/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The transcript's markdown, rendered where it can be trusted: here, not in the webview.
 *
 * The reason this file exists instead of `markdown.api.render` (the built-in markdown
 * extension's command) is that command answers with `html: true` — raw HTML written by the model
 * would reach the DOM. A transcript is full of model-written text and tool output, so the order
 * is inverted:
 *
 *   1. **Escape everything first.** The whole string becomes text: `&`, `<`, `>`, `"`, `'`.
 *   2. **Then add the tags this renderer knows**, from an allowlist, on text that is already
 *      inert. A `<script>` in the model's answer is `&lt;script&gt;` by the time any rule sees it.
 *
 * Links deserve their own note: only `http` and `https` become anchors. `javascript:`, `data:`
 * and anything else stay as literal text, so a crafted `[x](javascript:…)` is just characters.
 * The anchor carries `data-href` as well as `href` because the webview intercepts the click and
 * asks the editor to open it — inside the tab, CSP forbids navigation.
 *
 * Tables are read as GFM reads them — a header row, a delimiter row of dashes, then body rows —
 * and each cell goes through `inline()`, so the escape-first rule holds inside a cell exactly as
 * it does in prose: a `<img onerror=…>` written into a table is text, never a tag.
 *
 * Deliberately not supported: raw HTML (it is escaped) and `_italic_` (an underscore is far more
 * often part of `some_file_name` than italic markup).
 */

/** HTML-escapes a string. Every renderer below starts from this, never from the input. */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** A URL this renderer is willing to make clickable. */
function isAllowedUrl(url: string): boolean {
	return /^https?:\/\/[^\s]+$/i.test(url);
}

/** Placeholder for an inline code span, so bold/link rules cannot reach inside it. */
const CODE_TOKEN = '\u0000';

/**
 * Inline markdown. Takes RAW text and escapes it first, so there is exactly one place where the
 * model's characters become inert — and no caller can forget it.
 *
 * Order matters: code spans are lifted out first, then links, then bold, then italic — so
 * `**` inside `code` and `*` inside a URL are never interpreted.
 */
function inline(raw: string): string {
	const escaped = escapeHtml(raw);
	const codes: string[] = [];
	const hoisted = escaped.replace(/`([^`]+)`/g, (_match, code: string) => {
		codes.push(`<code>${code}</code>`);
		return `${CODE_TOKEN}${codes.length - 1}${CODE_TOKEN}`;
	});

	const linked = hoisted.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
		if (!isAllowedUrl(url)) {
			return match; // stays literal text: no anchor for javascript:, data:, relative paths…
		}
		return `<a href="${url}" data-href="${url}" rel="noreferrer noopener">${label}</a>`;
	});

	const bold = linked.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
	const italic = bold.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

	// Restoring the code spans by literal replacement, not by building a pattern: the token is a
	// constant, but a regex assembled from a string is a habit worth not having.
	let restored = italic;
	for (let index = 0; index < codes.length; index++) {
		restored = restored.split(`${CODE_TOKEN}${index}${CODE_TOKEN}`).join(codes[index]);
	}
	return restored;
}

/** One line of prose → its HTML, with the inline rules applied (which escape it). */
function paragraph(lines: readonly string[]): string {
	return `<p>${lines.map(line => inline(line)).join('<br>')}</p>`;
}

/** A pipe that ends a cell, as opposed to one the model escaped (`a \\| b`). */
const CELL_SEPARATOR = '|';

/**
 * One table row → its raw cells, with the pipes that are borders removed.
 *
 * `\|` is a literal pipe inside a cell, so it must not split anything; `\\` is a literal
 * backslash, which keeps `\\|` meaning "a backslash, then the end of the cell". Nothing here
 * escapes HTML — the cell's text goes to `inline()`, which does that.
 */
function tableCells(line: string): string[] {
	const trimmed = line.trim();
	const cells: string[] = [];
	let current = '';
	for (let index = 0; index < trimmed.length; index++) {
		const character = trimmed[index];
		if (character === '\\') {
			const next = trimmed[index + 1];
			if (next === CELL_SEPARATOR) {
				current += CELL_SEPARATOR; // the escape is spent: the cell holds a pipe
				index++;
				continue;
			}
			if (next === '\\') {
				current += '\\'; // a literal backslash, and the one after it is not an escape
				index++;
				continue;
			}
			current += character;
			continue;
		}
		if (character === CELL_SEPARATOR) {
			cells.push(current.trim());
			current = '';
			continue;
		}
		current += character;
	}
	cells.push(current.trim());
	// A leading or trailing pipe is the table's border, not an empty cell.
	if (cells.length > 0 && cells[0] === '') {
		cells.shift();
	}
	if (cells.length > 0 && cells[cells.length - 1] === '') {
		cells.pop();
	}
	return cells;
}

/** The dashes-and-colons cell GFM reads as a column's alignment. */
function isDelimiterCell(cell: string): boolean {
	return /^:?-+:?$/.test(cell.trim());
}

/** `:---` left, `:---:` center, `---:` right, `---` unset — the four GFM spellings. */
function alignmentOf(cell: string): 'left' | 'center' | 'right' | undefined {
	const value = cell.trim();
	const left = value.startsWith(':');
	const right = value.endsWith(':');
	if (left && right) {
		return 'center';
	}
	if (right) {
		return 'right';
	}
	return left ? 'left' : undefined;
}

/**
 * The table that starts at `index`, or `undefined` when no table starts there.
 *
 * Detection is the GFM one and nothing more: a row with a pipe, and directly under it a
 * delimiter row whose cells are all dashes (plus an optional colon) and whose count matches the
 * header's. A line with a pipe and no delimiter under it is prose, which is how a bare `a | b`
 * in an answer stays a sentence.
 */
function tableAt(lines: readonly string[], index: number):
	{ readonly head: readonly string[]; readonly alignments: readonly (ReturnType<typeof alignmentOf>)[] } | undefined {
	const header = lines[index];
	const delimiter = lines[index + 1];
	if (header === undefined || delimiter === undefined) {
		return undefined;
	}
	if (!header.includes(CELL_SEPARATOR) || !delimiter.includes(CELL_SEPARATOR)) {
		return undefined;
	}
	const head = tableCells(header);
	if (head.length === 0) {
		return undefined;
	}
	const delimiters = tableCells(delimiter);
	if (delimiters.length !== head.length || !delimiters.every(isDelimiterCell)) {
		return undefined;
	}
	return { head, alignments: delimiters.map(alignmentOf) };
}

/** One cell → its tag, with the inline rules applied to raw text (which escape it). */
function tableCell(tag: 'th' | 'td', text: string, alignment: 'left' | 'center' | 'right' | undefined): string {
	// `left` is the default the stylesheet already gives a cell, so only the other two need a class.
	const className = alignment === 'center' || alignment === 'right' ? ` class="t-${alignment}"` : '';
	return `<${tag}${className}>${inline(text)}</${tag}>`;
}

/**
 * Renders model markdown as HTML that is safe to put in the transcript.
 *
 * Blocks understood: fenced code, headings, GFM tables, blockquotes, unordered and ordered lists,
 * horizontal rules, and paragraphs (blank line separated). Everything else is text.
 */
export function renderMarkdown(markdown: string): string {
	// The placeholder character must not come from the model, or a crafted string could resurrect
	// a code token that was never pushed.
	const source = markdown.replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
	const lines = source.split('\n');
	const out: string[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index];

		// Fenced code: the body is escaped and never inline-processed.
		const fence = /^\s*```\s*([A-Za-z0-9+#._-]*)\s*$/.exec(line);
		if (fence !== null) {
			const language = fence[1];
			const body: string[] = [];
			index++;
			while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
				body.push(lines[index]);
				index++;
			}
			index++; // the closing fence, or the end of the text
			const label = language.length > 0 ? ` data-lang="${escapeHtml(language)}"` : '';
			out.push(`<pre class="code"><code${label}>${escapeHtml(body.join('\n'))}</code></pre>`);
			continue;
		}

		if (/^\s*$/.test(line)) {
			index++;
			continue;
		}

		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading !== null) {
			const level = heading[1].length;
			out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
			index++;
			continue;
		}

		if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
			out.push('<hr>');
			index++;
			continue;
		}

		if (/^\s*>\s?/.test(line)) {
			const quoted: string[] = [];
			while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
				quoted.push(lines[index].replace(/^\s*>\s?/, ''));
				index++;
			}
			out.push(`<blockquote>${paragraph(quoted)}</blockquote>`);
			continue;
		}

		if (/^\s*[-*+]\s+/.test(line)) {
			const items: string[] = [];
			while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
				items.push(lines[index].replace(/^\s*[-*+]\s+/, ''));
				index++;
			}
			out.push(`<ul>${items.map(item => `<li>${inline(item)}</li>`).join('')}</ul>`);
			continue;
		}

		if (/^\s*\d+[.)]\s+/.test(line)) {
			const items: string[] = [];
			while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
				items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ''));
				index++;
			}
			out.push(`<ol>${items.map(item => `<li>${inline(item)}</li>`).join('')}</ol>`);
			continue;
		}

		// A table: the header row, the delimiter row that made it a table, then body rows until a
		// line that is not a row. Cells are padded and truncated to the header's width, as GFM does.
		const table = tableAt(lines, index);
		if (table !== undefined) {
			index += 2; // the header and its delimiter
			const rows: string[] = [];
			while (index < lines.length && !/^\s*$/.test(lines[index]) && lines[index].includes(CELL_SEPARATOR)) {
				const cells = tableCells(lines[index]);
				const padded = table.head.map((_cell, column) => cells[column] ?? '');
				rows.push(`<tr>${padded.map((cell, column) => tableCell('td', cell, table.alignments[column])).join('')}</tr>`);
				index++;
			}
			const head = table.head.map((cell, column) => tableCell('th', cell, table.alignments[column])).join('');
			out.push(`<table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`);
			continue;
		}

		// A paragraph: consecutive plain lines, kept line by line so a model's short lines stay short.
		const prose: string[] = [];
		while (
			index < lines.length &&
			!/^\s*$/.test(lines[index]) &&
			!/^\s*```/.test(lines[index]) &&
			!/^(#{1,6})\s+/.test(lines[index]) &&
			!/^\s*>\s?/.test(lines[index]) &&
			!/^\s*[-*+]\s+/.test(lines[index]) &&
			!/^\s*\d+[.)]\s+/.test(lines[index]) &&
			!/^\s*(---+|\*\*\*+|___+)\s*$/.test(lines[index]) &&
			tableAt(lines, index) === undefined
		) {
			prose.push(lines[index]);
			index++;
		}
		if (prose.length === 0) {
			index++; // defensive: never spin on a line no rule claimed
			continue;
		}
		out.push(paragraph(prose));
	}

	return out.join('\n');
}
