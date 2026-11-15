/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License. See License.txt
 *--------------------------------------------------------------------------------------------*/

/**
 * Which of the editor's tools pi is given, and what comes back from them, run on their own.
 *
 * What matters: the integrated browser's tools reach pi alongside the MCP ones, the MCP switch
 * only governs the MCP tools, the editor's other tools stay out (pi has its own), and a
 * screenshot arrives as an image pi can show the model rather than being dropped.
 */

import assert from 'assert';
import { test } from 'node:test';
import { editorTools, isBrowserTool, mcpTools, toolResultParts, toolResultText, toolSetSignature } from '../src/mcpTools.ts';

const editor = [
	{ name: 'mcp_github_search', description: 'Search GitHub.', inputSchema: { type: 'object', properties: {} } },
	{ name: 'open_browser_page', description: 'Open a page.', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
	{ name: 'screenshot_page', description: 'Take a screenshot.', inputSchema: { type: 'object', properties: {} } },
	{ name: 'list_browser_pages', description: 'Not for models.' },
	{ name: 'copilot_readFile', description: 'Editor file tool.' },
];

test('the browser tools are recognised by their editor ids, and nothing else is', () => {
	assert.strictEqual(isBrowserTool({ name: 'open_browser_page' }), true);
	assert.strictEqual(isBrowserTool({ name: 'run_playwright_code' }), true);
	assert.strictEqual(isBrowserTool({ name: 'list_browser_pages' }), false);
	assert.strictEqual(isBrowserTool({ name: 'copilot_readFile' }), false);
});

test('pi gets the MCP tools and the browser tools, and none of the editor\'s other tools', () => {
	assert.deepStrictEqual(
		editorTools(editor, { mcp: true }).map(tool => tool.name),
		['mcp_github_search', 'open_browser_page', 'screenshot_page'],
	);
});

test('turning MCP off keeps the browser tools', () => {
	assert.deepStrictEqual(
		editorTools(editor, { mcp: false }).map(tool => tool.name),
		['open_browser_page', 'screenshot_page'],
	);
});

test('the browser tools keep their schema and description', () => {
	const open = editorTools(editor, { mcp: false })[0];
	assert.strictEqual(open.description, 'Open a page.');
	assert.deepStrictEqual(open.parameters, { type: 'object', properties: { url: { type: 'string' } } });
});

test('the MCP list on its own is unchanged', () => {
	assert.deepStrictEqual(mcpTools(editor).map(tool => tool.name), ['mcp_github_search']);
});

test('the signature changes when the browser tools come and go', () => {
	const withBrowser = toolSetSignature(editorTools(editor, { mcp: true }));
	const without = toolSetSignature(editorTools(editor.filter(tool => !isBrowserTool(tool)), { mcp: true }));
	assert.notStrictEqual(withBrowser, without);
});

test('a screenshot comes back as an image, next to the text', () => {
	const parts = toolResultParts([
		{ value: 'Page 1' },
		{ mimeType: 'image/jpeg', data: new Uint8Array([1, 2, 3]) },
	]);
	assert.deepStrictEqual(parts, [
		{ type: 'text', text: 'Page 1' },
		{ type: 'image', mimeType: 'image/jpeg', data: Buffer.from([1, 2, 3]).toString('base64') },
	]);
});

test('a result with no text and no image still answers with an empty text', () => {
	assert.deepStrictEqual(toolResultParts([]), [{ type: 'text', text: '' }]);
});

test('non-image data is written out as text, not lost', () => {
	assert.deepStrictEqual(
		toolResultParts([{ mimeType: 'application/json', data: new TextEncoder().encode('{"a":1}') }]),
		[{ type: 'text', text: '{"a":1}' }],
	);
});

test('the text view of a result is unchanged', () => {
	assert.strictEqual(toolResultText([{ value: 'a' }, 'b', { value: { x: 1 } }]), 'a\nb\n{"x":1}');
});
