/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ResourceSource } from './customizations';

/**
 * pi's MCP servers, as the editor's own MCP screen needs to see them.
 *
 * pi has MCP of its own since 0.99 and reads the servers the owner declares from
 * `<profile>/mcp.json` and each folder's `.pi/mcp.json`, which is the same file this connector
 * writes and reads. So the editor's MCP list has to show what pi will actually start, which is the
 * same file.
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
 * The keys of an entry that only tunes a user-level server, which pi 1.0.1 introduced.
 *
 * In pi 1.0.1 a project's `.pi/mcp.json` may carry an entry with no `command` and no `url` whose
 * only job is to turn the user-level server of the same name on or off for that project, or to
 * change how its tools are exposed to the model. Such an entry declares no server of its own.
 */
const OVERRIDE_KEYS = ['enabled', 'exposure', 'toolExposure'];

/** Whether an entry is a project's tune-up of a user-level server rather than a server of its own. */
function isOverrideEntry(entry: unknown): entry is Record<string, unknown> {
	if (!isRecord(entry)) {
		return false;
	}
	const keys = Object.keys(entry);
	return keys.length > 0 && keys.every(key => OVERRIDE_KEYS.includes(key));
}

/**
 * One entry of a `mcpServers` object, as a server or as a refusal.
 *
 * `command` wins over `url` when an entry carries both, because that is what pi does
 * (`mcpServerEntry` writes one or the other, so an entry with both was hand-written) and starting
 * the process the owner named is the reading that cannot silently reach somewhere else.
 *
 * `enabled: false` is pi's own switch: the entry stays in the file and pi does not start it. It is
 * refused here for the same reason — offering it to the editor would start it anyway, through the
 * editor's own client, whose tools then reach pi by the bridge, so "off" would turn nothing off.
 */
export function mcpServerFrom(label: string, entry: unknown): PiMcpEntry | RefusedEntry {
	if (!isRecord(entry)) {
		return { reason: 'the entry is not an object' };
	}
	if (entry['enabled'] === false) {
		return { reason: 'it is turned off (`"enabled": false`)' };
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
		// pi 1.0.1: a project file may carry an entry that only tunes the user-level server of the
		// same name. `enabled: false` is the one that changes this list — pi would not start that
		// server in this project, and offering it to the editor would start it anyway, through the
		// editor's own client, so "off" would turn nothing off. The other two keys decide how pi
		// exposes the server's tools to the model, which is not something this list gives out.
		if (isOverrideEntry(entry)) {
			if (entry['enabled'] === false) {
				into.delete(name);
			}
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

/* ------------------------------------------------------------------ *
 * Whether pi can actually use each server (the sign-in rule)
 * ------------------------------------------------------------------ */

/**
 * The state a row shows about a server's sign-in, in the words the owner sees:
 *
 * - `ok` — pi can use it: a local server, a remote one with a stored sign-in, or one that
 *   authenticates itself through its own `headers` (`github` does).
 * - `needed` — the entry is enabled but pi has no credential for it: a `url` server with
 *   neither a stored sign-in nor its own headers. `enabled` means "pi may start it", not
 *   "pi can use it", and this is the difference the rows have to tell.
 * - `unknown` — the answer cannot be had where this row is computed, and the row says so
 *   instead of defaulting to `On`.
 */
export type McpSignInState = 'ok' | 'needed' | 'unknown';

/** One server of the profile's `mcp.json`, with the switch pi reads and the sign-in fact. */
export interface McpServerStateRow {
	readonly name: string;
	/** Whether pi will start it: pi's own `enabled` key, absent meaning on. */
	readonly on: boolean;
	/** Left out for a switched-off server: its sign-in is not the fact on show. */
	readonly signIn?: McpSignInState;
}

/**
 * The profile's `mcp-auth.json`, where pi stores a server's OAuth tokens.
 *
 * `text` is the file's contents when it exists and could be read; a missing or malformed file
 * is the same fact as "no stored sign-in" (`ReadOnlyMcpAuthStore.load`), not an error.
 */
export interface McpAuthFile {
	readonly text?: string;
}

/**
 * The key pi stores one server's OAuth state under, by pi's own rule.
 *
 * Mirrored from `experimental/durable/lib/mcp.js` (`mcpAuthKey`, which cites pi's
 * `mcpNamespace` + `storeKeys`): `mcp__<name with - → _>|<normalized url>`. `legacyKey` is
 * the url-only key older pi versions wrote; it is read for compatibility, never written.
 * A `url` that cannot be parsed has no stored key to look up.
 */
function mcpAuthKeys(name: string, url: string): { key?: string; legacyKey?: string } {
	let urlKey: string;
	try {
		urlKey = String(new URL(url));
	} catch {
		return {};
	}
	return { key: `mcp__${name.replace(/-/g, '_')}|${urlKey}`, legacyKey: urlKey };
}

/** The OAuth state pi stored for one server, or `undefined` when there is none. */
function storedSignInState(authFile: McpAuthFile | undefined, name: string, url: string): Record<string, unknown> | undefined {
	if (authFile?.text === undefined) {
		return undefined;
	}
	let states: unknown;
	try {
		states = JSON.parse(authFile.text);
	} catch {
		// Not JSON: the same fact as "no stored sign-in" (`ReadOnlyMcpAuthStore.load`).
		return undefined;
	}
	if (!isRecord(states)) {
		return undefined;
	}
	const { key, legacyKey } = mcpAuthKeys(name, url);
	const state = (key !== undefined ? states[key] : undefined) ?? (legacyKey !== undefined ? states[legacyKey] : undefined);
	return isRecord(state) ? state : undefined;
}

/**
 * Whether pi can use one remote server, mirroring `experimental/durable/lib/mcp.js`.
 *
 * That bridge decides the same question before every request (`storedMcpAuth` + `ownHeaders`):
 * a stored sign-in whose token is still valid is used; an expired one fails fast; without a
 * stored sign-in, an entry that carries its own non-empty `headers` authenticates itself
 * (`github` reaches the API with its configured `Authorization` header), and one with neither
 * needs a sign-in — whatever `enabled` says. The connector cannot import that module, so the
 * rule is mirrored here and the origin is named: a `url` server with a stored sign-in is
 * usable; one that carries its own non-empty headers is usable; one with neither needs a
 * sign-in.
 *
 * The header check reads the values as written. pi expands `${VAR}` at use time, so a header
 * holding an interpolation the environment cannot fill fails at use time — a different fact
 * from "no credential at all", which is the one this rule is here to tell.
 */
function httpSignInState(name: string, entry: PiHttpEntry, authFile: McpAuthFile | undefined, now: number): McpSignInState {
	const ownHeaders = Object.values(entry.headers).some(value => value.length > 0);
	const stored = storedSignInState(authFile, name, entry.url);
	const token = stored?.['tokens'];
	if (isRecord(token) && typeof token['access_token'] === 'string' && token['access_token'].length > 0) {
		// An expired stored sign-in fails fast in the bridge (`storedMcpAuth`), so it is not a
		// usable one here either: the row asks for the sign-in again rather than promising "On".
		const expiresAt = stored?.['tokensExpireAt'];
		return typeof expiresAt === 'number' && expiresAt <= now ? 'needed' : 'ok';
	}
	if (ownHeaders) {
		// No stored sign-in, but the entry authenticates itself.
		return 'ok';
	}
	// `authFile` itself `undefined` means the profile's sign-ins were not looked at — the
	// external pi's directory, which this connector must not read — so the honest row is
	// "unknown", never a confident `On` or a guessed "needs sign-in".
	return authFile === undefined ? 'unknown' : 'needed';
}

/** The sign-in fact for one entry of the profile's `mcp.json`. */
function signInState(name: string, entry: unknown, authFile: McpAuthFile | undefined, now: number): McpSignInState | undefined {
	if (!isRecord(entry) || entry['enabled'] === false) {
		return undefined;
	}
	const mapped = mcpServerFrom(name, entry);
	if (!isServer(mapped)) {
		// An entry that cannot be mapped (an SSE transport, say) has no answer here either.
		return 'unknown';
	}
	if (mapped.kind === 'stdio') {
		return 'ok';
	}
	return httpSignInState(name, mapped, authFile, now);
}

/**
 * One row per server of the profile's `mcp.json`, with the two facts the surfaces show: the
 * switch pi reads (`enabled`), and whether pi can actually use the server. The order is the
 * file's, so the list does not jump between readings.
 *
 * This is the one place the rule is computed; `status-data.ts` feeds its answer to the status
 * panel and the MCP page, and neither of them re-derives it.
 */
export function mcpServerStates(
	servers: Readonly<Record<string, unknown>> | undefined,
	authFile: McpAuthFile | undefined,
	now: number,
): readonly McpServerStateRow[] {
	if (servers === undefined) {
		return [];
	}
	return Object.entries(servers).map(([name, entry]) => ({
		name,
		on: !(isRecord(entry) && entry['enabled'] === false),
		signIn: signInState(name, entry, authFile, now),
	}));
}
