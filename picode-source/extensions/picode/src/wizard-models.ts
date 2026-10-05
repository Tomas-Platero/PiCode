/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { fetchModelIds } from './endpoint';
import { loadPiSdk } from './piSdk';
import { ensureProfilePackages } from './packages-install';
import { locateNpmCli } from './npm-run';
import { projectDeclaration } from './declarations';

/**
 * The wizard's provider and model plumbing.
 *
 * Two questions the welcome page asks once, answered here:
 *
 * - **A provider, two ways.** By subscription (pi's own OAuth login flow, already
 *   registered as `picode.connectProvider`) or by hand (name, endpoint, dialect, key) —
 *   a hand-written provider is projected into PiCode's profile (`models.json` +
 *   `auth.json`) exactly like the settings row does, so pi can use it.
 * - **The model.** "Traerse los del proveedor": the list is fetched, not typed — from the
 *   provider's own `/models` endpoint for a hand-written one, from pi's catalogue for a
 *   subscription. The owner's pick becomes the profile's `default_model` (pi's own
 *   setting), which is what a session uses before anyone picks anything.
 */

export const PROVIDER_ADD_COMMAND = 'picode.setup.providerAddManual';
export const MODELS_LIST_COMMAND = 'picode.setup.modelsList';
export const MODEL_DEFAULT_COMMAND = 'picode.setup.modelDefault';

export interface WizardModelDeps {
	readonly distributionRoot: string;
	readonly profileDir: string;
	/** Fires the editor's model refresh after a provider lands. */
	readonly refreshModels: () => void;
}

/* ------------------------------------------------------------------ *
 * The provider, by hand
 * ------------------------------------------------------------------ */

export interface ManualProvider {
	readonly id: string;
	readonly endpoint: string;
	/** openai-completions | openai-responses | anthropic-messages | google-generative-ai */
	readonly api: string;
	/** The key, or empty for an endpoint that needs none. */
	readonly key?: string;
}

/** One model of the fetched list, as the picker shows it. */
export interface WizardModel {
	/** `provider/model-id` — the ref pi understands. */
	readonly ref: string;
	readonly provider: string;
	readonly model: string;
}

/** The dialects the editor's own provider form offers, in the same words. */
const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] as const;

export async function addManualProvider(deps: WizardModelDeps, request: unknown): Promise<{ models: WizardModel[] }> {
	const req = request as Partial<ManualProvider> | undefined;
	const id = typeof req?.id === 'string' ? req.id.trim() : '';
	const endpoint = typeof req?.endpoint === 'string' ? req.endpoint.trim() : '';
	const api = typeof req?.api === 'string' && (APIS as readonly string[]).includes(req.api) ? req.api : 'openai-completions';
	const key = typeof req?.key === 'string' ? req.key : '';
	if (id.length === 0 || /\s/.test(id)) {
		throw new Error('the provider needs a short name with no spaces');
	}
	if (!/^https?:\/\//.test(endpoint)) {
		throw new Error('the endpoint must be an http(s) address');
	}

	const modelIds = await fetchModelIds(endpoint, key.length > 0 ? key : undefined);
	if (modelIds === undefined || modelIds.length === 0) {
		throw new Error('the endpoint answered no models — check the address and the key');
	}

	// Projected into PiCode's profile exactly like the settings row projects: models.json
	// for what the provider is, auth.json for the key. pi can then run every model listed.
	projectDeclaration(deps.profileDir, { id, baseUrl: endpoint, api, key: key.length > 0 ? key : undefined }, modelIds);

	// Persisted in the editor's own providers row too, so the settings form shows it and
	// the projection repeats on every model listing without the wizard.
	const configuration = vscode.workspace.getConfiguration('picode');
	const rows = configuration.get<Array<Record<string, string>>>('providers', []);
	const next = rows.filter(row => row['id'] !== id);
	next.push({ id, endpoint, api, ...(key.length > 0 ? { key } : {}) });
	await configuration.update('providers', next, vscode.ConfigurationTarget.Global);
	deps.refreshModels();

	return { models: modelIds.map(mid => ({ ref: `${id}/${mid}`, provider: id, model: mid })) };
}

/* ------------------------------------------------------------------ *
 * The model list: the provider's own, fetched
 * ------------------------------------------------------------------ */

interface CatalogShape {
	readonly modelRuntime: {
		readonly getProviders?: () => ReadonlyArray<{ readonly id: string; readonly name?: string }>;
		readonly hasConfiguredAuth?: (providerId: string) => boolean;
		readonly getModels?: (providerId?: string) => ReadonlyArray<{ readonly id: string; readonly name?: string }>;
	};
}

interface RuntimeSdk {
	createAgentSessionServices(options: { cwd: string; agentDir?: string }): Promise<CatalogShape>;
}

/** The models of the setup: the profile's providers and pi's logged-in catalogue. */
export async function listModels(deps: WizardModelDeps): Promise<{ models: WizardModel[] }> {
	const models = new Map<string, WizardModel>();
	const push = (provider: string, mid: string, name?: string): void => {
		const ref = `${provider}/${mid}`;
		if (!models.has(ref)) {
			models.set(ref, { ref, provider, model: name && name !== mid ? `${mid} · ${name}` : mid });
		}
	};

	// The hand-written providers, from the settings row the wizard appended to.
	const rows = vscode.workspace.getConfiguration('picode').get<Array<Record<string, string>>>('providers', []);
	for (const row of rows) {
		if (typeof row['id'] !== 'string' || typeof row['endpoint'] !== 'string') { continue; }
		const ids = await fetchModelIds(row['endpoint'], typeof row['key'] === 'string' && row['key'].length > 0 ? row['key'] : undefined);
		for (const mid of ids ?? []) {
			push(row['id'], mid);
		}
	}

	// The subscriptions: pi's catalogue, for the providers that hold a credential in
	// PiCode's own profile.
	const loaded = await loadPiSdk<RuntimeSdk>(sdkCandidatesFor(deps.distributionRoot));
	if (!('problem' in loaded) && typeof loaded.sdk?.createAgentSessionServices === 'function') {
		try {
			// Before pi loads anything: the profile's declared-but-missing packages are installed
			// here (hidden, one run) so pi's loader never installs one itself — its per-package
			// installs each flashed a console window on Windows.
			await ensureProfilePackages({ profileDir: deps.profileDir, npmCli: locateNpmCli() });
			const services = await loaded.sdk.createAgentSessionServices({
				cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
				agentDir: deps.profileDir,
			});
			const runtime = services.modelRuntime;
			for (const provider of runtime.getProviders?.() ?? []) {
				if (runtime.hasConfiguredAuth !== undefined && !runtime.hasConfiguredAuth(provider.id)) { continue; }
				for (const model of runtime.getModels?.(provider.id) ?? []) {
					if (typeof model.id === 'string' && model.id.length > 0) {
						push(provider.id, model.id, typeof model.name === 'string' ? model.name : undefined);
					}
				}
			}
		} catch {
			// No catalogue from pi: the manual providers above still answer.
		}
	}

	return { models: [...models.values()].sort((a, b) => a.ref.localeCompare(b.ref)) };
}

function sdkCandidatesFor(distributionRoot: string): string[] {
	return [
		path.join(distributionRoot, 'resources', 'pi-runtime', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js'),
		path.join(distributionRoot, 'resources', 'app', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js'),
	];
}

/* ------------------------------------------------------------------ *
 * The default model (pi's own setting in the profile)
 * ------------------------------------------------------------------ */

export function setDefaultModel(deps: WizardModelDeps, ref: unknown): void {
	if (typeof ref !== 'string' || !ref.includes('/')) {
		throw new Error('PiCode: the default model is provider/model.');
	}
	const slash = ref.indexOf('/');
	editProfileSettings(deps, settings => {
		settings['defaultProvider'] = ref.slice(0, slash);
		settings['defaultModel'] = ref;
	});
	rememberChatDefault(ref);
}

/**
 * Makes the chat open on the model the wizard just chose.
 *
 * pi's own default (`defaultProvider` + `defaultModel` in the profile) is what a session runs once
 * it starts, but the editor seeds a **new conversation** from its own `chat.defaultModel`, and
 * nothing wrote it: the model the owner picked in the wizard and the one the chat opened with
 * could disagree. The editor compares a full `provider/model` ref, which is the shape the model
 * list already hands it.
 *
 * Written, not awaited: the step has done its job once pi's default is on disk, and an editor
 * whose settings cannot be written is not a reason to fail it.
 */
function rememberChatDefault(ref: string): void {
	void vscode.workspace.getConfiguration('chat')
		.update('defaultModel', ref, vscode.ConfigurationTarget.Global)
		.then(undefined, () => {
			// The profile's default is the one the chat falls back to; nothing to repair here.
		});
}

/* ------------------------------------------------------------------ *
 * The profile's settings.json — pi's own configuration
 * ------------------------------------------------------------------ */

function editProfileSettings(deps: WizardModelDeps, edit: (settings: Record<string, unknown>) => void): void {
	const file = path.join(deps.profileDir, 'settings.json');
	let settings: Record<string, unknown> = {};
	try {
		const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			settings = value as Record<string, unknown>;
		}
	} catch {
		// A fresh profile has no file yet; the first write creates it.
	}
	edit(settings);
	writeFileSync(file, JSON.stringify(settings, undefined, '\t') + '\n');
}

/** Registers the wizard's provider/model commands. */
export function registerWizardModelCommands(deps: WizardModelDeps): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(PROVIDER_ADD_COMMAND, (request: unknown) => addManualProvider(deps, request)),
		vscode.commands.registerCommand(MODELS_LIST_COMMAND, () => listModels(deps)),
		vscode.commands.registerCommand(MODEL_DEFAULT_COMMAND, (ref: unknown) => setDefaultModel(deps, ref)),
	];
}
