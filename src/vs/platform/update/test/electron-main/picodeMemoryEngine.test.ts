/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { join, resolve } from 'path';
import { type IEngineMarkerIo, stopEngineLeftByPicode } from '../../electron-main/picodeMemoryEngine.js';

/** A folder with the windows' leases and PiCode's marker, and the processes the system runs. */
function world(files: Record<string, string>, leases: Record<string, number[]>, alive: number[], engines: number[]) {
	const killed: number[] = [];
	const removed: string[] = [];
	const io: IEngineMarkerIo = {
		read: file => files[file],
		list: dir => (leases[dir] ?? []).map(String),
		remove: file => { removed.push(file); delete files[file]; },
		isAlive: pid => alive.includes(pid),
		isEngine: pid => engines.includes(pid),
		kill: pid => { killed.push(pid); },
	};
	return { io, killed, removed };
}

const FOLDER = resolve('home', '.picode', 'memory');
const MARKER = join(FOLDER, 'engine-started-by-picode');
const LEASES = join(FOLDER, 'leases');

suite('PicodeMemoryEngine on quit', () => {

	test('stops the engine PiCode started once no window uses it', () => {
		const { io, killed, removed } = world({ [MARKER]: '4242' }, { [LEASES]: [100] }, [4242], [4242]);
		assert.deepStrictEqual(stopEngineLeftByPicode([FOLDER], io), [4242]);
		assert.deepStrictEqual(killed, [4242]);
		assert.deepStrictEqual(removed, [MARKER]);
	});

	test('leaves it running while a window (of any PiCode) still holds a lease', () => {
		const { io, killed } = world({ [MARKER]: '4242' }, { [LEASES]: [100] }, [100, 4242], [4242]);
		assert.deepStrictEqual(stopEngineLeftByPicode([FOLDER], io), []);
		assert.deepStrictEqual(killed, []);
	});

	test('never stops an engine PiCode did not start (no marker)', () => {
		const { io, killed } = world({}, {}, [4242], [4242]);
		assert.deepStrictEqual(stopEngineLeftByPicode([FOLDER], io), []);
		assert.deepStrictEqual(killed, []);
	});

	test('never signals a recycled process id that is not the engine', () => {
		const { io, killed, removed } = world({ [MARKER]: '4242' }, {}, [4242], []);
		assert.deepStrictEqual(stopEngineLeftByPicode([FOLDER], io), []);
		assert.deepStrictEqual(killed, []);
		assert.deepStrictEqual(removed, [MARKER]);
	});

	test('looks at each folder once, even when two paths name it', () => {
		const { io, killed } = world({ [MARKER]: '4242' }, {}, [4242], [4242]);
		assert.deepStrictEqual(stopEngineLeftByPicode([FOLDER, FOLDER], io), [4242]);
		assert.deepStrictEqual(killed, [4242]);
	});
});
