/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reading the "What changed" summary out of a release page body, run on its own.
 *
 * What matters: only that section comes out (its heading and the sections after it stay
 * behind, the grouped ### headings stay in), and a body without it yields nothing so no
 * empty window opens.
 */

import assert from 'assert';
import { test } from 'node:test';
import { extractWhatChanged, shouldShowWhatsNew } from '../picodeWhatsNewData.js';

test('returns the grouped summary without its heading or the sections after it', () => {
	const body = ['Channel text', '', '## What changed', '', '### ✨ New', '', '- A thing', '', '## What\'s Changed', '', '* raw changelog'].join('\n');
	assert.strictEqual(extractWhatChanged(body), '### ✨ New\n\n- A thing');
});

test('takes the summary up to the end when nothing follows', () => {
	assert.strictEqual(extractWhatChanged('## What changed\n\n### 🐛 Fixed\n\n- Fix'), '### 🐛 Fixed\n\n- Fix');
});

test('yields nothing without the section or with an empty one', () => {
	assert.strictEqual(extractWhatChanged('Just a description'), undefined);
	assert.strictEqual(extractWhatChanged('## What changed\n\n## Files'), undefined);
});

test('shows after an update, and not again for the same version', () => {
	assert.strictEqual(shouldShowWhatsNew({ last: '0.7.2', current: '0.7.3', editorLast: '1.142.14', editorCurrent: '1.142.15' }), true);
	assert.strictEqual(shouldShowWhatsNew({ last: '0.7.3', current: '0.7.3', editorLast: '1.142.15', editorCurrent: '1.142.15' }), false);
});

test('shows on the update that brought the window in, which kept no version of its own', () => {
	assert.strictEqual(shouldShowWhatsNew({ last: '', current: '0.7.3', editorLast: '1.142.14', editorCurrent: '1.142.15' }), true);
});

test('stays quiet on a first install', () => {
	assert.strictEqual(shouldShowWhatsNew({ last: '', current: '0.7.3', editorLast: '', editorCurrent: '1.142.15' }), false);
	assert.strictEqual(shouldShowWhatsNew({ last: '', current: '0.7.3', editorLast: '1.142.15', editorCurrent: '1.142.15' }), false);
	assert.strictEqual(shouldShowWhatsNew({ last: '', current: '', editorLast: '1.142.14', editorCurrent: '1.142.15' }), false);
});
