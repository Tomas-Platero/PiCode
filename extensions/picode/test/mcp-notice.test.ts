import * as assert from 'assert';
import { test } from 'node:test';
import { mcpNotice, mcpNoticeLine, mcpNoticeRow } from '../src/mcp-notice.ts';

const PI_NOTICE = 'MCP servers need attention:\natlassian-rovo-mcp: needs sign-in\nfirebase: failed: MCP request timed out after 60000ms\nsentry: needs sign-in\nRun /mcp to fix.';

test('each server gets an icon and a status in plain words', () => {
	const notice = mcpNotice(PI_NOTICE);
	assert.ok(notice);
	assert.deepStrictEqual(notice.rows.map(row => [row.server, row.status, row.needsSignIn]), [
		['atlassian-rovo-mcp', 'Sign-in needed', true],
		['firebase', 'Not responding', false],
		['sentry', 'Sign-in needed', true],
	]);
	assert.match(notice.markdown, /^\*\*3 MCP servers need attention\*\*/);
	assert.match(notice.markdown, /⏱️ \*\*firebase\*\* · Not responding/);
});

test('the terminal instruction is left out: the chat has buttons for it', () => {
	assert.doesNotMatch(mcpNotice(PI_NOTICE)?.markdown ?? '', /Run|\/mcp|60000/);
});

test('one server reads in the singular', () => {
	assert.match(mcpNotice('MCP servers need attention:\nsentry: needs sign-in')?.markdown ?? '', /^\*\*An MCP server needs attention\*\*/);
});

test('other notices are not redrawn', () => {
	assert.strictEqual(mcpNotice('Something else happened'), undefined);
	assert.strictEqual(mcpNotice('MCP servers need attention:\nRun /mcp to fix.'), undefined);
});

test('statuses pi may write', () => {
	assert.strictEqual(mcpNoticeRow('a', 'failed: spawn npx ENOENT').status, 'Could not start');
	assert.strictEqual(mcpNoticeRow('a', 'unauthorized (401)').needsSignIn, true);
	assert.strictEqual(mcpNoticeRow('a', 'disabled').status, 'Disabled');
});

test('the chat line is one compact row: each server with its fix as a link, and the page last', () => {
	const notice = mcpNotice('MCP servers need attention:\natlassian-rovo-mcp: needs sign-in\nsentry: unauthorized (401)\nRun /mcp to fix.');
	assert.ok(notice);
	const line = mcpNoticeLine(notice, 'picode.mcp.signInServer', 'open.mcp');
	assert.equal(line.split('\n').length, 1, 'one line, not a card and a stack of buttons');
	assert.match(line, /🔑 \*\*atlassian-rovo-mcp\*\* \[Sign in\]\(command:picode\.mcp\.signInServer\?%5B%22atlassian-rovo-mcp%22%5D\)/);
	assert.match(line, /🔑 \*\*sentry\*\* \[Sign in\]\(command:picode\.mcp\.signInServer\?%5B%22sentry%22%5D\)/);
	assert.match(line, /\[Manage MCPs\]\(command:open\.mcp\)$/);
});

test('a server that does not need a sign-in says what is wrong, with no sign-in link', () => {
	const notice = mcpNotice('MCP servers need attention:\nfirebase: failed: MCP request timed out after 60000ms');
	assert.ok(notice);
	const line = mcpNoticeLine(notice, 'sign', 'open');
	assert.match(line, /⏱️ \*\*firebase\*\* · Not responding/);
	assert.doesNotMatch(line, /Sign in/);
});

test('the same set of servers has the same key, whatever the order pi listed them in', () => {
	const a = mcpNotice('MCP servers need attention:\nsentry: needs sign-in\nvercel: needs sign-in');
	const b = mcpNotice('MCP servers need attention:\nvercel: needs sign-in\nsentry: needs sign-in');
	assert.ok(a && b);
	assert.equal(a.key, b.key);
});
