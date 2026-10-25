/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ONBOARDING_VERSION, majorVersion, onboardingReason, readOnboardingFlag, writeOnboardingFlag } from '../picodeOnboardingFlag.js';

/**
 * The start-up contract, as tests: a first run asks, every later run does not, an upgrade asks
 * once more, and the answer survives being read by a process that has never seen the writer.
 */
suite('PiCode onboarding flag', () => {

	let dataDir: string;

	setup(() => {
		dataDir = mkdtempSync(join(tmpdir(), 'picode-onboarding-'));
	});

	teardown(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	test('a missing flag is a first run', () => {
		assert.strictEqual(readOnboardingFlag(dataDir), undefined);
		assert.strictEqual(onboardingReason(undefined, '1.142.1'), 'first-run');
	});

	test('a recorded flag stops the setup, on the same major version', () => {
		writeOnboardingFlag(dataDir, '1.142.1');
		const flag = readOnboardingFlag(dataDir);
		assert.deepStrictEqual(flag, { completed: true, onboardingVersion: ONBOARDING_VERSION, productVersion: '1.142.1' });
		assert.strictEqual(onboardingReason(flag, '1.142.9'), undefined);
	});

	test('a major version change runs the setup again, in update mode', () => {
		writeOnboardingFlag(dataDir, '1.142.1');
		assert.strictEqual(onboardingReason(readOnboardingFlag(dataDir), '2.0.0'), 'update');
	});

	test('a change in the setup itself runs it again, in update mode', () => {
		writeFileSync(join(dataDir, 'onboarding.json'), JSON.stringify({ completed: true, onboardingVersion: ONBOARDING_VERSION - 1, productVersion: '1.142.1' }));
		assert.strictEqual(onboardingReason(readOnboardingFlag(dataDir), '1.142.1'), 'update');
	});

	test('a flag that is not completed is still a first run', () => {
		writeFileSync(join(dataDir, 'onboarding.json'), JSON.stringify({ completed: false }));
		assert.strictEqual(onboardingReason(readOnboardingFlag(dataDir), '1.142.1'), 'first-run');
	});

	test('an unreadable flag opens the setup instead of crashing the start', () => {
		writeFileSync(join(dataDir, 'onboarding.json'), '{ this is not json');
		assert.strictEqual(readOnboardingFlag(dataDir), undefined);
		assert.strictEqual(onboardingReason(readOnboardingFlag(dataDir), '1.142.1'), 'first-run');
	});

	test('the flag is written where the next start reads it, with a newline', () => {
		writeOnboardingFlag(dataDir, '1.142.1');
		const text = readFileSync(join(dataDir, 'onboarding.json'), 'utf8');
		assert.ok(text.endsWith('\n'));
		assert.strictEqual(JSON.parse(text).completed, true);
	});

	test('a version with no major part answers an empty major version', () => {
		assert.strictEqual(majorVersion(undefined), '');
		assert.strictEqual(majorVersion(''), '');
		assert.strictEqual(majorVersion('1'), '1');
		assert.strictEqual(majorVersion('1.142.1-insider'), '1');
	});
});
