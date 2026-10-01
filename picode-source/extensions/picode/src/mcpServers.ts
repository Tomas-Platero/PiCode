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
	| { readonly type: 'http'; readonly url: string; readonly headers?: Record<string, string> }
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

/** One server, in the shape pi's `mcp.json` reads. */
export function mcpServerEntry(server: McpServerSetting): McpServerEntry {
	const key = typeof server.key === 'string' ? server.key.trim() : '';
	const headers = key.length === 0 ? undefined : { Authorization: `Bearer ${key}` };
	if (server.transport === 'stdio') {
		return { command: server.target.trim(), args: splitArguments(typeof server.args === 'string' ? server.args : '') };
	}
	return { type: 'http', url: server.target.trim(), ...(headers === undefined ? {} : { headers }) };
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
