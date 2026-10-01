/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Gentle subagent reader, run on its own.
 *
 * `node --test` runs this file directly (Node's own type stripping), which is why
 * `subagents.ts` carries no `vscode` import: the presence files, the task files and the
 * transcript rendering are pure parsing over shapes gentle-pi writes, and every filesystem
 * touch is injectable so no test reads a real home.
 */

import assert from 'assert';
import { test } from 'node:test';
import * as path from 'node:path';
import {
	activityLines,
	gentleAgentsHome,
	listTaskFiles,
	presenceActivityPath,
	presenceIncarnations,
	readPresenceActivity,
	readTaskRecord,
	readTaskTranscriptPath,
	relativeTime,
	sessionHash,
	sessionToMarkdown,
	type DirEntry,
} from '../src/subagents.ts';

/** sha256("abc"), the known vector every assertion below leans on. */
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

/** An injectable file system: files by absolute path, entries per directory. */
function fakeFs(files: Readonly<Record<string, string>>, entries: Readonly<Record<string, readonly DirEntry[]>> = {}) {
	return {
		readJson: (file: string): unknown => {
			const text = files[file];
			if (text === undefined) {
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			}
			return JSON.parse(text);
		},
		listDir: (dir: string): readonly DirEntry[] => entries[dir] ?? [],
	};
}

test('sessionHash is the sha256 hex digest of the session id', () => {
	assert.strictEqual(sessionHash('abc'), ABC_SHA256);
});

test('gentleAgentsHome resolves the env overrides before the default home', () => {
	assert.strictEqual(
		gentleAgentsHome({ GENTLE_PI_AGENT_HOME: 'C:/first' }),
		path.join('C:/first', 'gentle-agents'),
	);
	assert.strictEqual(
		gentleAgentsHome({ PI_CODING_AGENT_DIR: 'C:/second' }),
		path.join('C:/second', 'gentle-agents'),
	);
	// An empty override falls through, mirroring gentle-pi's own resolver.
	assert.strictEqual(
		gentleAgentsHome({ GENTLE_PI_AGENT_HOME: '', PI_CODING_AGENT_DIR: 'C:/second' }),
		path.join('C:/second', 'gentle-agents'),
	);
	const fallback = gentleAgentsHome({});
	assert.ok(fallback.endsWith(path.join('.pi', 'agent', 'gentle-agents')), fallback);
});

test('presenceActivityPath joins the hashed session, the incarnation and the kind', () => {
	assert.strictEqual(
		presenceActivityPath('abc', 'C:/home', 'inc-1'),
		path.join('C:/home', 'gentle-agents', 'presence', `${ABC_SHA256}.inc-1.activity.json`),
	);
});

test('presenceIncarnations lists only this session\'s activity files, oldest first', () => {
	const entries: readonly DirEntry[] = [
		{ name: `${ABC_SHA256}.old.activity.json`, mtimeMs: 1 },
		{ name: `${ABC_SHA256}.new.activity.json`, mtimeMs: 2 },
		{ name: 'otherhash.old.activity.json', mtimeMs: 3 },
		{ name: `${ABC_SHA256}.x.header.json`, mtimeMs: 4 },
	];
	const found = presenceIncarnations('abc', 'C:/home', () => entries);
	assert.deepStrictEqual(found, ['old', 'new']);
});

test('readPresenceActivity tolerates a missing, corrupt and half-written file', () => {
	const { readJson, listDir } = fakeFs({});
	assert.strictEqual(readPresenceActivity('abc', 'C:/home', readJson, undefined, listDir), undefined);
	assert.strictEqual(readPresenceActivity('abc', 'C:/missing-home', readJson, 'inc-1', listDir), undefined);

	const broken = fakeFs({
		[path.join('C:/home', 'gentle-agents', 'presence', `${ABC_SHA256}.inc-1.activity.json`)]: '{"schema":1,"activ',
	});
	assert.strictEqual(readPresenceActivity('abc', 'C:/home', broken.readJson, 'inc-1', broken.listDir), undefined);
});

test('readPresenceActivity parses a valid activity and prefers the given incarnation', () => {
	const dir = path.join('C:/home', 'gentle-agents', 'presence');
	// The file wraps the activity, as gentle writes it: {schema, ..., activity: {tasks}}.
	const activity = {
		tasks: [{ summary: { id: 't1', agent: 'worker', status: 'running' }, thread: { items: [] } }],
	};
	const files = {
		[path.join(dir, `${ABC_SHA256}.old.activity.json`)]: JSON.stringify({ schema: 1, activity: { tasks: [] } }),
		[path.join(dir, `${ABC_SHA256}.new.activity.json`)]: JSON.stringify({ schema: 1, activity }),
	};
	const entries = {
		[dir]: [
			{ name: `${ABC_SHA256}.old.activity.json`, mtimeMs: 1 },
			{ name: `${ABC_SHA256}.new.activity.json`, mtimeMs: 2 },
		],
	};
	const { readJson, listDir } = fakeFs(files, entries);

	const newest = readPresenceActivity('abc', 'C:/home', readJson, undefined, listDir);
	assert.ok(newest !== undefined);
	assert.strictEqual(newest.incarnation, 'new');
	// `tasks` is `unknown` in the reading — it is another program's JSON — so the test says the shape
	// it is about to check instead of indexing something the type does not describe.
	const tasks = newest.activity.tasks as Array<{ summary?: { agent?: string } }> | undefined;
	assert.strictEqual(tasks?.[0]?.summary?.agent, 'worker');

	const pinned = readPresenceActivity('abc', 'C:/home', readJson, 'old', listDir);
	assert.ok(pinned !== undefined);
	assert.strictEqual(pinned.incarnation, 'old');

	// A pinned incarnation that vanished is "no reading", never a crash.
	assert.strictEqual(readPresenceActivity('abc', 'C:/home', readJson, 'ghost', listDir), undefined);
});

function task(summary: Record<string, unknown>, items: readonly Record<string, unknown>[]): Record<string, unknown> {
	return { summary, thread: { version: 1, dropped: 0, items } };
}

test('activityLines renders one short line per subagent, capped', () => {
	const many = Array.from({ length: 12 }, (_, index) =>
		task({ id: `t${index}`, agent: `agent-${index}`, status: 'running' }, []));
	const lines = activityLines({ tasks: many });
	assert.strictEqual(lines.length, 8);
	assert.ok(lines[0]!.startsWith('agent-0'));
});

test('activityLines marks errors and finished tasks, and collapses tool output to a line', () => {
	const lines = activityLines({
		tasks: [
			task({ id: 't1', agent: 'scout', status: 'running' }, [
				{ kind: 'tool', name: 'grep', output: 'src/a.ts:1: hit\nsrc/b.ts:2: other', running: true, isError: false },
			]),
			task({ id: 't2', agent: 'worker', status: 'completed' }, [
				{ kind: 'tool', name: 'bash', output: 'boom', running: false, isError: true },
			]),
			task({ id: 't3', agent: 'reviewer', status: 'queued' }, []),
		],
	});
	assert.deepStrictEqual(lines, [
		'scout · grep src/a.ts:1: hit',
		'worker · bash boom · error',
		'reviewer · queued',
	]);
});

test('sessionToMarkdown renders role headers, collapses tool results and skips the unknown', () => {
	const jsonl = [
		JSON.stringify({ type: 'session', version: 3, id: 's1', cwd: 'C:/repo' }),
		JSON.stringify({ type: 'model_change', provider: 'nan', modelId: 'x' }),
		JSON.stringify({ type: 'custom', customType: 'gentle-agents.result', data: {} }),
		JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Fix the tests' }] } }),
		JSON.stringify({
			type: 'message',
			message: {
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'hidden from the transcript' },
					{ type: 'text', text: 'On it.' },
					{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } },
				],
			},
		}),
		JSON.stringify({
			type: 'message',
			message: { role: 'toolResult', toolCallId: 'c1', toolName: 'read', isError: false, content: [{ type: 'text', text: 'first line\nsecond line\nthird line' }] },
		}),
		'{"type":"message" broken',
	].join('\n');

	const markdown = sessionToMarkdown(jsonl, { title: 'Scout transcript' });
	assert.ok(markdown.includes('# Scout transcript'));
	assert.ok(markdown.includes('## User'));
	assert.ok(markdown.includes('Fix the tests'));
	assert.ok(markdown.includes('## Assistant'));
	assert.ok(markdown.includes('On it.'));
	assert.ok(markdown.includes('`read`'));
	// Collapsed: the tool result keeps only its first line unless expanded.
	assert.ok(markdown.includes('first line'));
	assert.ok(!markdown.includes('second line'));
	// Thinking and the metadata/custom entries stay out.
	assert.ok(!markdown.includes('hidden from the transcript'));
	assert.ok(!markdown.includes('gentle-agents.result'));

	const expanded = sessionToMarkdown(jsonl, { expandTools: true });
	assert.ok(expanded.includes('second line'));
	assert.ok(expanded.includes('third line'));
});

test('readTaskTranscriptPath resolves the session file, or undefined without one', () => {
	const dir = path.join('C:/home', 'gentle-agents', 'tasks');
	const taskFile = path.join(dir, 'task-1.json');
	const good = fakeFs({ [taskFile]: JSON.stringify({ task: { id: 'task-1', sessionPath: 'C:/sessions/a.jsonl' } }) });
	assert.strictEqual(readTaskTranscriptPath('task-1', 'C:/home', good.readJson), 'C:/sessions/a.jsonl');

	const bare = fakeFs({ [taskFile]: JSON.stringify({ task: { id: 'task-1' } }) });
	assert.strictEqual(readTaskTranscriptPath('task-1', 'C:/home', bare.readJson), undefined);

	assert.strictEqual(readTaskTranscriptPath('missing', 'C:/home', good.readJson), undefined);
	const corrupt = fakeFs({ [taskFile]: '{' });
	assert.strictEqual(readTaskTranscriptPath('task-1', 'C:/home', corrupt.readJson), undefined);

	// A task id is a file name; anything that escapes the tasks directory is refused.
	assert.strictEqual(readTaskTranscriptPath('../presence/x', 'C:/home', good.readJson), undefined);
});

test('readTaskRecord keeps what a quick pick needs', () => {
	const dir = path.join('C:/home', 'gentle-agents', 'tasks');
	const record = fakeFs({
		[path.join(dir, 'task-1.json')]: JSON.stringify({ task: { agent: 'scout', label: 'map the thing', status: 'completed', endedAt: 5_000 } }),
	});
	const read = readTaskRecord(path.join(dir, 'task-1.json'), record.readJson);
	assert.deepStrictEqual(read, { agent: 'scout', label: 'map the thing', status: 'completed', endedAt: 5_000 });
	assert.strictEqual(readTaskRecord(path.join(dir, 'nope.json'), record.readJson), undefined);
});

test('listTaskFiles filters json files and sorts newest first', () => {
	const entries: readonly DirEntry[] = [
		{ name: 'a.json', mtimeMs: 3 },
		{ name: 'notes.txt', mtimeMs: 9 },
		{ name: 'b.json', mtimeMs: 1 },
		{ name: 'c.json', mtimeMs: 2 },
	];
	const files = listTaskFiles('C:/home', () => entries);
	assert.deepStrictEqual(files.map(file => path.basename(file.file)), ['a.json', 'c.json', 'b.json']);
	assert.ok(files[0]!.mtimeMs >= files[files.length - 1]!.mtimeMs);
});

test('relativeTime speaks short English deltas', () => {
	const now = 1_000_000_000_000;
	assert.strictEqual(relativeTime(now - 20_000, now), 'just now');
	assert.strictEqual(relativeTime(now - 5 * 60_000, now), '5m ago');
	assert.strictEqual(relativeTime(now - 3 * 3_600_000, now), '3h ago');
	assert.strictEqual(relativeTime(now - 2 * 86_400_000, now), '2d ago');
	const month = relativeTime(now - 90 * 86_400_000, now);
	assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(month), month);
});
