/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Adding one MCP server to pi's own `mcp.json`, run on its own.
 *
 * The chat's management page lists pi's servers out of `<profile>/mcp.json` and each folder's
 * `.pi/mcp.json`; its "Add Server" button asks the connector to write the new one into the
 * **profile** file — the same file that list reads, in the shape the adapter documents. The
 * editor's own add flow would put the entry in the editor's user `mcp.json`, a file and a
 * shape pi never reads, which is why this translation exists instead of that command.
 *
 * Like the other pure modules here: no `vscode` import and no sibling import, because the
 * checks and the merge can be exercised by running them and Node does not resolve a sibling
 * import without its extension. The file's shape mirrors `mcpServers.ts` — same key, same
 * two-space indent, same final newline — and the tests run the two side by side to keep them
 * that way.
 */

/** One server as the quick-pick flow collects it. */
export interface AddServerDraft {
	readonly name: string;
	readonly transport: 'stdio' | 'http';
	/** `stdio`: the command that starts the server. */
	readonly command?: string;
	/** `stdio`: the command's arguments, already split. */
	readonly args?: readonly string[];
	/** `http`: where the server answers. */
	readonly url?: string;
	/** `http`: the headers sent with every request. */
	readonly headers?: Record<string, string>;
	/** `stdio`: the environment the command runs with. */
	readonly env?: Record<string, string>;
}

/** One server as the file holds it, in the shape the adapter documents. */
export type McpServerFileEntry =
	| { readonly type: 'http'; readonly url: string; readonly headers?: Record<string, string> }
	| { readonly command: string; readonly args: readonly string[]; readonly env?: Record<string, string> };

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** The one problem with a proposed name, or `undefined` when it can be used. */
export function validateServerName(name: string): string | undefined {
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		return 'The server needs a name.';
	}
	if (!NAME_PATTERN.test(trimmed)) {
		return 'A name holds letters, digits, dots, dashes and underscores, and starts with a letter or a digit.';
	}
	return undefined;
}

/** Every problem with a draft the flow is about to write, in the order the owner can fix them. */
export function validateDraft(draft: AddServerDraft): string[] {
	const problems: string[] = [];
	const nameProblem = validateServerName(draft.name);
	if (nameProblem !== undefined) {
		problems.push(nameProblem);
	}
	if (draft.transport === 'stdio') {
		if ((draft.command ?? '').trim().length === 0) {
			problems.push('A local server needs the command that starts it.');
		}
	} else {
		const url = (draft.url ?? '').trim();
		if (url.length === 0) {
			problems.push('A remote server needs its URL.');
		} else if (!isHttpUrl(url)) {
			problems.push(`"${url}" is not a http or https URL.`);
		}
	}
	return problems;
}

function isHttpUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * `KEY=VALUE` lines as one record, and the lines that are not that.
 *
 * The key may hold dots (`a.b=1` is a common shape for nested settings), and everything from
 * the first `=` on is the value, so a value may hold `=` too. A line with no `=` or an empty
 * key is **reported**, not guessed at: the caller says so and asks again.
 */
export function parseKeyValueLines(lines: readonly string[]): { values: Record<string, string>; malformed: readonly string[] } {
	const values: Record<string, string> = {};
	const malformed: string[] = [];
	for (const line of lines) {
		const text = line.trim();
		if (text.length === 0) {
			continue;
		}
		const equals = text.indexOf('=');
		const key = equals === -1 ? '' : text.slice(0, equals).trim();
		if (key.length === 0) {
			malformed.push(text);
			continue;
		}
		values[key] = text.slice(equals + 1).trim();
	}
	return { values, malformed };
}

/** One server, in the file's shape. An empty collection is left out: the file says what there is. */
export function serverFileEntry(draft: AddServerDraft): McpServerFileEntry {
	if (draft.transport === 'stdio') {
		return {
			command: (draft.command ?? '').trim(),
			args: [...(draft.args ?? [])],
			...(hasEntries(draft.env) ? { env: { ...draft.env } } : {}),
		};
	}
	return {
		type: 'http',
		url: (draft.url ?? '').trim(),
		...(hasEntries(draft.headers) ? { headers: { ...draft.headers } } : {}),
	};
}

function hasEntries(record: Record<string, string> | undefined): boolean {
	return record !== undefined && Object.keys(record).length > 0;
}

/**
 * The file's content with one server added: everything already there stays exactly as it is,
 * and an entry of the same name is replaced.
 *
 * The normalization is `mcpServersFile`'s with no declarations — a missing or broken file is
 * an empty one, a `mcpServers` that is not an object becomes one — and **not** its full merge:
 * that merge rewrites every entry the settings row declares, and the row's shape cannot
 * express an env on a local server or headers beyond one bearer token, so round-tripping the
 * existing servers through it would silently strip them. Left undeclared, every entry already
 * in the file survives untouched — which is what adding one server means.
 */
export function mcpServersWithAdded(existing: unknown, draft: AddServerDraft): Record<string, unknown> {
	const root: Record<string, unknown> = typeof existing === 'object' && existing !== null && !Array.isArray(existing)
		? { ...(existing as Record<string, unknown>) }
		: {};
	const servers: Record<string, unknown> = typeof root.mcpServers === 'object' && root.mcpServers !== null && !Array.isArray(root.mcpServers)
		? { ...(root.mcpServers as Record<string, unknown>) }
		: {};
	servers[draft.name.trim()] = serverFileEntry(draft);
	root.mcpServers = servers;
	return root;
}

/** What is written, as text: two-space indentation and a final newline, like the rest of the profile. */
export function mcpServersTextWithAdded(existing: unknown, draft: AddServerDraft): string {
	return `${JSON.stringify(mcpServersWithAdded(existing, draft), null, 2)}\n`;
}

/** The names of the servers already in the file, for the duplicate check. */
export function serverNames(existing: unknown): readonly string[] {
	const root = typeof existing === 'object' && existing !== null && !Array.isArray(existing)
		? (existing as Record<string, unknown>)
		: {};
	const servers = typeof root.mcpServers === 'object' && root.mcpServers !== null && !Array.isArray(root.mcpServers)
		? (root.mcpServers as Record<string, unknown>)
		: {};
	return Object.keys(servers);
}
