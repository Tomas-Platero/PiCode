/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Finding the external pi behind the `pi` on the PATH, in the two layouts that put it there.
 *
 * `node --test` runs this file directly (Node's own type stripping), which is why
 * `piLocate.ts` carries no `vscode` import. The rule being pinned here: **one function
 * answers "is there an external pi" for everyone** — the onboarding card's availability,
 * its probe's meta line, and the external runtime's SDK entry. Only the npm layout was ever
 * looked for, so on a machine with pi's managed install the card stayed greyed and
 * unclickable while the line beside it already said "found on your computer — ready to use",
 * and the external host could not load at all.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { sdkEntryOfShim } from '../src/piLocate.ts';

/** The package's entry, spelled the way every install spells it. */
const entryUnder = (...root: string[]): string => path.join(...root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js');

/** A fixture root of its own, so one test's layout can never satisfy another's. */
const fixture = (): string => mkdtempSync(path.join(tmpdir(), 'picode-pilocate-'));

const withFixture = (body: (root: string) => void): void => {
	const root = fixture();
	try {
		body(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
};

test('npm layout: the shim sits beside its node_modules and the walk-up finds it', () => {
	withFixture(root => {
		const entry = entryUnder(root, 'npm');
		mkdirSync(path.dirname(entry), { recursive: true });
		writeFileSync(entry, '');
		assert.equal(sdkEntryOfShim(path.join(root, 'npm', 'pi.cmd')), entry);
	});
});

test('managed layout: current-version names the release the launcher runs', () => {
	withFixture(root => {
		const entry = entryUnder(root, 'install', 'releases', '1.3.0');
		mkdirSync(path.dirname(entry), { recursive: true });
		writeFileSync(entry, '');
		writeFileSync(path.join(root, 'install', 'current-version'), '1.3.0\n');
		mkdirSync(path.join(root, 'bin'), { recursive: true });
		// The shim is one level below the root, exactly where pi-launcher.js puts it:
		// `agentDir = path.dirname(__dirname)` of the launcher beside the shim.
		assert.equal(sdkEntryOfShim(path.join(root, 'bin', 'pi.cmd')), entry);
	});
});

test('managed layout: a shim sitting directly on the root is answered too', () => {
	withFixture(root => {
		const entry = entryUnder(root, 'install', 'releases', '2.0.0-beta.1');
		mkdirSync(path.dirname(entry), { recursive: true });
		writeFileSync(entry, '');
		writeFileSync(path.join(root, 'install', 'current-version'), '2.0.0-beta.1');
		assert.equal(sdkEntryOfShim(path.join(root, 'pi')), entry);
	});
});

test('a version file that does not name one segment is "not found", never a path built from it', () => {
	withFixture(root => {
		const entry = entryUnder(root, 'install', 'releases', '1.3.0');
		mkdirSync(path.dirname(entry), { recursive: true });
		writeFileSync(entry, '');
		for (const hostile of ['..', '../outside', '', ' . ']) {
			writeFileSync(path.join(root, 'install', 'current-version'), hostile);
			mkdirSync(path.join(root, 'bin'), { recursive: true });
			assert.equal(sdkEntryOfShim(path.join(root, 'bin', 'pi.cmd')), undefined, `version file ${JSON.stringify(hostile)} must not resolve`);
		}
	});
});

test('a managed version whose release is missing on disk is "not found"', () => {
	withFixture(root => {
		mkdirSync(path.join(root, 'install'), { recursive: true });
		writeFileSync(path.join(root, 'install', 'current-version'), '9.9.9');
		mkdirSync(path.join(root, 'bin'), { recursive: true });
		assert.equal(sdkEntryOfShim(path.join(root, 'bin', 'pi.cmd')), undefined);
	});
});

test('no pi anywhere is undefined — the caller says so, it does not fall back', () => {
	withFixture(root => {
		assert.equal(sdkEntryOfShim(path.join(root, 'bin', 'pi.cmd')), undefined);
	});
});
