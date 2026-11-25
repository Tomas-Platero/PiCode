/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { hasUnmanagedGentleRuntime, isolateGentleReviewSource, prepareGentleReview } from '../src/gentle-review-runtime.ts';

test('unrecognized review source is never adapted', () => {
	assert.equal(isolateGentleReviewSource('unrecognized source'), undefined);
});

test('a package-local runtime is considered unmanaged', () => {
	const root = mkdtempSync(path.join(os.tmpdir(), 'picode-review-test-'));
	const prior = process.env.GENTLE_PI_GENTLE_AI_DEV_BINARY;
	try {
		delete process.env.GENTLE_PI_GENTLE_AI_DEV_BINARY;
		assert.equal(hasUnmanagedGentleRuntime(root), false);
		mkdirSync(path.join(root, 'npm', 'node_modules', 'gentle-pi', '.gentle-ai'), { recursive: true });
		assert.equal(hasUnmanagedGentleRuntime(root), true);
	} finally {
		if (prior === undefined) { delete process.env.GENTLE_PI_GENTLE_AI_DEV_BINARY; } else { process.env.GENTLE_PI_GENTLE_AI_DEV_BINARY = prior; }
		rmSync(root, { recursive: true, force: true });
	}
});

test('review preparation refuses absent or incompatible runtime pins', () => {
	const root = mkdtempSync(path.join(os.tmpdir(), 'picode-review-test-'));
	try {
		const runtime = path.join(root, 'pi-runtime');
		const profile = path.join(root, 'profile');
		assert.equal(prepareGentleReview(runtime, profile), false);
		mkdirSync(path.join(root, 'gentle-ai'));
		writeFileSync(path.join(root, 'gentle-ai', 'pin.json'), JSON.stringify({ gentlePiVersion: '99.0.0', gentleAiVersion: '5.0.0' }));
		assert.equal(prepareGentleReview(runtime, profile), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
