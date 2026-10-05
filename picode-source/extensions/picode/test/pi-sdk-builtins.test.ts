/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * pi's built-in extensions, as the chat's session must receive them.
 *
 * The chat's session used to pass only its own permission gate as `extensionFactories`, and pi
 * builds its built-in map **from the factories the caller passed** — so the chat's session had no
 * built-in extension at all: `builtin:mcp` could not resolve, the profile's MCP servers were never
 * connected, and the host guard warned "MCP connector: MISSING". pi's own CLI does the opposite
 * (`dist/main.js:451`): its built-in list first, the caller's factories after. These tests pin the
 * two pieces the chat needs to do the same without hand-copying a list that would go stale:
 * deriving the built-in module's path from the SDK entry that was actually loaded, and taking the
 * entries pi really ships from that module.
 */

import assert from 'assert';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { builtinsModuleOf, piBuiltinExtensions } from '../src/piSdk.ts';

test("the built-in module lives beside the SDK entry, in pi's own layout", () => {
	assert.strictEqual(
		builtinsModuleOf('D:/app/pi-coding-agent/dist/index.js'),
		path.join('D:/app/pi-coding-agent/dist', 'extensions', 'index.js'),
	);
});

test('the derivation also holds for the Windows separators pi is loaded with here', () => {
	assert.strictEqual(
		builtinsModuleOf('D:\\app\\pi-coding-agent\\dist\\index.js'),
		path.join('D:\\app\\pi-coding-agent\\dist', 'extensions', 'index.js'),
	);
});

test('the entries pi ships are taken as they are, with their built-in mark', () => {
	const factory = () => undefined;
	const read = piBuiltinExtensions({
		builtInExtensions: [
			{ name: 'mcp', factory, replaceable: true, builtin: true },
			{ name: 'codemode', factory, replaceable: true, builtin: true },
		],
	});

	assert.deepStrictEqual(read.builtins, [
		{ name: 'mcp', factory, replaceable: true, builtin: true },
		{ name: 'codemode', factory, replaceable: true, builtin: true },
	]);
	assert.deepStrictEqual(read.skipped, []);
});

test('an entry without the built-in mark is not a built-in: pi would ignore it, so does the reader', () => {
	const factory = () => undefined;
	const read = piBuiltinExtensions({
		builtInExtensions: [
			{ name: 'plain', factory },
			{ name: 'mcp', factory, builtin: true },
		],
	});

	assert.deepStrictEqual(read.builtins.map(builtin => builtin.name), ['mcp']);
	assert.strictEqual(read.skipped.length, 1);
	assert.ok(read.skipped[0].includes('plain'), read.skipped[0]);
});

test('a module without the list, or not a module at all, yields nothing and says why', () => {
	assert.deepStrictEqual(piBuiltinExtensions({}).builtins, []);
	assert.deepStrictEqual(piBuiltinExtensions(undefined).builtins, []);
	assert.deepStrictEqual(piBuiltinExtensions('mcp').builtins, []);
	assert.ok(piBuiltinExtensions(undefined).skipped.length > 0);
});

/**
 * The pinned runtime on this machine, when it is here. The proof that the reader reads the module
 * pi **really** ships — that `mcp` is among them and every entry carries the built-in mark — needs
 * no editor, only the install a development checkout has next to it.
 */
const pinnedRuntime = path.join(
	fileURLToPath(new URL('../../../..', import.meta.url)),
	'PiCode-win32-x64 - experimental', 'resources', 'pi-runtime', 'node_modules',
	'@earendil-works', 'pi-coding-agent', 'dist', 'extensions', 'index.js',
);

test('the pinned pi ships mcp, codemode, tool-search and llama.cpp as built-ins', { skip: !existsSync(pinnedRuntime) }, async () => {
	const loaded = await import(pathToFileURL(pinnedRuntime).href);
	const read = piBuiltinExtensions(loaded);

	assert.deepStrictEqual(read.builtins.map(builtin => builtin.name).sort(), ['codemode', 'llama.cpp', 'mcp', 'tool-search']);
	for (const builtin of read.builtins) {
		assert.strictEqual(builtin.builtin, true, builtin.name);
		assert.strictEqual(typeof builtin.factory, 'function', builtin.name);
	}
});
