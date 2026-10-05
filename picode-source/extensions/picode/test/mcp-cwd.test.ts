/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The MCP stdio transport's `cwd`, as this editor wraps it.
 *
 * pi's own transport (`pi-mcp/dist/transports/stdio.js:77`) spawns the server with
 * `cwd: resolve(sessionCwd, expandHome(config.cwd ?? '.'))` and reports a failure as the raw spawn
 * error — `spawn node ENOENT`, or `spawn C:\WINDOWS\system32\cmd.exe ENOENT` for the `.cmd` shims
 * cross-spawn routes through cmd.exe. When the directory is the thing that is not there, that
 * sentence is a lie about the command. The wrapper never lets a missing directory stop a server:
 * it starts it in the session directory or the home one instead and says so; and when no directory
 * can be resolved at all, it says *that* — naming the directory, never pretending about the
 * command. The tilde and relative-`cwd` resolution must match pi's own (`extensions/mcp/runtime.js:67`).
 */

import assert from 'assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCwdSafeTransport, expandMcpHome, resolveMcpServerCwd } from '../src/mcp-cwd.ts';

const home = mkdtempSync(join(tmpdir(), 'mcp-cwd-home-'));
const session = mkdtempSync(join(tmpdir(), 'mcp-cwd-session-'));
const gone = join(session, 'moved-away');

const log = (lines: string[]) => (line: string) => lines.push(line);
/** A fake of pi's `createDefaultTransport`: records the cwd it was handed. */
const recorder = () => {
	const calls: Array<{ name: string; cwd: string }> = [];
	const createDefaultTransport = (entry: unknown, cwd: string) => {
		const server = entry as { name: string };
		calls.push({ name: server.name, cwd });
		return { handed: cwd };
	};
	return { calls, createDefaultTransport };
};

test('the tilde expansion matches pi’s own: bare `~`, `~/…`, and `~\\…` on Windows', () => {
	assert.strictEqual(expandMcpHome('~', home), home);
	assert.strictEqual(expandMcpHome('~/servers', home), join(home, 'servers'));
	if (process.platform === 'win32') {
		assert.strictEqual(expandMcpHome('~\\servers', home), join(home, 'servers'));
	}
	assert.strictEqual(expandMcpHome('./relative', home), './relative');
	assert.strictEqual(expandMcpHome('C:/elsewhere', home), 'C:/elsewhere');
});

test('the server cwd resolves like pi’s transport: config.cwd against the session directory', () => {
	assert.strictEqual(resolveMcpServerCwd({}, session, home), session);
	assert.strictEqual(resolveMcpServerCwd({ cwd: 'sub' }, session, home), join(session, 'sub'));
	assert.strictEqual(resolveMcpServerCwd({ cwd: '~' }, session, home), home);
});

test('an existing directory is handed through untouched', () => {
	const { calls, createDefaultTransport } = recorder();
	const transport = createCwdSafeTransport({ createDefaultTransport, home, log: log([]) })(
		{ name: 'aikido', config: {} }, session, undefined,
	);
	assert.strictEqual((transport as { handed: string }).handed, session);
	assert.deepStrictEqual(calls, [{ name: 'aikido', cwd: session }]);
});

test('a missing directory never stops the server: it starts in the session directory instead, and says so', () => {
	const { calls, createDefaultTransport } = recorder();
	const lines: string[] = [];
	const transport = createCwdSafeTransport({ createDefaultTransport, home, log: log(lines) })(
		{ name: 'aikido', config: { cwd: 'moved-away' } }, session, undefined,
	);
	assert.strictEqual((transport as { handed: string }).handed, session);
	assert.deepStrictEqual(calls, [{ name: 'aikido', cwd: session }]);
	assert.strictEqual(lines.length, 1);
	assert.match(lines[0], /aikido/);
	assert.ok(lines[0].includes(gone), 'the log names the directory that is not there');
	assert.ok(lines[0].includes('does not exist'), 'the log says the directory does not exist');
	assert.ok(!lines[0].includes('ENOENT'), 'the log never blames the command');
});

test('a missing session directory falls back to the home one', () => {
	const { calls, createDefaultTransport } = recorder();
	const lines: string[] = [];
	const transport = createCwdSafeTransport({ createDefaultTransport, home, log: log(lines) })(
		{ name: 'aikido', config: {} }, gone, undefined,
	);
	assert.strictEqual((transport as { handed: string }).handed, home);
	assert.deepStrictEqual(calls, [{ name: 'aikido', cwd: home }]);
	assert.ok(lines[0]?.includes('does not exist'));
});

test('a url server has no directory: it is handed through untouched even in a broken workspace', () => {
	const { calls, createDefaultTransport } = recorder();
	const transport = createCwdSafeTransport({ createDefaultTransport, home, log: log([]) })(
		{ name: 'github', config: { url: 'https://api.githubcopilot.com/mcp/' } }, gone, undefined,
	);
	assert.ok(transport !== undefined);
	assert.deepStrictEqual(calls, [{ name: 'github', cwd: gone }]);
});

test('when no directory can be resolved at all, the error names the directory and never the command', () => {
	const { createDefaultTransport } = recorder();
	const nothing = createCwdSafeTransport({ createDefaultTransport, home: gone, log: log([]) });
	assert.throws(
		() => nothing({ name: 'aikido', config: { cwd: 'moved-away' } }, gone, undefined),
		(error: Error) => {
			assert.ok(error.message.includes('aikido'));
			assert.ok(error.message.includes(join(gone, 'moved-away')), 'the wanted directory is named');
			assert.ok(error.message.includes('does not exist'));
			assert.ok(!error.message.includes('ENOENT'), 'the message never blames the command');
			assert.ok(!error.message.includes('cmd.exe'));
			return true;
		},
	);
});

test('a file where the directory should be counts as not there', () => {
	const file = join(session, 'a-file');
	writeFileSync(file, 'not a directory');
	const { calls, createDefaultTransport } = recorder();
	const lines: string[] = [];
	const transport = createCwdSafeTransport({ createDefaultTransport, home, log: log(lines) })(
		{ name: 'aikido', config: { cwd: file } }, session, undefined,
	);
	assert.strictEqual((transport as { handed: string }).handed, session);
	assert.ok(lines[0]?.includes('does not exist'));
});
