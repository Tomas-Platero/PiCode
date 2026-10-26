/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the editor adds to a prompt, as a pure function.
 *
 * `context.ts` imports nothing relative (no `vscode`), so `node --test` runs it directly: the
 * checks below are the block the in-process chat prepends, and the
 * frame the transcript replay strips back out (`sessions-provider.ts`).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentFrame, applyContextMode, contextBlock, contextModeOf, conversationName, withContext, isSlashCommand } from '../src/context.ts';

test('nothing to say means no block, not an empty header', () => {
	assert.equal(contextBlock({}), undefined);
	assert.equal(contextBlock({ folder: '', file: '' }), undefined);
});

test('the folder, the open file and the selection are written for the agent', () => {
	const block = contextBlock({
		folder: 'D:\\repos\\app',
		file: 'D:\\repos\\app\\src\\a.ts',
		selection: { text: 'const a = 1;', lines: 1 },
	});
	assert.match(block ?? '', /Workspace: D:\\repos\\app/);
	assert.match(block ?? '', /File the owner has open: D:\\repos\\app\\src\\a\.ts/);
	assert.match(block ?? '', /Selected in it \(1 line\(s\), capped\):/);
	assert.match(block ?? '', /const a = 1;/);
});

test('an empty selection is not a selection', () => {
	assert.equal(contextBlock({ file: 'a.ts', selection: { text: '   \n', lines: 2 } })?.includes('Selected'), false);
});

test('the problems travel with their severity and their line', () => {
	const block = contextBlock({
		file: 'a.ts',
		diagnostics: [
			{ severity: 'error', line: 12, message: 'Cannot find name "x".' },
			{ severity: 'warning', line: 3, message: '"y" is declared but never read.' },
		],
	});
	assert.match(block ?? '', /Problems in it \(2, capped\):/);
	assert.match(block ?? '', /- error at line 12: Cannot find name "x"\./);
	assert.match(block ?? '', /- warning at line 3: "y" is declared but never read\./);
});

test('an attachment with text carries it; one without still says what was attached', () => {
	const block = contextBlock({
		attachments: [
			{ label: 'vscode.file', text: 'src/a.ts' },
			{ label: 'vscode.problems' },
		],
	});
	assert.match(block ?? '', /- Attached by the owner: vscode\.file\n```\nsrc\/a\.ts\n```/);
	assert.match(block ?? '', /- Attached by the owner: vscode\.problems/);
});

test('a huge selection is capped, because a whole file in every prompt is a bill', () => {
	const block = contextBlock({ selection: { text: 'x'.repeat(9000), lines: 1 } }) ?? '';
	assert.equal(block.includes('x'.repeat(8000)), true);
	assert.equal(block.includes('x'.repeat(8001)), false);
});

test('withContext puts the frame first and the request last', () => {
	const prompt = withContext('fix this', contextBlock({ file: 'a.ts' }), 'internal');
	assert.match(prompt, /^You are pi, the coding agent that runs inside the PiCode editor\./);
	assert.match(prompt, /Context from the editor, as it is right now:/);
	assert.equal(prompt.endsWith('\n\n---\n\nfix this'), true);
});

test('withContext without a context still frames the agent, and the frame names where it runs', () => {
	const prompt = withContext('hola', undefined, 'external');
	assert.match(prompt, /answering through the PiCode editor/);
	assert.equal(prompt.includes('Context from the editor'), false);
	assert.equal(prompt.endsWith('\n\n---\n\nhola'), true);
	assert.match(agentFrame('internal'), /runs inside the PiCode editor/);
	assert.match(agentFrame('external'), /the machine's own coding agent/);
});

test('the mode decides what travels, and the default sends what the product already sent', () => {
	const full = {
		folder: '/repo',
		file: '/repo/a.ts',
		selection: { text: 'const a = 1;', lines: 1 },
		diagnostics: [{ severity: 'error' as const, line: 3, message: 'boom' }],
		attachments: [{ label: '#file', text: 'x' }],
	};

	// `project` is untouched: this is the behaviour of every version before the setting existed.
	assert.deepEqual(applyContextMode(full, 'project'), full);

	// `file` drops the folder and keeps the rest.
	const file = applyContextMode(full, 'file');
	assert.equal(file.folder, undefined);
	assert.equal(file.file, '/repo/a.ts');
	assert.equal(file.selection?.text, 'const a = 1;');
	assert.equal(file.diagnostics?.length, 1);

	// `selection` names no path at all — neither the folder nor the file — and keeps what the
	// owner pointed at, including a hand attachment.
	const selection = applyContextMode(full, 'selection');
	assert.equal(selection.folder, undefined);
	assert.equal(selection.file, undefined);
	assert.equal(selection.diagnostics, undefined);
	assert.equal(selection.selection?.text, 'const a = 1;');
	assert.equal(selection.attachments?.length, 1);
});

test('a mode that is not one of the three falls back to the default', () => {
	assert.equal(contextModeOf('selection'), 'selection');
	assert.equal(contextModeOf('file'), 'file');
	assert.equal(contextModeOf('project'), 'project');
	assert.equal(contextModeOf('everything'), 'project');
	assert.equal(contextModeOf(undefined), 'project');
	assert.equal(contextModeOf(7), 'project');
});

test('selection mode with nothing selected says nothing rather than naming the file', () => {
	const block = contextBlock(applyContextMode({ folder: '/repo', file: '/repo/a.ts' }, 'selection'));
	assert.equal(block, undefined);
});

test('a slash command is recognised by its first word, and a path is not one', () => {
	for (const command of ['/gentle:status', '/mcp login github', '  /skill:judgment-day  ', '/gentle:mode yolo']) {
		assert.equal(isSlashCommand(command), true, command);
	}
	for (const text of ['/etc/hosts explain this', 'explain /gentle:status', '', '/', '//comment']) {
		assert.equal(isSlashCommand(text), false, text);
	}
});

test('a slash command reaches pi first, unframed; any other request keeps its frame', () => {
	assert.equal(withContext('/gentle:status', 'CONTEXT', 'internal'), '/gentle:status');
	assert.equal(withContext('  /mcp login x ', undefined, 'internal'), '/mcp login x');
	assert.ok(withContext('hola', 'CONTEXT', 'internal').includes('CONTEXT'));
});

test('a conversation is named by the first line of its first message', () => {
	assert.equal(conversationName('hola soy tomás'), 'hola soy tomás');
	assert.equal(conversationName('  fix the login\nand then the tests  '), 'fix the login');
	assert.equal(conversationName('a'.repeat(60)), `${'a'.repeat(47)}…`);
	assert.equal(conversationName('   '), undefined);
	assert.equal(conversationName('/gentle:models'), undefined);
});
