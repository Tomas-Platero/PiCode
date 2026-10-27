import * as assert from 'assert';
import { test } from 'node:test';
import { mcpNotice, mcpNoticeRow } from '../src/mcp-notice.ts';

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
