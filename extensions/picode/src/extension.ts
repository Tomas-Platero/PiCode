/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentRoots, coalesce, discoverAgents, discoverSkills, nodeFs, skillRoots, type ResourceRoot } from './customizations';
import { declarationsFromSetting, fillKeylessProviders, isRecord, projectDeclaration } from './declarations';
import { memoryEnabled, startMemory, stopStartedMemory } from './engram-activation';
import { fetchModelIds } from './endpoint';
import { splitModelId } from './providerIds';
import { connectSubscription } from './login';
import { mcpServersFrom, mcpCliEntryOf, mcpLoginArgs, mcpLoginEnv, storedDiscoveryOf, type McpConfigFile, type PiMcpServer } from './mcp-provider';
import { mcpServersText, mcpServersTextWithOAuthScope, normalizedServersFile, splitArguments, type McpServerSetting } from './mcpServers';
import { mcpServersTextWithAdded, mcpServersTextWithEdited, mcpServersTextWithRemoved, mcpServersTextWithToggled, parseKeyValueLines, serverEntry, serverFileEntry, serverNames, validateDraft, validateServerName, type AddServerDraft, type McpServerFileEntry } from './mcp-add';
import { cacheKey, cachedModels, deserialiseCache, sameIds, serialiseCache, singleFlight, storeModels, type CacheEntry } from './models-cache';
import { installPackage, searchPackages } from './packages-registry';
import { checkPackageUpdates, clearPackageUpdateCache, updatePackage, type PackageUpdateStatusRow } from './packages-updates';
import { piSessionsDir, registerSessionsBackupCommands } from './sessions-backup';
import {
	DISABLED_PACKAGES_KEY,
	disablePackageSource,
	disabledRecordWithout,
	enablePackageSource,
	packageDisplayInfo,
	packageInstallPaths,
	removePackage,
	type DisabledRecord,
	type ManageFs,
	type PiPackageRow,
} from './packages-manage';
import { packageSkillDirs, parsePackageSource, parseSettings, piPackages, projectPackageScope, userPackageScope, type PackageReadResult, type PiPackage } from './packages-data';
import { loadPiSdk, mcpOauthModuleOf, importPiModule, sdkCandidates, type OfficialSdk } from './piSdk';
import { offlineAccessScope } from './mcp-scopes';
import { externalProfileDir } from './profile-import';
import {
	CONNECT_PROVIDER_COMMAND,
	declarationFrom,
	modelsForConfiguration,
	readConfiguration,
	type ProviderConfiguration,
} from './providers';
import { BACKGROUND_JOBS_COMMAND, cancelQueuedTurns, liveSessionCommands, onPiSessionChanged, registerPiAgent, resetChatSession, runningBackgroundJobs } from './agent';
import { absolutePathOfBeforeUriPath, beforeContentFor, PICODE_BEFORE_SCHEME } from './chat-edits';
import { registerPiCommandPromptFiles } from './commands';
import { listModels, registerWizardModelCommands } from './wizard-models';
import { AGENT_MODELS_COMMAND, chooseAgentModels, registerAgentModelsStateCommands } from './gentle-models-ui';
import { registerPiSessionsProvider } from './sessions-register';
import { applyProductEnv, pointChildPiAtThisPi } from './product-env';
import { traceChildPi } from './child-trace';
import { distributionRootOf } from './distribution-root';
import { gentleAgents } from './gentle-agents-store';
import { disposeResumedSessions } from './sessions-resume';
import { probeExternalPi, readInternalPiVersion, registerSetupCommands } from './onboarding';
import { ensureProfilePackages } from './packages-install';
import { LEFT_BEHIND_PACKAGE_NAMES } from './left-behind-packages';
import { readDefaultModel, registerStatusDataCommand, registerUsagePanelCommand } from './status-data';
import { parseProviderStreamEvent, type ProviderApi } from './provider-stream';
import { STATUS_PROVIDER_SETTINGS_COMMAND, UPDATES_APPLY_COMMAND, UPDATES_CHECK_COMMAND } from './status-contract';
import { MEMORY_ENABLED_CONTEXT, registerMemoryView } from './memory-view';
import { registerTasksView } from './tasks-view';
import { isRunning, isTaskId, transcriptOf, transcriptOfJson } from './agent-transcript';
import { showAgentTranscript } from './agent-transcript-panel';
import { registerThemeGalleryCommands } from './theme-gallery';
import { chatAgentDir, internalProfileDir, PICODE_RUNTIME_SETTING, piRuntimeRoot, projectSlugsOfWindow, readRuntimeMode, sdkEntryCandidates } from './runtime';
import { launchedAgents, lastActivity, type AgentState } from './agents';
import { listProjectSessionFiles } from './sessions-provider';
import { REASONING_SETTING, THINKING_TOGGLE_COMMAND } from './piConfig';
import { describeTargets, fetchNpmLatest, parseSnapshot, PI_RUNTIME_PACKAGE, runPiUpdate, updatableTargets, UPDATES_STATE_KEY, type CandidateTarget, type UpdatesSnapshot } from './updates-check';
import { locateNpmCli } from './npm-run';
import { acceptsImages, modelPricing, type PiModelCost } from './model-info';

/**
 * PiCode's bridge, living **inside the core**.
 *
 * ## Why this is an extension at all, and why that is not a contradiction
 *
 * The rule is that PiCode has no extension of its own — no surface beside the editor. This
 * is not that: everything under `vscode/extensions/` **is** the core. These extensions are
 * compiled with the editor, ship inside the binary, and are how VS Code itself puts
 * anything that needs Node in its place (`git`, `github-authentication`, …).
 *
 * That is the problem this file solves. The workbench renderer has no Node, so it cannot
 * read pi's profile or call a provider's API; the extension host has Node and is part of the
 * build. So the *runtime* side of pi lives here, while every **surface** stays in Chat.
 *
 * ## What this first piece does
 *
 * It makes **pi's models appear in the editor's own model list** — the window that until now
 * only knew about Copilot's. Providers get there two ways, and both end in the profile PiCode
 * owns (`data/pi-agent`), which is what makes the editor's list and pi's own runtime agree:
 *
 * - the **lines the owner writes in the settings list** under Chat (`omni | <address> |
 *   <dialect> | <key>`), declared in place with the editor's own list widget, and
 * - the **editor's own provider form**, whose fields are the ones the manifest declares and
 *   whose key the editor keeps as a secret.
 *
 * It does not draw anything: no panel, no tab, no settings of its own — and no chain of
 * dialogs either, which is what the first version of this flow had.
 */

/** The vendor this extension registers with the editor. */
const VENDOR = 'picode';

/* ------------------------------------------------------------------ *
 * Where pi's profile is
 * ------------------------------------------------------------------ */

/**
 * PiCode's own profile directory.
 *
 * Derived from the editor's own location rather than configured, because there is only one
 * answer and a wrong one would read somebody else's models: the application lives at
 * `<root>/resources/app`, so two levels up is the distribution (the repository itself in a dev
 * run), and the profile is `<root>/data/pi-agent` — the same directory `instance.ts` resolves for
 * the host. **Nothing outside PiCode is ever read.**
 */
/** The distribution root: `<root>` in a pack, the repository in a dev run (`distribution-root.ts`). */
function distributionRoot(_extensionUri: vscode.Uri): string {
	return distributionRootOf(vscode.env.appRoot);
}

/**
 * PiCode's own profile — the only thing this function can mean. It is the write target of
 * everything PiCode projects for pi, whatever pi is running (see `runtime.ts`); the chat's
 * agent directory follows the runtime choice instead and comes from `chatAgentDir`.
 */
function profileDirectory(extensionUri: vscode.Uri): string {
	return internalProfileDir(distributionRoot(extensionUri));
}

/* ------------------------------------------------------------------ *
 * pi's models, as the editor needs to see them
 * ------------------------------------------------------------------ */

/** One model as pi's `models.json` declares it. */
interface PiModelEntry {
	readonly id: string;
	readonly name?: string;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly reasoning?: boolean;
	readonly cost?: PiModelCost;
	readonly input?: readonly string[];
}

/** One provider as pi's `models.json` declares it. */
interface PiProviderEntry {
	readonly baseUrl?: string;
	readonly api?: string;
	readonly apiKey?: string;
	readonly models?: readonly PiModelEntry[];
}

interface PiModelsFile {
	readonly providers?: Record<string, PiProviderEntry>;
}

function readModelsFile(profile: string): PiModelsFile | undefined {
	try {
		const text = fs.readFileSync(path.join(profile, 'models.json'), 'utf8');
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === 'object' && parsed !== null ? (parsed as PiModelsFile) : undefined;
	} catch {
		// A missing or broken file is "no models", not a crash: the first run has no file at
		// all, and the editor asks for models before anybody has connected anything.
		return undefined;
	}
}

/**
 * pi's models, in the shape the editor's model list wants.
 *
 * The id is qualified with the provider (`omni/anthropic/claude-sonnet-4`) because two
 * providers can offer the same model name, and the response call has to know which one to
 * reach. `family` is what the editor groups by, so it carries the provider too.
 */
function toChatInformation(models: PiModelsFile): vscode.LanguageModelChatInformation[] {
	const out: vscode.LanguageModelChatInformation[] = [];
	for (const [providerId, provider] of Object.entries(models.providers ?? {})) {
		for (const model of provider.models ?? []) {
			if (typeof model.id !== 'string' || model.id.length === 0) {
				continue;
			}
			out.push({
				id: `${providerId}/${model.id}`,
				name: model.name ?? model.id,
				family: providerId,
				version: '1',
				// pi's own defaults when the entry does not say, so the editor's budget is never
				// zero — a zero budget is read as "cannot be used".
				maxInputTokens: model.contextWindow ?? 128000,
				maxOutputTokens: model.maxTokens ?? 16384,
				detail: providerId,
				capabilities: { toolCalling: true, ...(acceptsImages(model.input) ? { imageInput: true } : {}) },
				...modelPricing(model.cost),
			});
		}
	}
	return out;
}


/* ------------------------------------------------------------------ *
 * The MCP servers pi runs
 * ------------------------------------------------------------------ */

/** Where pi's own MCP file lives, inside PiCode's profile. */
function mcpServersFile(profile: string): string {
	return path.join(profile, 'mcp.json');
}

/**
 * Writes the MCP servers the owner declared, in the shape pi's own MCP reads.
 *
 * The setting is the surface and this file is the projection, the same arrangement the model
 * providers use: what the owner fills in the form becomes what pi reads. The write is skipped when
 * the file already says exactly this, because activation and every settings change call it.
 *
 * Nothing is installed beside it: this is the file pi's own MCP reads, by name and shape. Whether
 * the editor's chat sessions reach it is a separate question.
 */
function writeMcpServers(profile: string, servers: readonly McpServerSetting[]): void {
	const file = mcpServersFile(profile);
	const text = mcpServersText(readJsonFile(file), servers);
	try {
		if (fs.readFileSync(file, 'utf8') === text) {
			return;
		}
	} catch {
		// No file yet: the first time a server is declared.
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text, { mode: 0o600 });
}

/**
 * The file's content as an object, or `undefined` when there is none, it is broken, or it is not an
 * object.
 *
 * Every entry comes back **normalized** (`mcpServers.ts`): a file that arrived with the old
 * adapter's `auth: "oauth"` / `oauth: false` is healed by the next write, which is what makes the
 * entries usable by pi's own MCP. It happens here, where the file is read for writing, so both
 * writers inherit it — the settings row's and the Add Server flow's.
 */
function readJsonFile(file: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
			? normalizedServersFile(parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** The servers the settings declare. */
function declaredMcpServers(): McpServerSetting[] {	const configured = vscode.workspace.getConfiguration('picode').get<McpServerSetting[]>('mcp.servers');
	return Array.isArray(configured) ? configured : [];
}

/** Writes the servers pi reads. Nothing is installed beside it: the file is pi's own. */
function applyMcpServers(profile: string): void {
	writeMcpServers(profile, declaredMcpServers());
}

/** How long the metadata lookup before a sign-in may take: it is a hint, not the sign-in itself. */
const MCP_DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Makes a sign-in durable before it starts, when the server's own metadata allows it.
 *
 * A remote server whose authorization server can issue a refresh token is asked for
 * `offline_access` (`mcp-scopes.ts` says why), so the credential pi stores can be renewed instead
 * of being asked for again the hour it expires. The discovery for that is pi's own: what it cached
 * beside the server's sign-in, or — for a server never contacted — pi's own
 * `discoverOAuthServerInfo`, loaded from the same install as the SDK entry.
 *
 * Best-effort by construction: this only changes what a sign-in asks for, so a lookup that fails
 * must leave the sign-in exactly as it was rather than block it.
 */
async function ensureSignInCanBeRenewed(profile: string, server: string, sdkEntry: string): Promise<void> {
	try {
		const file = mcpServersFile(profile);
		const existing = readJsonFile(file);
		const servers = isRecord(existing) && isRecord(existing['mcpServers']) ? existing['mcpServers'] : undefined;
		const entry = servers !== undefined && isRecord(servers[server]) ? servers[server] : undefined;
		// A local server, or one that authenticates itself with its own headers, has no OAuth sign-in
		// to make durable — pi would not even open a browser for it.
		if (entry === undefined || typeof entry['url'] !== 'string' || isRecord(entry['headers'])) {
			return;
		}
		const url = entry['url'];
		let authText: string | undefined;
		try {
			authText = fs.readFileSync(path.join(profile, 'mcp-auth.json'), 'utf8');
		} catch {
			authText = undefined;
		}
		let discovery: unknown = storedDiscoveryOf(authText === undefined ? undefined : { text: authText }, server, url);
		if (discovery === undefined) {
			const module = mcpOauthModuleOf(sdkEntry);
			if (module !== undefined) {
				const loaded = await importPiModule<{ discoverOAuthServerInfo?: (serverUrl: string, options?: { signal?: AbortSignal }) => Promise<unknown> }>(module);
				discovery = await loaded.discoverOAuthServerInfo?.(url, { signal: AbortSignal.timeout(MCP_DISCOVERY_TIMEOUT_MS) });
			}
		}
		const scope = offlineAccessScope(isRecord(entry['oauth']) ? entry['oauth']['scope'] : undefined, discovery);
		if (scope === undefined) {
			return;
		}
		const text = mcpServersTextWithOAuthScope(existing, server, scope);
		if (text !== undefined) {
			fs.writeFileSync(file, text, { mode: 0o600 });
		}
	} catch {
		// A sign-in that cannot be improved is still a sign-in.
	}
}

/**
 * Asks the owner what the new server is, one quick pick at a time, and writes it into the
 * profile's `mcp.json` — the same file the management page's MCP section lists.
 *
 * Every step can be cancelled, and a cancellation ends the flow quietly: an `undefined` answer
 * is not an error. The name is checked as it is typed, and a name the file already holds is
 * overwritten only after the owner says so. The project's `.pi/mcp.json` is deliberately out
 * of reach here: the profile is the one file every window and every pi session agrees on.
 *
 * A failure is **not** rethrown: the core's button falls back to the editor's own add flow
 * when this command rejects, and that flow writes a file pi never reads. The failure is said
 * here instead, and the file is left as it was.
 */
async function addMcpServer(profile: string): Promise<void> {
	const file = mcpServersFile(profile);
	const existing = readJsonFile(file);

	const name = (await vscode.window.showInputBox({
		prompt: 'Name of the MCP server',
		placeHolder: 'my-server',
		validateInput: validateServerName,
	}))?.trim();
	if (name === undefined || name.length === 0) {
		return;
	}
	if (serverNames(existing).includes(name)) {
		const overwrite = await vscode.window.showQuickPick(['Overwrite it', 'Cancel'], {
			placeHolder: `An MCP server named "${name}" is already in pi's profile`,
		});
		if (overwrite !== 'Overwrite it') {
			return;
		}
	}

	const picked = await vscode.window.showQuickPick(['stdio', 'http'], {
		placeHolder: 'How the server is reached: a local command or a remote URL',
	});
	if (picked === undefined) {
		return;
	}
	const transport: AddServerDraft['transport'] = picked === 'http' ? 'http' : 'stdio';

	let draft: AddServerDraft;
	if (transport === 'stdio') {
		const command = (await vscode.window.showInputBox({
			prompt: 'Command that starts the server',
			placeHolder: 'npx -y some-mcp-server',
		}))?.trim();
		if (command === undefined || command.length === 0) {
			return;
		}
		const argsText = await vscode.window.showInputBox({
			prompt: 'Arguments of the command, separated by spaces; quote one that holds spaces (optional)',
			placeHolder: '--port 3000',
		});
		if (argsText === undefined) {
			return;
		}
		const env = await collectKeyValueLines('Environment variable of the server');
		if (env === undefined) {
			return;
		}
		draft = { name, transport, command, args: splitArguments(argsText), ...env };
	} else {
		const url = (await vscode.window.showInputBox({
			prompt: 'URL of the server',
			placeHolder: 'https://example.test/mcp',
		}))?.trim();
		if (url === undefined || url.length === 0) {
			return;
		}
		const headers = await collectKeyValueLines('Header sent to the server');
		if (headers === undefined) {
			return;
		}
		draft = { name, transport, url, ...headers };
	}

	const problems = validateDraft(draft);
	if (problems.length > 0) {
		// Everything above was validated as it was asked; this is the net under it.
		void vscode.window.showErrorMessage(`PiCode: the server is not complete — ${problems.join(' ')}`);
		return;
	}

	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, mcpServersTextWithAdded(existing, draft), { mode: 0o600 });

	// The list repaints itself through the file watcher: pi reads the server from the file, so
	// nothing else has to be told that one was added.
	void vscode.window.showInformationMessage(`MCP server ${name} added to pi. It will appear in the list.`);
}

/** Every file the MCP section's pi servers can live in, in the order `mcpServersFrom` reads them: profile first, then each folder. */
function piMcpServerFiles(profile: string): string[] {
	return [path.join(profile, 'mcp.json'), ...workspaceFolderPaths().map(folder => path.join(folder, '.pi', 'mcp.json'))];
}

/**
 * The file whose entry is the one pi actually runs for a server, or `undefined` when no file
 * holds it. The files are read profile-first and a later file's entry of the same name replaces
 * the earlier one (`mcp-provider.ts`), so the **last** file that declares the name is the
 * effective one — the same reading the list itself answers with.
 */
function locateMcpServerFile(profile: string, name: string): string | undefined {
	let found: string | undefined;
	for (const file of piMcpServerFiles(profile)) {
		const existing = readJsonFile(file);
		if (existing !== undefined && serverNames(existing).includes(name)) {
			found = file;
		}
	}
	return found;
}

/** The command's entry point: the page hands the server's name over; without one, the owner picks it. */
async function editMcpServerCommand(profile: string, name?: string): Promise<void> {
	const picked = name ?? await pickPiMcpServerName(profile, 'Which MCP server to edit');
	if (picked === undefined) {
		return;
	}
	const file = locateMcpServerFile(profile, picked);
	if (file === undefined) {
		void vscode.window.showWarningMessage(`PiCode: there is no MCP server named "${picked}" any more.`);
		return;
	}
	await editMcpServer(file, picked);
}

/**
 * Asks what one existing server should say now and writes the entry back into the file that
 * holds it — the same file the list reads, in the shape pi's own MCP documents.
 *
 * The name is kept: it is the entry's key and the identity the page handed over. Everything
 * else starts prefilled from the entry as it is now, and every step can be cancelled. A failure
 * is said here and the file is left as it was, for the same reason `addMcpServer` never rejects.
 */
async function editMcpServer(file: string, name: string): Promise<void> {
	const existing = readJsonFile(file) ?? {};
	const current = serverEntry(existing, name);

	// The transport the entry says now is offered first, so accepting the pick keeps it.
	const transports = current !== undefined && 'command' in current ? ['stdio', 'http'] : ['http', 'stdio'];
	const picked = await vscode.window.showQuickPick(transports, {
		placeHolder: `How "${name}" is reached: a local command or a remote URL`,
	});
	if (picked === undefined) {
		return;
	}
	const transport: AddServerDraft['transport'] = picked === 'http' ? 'http' : 'stdio';

	let entry: McpServerFileEntry;
	if (transport === 'stdio') {
		const command = (await vscode.window.showInputBox({
			prompt: 'Command that starts the server',
			placeHolder: 'npx -y some-mcp-server',
			value: current !== undefined && 'command' in current ? current.command : undefined,
		}))?.trim();
		if (command === undefined || command.length === 0) {
			return;
		}
		const argsText = await vscode.window.showInputBox({
			prompt: 'Arguments of the command, separated by spaces; quote one that holds spaces (optional)',
			placeHolder: '--port 3000',
			value: current !== undefined && 'command' in current && current.args.length > 0 ? current.args.join(' ') : undefined,
		});
		if (argsText === undefined) {
			return;
		}
		const env = await collectKeyValueLines('Environment variable of the server', current !== undefined && 'command' in current ? { ...current.env } as Record<string, string> : undefined);
		if (env === undefined) {
			return;
		}
		entry = serverFileEntry({ name, transport, command, args: splitArguments(argsText), ...env });
	} else {
		const url = (await vscode.window.showInputBox({
			prompt: 'URL of the server',
			placeHolder: 'https://example.test/mcp',
			value: current !== undefined && 'url' in current ? current.url : undefined,
		}))?.trim();
		if (url === undefined || url.length === 0) {
			return;
		}
		const headers = await collectKeyValueLines('Header sent to the server', current !== undefined && 'url' in current ? { ...current.headers } : undefined);
		if (headers === undefined) {
			return;
		}
		entry = serverFileEntry({ name, transport, url, ...headers });
	}

	const problems = validateDraft({ ...entry, name, transport });
	if (problems.length > 0) {
		// Everything above was validated as it was asked; this is the net under it.
		void vscode.window.showErrorMessage(`PiCode: the server is not complete — ${problems.join(' ')}`);
		return;
	}

	// The file may have changed under the flow; what is on disk now decides whether the entry is
	// still there to be edited. Rewriting from a stale read would resurrect a removed entry.
	const text = mcpServersTextWithEdited(readJsonFile(file) ?? {}, name, entry);
	if (text === undefined) {
		void vscode.window.showWarningMessage(`PiCode: there is no MCP server named "${name}" any more.`);
		return;
	}
	fs.writeFileSync(file, text, { mode: 0o600 });
	void vscode.window.showInformationMessage(`MCP server ${name} updated in pi. It will appear in the list.`);
}

/** The command's entry point: the page hands the server's name over; without one, the owner picks it. */
async function removeMcpServerCommand(profile: string, name?: string): Promise<void> {
	const picked = name ?? await pickPiMcpServerName(profile, 'Which MCP server to remove');
	if (picked === undefined) {
		return;
	}
	const file = locateMcpServerFile(profile, picked);
	if (file === undefined) {
		void vscode.window.showWarningMessage(`PiCode: there is no MCP server named "${picked}" any more.`);
		return;
	}

	// Where the entry lives, in the words of the person reading the question: the path is PiCode's own
	// business, and the scope is what decides whether removing it affects this project or everything.
	const declaredIn = path.basename(path.dirname(file)) === '.pi' ? 'this project' : 'your profile';
	const confirmed = await vscode.window.showWarningMessage(`Remove the MCP server "${picked}" from pi? It is declared in ${declaredIn}.`, { modal: true }, 'Remove');
	if (confirmed !== 'Remove') {
		return;
	}

	const text = mcpServersTextWithRemoved(readJsonFile(file) ?? {}, picked);
	if (text === undefined) {
		void vscode.window.showWarningMessage(`PiCode: there is no MCP server named "${picked}" any more.`);
		return;
	}
	fs.writeFileSync(file, text, { mode: 0o600 });
	void vscode.window.showInformationMessage(`MCP server ${picked} removed from pi.`);
}

/** Every server name the files hold, in the order pi reads them, for the pick that runs without a name. */
async function pickPiMcpServerName(profile: string, subject: string): Promise<string | undefined> {
	const names = new Set<string>();
	for (const file of piMcpServerFiles(profile)) {
		for (const name of serverNames(readJsonFile(file) ?? {})) {
			names.add(name);
		}
	}
	if (names.size === 0) {
		void vscode.window.showInformationMessage('there are no MCP servers to edit.');
		return undefined;
	}
	return vscode.window.showQuickPick([...names], { placeHolder: subject });
}

/**
 * Asks for `KEY=VALUE` lines one at a time — the editor's input box is single-line — until an
 * empty answer ends it. A malformed line is said inline and asked again. `undefined` is a
 * cancellation; an empty record is "none".
 *
 * `initial` prefills the list with what the entry already said, so an edit starts from what is
 * there rather than from a blank sheet.
 */
async function collectKeyValueLines(subject: string, initial?: Record<string, string>): Promise<Record<string, string> | undefined> {
	const lines: string[] = Object.entries(initial ?? {}).map(([key, value]) => `${key}=${value}`);
	for (;;) {
		const line = await vscode.window.showInputBox({
			prompt: `${subject} as KEY=VALUE${lines.length === 0 ? '' : ' — leave empty to finish'}`,
			placeHolder: 'KEY=VALUE',
			validateInput: value => value.trim().length === 0 || parseKeyValueLines([value]).malformed.length === 0
				? undefined
				: 'Use KEY=VALUE, for example TOKEN=abc.',
		});
		if (line === undefined) {
			return undefined;
		}
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			return parseKeyValueLines(lines).values;
		}
		lines.push(trimmed);
	}
}

/* ------------------------------------------------------------------ *
 * The chat's management page: pi's own data
 * ------------------------------------------------------------------ */

/**
 * The packages pi has installed, asked for by the chat's page.
 *
 * A **contract**, not a contribution: the editor's own plugin discovery calls this command and gets
 * pi's real list back, so the page never hardcodes a pi path — the profile in force is resolved
 * here, where the runtime choice is known (`runtime.ts`).
 */
export const PACKAGES_COMMAND = 'picode.setup.packages';

/**
 * The Packages section's catalog: what npm says about packages tagged with pi's keywords —
 * the very list `pi.build/packages` renders, asked straight from npm's search endpoint (pi.dev
 * has no public API of its own). A **contract**, like `PACKAGES_COMMAND` above: the page
 * calls it programmatically, with the owner's query as an optional string argument.
 */
export const PACKAGES_SEARCH_COMMAND = 'picode.packages.search';

/**
 * The Packages section's install: pi's own installer, run into the profile in force. A
 * **contract** like the search: the page hands the target the owner chose (an npm name or a
 * git URL) and shows the one sentence this answers.
 */
export const PACKAGES_INSTALL_COMMAND = 'picode.packages.install';

/**
 * The Packages section's disable: pi has no per-package disable of its own — the
 * `packages` array of a settings file is a plain list of source strings — so this takes the
 * declaration out of the settings file that spells it (profile or workspace), keeps the
 * package's files where pi installed them, and remembers the source per profile so the
 * listing can still show the row and {@link PACKAGES_ENABLE_COMMAND} can restore it. A
 * **contract**, like the search and the install: the page hands the source to disable and
 * shows the one sentence this answers.
 */
export const PACKAGES_DISABLE_COMMAND = 'picode.packages.disable';

/**
 * The Packages section's enable: the declaration goes back into the profile settings file
 * and the source leaves the disabled record; a package whose files are gone on disk is
 * installed again through the same flow {@link PACKAGES_INSTALL_COMMAND} uses. A
 * **contract**, like the disable.
 */
export const PACKAGES_ENABLE_COMMAND = 'picode.packages.enable';

/**
 * The Packages section's uninstall: pi's own `pi remove`, run into the profile in force the
 * same way the installer runs `pi install`, with the source dropped from the disabled record.
 * The confirmation is the page's to ask; this command performs. A **contract**, like the
 * disable and the enable.
 */
export const PACKAGES_UNINSTALL_COMMAND = 'picode.packages.uninstall';

/**
 * The Packages section's update **check**: for every installed package, whether npm's registry
 * knows a newer version. A row that is behind is told so, with the version it is behind to; a
 * git or local one is told npm cannot say; a current one says nothing. The check runs after
 * the page has rendered and carries its own ten-minute cache, so refreshing never hammers the
 * registry. A **contract**, like the listing above.
 */
export const PACKAGES_UPDATES_CHECK_COMMAND = 'picode.packages.updatesCheck';

/**
 * The Packages section's update: one package taken to the newest version npm knows, run on the
 * profile in force through `npm-run.ts`'s shell-free planner — the click on a row that says it
 * is behind, not a reinstall by hand. A **contract**, like the other package commands.
 */
export const PACKAGES_UPDATE_COMMAND = 'picode.packages.update';

/**
 * The MCP section's "Add Server", which the core invokes: it asks this connector for the new
 * server instead of the editor's own add flow, because the servers this page lists live in
 * pi's own `mcp.json` — the editor's flow would write a file pi never reads.
 */
export const ADD_MCP_SERVER_COMMAND = 'picode.mcp.addServer';

/**
 * The MCP section's "Edit Server" for a server pi provides: the page hands the server's name
 * over and this connector asks what the entry should say now, writing it back into the file
 * that holds it — the profile's `mcp.json` or a project's `.pi/mcp.json`. Like "Add Server",
 * it exists because the editor's own edit flows open files pi never reads.
 */
export const EDIT_MCP_SERVER_COMMAND = 'picode.mcp.editServer';

/**
 * The MCP section's "Remove Server" for a server pi provides: the page hands the server's name
 * over, this connector asks the owner to confirm, and the entry leaves the file that holds it.
 * A **contract** like {@link EDIT_MCP_SERVER_COMMAND}.
 */
export const REMOVE_MCP_SERVER_COMMAND = 'picode.mcp.removeServer';

/**
 * The MCP switch, run from the status panel's rows: pi reads `enabled` in the file that holds the
 * entry, so flipping it turns a server off without losing it.
 *
 * The panel is the only place a switched-off server is still listed — the MCP page stops offering it
 * the moment it is off (`mcp-provider.ts`), by design — which is why its rows are the switch. A
 * **contract** like {@link CHECK_MCP_SERVER_COMMAND}.
 */
export const TOGGLE_MCP_SERVER_COMMAND = 'picode.mcp.toggleServer';

/**
 * The MCP sign-in, run from the status panel's "needs sign-in" row and the MCP page's Sign in
 * button: it starts pi's own `mcp login <server>` pointed at PiCode's own profile, so the
 * credential lands in `<app>/data/pi-agent/mcp-auth.json` — the file the sign-in rows read.
 *
 * The click that fixes a server is deliberately **not** the switch: a row that needs sign-in
 * signs in, and switching it off stays on the MCP page through {@link TOGGLE_MCP_SERVER_COMMAND}.
 */
export const SIGN_IN_MCP_SERVER_COMMAND = 'picode.mcp.signInServer';

/** How long the editor lets pi's login wait for the browser before the child is stopped. pi's own default is 300 s (`mcp login --timeout`); the slack is pi's own shutdown. */
const MCP_LOGIN_TIMEOUT_MS = 330_000;

/** The id the servers below are registered under; it must match the manifest's contribution. */
const MCP_PROVIDER_ID = 'pi';

/**
 * How long the watchers wait before telling the chat that something changed.
 *
 * A save fires one event per file and a `git checkout` fires dozens; the chat re-reads and re-lists
 * on every one of them, and the run the events were coalesced into reads what is on disk at that
 * moment anyway (`customizations.ts`) — so a short wait loses nothing and saves a burst of work.
 */
const CUSTOMIZATIONS_WAIT_MS = 250;

/**
 * A resource as the chat's prompt-file host reads it.
 *
 * The declared shape is `ChatResource` (`uri`, `when`, `sessionTypes`), but the host also reads
 * `name` and `description` off what a provider returns — `mainThreadChatAgents2` maps them into
 * `IPromptFileResource` — so they travel with the resource. The `source` a provider would declare
 * is **not** part of that crossing: it is lost in the extension host, and the files land as
 * extension-provided customizations whoever they came from.
 */
interface NamedChatResource extends vscode.ChatResource {
	readonly name: string;
	readonly description?: string;
}

/** The workspace folders, as plain paths: pi's project resources live under `<folder>/.pi`. */
function workspaceFolderPaths(): string[] {
	return (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
}

/**
 * The profile **in force**, exactly as the status view resolves it.
 *
 * The internal pi keeps everything in PiCode's own profile; the external one keeps its own on the
 * machine and this editor only reads it. Reading PiCode's own profile under an external runtime
 * would list another pi's agents as if they were the running one's.
 */
function profileInForce(): string {
	return readRuntimeMode() === 'external' ? externalProfileDir() : profileDirectory(requireProfileUri());
}

/** The directory holding the bundled pi runtime's `node_modules` — what npm reinstalls into. */
function piRuntimeDir(): string {
	return piRuntimeRoot(distributionRoot(requireProfileUri()));
}

/** The bundled pi CLI's entry script; a path that does not exist when the runtime is absent. */
function piCliEntry(): string {
	return path.join(piRuntimeDir(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
}

/**
 * The sentence a package action gives back when the profile in force is not PiCode's to write.
 *
 * With PiCode's own pi every write belongs here. With the machine's it never does: that pi and its
 * packages are the owner's, the setting that selects it says PiCode "uses it and never changes it",
 * and the whole product is built around writing inside its own profile only. The page keeps listing
 * them — reading is what the external mode is for — so what stops is the actions, not the list.
 */
function externalProfileRefusal(): string | undefined {
	if (readRuntimeMode() !== 'external') {
		return undefined;
	}
	return 'Your own pi keeps its own packages, and this editor never writes to them. Manage them where that pi lives.';
}

/**
 * The npm project an npm-declared package is installed in — the directory npm runs over when
 * the package is updated: `<profile>/npm`, or a trusted workspace's `<folder>/.pi/npm` when
 * that is where the package was found. An unspellable source answers the profile's, which is
 * where the updater's own refusal sentences come from instead of a wrong install root.
 */
function npmProjectFor(source: string, profileDir: string): string {
	const parsed = parsePackageSource(source);
	if (parsed !== undefined && parsed.kind === 'npm') {
		for (const scope of packageScopes(profileDir)) {
			if (fs.existsSync(path.join(scope.npmRoot, parsed.name))) {
				return path.dirname(scope.npmRoot);
			}
		}
	}
	return path.join(profileDir, 'npm');
}


/** A file's text, or `undefined` when it is not there. */
function readTextFile(file: string): string | undefined {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
}

/**
 * The package scopes of the current window.
 *
 * A project's declarations are read only while the folder is **trusted**: pi itself throws its
 * project settings away when it is not (`SettingsManager.loadFromStorage`), so listing a project's
 * packages in an untrusted window would show packages pi is not loading.
 */
function packageScopes(profileDir: string): ReturnType<typeof userPackageScope>[] {
	const scopes = [userPackageScope(profileDir, parseSettings(readTextFile(path.join(profileDir, 'settings.json'))))];
	if (vscode.workspace.isTrusted) {
		for (const folder of workspaceFolderPaths()) {
			scopes.push(projectPackageScope(folder, parseSettings(readTextFile(path.join(folder, '.pi', 'settings.json')))));
		}
	}
	return scopes;
}

/**
 * Every problem reported once per session.
 *
 * An entry that could not be read is said out loud — an empty list and a broken file look the same
 * on the page, and only one of them is worth acting on — but the listing runs on every open of the
 * page, so the same line is not repeated until the window is reloaded.
 */
const reportedProblems = new Set<string>();

function report(line: string): void {
	if (!reportedProblems.has(line)) {
		reportedProblems.add(line);
		console.error(`[pi] ${line}`);
	}
}

/** The `mcp.json` files of the current window: pi's own, then each folder's project file. */
function mcpConfigFiles(profileDir: string): McpConfigFile[] {
	const files: McpConfigFile[] = [];
	const add = (file: string, source: 'user' | 'local'): void => {
		const text = readTextFile(file);
		if (text !== undefined) {
			files.push({ path: file, text, source });
		}
	};
	add(path.join(profileDir, 'mcp.json'), 'user');
	for (const folder of workspaceFolderPaths()) {
		add(path.join(folder, '.pi', 'mcp.json'), 'local');
	}
	return files;
}

/** One server as the editor's own definition, which is what its MCP list renders. */
function mcpDefinition(server: PiMcpServer): vscode.McpServerDefinition {
	if (server.kind === 'stdio') {
		// No `cwd`: the editor starts a local server in the workspace folder, which is where pi runs
		// one too.
		return new vscode.McpStdioServerDefinition(server.label, server.command, [...server.args], { ...server.env });
	}
	return new vscode.McpHttpServerDefinition(server.label, vscode.Uri.parse(server.url), { ...server.headers });
}

/**
 * Registers pi's own data with the chat's management page: agents, skills, MCP servers and the
 * package list.
 *
 * Everything is read from disk on every call — no snapshot is kept of what the files said — and the
 * three watchers below are only a hint that the answer changed. The one thing kept is the package
 * read, which walks `node_modules`; the watchers drop it, so it is never staler than the events.
 *
 * The package commands also take the extension context's global state: the disabled-packages
 * record lives there, keyed per profile directory, the same way `registerSetupCommands` keeps
 * its state.
 */
function registerCustomizations(globalState: vscode.Memento): vscode.Disposable[] {
	const changed = new vscode.EventEmitter<void>();
	const fsReader = nodeFs();
	const disposables: vscode.Disposable[] = [changed];

	/** The last package read, and what it was read from: a runtime or folder change reads again. */
	let packages: { readonly from: string; readonly value: PackageReadResult } | undefined;
	const readPackages = (): PackageReadResult => {
		const profileDir = profileInForce();
		const from = [profileDir, String(vscode.workspace.isTrusted), ...workspaceFolderPaths()].join('\u0000');
		if (packages?.from !== from) {
			const value = piPackages(packageScopes(profileDir), fsReader);
			for (const line of value.unresolved) {
				report(`packages: ${line}`);
			}
			packages = { from, value };
		}
		return packages.value;
	};

	// The one run a burst of file events collapses into. The package read is dropped first: a change
	// that reaches the page has to be a change the listing can see.
	const fire = coalesce(CUSTOMIZATIONS_WAIT_MS, (run, delayMs) => { setTimeout(run, delayMs); }, () => {
		packages = undefined;
		changed.fire();
	});

	/** Tells the chat that a directory it lists changed, and releases the watcher with the rest. */
	const watch = (base: string, pattern: string): void => {
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), pattern));
		disposables.push(watcher, watcher.onDidCreate(fire), watcher.onDidDelete(fire), watcher.onDidChange(fire));
	};

	/** The disabled packages, as the global state holds them: one source list per profile directory. */
	const readDisabledRecord = (): DisabledRecord => {
		const record = globalState.get<DisabledRecord>(DISABLED_PACKAGES_KEY);
		return typeof record === 'object' && record !== null ? record : {};
	};
	const writeDisabledRecord = (record: DisabledRecord): void => {
		void globalState.update(DISABLED_PACKAGES_KEY, { ...record });
	};

	/** The filesystem the package flows run against: the window's real one, nothing beside it. */
	const manageFs: ManageFs = {
		readText: readTextFile,
		writeText: (file, text) => fs.writeFileSync(file, text),
		exists: file => fs.existsSync(file),
	};

	/** The folders the project scope reads, empty while the window is untrusted — like the listing. */
	const trustedWorkspaceDirs = (): string[] => (vscode.workspace.isTrusted ? workspaceFolderPaths() : []);

	const agentsProvider: vscode.ChatCustomAgentProvider = {
		onDidChangeCustomAgents: changed.event,
		provideCustomAgents: (): NamedChatResource[] => discoverAgents(agentRoots(profileInForce(), workspaceFolderPaths()), fsReader)
			.map(agent => ({ uri: vscode.Uri.file(agent.file), name: agent.name, ...(agent.description === undefined ? {} : { description: agent.description }) })),
	};

	/** Where pi's skills are right now: the packages it has decide part of it. */
	const currentSkillRoots = (): readonly ResourceRoot[] =>
		skillRoots(profileInForce(), workspaceFolderPaths(), readPackages().packages.flatMap(found => packageSkillDirs(found.path, fsReader)));

	const skillsProvider: vscode.ChatSkillProvider = {
		onDidChangeSkills: changed.event,
		provideSkills: (): NamedChatResource[] => discoverSkills(currentSkillRoots(), fsReader)
			.map(skill => ({ uri: vscode.Uri.file(skill.file), name: skill.name, ...(skill.description === undefined ? {} : { description: skill.description }) })),
	};

	const mcpProvider: vscode.McpServerDefinitionProvider = {
		onDidChangeMcpServerDefinitions: changed.event,
		provideMcpServerDefinitions: (): vscode.McpServerDefinition[] => {
			const read = mcpServersFrom(mcpConfigFiles(profileInForce()));
			for (const line of read.skipped) {
				report(`MCP: ${line}`);
			}
			return read.servers.map(mcpDefinition);
		},
	};

	// The three registrations. `chat` carries the two proposed providers (declared in the manifest
	// as `chatPromptFiles`), and `lm`'s MCP provider is stable.
	disposables.push(vscode.chat.registerCustomAgentProvider(agentsProvider));
	disposables.push(vscode.chat.registerSkillProvider(skillsProvider));
	disposables.push(vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, mcpProvider));

	// The Agent Customizations page, when it is looking at one of PiCode's own sessions: the agents
	// and skills it lists, and — what the page could not do before — the folders it **creates** them
	// in. The page's default folders are GitHub's (`.github/agents`, the editor's prompts home), so an
	// agent created there appeared in the list and was never loaded by pi: it looked real and could
	// not answer. With this registration the creation picker offers pi's own places, and a new file is
	// picked up by the same discovery the chat's pickers use.
	const customizationType = vscode.ChatSessionCustomizationType;
	const piCreationFolders = (type: string): { uri: vscode.Uri; label: string; source: 'user' | 'local' }[] => {
		if (type === customizationType.Agent.id) {
			return agentRoots(profileInForce(), workspaceFolderPaths()).map(root => ({
				uri: vscode.Uri.file(root.dir),
				label: root.source === 'local' ? 'This project' : 'PiCode profile',
				source: root.source === 'local' ? 'local' as const : 'user' as const,
			}));
		}
		if (type === customizationType.Skill.id) {
			// Only the two places a person writes skills: the profile, and the project. A package's own
			// skill directory is the package's to keep, not a place to create somebody else's file.
			return [
				{ uri: vscode.Uri.file(path.join(profileInForce(), 'skills')), label: 'PiCode profile', source: 'user' },
				...workspaceFolderPaths().map(folder => ({ uri: vscode.Uri.file(path.join(folder, '.pi', 'skills')), label: folder, source: 'local' as const })),
			];
		}
		return [];
	};
	disposables.push(vscode.chat.registerChatSessionCustomizationProvider('pi', { label: 'PiCode' }, {
		onDidChange: changed.event,
		provideChatSessionCustomizations: () => [
			...discoverAgents(agentRoots(profileInForce(), workspaceFolderPaths()), fsReader).map(agent => ({
				uri: vscode.Uri.file(agent.file),
				type: customizationType.Agent,
				name: agent.name,
				...(agent.description === undefined ? {} : { description: agent.description }),
				source: agent.source,
			})),
			...discoverSkills(currentSkillRoots(), fsReader).map(skill => ({
				uri: vscode.Uri.file(skill.file),
				type: customizationType.Skill,
				name: skill.name,
				...(skill.description === undefined ? {} : { description: skill.description }),
				source: skill.source,
			})),
		],
		provideSourceFolders: (_session, type) => piCreationFolders(type.id),
	}));

	// pi's agents and skills, wherever they are: the profile in force, each folder's project
	// directory, and the skill directories of the installed packages.
	const profileDir = profileInForce();
	for (const root of [...agentRoots(profileDir, workspaceFolderPaths()), ...currentSkillRoots()]) {
		watch(root.dir, '**/*.md');
	}
	// The files that decide the other two lists: the settings file says which packages pi has, and
	// `mcp.json` says which servers. Watching the `npm` install itself would mean watching
	// `node_modules`, which the editor excludes from watching by default — a package installed while
	// the window is open appears after a reload, and that is reported rather than hidden.
	for (const file of [
		path.join(profileDir, 'settings.json'),
		path.join(profileDir, 'mcp.json'),
		...workspaceFolderPaths().flatMap(folder => [
			path.join(folder, '.pi', 'settings.json'),
			path.join(folder, '.pi', 'mcp.json'),
		]),
	]) {
		watch(path.dirname(file), path.basename(file));
	}

	// A folder added to the window changes what the lists answer. The watchers of the folders that
	// were already open stay where they are, which is enough: the event makes the page re-ask.
	disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
		packages = undefined;
		changed.fire();
	}));

	// The page's own door onto the package list, for the discovery that cannot use a provider.
	// The answer now carries each package's state: its declaration as the settings file spells
	// it, Enabled or Disabled, and the scope the declaration was found in — the disabled record
	// merged in, so a disabled package still appears and the page can offer to enable it.
	const packageRows = (): PiPackageRow[] => {
		const profileDir = profileInForce();
		const read = readPackages();
		const info = packageDisplayInfo(read.packages, packageScopes(profileDir), readDisabledRecord(), profileDir);
		return read.packages.map(found => ({ ...found, ...info.get(found.path) }));
	};

	disposables.push(vscode.commands.registerCommand(PACKAGES_COMMAND, async (): Promise<PiPackageRow[]> => packageRows()));

	// "Launched agents": the HOST panel's row opens this. The count the panel shows is the
	// same listing read (`agents.ts`), so the picker answers what the number promises — the
	// delegations the open projects launched, what each was asked, and what its own
	// transcript says it is doing. A pick reveals the agent's transcript: the file is the
	// record of what it did, and no richer surface exists for a conversation the panel
	// cannot open as its own.
	disposables.push(vscode.commands.registerCommand('picode.agents', async () => {
		const sessionsDir = path.join(profileInForce(), 'sessions');
		let agents: ReturnType<typeof launchedAgents>;
		try {
			agents = launchedAgents(listProjectSessionFiles(sessionsDir, projectSlugsOfWindow()));
		} catch (error) {
			void vscode.window.showErrorMessage(`PiCode: the agents' transcripts could not be read — ${error instanceof Error ? error.message : String(error)}.`);
			return;
		}
		if (agents.length === 0) {
			void vscode.window.showInformationMessage('PiCode: no agent has been launched from the open projects.');
			return;
		}
		const stateIcon: Record<AgentState, string> = { working: 'loading~spin', answered: 'check', empty: 'circle-outline' };
		const stateWord: Record<AgentState, string> = { working: 'working', answered: 'answered', empty: 'not started' };
		const pick = await vscode.window.showQuickPick(
			agents.map(agent => ({
				label: agent.label,
				description: `${stateWord[agent.state]} · last active ${lastActivity(agent.mtime, Date.now())}`,
				detail: agent.parentLabel === undefined ? undefined : `launched by: ${agent.parentLabel}`,
				iconPath: new vscode.ThemeIcon(stateIcon[agent.state]),
				agent,
			})),
			{ placeHolder: 'Agents launched from the open projects', matchOnDescription: true, matchOnDetail: true },
		);
		if (pick !== undefined) {
			void vscode.window.showTextDocument(vscode.Uri.file(pick.agent.file), { preview: true });
		}
	}));

	// The background jobs the agent left running, as the pill above the chat input reads them.
	// Pure reading of what the transcript already reported: the same starts and completions the
	// chat cards draw, minus the cards. It answers even before the first turn — as "nothing
	// running" — which is why it is a plain read and not part of the status answer.
	disposables.push(vscode.commands.registerCommand(BACKGROUND_JOBS_COMMAND, () => runningBackgroundJobs()));

	// "Cancel queued": every turn waiting for its slot in this window returns without running.
	// The pill's Cancel button calls it; the turn in flight is never touched by it.
	disposables.push(vscode.commands.registerCommand('picode.cancelQueuedTurns', () => cancelQueuedTurns()));

	// The update check: which installed packages npm knows a newer version of. It runs after the
	// page has rendered — the page calls it without holding the list open — and
	// `checkPackageUpdates` caches each package's latest version for ten minutes, so refreshing
	// the page asks the registry for nothing inside that lifetime. Reading is all it does, so it
	// runs in external mode too, where only the writes stop.
	// Only packages the owner **declared** take part in the check. The list also carries modules
	// pi installed as dependencies (`quickjs-wasi` arrives inside `pi-lens`), and offering those as
	// updates is a notice that cannot be satisfied: updating them would declare them, npm would
	// keep the pinned version nested, and the same notice would come back on the next check. A
	// declaration is what makes a package the owner's to update.
	const declaredRows = (): PiPackageRow[] => packageRows().filter(row => typeof row.source === 'string' && row.source.length > 0);

	disposables.push(vscode.commands.registerCommand(PACKAGES_UPDATES_CHECK_COMMAND, async (): Promise<readonly PackageUpdateStatusRow[]> =>
		checkPackageUpdates(declaredRows().map(found => ({
			path: found.path,
			name: found.name,
			...(found.version === undefined ? {} : { version: found.version }),
			...(found.source === undefined ? {} : { source: found.source }),
		})), { log: report })));

	// The update of one package: the click on a row that says it is behind. npm runs through
	// `npm-run.ts`'s shell-free planner, over the npm project of the scope the package was
	// found installed in — the profile's first, then a trusted workspace's — so a side-by-side
	// build's spaced install folder arrives as one argument, as everywhere else here.
	disposables.push(vscode.commands.registerCommand(PACKAGES_UPDATE_COMMAND, async (source?: string): Promise<{ ok: boolean; message: string }> => {
		const target = typeof source === 'string' ? source.trim() : '';
		if (target.length === 0) {
			return { ok: false, message: 'No package source was given.' };
		}
		const refusal = externalProfileRefusal();
		if (refusal !== undefined) {
			return { ok: false, message: refusal };
		}
		const profileDir = profileInForce();
		const result = await updatePackage(target, { npmProject: npmProjectFor(target, profileDir), npmCli: locateNpmCli() });
		if (result.ok) {
			// The panel reads the STORED snapshot: an update that does not re-run the check
			// leaves the row saying it is behind until the next six-hourly pass — the "it
			// said it updated and it still says so" the owner hit. The check runs now, over
			// the profile the update just touched, and the panel repaints its answer.
			// And npm's cached "latest" goes too: after the update, the previous answer is what
			// would keep the row red.
			clearPackageUpdateCache();
			void runUpdateCheck(globalState).then(() => fire(), () => fire());
		}
		return result;
	}));

	// The Packages section's catalog and install. The search resolves nothing of the editor —
	// the rules live in `packages-registry.ts` and its failures are said here, once per session,
	// the way the package listing's are. The install resolves the editor-only parts first: the
	// bundled pi CLI (a missing one is a sentence, not an error) and the profile in force, which
	// is the directory pi installs into.
	disposables.push(vscode.commands.registerCommand(PACKAGES_SEARCH_COMMAND, async (query?: string) =>
		searchPackages(typeof query === 'string' ? query : '', { log: report })));
	disposables.push(vscode.commands.registerCommand(PACKAGES_INSTALL_COMMAND, async (target?: string) => {
		const refusal = externalProfileRefusal();
		if (refusal !== undefined) {
			return { ok: false, message: refusal };
		}
		const cliEntry = path.join(distributionRoot(requireProfileUri()), 'resources', 'pi-runtime', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
		if (!fs.existsSync(cliEntry)) {
			return { ok: false, message: 'pi is missing from this installation.' };
		}
		return installPackage(typeof target === 'string' ? target : '', { cliEntry, profileDir: profileInForce() });
	}));

	// Disable: the declaration out of the settings file(s) that spell it, the source remembered
	// per profile. The listing's cache is dropped and the page is told, so the row turns
	// Disabled without waiting for the file watcher.
	disposables.push(vscode.commands.registerCommand(PACKAGES_DISABLE_COMMAND, async (source?: string): Promise<{ ok: boolean; message: string }> => {
		const target = typeof source === 'string' ? source.trim() : '';
		if (target.length === 0) {
			return { ok: false, message: 'No package source was given.' };
		}
		const refusal = externalProfileRefusal();
		if (refusal !== undefined) {
			return { ok: false, message: refusal };
		}
		const result = disablePackageSource(target, {
			profileDir: profileInForce(),
			workspaceDirs: trustedWorkspaceDirs(),
			fs: manageFs,
			record: readDisabledRecord(),
		});
		writeDisabledRecord(result.record);
		fire();
		return { ok: true, message: `Package ${target} disabled. It is out of pi's settings; its files are untouched.` };
	}));

	// Enable: the declaration back into the profile settings, the record cleaned, and — when
	// the package's files are gone from every scope — pi's installer run again, the same flow
	// the install command uses.
	disposables.push(vscode.commands.registerCommand(PACKAGES_ENABLE_COMMAND, async (source?: string): Promise<{ ok: boolean; message: string }> => {
		const target = typeof source === 'string' ? source.trim() : '';
		if (target.length === 0) {
			return { ok: false, message: 'No package source was given.' };
		}
		const refusal = externalProfileRefusal();
		if (refusal !== undefined) {
			return { ok: false, message: refusal };
		}
		const profileDir = profileInForce();
		const result = enablePackageSource(target, {
			profileDir,
			workspaceDirs: trustedWorkspaceDirs(),
			fs: manageFs,
			record: readDisabledRecord(),
		});
		writeDisabledRecord(result.record);
		const installed = packageInstallPaths(target, profileDir, trustedWorkspaceDirs());
		if (!installed.some(file => fs.existsSync(file))) {
			const cliEntry = piCliEntry();
			if (!fs.existsSync(cliEntry)) {
				return { ok: false, message: 'pi is missing from this installation.' };
			}
			const reinstall = await installPackage(target, { cliEntry, profileDir });
			if (!reinstall.ok) {
				return reinstall;
			}
		}
		fire();
		return { ok: true, message: `Package ${target} enabled.` };
	}));

	// Uninstall: pi's own `pi remove`, the same spawn the install runs, and the source out of
	// the disabled record. The confirmation is the page's to ask; this command performs.
	disposables.push(vscode.commands.registerCommand(PACKAGES_UNINSTALL_COMMAND, async (source?: string): Promise<{ ok: boolean; message: string }> => {
		const target = typeof source === 'string' ? source.trim() : '';
		if (target.length === 0) {
			return { ok: false, message: 'No package source was given.' };
		}
		const refusal = externalProfileRefusal();
		if (refusal !== undefined) {
			return { ok: false, message: refusal };
		}
		const cliEntry = piCliEntry();
		if (!fs.existsSync(cliEntry)) {
			return { ok: false, message: 'pi is missing from this installation.' };
		}
		const result = await removePackage(target, { cliEntry, profileDir: profileInForce() });
		if (result.ok) {
			writeDisabledRecord(disabledRecordWithout(readDisabledRecord(), profileInForce(), target));
			fire();
		}
		return result;
	}));

	// The MCP section's "Add Server": it writes into pi's profile through `addMcpServer`, and a
	// failure inside it is said there rather than rejected — the core falls back to the editor's
	// own add flow on a rejection, and that flow writes a file pi never reads.
	disposables.push(vscode.commands.registerCommand(ADD_MCP_SERVER_COMMAND, async () => {
		try {
			await addMcpServer(profileInForce());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`PiCode: the MCP server could not be added (${message}).`);
		}
	}));

	// The MCP section's "Edit Server" and "Remove Server" for pi's own rows: the page hands the
	// server's name over, and the file that holds the entry is located here, where the profile
	// in force and the workspace folders are known. Like "Add Server", a failure is said here
	// rather than rejected, and the file is left as it was.
	disposables.push(vscode.commands.registerCommand(EDIT_MCP_SERVER_COMMAND, async (name?: string) => {
		try {
			await editMcpServerCommand(profileInForce(), typeof name === 'string' ? name : undefined);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`PiCode: the MCP server could not be edited (${message}).`);
		}
	}));
	disposables.push(vscode.commands.registerCommand(REMOVE_MCP_SERVER_COMMAND, async (name?: string) => {
		try {
			await removeMcpServerCommand(profileInForce(), typeof name === 'string' ? name : undefined);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`PiCode: the MCP server could not be removed (${message}).`);
		}
	}));


	// The MCP switch, run from the status panel's rows: pi reads `enabled` in the file that holds the
	// entry, so flipping it turns a server off without losing it. The entry lives in the profile's file or
	// in a workspace folder's; the first that holds it is the one that owns it, because a project entry
	// replaces the profile's of the same name.
	disposables.push(vscode.commands.registerCommand(TOGGLE_MCP_SERVER_COMMAND, (name?: string): { name: string; on: boolean } | undefined => {
		const server = (name ?? '').trim();
		if (server.length === 0) {
			return;
		}
		for (const file of mcpConfigFiles(profileInForce())) {
			const toggled = mcpServersTextWithToggled(readJsonFile(file.path), server);
			if (toggled === undefined) {
				continue;
			}
			try {
				fs.writeFileSync(file.path, toggled.text, { mode: 0o600 });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(`PiCode: "${server}" could not be switched (${message}).`);
				return;
			}
			// The editor's own list follows: an entry that is off stops being offered as a server, so the
			// page re-reads and its own row moves by one.
			fire();
			void vscode.window.showInformationMessage(`PiCode: "${server}" is now ${toggled.on ? 'on' : 'off'}.`);
			// Answered so the MCP page can move its own row with what was just written, rather
			// than re-reading the whole status (git included) to learn one boolean.
			return { name: server, on: toggled.on };
		}
		void vscode.window.showErrorMessage(`PiCode: "${server}" is not one of pi's servers any more.`);
		return undefined;
	}));

	// The MCP sign-in, from the status panel's "needs sign-in" row and the MCP page's Sign in
	// button: pi's own `mcp login <server>` as a child process. The child carries
	// `PI_CODING_AGENT_DIR` pointed at **PiCode's own profile** (`mcp-provider.ts`), which is
	// what makes pi's OAuth store write the credential into `data/pi-agent/mcp-auth.json` — the
	// file the sign-in rows read, and the one that has to survive the editor closing. A sign-in
	// run without that variable (a bare terminal, say) writes the machine's own pi file instead,
	// which is the relogin-every-restart the profile's empty file was measuring.
	//
	// The browser step is the owner's, and by design: the child opens it itself, and pi waits
	// for the callback exactly as it does from a terminal. This command returns at once; the
	// completion messages below are what tells the owner how it ended.
	disposables.push(vscode.commands.registerCommand(SIGN_IN_MCP_SERVER_COMMAND, async (name?: string): Promise<void> => {
		const server = (name ?? '').trim();
		if (server.length === 0) {
			return;
		}
		// PiCode's own profile only, whatever runtime is in force: this is where PiCode's pi
		// reads its credentials, and the external pi's directory is never written to.
		const profile = profileDirectory(requireProfileUri());
		const candidates = sdkCandidates(distributionRoot(requireProfileUri()));
		const entry = candidates.map(mcpCliEntryOf).find(file => fs.existsSync(file));
		if (entry === undefined) {
			void vscode.window.showErrorMessage(`PiCode: "${server}" could not be signed in — pi's own command line was not found in this installation.`);
			return;
		}
		// The sign-in is repaired before it starts: a credential the server cannot renew is one it
		// will ask for again the hour it expires.
		const sdkEntry = candidates.find(file => fs.existsSync(file));
		if (sdkEntry !== undefined) {
			await ensureSignInCanBeRenewed(profile, server, sdkEntry);
		}
		void vscode.window.showInformationMessage(`PiCode: signing in to "${server}" — complete it in the browser window that just opens.`);
		execFile(process.execPath, [entry, ...mcpLoginArgs(server)], {
			// The workspace's first folder, so pi resolves the same project file the sessions do;
			// the profile's servers are read whatever the folder is.
			cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? profile,
			env: mcpLoginEnv(profile, process.env),
			windowsHide: true,
			timeout: MCP_LOGIN_TIMEOUT_MS,
		}, (error, _stdout, stderr) => {
			if (error === null) {
				void vscode.window.showInformationMessage(`PiCode: signed in to "${server}".`);
				return;
			}
			// pi's last stderr line is the sentence that matters (a cancelled sign-in, a server
			// that does not use OAuth); the rest is its log, which is not for the dialog.
			const reason = typeof stderr === 'string' && stderr.trim().length > 0
				? stderr.trim().split('\n').pop()?.trim() ?? error.message
				: error.message;
			void vscode.window.showErrorMessage(`PiCode: "${server}" could not be signed in (${reason}).`);
		});
	}));

	return disposables;
}

/* ------------------------------------------------------------------ *
 * The provider
 * ------------------------------------------------------------------ */


/**
 * The credential as **this process** can use it, for asking an endpoint its own model list.
 *
 * `$NAME` is pi's interpolation, so it is read from the environment here. `!command` is left to
 * pi — running a command to list models would be a side effect nobody asked for — and the
 * endpoint is then asked without a key, which is what an endpoint that needs none expects.
 */
function resolveKey(key: string | undefined): string | undefined {
	if (key === undefined || key.length === 0) {
		return undefined;
	}
	if (key.startsWith('$')) {
		return process.env[key.slice(1).replace(/^\{|\}$/g, '')];
	}
	if (key.startsWith('!')) {
		return undefined;
	}
	return key;
}

/**
 * The providers the settings row declares, projected into the profile.
 *
 * The row is the surface; the profile is where pi finds them. Both are needed: the editor can
 * list a model from its own file, and only pi can run it, so a declaration that was not
 * projected would be a model row that fails the moment the agent picks it.
 *
 * An endpoint that does not answer keeps whatever the profile already had for it. A provider
 * whose list came back empty because the network was down must not vanish from the editor and
 * take its models with it.
 */
async function projectDeclaredProviders(profile: string): Promise<void> {
	const configuration = vscode.workspace.getConfiguration('picode');
	// `providers` is where the row lives now (`Settings > Chat > Providers`); `pi.providers` is read
	// as well, because a settings file written before the row moved is not a reason to lose the
	// providers written in it.
	const declared = declarationsFromSetting(configuration.get('providers') ?? configuration.get('pi.providers'));
	for (const declaration of declared) {
		const ids = await fetchModelIds(declaration.baseUrl, resolveKey(declaration.key));
		if (ids !== undefined && ids.length > 0) {
			projectDeclaration(profile, declaration, ids);
		}
	}
}

/**
 * Fired after a credential is stored, so the editor asks for the model list again.
 *
 * A subscription login adds no model to any file the editor can see by itself: the models come
 * from pi's profile, and the editor only re-reads them when it is told to.
 */
const onDidChangeModels = new vscode.EventEmitter<void>();

/**
 * A model as **pi's** catalogue describes it, reduced to what a row of the editor's list needs.
 *
 * This is the other half of "connect a subscription": logging in gives pi a credential, and the
 * models that credential unlocks are pi's to know — its catalogue carries the context window, the
 * token budget and the dialect, none of which is written down here.
 */
interface PiRuntimeModel {
	readonly id: string;
	readonly name?: string;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly cost?: PiModelCost;
	readonly input?: readonly string[];
}

interface PiRuntimeProvider {
	readonly id: string;
	readonly name?: string;
}

interface PiRuntimeServices {
	readonly modelRuntime: {
		getProviders?(): readonly PiRuntimeProvider[];
		getModels?(providerId?: string): readonly PiRuntimeModel[];
		hasConfiguredAuth?(providerId: string): boolean;
	};
}

interface PiRuntimeSdk {
	createAgentSessionServices: OfficialSdk['createAgentSessionServices'];
}

/**
 * pi's runtime for one folder, kept between listings.
 *
 * Building it loads extensions, skills and the model catalogue, which is far more work than a model
 * list is worth on every open of the picker — and the editor asks for the list often. It is
 * dropped when the folder changes and whenever a credential changes, because those are the two
 * things that change what the catalogue answers.
 */
let runtimeCache: { readonly cwd: string; readonly agentDir: string | undefined; readonly services: PiRuntimeServices } | undefined;

/**
 * How long an answer the connector already holds is served before the source is asked again.
 *
 * The configured endpoint is a network read, so its answer lives five minutes; pi's catalogue
 * is cheap once the runtime is built, and the runtime itself is cached separately, so its
 * answer lives one minute — long enough to absorb the listings the editor fires in bursts,
 * short enough that a login is never hidden behind a stale list for long.
 */
const CONFIGURED_MODELS_TTL_MS = 5 * 60_000;
const SUBSCRIPTION_MODELS_TTL_MS = 60_000;

/**
 * The last model list each source answered with, and the reads in flight for them.
 *
 * These are what make the picker open **now**: the listing serves whatever is here — fresh or
 * stale — and schedules the refreshes it needs instead of awaiting them, because the editor
 * re-asks the moment `onDidChangeLanguageModelChatInformation` fires and a slow source asked
 * once per listing would hold the picker hostage exactly when the owner is looking at it.
 * The configured cache is keyed by a **digest** of the endpoint and the key, so the key itself
 * is never held past the request (the same rule `usage-data.ts` keeps), and the subscription
 * cache is keyed by the agent directory, the one thing that changes what pi's catalogue answers.
 */
const configuredModelsCache = new Map<string, CacheEntry<vscode.LanguageModelChatInformation[]>>();
const configuredModelsInFlight = new Map<string, Promise<vscode.LanguageModelChatInformation[]>>();
const subscriptionModelsCache = new Map<string, CacheEntry<vscode.LanguageModelChatInformation[]>>();
const subscriptionModelsInFlight = new Map<string, Promise<vscode.LanguageModelChatInformation[]>>();

/** The configured cache's key: a digest, so the raw key never sits in a map. */
function configuredModelsCacheKey(config: ProviderConfiguration): string {
	return createHash('sha256').update(cacheKey(config.endpoint, config.apiKey)).digest('hex');
}

/**
 * Asks the configured endpoint for its models **in the background**, and repaints when they moved.
 *
 * Scheduled, never awaited: the listing that needs this has already answered with the stale
 * value. A failure is reported, not thrown — an endpoint that does not answer is a fact for
 * the owner, and the last list it gave stays in place either way.
 */
function refreshConfiguredModels(profile: string, configured: ProviderConfiguration, key: string): void {
	void singleFlight(configuredModelsInFlight, key, () => modelsForConfiguration(configured))
		.then(models => {
			const changed = !sameIds(configuredModelsCache.get(key)?.value ?? [], models);
			storeModels(configuredModelsCache, key, models, Date.now());
			const declaration = declarationFrom(configured);
			if (declaration !== undefined) {
				projectDeclaration(profile, declaration, models.map(info => splitModelId(info.id).modelId));
			}
			if (changed) {
				onDidChangeModels.fire();
			}
		})
		.catch((error: unknown) =>
			report(`models: the configured endpoint could not be read (${error instanceof Error ? error.message : String(error)})`));
}

/**
 * Builds pi's catalogue **in the background**, and repaints when it moved.
 *
 * The expensive part is the first runtime build for a folder — pi's extensions and skills are
 * scanned there — and it must never sit between the owner and an open picker. The runtime
 * cache inside `subscriptionModels` absorbs the rebuilds; this cache absorbs the re-reads.
 */
function refreshSubscriptionModels(agentDir: string | undefined, key: string): void {
	void singleFlight(subscriptionModelsInFlight, key, () =>
		subscriptionModels(distributionRoot(requireProfileUri()), agentDir, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()))
		.then(models => {
			const changed = !sameIds(subscriptionModelsCache.get(key)?.value ?? [], models);
			storeModels(subscriptionModelsCache, key, models, Date.now());
			// Written down here, where the answer is known to be good: the next window opens
			// with this list instead of waiting for the runtime to be built again.
			persistCachedModels();
			if (changed) {
				onDidChangeModels.fire();
			}
		})
		.catch((error: unknown) =>
			report(`models: pi's catalogue could not be read (${error instanceof Error ? error.message : String(error)})`));
}

/** Forgets the cached runtime, so the next listing reads credentials as they are now. */
export function forgetPiRuntime(): void {
	runtimeCache = undefined;
	// The subscription list is read through that runtime, so a dropped runtime must not leave
	// a cached answer standing behind it: the next listing refreshes it in the background. The
	// written-down copy goes with it — a login that changed what pi can answer must not be
	// undone by a catalogue the next window reads back off disk.
	subscriptionModelsCache.clear();
	persistCachedModels();
}

/**
 * Where the catalogue's last answer is written down, set once at activation.
 *
 * `undefined` until then, and in a host with no storage: the caches are the in-memory ones again,
 * which is what they were before this existed.
 */
let modelCacheFile: string | undefined;

/**
 * Reads the written-down catalogue into the cache, so the first listing of a window has it.
 *
 * Without this every window is a cold start: the picker opens with the profile's own rows and
 * pi's models arrive seconds later, once its runtime has been built again. The file holds what the
 * last window saw, which is what the wizard already hands the chat when it fetches the list.
 */
export function loadCachedModels(): void {
	const file = modelCacheFile;
	if (file === undefined) {
		return;
	}
	try {
		for (const [key, entry] of deserialiseCache<vscode.LanguageModelChatInformation[]>(fs.readFileSync(file, 'utf8'))) {
			subscriptionModelsCache.set(key, entry);
		}
	} catch {
		// No file yet, or one that cannot be read: the first listing refreshes it in the
		// background, which is exactly what a cold window did before it existed.
	}
}

/** Writes the catalogue down, so the next window opens with it. */
function persistCachedModels(): void {
	const file = modelCacheFile;
	if (file === undefined) {
		return;
	}
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, serialiseCache(subscriptionModelsCache), 'utf8');
	} catch {
		// A cache that cannot be written is a slower next start, never a failure now.
	}
}

/**
 * Warms the model caches **without being asked**.
 *
 * The editor resolves the list when the provider registers (and again whenever the window
 * feels like it), but between those moments the caches would sit and age. This re-reads
 * both sources on a fixed rhythm — the subscription catalogue through pi's runtime, and the
 * configured endpoint once a listing has seen its configuration — so a picker opened after
 * any stretch of idle time still answers instantly with something current.
 */
export function warmUpModels(): void {
	const agentDir = chatAgentDir(distributionRoot(requireProfileUri()));
	refreshSubscriptionModels(agentDir, agentDir ?? '');
	if (lastConfiguration?.endpoint !== undefined) {
		refreshConfiguredModels(profileDirectory(requireProfileUri()), lastConfiguration, configuredModelsCacheKey(lastConfiguration));
	}
}

/**
 * The models of the providers **with a credential**, read from pi.
 *
 * Without this, connecting a subscription would leave the model list empty: those providers have no
 * address and no `models.json` entry, and their models exist only in pi's own catalogue. A provider
 * without a credential is skipped — listing models that cannot be used would put rows in the picker
 * that fail the moment they are chosen.
 */
async function subscriptionModels(distributionRoot: string, agentDir: string | undefined, cwd: string): Promise<vscode.LanguageModelChatInformation[]> {
	const loaded = await loadPiSdk<PiRuntimeSdk>(sdkEntryCandidates(distributionRoot));
	if ('problem' in loaded || typeof loaded.sdk.createAgentSessionServices !== 'function') {
		return [];
	}
	const sdk = loaded.sdk;

	try {
		if (runtimeCache === undefined || runtimeCache.cwd !== cwd || runtimeCache.agentDir !== agentDir) {
			// The same guard every pi load has: if any declared package is still missing, it is
			// installed here (hidden, one run) rather than being left for pi's loader to install
			// with its own process — and its own window — per package.
			await ensureProfilePackages({ profileDir: profileDirectory(requireProfileUri()), runtimeRoot: piRuntimeRoot(distributionRoot), npmCli: locateNpmCli(), log: line => console.error(`[picode] ${line}`) });
			runtimeCache = { cwd, agentDir, services: await sdk.createAgentSessionServices({ cwd, ...(agentDir === undefined ? {} : { agentDir }) }) };
		}
	} catch {
		// A runtime that cannot be built is "no models from pi": the declared providers are still
		// listed, and the reason is nothing the owner could act on from here.
		return [];
	}

	const runtime = runtimeCache.services.modelRuntime;
	const models: vscode.LanguageModelChatInformation[] = [];
	for (const provider of runtime.getProviders?.() ?? []) {
		if (typeof runtime.hasConfiguredAuth === 'function' && !runtime.hasConfiguredAuth(provider.id)) {
			continue;
		}
		for (const model of runtime.getModels?.(provider.id) ?? []) {
			if (typeof model.id !== 'string' || model.id.length === 0) {
				continue;
			}
			models.push({
				id: `${provider.id}/${model.id}`,
				name: model.name ?? model.id,
				family: provider.id,
				version: '1',
				maxInputTokens: model.contextWindow ?? 128000,
				maxOutputTokens: model.maxTokens ?? 16384,
				detail: provider.id,
				capabilities: { toolCalling: true, ...(acceptsImages(model.input) ? { imageInput: true } : {}) },
				...modelPricing(model.cost),
			});
		}
	}
	return models;
}

const provider: vscode.LanguageModelChatProvider = {
	onDidChangeLanguageModelChatInformation: onDidChangeModels.event,


	async provideLanguageModelChatInformation(options, _token) {
		const profile = profileDirectory(requireProfileUri());
		const now = Date.now();

		// The editor's **own provider form**, when the owner filled it in: it is the surface that
		// renders the declared fields, with the key stored as a secret. Kept from the last listing
		// because the request that follows carries the model but not the configuration.
		const configured = readConfiguration(options.configuration);
		if (configured.endpoint === undefined) {
			lastConfiguration = undefined;
		} else {
			lastConfiguration = configured;
		}

		// The listing answers **now** with what the caches hold — fresh or stale, never missing
		// once a previous listing saw the value — and schedules the refreshes it needs instead of
		// awaiting them. A slow source must not hold the picker hostage exactly when the owner is
		// looking at it: the editor re-asks the moment `onDidChangeLanguageModelChatInformation`
		// fires, and the refreshed lists arrive that way.
		const configuredKey = configuredModelsCacheKey(configured);
		const configuredRead = configured.endpoint === undefined
			? { value: undefined as vscode.LanguageModelChatInformation[] | undefined, fresh: true }
			: cachedModels(configuredModelsCache, configuredKey, CONFIGURED_MODELS_TTL_MS, now);
		const fromConfigured = configuredRead.value ?? [];
		if (configuredRead.value !== undefined) {
			// The declaration the editor's form projects carries the model ids, so it is written
			// from the cached list when there is one — the ids read from a previous listing are
			// what pi needs, and a projection from a guess would be worse than none.
			const declaration = declarationFrom(configured);
			if (declaration !== undefined) {
				projectDeclaration(profile, declaration, fromConfigured.map(info => splitModelId(info.id).modelId));
			}
		}
		if (!configuredRead.fresh) {
			refreshConfiguredModels(profile, configured, configuredKey);
		}

		// The **lines the owner writes in the settings list**, projected so pi knows them too, and
		// then the profile read back: it now holds both of the above plus every provider an earlier
		// version of the connecting flow wrote there. This stays in the response path on purpose:
		// pi depends on the projection being done before the owner's next request, and deferring
		// it would let a request reach a model pi cannot yet see.
		await projectDeclaredProviders(profile);

		const models = readModelsFile(profile);
		const fromProfile = models === undefined ? [] : toChatInformation(models);

		const agentDir = chatAgentDir(distributionRoot(requireProfileUri()));
		const subscriptionKey = agentDir ?? '';
		const subscriptionRead = cachedModels(subscriptionModelsCache, subscriptionKey, SUBSCRIPTION_MODELS_TTL_MS, now);
		const fromSubscriptions = subscriptionRead.value ?? [];
		if (!subscriptionRead.fresh) {
			refreshSubscriptionModels(agentDir, subscriptionKey);
		}

		const configuredIds = new Set(fromConfigured.map(info => info.id));
		const profileIds = new Set(fromProfile.map(info => info.id));
		const merged = [
			...fromConfigured,
			...fromProfile.filter(info => !configuredIds.has(info.id)),
			...fromSubscriptions.filter(info => !configuredIds.has(info.id) && !profileIds.has(info.id)),
		];
		// The model **pi is configured with** is the picker's default, so the chat opens on the
		// model a session actually runs instead of whichever name happens to sort first — the
		// two disagreeing is the defect this closes. It is read live from pi's own
		// `settings.json`, so changing pi's default moves the chat's default with it, and it is
		// only the *seed*: a model the owner picked for a conversation still outranks it.
		const piDefault = readDefaultModel(profile);
		if (piDefault === undefined || !merged.some(info => info.id === piDefault)) {
			return merged;
		}
		return merged.map(info => info.id === piDefault ? { ...info, isDefault: true } : info);
	},

	/**
	 * How many tokens a piece of text is worth, for the editor's context budget.
	 *
	 * An **estimate**, and said as such: the real count needs the provider's own tokeniser,
	 * which none of these endpoints exposes, and pi reports its own real usage after every
	 * turn anyway. Four characters per token is the usual rule of thumb, and it errs on the
	 * safe side for the one thing this number decides — how much room is left. It is never
	 * shown to the owner as a fact.
	 */
	provideTokenCount(_model, text, _token): Thenable<number> {
		let length = 0;
		if (typeof text === 'string') {
			length = text.length;
		} else {
			length = text.content.reduce<number>(
				(sum, part) => sum + (part instanceof vscode.LanguageModelTextPart ? part.value.length : 0),
				0,
			);
		}
		return Promise.resolve(Math.ceil(length / 4));
	},

	async provideLanguageModelChatResponse(model, messages, _options, progress, token) {
		// The configured provider answers only for **its own** models: a declared provider's models
		// are routed from the profile, or every request would be sent to whichever endpoint the
		// owner last filled in the editor's form.
		const { providerId, modelId } = splitModelId(model.id);
		const configuredId = lastConfiguration?.endpoint === undefined ? undefined : lastConfiguration.id ?? 'pi';
		if (lastConfiguration !== undefined && configuredId === providerId) {
			return sendToEndpoint(
				lastConfiguration.endpoint!,
				lastConfiguration.api ?? 'openai-completions',
				lastConfiguration.apiKey,
				modelId,
				messages,
				progress,
				token,
			);
		}

		const models = readModelsFile(profileDirectory(requireProfileUri()));
		const entry = models?.providers?.[providerId];
		if (entry === undefined || typeof entry.baseUrl !== 'string') {
			throw new Error(
				`Model ${model.id} points at a provider that is not declared in PiCode's profile.`,
			);
		}

		// The key is kept in `auth.json` for providers connected through pi's own login, and
		// in `models.json` for an endpoint declared by hand. Both are read; the value never
		// leaves this process and is never shown.
		return sendToEndpoint(
			entry.baseUrl,
			entry.api,
			resolveApiKey(entry, providerId),
			modelId,
			messages,
			progress,
			token,
		);
	},
};

/**
 * Sends one request to an endpoint and streams the answer back.
 *
 * Shared by the two ways a provider can be known — the editor's own configuration and the
 * `models.json` the connecting command writes — because the request is the same HTTP call in
 * both cases and a second copy of it would be a second place to keep right.
 */
async function sendToEndpoint(
	baseUrl: string,
	api: string | undefined,
	apiKey: string | undefined,
	modelId: string,
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
	token: vscode.CancellationToken,
): Promise<void> {
	const body = buildRequestBody(api, modelId, messages);
	const url = `${baseUrl.replace(/\/$/, '')}${api === 'openai-responses' ? '/responses' : '/chat/completions'}`;

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(apiKey === undefined || apiKey.length === 0 ? {} : { authorization: `Bearer ${apiKey}` }),
		},
		body: JSON.stringify(body),
		// Cancelling the editor's request has to cancel the one in flight; otherwise the answer
		// keeps arriving for a question nobody is waiting for any more.
		signal: token.isCancellationRequested ? AbortSignal.abort() : undefined,
	});

	if (!response.ok || response.body === null) {
		throw new Error(`the provider answered ${response.status}`);
	}

	// The two dialects the editor's providers speak; anything else arrives as chat
	// completions, which is what a compatible endpoint expects by default.
	const dialect: ProviderApi = api === 'openai-responses' ? 'openai-responses' : 'openai-completions';
	await streamInto(response.body, dialect, progress, token);
}

/** How a provider's key is found: the entry's own, or the profile's `auth.json`. */
function resolveApiKey(entry: PiProviderEntry, providerId: string): string | undefined {
	const declared = entry.apiKey;
	if (typeof declared === 'string' && declared.length > 0) {
		// pi's forms: a literal, `$NAME` for an environment variable, or `!command`.
		if (declared.startsWith('$')) {
			return process.env[declared.slice(1).replace(/^\{|\}$/g, '')];
		}
		if (!declared.startsWith('!')) {
			return declared;
		}
	}
	try {
		const file = path.join(profileDirectory(requireProfileUri()), 'auth.json');
		const auth: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
		const record =
			typeof auth === 'object' && auth !== null
				? (auth as Record<string, { key?: unknown }>)[providerId]
				: undefined;
		return typeof record?.key === 'string' ? record.key : undefined;
	} catch {
		return undefined;
	}
}

/** The request body, in one of the two dialects the editor's providers speak. */
type ProviderRequestBody =
	| { readonly model: string; readonly input: readonly unknown[]; readonly stream: true }
	| { readonly model: string; readonly messages: readonly unknown[]; readonly stream: true };

/** The request body, in the dialect the provider declares. */
function buildRequestBody(api: string | undefined, modelId: string, messages: readonly vscode.LanguageModelChatRequestMessage[]): ProviderRequestBody {
	const converted = messages.map(message => ({
		role: message.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant',
		content: message.content
			.map(part => (part instanceof vscode.LanguageModelTextPart ? part.value : ''))
			.join(''),
	}));
	// The two shapes the editor's own providers use; anything else is sent as chat
	// completions, which is what a compatible endpoint expects by default.
	return api === 'openai-responses'
		? { model: modelId, input: converted, stream: true }
		: { model: modelId, messages: converted, stream: true };}

/**
 * Reads the provider's stream and forwards the answer AND the model's thinking as they
 * arrive.
 *
 * Server-sent events: lines beginning `data:` carry a JSON object, and `[DONE]` ends it.
 * The dialect table (`parseProviderStreamEvent`) tells text from reasoning — the reasoning
 * is what the owner reads as the thinking section, and dropping it was why the model
 * thought on record and the chat showed nothing. Whether it is forwarded at all is the
 * same switch the chat participant obeys (`picode.pi.reasoning`), read live so the
 * Thinking row's flip lands on the next turn without a reload.
 */
async function streamInto(
	body: ReadableStream<Uint8Array>,
	api: 'openai-completions' | 'openai-responses',
	progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
	token: vscode.CancellationToken,
): Promise<void> {
	const showThinking = vscode.workspace.getConfiguration('picode').get<string>('pi.reasoning') !== 'hide';
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	while (!token.isCancellationRequested) {
		const chunk = await reader.read();
		if (chunk.done) {
			break;
		}
		buffer += decoder.decode(chunk.value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('data:')) {
				continue;
			}
			const payload = trimmed.slice(5).trim();
			if (payload === '[DONE]') {
				return;
			}
			const parts = parseProviderStreamEvent(payload, api);
			if (parts === undefined) {
				continue;
			}
			if (parts.thinking !== undefined && parts.thinking.length > 0 && showThinking) {
				progress.report(new vscode.LanguageModelThinkingPart(parts.thinking));
			}
			if (parts.text !== undefined && parts.text.length > 0) {
				progress.report(new vscode.LanguageModelTextPart(parts.text));
			}
		}
	}
}

/* ------------------------------------------------------------------ *
 * Activation
 * ------------------------------------------------------------------ */

/**
 * This extension's own location, resolved once at activation.
 *
 * Module state on purpose: the provider's methods are called by the editor with no context
 * of ours, and resolving the path on every model listing would be a filesystem walk per
 * keystroke in the picker.
 */
let profileUri: vscode.Uri | undefined;

/**
 * The provider the owner configured in the editor's own settings, kept from the last time the
 * editor asked for models.
 *
 * Kept because the request that follows carries the model but not the configuration: the
 * editor asks for the model list first and then sends into one of those models, so the
 * configuration read at listing time is the one that belongs to the request.
 */
let lastConfiguration: ProviderConfiguration | undefined;

/**
 * That location, or a refusal.
 *
 * Read through a function so an early call — the editor can ask for models before
 * activation has run — fails with a sentence instead of dereferencing nothing.
 */
/* ------------------------------------------------------------------ *
 * The update check
 *
 * One question — is what this editor runs behind what npm has — asked quietly: 30 seconds
 * after activation and then every six hours, never competing with startup. The answer shows
 * as a notification and as a status-bar item (the workbench's toast position is its own, so
 * the item is the corner the owner actually sees), and the snapshot it produced survives
 * restarts in globalState until an update happens or a check says clean.
 * ------------------------------------------------------------------ */

/** The setting that turns the whole check off; on unless the owner says otherwise. */
const UPDATES_CHECK_SETTING = 'picode.updates.check';

// Where the answer is stored is `updates-check.ts`'s business, beside the shape it holds: the status
// panel reads the same answer, and two spellings of that key would be one too many.

/** The check starts this long after activation: past the work every startup actually does. */
const UPDATES_FIRST_CHECK_DELAY_MS = 30_000;

/** And then every six hours for as long as the window is open. */
const UPDATES_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

/** Whether the owner wants the check to run at all. */
function updatesCheckEnabled(): boolean {
	return vscode.workspace.getConfiguration().get<boolean>(UPDATES_CHECK_SETTING, true);
}

/** The stored value as a snapshot, or `undefined` when nothing usable was stored. */
function readUpdatesSnapshot(globalState: vscode.Memento): UpdatesSnapshot | undefined {
	return parseSnapshot(globalState.get<unknown>(UPDATES_STATE_KEY));
}

/** Whether `file` lives under `dir` — path-relative, so a sibling sharing a prefix is not inside. */
function isInside(dir: string, file: string): boolean {
	const relative = path.relative(dir, file);
	return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The candidates one check compares: the runtime in force, and the npm packages of the
 * profile pi loads. Everything arrives as "installed version if readable" — the assembly
 * in `updates-check.ts` decides what is actually behind, and a missing or junk version is
 * simply not a claim the check makes.
 */
async function gatherUpdateCandidates(): Promise<readonly CandidateTarget[]> {
	// With the machine's own pi in force there is nothing PiCode may update: that pi and its packages
	// are the owner's, and this product promises never to change them (the setting says so in as many
	// words). The check goes quiet instead of offering an update it must refuse to perform — an
	// unavailable update is not news, and a status-bar item leading to "no" is worse than none.
	if (readRuntimeMode() === 'external') {
		return [];
	}

	const candidates: CandidateTarget[] = [];

	// The runtime: the internal one from its manifest, the external one from the probe of the
	// machine's pi. Both are versions of the same npm package, so the latest is the same lookup.
	const installedPi = readRuntimeMode() === 'external'
		? (await probeExternalPi()).version
		: readInternalPiVersion(distributionRoot(requireProfileUri()));
	candidates.push({ kind: 'runtime', name: 'pi', installed: installedPi, latest: await fetchNpmLatest(PI_RUNTIME_PACKAGE, { log: report }) });

	// The npm packages of the profile in force. Git checkouts carry no version to compare and
	// are skipped.
	const scopes = packageScopes(profileInForce());
	const npmRoots = scopes.map(scope => scope.npmRoot);
	const profileDir = profileInForce();
	// Only what the owner **declared**. The list pi loads also carries modules it installed as
	// dependencies of a package (`quickjs-wasi` arrives inside `pi-lens`); offering those as updates
	// is a notice nobody can satisfy — "updating" one only declares it, npm keeps the pinned copy
	// nested, and the same notice returns on the next check.
	//
	// The mark of a declaration is its **source string**: `packageDisplayInfo` fills an entry for
	// every package (that is what the page needs), so testing for membership decided nothing — the
	// first version of this filter let everything through.
	const allPackages = piPackages(scopes, nodeFs()).packages;
	const declaredPaths = new Set(
		[...packageDisplayInfo(allPackages, scopes, {}, profileDir).entries()]
			.filter(([, info]) => info.source !== undefined && info.source.length > 0)
			.map(([path]) => path),
	);
	const npmPackages = allPackages.filter((found): found is PiPackage & { version: string } =>
		found.version !== undefined
		// A package the product left behind is not news: nothing here installs or uses it.
		&& !LEFT_BEHIND_PACKAGE_NAMES.includes(found.name)
		&& declaredPaths.has(found.path)
		&& npmRoots.some(root => isInside(root, found.path)));

	const latestVersions = await Promise.all(npmPackages.map(found => fetchNpmLatest(found.name, { log: report })));
	npmPackages.forEach((found, index) => {
		const latest = latestVersions[index];
		if (latest !== undefined) {
			candidates.push({ kind: 'package', name: found.name, installed: found.version, latest });
		}
	});
	return candidates;
}

/**
 * One check, run and stored: the snapshot is what the status bar and the notification read,
 * and what the next start finds in globalState.
 */
async function runUpdateCheck(globalState: vscode.Memento): Promise<UpdatesSnapshot | undefined> {
	const snapshot: UpdatesSnapshot = { checkedAt: Date.now(), targets: updatableTargets(await gatherUpdateCandidates()) };
	await globalState.update(UPDATES_STATE_KEY, snapshot);
	return snapshot;
}

/**
 * The whole update surface, registered once: the status-bar item, the command behind it, the
 * notification with its two buttons, and the `pi update` flow the Update button runs.
 */
function registerUpdateChecks(context: vscode.ExtensionContext): void {
	// Left of the status bar, low priority: the corner the owner reads, without pushing the
	// editor's own indicators around.
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1_000);
	status.name = 'PiCode updates';
	status.text = '$(cloud-download) PiCode updates';
	status.command = 'picode.updates.show';
	context.subscriptions.push(status);

	const showStatus = (snapshot: UpdatesSnapshot | undefined): void => {
		if (snapshot !== undefined && snapshot.targets.length > 0) {
			status.tooltip = `PiCode: updates available — ${describeTargets(snapshot.targets)}`;
			status.show();
		} else {
			status.hide();
		}
	};

	/** The update itself: stop the chat's pi, let pi update everything, then reload. */
	const runUpdateFlow = async (): Promise<void> => {
		// The check is quiet with the machine's pi in force, but a snapshot from before a runtime switch
		// (or the status-bar item it left) must not be able to talk this flow into writing there.
		if (readRuntimeMode() === 'external') {
			void vscode.window.showInformationMessage('PiCode: your own pi and its packages update where they live — this editor never writes to them.');
			return;
		}
		const cliEntry = piCliEntry();
		if (!fs.existsSync(cliEntry)) {
			void vscode.window.showInformationMessage('PiCode could not be updated: pi is missing from this installation.');
			return;
		}
		// The chat runs pi in this very process: its session must be gone before the files under
		// it change, or it keeps running the code being replaced.
		resetChatSession();
		const result = await runPiUpdate({ cliEntry, runtimeDir: piRuntimeDir(), profileDir: profileInForce(), npmCli: locateNpmCli() });
		if (!result.ok) {
			void vscode.window.showInformationMessage(result.message);
			return;
		}
		// The optimistic clear: the new version is on disk, the reload loads it, and the check
		// that runs after the reload rebuilds the truth from scratch.
		await context.globalState.update(UPDATES_STATE_KEY, undefined);
		showStatus(undefined);
		void vscode.window.showInformationMessage(
			'PiCode updated. Reload the window to start using the new version.',
			'Reload Window',
		).then(choice => {
			if (choice === 'Reload Window') {
				void vscode.commands.executeCommand('workbench.action.reloadWindow');
			}
		});
	};

	/** Forgets npm's cached answers: what was "latest" before an update may not be after it. */
	const forgetUpdateAnswers = (): void => {
		clearPackageUpdateCache();
	};

	const showUpdatesNotice = (snapshot: UpdatesSnapshot | undefined): void => {
		if (snapshot === undefined || snapshot.targets.length === 0) {
			void vscode.window.showInformationMessage('PiCode: everything is up to date.');
			return;
		}
		void vscode.window.showInformationMessage(
			`PiCode: updates available — ${describeTargets(snapshot.targets)}`,
			'Update',
			'Later',
		).then(choice => {
			if (choice === 'Update') {
				void runUpdateFlow();
			}
			// "Later" and a dismissal need no action: the status-bar item stays until the update
			// happens or a check says clean.
		});
	};

	context.subscriptions.push(vscode.commands.registerCommand('picode.updates.show', () =>
		showUpdatesNotice(readUpdatesSnapshot(context.globalState))));

	let checking = false;
	let firstBackgroundCheck = true;
	/**
	 * One check, run now: by the timer on its own rhythm, or by the owner asking (`picode.updates.check`).
	 *
	 * `force` is that second case. The setting silences the **background** check; somebody asking for an
	 * answer out loud has already overruled it, so a manual check runs even with the setting off.
	 */
	const scheduledCheck = async (force = false): Promise<void> => {
		// One flight at a time — a slow registry must not stack checks — and the setting is read
		// at fire time, so turning it off silences the check without a restart.
		if (checking || (!force && !updatesCheckEnabled())) {
			return;
		}
		// Asked for out loud ("Check again"): forget what was cached, so the answer describes the
		// disk as it is now rather than as it was before the update.
		if (force) {
			forgetUpdateAnswers();
		}
		checking = true;
		try {
			const snapshot = await runUpdateCheck(context.globalState);
			showStatus(snapshot);
			// Say it once, on the first background check of the session, when something new appeared
			// since the last time. After that the status bar carries the news until the owner acts.
			if (firstBackgroundCheck && snapshot !== undefined && snapshot.targets.length > 0) {
				void showUpdatesNotice(snapshot);
			}
			firstBackgroundCheck = false;
		} catch (error) {
			report(`updates: the check failed (${error instanceof Error ? error.message : String(error)})`);
		} finally {
			checking = false;
		}
	};

	// The last check's answer survives restarts, so the item is back the moment the window is —
	// before the first check of this session has run.
	showStatus(readUpdatesSnapshot(context.globalState));
	// If a previous check already found updates, say so once, on startup, instead of waiting for
	// the owner to open the panel. The delay lets the window finish opening before the toast.
	const cachedSnapshot = readUpdatesSnapshot(context.globalState);
	if (cachedSnapshot !== undefined && cachedSnapshot.targets.length > 0) {
		setTimeout(() => void showUpdatesNotice(cachedSnapshot), 8000);
	}
	const firstCheck = setTimeout(() => { void scheduledCheck(); }, UPDATES_FIRST_CHECK_DELAY_MS);
	const interval = setInterval(() => { void scheduledCheck(); }, UPDATES_CHECK_INTERVAL_MS);
	context.subscriptions.push(new vscode.Disposable(() => {
		clearTimeout(firstCheck);
		clearInterval(interval);
	}));

	// The status panel's Updates block reaches the very same two flows: this extension has one update
	// path and one check path, and the panel is a second door onto them, not a second copy of them.
	context.subscriptions.push(vscode.commands.registerCommand(UPDATES_APPLY_COMMAND, () => runUpdateFlow()));
	context.subscriptions.push(vscode.commands.registerCommand(UPDATES_CHECK_COMMAND, () => scheduledCheck(true)));
}

function requireProfileUri(): vscode.Uri {
	if (profileUri === undefined) {
		throw new Error('PiCode: the connector has not activated yet, so it does not know where pi\'s profile is.');
	}
	return profileUri;
}

export function activate(context: vscode.ExtensionContext): void {
	// Everything this window starts — pi in process, npm, the helpers a package may run — inherits
	// the product's fixed environment: nothing is fetched by an install script, nothing reports usage.
	applyProductEnv(process.env, profileDirectory(context.extensionUri));
	// gentle-pi's subagents are child pi processes: they start the pi this editor carries.
	pointChildPiAtThisPi(
		path.join(piRuntimeRoot(distributionRoot(context.extensionUri)), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
		candidate => fs.existsSync(candidate),
	);
	// What those children do, and when: a line each in the log, so an agent that fails to end can be read.
	traceChildPi(require('node:child_process'), line => console.error(`[pi] ${line}`));
	// Modules that imported `spawn` by name see the wrapped one.
	require('node:module').syncBuiltinESMExports();
	profileUri = context.extensionUri;

	// One switch turns every AI feature off: `chat.disableAIFeatures`. The editor hides the chat with
	// it; here nothing else starts either — no pi, no Gentle AI, no memory engine, no provider — so
	// switching it on is a real shutdown and not a hidden panel over running processes. Changing it
	// while the window is open stops the memory engine at once and offers the reload that finishes it.
	const aiIsOff = (): boolean => vscode.workspace.getConfiguration('chat').get<boolean>('disableAIFeatures') === true;
	const aiWasOff = aiIsOff();
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (!event.affectsConfiguration('chat.disableAIFeatures') || aiIsOff() === aiWasOff) {
			return;
		}
		if (aiIsOff()) {
			stopStartedMemory();
		}
		void vscode.window.showInformationMessage(
			aiIsOff() ? 'PiCode AI is off. Reload the window to finish shutting it down.' : 'PiCode AI is on. Reload the window to start it.',
			'Reload Window',
		).then(choice => {
			if (choice !== undefined) {
				void vscode.commands.executeCommand('workbench.action.reloadWindow');
			}
		});
	}));
	if (aiWasOff) {
		return;
	}
	context.subscriptions.push(onDidChangeModels);
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));

	// The "before" half of the chat's change card: the diff the card opens compares the real
	// file against the snapshot the turn took, which exists nowhere on disk — a content
	// provider on the before-scheme is what serves it. The path a snapshot URI carries is
	// encoded whole, so any absolute path (drives and backslashes included) round-trips.
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PICODE_BEFORE_SCHEME, {
		provideTextDocumentContent(uri: vscode.Uri): string | undefined {
			return beforeContentFor(absolutePathOfBeforeUriPath(uri.path));
		},
	}));

	// The editor owns the packages of its own profile: whatever the settings declare and the disk
	// lacks is installed here, in one hidden npm run, before anything loads pi. Left alone, pi's
	// own loader installs each missing declaration with its own npm process
	// (`package-manager.js`: `resolvePackageSources` → `installNpm`, one spec per spawn, no
	// `windowsHide`), and on Windows every one of those flashed a console window — sixteen
	// declarations, sixteen windows, on every load until the tree was whole. This run is the
	// whole tree; the wizard's steps only navigate and the chat waits for the same guard, so no
	// pi load ever finds a package to install. Failures are one sentence, not silence.
	void ensureProfilePackages({
		profileDir: profileDirectory(context.extensionUri),
		runtimeRoot: piRuntimeRoot(distributionRoot(context.extensionUri)),
		npmCli: locateNpmCli(),
		log: line => console.error(`[picode] ${line}`),
	}).then(outcome => {
		if (outcome.failed > 0) {
			void vscode.window.showInformationMessage(`PiCode: ${outcome.failed} package${outcome.failed === 1 ? '' : 's'} of your profile could not be installed — ${outcome.lines[outcome.lines.length - 1] ?? 'see the log for the reason'}.`);
		}
	});

	// `@pi` in the editor's own chat. This is what makes the chat exist: the editor hides its
	// chat when there is no agent to talk to, and this supplies one — the editor's agent, not a
	// surface of ours. Nothing to configure: it finds pi and its profile by itself.
	// The chat's profile is resolved per request by the agent (see `agent.ts`), so a
	// runtime switch takes effect without a window reload. What PiCode projects for pi
	// keeps going to PiCode's own profile either way.
	// Which model each Gentle agent answers with: the same pickers from the chat's `/gentle:models`
	// and from the status view's row.
	const chooseModelsOfAgents = (): Promise<string | undefined> => chooseAgentModels({
		profileDir: profileDirectory(context.extensionUri),
		listModels: () => listModels({
			distributionRoot: distributionRoot(context.extensionUri),
			profileDir: profileDirectory(context.extensionUri),
			refreshModels: () => undefined,
		}),
		onSaved: resetChatSession,
	});
	context.subscriptions.push(vscode.commands.registerCommand(AGENT_MODELS_COMMAND, async () => {
		const done = await chooseModelsOfAgents();
		if (done !== undefined) {
			void vscode.window.showInformationMessage(done.split('\n')[0]!);
		}
	}));
	context.subscriptions.push(...registerAgentModelsStateCommands(profileDirectory(context.extensionUri), resetChatSession));
	const piParticipant = registerPiAgent(context, {
		distributionRoot: distributionRoot(context.extensionUri),
		log: line => console.error(`[pi] ${line}`),
		chooseAgentModels: chooseModelsOfAgents,
	});

	// pi's own extension commands (`/omni` and its fellows) in the input's slash list,
	// read from the runtime in force — the external pi's registry when it runs, the live
	// session's own otherwise. A runtime switch re-reads; a session change fires through
	// `onPiSessionChanged`.
	const piCommands = registerPiCommandPromptFiles(context, {
		distributionRoot: distributionRoot(context.extensionUri),
		log: line => console.error(`[pi] ${line}`),
		liveSessionCommands,
		onSessionChanged: onPiSessionChanged,
	});
	context.subscriptions.push(piCommands);

	// The MCP servers pi runs are written from the settings row, and followed while the editor is
	// open: adding one in the form is what makes it available to pi.
	applyMcpServers(profileDirectory(context.extensionUri));
	// A provider that needs no key (a local router) gets pi's dummy one, or pi refuses its models.
	fillKeylessProviders(profileDirectory(context.extensionUri));

	// Memory: pi's engine, declared to this profile and woken for the editor's own surfaces. It is
	// joined, never restarted, when it already serves this store — the same store another agent on
	// the machine may be using right now. Detached on purpose: it outlives the window, so the next
	// start finds it instead of opening another one over the same base.
	// The block exists only while memory is on: the manifest's `when` reads this key, written
	// here before the views are created and again whenever the switch is flicked.
	void vscode.commands.executeCommand('setContext', MEMORY_ENABLED_CONTEXT, memoryEnabled());
	startMemory(profileDirectory(context.extensionUri), line => console.error(`[memory] ${line}`));
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('picode.mcp.servers')) {
				applyMcpServers(profileDirectory(context.extensionUri));
			}
			// The switch, and the engine it points at: both are answered by the same call. Off
			// takes the declaration and the protocol away; on puts them back and wakes the
			// engine. The store is never touched, so nothing is lost either way.
			if (event.affectsConfiguration('picode.memory.enabled')) {
				void vscode.commands.executeCommand('setContext', MEMORY_ENABLED_CONTEXT, memoryEnabled());
				startMemory(profileDirectory(context.extensionUri), line => console.error(`[memory] ${line}`));
			}
			// The runtime in force changed, so the command list belongs to another pi's
			// registry: the slash list re-reads.
			if (event.affectsConfiguration(PICODE_RUNTIME_SETTING)) {
				piCommands.refresh();
			}
			// The declared rows changed, so the answers the endpoint cache holds can no longer be
			// trusted: they are dropped and the picker is told to ask again — which serves the
			// profile immediately and refreshes the endpoints in the background.
			if (event.affectsConfiguration('picode.providers') || event.affectsConfiguration('pi.providers')) {
				configuredModelsCache.clear();
				onDidChangeModels.fire();
			}
		}),
	);
	// A folder added or removed changes the working directory a discovery session would
	// read, so the command list is read again.
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => piCommands.refresh()));

	// Connecting a provider with a subscription. It is a **list** and not a chain of windows: pi
	// says which of its providers can be logged in with an account the owner already pays for,
	// and the editor's own quick pick is where he chooses. The endpoints with an address and a
	// dialect have their own form in the settings row, and never come through here.
	// pi's own sessions, in the editor's Sessions panel. Nothing in the editor lists the
	// runtime profile's sessions directory; this provider is the bridge, and the import
	// fires it when a tree of transcripts lands.
	// pi's own conversations, in the editor's Sessions panel: the one list. The transcripts pi
	// writes under the profile's `sessions/` folder are listed here, opened as history, and
	// continued in place; the import fires it when a tree of transcripts lands.
	const piSessions = registerPiSessionsProvider({
		participant: piParticipant,
		deps: { distributionRoot: distributionRoot(context.extensionUri), log: (line: string) => console.error(`[pi] ${line}`) },
		profileDir: profileInForce,
	});
	context.subscriptions.push(piSessions, new vscode.Disposable(disposeResumedSessions));

const setupDeps = {
		distributionRoot: distributionRoot(context.extensionUri),
		profileDir: profileDirectory(context.extensionUri),
		// `<userData>/User/globalStorage/<extension>` → three levels up. The account hand-over is
		// written straight into that `User/settings.json`, because its keys are hidden from Settings
		// and the configuration service therefore refuses to write them.
		userDataPath: path.dirname(path.dirname(path.dirname(context.globalStorageUri.fsPath))),
		globalState: context.globalState,
		// The Tasks block lists the background jobs the chat itself launched, from the same tracker the
		// pill above the chat input reads — one holder of the truth, two surfaces.
		runningJobs: runningBackgroundJobs,
		forgetRuntime: forgetPiRuntime,
		// A package install or removal must be visible to the chat immediately.
		resetChat: resetChatSession,
		// An import writes providers, models and packages onto disk: the picker must ask
		// again instead of serving what it cached before the copy.
		refreshModels: () => {
			configuredModelsCache.clear();
			onDidChangeModels.fire();
		},
		// An import also lands a tree of session transcripts: the panel re-lists.
		sessionsChanged: () => piSessions.fireChanged(),
		// npm runs shell-free, over npm's own CLI script (npm-run.ts) — the spaced install
		// folder a side-by-side build carries must not be split by a shell's concatenation.
		npmCli: locateNpmCli(),
	};
	context.subscriptions.push(...registerSetupCommands(setupDeps));
	// The theme step of Set up PiCode lives in the core, so its three questions — list the gallery,
	// read one theme's colours, install it — travel as commands. Without this registration they do
	// not exist, and the gallery answers an empty list as if the search had found nothing.
	context.subscriptions.push(...registerThemeGalleryCommands(context));
	// The status is one command (`picode.setup.status`) and three readers: the Status section of the
	// Agent Customizations page, the MCP Servers section (which takes the servers out of it) and the
	// providers list in Settings. The command is registered before any of them asks, because a reader
	// that arrives first would answer with an error row.
	context.subscriptions.push(registerStatusDataCommand(setupDeps));
	// The Thinking row of the Host block is the switch: a click flips `picode.pi.reasoning`, and the
	// chat stops (or starts) writing the model's thinking from the next turn on. The setting was
	// always there; what the owner was missing was something to click.
	context.subscriptions.push(vscode.commands.registerCommand(THINKING_TOGGLE_COMMAND, async () => {
		const config = vscode.workspace.getConfiguration('picode');
		const shown = config.get<string>(REASONING_SETTING, 'show') !== 'hide';
		await config.update(REASONING_SETTING, shown ? 'hide' : 'show', vscode.ConfigurationTarget.Global);
		void vscode.window.showInformationMessage(shown
			? 'The model\'s thinking is now hidden in the chat. New turns will not show it.'
			: 'The model\'s thinking is now shown in the chat.');
	}));
	// The way into the providers' page: Chat Settings › Providers & Models, on its Providers tab —
	// where providers are added and signed in, not the raw settings line behind them.
	context.subscriptions.push(vscode.commands.registerCommand(STATUS_PROVIDER_SETTINGS_COMMAND, () =>
		vscode.commands.executeCommand('picode.providersModels.open', 'providers')));
	// The dashboard's actions: the things the status panel used to spell out as text become
	// buttons here. They run through the connector's own flows (reset + reload, update, cache
	// drop, profile reveal) so there is one path to each piece of work.
	context.subscriptions.push(vscode.commands.registerCommand('picode.pi.restart', async () => {
		resetChatSession();
		await vscode.commands.executeCommand('workbench.action.reloadWindow');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('picode.pi.openProfile', async () => {
		const uri = vscode.Uri.file(profileInForce());
		await vscode.commands.executeCommand('revealFileInOS', uri);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('picode.pi.cleanCache', async () => {
		const answer = await vscode.window.showWarningMessage(
			'Clean PiCode\'s model cache? The model list will be rebuilt.',
			{ modal: true },
			'Clean',
		);
		if (answer !== 'Clean') {
			return;
		}
		configuredModelsCache.clear();
		subscriptionModelsCache.clear();
		configuredModelsInFlight.clear();
		subscriptionModelsInFlight.clear();
		if (modelCacheFile !== undefined) {
			try {
				fs.rmSync(modelCacheFile, { force: true });
			} catch {
				// No file yet is the same answer as "cleared".
			}
		}
		forgetPiRuntime();
		onDidChangeModels.fire();
		void vscode.window.showInformationMessage('PiCode: the model cache was cleared.');
	}));
	// Memory reads what the engine already answered, so it is a view of its own in the same
	// container: the panel lists what this machine remembers without a second surface to learn.
	context.subscriptions.push(registerMemoryView());
	// The work the chat has out — its background jobs and the agents gentle-pi runs —
	// as a list that stays put while the owner works elsewhere. Same container, same rule: it reads
	// the tracker the pill reads, so the two surfaces cannot disagree about what is still running.
	context.subscriptions.push(registerTasksView({
		runningJobs: runningBackgroundJobs,
		agents: () => gentleAgents.current(),
		onAgentsChange: listener => gentleAgents.onDidChange(listener),
		openTranscript: id => {
			if (!isTaskId(id)) {
				return;
			}
			showAgentTranscript({
				id,
				// Gentle writes the full record when a task ends; until then what it last published is all there is.
				source: () => {
					const live = transcriptOf(gentleAgents.record(id));
					if (live !== undefined && isRunning(live.status)) {
						return live;
					}
					try {
						return transcriptOfJson(fs.readFileSync(path.join(profileDirectory(context.extensionUri), 'gentle-agents', 'tasks', `${id}.json`), 'utf8')) ?? live;
					} catch {
						return live;
					}
				},
				onChange: listener => gentleAgents.onDidChange(listener),
			});
		},
	}));

	// The chat's management page lists **pi's own** data — agents, skills, MCP servers and packages —
	// so this registers the three providers it reads (and the package commands) before anything the
	// owner opens looks for them. The global state carries the disabled-packages record.
	context.subscriptions.push(...registerCustomizations(context.globalState));

	// pi's sessions, backed up to PiCode Cloud and restored from it. A **backup channel**, not a
	// live sync: every transcript is its own opaque ref on the `piSessionsBackup` resource, and
	// the per-file hash state that makes a run incremental lives in the window's global state.
	context.subscriptions.push(...registerSessionsBackupCommands({
		globalState: context.globalState,
		sessionsDir: piSessionsDir(),
	}));

	// The update check: pi and the profile's packages, asked quietly on a schedule,
	// surfaced as a notification and a status-bar item, and run from there.
	registerUpdateChecks(context);
	context.subscriptions.push(registerUsagePanelCommand(distributionRoot(context.extensionUri)));

	// The model caches are read the moment the window exists (the subscription catalogue, the slow one
	// with the external pi, included) and then re-read on a slow rhythm. The picker does not wait for
	// that rhythm: serving it *is* a read, and the refresh fires the change event the list listens to
	// (`onDidChangeModels`). So this is the safety net behind that, not a drumbeat: every five minutes
	// it was two network calls an hour per source, for a window nobody was looking at.
	// What the last window saw is what this one opens with: the picker's list is read back before
	// anyone asks for it, so the warm-up below only has to say whether the list moved.
	modelCacheFile = path.join(context.globalStorageUri.fsPath, 'models-cache.json');
	loadCachedModels();
	warmUpModels();
	const modelsTimer = setInterval(() => warmUpModels(), 30 * 60_000);
	context.subscriptions.push(new vscode.Disposable(() => clearInterval(modelsTimer)));

	// The wizard's provider/model commands (the welcome page's model step).
	context.subscriptions.push(...registerWizardModelCommands({
		distributionRoot: distributionRoot(context.extensionUri),
		profileDir: profileDirectory(context.extensionUri),
		refreshModels: () => { forgetPiRuntime(); onDidChangeModels.fire(); },
	}));

	context.subscriptions.push(
		vscode.commands.registerCommand(CONNECT_PROVIDER_COMMAND, () =>
			connectSubscription({
				distributionRoot: distributionRoot(context.extensionUri),
				profileDir: profileDirectory(context.extensionUri),
				refreshModels: () => {
					// A new credential changes what pi's catalogue answers, so the cached runtime — and with
					// it the model list the editor is about to ask for — is dropped.
					forgetPiRuntime();
					onDidChangeModels.fire();
				},
			}),
		),
	);
}

export function deactivate(): void {
	// The provider is registered as a subscription and released with it.
	// The memory engine this editor started goes with it; one that was already serving stays.
	stopStartedMemory();
}
