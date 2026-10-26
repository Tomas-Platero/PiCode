/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the editor's model list says about a model beyond its name: what it costs and whether it
 * reads images.
 *
 * pi's catalogue carries both (`cost` in US dollars per million tokens, `input` the kinds of
 * content the model accepts). Nothing here is invented: a model whose catalogue entry says no
 * price has no price row at all, rather than a "Free" the catalogue never claimed — a zero can mean
 * free, included in a plan, or simply unknown.
 *
 * No `vscode` import and no local imports, so the rules can be exercised by running them.
 */

/** A model's price as pi's catalogue writes it: US dollars per million tokens. */
export interface PiModelCost {
	readonly input?: number;
	readonly output?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
}

/** The fields the editor's model list reads for a price (`languageModelPricing`). */
export interface ModelPricing {
	readonly pricing?: string;
	readonly inputCost?: number;
	readonly outputCost?: number;
	readonly cacheCost?: number;
	readonly cacheWriteCost?: number;
}

function amount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A price in dollars, in as few digits as keep it true: `3`, `0.25`, `0.075`. */
export function formatPrice(dollars: number): string {
	const digits = dollars >= 1 ? 2 : 3;
	return `$${Number(dollars.toFixed(digits))}`;
}

/**
 * The price fields for one model, or none when the catalogue has no price for it.
 *
 * The label is for people (`$3 in · $15 out per 1M tokens`); the numbers are there for the lists
 * that sort or show them in columns.
 */
export function modelPricing(cost: PiModelCost | undefined): ModelPricing {
	const input = amount(cost?.input);
	const output = amount(cost?.output);
	if ((input ?? 0) === 0 && (output ?? 0) === 0) {
		return {};
	}
	const cacheRead = amount(cost?.cacheRead);
	const cacheWrite = amount(cost?.cacheWrite);
	const parts = [
		...(input === undefined ? [] : [`${formatPrice(input)} in`]),
		...(output === undefined ? [] : [`${formatPrice(output)} out`]),
	];
	return {
		pricing: `${parts.join(' · ')} per 1M tokens`,
		...(input === undefined ? {} : { inputCost: input }),
		...(output === undefined ? {} : { outputCost: output }),
		...(cacheRead === undefined || cacheRead === 0 ? {} : { cacheCost: cacheRead }),
		...(cacheWrite === undefined || cacheWrite === 0 ? {} : { cacheWriteCost: cacheWrite }),
	};
}

/** Whether the catalogue says the model accepts images. */
export function acceptsImages(input: readonly unknown[] | undefined): boolean {
	return Array.isArray(input) && input.includes('image');
}
