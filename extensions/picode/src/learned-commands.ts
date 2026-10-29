/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The terminal-only commands the chat learns by itself.
 *
 * `TERMINAL_ONLY_COMMANDS` (`chat-commands.ts`) is the list measured by hand. A package installed
 * or updated later can bring a command that only works in pi's terminal, and it would sit in the
 * slash list looking usable. So every slash command the chat runs is watched: one that answers with
 * pi's "this needs the TUI" kind of notice, or that shows nothing at all, is remembered as
 * terminal-only — answered with a sentence and left out of the slash list from then on.
 *
 * What is remembered is tied to the file the command comes from (its path and modification time):
 * when the package is updated the file changes, the memory is dropped, and the command gets a
 * fresh chance — the new version may well work in the editor.
 *
 * vscode-free, like the other rules the tests run: the storage is a `Memento`-shaped object and
 * the file's fingerprint is passed in.
 */

/** The storage the remembered commands live in (`ExtensionContext.globalState`). */
export interface LearnedCommandsStorage {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

/** One remembered command: where it came from when it was judged, and what it said. */
export interface LearnedCommand {
	readonly fingerprint: string;
	readonly message?: string;
}

/** The global-state key, one record for the whole editor. */
export const LEARNED_COMMANDS_KEY = 'picode.chat.terminalOnlyCommands';

/** The longest notice kept as the reason, so a runaway message is not stored whole. */
const MESSAGE_LIMIT = 300;

/**
 * Whether a notice an extension raised means "this command needs pi's terminal".
 *
 * Only a notice with no way forward counts: `/btw` says it «cannot open its composer outside Pi's
 * TUI. Pass the question inline instead.» — and with the question inline it works, so a notice
 * that offers an alternative (instead, inline, usage) is not a verdict.
 */
export function isTerminalOnlyNotice(message: string): boolean {
	const text = message.replace(/\s+/g, ' ');
	const needsTerminal = /\bTUI\b|\binteractive (?:Pi )?terminal\b|\bterminal (?:mode|UI)\b/i.test(text)
		&& /\b(?:requires?|needs?|only|outside|unavailable|not available|cannot|can't)\b/i.test(text);
	const offersAWay = /\binstead\b|\binline\b|\busage\b|\bpass (?:the|a|an)\b/i.test(text);
	return needsTerminal && !offersAWay;
}

/** What a slash command did in the chat, as the turn saw it. */
export interface CommandRun {
	/** The arguments it was given; a command given some is never judged by its silence. */
	readonly args: string;
	/** The notices it raised, in order. */
	readonly notices: readonly string[];
	/** Whether anything reached the person: a notice, a question, a panel, an agent run. */
	readonly shownSomething: boolean;
}

/**
 * The verdict on one run: the reason it is terminal-only, or `undefined` when it worked.
 *
 * A notice saying it needs the TUI is the verdict. Silence is too, but only for a command run with
 * no arguments: run bare, a command that works shows something — and a bare command that showed
 * nothing is exactly what the person saw as "it does nothing".
 */
export function terminalOnlyVerdict(run: CommandRun): { readonly message?: string } | undefined {
	const notice = run.notices.find(isTerminalOnlyNotice);
	if (notice !== undefined) {
		return { message: notice.trim().slice(0, MESSAGE_LIMIT) };
	}
	if (!run.shownSomething && run.args.trim().length === 0) {
		return {};
	}
	return undefined;
}

/** The remembered commands, read and written through the storage. */
export class LearnedCommands {
	private readonly storage: LearnedCommandsStorage;
	/** The fingerprint of the file a command comes from, as it is now. */
	private readonly fingerprintOf: (source: string | undefined) => string;

	constructor(storage: LearnedCommandsStorage, fingerprintOf: (source: string | undefined) => string) {
		this.storage = storage;
		this.fingerprintOf = fingerprintOf;
	}

	private record(): Record<string, LearnedCommand> {
		const value = this.storage.get<unknown>(LEARNED_COMMANDS_KEY);
		return typeof value === 'object' && value !== null ? value as Record<string, LearnedCommand> : {};
	}

	/** What is remembered for this command, when it still comes from the same file. */
	get(name: string, source: string | undefined): LearnedCommand | undefined {
		const entry = this.record()[name];
		return entry !== undefined && typeof entry.fingerprint === 'string' && entry.fingerprint === this.fingerprintOf(source) ? entry : undefined;
	}

	/** Whether the command is remembered as terminal-only. */
	has(name: string, source: string | undefined): boolean {
		return this.get(name, source) !== undefined;
	}

	/** Remembers the command as terminal-only; entries whose file changed are dropped on the way. */
	async learn(name: string, source: string | undefined, message?: string): Promise<void> {
		const next: Record<string, LearnedCommand> = { ...this.record() };
		next[name] = { fingerprint: this.fingerprintOf(source), ...(message === undefined ? {} : { message }) };
		await this.storage.update(LEARNED_COMMANDS_KEY, next);
	}

	/** Forgets one command, so it is offered and run again. */
	async forget(name: string): Promise<void> {
		const next: Record<string, LearnedCommand> = { ...this.record() };
		if (!(name in next)) {
			return;
		}
		delete next[name];
		await this.storage.update(LEARNED_COMMANDS_KEY, next);
	}
}
