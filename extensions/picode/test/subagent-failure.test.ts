/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A subagent's provider refusal read back and put in words, and the retry on the chat's model.
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { canTryAnotherModel, describeFailure, explainTaskFailure, failureKind, lastProviderFailure } from '../src/subagent-failure.ts';
import type { FallbackPi } from '../src/subagent-model-fallback.ts';

// The fallback imports its sibling without an extension, as the compiled code does.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
			return nextResolve(`${specifier}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});

const { default: subagentModelFallback, CHAT_MODEL_ENV, parseModelRef, refusalOf } = await import('../src/subagent-model-fallback.ts');

// The answer NaN gave when its monthly allowance ran out (2026-10-29).
const NAN_CAP = '402: {"message":"deepseek-v4-flash allowance exhausted: 3,000,084,989 of 3,000,000,000 tokens used in the current period, 0 left. The counter resets when your allowance period rolls over, on 2026-11-01 00:00 UTC, in 2d13h.","type":"monthly_cap_reached","param":"","code":"402"}';

function refusal(errorMessage: string, provider = 'nan', model = 'deepseek-v4-flash') {
	return { role: 'assistant', content: [], provider, model, stopReason: 'error', errorMessage };
}

test('provider refusals are sorted by what a person can do about them', () => {
	assert.equal(failureKind(NAN_CAP), 'allowance');
	assert.equal(failureKind('401: {"error":{"message":"Incorrect API key provided"}}'), 'access');
	assert.equal(failureKind('429 Too Many Requests'), 'rate');
	assert.equal(failureKind('Model gpt-9 not found'), 'model');
	assert.equal(failureKind('500 internal server error'), 'other');
	assert.equal(canTryAnotherModel(NAN_CAP), true);
	assert.equal(canTryAnotherModel('500 internal server error'), false);
});

test('the Problem row names the provider, the cause and when it comes back', () => {
	assert.equal(describeFailure({ provider: 'nan', model: 'deepseek-v4-flash', message: NAN_CAP }), 'NaN allowance used up · resets Nov 1');
	assert.equal(describeFailure({ provider: 'openai', model: 'gpt-5', message: '401 unauthorized' }), 'OpenAI refused the key or sign-in');
	assert.equal(describeFailure({ provider: 'acme', model: 'm', message: '500: {"message":"upstream exploded"}' }), 'acme: upstream exploded');
});

test('the last assistant answer of a session decides; a later good answer clears an earlier refusal', () => {
	const failed = [JSON.stringify({ type: 'message', message: { role: 'user', content: 'go' } }), JSON.stringify({ type: 'message', message: refusal(NAN_CAP) })].join('\n');
	assert.equal(lastProviderFailure(failed)?.provider, 'nan');
	const recovered = `${failed}\n${JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [] } })}`;
	assert.equal(lastProviderFailure(recovered), undefined);
});

test('a failed task is explained from its record and the session it points at', () => {
	const profile = path.join('profile');
	const session = path.join('sessions', 'one.jsonl');
	const files: Record<string, string> = {
		[path.join(profile, 'gentle-agents', 'tasks', 'abc.json')]: JSON.stringify({ task: { sessionPath: session } }),
		[session]: JSON.stringify({ type: 'message', message: refusal(NAN_CAP) }),
	};
	const read = (file: string) => {
		const text = files[file];
		if (text === undefined) {
			throw new Error('missing');
		}
		return text;
	};
	assert.equal(explainTaskFailure(profile, 'abc', read), 'NaN allowance used up · resets Nov 1');
	assert.equal(explainTaskFailure(profile, 'gone', read), undefined);
});

test('model references split at the first slash', () => {
	assert.deepEqual(parseModelRef('omni/deepseek/deepseek-v4-flash'), { provider: 'omni', id: 'deepseek/deepseek-v4-flash' });
	assert.equal(parseModelRef('nomodel'), undefined);
	assert.equal(parseModelRef(undefined), undefined);
	assert.equal(refusalOf([refusal(NAN_CAP), { role: 'assistant', stopReason: 'stop' }]), undefined);
});

type Handler = Parameters<FallbackPi['on']>[1];

function fakePi() {
	const handlers: Handler[] = [];
	const chosen: Array<{ provider: string; id: string }> = [];
	const pi: FallbackPi = {
		on: (_event, handler) => { handlers.push(handler); },
		setModel: async model => { chosen.push(model); return true; },
	};
	const registry = { find: (provider: string, id: string) => ({ provider, id }) };
	const settle = (messages: unknown[], outcome = 'error') => handlers[0]!({ outcome, context: { contextMessages: messages } }, { modelRegistry: registry });
	return { pi, handlers, chosen, settle };
}

const CHILD_ENV = { GENTLE_PI_AGENTS_CHILD: '1', [CHAT_MODEL_ENV]: 'omni/deepseek/deepseek-v4-flash' };

test('a refused subagent switches to the chat model once and carries on', async () => {
	const { pi, chosen, settle } = fakePi();
	subagentModelFallback(pi, CHILD_ENV);
	const result = await settle([refusal(NAN_CAP)]) as { continue?: boolean; entries?: unknown[] };
	assert.deepEqual(chosen, [{ provider: 'omni', id: 'deepseek/deepseek-v4-flash' }]);
	assert.equal(result.continue, true);
	assert.equal(result.entries?.length, 1);
	// A second refusal, on the chat model too, is left to fail.
	assert.equal(await settle([refusal(NAN_CAP, 'omni', 'deepseek/deepseek-v4-flash')]), undefined);
	assert.equal(chosen.length, 1);
});

test('nothing switches outside a subagent, on errors about the work, or onto the same model', async () => {
	const outside = fakePi();
	subagentModelFallback(outside.pi, { [CHAT_MODEL_ENV]: 'omni/x' });
	assert.equal(outside.handlers.length, 0);

	const work = fakePi();
	subagentModelFallback(work.pi, CHILD_ENV);
	assert.equal(await work.settle([refusal('500 internal server error')]), undefined);
	assert.equal(await work.settle([refusal(NAN_CAP)], 'completed'), undefined);

	const same = fakePi();
	subagentModelFallback(same.pi, { GENTLE_PI_AGENTS_CHILD: '1', [CHAT_MODEL_ENV]: 'nan/deepseek-v4-flash' });
	assert.equal(await same.settle([refusal(NAN_CAP)]), undefined);

	const noChat = fakePi();
	subagentModelFallback(noChat.pi, { GENTLE_PI_AGENTS_CHILD: '1' });
	assert.equal(await noChat.settle([refusal(NAN_CAP)]), undefined);
	assert.equal(work.chosen.length + same.chosen.length + noChat.chosen.length, 0);
});
