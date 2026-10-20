/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What pi is doing, said in one line.
 *
 * The chat shows a progress line while a tool runs, and "read" says much less than
 * "read src/app.ts". The arguments are already there in the event, so the line is built from
 * them — but carefully: a progress line is a hint, not a transcript, so each tool contributes
 * the one argument that identifies what it is working on, and anything unexpected is dropped
 * rather than rendered as `[object Object]`.
 *
 * No `vscode` import: it is wording, and wording can be exercised by running it.
 */

/** The fields a tool's arguments may carry, tried in this order for each tool. */
function firstString(args: unknown, keys: readonly string[]): string | undefined {
	if (typeof args !== 'object' || args === null) {
		return undefined;
	}
	const record = args as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

/** The argument that identifies the work, per tool; tools pi adds later fall through to none. */
const IDENTIFYING_ARGUMENT: Readonly<Record<string, readonly string[]>> = {
	read: ['path', 'file_path', 'filePath'],
	write: ['path', 'file_path', 'filePath'],
	edit: ['path', 'file_path', 'filePath'],
	ls: ['path'],
	find: ['pattern', 'path'],
	grep: ['pattern', 'query'],
	bash: ['command'],
	powershell: ['command'],
};

/** The longest a single argument is shown: a progress line is not a place for a whole command. */
const MAX_ARGUMENT_CHARS = 80;

/**
 * One line for the chat, built from the tool's name and its arguments.
 *
 * A tool with no identifying argument keeps its bare name: a blank after it would look like the
 * line failed to load.
 */
export function toolProgress(toolName: string, args: unknown): string {
	const keys = IDENTIFYING_ARGUMENT[toolName];
	const argument = keys === undefined ? undefined : firstString(args, keys);
	if (argument === undefined) {
		return toolName;
	}
	const shown = argument.length > MAX_ARGUMENT_CHARS ? `${argument.slice(0, MAX_ARGUMENT_CHARS - 1)}…` : argument;
	return `${toolName} ${shown}`;
}

/**
 * How much of a call and of its answer a tool card keeps.
 *
 * The card is a way back to what the agent did, not a copy of the conversation: a read of a whole
 * file or a command's full output would bury the answer the chat is actually about. The tail of a
 * long output is dropped with a note, so nobody mistakes a cut card for the whole thing.
 */
const MAX_INPUT_CHARS = 2000;
const MAX_OUTPUT_CHARS = 4000;

/** A capped block of text, saying where it was cut. */
function capped(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	const dropped = text.length - max;
	return `${text.slice(0, max)}\n… ${dropped} more characters`;
}

/**
 * A call's arguments, as the card shows them: readable JSON when they are an object.
 *
 * They arrive parsed when the caller is the one that made the call and serialised when they have
 * crossed a boundary, so a JSON string is pretty-printed rather than shown as one long line.
 */
export function toolInputText(args: unknown): string {
	if (args === undefined || args === null) {
		return '';
	}
	if (typeof args === 'string') {
		try {
			return capped(JSON.stringify(JSON.parse(args), null, 2), MAX_INPUT_CHARS);
		} catch {
			return capped(args, MAX_INPUT_CHARS);
		}
	}
	try {
		return capped(JSON.stringify(args, null, 2) ?? String(args), MAX_INPUT_CHARS);
	} catch {
		return capped(String(args), MAX_INPUT_CHARS);
	}
}

/** One text out of a content part, whatever shape the part has. */
function partText(part: unknown): string | undefined {
	if (typeof part === 'string') {
		return part;
	}
	if (typeof part !== 'object' || part === null) {
		return undefined;
	}
	const record = part as Record<string, unknown>;
	for (const key of ['text', 'value', 'content']) {
		const value = record[key];
		if (typeof value === 'string') {
			return value;
		}
	}
	return JSON.stringify(part);
}

/**
 * What a tool answered, as the card shows it.
 *
 * pi delivers a result as content parts (`{ text }`, and the editor's own tools as
 * `{ value }`), so the parts are read in that order; anything else is written out rather than
 * dropped, because a card that says nothing reads as a tool that did nothing.
 */
export function toolOutputText(result: unknown): string {
	if (result === undefined || result === null) {
		return '';
	}
	if (typeof result === 'string') {
		return capped(result, MAX_OUTPUT_CHARS);
	}
	if (typeof result === 'object') {
		const content = (result as Record<string, unknown>)['content'];
		if (Array.isArray(content)) {
			const pieces = content.map(partText).filter((piece): piece is string => piece !== undefined);
			return capped(pieces.join('\n'), MAX_OUTPUT_CHARS);
		}
	}
	try {
		return capped(JSON.stringify(result, null, 2) ?? String(result), MAX_OUTPUT_CHARS);
	} catch {
		return capped(String(result), MAX_OUTPUT_CHARS);
	}
}
