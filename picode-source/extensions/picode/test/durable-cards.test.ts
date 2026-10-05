/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The durable delegation card, as the chat's turn builds it.
 *
 * `durable-cards.ts` is pure (no `vscode`), so `node --test` runs it directly: the shapes
 * below are the ones pi's tool events and the bridge's tool results actually carry.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { durableCard, durableDetailsOf, durablePromptOf, durableResultOf, isDurableDelegationTool } from '../src/durable-cards.ts';

/** The result a successful durable_send returns, as the bridge extension shapes it. */
const sendResult = (conversationId: number, status: string, answer: string) => ({
	content: [{ type: 'text', text: `durable conversation ${conversationId} answered:\n${answer}` }],
	details: { conversationId, status, answer },
});

test('only the delegation tool becomes a card', () => {
	assert.equal(isDurableDelegationTool('durable_send'), true);
	assert.equal(isDurableDelegationTool('durable_list'), false);
	assert.equal(isDurableDelegationTool('durable_read'), false);
	assert.equal(isDurableDelegationTool('read'), false);
	assert.equal(isDurableDelegationTool(undefined), false);
	assert.equal(durableCard('durable_list', {}, undefined, false), undefined);
});

test('a start card names the daemon and the prompt, and lies about nothing else', () => {
	const card = durableCard('durable_send', { prompt: 'Fix the flaky test in src/app.ts' }, undefined, false);
	assert.deepEqual(card, {
		agentName: 'durable agent',
		description: 'Runs in the durable daemon — the work survives even if this session is closed.',
		prompt: 'Fix the flaky test in src/app.ts',
	});
});

test('an end card carries durable identity: which conversation the work became, and how it ended', () => {
	const card = durableCard('durable_send', { prompt: 'do the thing' }, sendResult(42, 'done', 'ALL-QUIET'), false);
	assert.equal(card?.agentName, 'durable conversation 42');
	assert.equal(card?.description, 'Run done in the durable daemon.');
	assert.equal(card?.prompt, 'do the thing');
	assert.equal(card?.result, 'durable conversation 42 answered:\nALL-QUIET');
	assert.equal(card?.complete, true);
	assert.equal(card?.isError, undefined);
});

test('a failed call says so instead of pretending the run happened', () => {
	const card = durableCard('durable_send', { prompt: 'do the thing' }, {
		content: [{ type: 'text', text: 'the durable daemon is not running (endpoint \\\\.\\pipe\\picode-durable-agent)' }],
	}, true);
	assert.equal(card?.isError, true);
	assert.equal(card?.complete, true);
	assert.equal(card?.agentName, 'durable agent');
	assert.equal(card?.description, 'The durable daemon could not run it.');
	assert.match(card?.result ?? '', /not running/);
});

test('a result without the bridge details keeps the card, without an invented conversation', () => {
	const card = durableCard('durable_send', { prompt: 'do the thing' }, { content: [{ type: 'text', text: 'odd shape' }] }, false);
	assert.equal(card?.agentName, 'durable agent');
	assert.equal(card?.result, 'odd shape');
	assert.equal(card?.complete, true);
});

test('prompts and results are capped: a card is a pointer, not a transcript', () => {
	const longPrompt = 'x'.repeat(500);
	assert.equal(durablePromptOf({ prompt: longPrompt })?.length, 200);
	assert.equal(durablePromptOf({ prompt: 'x'.repeat(199) })?.length, 199);
	assert.equal(durablePromptOf({ prompt: 'x'.repeat(200) })?.length, 200);
	assert.equal(durableResultOf({ content: [{ type: 'text', text: 'y'.repeat(3000) }] })?.length, 2000);
});

test('arguments without a prompt string fall back to the arguments as JSON; none at all give no prompt', () => {
	assert.equal(durablePromptOf({ task: 'the other shape' }), '{"task":"the other shape"}');
	assert.equal(durablePromptOf('bare'), '"bare"');
	assert.equal(durablePromptOf(undefined), undefined);
});

test('details are read tolerantly: numbers that are not ids and statuses that are not text are left out', () => {
	assert.deepEqual(durableDetailsOf({ details: { conversationId: 7, status: 'done' } }), { conversationId: 7, status: 'done' });
	assert.deepEqual(durableDetailsOf({ details: { conversationId: 'seven' } }), {});
	assert.deepEqual(durableDetailsOf({ details: 'junk' }), undefined);
	assert.deepEqual(durableDetailsOf(undefined), undefined);
});
