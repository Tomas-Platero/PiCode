/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Which model each of Gentle AI's agents answers with.
 *
 * Gentle keeps this in one file, `<profile>/gentle-ai/models.json`, shaped `{ "<agent>": { "model":
 * "provider/model", "thinking": "high" } }`, and applies it to its agents every time a chat session
 * starts. Its terminal edits that file from a full-screen panel the editor cannot draw, so the editor
 * writes the same file from its own pickers. An agent with no model of its own answers with pi's
 * default model, which is not always the model the chat is on — which is the reason this exists.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

/** The effort levels Gentle accepts. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

/** What one agent is set to. An empty entry means "answer with the same model as everything else". */
export interface AgentModel {
	model?: string;
	thinking?: ThinkingLevel;
}

export type AgentModels = Record<string, AgentModel>;

/** The row that stands for every agent at once. */
export const ALL_AGENTS = 'all';

/** The characters Gentle accepts in a model reference. */
const SAFE_MODEL = /^[A-Za-z0-9._~:@/+%-]+$/;

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** A `provider/model` reference Gentle will take, or `undefined` for anything else. */
export function modelRefOf(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const ref = value.trim();
	return ref.includes('/') && SAFE_MODEL.test(ref) ? ref : undefined;
}

export function modelsFile(profileDir: string): string {
	return path.join(profileDir, 'gentle-ai', 'models.json');
}

export type ReadModels = { readonly status: 'ok'; readonly models: AgentModels } | { readonly status: 'invalid' };

/** The saved assignments; a missing file is "nothing assigned", a file that is not a JSON object is `invalid`. */
export function readAgentModels(profileDir: string): ReadModels {
	let text: string;
	try {
		text = fs.readFileSync(modelsFile(profileDir), 'utf8');
	} catch {
		return { status: 'ok', models: {} };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { status: 'invalid' };
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { status: 'invalid' };
	}
	const models: AgentModels = {};
	for (const [agent, value] of Object.entries(parsed)) {
		const entry: AgentModel = {};
		if (typeof value === 'string') {
			const model = modelRefOf(value);
			if (model !== undefined) {
				entry.model = model;
			}
		} else if (typeof value === 'object' && value !== null) {
			const record = value as Record<string, unknown>;
			const model = modelRefOf(record['model']);
			if (model !== undefined) {
				entry.model = model;
			}
			const thinking = isThinkingLevel(record['thinking']) ? record['thinking'] : record['effort'];
			if (isThinkingLevel(thinking)) {
				entry.thinking = thinking;
			}
		} else {
			continue;
		}
		models[agent] = entry;
	}
	return { status: 'ok', models };
}

/**
 * The agents whose model can be chosen: Gentle's agent files in the profile, without the review
 * agents, which only run inside Gentle's own code review.
 */
export function listAgents(profileDir: string): string[] {
	let names: string[];
	try {
		names = fs.readdirSync(path.join(profileDir, 'agents'));
	} catch {
		return [];
	}
	return names
		.filter(name => name.endsWith('.md'))
		.map(name => name.slice(0, -'.md'.length))
		.filter(name => !name.startsWith('review-'))
		.sort((a, b) => a.localeCompare(b));
}

/**
 * The assignments after one change. `target` is an agent or `ALL_AGENTS`; `change.model` undefined
 * puts the agent back on the same model as everything else. An agent put back is written as an empty
 * entry, not removed: Gentle only clears a model it wrote earlier when it is told so.
 */
export function assign(current: AgentModels, agents: readonly string[], target: string, change: AgentModel): AgentModels {
	const next: AgentModels = {};
	for (const [agent, entry] of Object.entries(current)) {
		next[agent] = { ...entry };
	}
	const names = target === ALL_AGENTS ? agents : [target];
	for (const name of names) {
		const entry: AgentModel = {};
		if (change.model !== undefined) {
			entry.model = change.model;
		}
		if (change.thinking !== undefined) {
			entry.thinking = change.thinking;
		}
		next[name] = entry;
	}
	return next;
}

/** One agent's setting, in the words a row shows. */
export function describeAgentModel(entry: AgentModel | undefined): string {
	if (entry?.model === undefined) {
		return 'Same model as the rest';
	}
	return entry.thinking === undefined ? entry.model : `${entry.model} · ${entry.thinking}`;
}

/** Writes the file whole, through a temporary one, so a crash never leaves half a file. */
export function writeAgentModels(profileDir: string, models: AgentModels): void {
	const file = modelsFile(profileDir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(models, undefined, 2)}\n`, 'utf8');
	fs.renameSync(temporary, file);
}

/** What the settings page shows: the agents, and what each is set to. */
export interface AgentModelsState {
	readonly agents: readonly string[];
	readonly models: AgentModels;
	/** The saved file could not be read; nothing is shown as set. */
	readonly invalid: boolean;
}

export function agentModelsState(profileDir: string): AgentModelsState {
	const saved = readAgentModels(profileDir);
	return { agents: listAgents(profileDir), models: saved.status === 'ok' ? saved.models : {}, invalid: saved.status === 'invalid' };
}

/**
 * One change from the settings page: `agent` is an agent or `all`; `model` and `thinking` are what it
 * should be now, empty for none. Anything that is not an agent, a model or a level is refused, so a
 * hand-made request cannot write a file Gentle would reject.
 */
export function setAgentModel(profileDir: string, request: unknown): AgentModelsState {
	const { agent, model, thinking } = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>;
	const state = agentModelsState(profileDir);
	if (state.invalid) {
		throw new Error("The agents' model list could not be read.");
	}
	if (typeof agent !== 'string' || (agent !== ALL_AGENTS && !state.agents.includes(agent))) {
		throw new Error('That agent does not exist.');
	}
	const ref = model === undefined || model === '' ? undefined : modelRefOf(model);
	if (model !== undefined && model !== '' && ref === undefined) {
		throw new Error('A model is written provider/model, without spaces.');
	}
	if (thinking !== undefined && thinking !== '' && !isThinkingLevel(thinking)) {
		throw new Error('That is not an effort level.');
	}
	const level = thinking === undefined || thinking === '' ? undefined : thinking as ThinkingLevel;
	writeAgentModels(profileDir, assign(state.models, state.agents, agent, { ...(ref === undefined ? {} : { model: ref }), ...(level === undefined ? {} : { thinking: level }) }));
	return agentModelsState(profileDir);
}

/** Whether a chat message is the request to choose the agents' models. */
export function isAgentModelsCommand(prompt: string): boolean {
	return /^\/gentle:models\s*$/.test(prompt.trim());
}
