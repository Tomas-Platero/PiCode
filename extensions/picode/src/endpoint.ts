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
/**
 * What one request to an endpoint's model list found out.
 *
 * Answering with a reason and a duration, rather than `undefined`, is the difference between
 * "it did not work" and something the owner can act on: a refused key, an empty balance, an
 * address that is not an API, a machine with no network. All four used to collapse into the
 * same silence.
 */
export interface EndpointProbe {
	readonly ok: boolean;
	/** The HTTP status, when the address answered at all. */
	readonly status?: number;
	/** How long the round trip took, in milliseconds. Measured, never estimated. */
	readonly latencyMs: number;
	readonly models: readonly string[];
	/** A sentence for a person: what went wrong and what to change. */
	readonly error?: string;
}

/** The sentence for a status the endpoint answered with. */
function refusalOf(status: number): string {
	if (status === 401 || status === 403) {
		return 'the key was refused';
	}
	if (status === 402) {
		return 'the account has no credit left';
	}
	if (status === 404) {
		return 'that address has no model list — check it ends in /v1 when it should';
	}
	if (status === 429) {
		return 'too many requests right now';
	}
	return `the address answered ${status}`;
}

/**
 * Asks an endpoint what it has, and says how it went.
 *
 * The model list is the test: a key that cannot list models cannot run one either, so this is
 * the same request the provider projection needs, timed and explained. Nothing is invented — an
 * address that answers with a shape this does not recognise yields no models and says so.
 */
export async function probeEndpoint(baseUrl: string, apiKey: string | undefined, timeoutMs = 20_000): Promise<EndpointProbe> {
	const started = Date.now();
	const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
	const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);
	const stop = (): number => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		return Date.now() - started;
	};
	try {
		const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
			headers: apiKey === undefined || apiKey.length === 0 ? {} : { authorization: `Bearer ${apiKey}` },
			...(controller === undefined ? {} : { signal: controller.signal }),
		});
		const latencyMs = stop();
		if (!response.ok) {
			return { ok: false, status: response.status, latencyMs, models: [], error: refusalOf(response.status) };
		}
		const models = parseModelIds(await response.json());
		if (models.length === 0) {
			return { ok: false, status: response.status, latencyMs, models: [], error: 'the address answered no models' };
		}
		return { ok: true, status: response.status, latencyMs, models };
	} catch (error) {
		const latencyMs = stop();
		const timedOut = error instanceof Error && error.name === 'AbortError';
		return {
			ok: false,
			latencyMs,
			models: [],
			error: timedOut ? `no answer within ${Math.round(timeoutMs / 1000)} s` : 'the address could not be reached',
		};
	}
}

export async function fetchModelIds(baseUrl: string, apiKey: string | undefined): Promise<string[] | undefined> {
	const probe = await probeEndpoint(baseUrl, apiKey);
	return probe.ok ? [...probe.models] : undefined;
}
