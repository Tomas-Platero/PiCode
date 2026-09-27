/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ResourceSource } from './customizations';

/**
 * pi's MCP servers, as the editor's own MCP screen needs to see them.
 *
 * pi has no MCP of its own — the owner installs `pi-mcp-adapter`, and this connector is what
 * writes the servers into the file that adapter reads. So the editor's MCP list has to show what
 * pi will actually start, which is the same file this connector writes and reads.
 *
 * ## The shape, quoted from the code that owns it
 *
 * `mcpServers.ts` writes `<profile>/mcp.json` as a `mcpServers` object, and the two places that
 * read it back agree on the key — `status-data.ts` (`file?.['mcpServers']`, and the same entry
 * counts a server for the Status view) and `profile-import.ts` (`mcpFile['mcpServers']`). A local
 * server carries `command` (with optional `args` and `env`); a remote one carries `type: 'http'`
 * and a `url` (with optional `headers`), exactly as `mcpServerEntry` in `mcpServers.ts` builds it.
 * The project-level file the same shape appears in is `<workspace>/.pi/mcp.json`, next to the
 * other `.pi` resources pi reads (`CONFIG_DIR_NAME = '.pi'` in pi's own `dist/config.js:403`).
 *
 * ## Nothing is invented
 *
 * An entry this module cannot map to a server the editor could start is **left out and named**,
 * never guessed at: a `command` that is not a string, a `url` that is empty, a transport the
 * editor has no definition for (SSE), or a file that is not JSON at all. A server the owner never
 * declared must not appear in his list.
 *
 * ## No `vscode` import
 *
 * The mapping is pure and returns plain descriptors, so `node --test` can exercise it; turning a
 * descriptor into `vscode.McpStdioServerDefinition` / `McpHttpServerDefinition` is `extension.ts`'s
 * job — that is the part that needs the editor.
 */

/** One `mcp.json` to read, already loaded: where it is, what it says, and whose it is. */
export interface McpConfigFile {
	/** The file, for the report and for the row's detail. */
	readonly path: string;
	readonly text: string;
	/** The profile's own file is `user`; a workspace folder's `.pi/mcp.json` is `local`. */
	readonly source: ResourceSource;
}

/** A server started as a local process, as an entry declares it. */
export interface PiStdioEntry {
	readonly kind: 'stdio';
	readonly label: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string | number>>;
}

/** A server reached over the network, as an entry declares it. */
export interface PiHttpEntry {
	readonly kind: 'http';
	readonly label: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
}

/** One server, as the file declares it. */
export type PiMcpEntry = PiStdioEntry | PiHttpEntry;

/** A server that was read, with the file it came from — what the editor's MCP list needs. */
export type PiMcpServer =
	| (PiStdioEntry & { readonly source: ResourceSource; readonly file: string })
	| (PiHttpEntry & { readonly source: ResourceSource; readonly file: string });

/** What one read of every `mcp.json` produced: the servers, and why the rest is not one. */
export interface McpReadResult {
	readonly servers: readonly PiMcpServer[];
	/** One line per entry that could not be mapped, for the log — never for the list. */
	readonly skipped: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty, trimmed string, or `undefined` for anything else. */
function text(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

/** The arguments of a local server: strings only, because that is what a process can be given. */
function argumentList(value: unknown): string[] {
	return Array.isArray(value) ? value.map(item => text(item)).filter((item): item is string => item !== undefined) : [];
}

/** The environment of a local server: names to literal values the editor can pass to a process. */
function environment(value: unknown): Record<string, string | number> {
	const env: Record<string, string | number> = {};
	if (!isRecord(value)) {
		return env;
	}
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === 'string' || typeof entry === 'number') {
			env[key] = entry;
		}
		// A `null` is "remove this variable" for the editor and a `$NAME` is pi's interpolation,
		// which is not this extension's to resolve: both are left out rather than sent wrong.
	}
	return env;
}

/** The headers of a remote server: name to a literal value. */
function headerMap(value: unknown): Record<string, string> {
	const headers: Record<string, string> = {};
	if (!isRecord(value)) {
		return headers;
	}
	for (const [key, entry] of Object.entries(value)) {
		const header = text(entry);
		if (header !== undefined) {
			headers[key] = header;
		}
	}
	return headers;
}

/** Where a server entry could not be read, and why. */
interface RefusedEntry {
	readonly reason: string;
}

/**
 * The transports the editor's own MCP definition can start.
 *
 * A `url` without a `type` is read as HTTP — `mcpServers.ts` always writes `type: 'http'`, but an
 * entry written by hand often leaves it out, and a remote address is the only thing such an entry
 * can mean. A `type` that names anything else (`sse`, the transport the editor replaced) is a
 * server this connector cannot start, and pretending it is HTTP would put a row in the list that
 * fails the moment it is used.
 */
const HTTP_TRANSPORTS = ['http', 'streamable-http', 'streamable_http'];

/**
 * One entry of a `mcpServers` object, as a server or as a refusal.
 *
 * `command` wins over `url` when an entry carries both, because that is what the adapter does
 * (`mcpServerEntry` writes one or the other, so an entry with both was hand-written) and starting
 * the process the owner named is the reading that cannot silently reach somewhere else.
 */
export function mcpServerFrom(label: string, entry: unknown): PiMcpEntry | RefusedEntry {
	if (!isRecord(entry)) {
		return { reason: 'the entry is not an object' };
	}
	const command = text(entry['command']);
	if (command !== undefined) {
		return {
			kind: 'stdio',
			label,
			command,
			args: argumentList(entry['args']),
			env: environment(entry['env']),
		};
	}
	const type = text(entry['type']);
	const url = text(entry['url']);
	const httpType = type === undefined || HTTP_TRANSPORTS.includes(type.toLowerCase());
	if (url !== undefined && httpType) {
		return { kind: 'http', label, url, headers: headerMap(entry['headers']) };
	}
	if (type === undefined) {
		return { reason: 'no command and no url' };
	}
	return {
		reason: httpType
			? `a "${type}" server with no url`
			: `the transport "${type}" has no definition in the editor`,
	};
}

/** Whether an answer is a server rather than a refusal. */
function isServer(value: PiMcpEntry | RefusedEntry): value is PiMcpEntry {
	return !('reason' in value);
}

/** The servers of one file, in the order they are written, and the reasons for the rest. */
function readFile(file: McpConfigFile, into: Map<string, PiMcpServer>, skipped: string[]): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(file.text);
	} catch {
		skipped.push(`${file.path}: the file is not JSON`);
		return;
	}
	if (!isRecord(parsed)) {
		skipped.push(`${file.path}: the file is not an object`);
		return;
	}
	const servers = parsed['mcpServers'];
	if (servers === undefined) {
		// A file with no `mcpServers` key declares no server of ours. pi's own file always has
		// one — `mcpServers.ts` writes it on every change — so nothing is missing when it is not.
		return;
	}
	if (!isRecord(servers)) {
		skipped.push(`${file.path}: "mcpServers" is not an object`);
		return;
	}
	for (const [label, entry] of Object.entries(servers)) {
		const name = label.trim();
		if (name.length === 0) {
			skipped.push(`${file.path}: an entry has no name`);
			continue;
		}
		const mapped = mcpServerFrom(name, entry);
		if (!isServer(mapped)) {
			skipped.push(`${file.path}: "${name}" was left out — ${mapped.reason}`);
			continue;
		}
		into.set(name, { ...mapped, source: file.source, file: file.path });
	}
}

/**
 * Every server pi would start, one per **name**.
 *
 * Later files replace an earlier server of the same name, and the files are read profile-first, so
 * a project's server of the same name is the one that survives — the same way a project's package
 * replaces the personal one (`docs/packages.md`).
 */
export function mcpServersFrom(files: readonly McpConfigFile[]): McpReadResult {
	const servers = new Map<string, PiMcpServer>();
	const skipped: string[] = [];
	for (const file of files) {
		readFile(file, servers, skipped);
	}
	return { servers: [...servers.values()], skipped };
}
