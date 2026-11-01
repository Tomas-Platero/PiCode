/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { gentleSettings, setGentleSetting, type GentleSettings } from './gentle-settings';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { externalProfileDir, importProfile, scanExternalProfile, type ImportReport, type ImportSelection, type ProfilePreview } from './profile-import';
import { NO_KEY_PLACEHOLDER, projectDeclaration } from './declarations';
import { probeEndpoint, type EndpointProbe } from './endpoint';
import { externalSdkEntry } from './piLocate';
import { searchPackages, type PackageSearchRow } from './packages-registry';
import { ensureProfilePackages } from './packages-install';
import { locateNpmCli } from './npm-run';
import { piRuntimeRoot } from './distribution-root';
import { readVoiceState, voiceManifestFor } from './voice-install';
import { homedir } from 'node:os';
import { firstExisting, importPiModule, sdkCandidates } from './piSdk';
import { FEATURED_SUBSCRIPTIONS, rankOf, type PiAuthEvent, type PiAuthPrompt, type PiModelRuntime } from './subscriptions';
import {
	buildImportSelection,
	readEditorSetting,
	readEditorSettings,
	readPackages,
	setAccountSignInOnStart,
	setAccountSignOutOnStart,
	clearAccountHandover,
	clearPendingAccountCode,
	publishAccountSession,
	clearPendingSession,
	setPendingAccountCode,
	setPendingSession,
	setContextMode,
	readProfileSettings,
	setExtras,
	setModel,
	setPackages,
	setRuntime,
	setTheme,
	writeEditorSettings,
	type SetupPaths,
} from './onboarding-settings';

/**
 * The setup window's half of the work, for everything that is about **pi itself**.
 *
 * The window that runs before the editor has no workbench and no extension host, so the
 * connector's commands (`picode.setup.*`) do not exist yet when it is on screen. Rather than
 * write a second copy of what those commands do, this module does the same job with the same
 * pieces the extension already uses — `profile-import` for the copy, `declarations` for the
 * provider projection, `endpoint` for the model list, `piLocate` for the machine's pi — and it is
 * driven by `resources/onboarding/host.cjs`, a child process the main process spawns.
 *
 * The writes themselves (settings files, the import selection, the extras whitelist) live in
 * `onboarding-settings.ts`, which has no runtime dependency on its neighbours and is therefore
 * the part a test can run on its own.
 *
 * Three rules this module cannot break:
 *
 * - **The internal profile is the only thing written.** The machine's pi profile is read by
 *   `scanExternalProfile` and by `importProfile`'s source side, and nothing else here names it.
 * - **Credentials are a flag like any other**, passed explicitly by the caller. The default for
 *   every request is "not asked for", so a forgotten field cannot import a login.
 * - **It never guesses a path.** The distribution root, the internal profile and the editor's
 *   user-data directory arrive from the main process, which is the only part that knows how the
 *   product is installed. This module has no `vscode` import for the same reason: it is run by
 *   plain node.
 */

export { HOST_ENV, EXTRA_SETTINGS, editorSettingsPath, readEditorSetting, setupPathsFromEnv, stripJsonComments, writeEditorSettings, type SetupPaths } from './onboarding-settings';

/* ------------------------------------------------------------------ *
 * The profile, as the window shows it
 * ------------------------------------------------------------------ */

/** One provider as the profile declares it, reduced to what the setup window shows. */
export interface ProviderFacts {
	readonly id: string;
	readonly endpoint?: string;
	readonly api?: string;
	/** The model ids the profile already lists for it. */
	readonly models: readonly string[];
	/** Whether a credential is stored for it in the profile's `auth.json`. */
	readonly hasKey: boolean;
}

/** The providers the internal profile declares, from `models.json` and `auth.json`. */
export function profileProviders(paths: SetupPaths): ProviderFacts[] {
	const read = (name: string): Record<string, unknown> | undefined => {
		try {
			const value: unknown = JSON.parse(readFileSync(path.join(paths.profileDir, name), 'utf8'));
			return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
		} catch {
			return undefined;
		}
	};
	const declared = read('models.json')?.['providers'];
	const providers = typeof declared === 'object' && declared !== null && !Array.isArray(declared) ? (declared as Record<string, unknown>) : {};
	const credentials = read('auth.json') ?? {};
	const rows: ProviderFacts[] = [];
	for (const [id, raw] of Object.entries(providers)) {
		const entry = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
		const models = Array.isArray(entry['models'])
			? entry['models'].flatMap(model => {
				const value = typeof model === 'string' ? model : typeof model === 'object' && model !== null ? (model as Record<string, unknown>)['id'] : undefined;
				return typeof value === 'string' && value.length > 0 ? [value] : [];
			})
			: [];
		rows.push({
			id,
			endpoint: typeof entry['baseUrl'] === 'string' ? entry['baseUrl'] : undefined,
			api: typeof entry['api'] === 'string' ? entry['api'] : undefined,
			models,
			// The placeholder a keyless provider is given is not a key: the row still says it needs none.
			hasKey: typeof credentials[id] === 'string' || (entry['apiKey'] !== undefined && entry['apiKey'] !== NO_KEY_PLACEHOLDER),
		});
	}
	return rows.sort((left, right) => left.id.localeCompare(right.id));
}

/** The version of the pi that ships inside PiCode, from its own manifest. */
export function internalPiVersion(distributionRoot: string): string | undefined {
	const manifest = path.join(distributionRoot, 'resources', 'pi-runtime', 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
	try {
		const value: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
		const version = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['version'] : undefined;
		return typeof version === 'string' ? version : undefined;
	} catch {
		return undefined;
	}
}

/** What the machine's pi is, or `undefined` when this machine has none. */
export interface ExternalPiFacts {
	readonly path: string;
	readonly version?: string;
	/** The machine's own profile — read by the import, never written. */
	readonly profileDir: string;
	readonly hasProfile: boolean;
}

/**
 * The machine's pi, found the way pi itself is found.
 *
 * `externalSdkEntry` resolves the `pi` shim on the PATH to the package behind it, which is the
 * only answer that matches what `pi` would actually run — a version read from anywhere else
 * describes a different program. No process is spawned for it: the version is the package's own.
 */
export function externalPi(): ExternalPiFacts | undefined {
	const entry = externalSdkEntry();
	if (entry === undefined) {
		return undefined;
	}
	const profileDir = externalProfileDir();
	let version: string | undefined;
	try {
		// `<package>/dist/index.js` → `<package>`.
		const manifest = path.join(path.dirname(path.dirname(entry)), 'package.json');
		const value: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
		version = typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)['version'] === 'string'
			? String((value as Record<string, unknown>)['version'])
			: undefined;
	} catch {
		version = undefined;
	}
	return { path: entry, version, profileDir, hasProfile: existsSync(profileDir) };
}

/* ------------------------------------------------------------------ *
 * The snapshot the window paints from
 * ------------------------------------------------------------------ */

/**
 * Whether this build can sign anybody in to PiCode's own account.
 *
 * Read from the distribution's `product.json`: without a web origin and a Firebase key the editor
 * registers no account provider, so a button here would be a button that cannot work.
 */
export function accountAvailable(distributionRoot: string): boolean {
	const candidates = [path.join(distributionRoot, 'resources', 'app', 'product.json'), path.join(distributionRoot, 'product.json')];
	for (const file of candidates) {
		try {
			const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
			const picode = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['picode'] : undefined;
			if (typeof picode === 'object' && picode !== null) {
				const entry = picode as Record<string, unknown>;
				if (typeof entry['webOrigin'] === 'string' && typeof entry['firebaseApiKey'] === 'string') {
					return true;
				}
			}
		} catch {
			// Try the next candidate: a dev tree keeps it at the root, a pack under resources/app.
		}
	}
	return false;
}

/** The extras step's two switches, as they are in force (each has its own default). */
export interface SetupExtras {
	readonly mcp: boolean;
	readonly context: boolean;
	/** Whether dictation is to be downloaded when the editor opens. Off unless the owner asked. */
	readonly voice: boolean;
}

/** The whole picture the window renders, in one call. */
export interface SetupSnapshot {
	readonly internalPiVersion?: string;
	readonly externalPi?: ExternalPiFacts;
	readonly extras: SetupExtras;
	/** Whether the dictation switch is worth offering: it works on this system and is not installed yet. */
	readonly voiceAvailable: boolean;
	/** Whether signing in to PiCode's own account is possible in this build. */
	readonly accountAvailable: boolean;
	/**
	 * Credentials stored in the profile with no provider declaring them.
	 *
	 * Seen in the wild: a key saved for `nan` while the only declared provider is `omni`, because
	 * the local router in front of it exposes the NAN models as its own. Without saying so, the
	 * list looks like it lost a provider that was never declared.
	 */
	readonly orphanCredentials: readonly string[];
	readonly runtime: 'internal' | 'external';
	readonly theme: string | undefined;
	readonly defaultModel: string | undefined;
	/** How much of the editor travels with a chat message (`picode.context.mode`). */
	readonly contextMode: 'project' | 'file' | 'selection';
	readonly providers: readonly ProviderFacts[];
	readonly packages: readonly string[];
}

/** Which pi runs, read from the editor's own setting. Anything else means the internal one. */
function readRuntime(paths: SetupPaths): 'internal' | 'external' {
	return readEditorSetting(paths, 'picode.pi.runtime') === 'external' ? 'external' : 'internal';
}

/** The profile's `default_model`, as pi writes it. */
function readDefaultModel(paths: SetupPaths): string | undefined {
	const settings = readProfileSettings(paths);
	const provider = settings['defaultProvider'];
	const model = settings['defaultModel'];
	if (typeof model === 'string' && model.length > 0) {
		return model.includes('/') ? model : typeof provider === 'string' && provider.length > 0 ? `${provider}/${model}` : model;
	}
	return undefined;
}

/**
 * The extras as they are in force.
 *
 * Each key carries its own default here because the declaration that used to supply one for
 * `picode.mcp.enabled` is gone (MCP is configured on its own page now). These are the defaults
 * every reader of those keys uses, so the switches show what the editor will do, not what the
 * file happens to contain.
 */
function readExtras(paths: SetupPaths): SetupExtras {
	const value = (key: string, fallback: boolean): boolean => {
		const raw = readEditorSettings(paths).value[key];
		return typeof raw === 'boolean' ? raw : fallback;
	};
	return {
		mcp: value('picode.mcp.enabled', true),
		context: value('picode.context.attach', true),
		voice: value('picode.voice.downloadOnStart', false),
	};
}

/**
 * The context mode in force.
 *
 * Read with the same fallback the product uses: anything that is not `file` or `selection` means
 * the default, so an older settings file and a fresh install report the same thing.
 */
function contextModeInForce(paths: SetupPaths): 'project' | 'file' | 'selection' {
	const value = readEditorSettings(paths).value['picode.context.mode'];
	return value === 'file' || value === 'selection' ? value : 'project';
}

/**
 * Credentials whose name is served by a declared provider anyway.
 *
 * A key saved as `nan` while the only declared provider is `omni` looks orphaned, and warning about
 * it was mostly noise: `omni` is a local router that exposes the NAN models as its own
 * (`nan-providers/…`, `NAN-…`). When the name appears as a **namespace inside** a declared
 * provider's models, that provider is what carries the key, and there is nothing to warn about.
 *
 * What is reported is the case that really is inconsistent: a credential nobody can use.
 */
function orphanCredentials(paths: SetupPaths): string[] {
	const read = (name: string): Record<string, unknown> => {
		try {
			const value: unknown = JSON.parse(readFileSync(path.join(paths.profileDir, name), 'utf8'));
			return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	};
	const declared = read('models.json')['providers'];
	const providers = typeof declared === 'object' && declared !== null ? declared as Record<string, unknown> : {};
	const providerIds = Object.keys(providers);

	// Every namespace the declared providers' models carry: `nan-providers/x` → `nan-providers`,
	// and `NAN-GLM_5.3-Flash` → `NAN`.
	const namespaces = new Set<string>();
	for (const entry of Object.values(providers)) {
		const models = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>)['models'] : undefined;
		for (const model of Array.isArray(models) ? models : []) {
			const id = typeof model === 'string' ? model : typeof model === 'object' && model !== null ? (model as Record<string, unknown>)['id'] : undefined;
			if (typeof id !== 'string' || id.length === 0) {
				continue;
			}
			const slash = id.indexOf('/');
			const head = slash === -1 ? id.split(/[-_]/)[0] : id.slice(0, slash);
			if (head.length > 0) {
				namespaces.add(head.toLowerCase());
			}
		}
	}

	return Object.keys(read('auth.json'))
		.filter(id => !providerIds.includes(id))
		.filter(id => !namespaces.has(id.toLowerCase()) && !namespaces.has(`${id.toLowerCase()}-providers`))
		.sort();
}

/** Everything the window needs to paint itself. */
export function setupSnapshot(paths: SetupPaths): SetupSnapshot {
	return {
		extras: readExtras(paths),
		voiceAvailable: readVoiceState(homedir(), voiceManifestFor(process.platform, process.arch)).kind === 'not-installed',
		accountAvailable: accountAvailable(paths.distributionRoot),
		orphanCredentials: orphanCredentials(paths),
		contextMode: contextModeInForce(paths),
		internalPiVersion: internalPiVersion(paths.distributionRoot),
		externalPi: externalPi(),
		runtime: readRuntime(paths),
		theme: readEditorSetting(paths, 'workbench.colorTheme'),
		defaultModel: readDefaultModel(paths),
		providers: profileProviders(paths),
		packages: readPackages(paths),
	};
}

/* ------------------------------------------------------------------ *
 * Adding a provider by hand
 * ------------------------------------------------------------------ */

/** What one provider request asks for. */
export interface ProviderRequest {
	readonly id: string;
	readonly endpoint: string;
	/** openai-completions | openai-responses | anthropic-messages | google-generative-ai */
	readonly api?: string;
	readonly key?: string;
	/** Whether this provider's first model becomes the profile's default. */
	readonly makeDefault?: boolean;
}

const PROVIDER_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] as const;

/**
 * Adds a provider by hand: the endpoint is asked what it has, the answer is projected into the
 * profile exactly like the settings row projects it, and the same row is written into the
 * editor's settings so the Settings page shows the provider the profile now has.
 *
 * The endpoint is asked **first**: a provider written with no models is a row that fails the
 * moment the agent picks one, so a failed question is a refusal, not a half-written provider.
 */
export async function addProvider(paths: SetupPaths, request: ProviderRequest): Promise<{ providers: ProviderFacts[]; models: string[]; defaultModel?: string; latencyMs: number }> {
	const id = typeof request.id === 'string' ? request.id.trim() : '';
	const endpoint = typeof request.endpoint === 'string' ? request.endpoint.trim() : '';
	const key = typeof request.key === 'string' ? request.key.trim() : '';
	const api = typeof request.api === 'string' && (PROVIDER_APIS as readonly string[]).includes(request.api) ? request.api : 'openai-completions';
	if (id.length === 0 || /\s/.test(id)) {
		throw new Error('the provider needs a short name with no spaces');
	}
	if (!/^https?:\/\//.test(endpoint)) {
		throw new Error('the address must start with http:// or https://');
	}
	// The endpoint is asked **first**, with the key, and its answer is the test: a key that cannot
	// list models cannot run one either. The refusal carries the reason the address gave, so the
	// window can say "the key was refused" instead of "it did not work".
	const probe = await probeEndpoint(endpoint, key.length > 0 ? key : undefined);
	if (!probe.ok) {
		throw new Error(probe.error ?? 'the address could not be used');
	}
	const modelIds = [...probe.models];
	projectDeclaration(paths.profileDir, { id, baseUrl: endpoint, api, ...(key.length > 0 ? { key } : {}) }, modelIds);

	// The same provider, in the editor's own row, so Settings shows it and the projection repeats
	// on the next model listing without this window.
	const rows = readEditorSettings(paths).value['picode.providers'];
	const list = Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null) : [];
	const next = list.filter(row => row['id'] !== id);
	next.push({ id, endpoint, api, ...(key.length > 0 ? { key } : {}) });
	writeEditorSettings(paths, { 'picode.providers': next });

	if (request.makeDefault === true) {
		setModel(paths, `${id}/${modelIds[0]}`);
	}
	return { providers: profileProviders(paths), models: modelIds, defaultModel: readDefaultModel(paths), latencyMs: probe.latencyMs };
}

/* ------------------------------------------------------------------ *
 * The import
 * ------------------------------------------------------------------ */

/** The import the window asks for: explicit items, credentials only when asked. */
export async function runImport(paths: SetupPaths, selection: ImportSelection, externalProfile: string | undefined): Promise<ImportReport & { packagesSettled?: number }> {
	const from = typeof externalProfile === 'string' && externalProfile.length > 0 ? externalProfile : externalProfileDir();
	if (path.resolve(from) === path.resolve(paths.profileDir)) {
		throw new Error('the profile to import from is already the one in use');
	}
	// Every item the caller did not name stays declined, credentials included: the flag has to be
	// `true` on the request, and nothing here fills it in.
	const report = importProfile({ from, to: paths.profileDir, selection });
	// What the import brought may declare packages. Install them now, hidden, so the first thing
	// that loads pi does not do it in front of somebody one console per package.
	await settlePackages(paths);
	return report;
}

/** What a `scan` answers: counts only, and never a credential. */
export type ScanAnswer = ProfilePreview & { readonly profile: string };

/** The scan itself. */
export function scan(externalProfile: string | undefined): ScanAnswer {
	const profile = typeof externalProfile === 'string' && externalProfile.length > 0 ? externalProfile : externalProfileDir();
	return { ...scanExternalProfile(profile), profile };
}

/* ------------------------------------------------------------------ *
 * Subscription sign-in, before the editor exists
 * ------------------------------------------------------------------ */

/** The SDK slice a login needs: the one call that builds a runtime over PiCode's profile. */
interface LoginSdk {
	createAgentSessionServices(options: { cwd: string; agentDir: string }): Promise<{ modelRuntime: PiModelRuntime }>;
}

/** One provider a subscription can be opened for. */
export interface SubscriptionChoice {
	readonly id: string;
	readonly name: string;
	/** What the subscription is, in the words the editor uses (`ChatGPT Plus or Pro`, …). */
	readonly note?: string;
	/** Whether a subscription sign-in is already stored for it in the profile. */
	readonly signedIn?: boolean;
}

/** One provider that can run models right now, with the models it offers. */
export interface AvailableProvider {
	readonly id: string;
	readonly name: string;
	readonly models: readonly string[];
	/** Signed in with a subscription, as opposed to a key or no credential at all. */
	readonly subscription: boolean;
}

/**
 * The bridge a login talks through.
 *
 * In the editor those are its quick pick and input box; here they are the setup window. pi does
 * not care which, which is exactly why this can run before any editor: `subscriptions.ts` keeps
 * the conversation and has no runtime `vscode` import.
 */
export interface LoginBridge {
	prompt(prompt: PiAuthPrompt): Promise<string>;
	notify(event: PiAuthEvent): void;
}

/**
 * Installs the profile's declared packages **before** anything loads pi.
 *
 * pi's own loader installs a declared-but-missing package the moment a session is built, one npm
 * process per package, with no `windowsHide` — so every one of them flashes a console window. The
 * connector already solved this for the editor (`packages-install.ts` exists for exactly that);
 * this calls it here so the setup window never triggers the flashing: by the time pi runs, the tree
 * is whole and its `needsInstall` check finds nothing to do.
 */
async function settlePackages(paths: SetupPaths): Promise<void> {
	try {
		await ensureProfilePackages({ profileDir: paths.profileDir, runtimeRoot: piRuntimeRoot(paths.distributionRoot), npmCli: locateNpmCli() });
	} catch {
		// A package that cannot be installed is not a reason to fail a sign-in or an import: pi will
		// try again later, and the editor's own pass reports it there.
	}
}

/** Loads pi over PiCode's own profile, or says why it could not. */
async function loginRuntime(paths: SetupPaths): Promise<PiModelRuntime> {
	// Before pi loads: no visible npm, and no per-package install behind the window.
	await settlePackages(paths);
	const entry = firstExisting(sdkCandidates(paths.distributionRoot));
	if (entry === undefined) {
		throw new Error('the pi that ships with PiCode was not found, so no provider can be signed in');
	}
	const sdk = await importPiModule<LoginSdk>(entry);
	const services = await sdk.createAgentSessionServices({ cwd: paths.distributionRoot, agentDir: paths.profileDir });
	return services.modelRuntime;
}

/**
 * The providers a subscription can be opened for.
 *
 * Filtered by what pi can actually do, not by a list of names we keep: a provider without an
 * `oauth.login` is one this button would fail on.
 */
export async function subscriptionChoices(paths: SetupPaths): Promise<SubscriptionChoice[]> {
	const runtime = await loginRuntime(paths);
	// The order is the product's, not the alphabet's: the subscriptions most people come for
	// first, then the rest by name. Same list the editor's own picker ranks by.
	return runtime
		.getProviders()
		.filter(provider => typeof provider.auth?.oauth?.login === 'function')
		.map(provider => ({
			id: provider.id,
			name: provider.name,
			note: FEATURED_SUBSCRIPTIONS.find(featured => featured.id === provider.id)?.note,
			signedIn: runtime.isUsingOAuth(provider.id),
		}))
		.sort((left, right) => rankOf(left.id) - rankOf(right.id) || left.name.localeCompare(right.name));
}

/**
 * The providers that can run models right now, as pi itself sees them.
 *
 * Asked of pi's own model registry, not read from `models.json`: a provider that arrives with a
 * package (NAN) and one that is signed in with a subscription (Anthropic) are not declared in that
 * file, and a model id's prefix is not a provider. Each provider is listed once, with its own models.
 */
export async function availableProviders(paths: SetupPaths): Promise<AvailableProvider[]> {
	const runtime = await loginRuntime(paths);
	const models = typeof runtime.getAvailable === 'function' ? await runtime.getAvailable() : [];
	const names = new Map(runtime.getProviders().map(provider => [provider.id, provider.name] as const));
	const grouped = new Map<string, string[]>();
	for (const model of models) {
		const list = grouped.get(model.provider) ?? [];
		list.push(model.id);
		grouped.set(model.provider, list);
	}
	return [...grouped.entries()]
		.map(([id, ids]) => ({ id, name: names.get(id) ?? id, models: ids, subscription: runtime.isUsingOAuth(id) }))
		.sort((left, right) => rankOf(left.id) - rankOf(right.id) || left.name.localeCompare(right.name));
}

/**
 * Runs one subscription sign-in, writing the credential into the profile.
 *
 * pi opens nothing by itself in a headless process: it hands out a URL (or a device code) through
 * `notify`, and the window decides what to show and what to open. The credential lands where the
 * editor expects it — the profile — because that is pi's own store, not a copy of it.
 */
export async function loginProvider(paths: SetupPaths, providerId: string, bridge: LoginBridge): Promise<void> {
	const id = typeof providerId === 'string' ? providerId.trim() : '';
	if (id.length === 0) {
		throw new Error('a sign-in needs a provider');
	}
	const runtime = await loginRuntime(paths);
	if (typeof runtime.login !== 'function') {
		throw new Error('this pi cannot sign a provider in; updating pi is what brings that');
	}
	await runtime.login(id, 'oauth', { prompt: bridge.prompt, notify: bridge.notify });
}

/* ------------------------------------------------------------------ *
 * The protocol
 * ------------------------------------------------------------------ */

/** What the setup window asks for; one command per round trip. */
export type HostCommand =
	| 'state'
	| 'scan'
	| 'import'
	| 'addProvider'
	| 'setModel'
	| 'setTheme'
	| 'setRuntime'
	| 'setPackages'
	| 'setExtras'
	| 'setContextMode'
	| 'clearHandover'
	| 'publishSession'
	| 'setAccountSignIn'
	| 'setAccountSignOut'
	| 'setPendingCode'
	| 'setPendingSession'
	| 'clearPendingSession'
	| 'clearPendingCode'
	| 'searchPackages'
	| 'subscriptions'
	| 'availableProviders'
	| 'gentle'
	| 'setGentle';

/**
 * What one command answers.
 *
 * One member per command, so the window's side of the protocol is a type rather than a shrug:
 * every answer that changes anything carries the fresh snapshot, which is what lets the window
 * repaint from the truth on disk instead of from what it hoped it had written.
 */
export type HostAnswer =
	| SetupSnapshot
	| ScanAnswer
	| { readonly report: ImportReport & { packagesSettled?: number }; readonly snapshot: SetupSnapshot }
	| { readonly providers: readonly ProviderFacts[]; readonly models: readonly string[]; readonly defaultModel?: string; readonly latencyMs: number; readonly snapshot: SetupSnapshot }
	| { readonly packages: readonly string[]; readonly snapshot: SetupSnapshot }
	| { readonly extras: Record<string, boolean>; readonly snapshot: SetupSnapshot }
	| { readonly mode: string; readonly snapshot: SetupSnapshot }
	| EndpointProbe
	| readonly PackageSearchRow[]
	| readonly SubscriptionChoice[]
	| readonly AvailableProvider[]
	| GentleSettings
	| { readonly snapshot: SetupSnapshot };

/** One round trip: a command name and its JSON payload, answered with a JSON value. */
export async function runHostCommand(paths: SetupPaths, command: string, payload: Record<string, unknown>): Promise<HostAnswer> {
	const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');
	const listOf = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
	switch (command) {
		case 'state':
			return setupSnapshot(paths);
		case 'scan':
			return scan(stringOf(payload['profile']));
		case 'import':
			return {
				report: await runImport(
					paths,
					// The card's ticks arrive as a list; the rules for turning them into a selection
					// (and the one that keeps credentials off unless asked) live in `onboarding-settings`.
					buildImportSelection(listOf(payload['items']), payload['credentials'] === true),
					stringOf(payload['profile']) || undefined,
				),
				snapshot: setupSnapshot(paths),
			};
		case 'addProvider':
			return {
				...await addProvider(paths, payload['request'] as ProviderRequest),
				snapshot: setupSnapshot(paths),
			};
		case 'setModel':
			setModel(paths, stringOf(payload['ref']));
			return { snapshot: setupSnapshot(paths) };
		case 'setTheme':
			setTheme(paths, stringOf(payload['id']));
			return { snapshot: setupSnapshot(paths) };
		case 'setRuntime':
			setRuntime(paths, stringOf(payload['runtime']));
			return { snapshot: setupSnapshot(paths) };
		case 'setPackages':
			return {
				packages: setPackages(paths, { add: listOf(payload['add']), remove: listOf(payload['remove']) }),
				snapshot: setupSnapshot(paths),
			};
		case 'clearPendingCode':
			clearPendingAccountCode(paths);
			return { snapshot: setupSnapshot(paths) };
		case 'setPendingSession': {
			const session = payload['session'] as { refreshToken?: string; uid?: string; email?: string } | undefined;
			setPendingSession(paths, {
				refreshToken: typeof session?.refreshToken === 'string' ? session.refreshToken : '',
				uid: typeof session?.uid === 'string' ? session.uid : '',
				email: typeof session?.email === 'string' ? session.email : '',
			});
			return { snapshot: setupSnapshot(paths) };
		}
		case 'clearPendingSession':
			clearPendingSession(paths);
			return { snapshot: setupSnapshot(paths) };
		case 'setPendingCode':
			setPendingAccountCode(paths, stringOf(payload['code']));
			return { snapshot: setupSnapshot(paths) };
		case 'setAccountSignOut':
			setAccountSignOutOnStart(paths);
			return { snapshot: setupSnapshot(paths) };
		case 'clearHandover':
			clearAccountHandover(paths);
			return { snapshot: setupSnapshot(paths) };
		case 'publishSession':
			publishAccountSession(paths, stringOf(payload['email']));
			return { snapshot: setupSnapshot(paths) };
		case 'setAccountSignIn':
			setAccountSignInOnStart(paths);
			return { snapshot: setupSnapshot(paths) };
		case 'setContextMode':
			return { mode: setContextMode(paths, stringOf(payload['mode'])), snapshot: setupSnapshot(paths) };
		case 'testProvider':
			// Asked, never written: this is what the "Test connection" button does, and a test that
			// saved a provider would be a very expensive button.
			return probeEndpoint(stringOf(payload['endpoint']), stringOf(payload['key']) || undefined);
		case 'setExtras':
			return {
				extras: setExtras(paths, typeof payload['values'] === 'object' && payload['values'] !== null ? payload['values'] as Record<string, unknown> : {}),
				snapshot: setupSnapshot(paths),
			};
		case 'subscriptions':
			return subscriptionChoices(paths);
		case 'availableProviders':
			return availableProviders(paths);
		case 'gentle':
			return gentleSettings(paths.profileDir);
		case 'setGentle':
			return setGentleSetting(paths.profileDir, { key: payload['key'], value: payload['value'] });
		case 'searchPackages': {
			const query = stringOf(payload['query']).trim();
			return query.length === 0 ? [] : await searchPackages(query);
		}
		default:
			throw new Error(`unknown setup command: ${command}`);
	}
}
