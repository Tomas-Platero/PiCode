/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the model list says about price and images, run on its own (`node --test`).
 */

import assert from 'assert';
import { test } from 'node:test';
import { acceptsImages, formatPrice, modelPricing } from '../src/model-info.ts';

test('a priced model gets a readable label and the numbers behind it', () => {
	assert.deepStrictEqual(
		modelPricing({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }),
		{ pricing: '$3 in · $15 out per 1M tokens', inputCost: 3, outputCost: 15, cacheCost: 0.3, cacheWriteCost: 3.75 },
	);
});

test('small prices keep the digits that matter and no more', () => {
	assert.strictEqual(formatPrice(0.075), '$0.075');
	assert.strictEqual(formatPrice(0.25), '$0.25');
	assert.strictEqual(formatPrice(2.5), '$2.5');
	assert.strictEqual(formatPrice(15), '$15');
	assert.strictEqual(formatPrice(1.2345), '$1.23');
});

test('a model with no price in the catalogue has no price row, not a made-up "Free"', () => {
	assert.deepStrictEqual(modelPricing(undefined), {});
	assert.deepStrictEqual(modelPricing({}), {});
	assert.deepStrictEqual(modelPricing({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), {});
});

test('a half-known price says only the half it knows', () => {
	assert.deepStrictEqual(modelPricing({ output: 8 }), { pricing: '$8 out per 1M tokens', outputCost: 8 });
});

test('garbage in a price is ignored, never printed', () => {
	assert.deepStrictEqual(modelPricing({ input: -1, output: Number.NaN }), {});
	assert.deepStrictEqual(modelPricing({ input: '3' as unknown as number, output: 6 }), { pricing: '$6 out per 1M tokens', outputCost: 6 });
});

test('image support is what the catalogue lists', () => {
	assert.strictEqual(acceptsImages(['text', 'image']), true);
	assert.strictEqual(acceptsImages(['text']), false);
	assert.strictEqual(acceptsImages(undefined), false);
});
