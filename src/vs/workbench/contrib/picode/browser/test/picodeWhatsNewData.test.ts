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
import { extractWhatChanged } from '../picodeWhatsNewData.js';

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
