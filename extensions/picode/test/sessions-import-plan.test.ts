import * as assert from 'assert';
import { test } from 'node:test';
import {
	completingCopy,
	importMessages,
	missingMessages,
	type ImportPlanCopy,
	type ImportPlanMessage,
	type ImportPlanTurn,
} from '../src/sessions-import-plan.ts';
import { sessionTail } from '../src/sessions-provider.ts';

const user = (text: string, timestamp?: number): ImportPlanTurn => ({ role: 'user', text, ...(timestamp === undefined ? {} : { timestamp }) });
const assistant = (text: string, timestamp?: number): ImportPlanTurn => ({ role: 'assistant', text, ...(timestamp === undefined ? {} : { timestamp }) });

test('importMessages appends the interrupted tail the turns parser leaves out', () => {
	const messages = importMessages({
		turns: [user('hello')],
		tail: { role: 'assistant', text: '', content: [{ type: 'toolCall', toolCallId: 't1' }] },
	});
	assert.deepStrictEqual(messages.map(message => message.role), ['user', 'assistant']);
	assert.strictEqual(messages[1].text, '');
	assert.deepStrictEqual(messages[1].content, [{ type: 'toolCall', toolCallId: 't1' }]);
});

test('importMessages skips a tail the turns already end with', () => {
	const tail = { role: 'assistant' as const, text: 'hola, que tal', content: [{ type: 'text', text: 'hola, que tal' }] };
	const messages = importMessages({
		turns: [user('hello'), assistant('hola, que tal')],
		tail,
	});
	assert.deepStrictEqual(messages.map(message => message.role), ['user', 'assistant']);
	assert.deepStrictEqual(messages[1].content, tail.content);
});

test('importMessages appends an unanswered tail prompt the turns parser skipped', () => {
	// A message with no text (an image-only prompt) is not a turn, but it IS the
	// session's end: the copy must end on it, or the panel reads the conversation
	// as answered when it was not.
	const messages = importMessages({
		turns: [user('hello'), assistant('hola, que tal')],
		tail: { role: 'user', text: '', content: [{ type: 'image', source: 'x' }] },
	});
	assert.deepStrictEqual(messages.map(message => message.role), ['user', 'assistant', 'user']);
	assert.deepStrictEqual(messages[2].content, [{ type: 'image', source: 'x' }]);
});

test('importMessages keeps the turns\' stamps and the tail\'s own stamp', () => {
	const messages = importMessages({
		turns: [user('hola', 1000)],
		tail: { role: 'assistant', text: '', content: [], timestamp: 2000 },
	});
	assert.strictEqual(messages[0].timestamp, 1000);
	assert.strictEqual(messages[1].timestamp, 2000);
});

test('completingCopy picks the copy whose turns are a prefix of the file', () => {
	const file = [
		{ role: 'user' as const, text: 'hello', content: [] },
		{ role: 'assistant' as const, text: 'hola, que tal', content: [] },
		{ role: 'assistant' as const, text: '', content: [] },
	];
	const older: ImportPlanCopy = { id: 10, turns: [user('hello')], modelEntries: 2 };
	const other: ImportPlanCopy = { id: 5, turns: [user('something else')], modelEntries: 2 };
	const diverged: ImportPlanCopy = { id: 20, turns: [user('hello'), user('and this?')], modelEntries: 3 };
	assert.strictEqual(completingCopy([other, diverged, older], file)?.id, 10);
	assert.strictEqual(completingCopy(undefined, file), undefined);
	assert.strictEqual(completingCopy([], file), undefined);
});

test('completingCopy picks the OLDEST among several prefixes', () => {
	const file = [
		{ role: 'user' as const, text: 'hello', content: [] },
		{ role: 'assistant' as const, text: '', content: [] },
	];
	const copies: ImportPlanCopy[] = [
		{ id: 30, turns: [user('hello')], modelEntries: 1 },
		{ id: 12, turns: [user('hello')], modelEntries: 1 },
	];
	assert.strictEqual(completingCopy(copies, file)?.id, 12);
});

test('missingMessages gives what the raw entry count is short of — tail included', () => {
	const messages: ImportPlanMessage[] = [
		{ role: 'user', text: 'hello', content: [] },
		{ role: 'assistant', text: 'hola, que tal', content: [] },
		{ role: 'assistant', text: '', content: [] },
	];
	const short: ImportPlanCopy = { id: 1, turns: [user('hello')], modelEntries: 2 };
	assert.deepStrictEqual(missingMessages(short, messages), [messages[2]]);
});

test('missingMessages gives nothing to a copy that already carries the tail', () => {
	const messages: ImportPlanMessage[] = [
		{ role: 'user', text: 'hello', content: [] },
		{ role: 'assistant', text: '', content: [] },
	];
	const healed: ImportPlanCopy = { id: 1, turns: [user('hello')], modelEntries: 2 };
	assert.deepStrictEqual(missingMessages(healed, messages), []);
});

test('missingMessages gives nothing to a copy that continued past the file', () => {
	const messages: ImportPlanMessage[] = [{ role: 'user', text: 'hello', content: [] }];
	const continued: ImportPlanCopy = { id: 1, turns: [user('hello'), assistant('I continued')], modelEntries: 4 };
	assert.deepStrictEqual(missingMessages(continued, messages), []);
});

const line = (value: unknown): string => JSON.stringify(value);

test('sessionTail reads the last turn of a transcript that ended mid-work', () => {
	const jsonl = [
		line({ type: 'message', id: 'e1', timestamp: '2026-10-09T22:51:30.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Este pi tiene pi durable?' }] } }),
		line({ type: 'message', id: 'e2', timestamp: '2026-10-09T22:51:35.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }, { type: 'toolCall', toolCallId: 't1' }] } }),
		line({ type: 'message', id: 'e3', message: { role: 'toolResult', content: [{ type: 'text', text: 'output' }] } }),
	].join('\n');
	const tail = sessionTail(jsonl);
	assert.strictEqual(tail?.role, 'assistant');
	assert.strictEqual(tail?.text, '');
	assert.deepStrictEqual(tail?.content, [{ type: 'thinking', thinking: '...' }, { type: 'toolCall', toolCallId: 't1' }]);
});

test('sessionTail reads the empty interrupted assistant turn', () => {
	const jsonl = line({ type: 'message', id: 'e2', message: { role: 'assistant', content: [] } });
	const tail = sessionTail(jsonl);
	assert.strictEqual(tail?.role, 'assistant');
	assert.strictEqual(tail?.text, '');
	assert.deepStrictEqual(tail?.content, []);
});

test('sessionTail reads an answered transcript as its last turn', () => {
	const jsonl = [
		line({ type: 'message', id: 'e1', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
		line({ type: 'message', id: 'e2', message: { role: 'assistant', content: [{ type: 'text', text: 'hola, que tal' }] } }),
	].join('\n');
	assert.deepStrictEqual(sessionTail(jsonl), { role: 'assistant', text: 'hola, que tal', content: [{ type: 'text', text: 'hola, que tal' }], timestamp: undefined });
});

test('sessionTail answers nothing for a transcript without turns', () => {
	assert.strictEqual(sessionTail('not json'), undefined);
	assert.strictEqual(sessionTail(line({ type: 'model_change', id: 'x' })), undefined);
});

test('importOutcomeMessage says what the panel now holds — or why it does not', async () => {
	const { importOutcomeMessage } = await import('../src/sessions-import-plan.ts');
	assert.strictEqual(
		importOutcomeMessage({ landed: 0, repaired: 0, completed: 0, daemonDown: true }),
		'PiCode: the conversations are in this profile, but the durable agent did not answer, so the panel does not list them yet. Import again once PiCode is running normally.',
	);
	assert.strictEqual(
		importOutcomeMessage({ landed: 3, repaired: 0, completed: 0, daemonDown: false }),
		'PiCode: 3 new conversations. The panel lists them now.',
	);
	assert.strictEqual(
		importOutcomeMessage({ landed: 1, repaired: 2, completed: 4, daemonDown: false }),
		'PiCode: 1 new conversation, 4 completed with the turns they were missing, 2 re-homed. The panel lists them now.',
	);
	assert.strictEqual(
		importOutcomeMessage({ landed: 0, repaired: 0, completed: 0, daemonDown: false }),
		'PiCode: every conversation in this profile is already in the panel — nothing new to add.',
	);
});
