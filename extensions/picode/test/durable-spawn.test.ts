/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The editor's half of the daemon's lifetime contract, as one spawn plan.
 *
 * `node --test` runs this file directly (Node's own type stripping), which is why
 * `durable-spawn.ts` carries no `vscode` import. The rule being pinned here: nothing
 * PiCode starts may outlive PiCode — so the daemon is spawned ATTACHED (never detached,
 * never backgrounded by construction) and carries the lifeline pipe in its spawn
 * contract: stdin is a pipe the editor holds open and never writes, and the daemon is
 * told to stop itself when that pipe reads EOF (the editor died without running
 * `deactivate`). The daemon's half lives in `picode-source/durable/lib/daemon.js`.
 */

import assert from 'assert';
import { test } from 'node:test';
import { daemonSpawnPlan, PICODE_PARENT_PIPE_ENV, RUN_AS_NODE_ENV } from '../src/durable-spawn.ts';

test('the daemon is spawned attached: never detached, and it is `serve` on the daemon cli', () => {
	const plan = daemonSpawnPlan('picode-source/durable/cli.js', { PATH: 'x' }, undefined);
	assert.equal(plan.detached, false);
	assert.deepEqual(plan.args, ['picode-source/durable/cli.js', 'serve']);
});

test("the daemon runs on the editor's own binary as Node, not on whatever `node` the PATH finds", () => {
	const plan = daemonSpawnPlan('cli.js', {}, undefined);
	// An installed PiCode is self-contained: a machine that runs it does not need a Node on PATH.
	assert.equal(plan.command, process.execPath);
	// Without this the editor would be re-launched as an editor instead of run as the interpreter.
	assert.equal(plan.env[RUN_AS_NODE_ENV], '1');
});

test('the lifeline pipe is the spawn contract: stdin is a pipe, the log fd goes to out/err', () => {
	const withLog = daemonSpawnPlan('c:/durable/cli.js', {}, 7);
	assert.equal(withLog.stdio[0], 'pipe');
	assert.equal(withLog.stdio[1], 7);
	assert.equal(withLog.stdio[2], 7);
	// Without a log the daemon still speaks through the pipe — nothing about the
	// lifeline depends on where its own words go.
	const withoutLog = daemonSpawnPlan('c:/durable/cli.js', {}, undefined);
	assert.equal(withoutLog.stdio[0], 'pipe');
	assert.equal(withoutLog.stdio[1], 'ignore');
	assert.equal(withoutLog.stdio[2], 'ignore');
});

test('the daemon is told to watch the lifeline pipe, on top of the environment the caller passes', () => {
	const plan = daemonSpawnPlan('cli.js', { PI_AGENT_PROFILE: 'data/pi-agent', PICODE_PARENT_PIPE_ENV: undefined }, undefined);
	assert.equal(plan.env[PICODE_PARENT_PIPE_ENV], '1');
	assert.equal(plan.env.PI_AGENT_PROFILE, 'data/pi-agent');
});
