/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The durable daemon's conversations, as the Sessions panel lists them.
 *
 * `durable-sessions.ts` is pure (no `vscode`), so `node --test` runs it directly: the shapes
 * below are the daemon's own `sessions` rows and the `subscribe` snapshot's entries, exactly
 * as `picode-source/durable` sends them over the local pipe.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	durableEntryText,
	durableSessionRow,
	durableSessionRows,
	durableSessionTurns,
	sessionsDigest,
	type DurableConversationRow,
} from '../src/durable-sessions.ts';

/** A conversation row as the daemon's `sessions` shapes it. */
const conversation = (id: number, entries = 3, note = ''): DurableConversationRow =>
	({ id, entries, newest: `entry ${entries} (pi.assistant)`, note });

/** A snapshot entry, as `picode-source/durable/lib/render.js` reads their kinds. */
const entry = (kind: string, text?: string, timestamp?: number): unknown => ({
	kind,
	...(text === undefined ? {} : { model: [{ role: kind === 'pi.user' ? 'user' : 'assistant', content: text, ...(timestamp === undefined ? {} : { timestamp }) }] }),
});

test('the label is the conversation\'s first user prompt, capped at eighty characters', () => {
	const snapshot = { entries: [entry('pi.system'), entry('pi.user', 'Arregla el panel de sesiones, por favor'), entry('pi.assistant', 'Hecho.')] };
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
	// own assignment order) leads.
	const undated = durableSessionRows([conversation(4), conversation(9)], () => undefined);
	assert.deepEqual(undated.map(r => r.id), [9, 4]);
});

test('a conversation without a usable id is skipped, not guessed into a row', () => {
	const rows = durableSessionRows([{ id: undefined as unknown as number, entries: 1, note: '' }, conversation(5)], () => ({ entries: [] }));
	assert.deepEqual(rows.map(r => r.id), [5]);
});

test('the replay is the two talking kinds only — plumbing and tool results stay out', () => {
	const snapshot = { entries: [
		entry('pi.system'),
		entry('pi.user', '¿Qué hiciste?'),
		entry('pi.assistant', 'Leí el panel y lo arreglé.'),
		entry('pi.tool-result', 'noisy output'),
		entry('pi.user', ''),
		entry('pi.assistant', ''),
	] };
	assert.deepEqual(durableSessionTurns(snapshot), [
		{ role: 'user', text: '¿Qué hiciste?' },
		{ role: 'assistant', text: 'Leí el panel y lo arreglé.' },
	]);
	assert.deepEqual(durableSessionTurns(undefined), []);
});

test('entry text is the model messages\' own text, joined — nothing else is read', () => {
	assert.equal(durableEntryText({ kind: 'pi.assistant', model: [{ content: 'parte uno' }, { content: 'parte dos' }] }), 'parte uno parte dos');
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
