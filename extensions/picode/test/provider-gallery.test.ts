/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// Exercise the actual gallery method with a minimal host, without opening an editor window.
const source = readFileSync(new URL('../../../src/vs/workbench/contrib/picode/browser/picodeProvidersModelsSection.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('gallery.ts', source, ts.ScriptTarget.Latest, true);
const owner = file.statements.find(ts.isClassDeclaration)!;
const method = owner.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(file) === 'paintProviderList')!;
const javascript = ts.transpileModule(`class Gallery { ${method.getText(file)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const Gallery = new Function('append', '$', 'clearNode', 'localize', 'Codicon', `${javascript}; return Gallery;`)(
	() => ({}), () => ({}), () => {}, (_key: string, value: string) => value,
	{ warning: {}, check: {}, account: {}, key: {} },
);

function draw(query: string, active?: string) {
	const rows: string[] = [];
	const gallery = new Gallery();
	Object.assign(gallery, {
		body: { querySelector: () => ({ querySelector: () => null }) },
		listStore: { clear() {} }, providerQuery: query, profileLoaded: true,
		catalog: [{ id: 'provider', name: 'Provider', note: 'special plan', oauth: true, apiKey: true, needsAttention: true }],
		profileProviders: [{ id: 'provider', credential: true, models: true }],
		providers: () => [], authState: active ? { providerId: active, phase: 'starting' } : undefined,
		paintSectionTitle: (_list: unknown, title: string) => rows.push(title),
		paintTile: (_grid: unknown, _entry: unknown, method: string) => rows.push(`tile:${method}`),
		paintConnectedCard: () => rows.push('connected'),
	});
	gallery.paintProviderList();
	return rows;
}

test('a failed credential found by its note never appears connected', () => {
	assert.deepEqual(draw('special plan'), ['Needs attention', 'tile:oauth']);
});

test('a dual-method failed credential defaults to OAuth and its active flow stays visible', () => {
	assert.deepEqual(draw(''), ['Needs attention', 'tile:oauth']);
	assert.deepEqual(draw('', 'provider'), ['Sign in with your account', 'tile:oauth']);
});
