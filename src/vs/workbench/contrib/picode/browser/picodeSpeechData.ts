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
	/** How loud the microphone is right now, from 0 (nothing) to 1. */
	readonly level: number;
}

export function readPollAnswer(value: unknown): IPollAnswer {
	if (typeof value !== 'object' || value === null) {
		return { phrases: [], active: false, level: 0 };
	}
	const { events, active, level } = value as { events?: unknown; active?: unknown; level?: unknown };
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
	return { phrases, active: active === true, level: typeof level === 'number' && Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0 };
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

/**
 * The next words to show while a phrase is being heard. The recogniser hands over the phrase so far
 * in jumps; showing it word by word, a few at a time when far behind, reads like someone typing
 * instead of a block landing. Words the recogniser revised are swapped in place, never taken away
 * first, so the text does not shrink and grow back.
 */
export function revealStep(shown: readonly string[], target: readonly string[]): readonly string[] {
	let common = 0;
	while (common < shown.length && common < target.length && shown[common] === target[common]) {
		common++;
	}
	const behind = target.length - common;
	if (behind <= 0) {
		return target;
	}
	const step = Math.max(1, Math.ceil(behind / 4));
	return target.slice(0, Math.min(target.length, Math.max(shown.length, common + step)));
}
