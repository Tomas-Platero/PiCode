/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The notices the chat does not show, run on its own.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isExpectedHelperNotice, isStartupHousekeepingNotice } from '../src/extension-notices.ts';

test('the notice about the helper program that the product does not install is dropped', () => {
	const notice = 'Gentle AI: receipt-driven-development status is unavailable: native `gentle-ai review mode status` failed (package-local-binary-missing): package-local-binary-missing: Gentle AI v4.2.0 is not installed at D:\\x\\gentle-ai.exe. If GENTLE_PI_SKIP_GENTLE_AI_INSTALL is set, remove or unset it.';
	assert.equal(isExpectedHelperNotice(notice), true);
	assert.equal(isExpectedHelperNotice('Gentle AI v4.2.0 is not installed at C:\\somewhere'), true);
});

test('every other notice is shown', () => {
	assert.equal(isExpectedHelperNotice('Skill registry refreshed (41 skills)'), false);
	assert.equal(isExpectedHelperNotice('Gentle AI activity push failed: boom'), false);
	assert.equal(isExpectedHelperNotice(''), false);
});

test('gentle-pi\'s start-up housekeeping report is not shown', () => {
	assert.equal(isStartupHousekeepingNotice('el Gentleman applied saved model config to 6 agent(s). Global delegation/review assets ready: 10 new agent(s), 1 new chain(s), 2 new support file(s).'), true);
	assert.equal(isStartupHousekeepingNotice('Global delegation/review assets ready: 2 new agent(s)'), true);
	assert.equal(isStartupHousekeepingNotice('Applied saved model config to 1 agent(s).'), true);
});

test('a notice that asks for something is still shown', () => {
	assert.equal(isStartupHousekeepingNotice('Gentle AI activity push failed: boom'), false);
	assert.equal(isStartupHousekeepingNotice('Skill registry refreshed (41 skills)'), false);
	assert.equal(isStartupHousekeepingNotice(''), false);
});

test('the note that a chat started with its profile and nothing changed is dropped', () => {
	assert.equal(isStartupHousekeepingNotice('el Gentleman started with profile "current".\nprofile "current" has no orchestrator model; this session keeps its current model.'), true);
	assert.equal(isStartupHousekeepingNotice('el Gentleman started with profile "work".'), true);
});

test('the note that a profile moved the chat to another model, or could not, is still shown', () => {
	assert.equal(isStartupHousekeepingNotice('el Gentleman started with profile "work".\nThis session now runs on openai/gpt-5 · high.'), false);
	assert.equal(isStartupHousekeepingNotice('el Gentleman started with profile "work".\nopenai/gpt-5 is not in the model catalog; this session keeps its current model.'), false);
	assert.equal(isStartupHousekeepingNotice('el Gentleman started with profile "work".\nno authentication is configured for openai; this session keeps its current model.'), false);
});
