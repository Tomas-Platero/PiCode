/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Network retries for pi's sign-in.
 *
 * A sign-in makes a few requests after the browser comes back (the code exchange, the account and
 * model lookups). Each uses the global `fetch`, and one dropped connection threw the whole sign-in
 * away after the person had already signed in. While a sign-in runs, `fetch` is wrapped so a
 * request that failed **before any answer arrived** is sent again, up to three more times.
 *
 * A failure with an answer (any HTTP status) is never retried: the server saw the request.
 */

const RETRIES = 3;
const FIRST_DELAY_MS = 700;

/** Node reports a connection that never got an answer as `TypeError: fetch failed` (undici). */
export function isNetworkFailure(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const cause = error.cause instanceof Error ? `${error.cause.message} ${(error.cause as { code?: string }).code ?? ''}` : '';
	return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR|socket hang up|network/i.test(`${error.message} ${cause}`);
}

/** The underlying reason, for the log: `fetch failed` alone says nothing. */
export function describeFailure(error: unknown): string {
	if (!(error instanceof Error)) {
		return String(error);
	}
	const cause = error.cause instanceof Error ? ` (cause: ${(error.cause as { code?: string }).code ?? ''} ${error.cause.message})` : '';
	return `${error.message}${cause}`;
}

let depth = 0;
let original: typeof fetch | undefined;

/** Runs `work` with `fetch` retrying network failures; nested calls share one wrapper. */
export async function withFetchRetry<T>(work: () => Promise<T>): Promise<T> {
	if (depth === 0) {
		original = globalThis.fetch;
		const base = original;
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			for (let attempt = 0; ; attempt += 1) {
				try {
					return await base(input, init);
				} catch (error) {
					if (init?.signal?.aborted || attempt >= RETRIES || !isNetworkFailure(error)) {
						console.error(`[PiCode sign-in] request failed: ${describeFailure(error)}`);
						throw error;
					}
					console.warn(`[PiCode sign-in] retrying after a network failure (${attempt + 1}/${RETRIES}): ${describeFailure(error)}`);
					await new Promise(resolve => setTimeout(resolve, FIRST_DELAY_MS * 2 ** attempt));
				}
			}
		}) as typeof fetch;
	}
	depth += 1;
	try {
		return await work();
	} finally {
		depth -= 1;
		if (depth === 0 && original !== undefined) {
			globalThis.fetch = original;
			original = undefined;
		}
	}
}
