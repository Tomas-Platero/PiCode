/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The one-time "anonymous usage counts" notice: only for someone who never chose. */

import assert from 'assert';
import { test } from 'node:test';
import { shouldShowUsageNotice } from '../picodeUsageSharingData.js';

test('an install that never chose sees the notice once', () => {
	assert.strictEqual(shouldShowUsageNotice(undefined, false), true);
	assert.strictEqual(shouldShowUsageNotice(undefined, true), false);
});

test('a choice made in the setup or in Settings is never asked again', () => {
	assert.strictEqual(shouldShowUsageNotice(true, false), false);
	assert.strictEqual(shouldShowUsageNotice(false, false), false);
});
