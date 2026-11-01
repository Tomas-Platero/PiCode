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
import { composeWhatsNew, extractWhatChanged, readHistory, shouldShowWhatsNew, whatsNewHistoryUrl, whatsNewSince } from '../picodeWhatsNewData.js';

test('returns the grouped summary without its heading or the sections after it', () => {
	const body = ['Channel text', '', '## What changed', '', '### ✨ New', '', '- A thing', '', '## What\'s Changed', '', '* raw changelog'].join('\n');
	assert.strictEqual(extractWhatChanged(body), '### ✨ New\n\n- A thing');
});

test('leaves out the rule that closes the section on the release page', () => {
	const body = ['## What changed', '', '- A thing', '', '---', '', '## What\'s Changed'].join('\r\n');
	assert.strictEqual(extractWhatChanged(body), '- A thing');
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

const entry = (version: string) => ({ version, notes: `- change in ${version}` });

test('after skipping versions, shows this one first and then each skipped one, newest first', () => {
	const history = [entry('0.7.3-experimental'), entry('0.7.4-experimental'), entry('0.7.2-experimental'), entry('0.6.0-experimental')];
	const shown = whatsNewSince('0.7.2-experimental', entry('0.8.0-experimental'), history);
	assert.deepStrictEqual(shown.map(e => e.version), ['0.8.0-experimental', '0.7.4-experimental', '0.7.3-experimental']);
});

test('orders versions by their numbers, so 0.7.10 comes after 0.7.9', () => {
	const shown = whatsNewSince('0.7.8', entry('0.7.11'), [entry('0.7.9'), entry('0.7.10')]);
	assert.deepStrictEqual(shown.map(e => e.version), ['0.7.11', '0.7.10', '0.7.9']);
});

test('shows this version alone when nothing was skipped or the version before is unknown', () => {
	const history = [entry('0.7.3'), entry('0.7.4')];
	assert.deepStrictEqual(whatsNewSince('0.7.4', entry('0.8.0'), history).map(e => e.version), ['0.8.0']);
	assert.deepStrictEqual(whatsNewSince('', entry('0.8.0'), history).map(e => e.version), ['0.8.0']);
});

test('caps the skipped versions and never repeats one', () => {
	const history = Array.from({ length: 20 }, (_, i) => entry(`0.1.${i + 1}`));
	assert.strictEqual(whatsNewSince('0.0.1', entry('0.2.0'), history, 5).length, 6);
	assert.deepStrictEqual(whatsNewSince('0.1.0', entry('0.2.0'), [entry('0.1.1'), entry('0.1.1')]).map(e => e.version), ['0.2.0', '0.1.1']);
});

test('one version reads as it is; several get a heading each', () => {
	assert.strictEqual(composeWhatsNew([entry('0.8.0')]), '- change in 0.8.0');
	assert.strictEqual(composeWhatsNew([entry('0.8.0'), entry('0.7.4')]), '## 0.8.0\n\n- change in 0.8.0\n\n## 0.7.4\n\n- change in 0.7.4');
	assert.strictEqual(composeWhatsNew([]), undefined);
});

test('ignores a history file that is not in the expected shape', () => {
	assert.deepStrictEqual(readHistory(undefined), []);
	assert.deepStrictEqual(readHistory({ versions: 'nope' }), []);
	assert.deepStrictEqual(readHistory({ versions: [{ version: '0.7.3', notes: '- a' }, { version: 'x', notes: '- b' }, { version: '0.7.4', notes: ' ' }, null] }), [{ version: '0.7.3', notes: '- a' }]);
});

test('reads each channel\'s history from the branch its update feed is served from', () => {
	assert.strictEqual(whatsNewHistoryUrl('experimental'), 'https://raw.githubusercontent.com/Tomas-Platero/PiCode/experimental/updates/experimental/whats-new.json');
	assert.strictEqual(whatsNewHistoryUrl('stable'), 'https://raw.githubusercontent.com/Tomas-Platero/PiCode/master/updates/stable/whats-new.json');
	assert.strictEqual(whatsNewHistoryUrl(undefined), undefined);
});
