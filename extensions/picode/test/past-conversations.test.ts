import * as assert from 'assert';
import { test } from 'node:test';
import { listConversations, pastConversationTools, readConversation, READ_PAGE_CHARS, type ConversationSource } from '../src/past-conversations.ts';
import type { PiSessionFile, PiSessionTurn } from '../src/sessions-provider.ts';

function transcript(...turns: Array<['user' | 'assistant', string]>): PiSessionTurn[] {
	return turns.map(([role, text]) => ({ role, text }));
}

const files: PiSessionFile[] = [
	{ id: 'aaaa1111-0000', file: 'today.jsonl', label: 'hey', mtime: Date.parse('2026-10-27T09:00:00Z') },
	{ id: 'bbbb2222-0000', file: 'yesterday.jsonl', label: 'hola soy tomás', mtime: Date.parse('2026-10-26T20:00:00Z') },
];
const texts: Record<string, PiSessionTurn[]> = {
	'today.jsonl': transcript(['user', 'hey'], ['assistant', 'hi']),
	'yesterday.jsonl': transcript(['user', 'hola soy tomás'], ['assistant', 'Encantado, Tomás.']),
};
const source: ConversationSource = { list: () => files, current: () => 'today.jsonl', turns: file => texts[file] ?? [] };

test('the list shows every conversation and marks the one asking', () => {
	const text = listConversations(source, undefined);
	assert.match(text, /aaaa1111-0000 · 2026-10-27 09:00 · hey \(this conversation\)/);
	assert.match(text, /bbbb2222-0000 · 2026-10-26 20:00 · hola soy tomás$/m);
});

test('a query finds the conversations whose text holds it, case folded', () => {
	const text = listConversations(source, 'TOMÁS');
	assert.match(text, /bbbb2222/);
	assert.doesNotMatch(text, /aaaa1111/);
	assert.strictEqual(listConversations(source, 'nowhere'), 'No earlier conversation mentions "nowhere".');
});

test('reading a conversation by its short id gives both sides', () => {
	const text = readConversation(source, 'bbbb');
	assert.match(text, /User: hola soy tomás/);
	assert.match(text, /Assistant: Encantado, Tomás\./);
});

test('an unknown or ambiguous id is an error the model can act on', () => {
	assert.throws(() => readConversation(source, 'zzzz'), /past_conversations/);
	assert.throws(() => readConversation(source, ''), /No conversation/);
	const twins: ConversationSource = { ...source, list: () => [files[0], { ...files[1], id: 'aaaa9999' }] };
	assert.throws(() => readConversation(twins, 'aaaa'), /more than one/);
	assert.match(readConversation(twins, 'aaaa9999'), /Encantado/);
});

test('a long conversation is read a page at a time', () => {
	const long: ConversationSource = { ...source, turns: () => transcript(['user', 'x'.repeat(READ_PAGE_CHARS + 500)]) };
	const first = readConversation(long, 'bbbb');
	const offset = Number(/offset (\d+)/.exec(first)?.[1]);
	assert.strictEqual(offset, READ_PAGE_CHARS);
	assert.doesNotMatch(readConversation(long, 'bbbb', offset), /more characters/);
});

test('the tools answer with text, as pi reads it', async () => {
	const [list, read] = pastConversationTools(source);
	assert.strictEqual(list.name, 'past_conversations');
	const listed = await list.execute('1', { query: 'tomás' });
	assert.match(listed.content[0].text, /bbbb2222/);
	const opened = await read.execute('2', { id: 'bbbb2222' });
	assert.match(opened.content[0].text, /Encantado/);
});
