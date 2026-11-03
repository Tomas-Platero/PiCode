/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a `/name` typed in the chat turns into.
 *
 * vscode-free, so `node --test` runs it. pi's session only understands three slash forms by
 * itself: an extension command (`/gentle:status`), a skill as `/skill:name`, and a prompt
 * template (`/name`). Everything else — pi's own terminal commands (`/compact`, `/model`, `/new`…)
 * and the skills the chat's slash list offers as plain `/name` — would reach the model as a
 * sentence. This module decides, per request, which of four things happens:
 *
 * - **editor**: the chat answers it with its own surface (`EDITOR_COMMANDS`);
 * - **unavailable**: it only exists in pi's terminal; the chat says so, with the way there is;
 * - **pi**: the text goes to pi, rewritten to `/skill:name` when it names a skill;
 * - nothing: not a slash command at all.
 */

import { l10n } from './l10n.ts';

/** One command as the chat's slash list shows it. */
export interface ChatSlashCommand {
	readonly name: string;
	readonly description: string;
	readonly argumentHint?: string;
}

/**
 * pi's terminal commands the editor answers itself, plus `/gentle:models`, whose terminal panel
 * the editor replaces with its own pickers.
 */
export const EDITOR_COMMANDS: readonly ChatSlashCommand[] = [
	{ name: 'compact', description: l10n.t('Summarize the conversation so far to free up context'), argumentHint: l10n.t('[what to keep]') },
	{ name: 'new', description: l10n.t('Start a new chat') },
	{ name: 'model', description: l10n.t('Choose the model') },
	{ name: 'thinking', description: l10n.t('Set how hard the model thinks'), argumentHint: '[off | minimal | low | medium | high | xhigh | max]' },
	{ name: 'name', description: l10n.t('Rename this conversation'), argumentHint: '<name>' },
	{ name: 'session', description: l10n.t('Show this conversation’s messages, tokens and cost') },
	{ name: 'export', description: l10n.t('Save this conversation as a web page') },
	{ name: 'copy', description: l10n.t('Copy the last answer') },
	{ name: 'reload', description: l10n.t('Reload extensions, skills and prompts') },
	{ name: 'resume', description: l10n.t('Open an earlier conversation') },
	{ name: 'login', description: l10n.t('Connect a provider') },
	{ name: 'logout', description: l10n.t('Disconnect a provider') },
	{ name: 'settings', description: l10n.t('Open PiCode’s settings') },
	{ name: 'gentle:models', description: l10n.t('Choose the model of each Gentle agent') },
];

/** Where the chat sends someone for a command that has no answer in the editor. */
export type UnavailableAction = 'tasks' | 'agentModels' | 'sessions';

/** A command that only works in pi's terminal: what the chat says instead, and where it points. */
export interface UnavailableCommand {
	readonly message: string;
	readonly action?: UnavailableAction;
}

/**
 * Commands that only exist in pi's terminal, measured one by one against the editor's chat (they
 * draw a terminal panel, need a keyboard session, or need the Gentle AI program the product does
 * not install). They are left out of the slash list and answered with a sentence instead of
 * silence — or, for pi's own terminal commands, instead of reaching the model as a question.
 */
export const TERMINAL_ONLY_COMMANDS: ReadonlyMap<string, UnavailableCommand> = new Map<string, UnavailableCommand>([
	// pi's own terminal commands.
	['tree', { message: l10n.t('Moving between branches of a conversation is only available in pi’s terminal.') }],
	['fork', { message: l10n.t('Branching a conversation is only available in pi’s terminal.') }],
	['clone', { message: l10n.t('Duplicating a conversation is only available in pi’s terminal.') }],
	['import', { message: l10n.t('Importing a conversation file is only available in pi’s terminal.'), action: 'sessions' }],
	['scoped-models', { message: l10n.t('Model cycling is a terminal shortcut; choose the model from the chat’s model picker.') }],
	['share', { message: l10n.t('Sharing a conversation is only available in pi’s terminal. Use /export to save it as a web page.') }],
	['bug', { message: l10n.t('Reporting a bug to pi’s developers is only available in pi’s terminal.') }],
	['trust', { message: l10n.t('Project trust is managed by the editor’s workspace trust.') }],
	['changelog', { message: l10n.t('pi’s changelog is only shown in its terminal. Updates are listed under Updates.') }],
	['hotkeys', { message: l10n.t('These are pi’s terminal shortcuts; the editor has its own keyboard shortcuts.') }],
	['quit', { message: l10n.t('Close the chat or the window to quit.') }],
	// Extension commands that draw a terminal panel.
	['intercom', { message: l10n.t('The intercom panel is only available in pi’s terminal. Use /intercom-pool, /alias or /handover here.') }],
	['gentle:agents', { message: l10n.t('The agents panel is only available in pi’s terminal.'), action: 'agentModels' }],
	['gentle:jobs', { message: l10n.t('The jobs panel is only available in pi’s terminal.'), action: 'tasks' }],
	['gentle:review-session-permission', { message: l10n.t('Review permissions are only available in pi’s terminal.') }],
	// Gentle commands that need the Gentle AI program, which PiCode does not install.
	['gentle:review-mode', { message: l10n.t('Review mode needs the Gentle AI program, which PiCode does not include.') }],
	['gentle:telemetry', { message: l10n.t('Gentle AI telemetry is off in PiCode.') }],
	['gentle:dev-binary', { message: l10n.t('This command needs the Gentle AI program, which PiCode does not include.') }],
]);

/** The names a request is resolved against: what the live session holds right now. */
export interface SlashContext {
	/** pi extension commands the session registered. */
	readonly extensionCommands: ReadonlySet<string>;
	/** Skills the session loaded. */
	readonly skills: ReadonlySet<string>;
	/** What the chat learned by itself about a command that only works in pi's terminal (`learned-commands.ts`). */
	readonly learnedTerminalOnly?: (name: string) => UnavailableCommand | undefined;
}

/** What the chat says for a command it learned only works in pi's terminal. */
export const LEARNED_TERMINAL_ONLY: UnavailableCommand = { message: l10n.t('This command only works in pi’s terminal.') };

export type SlashRoute =
	| { readonly kind: 'editor'; readonly name: string; readonly args: string }
	| { readonly kind: 'unavailable'; readonly name: string; readonly command: UnavailableCommand }
	| { readonly kind: 'pi'; readonly text: string };

const EDITOR_COMMAND_NAMES = new Set(EDITOR_COMMANDS.map(command => command.name));

/** The command name and its arguments, or `undefined` when the text is not a slash command. */
export function parseSlash(prompt: string): { readonly name: string; readonly args: string } | undefined {
	const match = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
	return match === null ? undefined : { name: match[1], args: (match[2] ?? '').trim() };
}

/**
 * Where a request goes.
 *
 * An extension command wins over the editor's own answer of the same name — it is what pi itself
 * would run — except for the terminal-only ones, which would draw nothing. A skill named alone is
 * rewritten to pi's own `/skill:name` form, which is what loads it.
 */
export function routeSlash(prompt: string, context: SlashContext): SlashRoute | undefined {
	const parsed = parseSlash(prompt);
	if (parsed === undefined) {
		return undefined;
	}
	const { name, args } = parsed;
	const unavailable = TERMINAL_ONLY_COMMANDS.get(name);
	if (unavailable !== undefined) {
		return { kind: 'unavailable', name, command: unavailable };
	}
	const learned = context.extensionCommands.has(name) ? context.learnedTerminalOnly?.(name) : undefined;
	if (learned !== undefined) {
		return { kind: 'unavailable', name, command: learned };
	}
	if (context.extensionCommands.has(name)) {
		return { kind: 'pi', text: prompt.trim() };
	}
	if (EDITOR_COMMAND_NAMES.has(name)) {
		return { kind: 'editor', name, args };
	}
	if (context.skills.has(name)) {
		return { kind: 'pi', text: args.length === 0 ? `/skill:${name}` : `/skill:${name} ${args}` };
	}
	return { kind: 'pi', text: prompt.trim() };
}

/** Whether a command belongs in the chat's slash list. */
export function isListedCommand(name: string): boolean {
	return !TERMINAL_ONLY_COMMANDS.has(name);
}

/** A terminal panel's lines as plain text: colour codes and trailing spaces gone, empty edges dropped. */
export function panelText(lines: readonly string[]): string | undefined {
	const plain = lines.map(line => line.replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g, '').trimEnd());
	while (plain.length > 0 && plain[0].trim() === '') {
		plain.shift();
	}
	while (plain.length > 0 && plain[plain.length - 1].trim() === '') {
		plain.pop();
	}
	return plain.length === 0 ? undefined : plain.join('\n');
}

/**
 * The text of a message an extension posted for the person to read (`pi.sendMessage` with
 * `display: true`), or `undefined` for any other message. pi's terminal draws these; without this
 * the chat showed nothing for a command that answers that way.
 */
export function displayedCustomText(message: unknown): string | undefined {
	if (typeof message !== 'object' || message === null) {
		return undefined;
	}
	const record = message as { role?: unknown; display?: unknown; content?: unknown };
	if (record.role !== 'custom' || record.display !== true) {
		return undefined;
	}
	const parts = typeof record.content === 'string'
		? [record.content]
		: Array.isArray(record.content)
			? record.content.flatMap(part => {
				const item = part as { type?: unknown; text?: unknown } | null;
				return item !== null && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
			})
			: [];
	const text = parts.join('\n').trim();
	return text.length === 0 ? undefined : text;
}

/** pi's session totals, as the chat shows them for `/session`. */
export interface SessionStatsView {
	readonly name?: string;
	readonly userMessages?: number;
	readonly assistantMessages?: number;
	readonly toolCalls?: number;
	readonly input?: number;
	readonly output?: number;
	readonly cacheRead?: number;
	readonly cost?: number;
	readonly contextPercent?: number;
	readonly model?: string;
}

/** `/session` as markdown: one row per figure that is known. */
export function sessionStatsMarkdown(stats: SessionStatsView): string {
	const count = (value: number | undefined): string | undefined => value === undefined ? undefined : value.toLocaleString('en-US');
	const rows: [string, string | undefined][] = [
		[l10n.t('💬 Conversation'), stats.name],
		[l10n.t('🧠 Model'), stats.model],
		[l10n.t('🙋 Your messages'), count(stats.userMessages)],
		[l10n.t('🤖 Answers'), count(stats.assistantMessages)],
		[l10n.t('🛠️ Tool calls'), count(stats.toolCalls)],
		[l10n.t('📥 Tokens in'), count(stats.input)],
		[l10n.t('📤 Tokens out'), count(stats.output)],
		[l10n.t('♻️ Tokens from cache'), count(stats.cacheRead)],
		[l10n.t('📊 Context used'), stats.contextPercent === undefined ? undefined : `${Math.round(stats.contextPercent)}%`],
		[l10n.t('💲 Cost'), stats.cost === undefined ? undefined : `$${stats.cost.toFixed(4)}`],
	];
	const known = rows.filter((row): row is [string, string] => row[1] !== undefined && row[1] !== '');
	if (known.length === 0) {
		return l10n.t('Nothing to show yet: this conversation has no messages.');
	}
	return ['| | |', '|---|---|', ...known.map(([label, value]) => `| ${label} | ${value.replace(/\|/g, '\\|')} |`)].join('\n');
}
