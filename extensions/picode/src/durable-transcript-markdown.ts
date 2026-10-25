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
 * Deliberately not supported: raw HTML (it is escaped), tables, and `_italic_` (an underscore is
 * far more often part of `some_file_name` than italic markup).
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

/**
 * Renders model markdown as HTML that is safe to put in the transcript.
 *
 * Blocks understood: fenced code, headings, blockquotes, unordered and ordered lists, horizontal
 * rules, and paragraphs (blank line separated). Everything else is text.
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
			!/^\s*(---+|\*\*\*+|___+)\s*$/.test(lines[index])
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
