/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Asking a provider what models it has.
 *
 * A provider's own list is the only list worth having: an endpoint that answers knows its own
 * catalogue, the owner does not, and a hand-written list goes stale the day the provider adds a
 * model. So the endpoint is asked, and what it answers is what gets written.
 *
 * This module has no `vscode` import on purpose. Nothing here decides anything about the
 * editor, and keeping it out means the two shapes an endpoint can answer with — and the
 * refusal to invent a list when it answers with neither — can be exercised by running them.
 */

import { isRecord } from './declarations';

/**
 * The model ids an endpoint answers with.
 *
 * Two shapes are accepted because both are found in the wild and neither is wrong: the
 * documented `{ data: [{ id }] }` and a plain `{ models: [{ id }] }`. Anything else yields an
 * empty list rather than a guess — a made-up model id would be a row in the editor that fails
 * the moment it is used.
 */
export function parseModelIds(payload: unknown): string[] {
	const list = isRecord(payload)
		? Array.isArray(payload.data)
			? payload.data
			: Array.isArray(payload.models)
				? payload.models
				: undefined
		: undefined;
	if (list === undefined) {
		return [];
	}
	const ids: string[] = [];
	for (const entry of list) {
		const id = typeof entry === 'string' ? entry : isRecord(entry) ? entry.id : undefined;
		if (typeof id === 'string' && id.length > 0) {
			ids.push(id);
		}
	}
	// Sorted and deduplicated, so the file does not depend on the endpoint's mood.
	return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

/**
 * Asks the endpoint for its own model list.
 *
 * A failure is returned as `undefined` and never thrown at the caller: an endpoint that does
 * not answer is a fact to tell the owner about, not a reason to stop serving the models the
 * profile already has.
 */
export async function fetchModelIds(baseUrl: string, apiKey: string | undefined): Promise<string[] | undefined> {
	try {
		const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
			headers: apiKey === undefined || apiKey.length === 0 ? {} : { authorization: `Bearer ${apiKey}` },
		});
		if (!response.ok) {
			return undefined;
		}
		return parseModelIds(await response.json());
	} catch {
		return undefined;
	}
}
