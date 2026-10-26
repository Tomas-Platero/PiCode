/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The page that tells what one of Gentle's agents did, built from a record and nothing else.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { elapsed, escapeHtml, isRunning, isTaskId, statusWord, transcriptHtml, transcriptOf, transcriptOfJson } from '../src/agent-transcript.ts';

const record = {
	task: { id: 'a-1', agent: 'gentle-ai-explore', label: 'map routes', status: 'completed', model: 'omni/x/y', thinking: 'medium', prompt: 'Map the routes.\nBe brief.', startedAt: 1_000, endedAt: 36_000, result: 'There are 3 routes.' },
	thread: { items: [
		{ kind: 'note', text: 'tools missing' },
		{ kind: 'text', text: 'Starting with a listing.' },
		{ kind: 'thinking', text: 'Which folder?' },
		{ kind: 'tool', name: 'find', args: { pattern: '**/route.ts' }, output: 'a/route.ts\nb/route.ts', isError: false },
		{ kind: 'tool', name: 'read', args: '{"path":"x"}', output: 'denied', isError: true },
		{ kind: 'tool', name: 'grep', args: {}, output: '', running: true },
	] },
};

const plain = async (markdown: string): Promise<string> => `<p>${escapeHtml(markdown)}</p>`;

test('a task id is a plain file name, never a path', () => {
	assert.equal(isTaskId('mvo5y2tl-1-sp2b'), true);
	for (const bad of ['', '../x', 'a/b', 'a\b', 'a.b', 7, undefined]) {
		assert.equal(isTaskId(bad), false, String(bad));
	}
});

test('a record reads into who, how it ended, the task, the steps in order and the answer', () => {
	const model = transcriptOf(record)!;
	assert.deepEqual([model.agent, model.label, model.status, model.model, model.thinking, model.prompt.split('\n')[0], model.result], ['gentle-ai-explore', 'map routes', 'completed', 'omni/x/y', 'medium', 'Map the routes.', 'There are 3 routes.']);
	assert.deepEqual(model.steps.map(step => step.kind), ['note', 'text', 'thinking', 'tool', 'tool', 'tool']);
	const tools = model.steps.filter(step => step.kind === 'tool');
	assert.equal(tools[0]!.kind === 'tool' && tools[0]!.args, '{"pattern":"**/route.ts"}');
	assert.equal(tools[1]!.kind === 'tool' && tools[1]!.args, '{"path":"x"}', 'a string argument is shown as it is');
});

test('something that is not a record gives no page', () => {
	assert.equal(transcriptOfJson('{ nope'), undefined);
	assert.equal(transcriptOfJson('[]'), undefined);
	assert.equal(transcriptOfJson('{"other":1}'), undefined);
	assert.equal(transcriptOf(undefined), undefined);
});

test('the clock says seconds, then minutes, and runs on while the task has no end', () => {
	assert.equal(elapsed(1_000, 36_000, 0), '35s');
	assert.equal(elapsed(0, 125_000, 0), '2m 5s');
	assert.equal(elapsed(1_000, undefined, 11_000), '10s');
	assert.equal(elapsed(undefined, undefined, 5), undefined);
	assert.equal(isRunning('running'), true);
	assert.equal(isRunning('completed'), false);
	assert.equal(statusWord('timed_out'), 'Timed out');
});

test('the page shows each part in order, with the steps as a timeline', async () => {
	const html = await transcriptHtml(transcriptOf(record)!, plain, 0);
	let at = -1;
	for (const part of ['gentle-ai-explore', 'Done', 'omni/x/y · medium', '35s', 'Task', 'Map the routes.', 'What it did', 'Starting with a listing.', 'Thinking', 'class="tool done"', 'find', 'class="tool error"', 'class="tool running"', 'Answer', 'There are 3 routes.']) {
		const next = html.indexOf(part, at + 1);
		assert.ok(next > at, `${part} comes after the one before it`);
		at = next;
	}
	assert.doesNotMatch(html, /Updating as it works/);
});

test('text from an agent can never become markup of the page', async () => {
	const hostile = { task: { agent: '<b>a</b>', label: '<img src=x>', status: 'failed', error: '<script>1</script>' }, thread: { items: [{ kind: 'tool', name: '<i>', args: '<u>', output: '<script>2</script>' }, { kind: 'note', text: '<em>n</em>' }] } };
	const html = await transcriptHtml(transcriptOf(hostile)!, plain, 0);
	assert.doesNotMatch(html, /<script|<img|<u>|<i>|<b>|<em>/);
});

test('a task still running says so, keeps its clock going and says when steps were left out', async () => {
	const live = { task: { agent: 'a', status: 'running', startedAt: 5_000 }, thread: { dropped: 3, items: [] } };
	const html = await transcriptHtml(transcriptOf(live)!, plain, 9_000);
	assert.match(html, /Working/);
	assert.match(html, /data-clock data-start="5000">4s</);
	assert.match(html, /The first 3 steps are not shown/);
	assert.match(html, /Updating as it works/);
	const finished = await transcriptHtml(transcriptOf({ task: { agent: 'a', status: 'completed', startedAt: 5_000, endedAt: 7_000 } })!, plain, 9_000);
	assert.doesNotMatch(finished, /data-start/);
	assert.match(finished, /Nothing was recorded/);
});

test('a failed agent shows its problem, and a renderer that breaks leaves the text readable', async () => {
	const html = await transcriptHtml(transcriptOf({ task: { agent: 'a', status: 'failed', error: 'it broke', prompt: 'do <it>' } })!, async () => { throw new Error('no renderer'); }, 0);
	assert.match(html, /class="problem"[\s\S]*it broke/);
	assert.match(html, /<pre>do &lt;it&gt;<\/pre>/);
});
