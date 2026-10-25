/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The timeline of gentle-pi's child pi processes, run on its own with a stand-in for `spawn`.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { isChildPi, lateness, traceChildPi, type SpawnModule } from '../src/child-trace.ts';

class FakeChild extends EventEmitter {
	pid = 4242;
	killed: unknown[] = [];
	kill(signal?: unknown): boolean {
		this.killed.push(signal);
		return true;
	}
}

const EDITOR = 'C:\\Apps\\PiCode\\PiCode.exe';

test('only the editor\'s binary over a pi cli.js is a child pi', () => {
	assert.equal(isChildPi(EDITOR, ['D:\\pi\\dist\\cli.js', '--mode', 'rpc'], EDITOR), true);
	assert.equal(isChildPi(EDITOR, ['/pi/dist/cli.js'], EDITOR), true);
	assert.equal(isChildPi(EDITOR, ['something.js'], EDITOR), false);
	assert.equal(isChildPi('git', ['/pi/dist/cli.js'], EDITOR), false);
	assert.equal(isChildPi(EDITOR, undefined, EDITOR), false);
});

test('a timer that fires late is how long the editor stood still', () => {
	assert.equal(lateness(1_000, 1_000), 0);
	assert.equal(lateness(1_000, 1_250), 250);
	assert.equal(lateness(1_000, 900), 0);
});

test('a child pi leaves started, asked to stop, exit and closed, in order, with its time', () => {
	const lines: string[] = [];
	const child = new FakeChild();
	const module: SpawnModule = { spawn: () => child as never };
	let clock = 1_000;
	const timers: Array<() => void> = [];
	traceChildPi(module, line => lines.push(line), EDITOR, () => clock, body => { timers.push(body); return 1; }, () => undefined);
	const spawned = module.spawn(EDITOR, ['/pi/dist/cli.js', '--mode', 'rpc']) as unknown as FakeChild;
	assert.equal(spawned, child);
	clock += 2_000;
	timers[0]!(); // the editor stood still: this timer was due 1.9 s ago
	spawned.kill('SIGTERM');
	clock += 30;
	child.emit('exit', null, 'SIGTERM');
	child.emit('close');
	assert.deepEqual(child.killed, ['SIGTERM']);
	assert.match(lines[0]!, /started/);
	assert.match(lines[1]!, /asked to stop \(SIGTERM, accepted: true\) \+2000ms/);
	assert.match(lines[2]!, /exit event \(code null, signal SIGTERM\) \+2030ms/);
	assert.match(lines[3]!, /closed \+2030ms; the editor stood still up to 1900ms/);
});

test('any other process is left exactly as it was, and wrapping twice wraps once', () => {
	const lines: string[] = [];
	const other = new FakeChild();
	const module: SpawnModule = { spawn: () => other as never };
	const restore = traceChildPi(module, line => lines.push(line), EDITOR);
	const again = traceChildPi(module, line => lines.push(line), EDITOR);
	assert.equal(module.spawn('git', ['status']), other as never);
	assert.deepEqual(lines, []);
	assert.equal(other.listenerCount('exit'), 0);
	again();
	restore();
	assert.equal(typeof module.spawn, 'function');
});

test('an exit the editor hears late is announced once the process is gone, and not said twice', () => {
	const lines: string[] = [];
	const child = new FakeChild();
	const module: SpawnModule = { spawn: () => child as never };
	const timers: Array<() => void> = [];
	traceChildPi(module, line => lines.push(line), EDITOR, () => 0, body => { timers.push(body); return 1; }, () => undefined, () => false);
	const spawned = module.spawn(EDITOR, ['/pi/dist/cli.js', '--mode', 'rpc']) as unknown as FakeChild;
	const heard: unknown[][] = [];
	spawned.on('exit', (...args) => heard.push(args));
	spawned.kill('SIGTERM');
	timers[1]!(); // the process is already gone
	spawned.emit('exit', null, 'SIGTERM'); // the late real one
	assert.deepEqual(heard, [[null, 'SIGTERM']]);
	assert.ok(lines.some(line => /exit announced by the editor/.test(line)));
});
