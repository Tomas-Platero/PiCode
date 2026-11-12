/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Closing pi-intercom's broker before an update sets the profile folder aside, run on its own.
 *
 * What matters: the broker that this installation's editor binary runs from this installation's
 * profile is stopped (whatever the case of the drive letter), and nothing else is: not a broker of
 * another PiCode install, not one run by a separate Node, not another process of the editor.
 */

import assert from 'assert';
import { test } from 'node:test';
import { dataFolderOf, isIntercomBrokerOf, readRunningProcesses, stopIntercomBrokers } from '../../../src/vs/platform/update/electron-main/picodeIntercomBroker.ts';

const INSTALL = 'C:\\Users\\tapla\\AppData\\Local\\Programs\\PiCode Experimental-win32-x64-experimental';
const EXE = `${INSTALL}\\PiCode Experimental.exe`;
const DATA = `${INSTALL}\\data`;
const BROKER_SCRIPT = `${DATA}\\pi-agent\\npm\\node_modules\\pi-intercom\\broker\\broker.ts`;
const BROKER_CMD = `"${EXE}" --import file:///c:/Users/tapla/AppData/Local/Programs/PiCode%20Experimental-win32-x64-experimental/data/pi-agent/npm/node_modules/tsx/dist/loader.mjs ${BROKER_SCRIPT}`;

function processes(running: { pid: number; path: string; commandLine: string }[], failing: number[] = []) {
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

test('the profile folder is the one at the top of the installation', () => {
	assert.strictEqual(dataFolderOf(`${INSTALL}\\resources\\app`), DATA);
});

test('the broker this installation runs from its profile is stopped, whatever the case of its drive', () => {
	const { io, killed } = processes([{ pid: 4120, path: EXE.replace('C:', 'c:'), commandLine: BROKER_CMD.replace('C:', 'c:') }]);
	assert.deepStrictEqual(stopIntercomBrokers(EXE, DATA, io, true), [4120]);
	assert.deepStrictEqual(killed, [4120]);
});

test('the editor itself and its other helpers are left alone', () => {
	const { io, killed } = processes([
		{ pid: 1, path: EXE, commandLine: `"${EXE}"` },
		{ pid: 2, path: EXE, commandLine: `"${EXE}" --type=renderer` },
		{ pid: 3, path: EXE, commandLine: BROKER_CMD },
	]);
	assert.deepStrictEqual(stopIntercomBrokers(EXE, DATA, io, true), [3]);
	assert.deepStrictEqual(killed, [3]);
});

test('a broker of another install or run by a separate Node is left alone', () => {
	const beta = 'C:\\Users\\tapla\\AppData\\Local\\Programs\\PiCode Beta\\PiCode Beta.exe';
	assert.strictEqual(isIntercomBrokerOf({ path: beta, commandLine: BROKER_CMD.replace(EXE, beta) }, EXE, DATA, true), false);
	assert.strictEqual(isIntercomBrokerOf({ path: 'C:\\Program Files\\nodejs\\node.exe', commandLine: `node ${BROKER_SCRIPT}` }, EXE, DATA, true), false);
	const otherProfile = 'C:\\Users\\tapla\\.pi\\agent\\npm\\node_modules\\pi-intercom\\broker\\broker.ts';
	assert.strictEqual(isIntercomBrokerOf({ path: EXE, commandLine: `"${EXE}" ${otherProfile}` }, EXE, DATA, true), false);
});

test('one that cannot be stopped does not keep the others from stopping', () => {
	const { io, killed } = processes([
		{ pid: 1, path: EXE, commandLine: BROKER_CMD },
		{ pid: 2, path: EXE, commandLine: BROKER_CMD },
	], [1]);
	assert.deepStrictEqual(stopIntercomBrokers(EXE, DATA, io, true), [2]);
	assert.deepStrictEqual(killed, [2]);
});

test('the system listing is read one process per line, and anything else is ignored', () => {
	const output = `4120|${EXE}|${BROKER_CMD}\r\n\r\nnot a process\r\n0|${EXE}|x\r\nabc|${EXE}|x\r\n77|${EXE}|\r\n`;
	assert.deepStrictEqual(readRunningProcesses(output), [
		{ pid: 4120, path: EXE, commandLine: BROKER_CMD },
	]);
});
