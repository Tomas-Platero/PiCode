/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { getSessionUsage } from './agent';
import { declarationsFromSetting, isRecord } from './declarations';
import { isGentleInstalled, probeExternalPi, readGentleVersion, readInternalPiVersion } from './onboarding';
import { externalProfileDir } from './profile-import';
import { internalProfileDir, readRuntimeMode } from './runtime';
import { STATUS_DATA_COMMAND, type McpServerSwitch, type StatusData } from './status-view';
import { getCachedNanUsage, matchedNanProvider, nanUsageSummary, resolveNanApiKey } from './usage-data';

/**
 * The data behind the PiCode status view.
 *
 * One call answers the whole tree: the pi in force and its version, the providers pi has, the
 * default model, the MCP servers, Gentle AI's state, the session's usage and cost, and the
 * project's branch, pending files and diff totals. What `status-view.ts` draws is exactly this,
 * so the shape returned here is that module's `StatusData` contract and nothing else.
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
 */

/** Where the answer is built from. */
export interface StatusDeps {
	/** The distribution root: where PiCode's own pi runtime and its profile live. */
	readonly distributionRoot: string;
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

/** The directories directly under `dir`, counted; 0 when it does not exist. */
function countDirectories(dir: string): number {
	try {
		return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).length;
	} catch {
		return 0;
	}
}

/**
 * The providers the owner has: the ones declared in the settings row, the endpoints pi's
 * `models.json` holds, and the credentials (subscriptions) `auth.json` holds — counted once
 * each, because the same provider can appear in more than one of them.
 */
function countProviders(profileDir: string): number {
	const ids = new Set<string>();

	const configuration = vscode.workspace.getConfiguration('picode');
	for (const declaration of declarationsFromSetting(configuration.get('providers') ?? configuration.get('pi.providers'))) {
		ids.add(declaration.id);
	}

	const models = readJsonObject(path.join(profileDir, 'models.json'));
	const providers = models?.['providers'];
	if (isRecord(providers)) {
		for (const id of Object.keys(providers)) {
			ids.add(id);
		}
	}

	const auth = readJsonObject(path.join(profileDir, 'auth.json'));
	if (auth !== undefined) {
		for (const id of Object.keys(auth)) {
			ids.add(id);
		}
	}

	return ids.size;
}

/** pi's MCP servers in the profile, one row each: the name, and whether pi will start it. */
function readMcpServers(profileDir: string): readonly McpServerSwitch[] {
	const file = readJsonObject(path.join(profileDir, 'mcp.json'));
	const servers = file?.['mcpServers'];
	if (!isRecord(servers)) {
		return [];
	}
	// `enabled: false` is pi's switch, and the one this connector honours too (`mcp-provider.ts`): this
	// is the list that keeps a switched-off server visible once it stops being offered as a row.
	return Object.entries(servers).map(([name, entry]) => ({ name, on: !(isRecord(entry) && entry['enabled'] === false) }));
}

/** The profile's default model, from pi's own `settings.json`. */
function readDefaultModel(profileDir: string): string | undefined {
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
 * Once those hold, the row is worth drawing even when the read fails: `unavailable` says the
 * provider is the one with a quota route and the number is not in hand. Codex and Claude
 * Pro/Max report their windows in SSE response headers this connector never sees, so they get
 * no row at all — not a dash, which would promise a number that cannot arrive.
 */
async function readUsageRow(profileDir: string, model: string | undefined): Promise<string | undefined> {
	const current = currentModelRef(model);
	if (current === undefined) {
		return undefined;
	}
	const declared = declarationsFromSetting(vscode.workspace.getConfiguration('picode').get('providers'));
	const provider = matchedNanProvider(declared, current.provider);
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
	return cached.value === undefined
		? 'unavailable'
		: nanUsageSummary(cached.value, current.model) ?? 'unavailable';
}

/** Builds the one answer the status tree renders, from the profile in force. */
export async function buildStatusData(deps: StatusDeps): Promise<StatusData> {
	const runtime = readRuntimeMode();
	const profileDir = runtime === 'external' ? externalProfileDir() : internalProfileDir(deps.distributionRoot);
	const defaultModel = readDefaultModel(profileDir);
	const usage = getSessionUsage();
	const gentleInstalled = isGentleInstalled(profileDir);
	const mcpServers = readMcpServers(profileDir);
	const gitInfo = await readGit(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);

	return {
		runtime,
		piVersion: await readPiVersion(runtime, deps.distributionRoot),
		gentleInstalled,
		gentleVersion: gentleInstalled ? readGentleVersion(profileDir) : undefined,
		providers: countProviders(profileDir),
		defaultModel,
		mcpServers,
		skills: countDirectories(path.join(profileDir, 'skills')),
		gitBranch: gitInfo.branch,
		gitChanges: gitInfo.changes,
		gitInsertions: gitInfo.insertions,
		gitDeletions: gitInfo.deletions,
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
		// The provider's own quota for the model in use, never the session's totals above.
		usage: await readUsageRow(profileDir, usage?.model),
		tasks: usage?.tasks,
	};
}

/** Registers the command the status tree calls; the caller collects the disposable. */
export function registerStatusDataCommand(deps: StatusDeps): vscode.Disposable {
	return vscode.commands.registerCommand(STATUS_DATA_COMMAND, (): Promise<StatusData> => buildStatusData(deps));
}
