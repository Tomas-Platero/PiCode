/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The work left running in the background, as a card.
 *
 * Every string here is the real one: the call's arguments and the completion message are copied from
 * a conversation of the owner's (the `background` tool starting `npm run build`) and from a finished
 * job of this session. Nothing is invented, because nothing about these two shapes is ours to guess —
 * one is the tool's and the other is the running environment's.
 */

import * as assert from 'assert';
import { test } from 'node:test';
import {
	backgroundCallOf,
	backgroundCompletionOf,
	backgroundJobNumberOf,
	backgroundResultOf,
	backgroundStartOf,
	completionFailed,
	finishedResultLine,
	isBackgroundTool,
	runningResultLine,
} from '../src/background-cards.ts';

test('only the background tool becomes a card', () => {
	assert.strictEqual(isBackgroundTool('background'), true);
	assert.strictEqual(isBackgroundTool('bash'), false);
	assert.strictEqual(isBackgroundTool(undefined), false);
});

test('the start result repeats the label, so the card has it without the call', () => {
	// The result names the job **and** repeats the label the call carried: that repetition is what lets
	// the card stand up when the call's own arguments are not readable from where it is drawn.
	const start = backgroundStartOf('Started background job 1 (web build (ArticTempest-Web)). It keeps running while you and the user carry on.');
	assert.strictEqual(start.jobNumber, '1');
	assert.strictEqual(start.label, 'web build (ArticTempest-Web)');

	// A result without a label still names the job.
	const bare = backgroundStartOf('Started background job 7. It keeps running.');
	assert.strictEqual(bare.jobNumber, '7');
	assert.strictEqual(bare.label, undefined);

	assert.deepStrictEqual(backgroundStartOf('nothing to see here'), {});
	assert.deepStrictEqual(backgroundStartOf(undefined), {});
});

test('the arguments are read even when they crossed a boundary', () => {
	// The same call, serialised — which is how an editor-side observer sees it, and why the first card
	// drawn by this feature had no label and no command on it.
	const args = { command: 'cd "d:/repositorios/ArticTempest-Web" && npm run build 2>&1 | tail -40', label: 'web build (ArticTempest-Web)' };
	assert.deepStrictEqual(backgroundCallOf(JSON.stringify(args)), args);

	// A string that is not JSON is simply not arguments, and never a crash.
	assert.deepStrictEqual(backgroundCallOf('npm run build'), {});
});

test('a call carries the command and the label the agent gave the job', () => {
	// Copied from a real call: the label is what the job is called from then on.
	const call = backgroundCallOf({
		command: 'cd "d:/repositorios/artictempest-bot-dashboard" && npm run build 2>&1 | tail -40',
		label: 'bot build (next 16.4.0)',
	});
	assert.strictEqual(call.label, 'bot build (next 16.4.0)');
	assert.ok(call.command?.includes('npm run build'));

	// Anything else is a call with nothing worth drawing, not a crash.
	assert.deepStrictEqual(backgroundCallOf(undefined), {});
	assert.deepStrictEqual(backgroundCallOf({ command: '   ' }), {});
});

test('a start result names the job, and says nothing else the card needs', () => {
	// The exact sentence: `Started background job 1 (bot build (next 16.4.0)). It keeps running…`
	const text = 'Started background job 1 (bot build (next 16.4.0)). It keeps running while you and the user carry on.';
	assert.strictEqual(backgroundJobNumberOf(text), '1');
	assert.strictEqual(backgroundJobNumberOf('Not run: this bash call would block the conversation'), undefined);
	assert.strictEqual(backgroundJobNumberOf(undefined), undefined);
});

test('the result text is read whichever shape it arrives in', () => {
	assert.strictEqual(backgroundResultOf('Started background job 2'), 'Started background job 2');
	assert.strictEqual(
		backgroundResultOf({ content: [{ type: 'text', text: 'Started background job 3' }, { type: 'image' }] }),
		'Started background job 3',
	);
	assert.strictEqual(backgroundResultOf({ content: [] }), undefined);
	assert.strictEqual(backgroundResultOf(undefined), undefined);
});

test('a completion message becomes the job\u2019s ending', () => {
	// A real one, from a finished job: the content, the details and the tail are as they arrived.
	const message = {
		role: 'custom',
		customType: 'specpi-background',
		display: true,
		content: [
			'Background job 1 (build experimental (carpeta del dueño)) finished with exit code 0 after 8m 22s.',
			'Command: cd /d/repositorios/PiCode && PICODE_PACK_SUFFIX=" - experimental" ./dev/build-run.sh',
			'It printed nothing.',
			'Last lines of output:',
			'```',
			'== done',
			'```',
		].join('\n'),
		details: { id: '1', state: 'exited', exitCode: 0, logPath: 'C:\\tmp\\job-1.log' },
	};

	const completion = backgroundCompletionOf(message);
	if (completion === undefined) {
		assert.fail('the completion message was not read as a job ending');
	}
	assert.strictEqual(completion.id, '1');
	assert.strictEqual(completion.label, 'build experimental (carpeta del dueño)');
	assert.strictEqual(completion.state, 'exited');
	assert.strictEqual(completion.exitCode, 0);
	assert.ok(completion.command?.includes('dev/build-run.sh'));
	assert.ok(completion.tail?.includes('== done'));
	assert.strictEqual(completion.summary, 'Background job 1 (build experimental (carpeta del dueño)) finished with exit code 0 after 8m 22s.');
});

test('anything that is not a completion message stays out of the chat\u2019s cards', () => {
	// The type is the marker. A message the owner typed, or an answer that merely mentions a job, must
	// never be drawn as one — that would be inventing work.
	assert.strictEqual(backgroundCompletionOf({ role: 'user', content: 'Background job 1 finished with exit code 0' }), undefined);
	assert.strictEqual(backgroundCompletionOf({ role: 'custom', customType: 'something-else', content: 'Background job 1 finished' }), undefined);
	assert.strictEqual(backgroundCompletionOf(undefined), undefined);
});

test('the card\u2019s sentences say the state it really has', () => {
	assert.strictEqual(runningResultLine(undefined), 'running');
	assert.strictEqual(runningResultLine('3'), 'running · job 3');

	const ok = { summary: '', state: 'exited', exitCode: 0 };
	assert.strictEqual(finishedResultLine(ok), 'exited · exit 0');
	assert.strictEqual(completionFailed(ok), false);
	assert.strictEqual(finishedResultLine({ summary: '', state: 'exited', exitCode: 2 }), 'exited · exit 2');
	assert.strictEqual(completionFailed({ summary: '', state: 'exited', exitCode: 2 }), true);
	// A job whose ending says nothing about its code is not called a failure.
	assert.strictEqual(finishedResultLine({ summary: '' }), 'finished');
	assert.strictEqual(completionFailed({ summary: '' }), false);
});
