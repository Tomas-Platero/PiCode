/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { gentleSettings, setGentleSetting, type GentleSettings } from './gentle-settings';
import { ALL_AGENTS, THINKING_LEVELS, agentModelsState, assign, describeAgentModel, listAgents, modelRefOf, readAgentModels, setAgentModel, writeAgentModels, type AgentModelsState, type ThinkingLevel } from './gentle-models';

/** The command that opens the pickers. */
export const AGENT_MODELS_COMMAND = 'picode.agents.chooseModels';
/** What the settings page reads and writes: the agents and what each is set to. */
export const AGENT_MODELS_STATE_COMMAND = 'picode.agents.models';
export const AGENT_MODELS_SET_COMMAND = 'picode.agents.setModel';
/** What the settings page reads and writes of Gentle's own preferences: persona and default permissions. */
export const GENTLE_SETTINGS_COMMAND = 'picode.gentle.settings';
export const GENTLE_SETTING_SET_COMMAND = 'picode.gentle.setSetting';

/** The settings page's two commands. A change restarts the chat's session, so the agents take it from the next message. */
export function registerAgentModelsStateCommands(profileDir: string, onSaved: () => void): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(AGENT_MODELS_STATE_COMMAND, (): AgentModelsState => agentModelsState(profileDir)),
		vscode.commands.registerCommand(AGENT_MODELS_SET_COMMAND, (request: unknown): AgentModelsState => {
			const state = setAgentModel(profileDir, request);
			onSaved();
			return state;
		}),
		vscode.commands.registerCommand(GENTLE_SETTINGS_COMMAND, (): GentleSettings => gentleSettings(profileDir)),
		vscode.commands.registerCommand(GENTLE_SETTING_SET_COMMAND, (request: unknown): GentleSettings => {
			const state = setGentleSetting(profileDir, request);
			onSaved();
			return state;
		}),
	];
}

export interface AgentModelsDeps {
	readonly profileDir: string;
	/** The models the editor can reach, as `provider/model` references. */
	readonly listModels: () => Promise<{ models: ReadonlyArray<{ ref: string; model: string; levels?: readonly ThinkingLevel[] }> }>;
	/** Called after a change is saved: the chat's session starts again so the agents pick it up. */
	readonly onSaved: () => void;
}

interface Item<T> extends vscode.QuickPickItem {
	readonly value: T;
}

const SAME_MODEL = 'Same model as the rest';
const OTHER_MODEL = 'Type another model…';

/**
 * Lets the owner give each Gentle agent the model it should answer with — the editor's own
 * version of the terminal's models panel. One round per change, until the owner closes the
 * picker. Returns what changed, in a sentence for the chat (or `undefined` when nothing did).
 */
export async function chooseAgentModels(deps: AgentModelsDeps): Promise<string | undefined> {
	const agents = listAgents(deps.profileDir);
	if (agents.length === 0) {
		return 'The agents are not ready yet. Send a message in the chat once, then choose their models.';
	}
	const changes: string[] = [];
	for (;;) {
		const saved = readAgentModels(deps.profileDir);
		if (saved.status === 'invalid') {
			return 'The agents’ model list could not be read. Delete it and try again.';
		}
		const target = await vscode.window.showQuickPick<Item<string>>([
			{ label: '$(organization) All agents', description: 'Give every agent the same model', value: ALL_AGENTS },
			{ label: '', kind: vscode.QuickPickItemKind.Separator, value: '' },
			...agents.map(agent => ({ label: `$(hubot) ${agent}`, description: describeAgentModel(saved.models[agent]), value: agent })),
		], { title: 'Models for agents', placeHolder: 'Which agent?', ignoreFocusOut: true });
		if (target === undefined) {
			break;
		}
		const picked = await pickModel(deps, target.value === ALL_AGENTS ? 'all agents' : target.value);
		if (picked === undefined) {
			continue;
		}
		const model = picked.model;
		let thinking: ThinkingLevel | undefined;
		// Only the effort levels the model supports are offered. A model that cannot think has nothing to
		// choose; one the catalogue does not describe keeps every level.
		const offered = picked.levels === undefined ? THINKING_LEVELS : picked.levels;
		if (model !== '' && offered.length > 1) {
			const level = await vscode.window.showQuickPick<Item<ThinkingLevel | ''>>([
				{ label: 'Default', description: 'No effort setting', value: '' },
				...offered.map(value => ({ label: value, value })),
			], { title: 'Models for agents', placeHolder: 'How much should it think?', ignoreFocusOut: true });
			if (level === undefined) {
				continue;
			}
			thinking = level.value === '' ? undefined : level.value;
		}
		const next = assign(saved.models, agents, target.value, model === '' ? {} : { model, ...(thinking === undefined ? {} : { thinking }) });
		writeAgentModels(deps.profileDir, next);
		deps.onSaved();
		changes.push(`${target.value === ALL_AGENTS ? 'All agents' : target.value}: ${model === '' ? SAME_MODEL.toLowerCase() : thinking === undefined ? model : `${model} · ${thinking}`}`);
	}
	return changes.length === 0
		? undefined
		: `Saved. The agents use this from your next message.\n\n${changes.map(line => `- ${line}`).join('\n')}`;
}

/** The model for one round: a `provider/model` reference (empty for "same as the rest") with the effort levels it supports when known, or `undefined` when cancelled. */
async function pickModel(deps: AgentModelsDeps, who: string): Promise<{ model: string; levels?: readonly ThinkingLevel[] } | undefined> {
	const listed = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Looking for models…' }, () => deps.listModels().catch(() => ({ models: [] })));
	const picked = await vscode.window.showQuickPick<Item<string>>([
		{ label: `$(circle-slash) ${SAME_MODEL}`, description: 'No model of its own', value: '' },
		...(listed.models.length === 0 ? [] : [{ label: '', kind: vscode.QuickPickItemKind.Separator, value: '#' }]),
		...listed.models.map(model => ({ label: model.model, description: model.ref, value: model.ref })),
		{ label: '', kind: vscode.QuickPickItemKind.Separator, value: '#' },
		{ label: `$(edit) ${OTHER_MODEL}`, value: '?' },
	], { title: 'Models for agents', placeHolder: `Model for ${who}`, matchOnDescription: true, ignoreFocusOut: true });
	if (picked === undefined) {
		return undefined;
	}
	if (picked.value !== '?') {
		const levels = listed.models.find(model => model.ref === picked.value)?.levels;
		return { model: picked.value, ...(levels === undefined ? {} : { levels }) };
	}
	const typed = await vscode.window.showInputBox({
		title: 'Models for agents',
		prompt: `Model for ${who}`,
		placeHolder: 'provider/model',
		ignoreFocusOut: true,
		validateInput: value => modelRefOf(value) === undefined ? 'Write it as provider/model, without spaces.' : undefined,
	});
	const ref = typed === undefined ? undefined : modelRefOf(typed);
	if (ref === undefined) {
		return undefined;
	}
	const levels = listed.models.find(model => model.ref === ref)?.levels;
	return { model: ref, ...(levels === undefined ? {} : { levels }) };
}
