/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The durable daemon's conversations, as the Sessions panel lists them.
 *
 * `durable-sessions.ts` is pure (no `vscode`), so `node --test` runs it directly: the shapes
 * below are the daemon's own `sessions` rows and the `subscribe` snapshot's entries, exactly
 * as `durable` sends them over the local pipe.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	durableEntryText,
	durableSessionMarkdown,
	durableSessionRow,
	durableSessionRows,
	durableSessionTurns,
	sessionsDigest,
	type DurableConversationRow,
} from '../src/durable-sessions.ts';

/** A conversation row as the daemon's `sessions` shapes it. */
const conversation = (id: number, entries = 3, note = ''): DurableConversationRow =>
	({ id, entries, newest: `entry ${entries} (pi.assistant)`, note });

/** A snapshot entry, as `durable/lib/render.js` reads their kinds. */
const entry = (kind: string, text?: string, timestamp?: number): unknown => ({
	kind,
	...(text === undefined ? {} : { model: [{ role: kind === 'pi.user' ? 'user' : 'assistant', content: text, ...(timestamp === undefined ? {} : { timestamp }) }] }),
});

test('the label is the conversation\'s first user prompt, capped at eighty characters', () => {
	const snapshot = { entries: [entry('pi.system'), entry('pi.user', 'Arregla el panel de sesiones, por favor'), entry('pi.assistant', 'Done.')] };
	assert.equal(durableSessionRow(conversation(7), snapshot).label, 'Arregla el panel de sesiones, por favor');

	const long = 'x'.repeat(120);
	assert.equal(durableSessionRow(conversation(7), { entries: [entry('pi.user', long)] }).label, `${'x'.repeat(79)}…`);
});

test('a conversation with no user words yet is called by its own name, never labelled from thin air', () => {
	assert.equal(durableSessionRow(conversation(7), { entries: [entry('pi.system')] }).label, 'Conversation 7');
	assert.equal(durableSessionRow(conversation(7), undefined).label, 'Conversation 7');
});

test('the dates come from the transcript\'s own message timestamps — earliest opens, latest ends', () => {
	const snapshot = { entries: [
		entry('pi.user', 'first', 1000),
		entry('pi.assistant', 'answer', 3000),
		entry('pi.user', 'again', 2000),
	] };
	const row = durableSessionRow(conversation(7), snapshot);
	assert.equal(row.created, 1000);
	assert.equal(row.lastActivity, 3000);
});

test('a transcript with no timestamps makes no date claim at all', () => {
	const row = durableSessionRow(conversation(7), { entries: [entry('pi.system')] });
	assert.equal(row.created, undefined);
	assert.equal(row.lastActivity, undefined);
});

test('the snapshot\'s run presence is the row\'s own in-flight state, unknown said as unknown', () => {
	assert.equal(durableSessionRow(conversation(7), { entries: [], run: {} }).inFlight, true);
	assert.equal(durableSessionRow(conversation(7), { entries: [] }).inFlight, false);
	assert.equal(durableSessionRow(conversation(7), 'junk').inFlight, undefined);
});

test('the note is durable\'s own sentence, passed through as the row\'s description', () => {
	assert.equal(durableSessionRow(conversation(7, 3, 'subagent (task t2)'), { entries: [] }).note, 'subagent (task t2)');
	assert.equal(durableSessionRow(conversation(7, 3, 'fork of 2'), { entries: [] }).note, 'fork of 2');
	assert.equal(durableSessionRow(conversation(7), undefined).note, '');
});

test('rows sort newest-first by what the transcript says, ties settled by conversation id', () => {
	const conversations = [conversation(1), conversation(2), conversation(3)];
	const snapshots = new Map<number, unknown>([
		[1, { entries: [entry('pi.user', 'a', 5000)] }],
		[2, { entries: [entry('pi.user', 'b', 9000)] }],
		// conversation 3 could not be read: it sorts by what it has — nothing — and lands last
	]);
	const rows = durableSessionRows(conversations, conv => snapshots.get(conv.id));
	assert.deepEqual(rows.map(r => r.id), [2, 1, 3]);

	// Two conversations with no dates at all: the higher id (created later, by the daemon's
	// own assignment order) leads. Each carries its own opening prompt — two conversations
	// without turns AND without words are indistinguishable copies, and the dedup keeps one.
	const undated = durableSessionRows([conversation(4), conversation(9)], conv => ({
		entries: [entry('pi.user', conv.id === 4 ? 'cuatro' : 'nueve')],
	}));
	assert.deepEqual(undated.map(r => r.id), [9, 4]);
});

test('a conversation without a usable id is skipped, not guessed into a row', () => {
	const rows = durableSessionRows([{ id: undefined as unknown as number, entries: 1, note: '' }, conversation(5)], () => ({ entries: [] }));
	assert.deepEqual(rows.map(r => r.id), [5]);
});

test('the replay is the two talking kinds only — plumbing and tool results stay out', () => {
	const snapshot = { entries: [
		entry('pi.system'),
		entry('pi.user', 'What did you do?'),
		entry('pi.assistant', 'I read the panel and fixed it.'),
		entry('pi.tool-result', 'noisy output'),
		entry('pi.user', ''),
		entry('pi.assistant', ''),
	] };
	assert.deepEqual(durableSessionTurns(snapshot), [
		{ role: 'user', text: 'What did you do?' },
		{ role: 'assistant', text: 'I read the panel and fixed it.' },
	]);
	assert.deepEqual(durableSessionTurns(undefined), []);
});

test('entry text is the model messages\' own text, joined — nothing else is read', () => {
	assert.equal(durableEntryText({ kind: 'pi.assistant', model: [{ content: 'part one' }, { content: 'part two' }] }), 'part one part two');
	assert.equal(durableEntryText({ kind: 'pi.system' }), '');
	assert.equal(durableEntryText(undefined), '');
});

test('the poll\'s digest moves when a conversation is added, removed, or grown — and only then', () => {
	const before = sessionsDigest([conversation(1, 3), conversation(2, 5)]);
	assert.equal(sessionsDigest([conversation(1, 3), conversation(2, 5)]), before, 'same answer, same digest');
	assert.notEqual(sessionsDigest([conversation(1, 4), conversation(2, 5)]), before, 'a conversation grew');
	assert.notEqual(sessionsDigest([conversation(2, 5)]), before, 'a conversation is gone');
	assert.equal(sessionsDigest([conversation(2, 5), conversation(1, 3)]), before, 'order alone must not move the digest — it is canonical');

	// A row whose entry count the daemon did not send reads as the same "unknown" a -1 does:
	// neither can be told apart from the other, and neither is a zero.
	assert.equal(sessionsDigest([{ id: 1, entries: undefined as unknown as number, note: '' }]), sessionsDigest([{ id: 1, entries: -1, note: '' }]));
});

test('the frame the editor adds is stripped from the label and from the replayed turn', () => {
	const frame = 'You are pi, the coding agent that runs inside the PiCode editor. You answer about the project the person you are talking to has open in it.\n\nContext from the editor, as it is right now:\n\n- Workspace: D:\\repos\\app\n\n---\n\n';
	const framed = `${frame}fix the panel`;
	const snapshot = { entries: [entry('pi.user', framed), entry('pi.assistant', 'Done.')] };
	assert.equal(durableSessionRow(conversation(7), snapshot).label, 'fix the panel');
	assert.deepEqual(durableSessionTurns(snapshot), [
		{ role: 'user', text: 'fix the panel' },
		{ role: 'assistant', text: 'Done.' },
	]);
});

test('a message the editor did not frame is left whole, separator or not', () => {
	assert.equal(durableSessionRow(conversation(7), { entries: [entry('pi.user', 'before --- after')] }).label, 'before --- after');
	const bare = 'a note written by hand\n\n---\n\nand its continuation';
	assert.deepEqual(durableSessionTurns({ entries: [entry('pi.user', bare)] }), [{ role: 'user', text: bare }]);
});

test('the Markdown export is a standalone document: header, then the turns in transcript order', () => {
	const snapshot = {
		entries: [
			entry('pi.system'),
			entry('pi.user', 'Exporta esto', 1_700_000_000_000),
			entry('pi.assistant', 'Hecho.', 1_700_000_060_000),
		],
	};
	const md = durableSessionMarkdown(snapshot, { conversationId: 7, label: 'Exporta esto', exportedAt: '2026-10-15T00:00:00.000Z' });
	assert.match(md, /^# Exporta esto\n/);
	assert.match(md, /- Conversation: 7\n/);
	assert.match(md, /- Turns: 2\n/);
	assert.match(md, /- Started: 2023-11-14T22:13:20.000Z\n/);
	assert.match(md, /- Last activity: 2023-11-14T22:14:20.000Z\n/);
	assert.match(md, /- Exported: 2026-10-15T00:00:00.000Z\n/);
	const turnHeaders = md.split('\n').filter(line => line.startsWith('### '));
	assert.deepEqual(turnHeaders, ['### 👤 User', '### 🤖 Assistant']);
	assert.ok(md.indexOf('Exporta esto', md.indexOf('### 👤 User')) > 0, 'the user turn text follows its header');
	assert.ok(md.trimEnd().endsWith('Hecho.'), 'the assistant turn closes the file');
});

test('a conversation with no readable words exports with its own name and zero turns, not an invented transcript', () => {
	const md = durableSessionMarkdown(undefined, { conversationId: 9, exportedAt: '2026-10-15T00:00:00.000Z' });
	assert.match(md, /^# Conversation 9\n/);
	assert.match(md, /- Turns: 0\n/);
	assert.ok(!md.includes('- Started:'), 'no timestamps the daemon never sent');
	assert.ok(!md.includes('###'), 'no turns where there are none');
});
