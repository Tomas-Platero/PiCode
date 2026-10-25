/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The setup window's host runs in plain Node, before any editor exists, and loads the connector's
 * `onboarding-host` from its compiled output. If anything in that module's tree needs the editor
 * (`vscode`), the setup cannot start: "Cannot find module 'vscode'". This loads the whole tree
 * with `vscode` forbidden, so the next import that drags the editor in fails here instead of in
 * the window.
 */

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const loaded: string[] = [];

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'vscode') {
			throw new Error(`the setup host needs the editor: ${context.parentURL ?? 'unknown importer'} imports 'vscode'`);
		}
		if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
			return nextResolve(`${specifier}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		loaded.push(url);
		return nextLoad(url, context);
	},
});

test('the setup host loads without the editor', async () => {
	const host = await import('../src/onboarding-host.ts');
	assert.equal(typeof host, 'object');
	assert.ok(loaded.some(url => url.endsWith('onboarding-host.ts')), 'the host itself was loaded');
	assert.ok(!loaded.some(url => url.endsWith('/runtime.ts')), 'nothing in its tree needs runtime.ts, which needs the editor');
});
