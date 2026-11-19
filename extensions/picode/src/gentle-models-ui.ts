/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { gentleSettings, setGentleSetting, type GentleSettings } from './gentle-settings';
import { agentModelsState, setAgentModel, type AgentModelsState } from './gentle-models';

/** The command the status view's row runs: it opens the agent profiles page. */
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
