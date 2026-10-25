/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which folder is the distribution, told from the editor's application root, run on its own.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { distributionRootOf } from '../src/distribution-root.ts';

test('in a pack the distribution is two levels above the application', () => {
	assert.equal(distributionRootOf('C:\\Apps\\PiCode\\resources\\app'), 'C:\\Apps\\PiCode');
	assert.equal(distributionRootOf('/opt/picode/resources/app'), '/opt/picode');
});

test('in a source tree the application root is the distribution, whatever it is called', () => {
	assert.equal(distributionRootOf('D:\\repositorios\\PiCode'), 'D:\\repositorios\\PiCode');
	assert.equal(distributionRootOf('/home/me/PiCode'), '/home/me/PiCode');
});

test('a folder that only looks like the pack layout is not one', () => {
	assert.equal(distributionRootOf('D:\\work\\resources\\app-extra'), 'D:\\work\\resources\\app-extra');
	assert.equal(distributionRootOf('D:\\work\\my-resources\\app'), 'D:\\work\\my-resources\\app');
});
