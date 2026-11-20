/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The editor's user-data folder, told from the connector's global storage, in the default
 * profile and in any other editor profile.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { userDataPathOf } from '../src/user-data-path.ts';

test('in the default profile the user data is three levels above the global storage', () => {
	assert.equal(userDataPathOf('C:\\PiCode\\data\\user-data\\User\\globalStorage\\picode.picode'), 'C:\\PiCode\\data\\user-data');
	assert.equal(userDataPathOf('/home/me/.config/PiCode/User/globalStorage/picode.picode'), '/home/me/.config/PiCode');
});

test('in another editor profile the profile folders are skipped', () => {
	assert.equal(userDataPathOf('C:\\PiCode\\data\\user-data\\User\\profiles\\-6d3a1f\\globalStorage\\picode.picode'), 'C:\\PiCode\\data\\user-data');
	assert.equal(userDataPathOf('/home/me/.config/PiCode/User/profiles/abc123/globalStorage/picode.picode'), '/home/me/.config/PiCode');
});

test('a folder named profiles that is not the profiles store is kept', () => {
	assert.equal(userDataPathOf('/home/profiles/x/User/globalStorage/picode.picode'), '/home/profiles/x');
});
