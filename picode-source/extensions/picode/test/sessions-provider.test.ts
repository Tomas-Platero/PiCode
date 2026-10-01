import * as assert from 'assert';
import { test } from 'node:test';
import { firstUserPrompt, sessionTurns, listSessionFiles } from '../src/sessions-provider.ts';

test('firstUserPrompt answers the first user text', () => {
	const jsonl = [
		'{"type":"session","version":3,"id":"abc","timestamp":"2026-09-28T09:00:00.000Z","cwd":"C:\\\\demo"}',
		'{"type":"message","id":"e1","timestamp":"2026-09-28T09:00:05.000Z","message":{"role":"user","content":[{"type":"text","text":"hola pi"}]}}',
	].join('\n');
	assert.strictEqual(firstUserPrompt(jsonl), 'hola pi');
});

test('firstUserPrompt tolerates junk and missing prompts', () => {
	assert.strictEqual(firstUserPrompt('not json'), undefined);
	assert.strictEqual(firstUserPrompt('{"type":"session","id":"x"}'), undefined);
});

test('sessionTurns maps user and assistant messages, skipping thinking and tool results', () => {
	const jsonl = [
		'{"type":"message","id":"e1","message":{"role":"user","content":[{"type":"text","text":"hola pi"}]}}',
		'{"type":"message","id":"e2","message":{"role":"assistant","content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"hola, que tal"}]}}',
		'{"type":"message","id":"e3","message":{"role":"toolResult","content":[{"type":"text","text":"output"}]}}',
		'{"type":"message","id":"e4","message":{"role":"assistant","content":[{"type":"text","text":"segunda linea"}]}}',
	].join('\n');
	assert.deepStrictEqual(sessionTurns(jsonl), [
		{ role: 'user', text: 'hola pi' },
		{ role: 'assistant', text: 'hola, que tal' },
		{ role: 'assistant', text: 'segunda linea' },
	]);
});

test('listSessionFiles walks project folders and labels from the first prompt', () => {
	const files: Record<string, string> = {
		'/sessions/--C--demo--/2026_a.jsonl': '{"type":"session","id":"a"}\n{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hola pi"}]}}',
		'/sessions/2026_b.jsonl': '{"type":"session","id":"b"}',
		'/sessions/--C--demo--/notes.txt': 'not a session',
	};
	const fs = {
		read: (file: string): string => files[file] ?? '',
		list: (dir: string): string[] => Object.keys(files)
			.filter(f => f.startsWith(dir + '/') || f === dir)
			.filter(f => !f.endsWith('.txt') || f === dir),
		mtime: (): number => 1000,
	};
	const found = listSessionFiles('/sessions', fs);
	assert.strictEqual(found.length, 2);
	assert.strictEqual(found[0].label, 'hola pi');
	assert.ok(found[1].label.length > 0);
});
