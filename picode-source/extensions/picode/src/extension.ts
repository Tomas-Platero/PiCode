/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentRoots, coalesce, discoverAgents, discoverSkills, nodeFs, skillRoots, type ResourceRoot } from './customizations';
import { declarationsFromSetting, projectDeclaration } from './declarations';
import { fetchModelIds } from './endpoint';
import { splitModelId } from './providerIds';
import { connectSubscription } from './login';
import { mcpServersFrom, type McpConfigFile, type PiMcpServer } from './mcp-provider';
import { authorizationUrlIn, lastLineOf, loginArguments, logoutArguments, serverTarget } from './mcp-login';
import { mcpServersText, normalizedServersFile, splitArguments, type McpServerSetting } from './mcpServers';
import { mcpServersTextWithAdded, mcpServersTextWithEdited, mcpServersTextWithRemoved, parseKeyValueLines, serverEntry, serverFileEntry, serverNames, validateDraft, validateServerName, type AddServerDraft, type McpServerFileEntry } from './mcp-add';
import { cacheKey, cachedModels, sameIds, singleFlight, storeModels, type CacheEntry } from './models-cache';
import { installPackage, searchPackages } from './packages-registry';
import { piSessionsDir, registerSessionsBackupCommands } from './sessions-backup';
import { listWorkspaceSessionFiles, sessionTurns } from './sessions-provider';
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
import { packageSkillDirs, parseSettings, piPackages, projectPackageScope, userPackageScope, type PackageReadResult, type PiPackage } from './packages-data';
import { loadPiSdk } from './piSdk';
import { externalProfileDir } from './profile-import';
import {
	CONNECT_PROVIDER_COMMAND,
	declarationFrom,
	modelsForConfiguration,
	readConfiguration,
	type ProviderConfiguration,
} from './providers';
import { liveSessionCommands, onPiSessionChanged, registerPiAgent, resetChatSession } from './agent';
import { registerPiCommandPromptFiles } from './commands';
import { gentleAgentsHome, listTaskFiles, readTaskRecord, readTaskTranscriptPath, relativeTime, sessionToMarkdown } from './subagents';
import { registerWizardModelCommands } from './wizard-models';
import { probeExternalPi, readGentleVersion, readInternalPiVersion, readProfilePackageVersion, registerSetupCommands } from './onboarding';
import { registerStatusDataCommand } from './status-data';
import { registerStatusTreeView } from './status-view';
import { chatAgentDir, internalProfileDir, PICODE_RUNTIME_SETTING, readRuntimeMode, sdkEntryCandidates } from './runtime';
import { describeTargets, fetchNpmLatest, parseSnapshot, runPiUpdate, updatableTargets, type CandidateTarget, type UpdatesSnapshot } from './updates-check';

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
 * Derived from this extension's location rather than configured, because there is only one
 * answer and a wrong one would read somebody else's models: the extension lives at
 * `<root>/resources/app/extensions/picode`, so four levels up is the distribution, and the
 * profile is `<root>/data/pi-agent` — the same directory `instance.ts` resolves for the
 * host. **Nothing outside PiCode is ever read.**
 */
/** The distribution root: four levels up from `resources/app/extensions/picode`. */
function distributionRoot(extensionUri: vscode.Uri): string {
	return path.resolve(extensionUri.fsPath, '..', '..', '..', '..');
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
				capabilities: { toolCalling: true },
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
 * the editor's chat sessions reach it is a separate question, recorded in
 * `odd/tasks/picode-pi-0992.md`.
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
		void vscode.window.showWarningMessage(`PiCode: no MCP server named "${picked}" was found in pi's mcp.json.`);
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
		void vscode.window.showWarningMessage(`PiCode: no MCP server named "${name}" was found in ${file}.`);
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
		void vscode.window.showWarningMessage(`PiCode: no MCP server named "${picked}" was found in pi's mcp.json.`);
		return;
	}

	const confirmed = await vscode.window.showWarningMessage(`Remove the MCP server "${picked}" from pi? Its entry is removed from ${path.basename(path.dirname(file)) === '.pi' ? file : file}.`, { modal: true }, 'Remove');
	if (confirmed !== 'Remove') {
		return;
	}

	const text = mcpServersTextWithRemoved(readJsonFile(file) ?? {}, picked);
	if (text === undefined) {
		void vscode.window.showWarningMessage(`PiCode: no MCP server named "${picked}" was found in ${file}.`);
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
		void vscode.window.showInformationMessage('pi has no MCP servers to edit.');
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
 * the very list `pi.dev/packages` renders, asked straight from npm's search endpoint (pi.dev
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
 * The MCP section's "Sign In" for a server pi provides: the page hands the server's name over and
 * this connector runs pi's own `mcp login` against PiCode's profile.
 *
 * OAuth is not re-implemented here. pi starts the callback, opens the browser and writes the tokens
 * into the profile — the same profile the chat now runs against — so the credentials land where pi
 * looks for them and nowhere else. A **contract** like {@link EDIT_MCP_SERVER_COMMAND}.
 */
export const LOGIN_MCP_SERVER_COMMAND = 'picode.mcp.loginServer';

/**
 * The MCP section's "Sign Out" for a server pi provides: the pair of {@link LOGIN_MCP_SERVER_COMMAND},
 * and the same contract. pi deletes the credentials it stored for that server, and nothing else
 * changes — the entry stays, so the next sign-in has somewhere to land.
 */
export const LOGOUT_MCP_SERVER_COMMAND = 'picode.mcp.logoutServer';

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

/** The URI scheme pi's session transcripts use; the editor derives the chat session type from it, so it must match the type the providers register under. */
const PI_SESSION_SCHEME = 'pi';

/**
 * pi's sessions, listed for the editor's Sessions panel.
 *
 * Nothing in the editor reads the runtime profile's `sessions/` directory — the panel's
 * 'Local' group is the chat service's own index. This provider is the bridge: it lists
 * pi's transcripts under a `pi` group, replays one as a read-only history when opened,
 * and fires the change event when the import lands a tree of transcripts.
 */
function registerPiSessionsProvider(participant: vscode.ChatParticipant): { fireChanged(): void } & vscode.Disposable {
	const sessionsChangedEmitter = new vscode.EventEmitter<void>();
	// The last listing the panel accepted. A cancelled refresh must return it, not `[]`:
	// the extension-host bridge diffs by reference and emits a removal for every item
	// absent from the returned array, so an empty listing from a cancelled run would
	// clear the panel — every pi session disappearing — until the next non-cancelled
	// refresh listed them all again.
	let lastItems: vscode.ChatSessionItem[] | undefined = undefined;
	const provider: vscode.ChatSessionItemProvider & vscode.ChatSessionContentProvider = {
		onDidChangeChatSessionItems: sessionsChangedEmitter.event,
		onDidCommitChatSessionItem: new vscode.EventEmitter<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }>().event,
		provideChatSessionItems(token: vscode.CancellationToken): vscode.ProviderResult<vscode.ChatSessionItem[]> {
			if (token.isCancellationRequested) {
				// Return the previous listing: see `lastItems` — a cancelled refresh must
				// never look like "everything was deleted".
				return lastItems ?? [];
			}
			// Like the pi CLI, the panel shows only the sessions of the folders actually
			// open: pi files transcripts under one folder per project cwd, so the listing
			// walks just those folders — no workspace, no match, no sessions.
			const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
			const sessionsDir = path.join(profileInForce(), 'sessions');
			const items = listWorkspaceSessionFiles(sessionsDir, workspacePaths).map(file => ({
				resource: vscode.Uri.from({ scheme: PI_SESSION_SCHEME, path: `/${file.id}` }),
				label: file.label,
				iconPath: vscode.ThemeIcon.File,
				// The mtime is the one timestamp a transcript file carries: it feeds both the
				// created marker and the last-activity marker, because a transcript is never
				// rewritten — pi only appends to it. Without a timestamp the panel renders
				// every session as dated 1970 ('57y ago').
				timing: { created: file.mtime, lastRequestEnded: file.mtime },
			}));
			lastItems = items;
			return items;
		},
		async provideChatSessionContent(resource: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
			// No `requestHandler`: the transcript replays as read-only history, and the
			// editor disables the input for sessions that cannot take requests.
			const readSession: vscode.ChatSession = { history: [], requestHandler: undefined };
			if (token.isCancellationRequested) {
				return readSession;
			}
			const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
			const sessionsDir = path.join(profileInForce(), 'sessions');
			const id = resource.path.split('/').pop();
			const file = listWorkspaceSessionFiles(sessionsDir, workspacePaths).find(entry => entry.id === id);
			if (file === undefined) {
				return readSession;
			}
			const history: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> = [];
			for (const turn of sessionTurns(readTextFile(file.file) ?? '')) {
				if (turn.role === 'user') {
					history.push(new vscode.ChatRequestTurn2(turn.text, undefined, [], 'pi', [], undefined, undefined, undefined, undefined));
				} else {
					history.push(new vscode.ChatResponseTurn2(
						[new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(turn.text))],
						{},
						'pi',
					));
				}
			}
			return { ...readSession, history };
		},
	};
	const registration = vscode.chat.registerChatSessionItemProvider('pi', provider);
	// The deprecated item-provider interface cannot carry session content, so the same object
	// registers again as the content provider for the scheme. Without it the editor cannot
	// resolve a pi session and falls back to a text editor for an unresolvable resource.
	const contentRegistration = vscode.chat.registerChatSessionContentProvider(PI_SESSION_SCHEME, provider, participant);
	return {
		fireChanged: () => sessionsChangedEmitter.fire(),
		dispose: () => {
			contentRegistration.dispose();
			registration.dispose();
		},
	};
}

/** The bundled pi CLI's entry script; a path that does not exist when the runtime is absent. */
function piCliEntry(): string {
	return path.join(distributionRoot(requireProfileUri()), 'resources', 'pi-runtime', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
}

/** How long a sign-in may wait for the browser: pi's own default, with room for the round trip. */
const MCP_LOGIN_TIMEOUT_MS = 330_000;

/** One `pi mcp …` run: what it printed, whether it finished, and whether it was cancelled. */
interface McpCommandOutcome {
	readonly ok: boolean;
	readonly cancelled: boolean;
	readonly output: string;
}

/**
 * Runs one of pi's MCP commands for one server, against PiCode's profile.
 *
 * pi opens the browser and catches the redirect on a local callback, so nothing here has to
 * understand OAuth. Its output is kept because the address it prints is the one thing to offer if
 * the browser did not open, and its last line is what a failure has to repeat. Cancelling the
 * notification kills the run: the sign-in is the owner's to abandon.
 */
async function runMcpCommand(cliEntry: string, profileDir: string, args: readonly string[], token: vscode.CancellationToken): Promise<McpCommandOutcome> {
	const { execFile } = await import('node:child_process');
	return new Promise<McpCommandOutcome>(resolve => {
		let cancelled = false;
		const child = execFile(process.execPath, [cliEntry, ...args], {
			// The editor's executable is Electron: without this flag it would try to open an app
			// instead of running pi's script as Node — the same invocation the installer uses.
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: profileDir },
			cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
			windowsHide: true,
			timeout: MCP_LOGIN_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		}, (error, stdout, stderr) => {
			resolve({ ok: error === null, cancelled, output: `${stdout}${stderr}` });
		});
		token.onCancellationRequested(() => {
			cancelled = true;
			child.kill();
		});
	});
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
	disposables.push(vscode.commands.registerCommand(PACKAGES_COMMAND, async (): Promise<PiPackageRow[]> => {
		const profileDir = profileInForce();
		const read = readPackages();
		const info = packageDisplayInfo(read.packages, packageScopes(profileDir), readDisabledRecord(), profileDir);
		return read.packages.map(found => ({ ...found, ...info.get(found.path) }));
	}));

	// The Packages section's catalog and install. The search resolves nothing of the editor —
	// the rules live in `packages-registry.ts` and its failures are said here, once per session,
	// the way the package listing's are. The install resolves the editor-only parts first: the
	// bundled pi CLI (a missing one is a sentence, not an error) and the profile in force, which
	// is the directory pi installs into.
	disposables.push(vscode.commands.registerCommand(PACKAGES_SEARCH_COMMAND, async (query?: string) =>
		searchPackages(typeof query === 'string' ? query : '', { log: report })));
	disposables.push(vscode.commands.registerCommand(PACKAGES_INSTALL_COMMAND, async (target?: string) => {
		const cliEntry = path.join(distributionRoot(requireProfileUri()), 'resources', 'pi-runtime', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
		if (!fs.existsSync(cliEntry)) {
			return { ok: false, message: 'pi runtime not found in this editor' };
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
				return { ok: false, message: 'pi runtime not found in this editor' };
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
		const cliEntry = piCliEntry();
		if (!fs.existsSync(cliEntry)) {
			return { ok: false, message: 'pi runtime not found in this editor' };
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

	/**
	 * The two MCP account commands, which differ in the verb and in nothing else.
	 *
	 * pi owns the credentials and pi does the work, so this host has three jobs: show the wait, repeat
	 * what pi said, and re-read the list — a server that just gained or lost credentials is a row whose
	 * state changed. Only a sign-in has an address to offer: if the browser never opened, that address
	 * is the one thing that saves the flow.
	 */
	const runMcpAccountCommand = async (direction: 'in' | 'out', name?: string): Promise<void> => {
		const server = serverTarget(name);
		const noun = direction === 'in' ? 'sign-in' : 'sign-out';
		const preposition = direction === 'in' ? 'to' : 'of';
		const gerund = direction === 'in' ? 'signing in to' : 'signing out of';
		if (server.length === 0) {
			void vscode.window.showErrorMessage(`PiCode: no MCP server was named for the ${noun}.`);
			return;
		}
		const cliEntry = piCliEntry();
		if (!fs.existsSync(cliEntry)) {
			void vscode.window.showErrorMessage('PiCode: pi runtime not found in this editor.');
			return;
		}
		const outcome = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `PiCode: ${gerund} "${server}"…`, cancellable: true },
			(_progress, token) => runMcpCommand(cliEntry, profileInForce(), direction === 'in' ? loginArguments(server) : logoutArguments(server), token),
		);
		if (outcome.cancelled) {
			void vscode.window.showInformationMessage(`PiCode: the ${noun} ${preposition} "${server}" was cancelled.`);
			return;
		}
		if (outcome.ok) {
			// The credentials changed, so the list re-reads: the row's state is not what it was.
			fire();
			// pi's own sentence is the one shown — it says what happened, including a server that was
			// already signed in (or already signed out) and how many tools it found.
			const said = lastLineOf(outcome.output);
			void vscode.window.showInformationMessage(said === undefined ? `PiCode: the ${noun} ${preposition} "${server}" finished.` : `PiCode: ${said}`);
			return;
		}
		const reason = lastLineOf(outcome.output);
		const message = `PiCode: the ${noun} ${preposition} "${server}" did not finish${reason === undefined ? '.' : ` (${reason}).`}`;
		// Only a sign-in has an address to offer.
		const url = direction === 'in' ? authorizationUrlIn(outcome.output) : undefined;
		if (url === undefined) {
			void vscode.window.showWarningMessage(message);
			return;
		}
		void vscode.window.showWarningMessage(message, 'Open in browser').then(choice => {
			if (choice !== undefined) {
				void vscode.env.openExternal(vscode.Uri.parse(url));
			}
		});
	};

	disposables.push(vscode.commands.registerCommand(LOGIN_MCP_SERVER_COMMAND, (name?: string) => runMcpAccountCommand('in', name)));
	disposables.push(vscode.commands.registerCommand(LOGOUT_MCP_SERVER_COMMAND, (name?: string) => runMcpAccountCommand('out', name)));

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
	createAgentSessionServices(options: { cwd: string; agentDir?: string }): Promise<PiRuntimeServices>;
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
	// a cached answer standing behind it: the next listing refreshes it in the background.
	subscriptionModelsCache.clear();
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
				capabilities: { toolCalling: true },
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
		return [
			...fromConfigured,
			...fromProfile.filter(info => !configuredIds.has(info.id)),
			...fromSubscriptions.filter(info => !configuredIds.has(info.id) && !profileIds.has(info.id)),
		];
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
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
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

	await streamInto(response.body, api, progress, token);
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
 * Reads the provider's stream and forwards the text as it arrives.
 *
 * Server-sent events: lines beginning `data:` carry a JSON object, and `[DONE]` ends it. The
 * two dialects differ only in which field holds the text, so they are handled together
 * instead of duplicating the whole loop.
 */
async function streamInto(
	body: ReadableStream<Uint8Array>,
	api: string | undefined,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	token: vscode.CancellationToken,
): Promise<void> {
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
			const text = extractText(payload, api);
			if (text !== undefined && text.length > 0) {
				progress.report(new vscode.LanguageModelTextPart(text));
			}
		}
	}
}

/** Where each dialect puts the text of one streamed event. */
function extractText(payload: string, api: string | undefined): string | undefined {
	let event: Record<string, unknown> | undefined;
	try {
		// SAFETY: the payload is a streamed JSON event whose shape the dialect table below
		// knows; parsing hands it over as an untyped record and the table narrows it.
		event = JSON.parse(payload) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	if (api === 'openai-responses') {
		// `response.output_text.delta`; every other event type is ignored on purpose.
		return event?.type === 'response.output_text.delta' && typeof event.delta === 'string'
			? event.delta
			: undefined;
	}
	// SAFETY: the dialect table above knows this payload's shape — an OpenAI-completions
	// stream event carries `choices[0].delta.content`; the parsed JSON is untyped at the
	// boundary, so the contract is recovered here after a runtime typeof check.
	const choices = event?.choices as unknown as Array<{ delta?: { content?: string } }> | undefined;
	return typeof choices?.[0]?.delta?.content === 'string' ? choices[0].delta.content : undefined;
}

/* ------------------------------------------------------------------ *
 * The subagents' transcripts
 * ------------------------------------------------------------------ */

/** The command that opens a subagent's transcript; it takes an optional task id. */
export const OPEN_SUBAGENT_TRANSCRIPT_COMMAND = 'picode.openSubagentTranscript';

/**
 * Opens a subagent's transcript, rendered from its pi session file.
 *
 * With a task id the transcript opens directly; without one the finished tasks gentle
 * recorded are listed, newest first. The markdown is opened in an **untitled** document:
 * the profile and the session files are read, never written or renamed. Every failure path
 * is a sentence, not a throw — a command the palette can invoke must not fail into the void.
 */
async function openSubagentTranscript(taskId?: string): Promise<void> {
	try {
		const home = gentleAgentsHome();
		let chosen = taskId;
		if (chosen === undefined) {
			const now = Date.now();
			const picks = listTaskFiles(home)
				.map(file => ({
					taskId: path.basename(file.file, '.json'),
					record: readTaskRecord(file.file),
				}))
				.map(({ taskId: id, record }) => ({
					taskId: id,
					label: `${record?.agent ?? 'subagent'} — ${record?.label ?? id}`,
					description: record?.endedAt === undefined ? undefined : relativeTime(record.endedAt, now),
				}));
			if (picks.length === 0) {
				void vscode.window.showInformationMessage('PiCode: no subagent transcripts yet. They appear after gentle launches a subagent.');
				return;
			}
			const picked = await vscode.window.showQuickPick(picks, {
				placeHolder: 'Which subagent transcript do you want to open?',
			});
			if (picked === undefined) {
				return;
			}
			chosen = picked.taskId;
		}

		const sessionPath = readTaskTranscriptPath(chosen, home);
		if (sessionPath === undefined) {
			void vscode.window.showInformationMessage(`PiCode: no transcript was recorded for subagent ${chosen}.`);
			return;
		}
		let text: string | undefined;
		try {
			text = fs.readFileSync(sessionPath, 'utf8');
		} catch {
			text = undefined;
		}
		if (text === undefined) {
			void vscode.window.showInformationMessage(`PiCode: the subagent's session file could not be read (${sessionPath}).`);
			return;
		}
		const document = await vscode.workspace.openTextDocument({
			content: sessionToMarkdown(text, { title: `Subagent ${chosen}` }),
			language: 'markdown',
		});
		await vscode.window.showTextDocument(document, { preview: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`PiCode: the subagent transcript could not be opened (${message}).`);
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

/** Where the last check's answer lives, so the status-bar item survives a restart. */
const UPDATES_STATE_KEY = 'picode.updates.lastCheck';

/** The check starts this long after activation: past the work every startup actually does. */
const UPDATES_FIRST_CHECK_DELAY_MS = 30_000;

/** And then every six hours for as long as the window is open. */
const UPDATES_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

/** The npm package both runtimes come from: the internal one ships it, the external one installs it. */
const PI_RUNTIME_PACKAGE = '@earendil-works/pi-coding-agent';

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
 * The candidates one check compares: the runtime in force, Gentle AI, and the npm packages of
 * the profile pi loads. Everything arrives as "installed version if readable" — the assembly
 * in `updates-check.ts` decides what is actually behind, and a missing or junk version is
 * simply not a claim the check makes.
 */
async function gatherUpdateCandidates(): Promise<readonly CandidateTarget[]> {
	const candidates: CandidateTarget[] = [];
	const profile = profileDirectory(requireProfileUri());

	// The runtime: the internal one from its manifest, the external one from the probe of the
	// machine's pi. Both are versions of the same npm package, so the latest is the same lookup.
	const installedPi = readRuntimeMode() === 'external'
		? (await probeExternalPi()).version
		: readInternalPiVersion(distributionRoot(requireProfileUri()));
	candidates.push({ kind: 'runtime', name: 'pi', installed: installedPi, latest: await fetchNpmLatest(PI_RUNTIME_PACKAGE, { log: report }) });

	// Gentle AI, only when it is installed: an absent package is not an out-of-date one.
	const gentleInstalled = readGentleVersion(profile);
	if (gentleInstalled !== undefined) {
		candidates.push({ kind: 'gentle', name: 'gentle-pi', installed: gentleInstalled, latest: await fetchNpmLatest('gentle-pi', { log: report }) });
	}
	const engramInstalled = readProfilePackageVersion(profile, 'gentle-engram');
	if (engramInstalled !== undefined) {
		candidates.push({ kind: 'gentle', name: 'gentle-engram', installed: engramInstalled, latest: await fetchNpmLatest('gentle-engram', { log: report }) });
	}

	// The npm packages of the profile in force. Git checkouts carry no version to compare and
	// are skipped; Gentle is skipped here because it is already counted above.
	const scopes = packageScopes(profileInForce());
	const npmRoots = scopes.map(scope => scope.npmRoot);
	const npmPackages = piPackages(scopes, nodeFs()).packages.filter((found): found is PiPackage & { version: string } =>
		found.version !== undefined
		&& found.name !== 'gentle-pi'
		&& found.name !== 'gentle-engram'
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
async function runUpdateCheck(context: vscode.ExtensionContext): Promise<UpdatesSnapshot | undefined> {
	const snapshot: UpdatesSnapshot = { checkedAt: Date.now(), targets: updatableTargets(await gatherUpdateCandidates()) };
	await context.globalState.update(UPDATES_STATE_KEY, snapshot);
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
		const cliEntry = piCliEntry();
		if (!fs.existsSync(cliEntry)) {
			void vscode.window.showInformationMessage('PiCode could not be updated: the pi CLI is missing from this installation.');
			return;
		}
		// The chat runs pi in this very process: its session must be gone before the files under
		// it change, or it keeps running the code being replaced.
		resetChatSession();
		const result = await runPiUpdate({ cliEntry, profileDir: profileInForce() });
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
	const scheduledCheck = async (): Promise<void> => {
		// One flight at a time — a slow registry must not stack checks — and the setting is read
		// at fire time, so turning it off silences the check without a restart.
		if (checking || !updatesCheckEnabled()) {
			return;
		}
		checking = true;
		try {
			showStatus(await runUpdateCheck(context));
		} catch (error) {
			report(`updates: the check failed (${error instanceof Error ? error.message : String(error)})`);
		} finally {
			checking = false;
		}
	};

	// The last check's answer survives restarts, so the item is back the moment the window is —
	// before the first check of this session has run.
	showStatus(readUpdatesSnapshot(context.globalState));
	const firstCheck = setTimeout(() => { void scheduledCheck(); }, UPDATES_FIRST_CHECK_DELAY_MS);
	const interval = setInterval(() => { void scheduledCheck(); }, UPDATES_CHECK_INTERVAL_MS);
	context.subscriptions.push(new vscode.Disposable(() => {
		clearTimeout(firstCheck);
		clearInterval(interval);
	}));
}

function requireProfileUri(): vscode.Uri {
	if (profileUri === undefined) {
		throw new Error('PiCode: the connector has not activated yet, so it does not know where pi\'s profile is.');
	}
	return profileUri;
}

export function activate(context: vscode.ExtensionContext): void {
	profileUri = context.extensionUri;
	context.subscriptions.push(onDidChangeModels);
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));

	// `@pi` in the editor's own chat. This is what makes the chat exist: the editor hides its
	// chat when there is no agent to talk to, and this supplies one — the editor's agent, not a
	// surface of ours. Nothing to configure: it finds pi and its profile by itself.
	// The chat's profile is resolved per request by the agent (see `agent.ts`), so a
	// runtime switch takes effect without a window reload. What PiCode projects for pi
	// keeps going to PiCode's own profile either way.
	const piParticipant = registerPiAgent(context, {
		distributionRoot: distributionRoot(context.extensionUri),
		log: line => console.error(`[pi] ${line}`),
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
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('picode.mcp.servers')) {
				applyMcpServers(profileDirectory(context.extensionUri));
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
	const piSessions = registerPiSessionsProvider(piParticipant);
	context.subscriptions.push(piSessions);

	const setupDeps = {
		distributionRoot: distributionRoot(context.extensionUri),
		profileDir: profileDirectory(context.extensionUri),
		globalState: context.globalState,
		forgetRuntime: forgetPiRuntime,
		// Installing or removing Gentle AI must be visible to the chat immediately.
		resetChat: resetChatSession,
		// An import writes providers, models and packages onto disk: the picker must ask
		// again instead of serving what it cached before the copy.
		refreshModels: () => {
			configuredModelsCache.clear();
			onDidChangeModels.fire();
		},
		// An import also lands a tree of session transcripts: the Sessions panel re-lists.
		sessionsChanged: () => piSessions.fireChanged(),
	};
	context.subscriptions.push(...registerSetupCommands(setupDeps));
	// The activity-bar status view is a native tree (declared `type: "tree"` in the manifest), so
	// its rows come from the data command. The command is registered before the view, because the
	// view refreshes the moment it is registered and would otherwise answer with an error row.
	context.subscriptions.push(registerStatusDataCommand(setupDeps));
	context.subscriptions.push(registerStatusTreeView(context.extensionUri));

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

	// The update check: pi, Gentle AI and the profile's packages, asked quietly on a schedule,
	// surfaced as a notification and a status-bar item, and run from there.
	registerUpdateChecks(context);

	// The model caches are re-read every five minutes, unasked: the picker must never open on
	// a list that went stale during a quiet stretch, and the subscription catalogue (the slow
	// one with the external pi) is read the moment the window exists.
	warmUpModels();
	const modelsTimer = setInterval(() => warmUpModels(), 5 * 60_000);
	context.subscriptions.push(new vscode.Disposable(() => clearInterval(modelsTimer)));

	// The wizard's provider/model/agents commands (the welcome page's step 2 and the
	// Gentle agents' model picker).
	context.subscriptions.push(...registerWizardModelCommands({
		distributionRoot: distributionRoot(context.extensionUri),
		profileDir: profileDirectory(context.extensionUri),
		refreshModels: () => { forgetPiRuntime(); onDidChangeModels.fire(); },
	}));

	// The subagents gentle launched from a chat turn stay visible in the chat itself (see
	// `agent.ts`); this command is how their full transcript opens — the pi session file
	// rendered as markdown into an untitled document, the profile never written.
	context.subscriptions.push(vscode.commands.registerCommand(OPEN_SUBAGENT_TRANSCRIPT_COMMAND, (taskId?: string) =>
		openSubagentTranscript(typeof taskId === 'string' ? taskId : undefined)));

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
}
