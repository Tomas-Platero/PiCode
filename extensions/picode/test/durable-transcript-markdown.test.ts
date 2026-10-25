/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The transcript's markdown renderer, and the only thing that really matters about it: it must
 * never let model text become markup.
 *
 * `durable-transcript-markdown.ts` is pure (no `vscode`), so `node --test` runs it directly.
 * The hostile inputs below are the reason the file escapes before it renders: every one of them
 * is something a model can emit in an answer.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml, renderMarkdown } from '../src/durable-transcript-markdown.ts';

test('raw HTML from the model is escaped, not executed', () => {
	const html = renderMarkdown('<img src=x onerror=alert(1)>');
	assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), html);
	assert.ok(!html.includes('<img'), 'a tag was emitted');
	// The same for the characters that end an attribute: they are escaped too.
	assert.equal(escapeHtml(`"onmouseover='x'`), '&quot;onmouseover=&#39;x&#39;');
});

test('a javascript: link stays text: no anchor is created', () => {
	const html = renderMarkdown('[x](javascript:alert(1))');
	assert.ok(!html.includes('<a '), html);
	assert.ok(html.includes('[x](javascript:alert(1))'), html);
	// data: is not a link either.
	assert.ok(!renderMarkdown('[y](data:text/html;base64,PHNjcmlwdD4=)').includes('<a '));
});

test('an https link becomes a real anchor, with its target kept for the click handler', () => {
	const html = renderMarkdown('see [the docs](https://example.com/a?b=1)');
	assert.ok(html.includes('<a href="https://example.com/a?b=1"'), html);
	assert.ok(html.includes('data-href="https://example.com/a?b=1"'), html);
	assert.ok(html.includes('rel="noreferrer noopener"'), html);
	assert.ok(html.includes('>the docs</a>'), html);
});

test('a fenced code block keeps its content literal: no markdown inside', () => {
	const html = renderMarkdown('```js\n**not bold** and <b>tag</b>\n```');
	assert.ok(html.includes('<pre class="code"><code data-lang="js">'), html);
	assert.ok(html.includes('**not bold**'), 'the asterisks were interpreted');
	assert.ok(!html.includes('<strong>'), html);
	assert.ok(html.includes('&lt;b&gt;tag&lt;/b&gt;'), html);
});

test('inline code is literal too, even when it contains bold markers', () => {
	const html = renderMarkdown('run `**x**` now');
	assert.ok(html.includes('<code>**x**</code>'), html);
	assert.ok(!html.includes('<strong>'), html);
});

test('bold, italic, lists, headings and quotes are rendered from escaped text', () => {
	assert.ok(renderMarkdown('**bold**').includes('<strong>bold</strong>'));
	assert.ok(renderMarkdown('*soft*').includes('<em>soft</em>'));
	assert.ok(renderMarkdown('- one\n- two').includes('<ul><li>one</li><li>two</li></ul>'));
	assert.ok(renderMarkdown('1. one\n2. two').includes('<ol><li>one</li><li>two</li></ol>'));
	assert.ok(renderMarkdown('## Title').includes('<h2>Title</h2>'));
	assert.ok(renderMarkdown('> quoted').includes('<blockquote><p>quoted</p></blockquote>'));
	// Underscores are left alone on purpose: `some_file_name` is not italic.
	assert.ok(!renderMarkdown('some_file_name').includes('<em>'));
});

test('a placeholder character from the model cannot resurrect a code token', () => {
	const html = renderMarkdown('a\u0000b `code`');
	assert.ok(!html.includes('\u0000'), html);
	assert.ok(html.includes('<code>code</code>'), html);
});

test('a GFM table becomes a table, and every cell is escaped first', () => {
	const html = renderMarkdown('| what | how |\n| --- | --- |\n| <img src=x onerror=alert(1)> | plain |');
	assert.ok(html.startsWith('<table><thead><tr><th>what</th><th>how</th></tr></thead><tbody>'), html);
	assert.ok(html.includes('<td>&lt;img src=x onerror=alert(1)&gt;</td>'), html);
	assert.ok(!html.includes('<img'), 'a tag was emitted from a cell');
	assert.ok(html.includes('<td>plain</td>'), html);
});

test('a cell keeps an escaped pipe instead of splitting on it', () => {
	const html = renderMarkdown('| left | right |\n| --- | --- |\n| a \\| b | c |');
	assert.ok(html.includes('<tr><td>a | b</td><td>c</td></tr>'), html);
});

test('a table with no body rows is still a table', () => {
	const html = renderMarkdown('| one | two |\n| --- | --- |');
	assert.ok(html.includes('<thead><tr><th>one</th><th>two</th></tr></thead>'), html);
	assert.ok(html.includes('<tbody></tbody>'), html);
});

test('column alignment is read from the delimiter row, and a short row is padded', () => {
	const html = renderMarkdown('| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 |');
	assert.ok(html.includes('<th>a</th><th class="t-center">b</th><th class="t-right">c</th>'), html);
	assert.ok(html.includes('<tr><td>1</td><td class="t-center">2</td><td class="t-right"></td></tr>'), html);
});

test('a pipe with no delimiter row under it stays a sentence', () => {
	const html = renderMarkdown('the value is a | b');
	assert.ok(!html.includes('<table'), html);
	assert.ok(html.includes('<p>the value is a | b</p>'), html);
});
