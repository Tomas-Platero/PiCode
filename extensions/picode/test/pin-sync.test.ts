/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * One pi, named once.
 *
 * `node --test` runs this file directly (Node's own type stripping). The rule being pinned
 * here: the version the build installs (`distribution/runtime.json`, the pin `dev/pi-runtime.sh`
 * reads) and the version the source declares as its own dependency (`picode-source/package.json`,
 * what the SDK's types are checked against) are the **same pi**. Two numbers that can drift apart
 * is the state this whole unification closed: a compile against one version and a runtime on
 * another. Exact — no ranges: the pin's whole point is that a build six months from now is the
 * pi that was measured.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const readJson = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8'));

test('the pin and the source dependency name the same exact pi', () => {
	const pin = readJson(path.join(REPO, 'distribution', 'runtime.json'));
	const source = readJson(path.join(REPO, 'picode-source', 'package.json'));
	const declared = (source['devDependencies'] as Record<string, string> | undefined)?.['@earendil-works/pi-coding-agent'];

	assert.equal(typeof pin['version'], 'string', 'the pin must carry a version');
	assert.match(pin['version'] as string, /^\d+\.\d+\.\d+$/, 'the pin is exact, never a range');
	assert.equal(declared, pin['version'], 'the source dependency must be the pinned pi, exactly');
});
