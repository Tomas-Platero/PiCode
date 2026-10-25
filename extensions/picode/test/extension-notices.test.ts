/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The notices the chat does not show, run on its own.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isExpectedHelperNotice } from '../src/extension-notices.ts';

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
