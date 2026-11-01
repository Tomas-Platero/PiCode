/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { getSessionUsage, liveSessionMcpServers } from './agent';
import { declarationsFromSetting, isRecord } from './declarations';
import { providerInventory } from './providers-list';
import { probeExternalPi, readInternalPiVersion } from './onboarding';
import { readPiChatSettings } from './piConfig';
import { discoveredMcpServers, mergeMcpServers, mcpServerStates, type McpAuthFile } from './mcp-provider';
import { externalProfileDir } from './profile-import';
import { internalProfileDir, readRuntimeMode, resolveProjectScope } from './runtime';
import { STATUS_DATA_COMMAND, USAGE_PANEL_COMMAND, type UsagePanelData, type UsagePanelModel, type BackgroundJobStatus, type McpServerSwitch, type StatusData, type SubscriptionStatus } from './status-contract';
import { isOurEngramDeclaration } from './engram';
import { parseSnapshot, UPDATES_STATE_KEY } from './updates-check';
import type { VoiceStatus } from './voice-controller';
import { firstNanProvider, getCachedNanUsage, type CachedNanUsage, matchedNanProvider, NAN_PROVIDER_ID, nanAccountMeters, nanModelUsage, resolveNanApiKey, spokenWindowLabel, type NanUsageLimit } from './usage-data';
import { ANTHROPIC_PROVIDER, CODEX_PROVIDER, codexSignIn, getCachedCodexUsage, newestUsage, usageFromResponses, type ProviderUsage } from './subscription-usage';

/**
 * The data behind PiCode's status surface.
 *
 * One call answers the whole surface: the pi in force and its version, the providers pi has, the
 * default model, the MCP servers, the session's usage and cost, and the project's branch, pending
 * files and diff totals. `status-contract.ts` is the shape and nothing else is: the Status section
 * of the Agent Customizations page, the MCP Servers section and the providers list in Settings all
 * read this one answer.
 *
 * ## The profile **in force**, not always PiCode's own
 *
 * Everything read from a profile follows the runtime the owner chose (`runtime.ts`): with the
 * internal pi it is PiCode's own (`data/pi-agent`); with the external pi it is that pi's own
 * profile on the machine, which this editor only ever reads. Reading the internal profile under
 * an external runtime would print another pi's version and models under an "External" label,
 * which is the kind of number this view exists not to invent.
 *
 * ## Nothing is invented
 *
 * A fact the connector cannot obtain stays `undefined`, and the tree draws its placeholder for
 * it. The session rows come from the chat's live session (`agent.ts`): before the first turn
 * there is no context usage, so `ctxTokens` is left out and the view honestly says "No turns
 * yet" rather than printing a zero it does not have.
 *
 * The project's git follows the project scope in force (`runtime.ts`): in folder mode it is
 * the single answer it has always been; in workspace mode every folder of the area is read
 * and answered as its own row, because the area is the project the owner is looking at.
 */

/** Where the answer is built from. */
export interface StatusDeps {
	/** The distribution root: where PiCode's own pi runtime and its profile live. */
	readonly distributionRoot: string;
	/**
	 * The editor's own storage, which is where the update check leaves its last answer
	 * (`updates-check.ts`). The panel reads that answer; it never runs the lookup itself.
	 */
	readonly globalState: vscode.Memento;
	/**
	 * The chat's background jobs still running (`background-jobs.ts`, the pill's own source): what
	 * the Tasks block lists as the work the chat itself launched. Read live per refresh — the
	 * tracker is the one holder of the truth, and the panel only draws it.
	 */
	readonly runningJobs: () => readonly BackgroundJobStatus[];
	/** Dictation's state, read live per refresh from `voice-controller.ts`: a download's progress moves between refreshes. */
	readonly voice: () => VoiceStatus;
}

/** Reads a JSON object from a file, treating "missing or malformed" as "nothing there". */
function readJsonObject(file: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
		return isRecord(value) ? value : undefined;
	} catch {
		// A profile that is absent or half-written is "no fact yet", not an error to surface.
		return undefined;
	}
}

/**
 * The three places the editor learns of a provider, kept apart instead of merged into a count.
 *
 * They are not the same thing, and merging them is what made the panel say «Providers 2» while the
 * settings page listed one row — the page edits **declarations**, and a provider pi itself carries
 * (models in its profile, a sign-in in its credentials) has nothing there to edit. The owner read the
 * disagreement as a missing provider; the panel now answers *which* two and why
 * (`providers-list.ts`, which owns the rule and is tested).
 */
function providerSources(profileDir: string): { declared: string[]; models: string[]; credentials: string[]; subscriptions: string[] } {
	const configuration = vscode.workspace.getConfiguration('picode');
	const declared = declarationsFromSetting(configuration.get('providers') ?? configuration.get('pi.providers'))
		.map(declaration => declaration.id);

	const models = readJsonObject(path.join(profileDir, 'models.json'))?.['providers'];
	const auth = readJsonObject(path.join(profileDir, 'auth.json'));

	return {
		declared,
		models: isRecord(models) ? Object.keys(models) : [],
		credentials: auth === undefined ? [] : Object.keys(auth),
		// A subscription sign-in is stored as an `oauth` credential; a key is `api_key`.
		subscriptions: auth === undefined ? [] : Object.entries(auth).flatMap(([id, value]) => isRecord(value) && value['type'] === 'oauth' ? [id] : []),
	};
}

/** The profile's `mcp-auth.json`, as the sign-in rule wants it: looked at, whatever it holds. */
function mcpAuthFile(file: string): McpAuthFile {
	try {
		return { text: readFileSync(file, 'utf8') };
	} catch {
		// A missing or unreadable file is "no stored sign-in", not an error (`mcp-provider.ts`).
		return { text: undefined };
	}
}

/**
 * pi's MCP servers in the profile, one row each: the name, whether pi will start it, and
 * whether pi can actually use it (`mcp-provider.ts`).
 *
 * The sign-in file of the profile in force is only read where it **may** be: PiCode's own
 * profile, the internal one. The external pi's directory is off-limits to this connector, so
 * under an external runtime the sign-in fact is left `unknown` for the servers it would
 * matter to — the row says so instead of defaulting to `On`.
 */
function readMcpServers(profileDir: string, runtime: 'internal' | 'external'): readonly McpServerSwitch[] {
	const servers = readJsonObject(path.join(profileDir, 'mcp.json'))?.['mcpServers'];
	const authFile: McpAuthFile | undefined = runtime === 'internal'
		? mcpAuthFile(path.join(profileDir, 'mcp-auth.json'))
		: undefined;
	const byName = isRecord(servers) ? servers : undefined;
	return mcpServerStates(byName, authFile, Date.now())
		.map(row => ({
			...row,
			origin: 'profile' as const,
			// The memory engine's entry is this product's own declaration (`engram.ts`), not a server
			// the owner added or can manage. It is marked so the MCP section leaves it out: a row the
			// owner never created, with an address they cannot edit, is a row that only confuses.
			...(byName !== undefined && isOurEngramDeclaration(byName[row.name]) ? { internal: true } : {}),
		}));
}

/**
 * The project's own `.pi/mcp.json` servers, when pi would load them.
 *
 * pi only reads the project's file for a **trusted** workspace, so an untrusted one yields
 * nothing here — listing servers pi will not start would promise tools that never arrive.
 * The rows carry no sign-in fact: the profile's sign-in file has nothing to say about a
 * server the project declares, and guessing would print a state the owner cannot act on.
 */
function readProjectMcpServers(): readonly McpServerSwitch[] {
	if (!vscode.workspace.isTrusted) {
		return [];
	}
	const scope = resolveProjectScope();
	const folders = (scope.mode === 'workspace' ? scope.folders : [scope.cwd])
		.filter((folder): folder is string => folder !== undefined);
	const rows: McpServerSwitch[] = [];
	for (const folder of folders) {
		const servers = readJsonObject(path.join(folder, '.pi', 'mcp.json'))?.['mcpServers'];
		if (!isRecord(servers)) {
			continue;
		}
		for (const [name, entry] of Object.entries(servers)) {
			rows.push({ name, on: !(isRecord(entry) && entry['enabled'] === false), origin: 'project' });
		}
	}
	return rows;
}

/** The profile's default model, from pi's own `settings.json`. */
export function readDefaultModel(profileDir: string): string | undefined {
	const settings = readJsonObject(path.join(profileDir, 'settings.json'));
	const value = settings?.['defaultModel'];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The context window for a `provider/modelId` reference, from the profile's `models.json`. */
function readContextWindow(profileDir: string, modelRef: string | undefined): number | undefined {
	if (modelRef === undefined || !modelRef.includes('/')) {
		return undefined;
	}
	const slash = modelRef.indexOf('/');
	const providerId = modelRef.slice(0, slash);
	const modelId = modelRef.slice(slash + 1);
	const models = readJsonObject(path.join(profileDir, 'models.json'));
	const providers = models?.['providers'];
	const provider = isRecord(providers) ? providers[providerId] : undefined;
	const list = isRecord(provider) ? provider['models'] : undefined;
	if (!Array.isArray(list)) {
		return undefined;
	}
	for (const model of list) {
		if (isRecord(model) && model['id'] === modelId) {
			const window = model['contextWindow'];
			return typeof window === 'number' ? window : undefined;
		}
	}
	return undefined;
}

/** Runs one git command in a folder; `undefined` when git is absent or the folder is not a repo. */
function git(folder: string, args: readonly string[]): Promise<string | undefined> {
	return new Promise(resolve => {
		execFile('git', [...args], { cwd: folder, windowsHide: true, timeout: 5000 }, (error, stdout) => {
			resolve(error === null && typeof stdout === 'string' ? stdout : undefined);
		});
	});
}

/**
 * Sums the added/removed columns of `git diff --numstat`; `-` binary rows and malformed lines
 * are skipped because they carry no line count.
 */
function sumNumstat(output: string): { insertions: number; deletions: number } {
	let insertions = 0;
	let deletions = 0;
	for (const line of output.split('\n')) {
		if (line.trim().length === 0) {
			continue;
		}
		const [added, removed] = line.split('\t');
		const add = Number(added);
		const del = Number(removed);
		if (Number.isFinite(add)) { insertions += add; }
		if (Number.isFinite(del)) { deletions += del; }
	}
	return { insertions, deletions };
}

/** The project's branch, pending files and diff totals, or `undefined` for each fact git cannot give. */
async function readGit(folder: string | undefined): Promise<{ branch?: string; changes?: number; insertions?: number; deletions?: number }> {
	if (folder === undefined) {
		return {};
	}
	const [branch, status, numstat] = await Promise.all([
		git(folder, ['rev-parse', '--abbrev-ref', 'HEAD']),
		git(folder, ['status', '--porcelain']),
		git(folder, ['diff', 'HEAD', '--numstat']),
	]);
	const diff = numstat === undefined ? undefined : sumNumstat(numstat);
	return {
		...(branch === undefined ? {} : { branch: branch.trim() }),
		...(status === undefined ? {} : { changes: status.split('\n').filter(line => line.trim().length > 0).length }),
		...(diff === undefined ? {} : { insertions: diff.insertions, deletions: diff.deletions }),
	};
}

/** The version of the pi actually in force: PiCode's own, or the machine's when that one is chosen. */
async function readPiVersion(mode: 'internal' | 'external', distributionRoot: string): Promise<string | undefined> {
	if (mode === 'external') {
		const info = await probeExternalPi();
		return info.found ? info.version : undefined;
	}
	return readInternalPiVersion(distributionRoot);
}

/**
 * The provider and model the live session is on.
 *
 * pi's entries carry the two as one `provider/modelId` reference (`agent.ts`), which is what
 * this splits: the provider id is matched against the declarations, the model id picks the
 * meter. A reference that is not one — no slash, or one at either end — is no answer at all.
 */
function currentModelRef(model: string | undefined): { provider: string; model: string } | undefined {
	if (model === undefined) {
		return undefined;
	}
	const slash = model.indexOf('/');
	if (slash <= 0 || slash === model.length - 1) {
		return undefined;
	}
	return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

/**
 * The credential pi's own `auth.json` holds for a provider.
 *
 * The file is pi's, so both shapes found there are read: the record `declarations.ts` itself
 * writes (`{ type, key }`) and a bare string. Anything else — an OAuth entry, a malformed
 * value — is not a key and is left alone.
 */
function storedApiKey(profileDir: string, providerId: string): string | undefined {
	const entry = readJsonObject(path.join(profileDir, 'auth.json'))?.[providerId];
	if (typeof entry === 'string' && entry.length > 0) {
		return entry;
	}
	if (isRecord(entry)) {
		const key = entry['key'];
		if (typeof key === 'string' && key.length > 0) {
			return key;
		}
	}
	return undefined;
}

/**
 * The subscription-usage row: the provider's own quota for the model in use, or `undefined`
 * when there is no honest row to print.
 *
 * Three things must all hold before anything is drawn, and each failing one means **no row**
 * rather than a placeholder: the session must be on a provider the settings declare **and**
 * that declaration must be NaN's, and a credential must be resolvable. Showing another
 * provider's meter under the session's model would be a number the owner cannot act on.
 *
 * Once those hold, the block is worth showing even before the first turn: the meter is live
 * provider data, not session data. ChatGPT and Claude are read by `readAccountSubscriptions`, which
 * is what the card draws whenever it has anything; this row is only its fallback.
 */
async function readSubscription(profileDir: string, model: string | undefined): Promise<SubscriptionStatus | undefined> {
	const current = currentModelRef(model);
	if (current === undefined) {
		return undefined;
	}
	const declared = declarationsFromSetting(vscode.workspace.getConfiguration('picode').get('providers'));
	// NaN's own pi package registers the provider without any settings line: its id is enough, and
	// the key is the one pi stored for it.
	const provider = matchedNanProvider(declared, current.provider)
		?? (current.provider === NAN_PROVIDER_ID ? { id: NAN_PROVIDER_ID, key: undefined } : undefined);
	if (provider === undefined) {
		return undefined;
	}
	const apiKey = resolveNanApiKey({
		declared: provider.key,
		environment: process.env,
		stored: storedApiKey(profileDir, provider.id),
	});
	if (apiKey === undefined) {
		return undefined;
	}
	const cached = await getCachedNanUsage(apiKey, Date.now());
	const limit = cached.value === undefined ? undefined : nanModelUsage(cached.value, current.model);
	if (limit === undefined || limit.windows.length === 0) {
		// A read that names no meter for this model says nothing: no section, not an empty one.
		return undefined;
	}
	return toSubscriptionStatus(limit, cached.fresh);
}

/** One meter as the panel draws it: the tightest window first, because it runs out first. */
function toSubscriptionStatus(limit: NanUsageLimit, fresh: boolean): SubscriptionStatus {
	const labelled = limit.windows.filter(window => window.label.length > 0).sort((left, right) => left.windowSeconds - right.windowSeconds);
	const unlabelled = limit.windows.filter(window => window.label.length === 0);
	return {
		meter: limit.name,
		windows: [...labelled, ...unlabelled].map(window => ({
			label: window.label.length > 0 ? `${spokenWindowLabel(window.label)} window` : 'billing period',
			usedPercent: window.usedPercent,
			resetAt: window.resetAt,
			...(window.used === undefined || window.budget === undefined ? {} : { used: window.used, cap: window.budget }),
		})),
		limitReached: limit.limitReached,
		fresh,
	};
}

/** NaN's quota for the account the profile holds a key for, or `undefined` when there is none. */
async function readNanAccount(profileDir: string): Promise<CachedNanUsage | undefined> {
	const declared = declarationsFromSetting(vscode.workspace.getConfiguration('picode').get('providers'));
	const carried = readJsonObject(path.join(profileDir, 'models.json'))?.['providers'];
	const refs: { id: string; baseUrl: string; key?: string }[] = [
		...declared.map(declaration => ({ id: declaration.id, baseUrl: declaration.baseUrl, key: declaration.key })),
		...(isRecord(carried)
			? Object.entries(carried).map(([id, entry]) => ({
				id,
				baseUrl: isRecord(entry) && typeof entry['baseUrl'] === 'string' ? entry['baseUrl'] : '',
				key: isRecord(entry) && typeof entry['apiKey'] === 'string' ? entry['apiKey'] : undefined,
			}))
			: []),
	];
	// NaN's own pi package registers the provider with no settings line and no model list entry:
	// the key pi stored for it is what says it is there.
	const provider = firstNanProvider(refs)
		?? (storedApiKey(profileDir, NAN_PROVIDER_ID) === undefined ? undefined : { id: NAN_PROVIDER_ID, baseUrl: '', key: undefined });
	if (provider === undefined) {
		return undefined;
	}
	const apiKey = resolveNanApiKey({
		declared: provider.key,
		environment: process.env,
		stored: storedApiKey(profileDir, provider.id),
	});
	if (apiKey === undefined) {
		return undefined;
	}
	return getCachedNanUsage(apiKey, Date.now());
}

/**
 * The account's whole allowance: NaN's metered models, ChatGPT's and Claude's windows, the
 * provider the chat is on first, whichever provider's model is answering right now.
 *
 * A quota belongs to the account, so it is worth seeing while another provider's model is the one
 * in the chat — the case the one-meter rule above leaves empty. NaN is found where the owner may
 * have put it: declared in the settings, or only carried in the profile's own model list. ChatGPT
 * and Claude come from `subscription-usage.ts`. A provider with nothing to read draws nothing.
 */
async function readAccountSubscriptions(profileDir: string, model: string | undefined): Promise<readonly SubscriptionStatus[] | undefined> {
	const current = currentModelRef(model);
	const cached = await readNanAccount(profileDir);
	const nan = cached?.value === undefined
		? []
		: nanAccountMeters(cached.value, current?.model)
			.filter(limit => limit.windows.length > 0)
			.map(limit => toSubscriptionStatus(limit, cached.fresh));
	const groups: { provider: string; meters: SubscriptionStatus[] }[] = [
		{ provider: NAN_PROVIDER_ID, meters: nan },
		{ provider: CODEX_PROVIDER, meters: await readCodexMeters(profileDir) },
		{ provider: ANTHROPIC_PROVIDER, meters: signInMeters(usageFromResponses(ANTHROPIC_PROVIDER), true) },
	];
	// The provider the chat is on leads; the rest keep their order, so the card does not reshuffle.
	const ordered = [...groups.filter(group => group.provider === current?.provider), ...groups.filter(group => group.provider !== current?.provider)];
	const meters = ordered.flatMap(group => group.meters.map(meter => ({
		...meter,
		provider: group.provider,
		// NaN may be declared under another id (`omni`), so its meter is matched by the model name.
		current: group.provider === NAN_PROVIDER_ID ? meter.meter === current?.model : group.provider === current?.provider,
	})));
	return meters.length > 0 ? meters : undefined;
}

/**
 * ChatGPT's allowances: Codex's usage endpoint, read with the sign-in pi holds, merged with what the
 * last ChatGPT response reported — whichever is newer. Nothing when there is neither.
 */
async function readCodexMeters(profileDir: string): Promise<SubscriptionStatus[]> {
	const now = Date.now();
	const signIn = codexSignIn(readJsonObject(path.join(profileDir, 'auth.json'))?.[CODEX_PROVIDER], now);
	const endpoint = signIn === undefined ? undefined : await getCachedCodexUsage(signIn, now);
	const usage = newestUsage(endpoint?.value, usageFromResponses(CODEX_PROVIDER));
	return signInMeters(usage, usage !== endpoint?.value || endpoint?.fresh === true);
}

/** A sign-in provider's snapshot as the card draws it. */
function signInMeters(usage: ProviderUsage | undefined, fresh: boolean): SubscriptionStatus[] {
	return (usage?.limits ?? [])
		.filter(limit => limit.windows.length > 0)
		.map(limit => toSubscriptionStatus({ ...limit, windows: [...limit.windows] }, fresh));
}

/**
 * The whole NaN account for the status-bar panel: every metered model with its period allowance,
 * the one the chat is on (the session's model, or the profile default before the first turn) first.
 * `undefined` when the profile holds no NaN key or the quota has never answered.
 */
export async function readUsagePanel(distributionRoot: string): Promise<UsagePanelData | undefined> {
	const profileDir = readRuntimeMode() === 'external' ? externalProfileDir() : internalProfileDir(distributionRoot);
	const cached = await readNanAccount(profileDir);
	if (cached?.value === undefined) {
		return undefined;
	}
	const modelId = currentModelRef(getSessionUsage()?.model ?? readDefaultModel(profileDir))?.model;
	const models = nanAccountMeters(cached.value, modelId).flatMap((limit): UsagePanelModel[] => {
		const period = limit.windows.find(window => window.label.length === 0);
		if (period?.used === undefined || period.budget === undefined) {
			return [];
		}
		const rolling = limit.windows.find(window => window.label.length > 0);
		return [{
			name: limit.name,
			used: period.used,
			cap: period.budget,
			usedPercent: period.usedPercent,
			resetAt: period.resetAt,
			...(rolling === undefined ? {} : { window: { label: `${spokenWindowLabel(rolling.label)} window`, usedPercent: rolling.usedPercent, resetAt: rolling.resetAt } }),
			limitReached: limit.limitReached,
			current: limit.name === modelId,
		}];
	});
	return models.length === 0 ? undefined : { models, periodStart: cached.value.periodStart ?? null, fresh: cached.fresh, fetchedAt: cached.value.fetchedAt };
}

/** Registers the command the status-bar usage panel reads; the caller collects the disposable. */
export function registerUsagePanelCommand(distributionRoot: string): vscode.Disposable {
	return vscode.commands.registerCommand(USAGE_PANEL_COMMAND, () => readUsagePanel(distributionRoot));
}

/** Builds the one answer the status tree renders, from the profile in force. */
export async function buildStatusData(deps: StatusDeps): Promise<StatusData> {
	const runtime = readRuntimeMode();
	const profileDir = runtime === 'external' ? externalProfileDir() : internalProfileDir(deps.distributionRoot);
	const defaultModel = readDefaultModel(profileDir);
	const sources = providerSources(profileDir);
	// Whether the agent's thinking reaches the chat. `hide` is the shipped default, and the owner was
	// looking for exactly this.
	const reasoning = readPiChatSettings(key => vscode.workspace.getConfiguration('picode').get(key)).showReasoning ? 'shown' as const : 'hidden' as const;
	const usage = getSessionUsage();
	const profileMcpServers = readMcpServers(profileDir, runtime);
	const mcpServers = mergeMcpServers(
		profileMcpServers,
		readProjectMcpServers(),
		discoveredMcpServers(profileMcpServers.map(row => row.name), liveSessionMcpServers()),
	);
	const scope = resolveProjectScope();
	const projects = scope.mode === 'workspace'
		? await Promise.all(scope.folders.map(async folder => ({
				name: path.basename(folder),
				...(await readGit(folder)),
			})))
		: undefined;
	const gitInfo = projects === undefined ? await readGit(scope.cwd) : {};

	return {
		runtime,
		piVersion: await readPiVersion(runtime, deps.distributionRoot),
		providers: providerInventory(sources.declared, sources.models, sources.credentials, sources.subscriptions),
		defaultModel,
		mcpServers,
		gitBranch: gitInfo.branch,
		gitChanges: gitInfo.changes,
		gitInsertions: gitInfo.insertions,
		gitDeletions: gitInfo.deletions,
		...(projects === undefined ? {} : { projects }),
		ctxTokens: usage?.ctxTokens,
		// The window belongs to the model the session is actually on; the profile default is
		// only the fallback for a session that has not reported a model yet.
		ctxWindow: usage?.ctxTokens === undefined ? undefined : readContextWindow(profileDir, usage?.model ?? defaultModel),
		cost: usage?.cost,
		inputTokens: usage?.input,
		outputTokens: usage?.output,
		cacheRead: usage?.cacheRead,
		cacheWrite: usage?.cacheWrite,
		model: usage?.model,
		thinkingLevel: usage?.thinkingLevel,
		reasoning,
		// The provider's own quota for the model in use, never the session's totals above.
		// The model's subscription meter, read the way the Session Usage row used to be: the lookup
		// and its one-minute cache belong to `usage-data.ts`, and the block draws what it answered.
		subscription: await readSubscription(profileDir, usage?.model ?? defaultModel),
		subscriptions: await readAccountSubscriptions(profileDir, usage?.model ?? defaultModel),
		// What the update check last found, read from where the check stored it: the lookup and its
		// cadence belong to `updates-check.ts`, and this reading only draws the answer it left behind.
		updates: parseSnapshot(deps.globalState.get<unknown>(UPDATES_STATE_KEY)),
		// The chat's own background jobs, straight from the tracker the pill reads — the same rows,
		// so the card and the pill can never disagree about what is still out.
		jobs: deps.runningJobs(),
		voice: deps.voice(),
	};
}

/** Registers the command the status surface calls; the caller collects the disposable. */
export function registerStatusDataCommand(deps: StatusDeps): vscode.Disposable {
	return vscode.commands.registerCommand(STATUS_DATA_COMMAND, (): Promise<StatusData> => buildStatusData(deps));
}
