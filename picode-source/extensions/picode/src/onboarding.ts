/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { externalSdkEntry, findSdkEntry, resolveOnPath } from './piLocate';
import { PICODE_RUNTIME_SETTING, readRuntimeMode } from './runtime';
import { externalProfileDir, importProfile, scanExternalProfile, type ProfilePreview } from './profile-import';
import { getSessionUsage } from './agent';
import type { StatusData } from './status-view';

/**
 * The first-run setup, as a **bridge** for the welcome page.
 *
 * The setup itself lives in the welcome page — the same window, no popups. This module is
 * the half the workbench renderer cannot do by itself: probing whether an external pi
 * exists, installing or removing Gentle AI with pi's own CLI, and remembering that the
 * setup already happened. The page renders the choices and calls these commands; the
 * commands act and answer with the state that is now true.
 *
 * ## Gentle AI follows the internal pi
 *
 * Gentle AI is installed into **PiCode's own profile**, which is the internal pi's. The
 * external pi keeps its own profile on this machine, which this editor never writes to —
 * so when the external pi is chosen the welcome page does not even ask about Gentle AI,
 * and this bridge exposes no way to install it there.
 */

/** Opens the welcome page, where the setup is rendered. */
export const SETUP_COMMAND = 'picode.setup';

/** The state the welcome page renders: which pi, is it there, is Gentle AI in. */
export const GET_STATE_COMMAND = 'picode.setup.getState';

/** Applies a runtime choice and answers with the resulting state. */
export const APPLY_RUNTIME_COMMAND = 'picode.setup.applyRuntime';

/** Installs or removes Gentle AI (internal pi only) and answers with the result. */
export const APPLY_GENTLE_COMMAND = 'picode.setup.applyGentle';

/** Records that the setup happened (called by the page after a theme choice). */
export const COMPLETE_COMMAND = 'picode.setup.complete';

/** Probes the machine's pi: where it is and which version, answered once and cached. */
export const PROBE_EXTERNAL_COMMAND = 'picode.setup.probeExternal';

/** Counts what the external profile would bring across. Reads, never writes. */
export const IMPORT_PREVIEW_COMMAND = 'picode.setup.importPreview';

/** The one-shot copy from the external profile into PiCode's own. */
export const IMPORT_COMMAND = 'picode.setup.importFromExternal';

/** The Gentle install's live output, polled by the page while the install runs. */
export const GENTLE_LOG_COMMAND = 'picode.setup.gentleLog';

/** What the probe answers about the machine's pi. */
export interface ExternalPiInfo {
	readonly found: boolean;
	readonly path?: string;
	readonly version?: string;
}

/** The "the setup already happened" mark, in this extension's own global state. */
const DONE_KEY = 'picode.onboarding.done';

/** How many times the gentle first-run nudge may show before it keeps quiet for good. */
const MAX_NUDGES = 3;

/** The nudge counter, so a user who answers "not now" three times is never asked again. */
const NAG_KEY = 'picode.onboarding.nudged';

/** The packages Gentle AI is made of, as pi knows them. */
const GENTLE_PACKAGES = ['npm:gentle-pi', 'npm:gentle-engram'] as const;

/** The directories an installed Gentle AI leaves inside the profile it was installed into. */
export const GENTLE_PACKAGE_DIRS = ['gentle-pi', 'gentle-engram'] as const;

export interface SetupDeps {
	/** The distribution root: where pi's CLI and the profile live. */
	readonly distributionRoot: string;
	/** PiCode's own profile — the write target of every setup action. */
	readonly profileDir: string;
	readonly globalState: vscode.Memento;
	/** Drops the cached pi runtime, so the editor asks for models again after a pi change. */
	readonly forgetRuntime: () => void;
	/** Disposes the chat's live pi session, so the next message loads what just changed. */
	readonly resetChat: () => void;
}

/** What the welcome page renders, and what the actions answer with. */
export interface SetupState {
	readonly runtime: 'internal' | 'external';
	/** Whether the external pi (the machine's) could be found on the PATH. */
	readonly externalAvailable: boolean;
	readonly gentleInstalled: boolean;
	/** The version of the internal pi, from its own package manifest. */
	readonly internalPiVersion?: string;
	/** The version of Gentle AI when it is installed, from its package manifest. */
	readonly gentleVersion?: string;
}

/** The answer of an action that may fail, with the reason for a failed one. */
export interface SetupActionError {
	readonly error?: string;
}

/** The Gentle installer's live state, answered to the page's poll. */
const gentleLog: { running: boolean; lines: string[]; step: number; total: number } = { running: false, lines: [], step: 0, total: 0 };

function logGentle(line: string): void {
	gentleLog.lines.push(line);
	if (gentleLog.lines.length > 12) {
		gentleLog.lines.splice(0, gentleLog.lines.length - 12);
	}
}

/**
 * Adds or removes the two Gentle sources in the profile's `settings.json` — the file pi
 * reads its package list from. This is what `pi install` / `pi remove` write; doing it
 * here is what keeps the install inside npm calls we hide, instead of pi's installer
 * flashing console windows.
 */
function editProfilePackages(deps: SetupDeps, add: boolean): void {
	const file = path.join(deps.profileDir, 'settings.json');
	let settings: Record<string, unknown> = {};
	try {
		const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			settings = value as Record<string, unknown>;
		}
	} catch {
		// No file yet, or a malformed one: a fresh profile starts from an empty object and
		// the first write creates it.
	}
	const packages = Array.isArray(settings['packages']) ? settings['packages'].filter((p): p is string => typeof p === 'string') : [];
	const next = add
		? [...new Set([...packages, ...GENTLE_PACKAGES.map(p => p.replace(/^npm:/, 'npm:'))])]
		: packages.filter(p => !GENTLE_PACKAGES.some(g => p === g || p === g.replace(/^npm:/, '')));
	settings['packages'] = next;
	mkdirSync(deps.profileDir, { recursive: true });
	writeFileSync(file, JSON.stringify(settings, undefined, '\t') + '\n');
}

export function registerSetupCommands(deps: SetupDeps): vscode.Disposable[] {
	const state = (): SetupState => ({
		runtime: readRuntimeMode(),
		externalAvailable: externalSdkEntry() !== undefined,
		gentleInstalled: isGentleInstalled(deps.profileDir),
		internalPiVersion: readInternalPiVersion(deps.distributionRoot),
		gentleVersion: readGentleVersion(deps.profileDir),
	});

	const markDone = (): void => {
		void deps.globalState.update(DONE_KEY, true);
	};

	return [
		vscode.commands.registerCommand(SETUP_COMMAND, () => vscode.commands.executeCommand('workbench.action.openWalkthrough')),
		vscode.commands.registerCommand(GET_STATE_COMMAND, (): SetupState => state()),
		vscode.commands.registerCommand(APPLY_RUNTIME_COMMAND, async (mode: unknown): Promise<SetupState> => {
			// An unknown value is ignored rather than guessed at: the page sends only what it
			// rendered, and anything else is a bug worth surfacing as no-change.
			if (mode !== 'internal' && mode !== 'external') {
				throw new Error('PiCode: the runtime must be "internal" or "external".');
			}
			if (mode !== readRuntimeMode()) {
				await vscode.workspace.getConfiguration().update(PICODE_RUNTIME_SETTING, mode, vscode.ConfigurationTarget.Global);
				// The chosen runtime decides the pi of the next conversation; the caches of the
				// previous one are dropped so the editor asks for models again.
				deps.forgetRuntime();
			}
			markDone();
			return state();
		}),
		vscode.commands.registerCommand(APPLY_GENTLE_COMMAND, async (enable: unknown): Promise<SetupState & SetupActionError> => {
			if (enable !== true && enable !== 'install' && enable !== 'update' && enable !== 'remove' && enable !== false) {
				throw new Error('PiCode: the Gentle AI action needs install, update or remove.');
			}
			// Gentle AI lives in PiCode's own profile — the internal pi's. With the external pi
			// there is nothing to install into that this editor may write to.
			if (readRuntimeMode() === 'external') {
				return { ...state(), error: 'Gentle AI follows the internal pi. Your external pi keeps its own profile, which this editor never writes to.' };
			}
			const want = enable === 'update' ? 'update' : enable === true || enable === 'install' ? 'install' : 'remove';
			// The installer is OURS, not pi's: `pi install` flashes console windows (its own
			// npm children are spawned without a hidden console) and says nothing until it
			// ends. What it writes is simple - the two sources in the profile's
			// `settings.json`, then npm into the profile's npm project - so the steps run
			// here, hidden, each one logged for the card to show live.
			gentleLog.running = true;
			gentleLog.lines = [];
			gentleLog.step = 0;
			gentleLog.total = want === 'remove' ? 2 : 5;
			try {
				if (want === 'remove') {
					logGentle("[1/2] Removing Gentle AI from pi's configuration…");
					editProfilePackages(deps, false);
					gentleLog.step = 1;
					logGentle('[2/2] Removed. New conversations run plain pi.');
					gentleLog.step = 2;
				} else {
					logGentle("[1/5] Recording Gentle AI in pi's configuration…");
					editProfilePackages(deps, true);
					gentleLog.step = 1;
					logGentle('[2/5] Installing the packages with npm (this downloads the agent)…');
					await runNpm(deps, ['install', '--save', 'gentle-pi', 'gentle-engram']);
					gentleLog.step = 2;
					logGentle('[3/5] Approving install scripts…');
					await runNpm(deps, ['approve-scripts', 'gentle-pi']);
					await runNpm(deps, ['approve-scripts', 'gentle-engram']);
					gentleLog.step = 3;
					logGentle('[4/5] Rebuilding so the approved script runs (fetches the agent)…');
					await runNpm(deps, ['rebuild', 'gentle-pi', 'gentle-engram']);
					gentleLog.step = 4;
					logGentle('[5/5] Checking what landed on disk…');
					gentleLog.step = 5;
				}
			} catch (error) {
				gentleLog.running = false;
				logGentle(messageOf(error));
				throw error;
			}
			gentleLog.running = false;
			// Gentle's agents, skills and commands load when pi's session is created; the
			// live session is disposed so the next message rebuilds with them in.
			deps.resetChat();
			// And the editor gets Gentle's skills as /commands and its agents in the agent
			// picker: they are mirrored into the profile's own folders and those folders
			// are registered as chat sources. Removal unregisters.
			mirrorGentleIntoProfile(deps, want !== 'remove');
			await registerChatSources(deps, want !== 'remove');
			markDone();
			const after = state();
			// The honest answer is what is actually on disk now, not what the command hoped:
			// a failed change is reported as an error line in the page, not as success.
			const wantedInstalled = want !== 'remove';
			return after.gentleInstalled === wantedInstalled
				? after
				: { ...after, error: `pi's command line did not ${want} Gentle AI. See the notification for the reason.` };
		}),
		vscode.commands.registerCommand(COMPLETE_COMMAND, (): void => markDone()),
		vscode.commands.registerCommand(PROBE_EXTERNAL_COMMAND, (): Promise<ExternalPiInfo> => probeExternalPi()),
		vscode.commands.registerCommand(IMPORT_PREVIEW_COMMAND, (): ProfilePreview & { profile: string } =>
			({ ...scanExternalProfile(), profile: externalProfileDir() })),
		vscode.commands.registerCommand(GENTLE_LOG_COMMAND, (): { running: boolean; lines: string[]; step: number; total: number } => ({ ...gentleLog, lines: [...gentleLog.lines] })),
		vscode.commands.registerCommand(IMPORT_COMMAND, (credentials: unknown) => {
			// Credentials are the one item whose copy is the owner's own decision: the page asks
			// for them behind an unchecked box, and nothing here turns the import into a way of
			// copying `auth.json` as a side effect.
			return importProfile({
				from: externalProfileDir(),
				to: deps.profileDir,
				selection: {
					settings: true,
					models: true,
					mcp: true,
					skills: true,
					memory: true,
					sessions: true,
					credentials: credentials === true,
				},
			});
		}),
	];
}

/**
 * The first-run nudge, shown once per start at most and at most `MAX_NUDGES` times ever.
 *
 * It only speaks when there is genuinely nothing configured yet — no choice made, no
 * provider declared, no credential and no models in the profile. A working setup is never
 * interrupted; the welcome page (where the setup lives) is what it offers.
 */
export async function maybeNudgeFirstRun(deps: SetupDeps): Promise<void> {
	if (deps.globalState.get<boolean>(DONE_KEY) === true) {
		return;
	}
	const nudges = deps.globalState.get<number>(NAG_KEY, 0);
	if (nudges >= MAX_NUDGES) {
		return;
	}

	const providers = vscode.workspace.getConfiguration('picode').get<unknown[]>('providers');
	if (Array.isArray(providers) && providers.length > 0) {
		return;
	}
	if (existsSync(path.join(deps.profileDir, 'auth.json')) || existsSync(path.join(deps.profileDir, 'models.json'))) {
		return;
	}

	const answer = await vscode.window.showInformationMessage(
		'Welcome to PiCode. Set up your pi and your theme?',
		'Set up…',
		'Not now',
	);
	deps.globalState.update(NAG_KEY, nudges + 1);
	if (answer === 'Set up…') {
		await vscode.commands.executeCommand(SETUP_COMMAND);
	}
}

/** Recursively copies a directory tree, creating the destination as needed. */
function copyTree(from: string, to: string): void {
	if (!existsSync(from)) {
		return;
	}
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		const source = path.join(from, entry.name);
		const target = path.join(to, entry.name);
		if (entry.isDirectory()) {
			copyTree(source, target);
		} else if (entry.isFile()) {
			writeFileSync(target, readFileSync(source));
		}
	}
}

/**
	* Mirrors Gentle AI's skills and agents into the profile's own `skills/` and
		* `agents/` folders - the folders the editor's chat scans for `/commands` and
		* agent picker entries. The package itself stays the source; this is a copy.
	*/
function mirrorGentleIntoProfile(deps: SetupDeps, enable: boolean): void {
	if (!enable) {
		return; // removal unregisters the sources; the mirrored copies are left orphaned-free
	}
	const packageDir = path.join(deps.profileDir, 'npm', 'node_modules', 'gentle-pi');
	copyTree(path.join(packageDir, 'skills'), path.join(deps.profileDir, 'skills'));
	// The editor's agent scanner only picks up `*.agent.md` in the agents folders, so the
	// mirrors are renamed on the way in: gentle-ai-explore.md -> gentle-ai-explore.agent.md.
	const agentsFrom = path.join(packageDir, 'assets', 'agents');
	const agentsTo = path.join(deps.profileDir, 'agents');
	mkdirSync(agentsTo, { recursive: true });
	if (existsSync(agentsFrom)) {
		for (const entry of readdirSync(agentsFrom)) {
			if (!entry.endsWith('.md')) {
				continue;
			}
			const base = entry.slice(0, -'.md'.length);
			writeFileSync(path.join(agentsTo, base + '.agent.md'), readFileSync(path.join(agentsFrom, entry)));
		}
	}
}

/**
	* Registers (or unregisters) the profile's skills and agents folders as chat
		* sources (`chat.agentSkillsLocations` / `chat.agentFilesLocations`).
	*/
async function registerChatSources(deps: SetupDeps, enable: boolean): Promise<void> {
	const skillsKey = (deps.profileDir + '/skills').replace(/\\/g, '/');
	const agentsKey = (deps.profileDir + '/agents').replace(/\\/g, '/');
	const configuration = vscode.workspace.getConfiguration();

	const skills = configuration.get<Record<string, boolean>>('chat.agentSkillsLocations', {});
	const nextSkills: Record<string, boolean> = { ...skills };
	if (enable) {
		nextSkills[skillsKey] = true;
	} else {
		delete nextSkills[skillsKey];
	}
	await configuration.update('chat.agentSkillsLocations', nextSkills, vscode.ConfigurationTarget.Global);

	const agents = configuration.get<Record<string, boolean>>('chat.agentFilesLocations', {});
	const nextAgents: Record<string, boolean> = { ...agents };
	if (enable) {
		nextAgents[agentsKey] = true;
	} else {
		delete nextAgents[agentsKey];
	}
	await configuration.update('chat.agentFilesLocations', nextAgents, vscode.ConfigurationTarget.Global);
}

export const STATUS_DATA_COMMAND = 'picode.setup.status';

/** Everything the status view renders, aggregated in one call. */
export const STATUS_COMMAND = 'picode.setup.status';

/** Registers the status view's data command. */
export function registerStatusCommand(deps: SetupDeps): vscode.Disposable {
	return vscode.commands.registerCommand(STATUS_COMMAND, async (): Promise<StatusData> => buildStatusData(deps));
}

export async function buildStatusData(deps: SetupDeps): Promise<{
	runtime: 'internal' | 'external';
	piVersion?: string;
	gentleInstalled: boolean;
	gentleVersion?: string;
	providers: number;
	defaultModel?: string;
	mcpServers: number;
	skills: number;
	agents: number;
	sessions: number;
	gitBranch?: string;
	gitChanges: number;
	ctxTokens?: number;
	ctxWindow?: number;
	cost?: number;
	inputTokens?: number;
	outputTokens?: number;
	/** The external pi's own facts (read-only), when the external runtime is in force. */
	external?: {
		found: boolean;
		version?: string;
		path?: string;
		providers: number;
		skills: number;
		agents: number;
		gentleInstalled: boolean;
	};
}> {
	const gentle = isGentleInstalled(deps.profileDir);
	const gentleVersion = readGentleVersion(deps.profileDir);
	const providers = vscode.workspace.getConfiguration('picode').get<Array<Record<string, string>>>('providers', []);
	const mcpServers = vscode.workspace.getConfiguration('picode').get<Array<Record<string, unknown>>>('mcp.servers', []).length;
	const defaultModel = readProfileDefaultModel(deps);
	const skills = countDirs(path.join(deps.profileDir, 'skills'));
	const agents = countDirs(path.join(deps.profileDir, 'agents'));
	const sessions = countDirs(path.join(deps.profileDir, 'sessions'));
	const piVersion = readInternalPiVersion(deps.distributionRoot);
	const usage = getSessionUsage();
	const ctxWindow = usage?.ctxTokens !== undefined ? readContextWindow(deps, defaultModel) : undefined;
	const git = await gitInfo();
	const external = readRuntimeMode() === 'external' ? await probeExternalPi().then(info => ({
		found: info.found,
		version: info.version,
		path: info.path,
		providers: countMachineProfileProviders(),
		skills: countDirsAt(externalProfileDir(), 'skills'),
		agents: countDirsAt(externalProfileDir(), 'agents'),
		gentleInstalled: isGentleInstalled(externalProfileDir()),
	})) : undefined;

	return {
		runtime: readRuntimeMode(),
		piVersion,
		gentleInstalled: gentle,
		gentleVersion,
		providers: providers.length,
		defaultModel,
		mcpServers,
		skills,
		agents,
		sessions,
		gitBranch: git?.branch,
		gitChanges: git?.changes ?? 0,
		ctxTokens: usage?.ctxTokens,
		ctxWindow,
		cost: usage?.cost,
		inputTokens: usage?.input,
		outputTokens: usage?.output,
		external,
	};
}

function countDirs(dir: string): number {
	try {
		return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).length;
	} catch {
		return 0;
	}
}

/** Counts the provider entries in a profile's models.json — read-only, any profile. */
function countMachineProfileProviders(): number {
	try {
		const models = JSON.parse(readFileSync(externalProfileDir() + '/models.json', 'utf8')) as Record<string, unknown>;
		const providers = models['providers'];
		return typeof providers === 'object' && providers !== null ? Object.keys(providers).length : 0;
	} catch {
		return 0;
	}
}

function countDirsAt(base: string, sub: string): number {
	try {
		return readdirSync(base + '/' + sub, { withFileTypes: true }).filter(entry => entry.isDirectory()).length;
	} catch {
		return 0;
	}
}

/** The profile's default model, from pi's own settings.json. */
function readProfileDefaultModel(deps: SetupDeps): string | undefined {
	try {
		const settings = JSON.parse(readFileSync(path.join(deps.profileDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
		return typeof settings['defaultModel'] === 'string' ? settings['defaultModel'] : undefined;
	} catch {
		return undefined;
	}
}

/** The default model's context window, from the profile's models.json. */
function readContextWindow(deps: SetupDeps, defaultModel: string | undefined): number | undefined {
	if (defaultModel === undefined || !defaultModel.includes('/')) { return undefined; }
	const slash = defaultModel.indexOf('/');
	const providerId = defaultModel.slice(0, slash);
	const modelId = defaultModel.slice(slash + 1);
	try {
		const models = JSON.parse(readFileSync(path.join(deps.profileDir, 'models.json'), 'utf8')) as Record<string, unknown>;
		const provider = (models['providers'] as Record<string, unknown> | undefined)?.[providerId];
		const list = provider !== undefined && typeof provider === 'object' ? (provider as { models?: unknown }).models : undefined;
		if (!Array.isArray(list)) { return undefined; }
		for (const model of list) {
			if (typeof model === 'object' && model !== null && (model as { id?: unknown }).id === modelId) {
				const window = (model as { contextWindow?: unknown }).contextWindow;
				return typeof window === 'number' ? window : undefined;
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** Branch and pending changes, via the editor's own git extension. */
async function gitInfo(): Promise<{ branch?: string; changes: number } | undefined> {
	try {
		const git = vscode.extensions.getExtension('vscode.git');
		if (git === undefined || !git.isActive) { return undefined; }
		const api = git.exports.getAPI(1) as {
			repositories: ReadonlyArray<{
				state: {
					HEAD?: { name?: string };
					workingTreeChanges: unknown[];
					indexChanges: unknown[];
				};
			}>;
		};
		const repo = api.repositories[0];
		if (repo === undefined) { return undefined; }
		return {
			branch: repo.state.HEAD?.name,
			changes: repo.state.workingTreeChanges.length + repo.state.indexChanges.length,
		};
	} catch {
		return undefined;
	}
}

/** Whether Gentle AI is installed in the given profile. */
/** The sentence an error carries, whatever threw it. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isGentleInstalled(profileDir: string): boolean {
	return GENTLE_PACKAGE_DIRS.every(dir => existsSync(path.join(profileDir, 'npm', 'node_modules', dir)));
}

/** A file's text; throws so the caller decides what a missing file means. */
function readTextFile(file: string): string {
	return readFileSync(file, 'utf8');
}

/** The installed Gentle AI's version, from its own manifest; undefined when it is not there. */
export function readGentleVersion(profileDir: string): string | undefined {
	try {
		const value: unknown = JSON.parse(readTextFile(path.join(profileDir, 'npm', 'node_modules', 'gentle-pi', 'package.json')));
		return typeof (value as { version?: unknown }).version === 'string' ? (value as { version: string }).version : undefined;
	} catch {
		return undefined;
	}
}

/** The internal pi's version, from the manifest of the copy PiCode ships. */
export function readInternalPiVersion(distributionRoot: string): string | undefined {
	try {
		const value: unknown = JSON.parse(readTextFile(path.join(
			distributionRoot, 'resources', 'pi-runtime', 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json')));
		return typeof (value as { version?: unknown }).version === 'string' ? (value as { version: string }).version : undefined;
	} catch {
		return undefined;
	}
}

/** The machine's pi, probed once: the shim's location and its version. */
let externalProbe: ExternalPiInfo | undefined;

export async function probeExternalPi(): Promise<ExternalPiInfo> {
	if (externalProbe !== undefined) {
		return externalProbe;
	}
	const shim = resolveOnPath('pi');
	if (shim === undefined) {
		return (externalProbe = { found: false });
	}
	// The version comes from running the machine's own pi once. The shim may be a `.cmd`, which
	// `execFile` refuses to run without a shell, so the package's CLI is run in Node mode
	// directly — the same entry the SDK loads.
	let version: string | undefined;
	const cli = findSdkEntry(path.dirname(shim))?.replace(/index\.js$/, 'cli.js');
	if (cli !== undefined && existsSync(cli)) {
		version = await new Promise<string | undefined>(resolve => {
			execFile(process.execPath, [cli, '--version'], {
				env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
				windowsHide: true,
				timeout: 8000,
			}, (error, stdout) => resolve(error === null && typeof stdout === 'string' ? stdout.trim().split('\n')[0] : undefined));
		});
	}
	return (externalProbe = { found: true, path: shim, version });
}

/**
 * Runs the npm on PATH inside the profile's npm project — the directory where pi
 * installs packages and the one whose `package.json` carries the install-script
 * approvals. The shell lets Windows resolve `npm` to `npm.cmd`, which is also how
 * pi's own package manager runs the npm on the PATH.
 */
export function runNpm(deps: SetupDeps, args: readonly string[]): Promise<void> {
	// The npm project may not exist yet - a fresh profile has no `npm/` directory until
	// the first install - and npm refuses a working directory that is not there.
	const project = path.join(deps.profileDir, 'npm');
	mkdirSync(project, { recursive: true });
	const manifest = path.join(project, 'package.json');
	if (!existsSync(manifest)) {
		writeFileSync(manifest, '{\n\t\"private\": true\n}\n');
	}
	return new Promise<void>((resolve, reject) => {
		execFile(
			'npm',
			[...args],
			{
				cwd: project,
				env: { ...process.env, PI_CODING_AGENT_DIR: deps.profileDir },
				windowsHide: true,
				shell: true,
			},
			error => (error === null ? resolve() : reject(error)),
		);
	});
}
