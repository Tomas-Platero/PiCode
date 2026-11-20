/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * "Help Improve PiCode" also covers pi's own install and update report (ADR-045): with the switch
 * off pi is told not to send it; with it on, pi's own setting decides again.
 */

import assert from 'node:assert';
import { test } from 'node:test';
import { applyUsageSharing } from '../src/product-env.ts';

test('with sharing off, pi is told not to send its install report', () => {
	const env: NodeJS.ProcessEnv = {};
	applyUsageSharing(false, env);
	assert.strictEqual(env['PI_TELEMETRY'], '0');
});

test('turning sharing back on hands the decision back to pi', () => {
	const env: NodeJS.ProcessEnv = { PI_TELEMETRY: '0' };
	applyUsageSharing(true, env);
	assert.strictEqual('PI_TELEMETRY' in env, false);
});
