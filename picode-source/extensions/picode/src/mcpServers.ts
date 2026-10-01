/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The MCP servers the owner declares, as the file **pi** reads.
 *
 * pi has had MCP of its own since 0.99: it reads `<agent dir>/mcp.json` — which for PiCode is
 * `data/pi-agent/mcp.json`, **inside the product**, never the machine's `~/.config/mcp/mcp.json` —
 * and, for a trusted project, `<project>/.pi/mcp.json`. This module is the translation between the
 * row in the settings (`picode.mcp.servers`, a form) and that file, in the shape pi documents: a
 * `mcpServers` object whose entries are either a remote server (`type`, `url`) or a local one
 * (`command`, `args`).
 *
 * The file may already hold things that are not ours — the owner may have added a server by hand,
 * or an older adapter left its own keys there, which pi ignores — so the merge keeps every entry it
 * does not own.
 *
 * What reads this file, and from where, is narrower than it looks: the editor's chat builds its
 * session through pi's SDK, which loads neither pi's built-in extensions nor `session_start`, so
 * these servers are not served there yet. The measurements are in `odd/tasks/picode-pi-0992.md`.
 *
 * No `vscode` import: the translation can be exercised by running it.
 */

/** One server as the settings row holds it. */
export interface McpServerSetting {
	readonly name: string;
	readonly transport: string;
	readonly target: string;
	readonly args: string;
	readonly key: string;
}

/** One server as pi's file declares it. */
export type McpServerEntry =
	| { readonly type: 'http'; readonly url: string; readonly headers?: Record<string, string>; readonly oauth?: Record<string, never> }
	| { readonly command: string; readonly args: readonly string[] };

/**
 * The shape a server name must have — the one the settings row is validated against, and the one an
 * imported name is sanitized into.
 *
 * The dot is deliberately absent: pi's own MCP validates names with `^[A-Za-z0-9_-]+$` and refuses
 * the rest, so a name this pattern let through with a dot would be written to `mcp.json` and never
 * connect. The leading letter-or-digit rule is PiCode's, stricter than pi's, and harmless.
 */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * The arguments of a local server's command, as the row writes them.
 *
 * Split on spaces, and quoted pieces kept together (`"C:\\Program Files\\x"`) because a path with a
 * space is the common case and splitting it would start a command that does not exist.
 */
export function splitArguments(args: string): string[] {
	const pieces: string[] = [];
	let current = '';
	let quoted = false;
	for (const character of args) {
		if (character === '"') {
			quoted = !quoted;
			continue;
		}
		if (character === ' ' && !quoted) {
			if (current.length > 0) {
				pieces.push(current);
				current = '';
			}
			continue;
		}
		current += character;
	}
	if (current.length > 0) {
		pieces.push(current);
	}
	return pieces;
}

/** Whether the row describes a server pi could use. */
export function isUsableServer(server: McpServerSetting | undefined | null): boolean {
	return !!server
		&& typeof server.name === 'string' && NAME_PATTERN.test(server.name.trim())
		&& typeof server.target === 'string' && server.target.trim().length > 0;
}

/**
 * One server, in the shape pi's `mcp.json` reads.
 *
 * A remote server with a token carries it as an `Authorization` header, and one without carries
 * `oauth: {}` — the empty object, not `auth: "oauth"`. Those two spellings are the whole point:
 * pi's own MCP refuses `auth: "oauth"` (`auth.provider must be a provider name`) and refuses
 * `oauth: false`, while it reads `oauth: {}` as "this one signs in" (`usesOAuth`, `runtime.js:36`);
 * and `pi-mcp-adapter` maps that same object back to `auth: "oauth"` for itself (`config.ts:1215`).
 * One entry, both readers.
 */
export function mcpServerEntry(server: McpServerSetting): McpServerEntry {
	const key = typeof server.key === 'string' ? server.key.trim() : '';
	const headers = key.length === 0 ? undefined : { Authorization: `Bearer ${key}` };
	if (server.transport === 'stdio') {
		return { command: server.target.trim(), args: splitArguments(typeof server.args === 'string' ? server.args : '') };
	}
	return headers === undefined
		? { type: 'http', url: server.target.trim(), oauth: {} }
		: { type: 'http', url: server.target.trim(), headers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One entry of the file's `mcpServers`, as it was read: the keys this module does not interpret
 * travel to the file untouched, which is what keeps a hand-written entry from being pruned.
 */
export type FileServerEntry = Record<string, unknown>;

/**
 * One server entry with the two keys pi's own MCP refuses repaired, and nothing else touched.
 *
 * Entries written for the old adapter carry `auth: "oauth"` (which pi rejects with
 * `auth.provider must be a provider name`) and `auth: false` / `oauth: false` (pi rejects the
 * second: `oauth must be an object`). Neither is needed by anything: the old adapter derives its
 * `auth` from the `oauth` object, so dropping the legacy spelling and keeping `oauth: {}` leaves
 * both readers working, and the entry stops being skipped.
 *
 * Deliberately conservative: an entry whose `auth` already names a provider is returned exactly as
 * it came. `oauth: false` — "this server must not sign in" — has no equivalent in pi's file and is
 * dropped, which is what makes the entry usable at all; a server that then has no `Authorization`
 * header will be asked to sign in the first time pi uses it.
 */
export function normalizedServerEntry(entry: FileServerEntry): FileServerEntry {
	const next: FileServerEntry = { ...entry };
	const auth = next['auth'];
	if (auth !== undefined && !(isRecord(auth) && typeof auth['provider'] === 'string')) {
		const wantedSignIn = auth === 'oauth' || next['oauth'] === true;
		delete next['auth'];
		if (!isRecord(next['oauth'])) {
			if (wantedSignIn) {
				next['oauth'] = {};
			} else {
				delete next['oauth'];
			}
		}
	} else if (next['oauth'] !== undefined && !isRecord(next['oauth'])) {
		delete next['oauth'];
	}
	return next;
}

/**
 * The parsed file with every server entry normalized, and everything else exactly as it was.
 *
 * Applied where the file is read for writing, so a file that arrived with the old adapter's keys is
 * repaired by the next write instead of staying half-readable. A file that is not an object, or
 * whose `mcpServers` is not one, comes back untouched: there is nothing to normalize.
 */
export function normalizedServersFile(parsed: Record<string, unknown>): Record<string, unknown> {
	const servers = parsed['mcpServers'];
	if (!isRecord(servers)) {
		return parsed;
	}
	const normalized: Record<string, unknown> = {};
	for (const [name, entry] of Object.entries(servers)) {
		normalized[name] = isRecord(entry) ? normalizedServerEntry(entry) : entry;
	}
	return { ...parsed, mcpServers: normalized };
}

/**
 * The file's content: what the settings declare, over whatever else was already there.
 *
 * An entry with the same name is replaced — that is what editing the row means — and a name the
 * settings no longer declare is **removed**, because a server deleted from the form has to stop
 * being offered. What is left alone is everything that is not a server of ours: keys an older
 * adapter left behind, and any entry the owner added by hand in a shape this row cannot express.
 */
export function mcpServersFile(existing: unknown, servers: readonly McpServerSetting[]): Record<string, unknown> {
	const root = typeof existing === 'object' && existing !== null && !Array.isArray(existing)
		? { ...(existing as Record<string, unknown>) }
		: {};
	const previous = typeof root.mcpServers === 'object' && root.mcpServers !== null && !Array.isArray(root.mcpServers)
		? { ...(root.mcpServers as Record<string, unknown>) }
		: {};

	const declared = new Map<string, McpServerEntry>();
	for (const server of servers ?? []) {
		if (isUsableServer(server)) {
			declared.set(server.name.trim(), mcpServerEntry(server));
		}
	}

	const merged: Record<string, unknown> = {};
	for (const [name, entry] of Object.entries(previous)) {
		// Kept when the settings do not declare it: it is not ours to delete.
		if (!declared.has(name)) {
			merged[name] = entry;
		}
	}
	for (const [name, entry] of declared) {
		merged[name] = entry;
	}

	root.mcpServers = merged;
	return root;
}

/** What is written, as text: two-space indentation and a final newline, like the rest of the profile. */
export function mcpServersText(existing: unknown, servers: readonly McpServerSetting[]): string {
	return `${JSON.stringify(mcpServersFile(existing, servers), null, 2)}\n`;
}
