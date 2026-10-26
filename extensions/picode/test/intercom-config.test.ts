/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** pi-intercom's broker launch, written into PiCode's profile. `node --test` runs this file directly. */

import assert from 'assert';
import { test } from 'node:test';
import { withIntercomBroker } from '../src/intercom-config.ts';

const ARGS = ['--import', 'file:///D:/PiCode/data/pi-agent/npm/node_modules/tsx/dist/loader.mjs'];

test('a first run writes the broker launch', () => {
	const result = withIntercomBroker(undefined, 'D:\PiCode\PiCode Experimental.exe', ARGS);
	assert.equal(result.changed, true);
	assert.deepEqual(JSON.parse(result.text!), { brokerCommand: 'D:\PiCode\PiCode Experimental.exe', brokerArgs: ARGS });
});

test('the owner\'s other settings stay, and a second run changes nothing', () => {
	const first = withIntercomBroker(JSON.stringify({ confirmSend: true, brokerCommand: 'npx' }), 'pc.exe', ARGS);
	assert.deepEqual(JSON.parse(first.text!), { confirmSend: true, brokerCommand: 'pc.exe', brokerArgs: ARGS });
	assert.equal(withIntercomBroker(first.text, 'pc.exe', ARGS).changed, false);
});

test('a moved editor is followed', () => {
	const first = withIntercomBroker(undefined, 'C:\old\pc.exe', ARGS);
	assert.equal(withIntercomBroker(first.text, 'D:\new\pc.exe', ARGS).changed, true);
});

test('a file that is not a JSON object is never replaced by a guess', () => {
	for (const text of ['{ broken', '[]', '"x"']) {
		assert.deepEqual(withIntercomBroker(text, 'pc.exe', ARGS), { text, changed: false });
	}
});
