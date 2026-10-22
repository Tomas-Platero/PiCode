/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * One pi, named once.
 *
 * `node --test` runs this file directly (Node's own type stripping). The rule being pinned
 * here: the version the build installs (`build/distribution/runtime.json`, the pin
 * `build/pi-runtime.sh`
 * reads) and the version the source declares as its own dependency (`package.json`,
 * what the SDK's types are checked against) are the **same pi**. Two numbers that can drift apart
 * is the state this whole unification closed: a compile against one version and a runtime on
 * another. Exact — no ranges: the pin's whole point is that a build six months from now is the
 * pi that was measured.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const readJson = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8'));

test('the pin and the source dependency name the same exact pi', () => {
	const pin = readJson(path.join(REPO, 'build', 'distribution', 'runtime.json'));
	const source = readJson(path.join(REPO, 'package.json'));
	const declared = (source['devDependencies'] as Record<string, string> | undefined)?.['@earendil-works/pi-coding-agent'];

	assert.equal(typeof pin['version'], 'string', 'the pin must carry a version');
	assert.match(pin['version'] as string, /^\d+\.\d+\.\d+$/, 'the pin is exact, never a range');
	assert.equal(declared, pin['version'], 'the source dependency must be the pinned pi, exactly');
});

/**
 * The durable agent is the same product and must not run a second pi behind the editor's back.
 *
 * It is a separate program with its own manifest — `host/durable/package.json`, installed into
 * `resources/durable` — so nothing but this test stops its `@earendil-works/*` packages (the
 * harness, the model layer, the MCP client, chord) from sitting on an older release than the one
 * the editor runs. Ranges are refused for the same reason they are refused above: `^1.3.0` reads
 * as "some 1.x" and resolves to a different pi the next time somebody installs.
 */
test('the durable agent runs the same exact pi release as the editor', () => {
	const pin = readJson(path.join(REPO, 'build', 'distribution', 'runtime.json'));
	const durable = readJson(path.join(REPO, 'host', 'durable', 'package.json'));
	const dependencies = (durable['dependencies'] ?? {}) as Record<string, string>;
	const piPackages = Object.keys(dependencies).filter(name => name.startsWith('@earendil-works/'));

	assert.deepEqual(piPackages.sort(), [
		'@earendil-works/chord',
		'@earendil-works/pi-ai',
		'@earendil-works/pi-durable',
		'@earendil-works/pi-mcp',
	], 'the durable agent declares a different set of pi packages than this test knows about');
	for (const name of piPackages) {
		assert.equal(dependencies[name], pin['version'], `${name} must be the pinned pi release, exactly`);
	}
});
