/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { loadPiSdk } from './piSdk';
import { withFetchRetry } from './fetch-retry';
import { settingsForFolder } from './folder-trust';
import { ensureProfilePackages } from './packages-install';
import { locateNpmCli } from './npm-run';
import { piRuntimeRoot, readRuntimeMode, sdkEntryCandidates } from './runtime';
import {
	LoginCancelled,
	defaultOptionOf,
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

/** How long the browser gets to come back by itself before pasting is offered as a way out. */
const PASTE_FALLBACK_DELAY_MS = 30_000;

/**
 * pi's prompts and notices, answered by the editor.
 *
 * A browser sign-in works like Claude Code's or Codex's: the browser opens by itself, pi's own
 * loopback server catches the answer, and the only thing on screen is one progress notification
 * with Cancel. pi also asks, in parallel, for the code or redirect address "in case the browser
 * cannot come back" — that question is **not** shown up front; it is offered only if the browser
 * has not come back after a while, and disappears when it does.
 *
 * A cancelled prompt **throws** rather than answering: an empty string would be submitted to pi as
 * if the owner had typed it. A `select` answers with the option's id, never its label, because
 * the id is what pi asked about.
 */
export function createAuthInteraction(progress: vscode.Progress<{ message?: string }>, signal: AbortSignal): PiAuthInteraction {
	let browserUrl: string | undefined;
	return {
		signal,

		async prompt(prompt: PiAuthPrompt): Promise<string> {
			if (prompt.type === 'select') {
				const preferred = defaultOptionOf(prompt.options ?? []);
				if (preferred !== undefined) {
					return preferred;
				}
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

			if (prompt.type === 'manual_code') {
				return waitForBrowser(prompt, signal, () => browserUrl);
			}

			return askText(prompt);
		},

		notify(event: PiAuthEvent): void {
			switch (event.type) {
				case 'auth_url':
					browserUrl = event.url;
					void vscode.env.openExternal(vscode.Uri.parse(event.url));
					progress.report({ message: vscode.l10n.t('Finish signing in in your browser.') });
					return;
				case 'device_code':
					// The code is only useful on the page that asks for it: copy it and open the page, so
					// signing in is a paste rather than two things typed by hand.
					browserUrl = event.verificationUri;
					void vscode.env.clipboard.writeText(event.userCode);
					void vscode.env.openExternal(vscode.Uri.parse(event.verificationUri));
					progress.report({ message: vscode.l10n.t('Enter the code {0} on the page that opened. It is already copied.', event.userCode) });
					return;
				case 'progress':
					// pi's progress lines describe its plumbing (ports, token exchange); the
					// notification already says what is happening.
					return;
				case 'info':
					void vscode.window.showInformationMessage(noticeOf(event).message);
					return;
			}
		},
	};
}

/** A typed answer pi needs (a domain, a key): the editor's input box. */
async function askText(prompt: Exclude<PiAuthPrompt, { type: 'select' }>): Promise<string> {
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
}

/**
 * pi's "or paste the code here", answered by waiting for the browser instead.
 *
 * When the browser comes back, pi aborts the prompt's signal and this promise is simply left
 * unanswered (pi no longer listens). Only if nothing has happened after a while is the way out
 * offered: open the page again, or paste the address the browser ended on.
 */
function waitForBrowser(prompt: Exclude<PiAuthPrompt, { type: 'select' | 'secret' }>, loginSignal: AbortSignal, urlOf: () => string | undefined): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const finished = () => prompt.signal?.aborted === true || loginSignal.aborted;
		const onLoginAbort = () => reject(new LoginCancelled(prompt.message));
		loginSignal.addEventListener('abort', onLoginAbort, { once: true });
		const timer = setTimeout(() => void offerPaste(), PASTE_FALLBACK_DELAY_MS);
		prompt.signal?.addEventListener('abort', () => {
			clearTimeout(timer);
			loginSignal.removeEventListener('abort', onLoginAbort);
		}, { once: true });

		const offerPaste = async (): Promise<void> => {
			if (finished()) {
				return;
			}
			const openAgain = vscode.l10n.t('Open browser again');
			const paste = vscode.l10n.t('Paste address');
			const choice = await vscode.window.showInformationMessage(
				vscode.l10n.t('Still waiting for the browser. If it did not come back to PiCode, paste the address it ended on.'),
				...(urlOf() === undefined ? [] : [openAgain]),
				paste,
			);
			if (finished()) {
				return;
			}
			if (choice === openAgain) {
				const url = urlOf();
				if (url !== undefined) {
					void vscode.env.openExternal(vscode.Uri.parse(url));
				}
				setTimeout(() => void offerPaste(), PASTE_FALLBACK_DELAY_MS);
				return;
			}
			if (choice !== paste) {
				return;
			}
			const answer = await vscode.window.showInputBox({
				title: vscode.l10n.t('Paste the address the browser ended on'),
				ignoreFocusOut: true,
				...(prompt.placeholder === undefined ? {} : { placeHolder: prompt.placeholder }),
			});
			if (answer !== undefined && answer.trim() !== '' && !finished()) {
				resolve(answer.trim());
			}
		};
	});
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
/** Why no login runtime could be built, in the terms the caller needs to answer it. */
export type LoginRuntimeProblem = 'external' | 'noPi' | 'noLogin' | { readonly failed: string };

/**
 * pi's model runtime over PiCode's own profile, ready to log a provider in — or the reason it is
 * not. Shared by the palette command and the Providers panel, so both see the same catalogue.
 */
export async function openLoginRuntime(deps: Pick<ConnectSubscriptionDeps, 'distributionRoot' | 'profileDir'>): Promise<PiModelRuntime | LoginRuntimeProblem> {
	if (readRuntimeMode() === 'external') {
		return 'external';
	}
	const loaded = await loadPiSdk<PiLoginSdk>(sdkEntryCandidates(deps.distributionRoot));
	if ('problem' in loaded || typeof loaded.sdk.createAgentSessionServices !== 'function') {
		return 'noPi';
	}
	const sdk = loaded.sdk;
	try {
		await ensureProfilePackages({ profileDir: deps.profileDir, runtimeRoot: piRuntimeRoot(deps.distributionRoot), npmCli: locateNpmCli() });
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const services = await sdk.createAgentSessionServices({
			cwd,
			agentDir: deps.profileDir,
			...settingsForFolder(sdk, cwd, deps.profileDir),
		});
		const runtime = services.modelRuntime as PiModelRuntime;
		return typeof runtime.login === 'function' ? runtime : 'noLogin';
	} catch (error) {
		return { failed: messageOf(error) };
	}
}

export async function connectSubscription(deps: ConnectSubscriptionDeps): Promise<void> {
	// The subscription login writes the credential into pi's own profile through pi's login
	// machinery. With the external pi that profile is the machine's, which PiCode never writes
	// to — so instead of a credential landing where the running pi cannot see it (or worse,
	// outside the product), the honest answer is the way that does work.
	if (readRuntimeMode() === 'external') {
		// The sentence explains the boundary; the button is the way out of it. A notification cannot
		// render a command link, so the action is an item, which is what the owner can press.
		void vscode.window.showErrorMessage(
			vscode.l10n.t('PiCode: the external pi keeps its own credentials, which this editor never writes to. Use a provider key instead, or set up PiCode\'s own pi.'),
			vscode.l10n.t('Set up PiCode'),
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
		void vscode.window.showErrorMessage(vscode.l10n.t('PiCode: no subscription can be connected from here.'), vscode.l10n.t('Set up PiCode')).then(choice => {
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
		await ensureProfilePackages({ profileDir: deps.profileDir, runtimeRoot: piRuntimeRoot(deps.distributionRoot), npmCli: locateNpmCli() });
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const services = await sdk.createAgentSessionServices({
			cwd,
			agentDir: deps.profileDir,
			...settingsForFolder(sdk, cwd, deps.profileDir),
		});
		runtime = services.modelRuntime;
	} catch (error) {
		void vscode.window.showErrorMessage(vscode.l10n.t('PiCode: pi could not be asked for its providers: {0}', messageOf(error)));
		return;
	}

	if (typeof runtime.login !== 'function') {
		void vscode.window.showErrorMessage(
			vscode.l10n.t('PiCode: this pi cannot log a provider in. Updating pi is what brings the feature.'),
			vscode.l10n.t('Show updates'),
		).then(choice => {
			if (choice !== undefined) {
				void vscode.commands.executeCommand('picode.updates.show');
			}
		});
		return;
	}

	const rows = subscriptionRows(runtime.getProviders(), providerId => runtime.hasConfiguredAuth(providerId));
	if (rows.length === 0) {
		void vscode.window.showInformationMessage(vscode.l10n.t('PiCode: this pi offers no provider that can be connected with a subscription.'));
		return;
	}

	const chosen = await vscode.window.showQuickPick(rows, {
		title: vscode.l10n.t('PiCode: connect a subscription'),
		placeHolder: vscode.l10n.t('Which account do you already pay for?'),
		ignoreFocusOut: true,
	});
	if (chosen === undefined) {
		return;
	}

	const login = runtime.login.bind(runtime);
	const abort = new AbortController();
	try {
		// One notification for the whole sign-in, with Cancel: it says where to go and goes away
		// on its own when the browser comes back.
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Connecting {0}', chosen.label), cancellable: true },
			async (progress, token) => {
				token.onCancellationRequested(() => abort.abort());
				await withFetchRetry(() => login(chosen.providerId, 'oauth', createAuthInteraction(progress, abort.signal)));
			},
		);
	} catch (error) {
		if (error instanceof LoginCancelled || abort.signal.aborted) {
			return;
		}
		void vscode.window.showErrorMessage(vscode.l10n.t('PiCode: {0} could not be connected: {1}', chosen.label, messageOf(error)));
		return;
	}

	// The models come from the profile, which now holds a fresh credential, so the editor is asked
	// for them again instead of waiting for it to feel like asking.
	deps.refreshModels();
	void vscode.window.showInformationMessage(vscode.l10n.t('PiCode: {0} connected. Its models are in the model list now.', chosen.label));
}

/** One sentence out of anything thrown. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
