/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The memory engine's rules, pinned.
 *
 * `node --test` runs this file directly (Node's own type stripping), which is why `engram.ts`
 * carries no `vscode` import. What is being pinned is not plumbing but three product promises:
 *
 *  * the engine is found **wherever PiCode is installed**, without the owner configuring anything;
 *  * the store is `~/.engram` and is reused exactly as found — it is the user's, and it is shared;
 *  * a server answering on the port is only joined when it owns *this* store, because two
 *    processes on one store is how a memory gets corrupted.
 */

import assert from 'assert';
import { test } from 'node:test';
import * as path from 'path';
import {
	ENGRAM_DEFAULT_PORT,
	engramBinaryCandidates,
	firstEngramBinary,
	engramBinaryName,
	engramDataDir,
	engramDeclarationDecision,
	engramMcpDeclaration,
	engramOwnsStore,
	engramServerUrl,
	engramStateLine,
	isOurEngramDeclaration,
	defaultEngramDataDir,
	parseEngramHealth,
	parseEngramStats,
	SHIPPED_ENGRAM_FOLDER
} from '../src/engram.ts';

/** POSIX separators for comparison, so the assertions read the same on every platform. */
const slashed = (value: string) => value.replace(/\\/g, '/');

/** A fully resolved app root: `<install>/resources/app`, as an installed editor has it. */
const appRoot = () => slashed(path.resolve(process.cwd(), 'install', 'resources', 'app'));

test('the engine is looked for in the open folders and then where the installation carries it', () => {
	const candidates = engramBinaryCandidates(undefined, [
		slashed(path.resolve(process.cwd(), 'work', 'one')),
		slashed(path.resolve(process.cwd(), 'work', 'two'))
	], appRoot());

	const binary = engramBinaryName();
	assert.deepEqual(candidates, [
		slashed(path.resolve(process.cwd(), 'work', 'one', SHIPPED_ENGRAM_FOLDER, binary)),
		slashed(path.resolve(process.cwd(), 'work', 'two', SHIPPED_ENGRAM_FOLDER, binary)),
		// `<app>/resources/app` → up one is `<app>/resources`, where the build writes `memory/`.
		slashed(path.resolve(process.cwd(), 'install', 'resources', SHIPPED_ENGRAM_FOLDER, binary))
	]);
});

test('an absolute path is the owner\'s own answer, used as given and nothing else', () => {
	const own = path.resolve(process.cwd(), 'D:', 'tools', 'engram.exe');
	assert.deepEqual(engramBinaryCandidates(own, [process.cwd()], appRoot()), [own]);
});

test('the engine is found without waiting: the first candidate that exists, or none', () => {
	const shipped = slashed(path.resolve(process.cwd(), 'install', 'resources', SHIPPED_ENGRAM_FOLDER, engramBinaryName()));
	const base = { env: {}, home: slashed(path.resolve(process.cwd(), 'home')), appRoot: appRoot(), workspaceFolders: [] as string[] };
	assert.equal(firstEngramBinary({ ...base, exists: candidate => slashed(candidate) === shipped }), shipped);
	assert.equal(firstEngramBinary({ ...base, exists: () => false }), undefined);
});

test('a custom relative folder still ends at the engine the editor ships', () => {
	const candidates = engramBinaryCandidates('my/memory', [], appRoot());
	assert.equal(
		candidates[candidates.length - 1],
		slashed(path.resolve(process.cwd(), 'install', 'resources', SHIPPED_ENGRAM_FOLDER, engramBinaryName()))
	);
});

test('an engine the machine already had is the last resort, never the first', () => {
	const binary = engramBinaryName();
	const pathValue = [path.resolve(process.cwd(), 'usr', 'bin'), path.resolve(process.cwd(), 'tools')].join(';');

	const candidates = engramBinaryCandidates(undefined, [], appRoot(), pathValue);

	// The installation's copy comes before anything on PATH: it is pinned, and the store is
	// shared with whatever other agent on the machine wrote there.
	assert.equal(
		candidates[candidates.length - 3],
		slashed(path.resolve(process.cwd(), 'install', 'resources', SHIPPED_ENGRAM_FOLDER, binary))
	);
	assert.deepEqual(candidates.slice(-2), [
		slashed(path.resolve(process.cwd(), 'usr', 'bin', binary)),
		slashed(path.resolve(process.cwd(), 'tools', binary))
	]);
});

test('the binary carries its extension only on Windows', () => {
	assert.equal(engramBinaryName('win32'), 'engram.exe');
	assert.equal(engramBinaryName('linux'), 'engram');
	assert.equal(engramBinaryName('darwin'), 'engram');
});

test('the store is ~/.engram unless the engine itself was pointed elsewhere', () => {
	// The engine's own default, kept so the store is shared with any other agent on the machine
	// rather than owned by this product.
	assert.equal(engramDataDir({}, 'C:\\Users\\someone'), 'C:/Users/someone/.engram');
	assert.equal(defaultEngramDataDir('/home/someone'), '/home/someone/.engram');

	// A blank value is not an answer: the engine treats it as unset and so does this product.
	assert.equal(engramDataDir({ ENGRAM_DATA_DIR: '   ' }, '/home/someone'), '/home/someone/.engram');
	assert.equal(engramDataDir({ ENGRAM_DATA_DIR: 'D:\\memory' }, '/home/someone'), 'D:\\memory');
});

test('the server address follows the engine\'s own environment, then the default port', () => {
	assert.equal(engramServerUrl({}), `http://127.0.0.1:${ENGRAM_DEFAULT_PORT}`);
	assert.equal(engramServerUrl({ ENGRAM_PORT: '7455' }), 'http://127.0.0.1:7455');
	// An owner-managed server wins, and its trailing slash never doubles up in a request.
	assert.equal(engramServerUrl({ ENGRAM_URL: 'http://127.0.0.1:9000/', ENGRAM_PORT: '7455' }), 'http://127.0.0.1:9000');
	// A blank URL is unset, not "the empty server".
	assert.equal(engramServerUrl({ ENGRAM_URL: '  ' }), `http://127.0.0.1:${ENGRAM_DEFAULT_PORT}`);
});

test('a health body is only trusted when the engine itself answered ok', () => {
	const health = parseEngramHealth({ service: 'engram', status: 'ok', version: '3.4.0', instance_id: 'abc' });
	assert.deepEqual(health, { version: '3.4.0', instanceId: 'abc' });

	// Everything else is somebody else, or a broken answer. Nothing is guessed at.
	assert.equal(parseEngramHealth(undefined), undefined);
	assert.equal(parseEngramHealth('ok'), undefined);
	assert.equal(parseEngramHealth({ service: 'engram', status: 'degraded', version: '3.4.0', instance_id: 'abc' }), undefined);
	assert.equal(parseEngramHealth({ service: 'other', status: 'ok', version: '3.4.0', instance_id: 'abc' }), undefined);
	assert.equal(parseEngramHealth({ service: 'engram', status: 'ok', instance_id: 'abc' }), undefined);
	assert.equal(parseEngramHealth({ service: 'engram', status: 'ok', version: '3.4.0' }), undefined);
});

test('a running server is joined only when it serves this store', () => {
	const health = { version: '3.4.0', instanceId: 'e98b96b9e07cb781a078add37ac98652' };

	assert.equal(engramOwnsStore(health, 'e98b96b9e07cb781a078add37ac98652'), true);
	assert.equal(engramOwnsStore(health, 'e98b96b9e07cb781a078add37ac98652\n'), true);
	// Another store's server on the same port (a second install, a WSL loopback): not ours.
	assert.equal(engramOwnsStore(health, '00000000000000000000000000000000'), false);
	// A store that has never been opened has no identity to compare, so nothing is adopted.
	assert.equal(engramOwnsStore(health, undefined), false);
	assert.equal(engramOwnsStore(health, ''), false);
});

test('stats reduce to the two numbers a surface shows', () => {
	assert.deepEqual(parseEngramStats({ total_observations: 134, projects: ['picode', 'other'] }), { memories: 134, projects: 2 });
	assert.deepEqual(parseEngramStats({ total_observations: 0, projects: [] }), { memories: 0, projects: 0 });

	assert.equal(parseEngramStats({ total_observations: -1, projects: [] }), undefined);
	assert.equal(parseEngramStats({ total_observations: 'many', projects: [] }), undefined);
	assert.equal(parseEngramStats({ total_observations: 1 }), undefined);
	assert.equal(parseEngramStats(null), undefined);
});

test('what the owner reads is a state, never the machinery', () => {
	assert.equal(engramStateLine({ kind: 'ready', memories: 1, version: '3.4.0' }), 'Memory: 1 memory');
	assert.equal(engramStateLine({ kind: 'ready', memories: 134, version: '3.4.0' }), 'Memory: 134 memories');
	assert.equal(engramStateLine({ kind: 'empty' }), 'Memory: ready · nothing saved yet');
	assert.equal(engramStateLine({ kind: 'missing' }), 'Memory: unavailable — this installation has no memory engine');
	assert.equal(engramStateLine({ kind: 'foreign', url: 'http://127.0.0.1:7437' }), 'Memory: unavailable — another engram answered on this machine');
	assert.equal(engramStateLine({ kind: 'error', detail: 'the engine did not start' }), 'Memory: error — the engine did not start');

	// No path, no port, no instance id ever reaches the line.
	for (const line of [
		engramStateLine({ kind: 'ready', memories: 3, version: '3.4.0' }),
		engramStateLine({ kind: 'foreign', url: 'http://127.0.0.1:7437' })
	]) {
		assert.equal(/[\\/]|127\.0\.0\.1|instance/.test(line), false, line);
	}
});

test('the declaration pi receives names a short set and an absolute command', () => {
	const declaration = engramMcpDeclaration('C:/PiCode/resources/memory/engram.exe');

	assert.equal(declaration.name, 'engram');
	assert.equal(declaration.transport, 'stdio');
	assert.deepEqual(declaration.args, ['mcp', '--tools=agent']);
	// Absolute: a chat session is started by the editor, not by a shell, so PATH is not an answer.
	assert.equal(declaration.command, 'C:/PiCode/resources/memory/engram.exe');
});

test('a declaration that works is never touched, and one that points nowhere is repaired', () => {
	const binary = 'C:/PiCode/resources/memory/engram.exe';
	const exists = (candidate: string) => candidate === 'C:/tools/engram.exe';

	assert.equal(engramDeclarationDecision(undefined, binary, exists), 'add');
	// Already ours.
	assert.equal(engramDeclarationDecision({ command: binary, args: ['mcp'] }, binary, exists), 'keep');
	// The owner's own binary, still on disk: theirs.
	assert.equal(engramDeclarationDecision({ command: 'C:/tools/engram.exe' }, binary, exists), 'keep');
	// The owner's own idea of memory over HTTP: not this product's to replace.
	assert.equal(engramDeclarationDecision({ type: 'http', url: 'http://127.0.0.1:9000/mcp' }, binary, exists), 'keep');
	// What an installation that moved leaves behind: a path that is not there.
	assert.equal(engramDeclarationDecision({ command: 'D:/Old/PiCode/resources/memory/engram.exe' }, binary, exists), 'update');
	// A local server with no command at all is the entry that leaves a chat without memory.
	assert.equal(engramDeclarationDecision({ args: ['mcp'] }, binary, exists), 'update');
});

test('only the declaration this product wrote can be taken away', () => {
	const binary = 'C:/PiCode/resources/memory/engram.exe';
	assert.equal(isOurEngramDeclaration({ command: binary, args: ['mcp', '--tools=agent'] }), true);
	assert.equal(isOurEngramDeclaration({ command: 'C:\\tools\\engram.exe', args: ['mcp', '--tools=agent'] }), true);

	// Somebody else's engine, or somebody else's set of tools: a switch that says "off" is not
	// allowed to delete a declaration this product never wrote.
	assert.equal(isOurEngramDeclaration({ command: 'C:/tools/other-binary.exe', args: ['mcp', '--tools=agent'] }), false);
	assert.equal(isOurEngramDeclaration({ command: binary, args: ['mcp', '--tools=all'] }), false);
	assert.equal(isOurEngramDeclaration({ command: binary, args: [] }), false);
	assert.equal(isOurEngramDeclaration({ command: binary }), false);
	assert.equal(isOurEngramDeclaration({ type: 'http', url: 'http://127.0.0.1:9000/mcp' }), false);
	assert.equal(isOurEngramDeclaration(undefined), false);
});