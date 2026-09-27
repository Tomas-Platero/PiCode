/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';

/**
 * The providers a person can connect **with the subscription they already pay for**.
 *
 * ChatGPT Plus/Pro, Claude Pro/Max, GitHub Copilot, Grok, Kimi: these are accounts rather than
 * API keys, and the way in is pi's own login. That is why the surface for them is a **list** —
 * the owner's request was "una lista de proveedores a los cuales conectarme por oauth" — and why
 * nothing here asks for an endpoint or a dialect: those belong to the declared providers, which
 * have their own form in the settings row.
 *
 * ## What is pi's and what is this file's
 *
 * The catalogue is **pi's**: which providers exist, which of them can be logged in and whether a
 * credential is already stored all come from the runtime pi builds for PiCode's own profile.
 * Nothing about providers is written down here as a fact — a provider that disappears from pi
 * disappears from the list, and one that appears shows up even though this table has never heard
 * of it.
 *
 * What this file adds is the **order** and the wording, which are decisions about how to present
 * that catalogue. The order is not invented: the same three subscriptions lead every public list
 * of "use the AI subscription you already have" — ChatGPT Plus/Pro, Claude Pro/Max and GitHub
 * Copilot come first in Zed's own documentation of its subscription logins
 * (zed.dev/docs/ai/use-an-existing-subscription), and Copilot and Claude Code lead the
 * coding-agent round-ups. Anything pi offers that is not on that list is still shown, after it
 * and in alphabetical order, because hiding a provider somebody pays for would be worse than an
 * imperfect order.
 *
 * This module has no runtime `vscode` import (only a type), so the list and its order can be
 * exercised by running them.
 */

/* ------------------------------------------------------------------ *
 * pi's side, reduced to what this flow calls
 * ------------------------------------------------------------------ */

/**
 * pi's `ProviderAuth`, reduced to the one method this flow runs.
 *
 * Quoted rather than imported because pi is ESM loaded at runtime. Only presence matters:
 * `apiKey` may exist without a `login`, while `oauth` always carries one.
 */
export interface PiProviderAuth {
	readonly apiKey?: { readonly login?: unknown };
	readonly oauth?: { readonly login?: unknown };
}

/** pi's `Provider`, reduced to an id, a name and its auth methods. */
export interface PiProvider {
	readonly id: string;
	readonly name: string;
	readonly auth?: PiProviderAuth;
}

/** pi's `AuthType`: a subscription login is `oauth`, an API key is `api_key`. */
export type PiAuthType = 'api_key' | 'oauth';

/** One question pi asks during a login, reduced to the shapes the editor can answer. */
export type PiAuthPrompt =
	| { readonly type: 'select'; readonly message: string; readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[] }
	| { readonly type: 'secret'; readonly message: string; readonly placeholder?: string }
	| { readonly type: 'text' | 'manual_code'; readonly message: string; readonly placeholder?: string };

/** One thing pi says during a login. */
export type PiAuthEvent =
	| { readonly type: 'info'; readonly message: string; readonly links?: readonly { readonly label?: string; readonly url: string }[] }
	| { readonly type: 'auth_url'; readonly url: string; readonly instructions?: string }
	| { readonly type: 'device_code'; readonly userCode: string; readonly verificationUri: string }
	| { readonly type: 'progress'; readonly message: string };

/** What pi calls while a login runs. The editor's dialogs are the whole interface. */
export interface PiAuthInteraction {
	prompt(prompt: PiAuthPrompt): Promise<string>;
	notify(event: PiAuthEvent): void;
}

/** The `ModelRuntime` slice this flow calls. */
export interface PiModelRuntime {
	getProviders(): readonly PiProvider[];
	isUsingOAuth(providerId: string): boolean;
	isUsingSubscription(providerId: string): boolean;
	hasConfiguredAuth(providerId: string): boolean;
	login?(providerId: string, type: PiAuthType, interaction: PiAuthInteraction): Promise<unknown>;
}

/** The SDK slice: the one step that builds a runtime over PiCode's own profile. */
export interface PiLoginSdk {
	createAgentSessionServices(options: { cwd: string; agentDir: string }): Promise<{ modelRuntime: PiModelRuntime }>;
}

/* ------------------------------------------------------------------ *
 * The list
 * ------------------------------------------------------------------ */

/** One row of the list, already written for the owner. */
export interface SubscriptionRow extends vscode.QuickPickItem {
	readonly providerId: string;
}

/**
 * The subscriptions worth putting first, in the order public sources put them.
 *
 * Only the **order** and the note are here; see the module comment for where they come from.
 */
export const FEATURED_SUBSCRIPTIONS: readonly { readonly id: string; readonly note: string }[] = [
	{ id: 'openai-codex', note: 'ChatGPT Plus or Pro' },
	{ id: 'anthropic', note: 'Claude Pro or Max' },
	{ id: 'github-copilot', note: 'GitHub Copilot' },
	{ id: 'xai', note: 'Grok or X subscription' },
	{ id: 'kimi-coding', note: 'Kimi For Coding' },
	{ id: 'openrouter', note: 'OpenRouter credits' },
];

/** The position of a provider in that order; everything else sorts after it, by name. */
export function rankOf(providerId: string): number {
	const index = FEATURED_SUBSCRIPTIONS.findIndex(featured => featured.id === providerId);
	return index === -1 ? FEATURED_SUBSCRIPTIONS.length : index;
}

/** What a row says about the account: whether there is one yet. */
export function accountState(configured: boolean): string {
	return configured ? 'already connected' : 'not connected yet';
}

/**
 * The providers pi can log in with a subscription, as rows of the list.
 *
 * A provider counts when pi gives it an OAuth login: that is what a subscription **is** here, and
 * offering a provider whose login cannot run would fail one step later for no reason. A provider
 * that already holds a credential is kept and marked — re-connecting an account is a thing people
 * do (a different account, an expired token) — and the mark is what tells them apart.
 */
export function subscriptionRows(providers: readonly PiProvider[], hasCredential: (providerId: string) => boolean): SubscriptionRow[] {
	const rows: SubscriptionRow[] = [];
	for (const provider of providers ?? []) {
		if (typeof provider?.auth?.oauth?.login !== 'function') {
			continue;
		}
		const featured = FEATURED_SUBSCRIPTIONS.find(entry => entry.id === provider.id);
		const detail = featured === undefined ? '' : `${featured.note} · `;
		rows.push({
			label: provider.name,
			description: detail + accountState(hasCredential(provider.id)),
			detail: provider.id,
			providerId: provider.id,
		});
	}
	return rows.sort((left, right) => {
		const byRank = rankOf(left.providerId) - rankOf(right.providerId);
		return byRank !== 0 ? byRank : left.label.localeCompare(right.label);
	});
}

/* ------------------------------------------------------------------ *
 * What pi says, written for the owner
 * ------------------------------------------------------------------ */

/** Thrown when the owner dismisses a prompt, so a cancelled login is not reported as a failure. */
export class LoginCancelled extends Error {
	constructor(title: string) {
		super(`Login cancelled: ${title}`);
		this.name = 'LoginCancelled';
	}
}

/** One notice, with the address to open when the event carries one. Pure, so it can be checked. */
export function noticeOf(event: PiAuthEvent): { message: string; url?: string } {
	switch (event.type) {
		case 'info': {
			const links = (event.links ?? []).map(link => (link.label === undefined ? link.url : `${link.label}: ${link.url}`));
			return { message: links.length === 0 ? event.message : `${event.message}\n${links.join('\n')}` };
		}
		case 'auth_url':
			return { message: event.instructions === undefined ? event.url : `${event.instructions}\n${event.url}`, url: event.url };
		case 'device_code':
			return { message: `Enter the code ${event.userCode} at ${event.verificationUri}`, url: event.verificationUri };
		case 'progress':
			return { message: event.message };
	}
}
