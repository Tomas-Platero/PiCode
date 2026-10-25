/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The durable surfaces' shared signal: the transcript tab announces a run starting or ending, and
 * the Tasks block asks its source again.
 *
 * `durable-signal.ts` is pure (no `vscode`), so `node --test` runs it directly. What it must
 * guarantee is small and total: nobody listening is not an error, one broken listener cannot
 * silence the others, and unsubscribing really stops the calls.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notifyDurableChange, onDurableChange, resetDurableChangeListeners } from '../src/durable-signal.ts';

test('a listener hears the reason it was told about', () => {
	resetDurableChangeListeners();
	const heard: string[] = [];
	const off = onDurableChange(reason => heard.push(reason));
	notifyDurableChange('run-start');
	notifyDurableChange('run-end');
	off();
	assert.deepEqual(heard, ['run-start', 'run-end']);
});

test('announcing with nobody listening is not an error', () => {
	resetDurableChangeListeners();
	assert.doesNotThrow(() => notifyDurableChange('run-end'));
});

test('one listener that throws does not silence the others', () => {
	resetDurableChangeListeners();
	const heard: string[] = [];
	const offBad = onDurableChange(() => { throw new Error('this surface is broken'); });
	const offGood = onDurableChange(reason => heard.push(reason));
	assert.doesNotThrow(() => notifyDurableChange('run-end'));
	offBad();
	offGood();
	assert.deepEqual(heard, ['run-end']);
});

test('unsubscribing stops the calls', () => {
	resetDurableChangeListeners();
	let calls = 0;
	const off = onDurableChange(() => { calls++; });
	notifyDurableChange('run-start');
	off();
	notifyDurableChange('run-start');
	assert.equal(calls, 1);
});
