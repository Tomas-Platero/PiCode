/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Where the memory engine lives, which store it opens, and how to tell whether a server that
 * answers is *ours* — decided in one pure place.
 *
 * The engine is a program this installation carries (`<app>/resources/memory/engram.exe`), the
 * same way pi travels. Two rules shape everything here:
 *
 *  1. **The store is the user's, not the profile's.** `~/.engram` by default, and it is used
 *     exactly as found: never moved, never migrated, never overwritten. It is shared on purpose
 *     with whatever other agent on the machine points at the same folder, which is the whole
 *     reason a different pi can read what this one learned.
 *  2. **A running server is joined, not duplicated.** Two processes opening one SQLite store is
 *     how a memory gets corrupted. So before starting anything, the caller asks
 *     {@link engramServerUrl} whether somebody is already serving and compares
 *     {@link engramOwnsStore}. A server answering on the port that does *not* own this store is
 *     somebody else's, and it is left alone.
 *
 * Runs under `node --test` through Node's own type stripping, exactly like `memory-update.ts`, so
 * the rules above are pinned in tests instead of asserted in prose. That is also why the file
 * imports nothing of its own: type stripping resolves `./sibling` only with an extension, and the
 * build compiles these sources as CommonJS without one. One file, one set of rules.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** Where a build puts the engine inside its own installation, under `resources/`. */
export const SHIPPED_ENGRAM_FOLDER = 'memory';

/** The port the engine serves on when nobody says otherwise (its own default). */
export const ENGRAM_DEFAULT_PORT = 7437;

/** The binary's name: Windows carries the extension, the other platforms do not. */
export function engramBinaryName(platform: string = process.platform): string {
	return platform === 'win32' ? 'engram.exe' : 'engram';
}

/**
 * The folders to try, in order, for a configured value.
 *
 * The owner's rule is simple: the program is always
 * found **wherever PiCode is installed**, without the owner configuring anything and without
 * depending on which project happens to be open. A copy that travels with the project wins, so
 * the engine can be worked on inside the project it is being tried in.
 *
 * An absolute value never reaches this list: it is the owner's own answer, used as given.
 */
export function engramBinaryCandidates(configured: string | undefined, workspaceFolders: readonly string[], appRoot: string, pathValue?: string, home?: string): string[] {
	const binary = engramBinaryName();
	if (configured !== undefined && configured.trim() !== '' && isAbsolutePath(configured.trim())) {
		return [configured.trim()];
	}
	const relative = configured === undefined || configured.trim() === '' ? SHIPPED_ENGRAM_FOLDER : configured.trim();
	const onPath = (pathValue ?? '')
		.split(isWindowsPathValue(pathValue) ? ';' : ':')
		.map(entry => entry.trim())
		.filter(entry => entry !== '')
		.map(entry => joinPath(entry, binary));
	return [
		...workspaceFolders.map(folder => joinPath(folder, relative, binary)),
		// The owner's own update, if they ran it: a newer engine downloaded into their profile,
		// never the shared store and never the installation. It wins over the shipped copy
		// because it is the one they asked for, and it is reverted by deleting the folder.
		...(home !== undefined && home.trim() !== '' ? [joinPath(home, '.picode', 'memory', binary)] : []),
		// The only candidate an *installed* editor has: `<app>/resources/memory`, which is what
		// the build writes. It is tried whatever the setting is spelled as — the value says where
		// else to look, never that the installation's own engine should be ignored.
		joinPath(appRoot, '..', SHIPPED_ENGRAM_FOLDER, binary),
		// Last, and on purpose: an engine the machine already had is used only when this
		// installation carries none. The pack's copy is pinned and known; a machine-wide one may
		// be a different version, and the store is shared with whatever other agent wrote there.
		...onPath
	];
}

/** `~/.engram` — the engine's own default, kept so the store is shared rather than owned. */
export function defaultEngramDataDir(home: string): string {
	return joinPath(home, '.engram');
}

/**
 * The folder the store lives in, read the way the engine itself reads it: `ENGRAM_DATA_DIR` when
 * it holds something, `~/.engram` otherwise. An empty or blank value is not an answer.
 */
export function engramDataDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
	const configured = env['ENGRAM_DATA_DIR'];
	return configured !== undefined && configured.trim() !== '' ? configured.trim() : defaultEngramDataDir(home);
}

/**
 * The base URL of a serving engine: `ENGRAM_URL` when the owner manages one, otherwise the local
 * default. Trailing slashes are dropped so every caller builds the same strings.
 */
export function engramServerUrl(env: Readonly<Record<string, string | undefined>>): string {
	const configured = env['ENGRAM_URL'];
	if (configured !== undefined && configured.trim() !== '') {
		return configured.trim().replace(/\/+$/, '');
	}
	const port = (env['ENGRAM_PORT'] ?? '').trim();
	return `http://127.0.0.1:${port === '' ? ENGRAM_DEFAULT_PORT : port}`;
}

/** What a healthy engine answers. Only the fields this product acts on are kept. */
export interface EngramHealth {
	readonly version: string;
	readonly instanceId: string;
}

/**
 * Reads the engine's `/health` body. Anything that is not the engine answering `ok` is discarded
 * rather than guessed at: a half-understood health response is how the wrong server gets adopted.
 */
export function parseEngramHealth(value: unknown): EngramHealth | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const body = value as Record<string, unknown>;
	if (body['service'] !== 'engram' || body['status'] !== 'ok') {
		return undefined;
	}
	const version = body['version'];
	const instanceId = body['instance_id'];
	if (typeof version !== 'string' || version.trim() === '') {
		return undefined;
	}
	if (typeof instanceId !== 'string' || instanceId.trim() === '') {
		return undefined;
	}
	return { version: version.trim(), instanceId: instanceId.trim() };
}

/**
 * Whether the server that answered is the one serving **this** store.
 *
 * The store carries its identity in `.instance-id`; a server answering a different id is another
 * store's server on the same port — a WSL loopback, a second installation, or a stray process.
 * It is never adopted and never stopped: it is simply not ours.
 */
export function engramOwnsStore(health: EngramHealth, storeInstanceId: string | undefined): boolean {
	if (storeInstanceId === undefined || storeInstanceId.trim() === '') {
		// A store that has not been opened yet has no identity to compare with. The engine creates
		// one on first start, so an answering server is only trusted when the folder is empty
		// *because* nothing has run here — the caller decides that; without an id, this says no.
		return false;
	}
	return health.instanceId === storeInstanceId.trim();
}

/** What the engine's `/stats` says about the store, reduced to the numbers a surface shows. */
export interface EngramStats {
	readonly memories: number;
	readonly projects: number;
}

export function parseEngramStats(value: unknown): EngramStats | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const body = value as Record<string, unknown>;
	const memories = body['total_observations'];
	const projects = body['projects'];
	if (typeof memories !== 'number' || !Number.isFinite(memories) || memories < 0) {
		return undefined;
	}
	if (!Array.isArray(projects)) {
		return undefined;
	}
	return { memories, projects: projects.length };
}

/** One project as the engine lists it: the name a memory is filed under, and how many it holds. */
export interface EngramProject {
	readonly name: string;
	readonly memories: number;
}

/**
 * The engine's `/projects`, reduced to what the editor groups by.
 *
 * This is the read that gives a *whole-store* count: `/stats` without a project answers for the
 * folder the server happens to run in, and PiCode's editor process does not run in the owner's
 * project. Summing the projects is the only honest total.
 */
export function parseEngramProjects(value: unknown): { readonly total: number; readonly projects: readonly EngramProject[] } | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const list = (value as Record<string, unknown>)['projects'];
	if (!Array.isArray(list)) {
		return undefined;
	}
	const projects: EngramProject[] = [];
	for (const entry of list) {
		if (typeof entry !== 'object' || entry === null) {
			return undefined;
		}
		const row = entry as Record<string, unknown>;
		const name = row['name'];
		const memories = row['observation_count'];
		if (typeof name !== 'string' || name.trim() === '') {
			return undefined;
		}
		if (typeof memories !== 'number' || !Number.isFinite(memories) || memories < 0) {
			return undefined;
		}
		projects.push({ name: name.trim(), memories });
	}
	return { total: projects.reduce((sum, project) => sum + project.memories, 0), projects };
}

/**
 * What the owner reads about memory, in one line. No paths, no version numbers unless they are
 * the answer to a question somebody asked, and no machinery.
 */
export type EngramState =
	| { readonly kind: 'ready'; readonly memories: number; readonly version: string }
	| { readonly kind: 'empty' }
	| { readonly kind: 'stopped' }
	| { readonly kind: 'missing' }
	| { readonly kind: 'foreign'; readonly url: string }
	| { readonly kind: 'error'; readonly detail: string };

/** The one line a status surface prints for {@link EngramState}. */
export function engramStateLine(state: EngramState): string {	switch (state.kind) {
		case 'ready':
			return `Memory: ${state.memories} ${state.memories === 1 ? 'memory' : 'memories'}`;
		case 'empty':
			return 'Memory: ready · nothing saved yet';
		case 'stopped':
			return 'Memory: stopped';
		case 'missing':
			return 'Memory: unavailable — this installation has no memory engine';
		case 'foreign':
			return 'Memory: unavailable — another engram answered on this machine';
		case 'error':
			return `Memory: error — ${state.detail}`;
	}
}

/**
 * The server this product declares to pi, in the shape pi's own MCP file reads.
 *
 * `--tools=agent` is the engine's own set for agents — **19 of its 23**, leaving out the admin and
 * cloud ones — and it is chosen over a hand-picked handful on purpose: it carries the session
 * start/end calls, which are what let a memory say *where it came from*. The editor prints what a
 * chat's tools cost, which is where this figure is checked rather than argued.
 *
 * The command is an absolute path on purpose: a chat session is started by the editor, not by a
 * shell, so an installed PiCode cannot rely on `engram` being on anybody's PATH.
 */
export interface EngramMcpDeclaration {
	readonly name: 'engram';
	readonly transport: 'stdio';
	readonly command: string;
	readonly args: readonly string[];
}

export function engramMcpDeclaration(binary: string): EngramMcpDeclaration {
	return { name: 'engram', transport: 'stdio', command: binary, args: ['mcp', '--tools=agent'] };
}

/**
 * What to do with the `engram` entry already in the profile: `add`, `update`, or `keep`.
 *
 * The rule is "an entry that works is never touched". A declaration the owner wrote by hand — a
 * different binary, their own arguments — is theirs, even when it is not the one this product
 * would have written. Only an entry that points **nowhere** is rewritten, because that is the one
 * that stops a chat from having memory at all, and it is how an installation that moved heals
 * itself.
 */
export function engramDeclarationDecision(existing: unknown, binary: string, exists: (candidate: string) => boolean): 'add' | 'update' | 'keep' {
	if (typeof existing !== 'object' || existing === null) {
		return 'add';
	}
	const entry = existing as Record<string, unknown>;
	// A remote declaration is the owner's own idea of memory; it is not this product's to replace.
	if (typeof entry['url'] === 'string' && entry['url'].trim() !== '') {
		return 'keep';
	}
	const command = typeof entry['command'] === 'string' ? entry['command'].trim() : '';
	if (command === '') {
		// Present and unusable: a local server with no command is exactly the entry that leaves a
		// chat without memory.
		return 'update';
	}
	return command === binary || exists(command) ? 'keep' : 'update';
}

/* ------------------------------------------------------------------ *
 * Path helpers
 *
 * The module is loaded by `node --test` on any platform, and the repository's tests assert the
 * shape of these lists, so the arithmetic is written once here instead of importing `path` in a
 * way that makes the assertions platform-specific.
 * ------------------------------------------------------------------ */

function joinPath(...parts: readonly string[]): string {
	return normalizePath(parts.filter(part => part !== '').join('/'));
}

function normalizePath(value: string): string {
	const parts = value.replace(/\\/g, '/').split('/');
	const out: string[] = [];
	for (const part of parts) {
		if (part === '' && out.length > 0) {
			continue;
		}
		if (part === '.') {
			continue;
		}
		if (part === '..') {
			if (out.length > 1 && out[out.length - 1] !== '..') {
				out.pop();
			} else if (!/^[A-Za-z]:$/.test(out[0] ?? '')) {
				out.push('..');
			}
			continue;
		}
		out.push(part);
	}
	const joined = out.join('/');
	return joined === '' ? '/' : joined;
}

function isAbsolutePath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}

/** Windows separates `PATH` with `;`, everything else with `:` — decided by what the value looks like. */
function isWindowsPathValue(value: string | undefined): boolean {
	if (value === undefined) {
		return process.platform === 'win32';
	}
	return value.includes(';') || /^[A-Za-z]:[\\/]/.test(value);
}

/* ------------------------------------------------------------------ *
 * The probe: the half that touches the disk and the network
 *
 * Everything above decides *what* the rules are; this decides them *once*, so the status surface,
 * the chat and the terminal all ask the same question and get the same answer. Two details
 * are deliberate:
 *
 *  * **A short timeout.** Memory is support, not the product: if the engine does not answer in a
 *    moment, the editor says so and carries on. No turn is ever blocked on a probe.
 *  * **Injected I/O.** `node --test` runs this with fakes, so "join a server that owns the store",
 *    "never adopt a foreign one" and "never claim a store that is not there" are pinned without a
 *    real engram on the machine.
 * ------------------------------------------------------------------ */

/**
 * Whether a declared server is **the one this product wrote**, which is the only one it may take
 * away when the owner turns memory off.
 *
 * The test is deliberately narrow: the command has to be an `engram` binary and the arguments have
 * to be exactly the ones {@link engramMcpDeclaration} writes. An entry pointed at the owner's own
 * engine with another profile of tools is theirs — a switch that says "memory off" does not get to
 * delete somebody else's declaration.
 */
export function isOurEngramDeclaration(entry: unknown): boolean {
	if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
		return false;
	}
	const row = entry as Record<string, unknown>;
	const command = row['command'];
	if (typeof command !== 'string') {
		return false;
	}
	const base = command.replace(/\\/g, '/').split('/').pop() ?? '';
	if (!/^engram(\.exe)?$/i.test(base)) {
		return false;
	}
	const args = row['args'];
	if (!Array.isArray(args)) {
		return false;
	}
	const ours = engramMcpDeclaration(command).args;
	return args.length === ours.length && args.every((value, index) => value === ours[index]);
}

/** How long a probe waits before deciding the engine is not answering. */
export const ENGRAM_PROBE_TIMEOUT_MS = 1_500;

/** Everything {@link probeEngram} needs from the outside world. */
export interface EngramProbeIo {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly home: string;
	readonly appRoot: string;
	readonly workspaceFolders: readonly string[];
	/** `picode.memory.binary`: an absolute path is the owner's own answer. */
	readonly configured?: string;
	exists(path: string): boolean;
	read(path: string): string | undefined;
	/** The parsed body, or `undefined` when the engine did not answer or did not answer JSON. */
	fetchJson(url: string, timeoutMs: number): Promise<unknown | undefined>;
}

/** What the editor knows about memory after one probe. */
export interface EngramProbe {
	/** The engine this installation can run, when it was found. */
	readonly binary?: string;
	/** The folder the store lives in — `~/.engram` unless the engine was pointed elsewhere. */
	readonly dataDir: string;
	/** Whether a store already exists there. It is reused exactly as found. */
	readonly storeExists: boolean;
	/** The server that answered, when one did. */
	readonly server?: EngramHealth;
	/** The projects the store holds, when the engine answered for them. */
	readonly projects?: readonly EngramProject[];
	/** What the owner reads. */
	readonly state: EngramState;
}

/**
 * Answers one question: can this editor remember right now, and what does it remember?
 *
 * Order matters and is the whole design:
 *
 *  1. no engine in the installation → `missing`, and nothing else is attempted;
 *  2. an engine answering `/health` that owns this store → `ready` (or `empty`), joined as-is;
 *  3. an engine answering that owns **another** store → `foreign`, left alone;
 *  4. a store on disk with nobody serving it → `stopped` (the caller may start it);
 *  5. an engine and no store → `empty` (the engine creates one on first use).
 */
export async function probeEngram(io: EngramProbeIo, timeoutMs: number = ENGRAM_PROBE_TIMEOUT_MS): Promise<EngramProbe> {
	const binary = engramBinaryCandidates(io.configured, io.workspaceFolders, io.appRoot, io.env['PATH'] ?? io.env['Path'], io.home)
		.find(candidate => io.exists(candidate));
	const dataDir = engramDataDir(io.env, io.home);
	const database = join(dataDir, 'engram.db');
	const instanceFile = join(dataDir, '.instance-id');

	const storeInstanceId = io.read(instanceFile);
	const storeExists = io.exists(database) || storeInstanceId !== undefined;

	if (binary === undefined) {
		return { dataDir, storeExists, state: { kind: 'missing' } };
	}

	const url = engramServerUrl(io.env);
	const health = parseEngramHealth(await fetchJsonOrUndefined(io, `${url}/health`, timeoutMs));
	if (health === undefined) {
		return { binary, dataDir, storeExists, state: storeExists ? { kind: 'stopped' } : { kind: 'empty' } };
	}

	if (!engramOwnsStore(health, storeInstanceId)) {
		return { binary, dataDir, storeExists, server: health, state: { kind: 'foreign', url } };
	}

	const listed = parseEngramProjects(await fetchJsonOrUndefined(io, `${url}/projects`, timeoutMs));
	if (listed === undefined) {
		// It answered, and it owns the store, so it is joined — but the count was not read.
		// Claiming zero would be a lie the owner would believe.
		return { binary, dataDir, storeExists, server: health, state: { kind: 'empty' } };
	}

	return {
		binary,
		dataDir,
		storeExists,
		server: health,
		projects: listed.projects,
		state: listed.total === 0 ? { kind: 'empty' } : { kind: 'ready', memories: listed.total, version: health.version }
	};
}

/**
 * A probe never rejects. The caller is a chat turn or a status refresh, and neither has anywhere
 * useful to put an exception: memory trouble is *reported* (`EngramState`), not thrown at the
 * product. The real I/O already swallows its own failures; this makes the promise hold for any
 * implementation, including the fakes tests write.
 */
async function fetchJsonOrUndefined(io: EngramProbeIo, url: string, timeoutMs: number): Promise<unknown | undefined> {
	try {
		return await io.fetchJson(url, timeoutMs);
	} catch {
		return undefined;
	}
}

/** How long the editor waits for a server it started before saying it did not come up. */
export const ENGRAM_START_TIMEOUT_MS = 5_000;

/** Starting the engine, as {@link ensureEngramServer} needs it — injected so tests never spawn. */
export interface EngramStartOptions {
	/** Runs the engine. The caller decides how detached it is; this module never owns a process. */
	readonly spawn: (binary: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>) => void;
	readonly waitMs?: number;
	readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The state the editor should be in after trying: someone is serving this store, or why not.
 *
 * The rules, in order, and each one exists because of a way this goes wrong:
 *
 *  * a server that already owns the store is **joined**, never restarted — it may be the one the
 *    owner's other pi is using right now;
 *  * `ENGRAM_URL` means somebody else manages the engine, so **nothing is ever started**;
 *  * the engine is started **only** when the store is there and nobody serves it, or when there is
 *    no store yet — never to fight a server that owns a *different* store;
 *  * a start that does not answer in time is reported as `stopped`, not thrown: the owner can try
 *    again, and a chat turn is never blocked by memory.
 */
export async function ensureEngramServer(io: EngramProbeIo, options: EngramStartOptions): Promise<EngramProbe> {
	const first = await probeEngram(io);
	// `first.server` covers the case where the engine owns the store but could not list it: it is
	// already serving, so starting another would be the second process this whole file avoids.
	if (first.server !== undefined || (first.state.kind !== 'stopped' && first.state.kind !== 'empty')) {
		return first;
	}
	if (first.binary === undefined || (io.env['ENGRAM_URL'] ?? '').trim() !== '') {
		return first;
	}

	const waitMs = options.waitMs ?? ENGRAM_START_TIMEOUT_MS;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const port = new URL(engramServerUrl(io.env)).port;
	options.spawn(first.binary, ['serve', port], io.env);

	// A fixed number of attempts rather than a clock: the wait is the same, and a test that fakes
	// `sleep` still terminates instead of spinning on a `Date.now()` that never moves.
	let last = first;
	for (let attempt = 0; attempt < Math.max(1, Math.ceil(waitMs / 250)); attempt++) {
		await sleep(250);
		last = await probeEngram(io);
		if (last.server !== undefined && last.state.kind !== 'foreign') {
			return last;
		}
	}
	return last;
}

/** The real world, as {@link probeEngram} expects it. */
export function nodeEngramProbeIo(options: {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly home: string;
	readonly appRoot: string;
	readonly workspaceFolders: readonly string[];
	readonly configured?: string;
}): EngramProbeIo {
	return {
		env: options.env,
		home: options.home,
		appRoot: options.appRoot,
		workspaceFolders: options.workspaceFolders,
		configured: options.configured,
		exists: candidate => existsSync(candidate),
		read: candidate => {
			try {
				return readFileSync(candidate, 'utf8');
			} catch {
				return undefined;
			}
		},
		fetchJson: async (url, timeoutMs) => {
			try {
				const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
				if (!response.ok) {
					return undefined;
				}
				return await response.json();
			} catch {
				// Sleeping engine, missing one, a foreign process that does not speak HTTP: all of
				// them answer the same question — nobody is serving our store here.
				return undefined;
			}
		}
	};
}
