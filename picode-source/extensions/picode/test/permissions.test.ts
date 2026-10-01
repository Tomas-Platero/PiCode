/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The chat's "Default permissions" control governing pi's native tools, run on its own.
 *
 * `node --test` runs this file directly (Node's own type stripping), which is why
 * `permissions.ts` carries no `vscode`: which tool asks and how an answer is read are the
 * parts worth exercising, and none of them needs an editor.
 *
 * The MCP half of the rule is here because the gap was real: pi's MCP tools ran with no question
 * at all, however much they changed (see `odd/tasks/picode-pi-0992.md`).
 */

import assert from 'assert';
import { test } from 'node:test';
import {
	decisionFromAnswer,
	permissionLevelOf,
	shouldAsk,
	PERMISSION_ALLOW,
	PERMISSION_DENY,
	PERMISSION_QUESTION_ID,
} from '../src/permissions.ts';

test('shouldAsk asks for the four mutating tools at the default level', () => {
	assert.strictEqual(shouldAsk('default', 'bash'), true);
	assert.strictEqual(shouldAsk('default', 'powershell'), true);
	assert.strictEqual(shouldAsk('default', 'edit'), true);
	assert.strictEqual(shouldAsk('default', 'write'), true);
});

test('shouldAsk asks for the four mutating tools at the assisted level', () => {
	assert.strictEqual(shouldAsk('assisted', 'bash'), true);
	assert.strictEqual(shouldAsk('assisted', 'powershell'), true);
	assert.strictEqual(shouldAsk('assisted', 'edit'), true);
	assert.strictEqual(shouldAsk('assisted', 'write'), true);
});

test('shouldAsk never asks at autoApprove or autopilot', () => {
	for (const level of ['autoApprove', 'autopilot']) {
		for (const tool of ['bash', 'powershell', 'edit', 'write']) {
			assert.strictEqual(shouldAsk(level, tool), false, `${level}/${tool}`);
		}
	}
});

test('shouldAsk treats an undefined level as default', () => {
	assert.strictEqual(shouldAsk(undefined, 'bash'), true);
	assert.strictEqual(shouldAsk(undefined, 'edit'), true);
});

test('shouldAsk fails open for an unknown level', () => {
	assert.strictEqual(shouldAsk('yolo', 'bash'), false);
});

test('shouldAsk never asks for read-only tools', () => {
	for (const tool of ['read', 'grep', 'find', 'ls', '', 'Bash']) {
		assert.strictEqual(shouldAsk('default', tool), false, tool);
		assert.strictEqual(shouldAsk('assisted', tool), false, tool);
	}
});

// pi's own MCP tools are somebody else's: nothing in the name says whether a call reads or writes,
// so they ask like the mutating built-ins do. The field that would let a name be classified is not
// there, and guessing from it would let `delete_*` through the day a server names it differently.
test("shouldAsk asks for pi's MCP tools at the levels that ask", () => {
	assert.strictEqual(shouldAsk('default', 'mcp__supabase-mcp-server__execute_sql'), true);
	assert.strictEqual(shouldAsk('assisted', 'mcp__sentry__list_issues'), true);
	assert.strictEqual(shouldAsk(undefined, 'mcp__github__create_issue'), true);
});

test("shouldAsk asks nothing for pi's MCP tools at the approving levels", () => {
	assert.strictEqual(shouldAsk('autoApprove', 'mcp__supabase-mcp-server__execute_sql'), false);
	assert.strictEqual(shouldAsk('autopilot', 'mcp__supabase-mcp-server__execute_sql'), false);
});

// The editor's own MCP tools arrive through `lm.invokeTool`, which runs the editor's confirmation
// first: asking here as well would be the same question twice.
test("shouldAsk leaves the editor's MCP tools to the editor", () => {
	assert.strictEqual(shouldAsk('default', 'mcp_github_search'), false);
	assert.strictEqual(shouldAsk('assisted', 'mcp_firebase_firebase_list_projects'), false);
});

test('decisionFromAnswer allows an explicit allow answer', () => {
	const answer = { [PERMISSION_QUESTION_ID]: PERMISSION_ALLOW };
	assert.deepStrictEqual(decisionFromAnswer(answer, 'bash'), { block: false, reason: '' });
});

test('decisionFromAnswer declines an explicit deny answer', () => {
	const answer = { [PERMISSION_QUESTION_ID]: PERMISSION_DENY };
	assert.deepStrictEqual(decisionFromAnswer(answer, 'edit'), {
		block: true,
		reason: 'The user declined this edit call',
	});
});

test('decisionFromAnswer treats a missing answer (Escape, cancel, teardown) as a cancellation', () => {
	assert.deepStrictEqual(decisionFromAnswer(undefined, 'write'), {
		block: true,
		reason: 'Tool call cancelled before approval',
	});
});

test('decisionFromAnswer declines an unknown or malformed answer', () => {
	assert.deepStrictEqual(decisionFromAnswer({ [PERMISSION_QUESTION_ID]: 'maybe' }, 'bash').block, true);
	assert.deepStrictEqual(decisionFromAnswer({}, 'bash').block, true);
});

test('permissionLevelOf lets the request win over the setting', () => {
	assert.strictEqual(permissionLevelOf('autopilot', 'default'), 'autopilot');
	assert.strictEqual(permissionLevelOf('autoApprove', 'assisted'), 'autoApprove');
});

test('permissionLevelOf falls back to a valid setting', () => {
	assert.strictEqual(permissionLevelOf(undefined, 'autoApprove'), 'autoApprove');
	assert.strictEqual(permissionLevelOf(undefined, 'assisted'), 'assisted');
});

test('permissionLevelOf degrades unknown input to default', () => {
	assert.strictEqual(permissionLevelOf(undefined, 'nonsense'), 'default');
	assert.strictEqual(permissionLevelOf('garbage', undefined), 'default');
	assert.strictEqual(permissionLevelOf(42, { level: 'autopilot' }), 'default');
	assert.strictEqual(permissionLevelOf(undefined, undefined), 'default');
});
