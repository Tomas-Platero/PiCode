/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { agentProfilesState, editAgentProfiles, ORCHESTRATOR, ProfileEditError, resolvedProfile, type AgentProfilesState, type ProfileEdit } from './agent-profiles';
import { applyAgentProfile, applyConfirmed, deferDefault, hasLiveSession, type ApplyResult } from './agent-profiles-live';
import { listAgents } from './gentle-models';

/** What the settings page and the chat's chip read. */
export const AGENT_PROFILES_STATE_COMMAND = 'picode.agentProfiles.state';
/** One edit: create, rename, delete, a route, the way of working, a pin. */
export const AGENT_PROFILES_EDIT_COMMAND = 'picode.agentProfiles.edit';
/** Use a profile: by default (and in the chat in front), or only in the chat in front. */
export const AGENT_PROFILES_USE_COMMAND = 'picode.agentProfiles.use';
/** The editor profile's own agent profile: a setting, so it lives in each editor profile's settings. */
export const EDITOR_PROFILE_SETTING = 'picode.agents.profile';

export interface AgentProfilesView extends AgentProfilesState {
	/** The agents a profile can route: the main agent first, then Gentle's agents. */
	readonly agents: readonly string[];
	/** The profile new chats in this folder use, and why. */
	readonly resolved: ReturnType<typeof resolvedProfile>;
	/** The agent profile this editor profile asks for, if any. */
	readonly editorProfile?: string;
	/** A chat is running, so a choice reaches it at once. */
	readonly live: boolean;
}

function workspaceFolder(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function editorProfileChoice(): string | undefined {
	const value = vscode.workspace.getConfiguration().get<string>(EDITOR_PROFILE_SETTING, '');
	return value.trim().length > 0 ? value.trim() : undefined;
}

function view(profileDir: string): AgentProfilesView {
	const state = agentProfilesState(profileDir, workspaceFolder());
	const editorProfile = editorProfileChoice();
	return {
		...state,
		agents: [ORCHESTRATOR, ...listAgents(profileDir)],
		resolved: resolvedProfile(state),
		...(editorProfile === undefined ? {} : { editorProfile }),
		live: hasLiveSession(),
	};
}

/** What Gentle said, as one line for a notification. */
function noteOf(result: ApplyResult): string | undefined {
	if (result.status === 'applied' || result.status === 'not_applied') {
		return result.notes.at(-1)?.text;
	}
	return undefined;
}

/**
 * Uses a profile. `default` makes it what new chats start with and moves the chat in front to it;
 * `session` moves only the chat in front. Gentle's own confirmation is shown when `ask` is set.
 * Returns whether it was used.
 */
async function useProfile(profileDir: string, name: string, mode: 'default' | 'session', ask: boolean): Promise<boolean> {
	if (!hasLiveSession()) {
		if (mode === 'session') {
			void vscode.window.showInformationMessage(vscode.l10n.t('Send a message in the chat first, then choose a profile for it.'));
			return false;
		}
		// No chat to let Gentle apply it now: the default is marked (what a new chat freezes) and
		// Gentle applies it fully as the next chat starts.
		editAgentProfiles(profileDir, workspaceFolder(), { type: 'active', name });
		deferDefault(name);
		return true;
	}
	let result = await applyAgentProfile(name, mode);
	if (result.status === 'confirmation_required') {
		if (ask) {
			const apply = vscode.l10n.t('Apply');
			const answer = await vscode.window.showInformationMessage(result.title, { modal: true, detail: result.message }, apply);
			if (answer !== apply) {
				return false;
			}
		}
		result = await applyAgentProfile(name, mode, result.confirmation);
	}
	switch (result.status) {
		case 'applied':
			break;
		case 'unknown_profile':
			void vscode.window.showWarningMessage(vscode.l10n.t('There is no profile called {0}.', name));
			return false;
		case 'busy':
			void vscode.window.showWarningMessage(vscode.l10n.t('Another profile is being applied. Try again in a moment.'));
			return false;
		case 'unavailable':
			void vscode.window.showWarningMessage(vscode.l10n.t('The agents could not switch profile right now. Try again after the chat answers.'));
			return false;
		default: {
			const note = noteOf(result);
			void vscode.window.showWarningMessage(note ?? vscode.l10n.t('The profile was not applied.'));
			return false;
		}
	}
	if (mode === 'default') {
		// The chat in front follows too: Gentle's default only reaches new chats' subagents.
		await applyConfirmed(name, 'session');
	}
	return true;
}

export function registerAgentProfilesCommands(profileDir: string): vscode.Disposable[] {
	const changed = new vscode.EventEmitter<void>();
	return [
		changed,
		vscode.commands.registerCommand(AGENT_PROFILES_STATE_COMMAND, (): AgentProfilesView => view(profileDir)),
		vscode.commands.registerCommand(AGENT_PROFILES_EDIT_COMMAND, async (edit: ProfileEdit): Promise<AgentProfilesView | { readonly error: string }> => {
			try {
				const before = agentProfilesState(profileDir, workspaceFolder());
				editAgentProfiles(profileDir, workspaceFolder(), edit);
				// A change to the default profile reaches the chat in front at once, as the old per-agent rows did.
				if ((edit.type === 'route' || edit.type === 'mode') && edit.name === before.active && !before.unsaved && hasLiveSession()) {
					await applyConfirmed(edit.name, 'default');
					await applyConfirmed(edit.name, 'session');
				}
				// The editor profile follows a rename of the profile it asks for.
				if (edit.type === 'rename' && editorProfileChoice() === edit.name) {
					await vscode.workspace.getConfiguration().update(EDITOR_PROFILE_SETTING, edit.to, vscode.ConfigurationTarget.Global);
				}
				return view(profileDir);
			} catch (error) {
				return { error: error instanceof ProfileEditError ? error.message : String(error) };
			}
		}),
		vscode.commands.registerCommand(AGENT_PROFILES_USE_COMMAND, async (request: { name?: unknown; mode?: unknown; ask?: unknown }): Promise<AgentProfilesView> => {
			const name = typeof request?.name === 'string' ? request.name : undefined;
			const mode = request?.mode === 'session' ? 'session' : 'default';
			if (name !== undefined && await useProfile(profileDir, name, mode, request?.ask !== false) && mode === 'default' && editorProfileChoice() !== undefined) {
				// This editor profile asks for a profile: the choice becomes its own, or the next switch back would undo it.
				await vscode.workspace.getConfiguration().update(EDITOR_PROFILE_SETTING, name, vscode.ConfigurationTarget.Global);
			}
			return view(profileDir);
		}),
		...followEditorProfile(profileDir),
	];
}

/**
 * Each editor profile may name an agent profile (`picode.agents.profile`). Switching editor profile
 * restarts the extensions, so this runs on every switch: when the editor profile asks for another
 * profile than the default, the default moves to it, with Undo. An empty setting leaves the agents alone.
 */
function followEditorProfile(profileDir: string): vscode.Disposable[] {
	const follow = async (): Promise<void> => {
		const wanted = editorProfileChoice();
		if (wanted === undefined) {
			return;
		}
		const state = agentProfilesState(profileDir, workspaceFolder());
		if (state.invalid || state.active === wanted) {
			return;
		}
		if (!state.profiles.some(profile => profile.name === wanted) || state.unsaved) {
			void vscode.window.showWarningMessage(vscode.l10n.t('This editor profile uses the agent profile {0}, which does not exist.', wanted));
			return;
		}
		const previous = state.active;
		if (!await useProfile(profileDir, wanted, 'default', false)) {
			return;
		}
		const undo = vscode.l10n.t('Undo');
		const answer = await vscode.window.showInformationMessage(vscode.l10n.t('Agents now use the {0} profile.', wanted), ...(previous === undefined ? [] : [undo]));
		if (answer === undo && previous !== undefined) {
			await useProfile(profileDir, previous, 'default', false);
			await vscode.workspace.getConfiguration().update(EDITOR_PROFILE_SETTING, previous, vscode.ConfigurationTarget.Global);
		}
	};
	void follow();
	return [
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(EDITOR_PROFILE_SETTING)) {
				void follow();
			}
		}),
	];
}
