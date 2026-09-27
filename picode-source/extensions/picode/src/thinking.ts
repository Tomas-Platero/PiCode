/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * pi's thinking, written as a quoted block in the chat.
 *
 * The chat appends what a participant streams, and it appends it **as it arrives**: pi sends its
 * thinking in tokens, so each delta is a few characters. A quote therefore cannot be prefixed
 * blindly — `> The` followed by `> user` renders as `> The> user`, which is exactly how this
 * looked the first time. The marker belongs where a line *starts* and nowhere else.
 *
 * So this module keeps the one bit of state that decides it: whether the next character opens a
 * line. Small, and worth its own home, because getting it wrong is visible on screen and can be
 * exercised by running it.
 */

/** The line that opens the block, emitted once and before the first delta. */
export const THINKING_HEADER = '\n> **Thinking**\n>\n';

/** One delta, quoted for the position it arrives in. */
export interface QuotedDelta {
	/** What to append, exactly as the chat should receive it. */
	readonly text: string;
	/** Whether the **next** delta opens a line. */
	readonly atLineStart: boolean;
}

/**
 * Quotes one delta.
 *
 * A delta that is the only thing on the line gets the marker; a delta that continues a line is
 * appended as it came, which is what joins a word to the word before it.
 */
export function quotedThinking(delta: string, atLineStart: boolean): QuotedDelta {
	const lines = delta.split('\n');
	const quoted = lines
		.map((line, index) => (index === 0 && !atLineStart ? line : `> ${line}`))
		.join('\n');
	return { text: quoted, atLineStart: lines[lines.length - 1].length === 0 };
}
