/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Notices an extension sends to the chat that the product expects and does not show.
 *
 * gentle-pi tries to read the status of its review mode through a helper program it installs
 * next to itself. The product does not install that helper (`product-env.ts`: an install script
 * fetches nothing), so on every session gentle-pi says, in a yellow card with a path and an
 * environment variable in it, that the helper is missing. That is not news to the person using
 * the chat — it is how the product ships — and the card names internals, which the editor does
 * not put on screen. The notice is dropped here; the missing helper stays a plain fact in the
 * documentation (ADR-031) and the review operations that need it say so when they are used.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

/** Whether a notice only says that gentle-pi's helper program is not installed. */
export function isExpectedHelperNotice(message: string): boolean {
	return message.includes('package-local-binary-missing')
		|| /Gentle AI v\d+\.\d+\.\d+ is not installed at/.test(message);
}

/**
 * Whether a notice is gentle-pi's start-up housekeeping report ("applied saved model config to 6
 * agent(s). Global delegation/review assets ready: 10 new agent(s)…").
 *
 * It arrives at the top of a conversation, in bold, before the answer to the first question, and
 * it reports setup the person never asked about and cannot act on. The chat drops it; the same
 * facts stay visible where they belong (the agents and their models in the editor's settings).
 */
export function isStartupHousekeepingNotice(message: string): boolean {
	return /applied saved model config to \d+ agent/i.test(message)
		|| /delegation\/review assets ready/i.test(message);
}
