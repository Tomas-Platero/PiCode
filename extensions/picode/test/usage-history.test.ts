import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readUsageHistory } from '../src/usage-history.ts';

test('usage history reads only the PiCode sessions and keeps Gentle’s projection', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'picode-usage-'));
	try {
		const profile = path.join(dir, 'pi-agent');
		const sessions = path.join(profile, 'sessions');
		await mkdir(sessions, { recursive: true });
		await mkdir(path.join(dir, 'external', 'sessions'), { recursive: true });
		let roots: readonly string[] = [];
		const expected = { totals: { totalTokens: 42 }, byDay: [{ day: '2026-11-24', tokens: 42 }], byProvider: [{ provider: 'openai', tokens: 42 }] };
		const result = await readUsageHistory(dir, dir, async () => ({
			load: async paths => { roots = paths; return []; },
			project: () => expected,
		}));
		assert.deepEqual(roots, [await realpath(sessions)]);
		assert.deepEqual(result, expected);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('unavailable or older Gentle packages return no history', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'picode-usage-'));
	try {
		await mkdir(path.join(dir, 'pi-agent', 'sessions'), { recursive: true });
		assert.equal(await readUsageHistory(dir, dir, async () => undefined), undefined);
		assert.equal(await readUsageHistory(dir, dir, async () => { throw new Error('unavailable'); }), undefined);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('a profile replaced with a link while the adapter loads is not scanned', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'picode-usage-race-'));
	try {
		const profile = path.join(dir, 'pi-agent');
		await mkdir(path.join(profile, 'sessions'), { recursive: true });
		let replaced = false;
		let scanned = false;
		const inspect = async (entry: string) => replaced && entry === profile ? { isSymbolicLink: () => true } : lstat(entry);
		const result = await readUsageHistory(dir, dir, async () => {
			replaced = true;
			return { load: async () => { scanned = true; return []; }, project: () => ({ totals: { totalTokens: 0 }, byDay: [], byProvider: [] }) };
		}, inspect);
		assert.equal(result, undefined);
		assert.equal(scanned, false);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('a sessions link detected after scanning is never projected', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'picode-usage-race-'));
	try {
		const sessions = path.join(dir, 'pi-agent', 'sessions');
		await mkdir(sessions, { recursive: true });
		let replaced = false;
		let projected = false;
		const inspect = async (entry: string) => replaced && entry === sessions ? { isSymbolicLink: () => true } : lstat(entry);
		const result = await readUsageHistory(dir, dir, async () => ({
			load: async () => { replaced = true; return []; },
			project: () => { projected = true; return { totals: { totalTokens: 0 }, byDay: [], byProvider: [] }; },
		}), inspect);
		assert.equal(result, undefined);
		assert.equal(projected, false);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('linked profile or sessions directories are refused before loading Gentle', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'picode-usage-'));
	try {
		const profile = path.join(dir, 'pi-agent');
		const sessions = path.join(profile, 'sessions');
		await mkdir(sessions, { recursive: true });
		for (const link of [dir, profile, sessions]) {
			let loaded = false;
			const inspected: string[] = [];
			const inspect = async (entry: string) => {
				inspected.push(entry);
				return entry === link ? { isSymbolicLink: () => true } : lstat(entry);
			};
			const result = await readUsageHistory(dir, dir, async () => { loaded = true; return undefined; }, inspect);
			assert.equal(result, undefined);
			assert.equal(loaded, false, `${link} must not be traversed`);
			assert.equal(inspected.at(-1), link);
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('real links to an external profile or sessions are refused', async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'picode-usage-links-'));
	try {
		const external = path.join(dir, 'external');
		await mkdir(path.join(external, 'sessions'), { recursive: true });
		const profileLinkRoot = path.join(dir, 'profile-link');
		const sessionsLinkRoot = path.join(dir, 'sessions-link');
		await mkdir(profileLinkRoot);
		await mkdir(path.join(sessionsLinkRoot, 'pi-agent'), { recursive: true });
		try {
			await symlink(external, path.join(profileLinkRoot, 'pi-agent'), 'junction');
			await symlink(path.join(external, 'sessions'), path.join(sessionsLinkRoot, 'pi-agent', 'sessions'), 'junction');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') {
				t.skip('This environment does not permit creating links');
				return;
			}
			throw error;
		}
		for (const root of [profileLinkRoot, sessionsLinkRoot]) {
			let loaded = false;
			assert.equal(await readUsageHistory(root, dir, async () => { loaded = true; return undefined; }), undefined);
			assert.equal(loaded, false);
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});
