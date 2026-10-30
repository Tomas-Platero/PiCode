/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the connector's dictation hands the chat, read without the editor's services.
 *
 * The connector answers a poll with whatever was heard since the last one. Anything that is not
 * a phrase with words in it is dropped here, so a malformed answer is silence and never an error
 * in the middle of someone's sentence.
 */

export interface IHeardPhrase {
	/** `partial`: the phrase so far, replaced by the next one. `final`: a closed phrase. */
	readonly kind: 'partial' | 'final';
	readonly text: string;
}

export interface IListenAnswer {
	readonly ok: boolean;
	readonly message?: string;
	/** Set when dictation is not on this computer yet, so the chat can offer to download it. */
	readonly needsDownload?: boolean;
}

export interface IPollAnswer {
	readonly phrases: readonly IHeardPhrase[];
	/** `false` once the recording has ended, including by reaching the time limit. */
	readonly active: boolean;
}

export function readPollAnswer(value: unknown): IPollAnswer {
	if (typeof value !== 'object' || value === null) {
		return { phrases: [], active: false };
	}
	const { events, active } = value as { events?: unknown; active?: unknown };
	const phrases: IHeardPhrase[] = [];
	if (Array.isArray(events)) {
		for (const event of events) {
			if (typeof event === 'object' && event !== null) {
				const { kind, text } = event as { kind?: unknown; text?: unknown };
				if ((kind === 'partial' || kind === 'final') && typeof text === 'string' && text.trim() !== '') {
					phrases.push({ kind, text: text.trim() });
				}
			}
		}
	}
	return { phrases, active: active === true };
}

export function readListenAnswer(value: unknown): IListenAnswer {
	if (typeof value !== 'object' || value === null) {
		return { ok: false, message: 'Dictation is not available right now.' };
	}
	const { ok, message, needsDownload } = value as { ok?: unknown; message?: unknown; needsDownload?: unknown };
	return {
		ok: ok === true,
		...(typeof message === 'string' ? { message } : {}),
		...(needsDownload === true ? { needsDownload: true } : {}),
	};
}
