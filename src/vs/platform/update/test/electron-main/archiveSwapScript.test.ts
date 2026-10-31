/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { archiveSwapSpawnOptions } from '../../electron-main/archiveSwapScript.js';

suite('ArchiveSwapScript', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('starts the swap script hidden, without a console window of its own', () => {
		// `detached` would make Windows drop `windowsHide` and open a visible console
		// (an empty `find.exe` tab) for the whole portable update.
		const options: Record<string, unknown> = archiveSwapSpawnOptions();
		assert.deepStrictEqual(options, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
		assert.strictEqual('detached' in options, false);
	});
});
