/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The `models.json` merge, run on its own.
 *
 * `mergeModelsFile` is the only thing in PiCode that rewrites pi's `models.json`, and pi 1.0.2
 * added a per-model field to that file (`samplingParamsByThinkingLevel`; 1.0.2's changelog is
 * nothing else). The bridge's draft only names `id` and `name`, so the check that matters is
 * that a field it does not name — a per-model setting written by hand or by a newer pi — survives
 * the projection instead of being dropped on the next connect.
 *
 * `node --test` runs this file directly (Node's own type stripping); `declarations.ts` imports
 * only `node:fs`, `node:path` and a type, so it loads without an editor.
 */

import assert from 'assert';
import { test } from 'node:test';
import { mergeModelsFile, type ModelDraft } from '../src/declarations.ts';

const EXISTING = {
	providers: {
		omni: {
			baseUrl: 'https://old.example/v1',
			api: 'openai-completions',
			apiKey: '$OMNI_KEY',
			models: [
				{
					id: 'm1',
					name: 'M One',
					contextWindow: 200_000,
					samplingParamsByThinkingLevel: { high: { temperature: 0.2 } },
				},
				{ id: 'm2', name: 'M Two' },
			],
		},
		other: { baseUrl: 'https://other.example/v1', api: 'openai-completions', models: [{ id: 'x' }] },
	},
};

test('mergeModelsFile keeps a per-model field the draft does not name (pi 1.0.2 samplingParamsByThinkingLevel)', () => {
	const models: ModelDraft[] = [{ id: 'm1', name: 'M One' }, { id: 'm3' }];
	const merged = mergeModelsFile(EXISTING, { id: 'omni', baseUrl: 'https://new.example/v1', api: 'openai-completions' }, models);
	const provider = (merged['providers'] as Record<string, Record<string, unknown>>)['omni'];
	assert.strictEqual(provider['baseUrl'], 'https://new.example/v1');

	const mergedModels = provider['models'] as Array<Record<string, unknown>>;
	assert.deepStrictEqual(mergedModels, [
		{
			id: 'm1',
			name: 'M One',
			contextWindow: 200_000,
			samplingParamsByThinkingLevel: { high: { temperature: 0.2 } },
		},
		{ id: 'm3' },
	]);
});

test('mergeModelsFile keeps the previous key and the other providers, and replaces what the draft names', () => {
	const merged = mergeModelsFile(EXISTING, { id: 'omni', baseUrl: 'https://new.example/v1', api: 'openai-completions' }, [{ id: 'm1' }]);
	const providers = merged['providers'] as Record<string, Record<string, unknown>>;
	assert.strictEqual(providers['omni']['apiKey'], '$OMNI_KEY');
	assert.deepStrictEqual(providers['other'], EXISTING.providers.other);
	// A model the draft no longer names is gone: the provider's own list is authoritative for
	// which models it exposes.
	assert.deepStrictEqual((providers['omni']['models'] as Array<Record<string, unknown>>).map(model => model['id']), ['m1']);
});

test('mergeModelsFile writes a fresh provider when there is nothing on disk', () => {
	const merged = mergeModelsFile(undefined, { id: 'omni', baseUrl: 'https://e', api: 'openai-completions', authHeader: true }, [{ id: 'm1' }]);
	assert.deepStrictEqual(merged, {
		providers: {
			omni: { baseUrl: 'https://e', api: 'openai-completions', authHeader: true, models: [{ id: 'm1' }] },
		},
	});
});
