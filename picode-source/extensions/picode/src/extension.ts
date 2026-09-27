/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentRoots, coalesce, discoverAgents, discoverSkills, nodeFs, skillRoots, type ResourceRoot } from './customizations';
import { declarationsFromSetting, projectDeclaration } from './declarations';
import { fetchModelIds } from './endpoint';
import { splitModelId } from './providerIds';
import { connectSubscription } from './login';
import { mcpServersFrom, type McpConfigFile, type PiMcpServer } from './mcp-provider';
import { mcpServersText, splitArguments, type McpServerSetting } from './mcpServers';
import { mcpServersTextWithAdded, parseKeyValueLines, serverNames, validateDraft, validateServerName, type AddServerDraft } from './mcp-add';
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
import { registerPiAgent, resetChatSession } from './agent';
import { registerWizardModelCommands } from './wizard-models';
import { maybeNudgeFirstRun, registerSetupCommands } from './onboarding';
import { registerStatusDataCommand } from './status-data';
import { registerStatusTreeView } from './status-view';
import { chatAgentDir, internalProfileDir, readRuntimeMode, sdkEntryCandidates } from './runtime';

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

/** The adapter that gives pi MCP: installed into PiCode's own profile, never the machine's. */
const MCP_ADAPTER_PACKAGE = 'npm:pi-mcp-adapter';

/** Where the adapter's own file lives, inside PiCode's profile. */
function mcpServersFile(profile: string): string {
	return path.join(profile, 'mcp.json');
}

/**
 * Writes the MCP servers the owner declared, in the shape the adapter reads.
 *
 * The setting is the surface and this file is the projection, the same arrangement the model
 * providers use: what the owner fills in the form becomes what pi reads. The write is skipped when
 * the file already says exactly this, because activation and every settings change call it.
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

/** The file's content as an object, or `undefined` when there is none, it is broken, or it is not an object. */
function readJsonFile(file: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Installs the adapter once, if the profile does not have it.
 *
 * pi owns its packages, so the install is pi's own command, run against **PiCode's** profile
 * (`PI_CODING_AGENT_DIR`), which is what keeps this inside the product. It runs in the background
 * and its result is reported: a server whose adapter is missing would look connected and do
 * nothing.
 */
async function ensureMcpAdapter(profile: string): Promise<void> {
	if (fs.existsSync(path.join(profile, 'npm', 'node_modules', 'pi-mcp-adapter'))) {
		return;
	}
	const entry = path.join(distributionRoot(requireProfileUri()), 'resources', 'pi-runtime', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
	if (!fs.existsSync(entry)) {
		return;
	}
	try {
		const { execFile } = await import('node:child_process');
		await new Promise<void>((resolve, reject) => {
			execFile(process.execPath, [entry, 'install', MCP_ADAPTER_PACKAGE], {
				// The editor's executable is Electron: without this flag it would try to open an
				// app instead of running pi's script as Node.
				env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: profile },
				windowsHide: true,
			}, error => (error === null ? resolve() : reject(error)));
		});
		void vscode.window.showInformationMessage('PiCode: the MCP adapter is installed for pi. Its servers are in Settings > PiCode > MCP.');
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`PiCode: the MCP adapter could not be installed (${message}). The servers you declared will not be reachable until it is.`);
	}
}

/** The servers the settings declare. */
function declaredMcpServers(): McpServerSetting[] {	const configured = vscode.workspace.getConfiguration('picode').get<McpServerSetting[]>('mcp.servers');
	return Array.isArray(configured) ? configured : [];
}

/** Writes the servers pi reads, and installs the adapter the first time one is declared. */
async function applyMcpServers(profile: string): Promise<void> {
	const servers = declaredMcpServers();
	writeMcpServers(profile, servers);
	if (servers.length > 0) {
		await ensureMcpAdapter(profile);
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

	// The list repaints itself through the file watcher; the adapter only decides whether pi can
	// actually run the server, and installing it is idempotent, so it is checked every time.
	void ensureMcpAdapter(profile);
	void vscode.window.showInformationMessage(`MCP server ${name} added to pi. It will appear in the list.`);
}

/**
 * Asks for `KEY=VALUE` lines one at a time — the editor's input box is single-line — until an
 * empty answer ends it. A malformed line is said inline and asked again. `undefined` is a
 * cancellation; an empty record is "none".
 */
async function collectKeyValueLines(subject: string): Promise<Record<string, string> | undefined> {
	const lines: string[] = [];
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
 * The MCP section's "Add Server", which the core invokes: it asks this connector for the new
 * server instead of the editor's own add flow, because the servers this page lists live in
 * pi's own `mcp.json` — the editor's flow would write a file pi never reads.
 */
export const ADD_MCP_SERVER_COMMAND = 'picode.mcp.addServer';

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
 */
function registerCustomizations(): vscode.Disposable[] {
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
	disposables.push(vscode.commands.registerCommand(PACKAGES_COMMAND, async (): Promise<PiPackage[]> => [...readPackages().packages]));

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

/** Forgets the cached runtime, so the next listing reads credentials as they are now. */
export function forgetPiRuntime(): void {
	runtimeCache = undefined;
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

		// The editor's **own provider form**, when the owner filled it in: it is the surface that
		// renders the declared fields, with the key stored as a secret. Kept from the last listing
		// because the request that follows carries the model but not the configuration.
		const configured = readConfiguration(options.configuration);
		const configuredModels =
			configured.endpoint === undefined ? [] : await modelsForConfiguration(configured);
		if (configured.endpoint === undefined) {
			lastConfiguration = undefined;
		} else {
			lastConfiguration = configured;
			const declaration = declarationFrom(configured);
			if (declaration !== undefined) {
				projectDeclaration(profile, declaration, configuredModels.map(info => splitModelId(info.id).modelId));
			}
		}

		// The **lines the owner writes in the settings list**, projected so pi knows them too, and
		// then the profile read back: it now holds both of the above plus every provider an earlier
		// version of the connecting flow wrote there.
		await projectDeclaredProviders(profile);

		const models = readModelsFile(profile);
		const fromProfile = models === undefined ? [] : toChatInformation(models);
		const fromSubscriptions = await subscriptionModels(distributionRoot(requireProfileUri()), chatAgentDir(distributionRoot(requireProfileUri())), vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd());
		const configuredIds = new Set(configuredModels.map(info => info.id));
		const profileIds = new Set(fromProfile.map(info => info.id));
		return [
			...configuredModels,
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
	let event: any;
	try {
		event = JSON.parse(payload);
	} catch {
		return undefined;
	}
	if (api === 'openai-responses') {
		// `response.output_text.delta`; every other event type is ignored on purpose.
		return event?.type === 'response.output_text.delta' && typeof event.delta === 'string'
			? event.delta
			: undefined;
	}
	return typeof event?.choices?.[0]?.delta?.content === 'string' ? event.choices[0].delta.content : undefined;
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
	registerPiAgent(context, {
		distributionRoot: distributionRoot(context.extensionUri),
		// The chat's profile is resolved per request by the agent (see `agent.ts`), so a
		// runtime switch takes effect without a window reload. What PiCode projects for pi
		// keeps going to PiCode's own profile either way.
		log: line => console.error(`[pi] ${line}`),
	});

	// The MCP servers pi runs are written from the settings row, and followed while the editor is
	// open: adding one in the form is what makes it available to pi.
	void applyMcpServers(profileDirectory(context.extensionUri));
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('picode.mcp.servers')) {
				void applyMcpServers(profileDirectory(context.extensionUri));
			}
		}),
	);

	// Connecting a provider with a subscription. It is a **list** and not a chain of windows: pi
	// says which of its providers can be logged in with an account the owner already pays for,
	// and the editor's own quick pick is where he chooses. The endpoints with an address and a
	// dialect have their own form in the settings row, and never come through here.
	const setupDeps = {
		distributionRoot: distributionRoot(context.extensionUri),
		profileDir: profileDirectory(context.extensionUri),
		globalState: context.globalState,
		forgetRuntime: forgetPiRuntime,
		// Installing or removing Gentle AI must be visible to the chat immediately.
		resetChat: resetChatSession,
	};
	context.subscriptions.push(...registerSetupCommands(setupDeps));
	// The activity-bar status view is a native tree (declared `type: "tree"` in the manifest), so
	// its rows come from the data command. The command is registered before the view, because the
	// view refreshes the moment it is registered and would otherwise answer with an error row.
	context.subscriptions.push(registerStatusDataCommand(setupDeps));
	context.subscriptions.push(registerStatusTreeView());
	void maybeNudgeFirstRun(setupDeps);

	// The chat's management page lists **pi's own** data — agents, skills, MCP servers and packages —
	// so this registers the three providers it reads (and the package command) before anything the
	// owner opens looks for them.
	context.subscriptions.push(...registerCustomizations());

	// The wizard's provider/model/agents commands (the welcome page's step 2 and the
	// Gentle agents' model picker).
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
}
