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
import { STATUS_DATA_COMMAND, type StatusData } from './status-view';

/**
 * The data behind the PiCode status view.
 *
 * One call answers the whole tree: the pi in force and its version, the providers pi has, the
 * default model, the MCP servers, Gentle AI's state, the session's usage and cost, and the
 * project's branch and pending changes. What `status-view.ts` draws is exactly this, so the
 * shape returned here is that module's `StatusData` contract and nothing else.
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

/** The MCP servers pi's adapter reads from the profile. */
function countMcpServers(profileDir: string): number {
	const file = readJsonObject(path.join(profileDir, 'mcp.json'));
	const servers = file?.['mcpServers'];
	return isRecord(servers) ? Object.keys(servers).length : 0;
}

/** The profile's default model, from pi's own `settings.json`. */
function readDefaultModel(profileDir: string): string | undefined {
	const settings = readJsonObject(path.join(profileDir, 'settings.json'));
	const value = settings?.['defaultModel'];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The default model's context window, from the profile's `models.json`. */
function readContextWindow(profileDir: string, defaultModel: string | undefined): number | undefined {
	if (defaultModel === undefined || !defaultModel.includes('/')) {
		return undefined;
	}
	const slash = defaultModel.indexOf('/');
	const providerId = defaultModel.slice(0, slash);
	const modelId = defaultModel.slice(slash + 1);
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

/** The project's branch and pending changes, or `undefined` for each fact git cannot give. */
async function readGit(folder: string | undefined): Promise<{ branch?: string; changes?: number }> {
	if (folder === undefined) {
		return {};
	}
	const [branch, status] = await Promise.all([
		git(folder, ['rev-parse', '--abbrev-ref', 'HEAD']),
		git(folder, ['status', '--porcelain']),
	]);
	return {
		...(branch === undefined ? {} : { branch: branch.trim() }),
		...(status === undefined ? {} : { changes: status.split('\n').filter(line => line.trim().length > 0).length }),
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

/** Builds the one answer the status tree renders, from the profile in force. */
export async function buildStatusData(deps: StatusDeps): Promise<StatusData> {
	const runtime = readRuntimeMode();
	const profileDir = runtime === 'external' ? externalProfileDir() : internalProfileDir(deps.distributionRoot);
	const defaultModel = readDefaultModel(profileDir);
	const usage = getSessionUsage();
	const gentleInstalled = isGentleInstalled(profileDir);
	const gitInfo = await readGit(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);

	return {
		runtime,
		piVersion: await readPiVersion(runtime, deps.distributionRoot),
		gentleInstalled,
		gentleVersion: gentleInstalled ? readGentleVersion(profileDir) : undefined,
		providers: countProviders(profileDir),
		defaultModel,
		mcpServers: countMcpServers(profileDir),
		skills: countDirectories(path.join(profileDir, 'skills')),
		agents: countDirectories(path.join(profileDir, 'agents')),
		sessions: countDirectories(path.join(profileDir, 'sessions')),
		gitBranch: gitInfo.branch,
		gitChanges: gitInfo.changes,
		ctxTokens: usage?.ctxTokens,
		ctxWindow: usage?.ctxTokens === undefined ? undefined : readContextWindow(profileDir, defaultModel),
		cost: usage?.cost,
		inputTokens: usage?.input,
		outputTokens: usage?.output,
	};
}

/** Registers the command the status tree calls; the caller collects the disposable. */
export function registerStatusDataCommand(deps: StatusDeps): vscode.Disposable {
	return vscode.commands.registerCommand(STATUS_DATA_COMMAND, (): Promise<StatusData> => buildStatusData(deps));
}
