/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { loadPiSdk } from './piSdk';
import { ensureProfilePackages } from './packages-install';
import { readRuntimeMode, sdkEntryCandidates } from './runtime';
import {
	LoginCancelled,
	noticeOf,
	subscriptionRows,
	type PiAuthEvent,
	type PiAuthInteraction,
	type PiAuthPrompt,
	type PiLoginSdk,
	type PiModelRuntime,
} from './subscriptions';

/**
 * The flow behind "connect a subscription".
 *
 * What the list holds, in which order, and what pi's notices mean is decided in
 * `subscriptions.ts`, which has no runtime `vscode` import and can therefore be exercised by
 * running it. What is left here is the part that needs the editor: pi's questions answered with
 * the editor's own dialogs, and the one list the owner picks from.
 *
 * ## The dialogs are pi's, not ours
 *
 * A subscription login is a conversation: pi asks for a choice, a code, or nothing at all (many
 * flows open a browser and come back by themselves). Those prompts are the *editor's* quick pick
 * and input box, driven by what pi asks for — this is not the old chain of four windows, which
 * asked the owner for data PiCode could have asked the endpoint for.
 */

/**
 * pi's prompts and notices, answered by the editor.
 *
 * A cancelled prompt **throws** rather than answering: an empty string would be submitted to pi as
 * if the owner had typed it. A `select` answers with the option's id, never its label, because
 * the id is what pi asked about.
 */
export function createAuthInteraction(): PiAuthInteraction {
	return {
		async prompt(prompt: PiAuthPrompt): Promise<string> {
			if (prompt.type === 'select') {
				const picked = await vscode.window.showQuickPick(
					(prompt.options ?? []).map(option => ({
						label: option.label,
						...(option.description === undefined ? {} : { description: option.description }),
						id: option.id,
					})),
					{ title: prompt.message, ignoreFocusOut: true },
				);
				if (picked === undefined) {
					throw new LoginCancelled(prompt.message);
				}
				return picked.id;
			}

			const answer = await vscode.window.showInputBox({
				title: prompt.message,
				prompt: prompt.message,
				ignoreFocusOut: true,
				...(prompt.placeholder === undefined ? {} : { placeHolder: prompt.placeholder }),
				...(prompt.type === 'secret' ? { password: true } : {}),
			});
			if (answer === undefined) {
				throw new LoginCancelled(prompt.message);
			}
			return answer;
		},

		notify(event: PiAuthEvent): void {
			const notice = noticeOf(event);
			if (notice.url === undefined) {
				void vscode.window.showInformationMessage(notice.message);
				return;
			}
			// `ignoreFocusOut` above is what lets the owner go to the browser mid-login; this is the
			// button that takes them there, so the address never has to be copied by hand.
			void vscode.window.showInformationMessage(notice.message, 'Open in browser').then(choice => {
				if (choice !== undefined && notice.url !== undefined) {
					void vscode.env.openExternal(vscode.Uri.parse(notice.url));
				}
			});
		},
	};
}

export interface ConnectSubscriptionDeps {
	/** The distribution root, where pi lives. */
	readonly distributionRoot: string;
	/** PiCode's own profile: where pi stores the credential. */
	readonly profileDir: string;
	/** Called after a credential was stored, so the editor asks for models again. */
	readonly refreshModels: () => void;
}

/**
 * The command: lists the subscriptions pi can log in, and logs in the chosen one.
 *
 * Every failure is a sentence rather than silence: no pi, no catalogue, no provider that can be
 * logged in, and a login pi refused. The one ending that is not a failure is the owner dismissing
 * the list or one of pi's prompts.
 */
export async function connectSubscription(deps: ConnectSubscriptionDeps): Promise<void> {
	// The subscription login writes the credential into pi's own profile through pi's login
	// machinery. With the external pi that profile is the machine's, which PiCode never writes
	// to — so instead of a credential landing where the running pi cannot see it (or worse,
	// outside the product), the honest answer is the way that does work.
	if (readRuntimeMode() === 'external') {
		// The sentence explains the boundary; the button is the way out of it. A notification cannot
		// render a command link, so the action is an item, which is what the owner can press.
		void vscode.window.showErrorMessage(
			'PiCode: the external pi keeps its own credentials, which this editor never writes to. '
			+ 'Use a provider key instead, or set up PiCode\'s own pi.',
			'Set up PiCode',
		).then(choice => {
			if (choice !== undefined) {
				void vscode.commands.executeCommand('picode.setup');
			}
		});
		return;
	}
	const loaded = await loadPiSdk<PiLoginSdk>(sdkEntryCandidates(deps.distributionRoot));
	if ('problem' in loaded || typeof loaded.sdk.createAgentSessionServices !== 'function') {
		// What went wrong technically (a pi that could not be loaded, a missing method) is the log's business;
		// the owner gets the sentence about what they can do, and the door that does it.
		void vscode.window.showErrorMessage('PiCode: no subscription can be connected from here.', 'Set up PiCode').then(choice => {
			if (choice !== undefined) {
				void vscode.commands.executeCommand('picode.setup');
			}
		});
		return;
	}
	const sdk = loaded.sdk;

	let runtime: PiModelRuntime;
	try {
		// Before pi loads anything: the profile's declared-but-missing packages are installed here
		// (hidden, one run) so pi's loader never installs one itself — its per-package installs
		// each flashed a console window on Windows.
		await ensureProfilePackages({ profileDir: deps.profileDir });
		const services = await sdk.createAgentSessionServices({
			cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
			agentDir: deps.profileDir,
		});
		runtime = services.modelRuntime;
	} catch (error) {
		void vscode.window.showErrorMessage(`PiCode: pi could not be asked for its providers: ${messageOf(error)}`);
		return;
	}

	if (typeof runtime.login !== 'function') {
		void vscode.window.showErrorMessage(
			'PiCode: this pi cannot log a provider in. Updating pi is what brings the feature.',
			'Show updates',
		).then(choice => {
			if (choice !== undefined) {
				void vscode.commands.executeCommand('picode.updates.show');
			}
		});
		return;
	}

	const rows = subscriptionRows(runtime.getProviders(), providerId => runtime.hasConfiguredAuth(providerId));
	if (rows.length === 0) {
		void vscode.window.showInformationMessage('PiCode: this pi offers no provider that can be connected with a subscription.');
		return;
	}

	const chosen = await vscode.window.showQuickPick(rows, {
		title: 'PiCode: connect a subscription',
		placeHolder: 'Which account do you already pay for?',
		ignoreFocusOut: true,
	});
	if (chosen === undefined) {
		return;
	}

	try {
		await runtime.login(chosen.providerId, 'oauth', createAuthInteraction());
	} catch (error) {
		if (error instanceof LoginCancelled) {
			return;
		}
		void vscode.window.showErrorMessage(`PiCode: ${chosen.label} could not be connected: ${messageOf(error)}`);
		return;
	}

	// The models come from the profile, which now holds a fresh credential, so the editor is asked
	// for them again instead of waiting for it to feel like asking.
	deps.refreshModels();
	void vscode.window.showInformationMessage(`PiCode: ${chosen.label} connected. Its models are in the model list now.`);
}

/** One sentence out of anything thrown. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
