/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The agents' model assignments, run on their own against a throwaway profile folder.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ALL_AGENTS, agentModelsState, assign, describeAgentModel, isAgentModelsCommand, listAgents, supportedLevels, modelRefOf, modelsFile, readAgentModels, setAgentModel, writeAgentModels } from '../src/gentle-models.ts';

function profile(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'picode-models-'));
}

test('only provider/model references without spaces are models', () => {
	assert.equal(modelRefOf('omni/deepseek/deepseek-v4-flash'), 'omni/deepseek/deepseek-v4-flash');
	assert.equal(modelRefOf('  anthropic/claude-sonnet-4  '), 'anthropic/claude-sonnet-4');
	assert.equal(modelRefOf('deepseek'), undefined);
	assert.equal(modelRefOf('a/b c'), undefined);
	assert.equal(modelRefOf(7), undefined);
});

test('the agents are the profile\'s agent files, without the review agents, in order', () => {
	const dir = profile();
	fs.mkdirSync(path.join(dir, 'agents'));
	for (const name of ['gentle-ai-worker.md', 'gentle-ai-explore.md', 'review-risk.md', 'notes.txt']) {
		fs.writeFileSync(path.join(dir, 'agents', name), '');
	}
	assert.deepEqual(listAgents(dir), ['gentle-ai-explore', 'gentle-ai-worker']);
	assert.deepEqual(listAgents(path.join(dir, 'nowhere')), []);
});

test('a profile with no file has nothing assigned, and a file that is not an object is invalid', () => {
	const dir = profile();
	assert.deepEqual(readAgentModels(dir), { status: 'ok', models: {} });
	fs.mkdirSync(path.dirname(modelsFile(dir)), { recursive: true });
	fs.writeFileSync(modelsFile(dir), '[1]');
	assert.equal(readAgentModels(dir).status, 'invalid');
	fs.writeFileSync(modelsFile(dir), '{ nope');
	assert.equal(readAgentModels(dir).status, 'invalid');
});

test('what is written reads back the same, and a stray temporary file is not left', () => {
	const dir = profile();
	writeAgentModels(dir, { 'gentle-ai-explore': { model: 'omni/a/b', thinking: 'high' }, 'gentle-ai-worker': {} });
	assert.deepEqual(readAgentModels(dir), { status: 'ok', models: { 'gentle-ai-explore': { model: 'omni/a/b', thinking: 'high' }, 'gentle-ai-worker': {} } });
	assert.deepEqual(fs.readdirSync(path.dirname(modelsFile(dir))), ['models.json']);
});

test('the file reads Gentle\'s other spellings and drops what Gentle would', () => {
	const dir = profile();
	fs.mkdirSync(path.dirname(modelsFile(dir)), { recursive: true });
	fs.writeFileSync(modelsFile(dir), JSON.stringify({ a: 'omni/x/y', b: { model: 'omni/x/z', effort: 'low' }, c: { model: 'no spaces allowed' }, d: 4 }));
	assert.deepEqual(readAgentModels(dir), { status: 'ok', models: { a: { model: 'omni/x/y' }, b: { model: 'omni/x/z', thinking: 'low' }, c: {} } });
});

test('one agent changes alone; all changes every agent and keeps the others as they were', () => {
	const current = { a: { model: 'omni/old/m' }, other: { model: 'omni/keep/m' } };
	const one = assign(current, ['a', 'b'], 'b', { model: 'omni/new/m', thinking: 'low' });
	assert.deepEqual(one, { a: { model: 'omni/old/m' }, other: { model: 'omni/keep/m' }, b: { model: 'omni/new/m', thinking: 'low' } });
	assert.deepEqual(current.a, { model: 'omni/old/m' }, 'the original is not touched');
	const all = assign(current, ['a', 'b'], ALL_AGENTS, { model: 'omni/new/m' });
	assert.deepEqual(all, { a: { model: 'omni/new/m' }, b: { model: 'omni/new/m' }, other: { model: 'omni/keep/m' } });
});

test('putting an agent back is an empty entry, so Gentle clears what it wrote before', () => {
	assert.deepEqual(assign({ a: { model: 'omni/x/y', thinking: 'high' } }, ['a'], 'a', {}), { a: {} });
	assert.equal(describeAgentModel({}), 'Same model as the rest');
	assert.equal(describeAgentModel(undefined), 'Same model as the rest');
	assert.equal(describeAgentModel({ model: 'omni/x/y' }), 'omni/x/y');
	assert.equal(describeAgentModel({ model: 'omni/x/y', thinking: 'high' }), 'omni/x/y · high');
});

test('only the bare command opens the pickers', () => {
	assert.equal(isAgentModelsCommand('/gentle:models'), true);
	assert.equal(isAgentModelsCommand('  /gentle:models  '), true);
	assert.equal(isAgentModelsCommand('/gentle:models now'), false);
	assert.equal(isAgentModelsCommand('/gentle:profiles'), true);
	assert.equal(isAgentModelsCommand('/gentle:profiles export x'), false);
	assert.equal(isAgentModelsCommand('/gentle:status'), false);
});

test('the settings page reads the agents and what each is set to', () => {
	const dir = profile();
	fs.mkdirSync(path.join(dir, 'agents'));
	fs.writeFileSync(path.join(dir, 'agents', 'gentle-ai-explore.md'), '');
	fs.writeFileSync(path.join(dir, 'agents', 'gentle-ai-worker.md'), '');
	assert.deepEqual(agentModelsState(dir), { agents: ['gentle-ai-explore', 'gentle-ai-worker'], models: {}, invalid: false });
	setAgentModel(dir, { agent: 'gentle-ai-explore', model: 'omni/a/b', thinking: 'high' });
	assert.deepEqual(agentModelsState(dir).models, { 'gentle-ai-explore': { model: 'omni/a/b', thinking: 'high' } });
	fs.writeFileSync(modelsFile(dir), '{ nope');
	assert.equal(agentModelsState(dir).invalid, true);
});

test('a change from the page sets one agent, or all; only the effort is allowed alone; empty puts it back', () => {
	const dir = profile();
	fs.mkdirSync(path.join(dir, 'agents'));
	for (const name of ['a.md', 'b.md']) {
		fs.writeFileSync(path.join(dir, 'agents', name), '');
	}
	setAgentModel(dir, { agent: ALL_AGENTS, model: 'omni/x/y' });
	assert.deepEqual(agentModelsState(dir).models, { a: { model: 'omni/x/y' }, b: { model: 'omni/x/y' } });
	setAgentModel(dir, { agent: 'a', model: '', thinking: 'low' });
	assert.deepEqual(agentModelsState(dir).models['a'], { thinking: 'low' });
	setAgentModel(dir, { agent: 'a', model: '', thinking: '' });
	assert.deepEqual(agentModelsState(dir).models['a'], {});
});

test('a hand-made request that Gentle would reject is refused and writes nothing', () => {
	const dir = profile();
	fs.mkdirSync(path.join(dir, 'agents'));
	fs.writeFileSync(path.join(dir, 'agents', 'a.md'), '');
	for (const bad of [undefined, 'a', { agent: 'nobody' }, { agent: 'a', model: 'no spaces/here x' }, { agent: 'a', model: 'bare' }, { agent: 'a', thinking: 'extreme' }, { agent: '../a' }]) {
		assert.throws(() => setAgentModel(dir, bad), () => true, JSON.stringify(bad));
	}
	assert.equal(fs.existsSync(modelsFile(dir)), false);
});

test('a model offers only the effort levels it supports, and an undescribed one keeps them all', () => {
	assert.deepEqual(supportedLevels({ reasoning: false }), ['off']);
	assert.deepEqual(supportedLevels({ reasoning: true }), ['off', 'minimal', 'low', 'medium', 'high']);
	assert.deepEqual(supportedLevels({ reasoning: true, thinkingLevelMap: { minimal: null, xhigh: 'xhigh' } }), ['off', 'low', 'medium', 'high', 'xhigh']);
	assert.equal(supportedLevels({}), undefined);
});
