/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The daemon's own request resolver, exercised from the connector's tests.
 *
 * `durable/lib/daemon.js` is the daemon's one file and imports cleanly (the serve is
 * started by `cli.js`, not by loading the module), so its exported `agentFor` can be
 * pinned here — the `cwd` half is what the editor's durable chats depend on, and it is
 * the one field a wrong shape would silently drop.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentFor } from '../../../durable/lib/daemon.js';

/** The resolved options the daemon hands `agentFor`: only the model default is read. */
const resolved = { options: { model: { value: 'omni/auto' }, agent: { value: undefined } } };

test('an absolute cwd becomes the conversation\'s working directory', () => {
	const agent = agentFor(resolved, [], { cwd: 'D:\\repositorios\\PiCode' });
	assert.equal(agent.cwd, 'D:\\repositorios\\PiCode');
});

test('a relative cwd is refused — it would mean wherever the daemon was started', () => {
	assert.equal(agentFor(resolved, [], { cwd: 'src' }).cwd, undefined);
	assert.equal(agentFor(resolved, [], { cwd: './src' }).cwd, undefined);
});

test('a missing or mistyped cwd says nothing rather than guessing one', () => {
	assert.equal(agentFor(resolved, [], {}).cwd, undefined);
	assert.equal(agentFor(resolved, [], { cwd: 42 as unknown as string }).cwd, undefined);
	assert.equal(agentFor(resolved, [], { cwd: undefined }).cwd, undefined);
});

test('model and agent resolution keep working beside the cwd', () => {
	const agent = agentFor(resolved, [], { model: 'omni/gpt', cwd: '/tmp/work' });
	assert.deepEqual(agent.model, { provider: 'omni', modelId: 'gpt' });
	assert.equal(agent.cwd, '/tmp/work');
	// An unknown agent name is the daemon's own error, not a silent empty agent.
	assert.throws(() => agentFor(resolved, [], { agent: 'no-such-agent' }), /No agent/);
});
