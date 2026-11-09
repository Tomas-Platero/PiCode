/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Closing the memory engine that PiCode carries before an update replaces its folder, run on its own.
 *
 * What matters: an engine running from the installation's own folder is stopped (whatever the case
 * of the drive letter), and nothing else is: not the one another program installed, not a folder
 * with a similar name, not an answer that is not a process.
 */

import assert from 'assert';
import { test } from 'node:test';
import { isInsideFolder, memoryFolderOf, readRunningEngines, stopEnginesInside } from '../../../src/vs/platform/update/electron-main/picodeMemoryEngine.ts';

const INSTALL = 'C:\\Users\\tapla\\AppData\\Local\\Programs\\PiCode Experimental-win32-x64-experimental';
const MEMORY = `${INSTALL}\\resources\\memory`;

function processes(running: { pid: number; path: string }[], failing: number[] = []) {
	const killed: number[] = [];
	return {
		killed,
		io: {
			list: () => running,
			kill: (pid: number) => {
				if (failing.includes(pid)) {
					throw new Error('already gone');
				}
				killed.push(pid);
			}
		}
	};
}

test('the memory folder is the one next to the editor code', () => {
	assert.strictEqual(memoryFolderOf(`${INSTALL}\\resources\\app`), MEMORY);
});

test('an engine running from the installation is stopped, whatever the case of its drive', () => {
	const { io, killed } = processes([{ pid: 15460, path: MEMORY.replace('C:', 'c:') + '\\engram.exe' }]);
	assert.deepStrictEqual(stopEnginesInside(MEMORY, io, true), [15460]);
	assert.deepStrictEqual(killed, [15460]);
});

test('the engine another program installed is left alone', () => {
	const { io, killed } = processes([
		{ pid: 28732, path: 'C:\\Users\\tapla\\AppData\\Local\\engram\\bin\\engram.exe' },
		{ pid: 15460, path: `${MEMORY}\\engram.exe` },
	]);
	assert.deepStrictEqual(stopEnginesInside(MEMORY, io, true), [15460]);
	assert.deepStrictEqual(killed, [15460]);
});

test('a folder that only starts with the same name is not the installation', () => {
	assert.strictEqual(isInsideFolder(`${MEMORY}-old\\engram.exe`, MEMORY, true), false);
	assert.strictEqual(isInsideFolder(`${MEMORY}\\engram.exe`, MEMORY, true), true);
	assert.strictEqual(isInsideFolder(`${MEMORY}\\`, MEMORY, true), false);
});

test('one that cannot be stopped does not keep the others from stopping', () => {
	const { io, killed } = processes([
		{ pid: 1, path: `${MEMORY}\\engram.exe` },
		{ pid: 2, path: `${MEMORY}\\engram.exe` },
	], [1]);
	assert.deepStrictEqual(stopEnginesInside(MEMORY, io, true), [2]);
	assert.deepStrictEqual(killed, [2]);
});

test('nothing running means nothing to stop', () => {
	const { io, killed } = processes([]);
	assert.deepStrictEqual(stopEnginesInside(MEMORY, io, true), []);
	assert.deepStrictEqual(killed, []);
});

test('the system listing is read one process per line, and anything else is ignored', () => {
	const output = `15460|${MEMORY}\\engram.exe\r\n\r\nnot a process\r\n|${MEMORY}\\x.exe\r\n0|${MEMORY}\\x.exe\r\nabc|${MEMORY}\\x.exe\r\n28732|C:\\other\\engram.exe\r\n`;
	assert.deepStrictEqual(readRunningEngines(output), [
		{ pid: 15460, path: `${MEMORY}\\engram.exe` },
		{ pid: 28732, path: 'C:\\other\\engram.exe' },
	]);
});
