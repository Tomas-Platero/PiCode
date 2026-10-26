/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * One probe, five answers, and the rule behind each.
 *
 * The promise being pinned: the editor either joins the server that owns *its* store, or says
 * plainly what is missing — and it never adopts somebody else's memory, never claims a count it
 * did not read, and never lets a sleeping engine look like a broken product.
 *
 * `node --test` runs this file with fakes (no real engram, no network), which is why the I/O is
 * injected in `engram-runtime.ts`.
 */

import assert from 'assert';
import { test } from 'node:test';
import * as path from 'path';
import { ensureEngramServer, probeEngram, type EngramProbeIo } from '../src/engram.ts';

const OURS = 'e98b96b9e07cb781a078add37ac98652';
const THEIRS = '00000000000000000000000000000000';
const slashed = (value: string) => value.replace(/\\/g, '/');

interface FakeOptions {
	readonly binary?: boolean;
	readonly instanceId?: string;
	readonly database?: boolean;
	readonly health?: unknown;
	readonly healthThrows?: boolean;
	readonly projects?: unknown;
	readonly env?: Record<string, string | undefined>;
}

function fakeIo(options: FakeOptions): EngramProbeIo {
	const home = path.resolve(process.cwd(), 'home');
	const dataDir = path.join(home, '.engram');
	const database = slashed(path.join(dataDir, 'engram.db'));
	const instanceFile = slashed(path.join(dataDir, '.instance-id'));
	const binaryName = process.platform === 'win32' ? 'engram.exe' : 'engram';

	return {
		env: options.env ?? {},
		home,
		appRoot: path.resolve(process.cwd(), 'install', 'resources', 'app'),
		workspaceFolders: [],
		exists: candidate => {
			const value = slashed(candidate);
			if (value.endsWith(`/${binaryName}`)) {
				return options.binary !== false;
			}
			if (value === database) {
				return options.database === true;
			}
			if (value === instanceFile) {
				return options.instanceId !== undefined;
			}
			return false;
		},
		read: candidate => (slashed(candidate) === instanceFile ? options.instanceId : undefined),
		fetchJson: async url => {
			if (options.healthThrows) {
				throw new Error('connection refused');
			}
			if (url.endsWith('/health')) {
				return options.health;
			}
			if (url.endsWith('/projects')) {
				return options.projects;
			}
			return undefined;
		}
	};
}

const healthOf = (instanceId: string) => ({ service: 'engram', status: 'ok', version: '3.4.0', instance_id: instanceId });

test('no engine in the installation is said plainly, and nothing else is tried', async () => {
	const probe = await probeEngram(fakeIo({ binary: false }));

	assert.deepEqual(probe.state, { kind: 'missing' });
	assert.equal(probe.binary, undefined);
	assert.equal(probe.dataDir, slashed(path.resolve(process.cwd(), 'home', '.engram')));
});

test('a server that owns this store is joined, and the count is the whole store', async () => {
	const probe = await probeEngram(fakeIo({
		instanceId: OURS,
		database: true,
		health: healthOf(OURS),
		projects: {
			count: 2,
			projects: [
				{ name: 'picode', observation_count: 134, session_count: 297, prompt_count: 982 },
				{ name: 'picode-website', observation_count: 9, session_count: 24, prompt_count: 30 }
			]
		}
	}));

	assert.deepEqual(probe.state, { kind: 'ready', memories: 143, version: '3.4.0' });
	assert.deepEqual(probe.projects?.map(project => project.name), ['picode', 'picode-website']);
	assert.equal(probe.storeExists, true);
});

test('an engine that answers but cannot list projects is joined without inventing a number', async () => {
	const probe = await probeEngram(fakeIo({ instanceId: OURS, database: true, health: healthOf(OURS) }));

	// It owns the store, so it is ours; the count is simply not known yet, and "0 memories"
	// would be a lie the owner would believe.
	assert.deepEqual(probe.state, { kind: 'empty' });
	assert.equal(probe.server?.instanceId, OURS);
});

test('a server serving another store is left alone, never adopted', async () => {
	const probe = await probeEngram(fakeIo({
		instanceId: OURS,
		database: true,
		health: healthOf(THEIRS),
		projects: { count: 1, projects: [{ name: 'someone-else', observation_count: 999 }] }
	}));

	assert.deepEqual(probe.state, { kind: 'foreign', url: 'http://127.0.0.1:7437' });
	assert.equal(probe.projects, undefined);
});

test('a store with nobody serving it is stopped, not broken', async () => {
	const probe = await probeEngram(fakeIo({ instanceId: OURS, database: true }));

	assert.deepEqual(probe.state, { kind: 'stopped' });
	assert.equal(probe.storeExists, true);
	// The engine is there; starting it is the caller's job, and it can.
	assert.ok(probe.binary !== undefined);
});

test('an engine with no store yet is empty, and that is not an error', async () => {
	const probe = await probeEngram(fakeIo({ binary: true }));

	assert.deepEqual(probe.state, { kind: 'empty' });
	assert.equal(probe.storeExists, false);
});

test('a sleeping engine that throws is the same as no engine answering', async () => {
	const probe = await probeEngram(fakeIo({ instanceId: OURS, database: true, healthThrows: true }));

	assert.deepEqual(probe.state, { kind: 'stopped' });
});

test('the folder the engine itself was pointed at is the folder used', async () => {
	const probe = await probeEngram(fakeIo({ env: { ENGRAM_DATA_DIR: 'D:\\shared-memory' } }));

	// The rule is reuse-as-found: a pointed folder is the store, wherever it is.
	assert.equal(probe.dataDir, 'D:\\shared-memory');
	assert.equal(probe.storeExists, false);
});

/* ---------------------------------------------------------------- *
 * Starting: one spawn only when nobody serves this store
 * ---------------------------------------------------------------- */

function starterIo(options: FakeOptions & { readonly afterSpawn?: unknown; readonly projectsAfterSpawn?: unknown }) {
	const spawns: Array<{ binary: string; args: readonly string[] }> = [];
	let started = false;
	const base = fakeIo(options);
	const io: EngramProbeIo = {
		...base,
		fetchJson: async (url, timeoutMs) => {
			if (url.endsWith('/health')) {
				return started ? options.afterSpawn : options.health;
			}
			if (url.endsWith('/projects')) {
				return started ? (options.projectsAfterSpawn ?? options.projects) : options.projects;
			}
			return undefined;
		}
	};
	const spawn = (binary: string, args: readonly string[]) => {
		spawns.push({ binary, args });
		started = true;
	};
	return { io, spawns, spawn, options };
}

const fastStart = { waitMs: 250, sleep: async () => { } };

test('a stopped engine is started once, on its own port, and then joined', async () => {
	const world = starterIo({
		instanceId: OURS,
		database: true,
		health: undefined,
		afterSpawn: healthOf(OURS),
		projects: { count: 1, projects: [{ name: 'picode', observation_count: 134 }] }
	});

	const probe = await ensureEngramServer(world.io, { spawn: world.spawn, ...fastStart });

	assert.equal(world.spawns.length, 1);
	assert.deepEqual(world.spawns[0].args, ['serve', '7437']);
	assert.deepEqual(probe.state, { kind: 'ready', memories: 134, version: '3.4.0' });
});

test('a server that already owns the store is joined, never restarted', async () => {
	const world = starterIo({
		instanceId: OURS,
		database: true,
		health: healthOf(OURS),
		projects: { count: 1, projects: [{ name: 'picode', observation_count: 7 }] }
	});

	const probe = await ensureEngramServer(world.io, { spawn: world.spawn, ...fastStart });

	assert.equal(world.spawns.length, 0);
	assert.deepEqual(probe.state, { kind: 'ready', memories: 7, version: '3.4.0' });
});

test('nothing is started when the engine is missing, foreign, or managed elsewhere', async () => {
	const missing = starterIo({ binary: false });
	assert.deepEqual((await ensureEngramServer(missing.io, { spawn: missing.spawn, ...fastStart })).state, { kind: 'missing' });
	assert.equal(missing.spawns.length, 0);

	const foreign = starterIo({ instanceId: OURS, database: true, health: healthOf(THEIRS) });
	assert.equal((await ensureEngramServer(foreign.io, { spawn: foreign.spawn, ...fastStart })).state.kind, 'foreign');
	assert.equal(foreign.spawns.length, 0);

	// `ENGRAM_URL` means somebody else runs the engine. Starting one would be a second process
	// on a store this product does not manage.
	const managed = starterIo({
		instanceId: OURS,
		database: true,
		env: { ENGRAM_URL: 'http://127.0.0.1:9000' }
	});
	assert.equal((await ensureEngramServer(managed.io, { spawn: managed.spawn, ...fastStart })).state.kind, 'stopped');
	assert.equal(managed.spawns.length, 0);
});

test('an engine that never answers is reported as stopped, not thrown at the caller', async () => {
	const world = starterIo({ instanceId: OURS, database: true, health: undefined, afterSpawn: undefined });

	const probe = await ensureEngramServer(world.io, { spawn: world.spawn, waitMs: 250, sleep: async () => { } });

	assert.deepEqual(probe.state, { kind: 'stopped' });
	assert.equal(world.spawns.length, 1);
});
