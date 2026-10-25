/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the owner can decide about **pi itself**, read where the answers are.
 *
 * The settings live in the editor (`Settings > Chat > Pi`), because the editor's settings are the
 * surface this product has — there is no PiCode panel. The values are what pi's own session takes:
 * how hard it thinks, whether its thinking is shown, and whether the editor's context travels with
 * every prompt.
 *
 * ## Why there are only three
 *
 * The retired extension had more, and they are not all here on purpose: a switch that changes
 * nothing is a surface that lies. Three of those settings belonged to the two-pi world the owner
 * retired (`runtime`, `executablePath`, `transport`: *which* pi runs and *how* it is talked to),
 * one to the command-line transport that the SDK path does not have (`extraArgs`), and two to the
 * voice features of the panel that no longer exists (`media.ffmpegPath`, `media.transcription`).
 * What is left is what this architecture can actually do.
 *
 * No `vscode` import: the reader takes a getter, so the mapping can be exercised by running it.
 * The one import is pi's own SDK, and it is a type — erased at compile time, so nothing here
 * loads at runtime either.
 */

import type { OfficialSdk } from './piSdk';
import type { ContextMode } from './context';

/** pi's own thinking level, named from pi's own signature — the list below is checked against it member by member. */
type PiThinkingLevel = NonNullable<Parameters<OfficialSdk['createAgentSessionFromServices']>[0]['thinkingLevel']>;

/** The thinking levels pi accepts, in the order it accepts them. */
export const THINKING_LEVELS: readonly PiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Reads a value as one of the levels pi accepts: a hand-typed `settings.json` value is checked, never trusted. */
const isThinkingLevel = (value: unknown): value is PiThinkingLevel =>
	typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);

/** How the model's thinking is shown in the chat. */
export const REASONING_MODES = ['hide', 'show'] as const;

/**
 * The setting the modes are stored under, and the command that flips it.
 *
 * The status panel's Thinking row is the button: a click flips `picode.pi.reasoning` between
 * `show` and `hide`, and the row's own description repaints on the next refresh to say which it
 * now is. The chat then stops writing the thinking from the next turn on — turns already on
 * screen keep what they showed.
 */
export const REASONING_SETTING = 'pi.reasoning';
export const THINKING_TOGGLE_COMMAND = 'picode.pi.toggleThinking';

export interface PiChatSettings {
	/** The thinking level to run pi at, or `undefined` to leave pi's own default alone. pi's own union, validated when read. */
	readonly thinkingLevel: PiThinkingLevel | undefined;
	/** Whether the model's thinking is written into the chat. */
	readonly showReasoning: boolean;
	/** Whether the editor's context (folder, file, selection) travels with the prompt. */
	readonly attachContext: boolean;
	/** How much of the editor travels with a prompt, when the context is attached at all. */
	readonly contextMode: ContextMode;
	/** Whether the editor's MCP servers' tools are given to pi. */
	readonly mcpEnabled: boolean;
	/** The agent tools that stay off, by name. Empty — nothing is excluded — unless filled. */
	readonly disabledTools: readonly string[];
}

/**
 * Reads the three settings from anything that can answer by key.
 *
 * Anything unrecognised is read as "not set" rather than as a value: these are settings a person
 * can also write by hand in `settings.json`, and a typo there must not become a pi option.
 */
export function readPiChatSettings(get: (key: string) => unknown): PiChatSettings {
	const thinking = get('pi.thinkingLevel');
	const reasoning = get('pi.reasoning');
	const attach = get('context.attach');

	const mcp = get('mcp.enabled');
	const disabledTools = get('pi.disabledTools');

	return {
		thinkingLevel: isThinkingLevel(thinking) ? thinking : undefined,
		// Default **shown** (the owner's call); an explicit
		// `hide` is the only thing that turns it off.
		showReasoning: reasoning !== 'hide',
		// On unless it was turned off: a switch that only exists to be left alone is not a switch.
		mcpEnabled: mcp === undefined ? true : mcp === true,
		// Default **on**, unlike the retired extension's: attaching the context is what makes the
		// agent answer about the file the owner is looking at without being told which one, and a
		// user who does not want it is the exception, not the rule.
		attachContext: attach === undefined ? true : attach === true,
		// The default is what the product already did: the folder, the file and the selection.
		// Parsed here rather than with `context.ts`'s helper on purpose: a **type-only** import is
		// erased, so this module keeps loading on its own (the connector's tests run it with
		// `node --test`, which resolves imports strictly and would not find an extensionless one).
		contextMode: contextModeOfRaw(get('context.mode')),
		disabledTools: disabledToolsOf(disabledTools),
	};
}

/**
 * The context mode, from the setting's raw value.
 *
 * Anything that is not `file` or `selection` is the default: an older settings file and a fresh
 * install have to report the same thing, and a typo must not leave the editor with a mode it
 * does not know.
 */
function contextModeOfRaw(raw: unknown): ContextMode {
	return raw === 'file' || raw === 'selection' ? raw : 'project';
}

/**
 * The tools the session is built without, read from the setting's raw value.
 *
 * A name that is not a non-empty string is a typo, not a tool — it is dropped rather than
 * passed to pi, because an `excludeTools` entry pi cannot match is a tool the owner thinks
 * is off and is not. Duplicates collapse: one entry is enough to exclude a tool.
 */
export function disabledToolsOf(value: unknown): readonly string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const names = new Set<string>();
	for (const entry of value) {
		if (typeof entry === 'string' && entry.trim().length > 0) {
			names.add(entry.trim());
		}
	}
	return [...names].toSorted((a, b) => a.localeCompare(b));
}
