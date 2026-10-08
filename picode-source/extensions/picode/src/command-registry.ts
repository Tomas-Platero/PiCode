/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * pi's command registry, read out of a session's extension runner.
 *
 * vscode-free, the way every rule the tests run is kept: which commands a session holds
 * and what their arguments look like are data questions, and `node --test` runs this file
 * directly. The editor half — the prompt files the chat's slash list is built from —
 * lives in `commands.ts`.
 */

/**
 * One pi command, as the chat's slash list shows it.
 *
 * `argumentHint` is pi's own argument surface, read from the command's
 * `getArgumentCompletions('')` — the same call the TUI makes after a space. The chat's
 * prompt-file API cannot offer per-keystroke completions (see `commands.ts`), but the
 * editor does show a prompt file's `argument-hint` front matter as a placeholder once a
 * space follows the command, so the top-level options travel that way.
 */
export interface PiCommand {
	readonly name: string;
	readonly description?: string;
	readonly argumentHint?: string;
}

/** The longest argument hint written into a command's prompt file; the rest is trimmed. */
export const COMMAND_ARGUMENT_HINT_LIMIT = 120;

/** A record from an unknown value, or `undefined` when it is not one. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

/**
 * The top-level argument options of one registered command, read from its own
 * `getArgumentCompletions` with the empty prefix — the first completion round the TUI
 * shows after a space.
 *
 * Only **synchronous** results are used: the slash listing runs on the extension host and
 * must never await an arbitrary extension's promise, and a completion provider that is
 * still loading simply contributes no hint. pi's own commands (`/mcp` and friends) answer
 * synchronously. A provider that throws or returns nothing contributes nothing — a hint is
 * decoration, never worth failing a listing over.
 */
export function piArgumentHintOf(command: unknown): string | undefined {
	const record = recordOf(command);
	const getCompletions = record?.['getArgumentCompletions'];
	if (typeof getCompletions !== 'function') {
		return undefined;
	}
	let result: unknown;
	try {
		result = getCompletions('');
	} catch {
		return undefined;
	}
	if (!Array.isArray(result)) {
		return undefined;
	}
	const options: string[] = [];
	for (const item of result) {
		const itemRecord = recordOf(item);
		const label = typeof itemRecord?.['label'] === 'string' && itemRecord['label'].trim().length > 0
			? itemRecord['label'].trim()
			: typeof itemRecord?.['value'] === 'string' && itemRecord['value'].trim().length > 0
				? itemRecord['value'].trim()
				: undefined;
		if (label !== undefined) {
			options.push(label);
		}
	}
	const deduped = [...new Set(options)];
	if (deduped.length === 0) {
		return undefined;
	}
	let hint = deduped.join(' | ');
	if (hint.length > COMMAND_ARGUMENT_HINT_LIMIT) {
		hint = `${hint.slice(0, COMMAND_ARGUMENT_HINT_LIMIT)}…`;
	}
	return `[${hint}]`;
}

/**
 * The commands a pi session's extension runner holds, read structurally.
 *
 * pi's registered commands carry `name` (pi's own, deduplicated `invocationName` when two
 * extensions register the same name) plus the description and the argument-completion
 * provider the TUI uses. What comes back here is exactly what the session holds — pi's
 * built-in extensions register through the same runner as the installed ones, so `/mcp`
 * and its fellow built-ins are in the list as long as the session loaded them.
 */
export function piCommandsOfRunner(piSession: unknown): readonly PiCommand[] {
	const runner = (piSession as { extensionRunner?: { getRegisteredCommands?: () => unknown } } | undefined)?.extensionRunner;
	if (typeof runner?.getRegisteredCommands !== 'function') {
		return [];
	}
	try {
		const registered = runner.getRegisteredCommands();
		if (!Array.isArray(registered)) {
			return [];
		}
		return registered.flatMap(command => {
			const record = recordOf(command);
			const name = typeof record?.['name'] === 'string' && record['name'].length > 0
				? record['name']
				: typeof record?.['invocationName'] === 'string' && record['invocationName'].length > 0 ? record['invocationName'] : undefined;
			if (name === undefined) {
				return [];
			}
			const description = typeof record?.['description'] === 'string' && record['description'].length > 0 ? record['description'] : undefined;
			const argumentHint = piArgumentHintOf(command);
			return [{
				name,
				...(description === undefined ? {} : { description }),
				...(argumentHint === undefined ? {} : { argumentHint }),
			} satisfies PiCommand];
		});
	} catch {
		return [];
	}
}

/** A file name a command's prompt file can carry. */
export function fileNameOf(command: PiCommand): string {
	return `${command.name.replace(/[^\p{L}\d_.-]+/gu, '-')}.prompt.md`;
}

/** The text of one command's prompt file: front matter for the description and arguments, one line of body. */
export function promptFileText(command: PiCommand): string {
	const description = (command.description ?? `pi's /${command.name} command`).replace(/\s+/g, ' ');
	const hint = command.argumentHint === undefined ? '' : `argument-hint: ${command.argumentHint}\n`;
	return `---\ndescription: ${description}\n${hint}---\n\nThe message text reaches pi as its /${command.name} command, with any arguments typed after it.\n`;
}
