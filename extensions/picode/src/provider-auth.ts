/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { openLoginRuntime, type ConnectSubscriptionDeps } from './login';
import { describeFailure, isNetworkFailure, withFetchRetry } from './fetch-retry';
import {
	FEATURED_SUBSCRIPTIONS,
	LoginCancelled,
	defaultOptionOf,
	rankOf,
	type PiAuthEvent,
	type PiAuthInteraction,
	type PiAuthPrompt,
	type PiModelRuntime,
} from './subscriptions';

/**
 * Connecting a provider from the Providers panel, step by step, inside the panel.
 *
 * The palette command (`login.ts`) answers pi with the editor's quick pick and input box. The
 * panel draws the whole conversation itself — the browser wait, a device code, a key field — so
 * this module turns pi's login into a **state** the panel reads (`picode.providers.auth.state`)
 * and a handful of answers it sends back. One login runs at a time; starting another cancels it.
 *
 * Commands are request/response, so the panel polls the state while a login runs. A login lasts
 * seconds to a minute and the state is a small object: polling is cheaper than a channel.
 */

export const PROVIDER_CATALOG_COMMAND = 'picode.providers.catalog';
export const PROVIDER_AUTH_START_COMMAND = 'picode.providers.auth.start';
export const PROVIDER_AUTH_STATE_COMMAND = 'picode.providers.auth.state';
export const PROVIDER_AUTH_ANSWER_COMMAND = 'picode.providers.auth.answer';
export const PROVIDER_AUTH_CANCEL_COMMAND = 'picode.providers.auth.cancel';
export const PROVIDER_AUTH_REOPEN_COMMAND = 'picode.providers.auth.reopen';
export const PROVIDER_LOGOUT_COMMAND = 'picode.providers.logout';

/** How long the browser gets to come back by itself before pasting is offered. */
const PASTE_FALLBACK_DELAY_MS = 30_000;

/** The API-key providers most people come for, first in their group (the rest by name). */
const FEATURED_KEYS = ['openai', 'anthropic', 'google', 'openrouter', 'deepseek', 'xai', 'mistral', 'groq', 'opencode'];

/** One provider pi can connect, as the panel shows it. */
export interface CatalogEntry {
	readonly id: string;
	readonly name: string;
	/** What the subscription is (`ChatGPT Plus or Pro`), for the ones that have a known plan. */
	readonly note?: string;
	/** pi can sign it in with an account. */
	readonly oauth: boolean;
	/** pi can store a key for it. */
	readonly apiKey: boolean;
	/** How it is connected now, if it is. */
	readonly connected?: 'subscription' | 'key';
	/** Position in its group: featured first, then by name. */
	readonly rank: number;
}

export type CatalogAnswer =
	| { readonly entries: readonly CatalogEntry[] }
	| { readonly unavailable: 'external' | 'noPi' | 'noLogin' | 'failed' };

/** The question pi is asking, as the panel draws it. */
export interface AuthQuestion {
	readonly id: number;
	readonly kind: 'select' | 'secret' | 'text';
	readonly message: string;
	readonly placeholder?: string;
	readonly options?: readonly { readonly id: string; readonly label: string }[];
}

/** Where a login stands. */
export interface AuthRunState {
	readonly run: number;
	readonly providerId: string;
	readonly method: 'oauth' | 'api_key';
	readonly phase: 'starting' | 'browser' | 'code' | 'question' | 'done' | 'cancelled' | 'failed';
	readonly userCode?: string;
	readonly canReopen: boolean;
	readonly canPaste: boolean;
	readonly question?: AuthQuestion;
	readonly error?: string;
}

interface ActiveRun {
	state: AuthRunState;
	readonly abort: AbortController;
	url?: string;
	/** Resolves the question on screen; `paste` answers pi's "or paste the address" prompt. */
	answer?: (value: string) => void;
	paste?: (value: string) => void;
	pasteTimer?: ReturnType<typeof setTimeout>;
}

let runCounter = 0;
let questionCounter = 0;
let active: ActiveRun | undefined;

function update(run: ActiveRun, patch: Partial<AuthRunState>): void {
	run.state = { ...run.state, ...patch };
}

/** pi's prompts and notices, turned into the panel's state. */
function panelInteraction(run: ActiveRun): PiAuthInteraction {
	return {
		signal: run.abort.signal,

		prompt(prompt: PiAuthPrompt): Promise<string> {
			if (prompt.type === 'select') {
				const preferred = defaultOptionOf(prompt.options ?? []);
				if (preferred !== undefined) {
					return Promise.resolve(preferred);
				}
			}
			if (prompt.type === 'manual_code') {
				return waitForBrowser(run, prompt.signal);
			}
			return ask(run, prompt);
		},

		notify(event: PiAuthEvent): void {
			if (event.type === 'auth_url') {
				run.url = event.url;
				void vscode.env.openExternal(vscode.Uri.parse(event.url));
				update(run, { phase: 'browser', canReopen: true });
			} else if (event.type === 'device_code') {
				run.url = event.verificationUri;
				void vscode.env.clipboard.writeText(event.userCode);
				void vscode.env.openExternal(vscode.Uri.parse(event.verificationUri));
				update(run, { phase: 'code', userCode: event.userCode, canReopen: true });
			}
			// `progress` and `info` describe pi's plumbing; the panel already says what is happening.
		},
	};
}

/** A question for the panel: it shows, the person answers, the login goes on. */
function ask(run: ActiveRun, prompt: Exclude<PiAuthPrompt, { type: 'manual_code' }>): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const previous = run.state.phase;
		const question: AuthQuestion = {
			id: ++questionCounter,
			kind: prompt.type === 'select' ? 'select' : prompt.type === 'secret' ? 'secret' : 'text',
			message: prompt.message,
			...(prompt.type !== 'select' && prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}),
			...(prompt.type === 'select' ? { options: prompt.options.map(option => ({ id: option.id, label: option.label })) } : {}),
		};
		const onAbort = () => reject(new LoginCancelled(prompt.message));
		run.abort.signal.addEventListener('abort', onAbort, { once: true });
		run.answer = value => {
			run.abort.signal.removeEventListener('abort', onAbort);
			run.answer = undefined;
			update(run, { phase: previous === 'question' ? 'starting' : previous, question: undefined });
			resolve(value);
		};
		update(run, { phase: 'question', question });
	});
}

/**
 * pi's "or paste the code here", answered by waiting for the browser. Pasting becomes possible
 * only after a while; when the browser comes back pi aborts `signal` and the promise is dropped.
 */
function waitForBrowser(run: ActiveRun, signal: AbortSignal | undefined): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const onAbort = () => reject(new LoginCancelled('browser'));
		run.abort.signal.addEventListener('abort', onAbort, { once: true });
		run.pasteTimer = setTimeout(() => {
			if (signal?.aborted !== true && active === run) {
				update(run, { canPaste: true });
			}
		}, PASTE_FALLBACK_DELAY_MS);
		run.paste = value => {
			run.paste = undefined;
			update(run, { canPaste: false });
			resolve(value);
		};
		signal?.addEventListener('abort', () => {
			clearTimeout(run.pasteTimer);
			run.abort.signal.removeEventListener('abort', onAbort);
			run.paste = undefined;
			update(run, { canPaste: false });
		}, { once: true });
	});
}

/** Registers the panel's commands. */
export function registerProviderAuthCommands(deps: ConnectSubscriptionDeps): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(PROVIDER_CATALOG_COMMAND, async (): Promise<CatalogAnswer> => {
			const runtime = await openLoginRuntime(deps);
			if (typeof runtime !== 'object' || 'failed' in runtime) {
				return { unavailable: typeof runtime === 'string' ? runtime : 'failed' };
			}
			return { entries: catalogOf(runtime) };
		}),

		vscode.commands.registerCommand(PROVIDER_AUTH_START_COMMAND, async (providerId: unknown, method: unknown): Promise<AuthRunState | undefined> => {
			if (typeof providerId !== 'string' || (method !== 'oauth' && method !== 'api_key')) {
				return undefined;
			}
			cancelActive();
			const run: ActiveRun = {
				state: { run: ++runCounter, providerId, method, phase: 'starting', canReopen: false, canPaste: false },
				abort: new AbortController(),
			};
			active = run;
			void runLogin(run, deps);
			return run.state;
		}),

		vscode.commands.registerCommand(PROVIDER_AUTH_STATE_COMMAND, (): AuthRunState | undefined => active?.state),

		vscode.commands.registerCommand(PROVIDER_AUTH_ANSWER_COMMAND, (questionId: unknown, value: unknown): void => {
			if (active === undefined || typeof value !== 'string') {
				return;
			}
			if (questionId === 'paste') {
				active.paste?.(value.trim());
				return;
			}
			if (active.state.question?.id === questionId) {
				active.answer?.(value);
			}
		}),

		vscode.commands.registerCommand(PROVIDER_AUTH_CANCEL_COMMAND, (): void => cancelActive()),

		vscode.commands.registerCommand(PROVIDER_AUTH_REOPEN_COMMAND, (): void => {
			if (active?.url !== undefined) {
				void vscode.env.openExternal(vscode.Uri.parse(active.url));
			}
		}),

		vscode.commands.registerCommand(PROVIDER_LOGOUT_COMMAND, async (providerId: unknown): Promise<boolean> => {
			if (typeof providerId !== 'string') {
				return false;
			}
			const runtime = await openLoginRuntime(deps);
			if (typeof runtime !== 'object' || 'failed' in runtime || typeof runtime.logout !== 'function') {
				return false;
			}
			await runtime.logout(providerId);
			deps.refreshModels();
			return true;
		}),

		new vscode.Disposable(() => cancelActive()),
	];
}

function cancelActive(): void {
	const run = active;
	if (run === undefined) {
		return;
	}
	if (run.state.phase !== 'done' && run.state.phase !== 'failed' && run.state.phase !== 'cancelled') {
		update(run, { phase: 'cancelled', question: undefined, canPaste: false });
		run.abort.abort();
	}
	clearTimeout(run.pasteTimer);
}

async function runLogin(run: ActiveRun, deps: ConnectSubscriptionDeps): Promise<void> {
	const runtime = await openLoginRuntime(deps);
	if (active !== run || run.abort.signal.aborted) {
		return;
	}
	if (typeof runtime !== 'object' || 'failed' in runtime || runtime.login === undefined) {
		update(run, { phase: 'failed', error: vscode.l10n.t('PiCode could not reach its pi to connect this provider.') });
		return;
	}
	try {
		const login = runtime.login.bind(runtime);
		await withFetchRetry(() => login(run.state.providerId, run.state.method, panelInteraction(run)));
		if (active === run && !run.abort.signal.aborted) {
			update(run, { phase: 'done', question: undefined, canPaste: false, canReopen: false });
			deps.refreshModels();
		}
	} catch (error) {
		if (active !== run || run.abort.signal.aborted || error instanceof LoginCancelled) {
			return;
		}
		update(run, { phase: 'failed', question: undefined, canPaste: false, error: failureOf(error) });
	} finally {
		clearTimeout(run.pasteTimer);
	}
}

/**
 * What went wrong, said for the person. A network failure surfaces from Node as `fetch failed`
 * (or a socket code); what it means is that the service could not be reached.
 */
function failureOf(error: unknown): string {
	console.error(`[PiCode sign-in] failed: ${describeFailure(error)}`);
	const message = error instanceof Error ? error.message : String(error);
	if (isNetworkFailure(error)) {
		return vscode.l10n.t('The service could not be reached. Check your internet connection and try again.');
	}
	return message;
}

/** Every provider pi can connect, with how it is connected now. */
function catalogOf(runtime: PiModelRuntime): CatalogEntry[] {
	const entries: CatalogEntry[] = [];
	for (const provider of runtime.getProviders() ?? []) {
		const oauth = typeof provider.auth?.oauth?.login === 'function';
		const apiKey = typeof provider.auth?.apiKey?.login === 'function';
		if (!oauth && !apiKey) {
			continue;
		}
		const subscription = oauth && runtime.isUsingOAuth(provider.id);
		const configured = runtime.hasConfiguredAuth(provider.id);
		const note = FEATURED_SUBSCRIPTIONS.find(featured => featured.id === provider.id)?.note;
		const keyRank = FEATURED_KEYS.indexOf(provider.id);
		entries.push({
			id: provider.id,
			name: provider.name,
			...(note === undefined ? {} : { note }),
			oauth,
			apiKey,
			...(subscription ? { connected: 'subscription' as const } : configured ? { connected: 'key' as const } : {}),
			rank: oauth ? rankOf(provider.id) : (keyRank === -1 ? FEATURED_KEYS.length : keyRank),
		});
	}
	return entries.sort((left, right) => left.rank - right.rank || left.name.localeCompare(right.name));
}
