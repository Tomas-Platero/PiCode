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
