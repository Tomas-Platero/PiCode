/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { externalSdkEntry, findSdkEntry, resolveOnPath } from './piLocate';
import { PICODE_RUNTIME_SETTING, readRuntimeMode } from './runtime';
import { externalProfileDir, importProfile, scanExternalProfile, type ImportItem, type ImportReport, type ProfilePreview } from './profile-import';
import { isLeftBehindPackage, splitLeftBehindPackages } from './left-behind-packages';
import { mcpRowsFromMcpFile, mergeRowsById, providerRowsFromModelsFile } from './import-project';
import { isSafeNpmInstallSpec, npmInstallSpec } from './packages-registry';
import { npmRunEnv, planNpmRun } from './npm-run';

/**
 * The first-run setup, as a **bridge** for the welcome page.
 *
 * The setup itself lives in the welcome page — the same window, no popups. This module is
 * the half the workbench renderer cannot do by itself: probing whether an external pi
 * exists, importing its profile, and remembering that the setup already happened. The page
 * renders the choices and calls these commands; the commands act and answer with the state
 * that is now true.
 */

/** Opens the welcome page, where the setup is rendered. */
export const SETUP_COMMAND = 'picode.setup';

/** The state the welcome page renders: which pi, and is it there. */
export const GET_STATE_COMMAND = 'picode.setup.getState';

/**
 * The version the editor's About dialog shows: the pi **in force**. A dedicated command
 * rather than {@link GET_STATE_COMMAND} because the About wants the running pi (the external
 * one when that is the runtime), not the shipped one, and nothing else the setup state
 * carries.
 */
export const ABOUT_VERSIONS_COMMAND = 'picode.setup.aboutVersions';

/** Applies a runtime choice and answers with the resulting state. */
export const APPLY_RUNTIME_COMMAND = 'picode.setup.applyRuntime';

/** Records that the setup happened (called by the page after a theme choice). */
export const COMPLETE_COMMAND = 'picode.setup.complete';

/**
 * Ends the setup for good: the done mark of {@link COMPLETE_COMMAND}, plus the editor
 * setting that keeps the welcome page from opening again on start. Called by the page's
 * "End the setup" button.
 */
export const END_FOR_GOOD_COMMAND = 'picode.setup.endForGood';

/** Probes the machine's pi: where it is and which version, answered once and cached. */
export const PROBE_EXTERNAL_COMMAND = 'picode.setup.probeExternal';

/** Counts what the external profile would bring across. Reads, never writes. */
export const IMPORT_PREVIEW_COMMAND = 'picode.setup.importPreview';

/** The one-shot copy from the external profile into PiCode's own. */
export const IMPORT_COMMAND = 'picode.setup.importFromExternal';

/** Brings only the saved logins (auth.json), as a follow-up to the main import. */
export const IMPORT_CREDENTIALS_COMMAND = 'picode.setup.importCredentials';

/**
 * Brings the external pi's conversations in again, on demand.
 *
 * The setup import is a one-shot copy, so the profile it leaves behind is a snapshot of the day
 * it ran: every conversation the external pi has had since is in the other profile and nowhere
 * else. This is the same copy for `sessions` alone — the rest of the profile is NOT re-imported,
 * because doing that would overwrite the settings this editor has since been configured with.
 */
export const IMPORT_SESSIONS_COMMAND = 'picode.importExternalSessions';

/** The import's live state, answered to the page's poll. */
export const IMPORT_LOG_COMMAND = 'picode.setup.importLog';

/** What the probe answers about the machine's pi. */
export interface ExternalPiInfo {
	readonly found: boolean;
	readonly path?: string;
	readonly version?: string;
}

/** The "the setup already happened" mark, in this extension's own global state. */
const DONE_KEY = 'picode.onboarding.done';

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
	/** Drops the model caches and repaints the picker — what an import just changed on disk. */
	readonly refreshModels: () => void;
	/** Tells the Sessions panel that transcripts just landed. */
	readonly sessionsChanged: () => void;
	/** npm's CLI script, resolved by the caller (`extension.ts`). `undefined` plans the npm shim through a quoted shell. */
	readonly npmCli?: string;
}

/** What the welcome page renders, and what the actions answer with. */
export interface SetupState {
	readonly runtime: 'internal' | 'external';
	/** Whether the external pi (the machine's) could be found on the PATH. */
	readonly externalAvailable: boolean;
	/** The version of the internal pi, from its own package manifest. */
	readonly internalPiVersion?: string;
}

/** What the About dialog shows: the version of the pi in force. */
export interface AboutVersions {
	readonly piVersion?: string;
}

/** The import's live state: the page polls it to draw its progress bar. */
const importLog: { running: boolean; lines: string[]; step: number; total: number } = { running: false, lines: [], step: 0, total: 0 };

function logImport(line: string): void {
	importLog.lines.push(line);
	if (importLog.lines.length > 12) {
		importLog.lines.splice(0, importLog.lines.length - 12);
	}
}

/**
 * Adds what the import brought to the **editor's own settings rows**.
 *
 * The copy already put the providers and MCP servers where pi reads them, and that is
 * enough for the runtime — but the Settings pages read two editor settings
 * (`picode.providers` and `picode.mcp.servers`), the stores the owner edits and the ones
 * the editor projects *into* pi's files. Without this step the import would be invisible
 * there: a working provider no settings row explains, and one the owner could not edit
 * without starting over.
 *
 * Only items that actually landed are read, and only what the rows do not already name is
 * added — the owner's own rows are never clobbered. A failure is a line in the import log,
 * not a thrown error: the runtime already works either way, and the rows can be filled in
 * by hand if this ever fails.
 */
async function syncImportedRowsToSettings(deps: SetupDeps, report: ImportReport): Promise<void> {
	const landed = (item: ImportItem): boolean =>
		report.items.some(entry => entry.item === item && (entry.status === 'copied' || entry.status === 'overwritten'));
	/** The copied file, parsed at its one boundary: the object it holds, or nothing. */
	const readCopiedFile = (name: string): Record<string, unknown> | undefined => {
		try {
			const value: unknown = JSON.parse(readFileSync(path.join(deps.profileDir, name), 'utf8'));
			return typeof value === 'object' && value !== null && !Array.isArray(value)
				? (value as Record<string, unknown>)
				: undefined;
		} catch {
			// The copy said it landed, so this is a file that changed underneath the import —
			// read as "nothing to add" rather than as a failure of the import itself.
			return undefined;
		}
	};
	const configuration = vscode.workspace.getConfiguration('picode');

	if (landed('models')) {
		try {
			const rows = providerRowsFromModelsFile(readCopiedFile('models.json'));
			if (rows.length > 0) {
				const current = configuration.get<unknown[]>('providers') ?? [];
				const merged = mergeRowsById(
					current,
					rows,
					// The settings reader compares ids in lower case, so the merge does too: a
					// row and an import that differ only in case are the same provider.
					raw => (typeof (raw as { id?: unknown })['id'] === 'string' ? ((raw as { id: string }).id.trim().toLowerCase()) : ''),
				);
				// `Global` is this tree's name for the user-level settings target (the same
				// value every other write here uses), and the target the rows are read back
				// from when the Settings pages render them.
				await configuration.update('providers', merged, vscode.ConfigurationTarget.Global);
				logImport(`Recorded ${rows.length} provider ${rows.length === 1 ? 'connection' : 'connections'} in Settings > PiCode > Providers.`);
			}
		} catch (error) {
			logImport(`Your imported providers could not be added to the settings (${messageOf(error)}). They still work; pi reads them from its own files.`);
		}
	}

	if (landed('mcp')) {
		try {
			const rows = mcpRowsFromMcpFile(readCopiedFile('mcp.json'));
			if (rows.length > 0) {
				const current = configuration.get<unknown[]>('mcp.servers') ?? [];
				const merged = mergeRowsById(
					current,
					rows,
					raw => (typeof (raw as { name?: unknown })['name'] === 'string' ? ((raw as { name: string }).name.trim()) : ''),
				);
				await configuration.update('mcp.servers', merged, vscode.ConfigurationTarget.Global);
				logImport(`Recorded ${rows.length} MCP ${rows.length === 1 ? 'server' : 'servers'} in Settings > PiCode > MCP.`);
			}
		} catch (error) {
			logImport(`Your imported MCP servers could not be added to the settings (${messageOf(error)}). They still work; pi reads them from its own file.`);
		}
	}
}

export function registerSetupCommands(deps: SetupDeps): vscode.Disposable[] {
	const state = (): SetupState => ({
		runtime: readRuntimeMode(),
		externalAvailable: externalSdkEntry() !== undefined,
		internalPiVersion: readInternalPiVersion(deps.distributionRoot),
	});

	const markDone = (): void => {
		void deps.globalState.update(DONE_KEY, true);
	};

	return [
		vscode.commands.registerCommand(SETUP_COMMAND, () => vscode.commands.executeCommand('workbench.action.openWalkthrough')),
		vscode.commands.registerCommand(GET_STATE_COMMAND, (): SetupState => state()),
		vscode.commands.registerCommand(ABOUT_VERSIONS_COMMAND, async (): Promise<AboutVersions> => {
			// The pi in force: the machine's when that is the runtime, the shipped one otherwise.
			const piVersion = readRuntimeMode() === 'external'
				? (await probeExternalPi()).version
				: readInternalPiVersion(deps.distributionRoot);
			return {
				...(piVersion === undefined ? {} : { piVersion }),
			};
		}),
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
		vscode.commands.registerCommand(COMPLETE_COMMAND, (): void => markDone()),
		vscode.commands.registerCommand(END_FOR_GOOD_COMMAND, async (): Promise<void> => {
			markDone();
			// Ending for good also quiets the page itself: without this the welcome page would
			// open again on the next start however finished the setup is. The write lands at
			// user level — the owner's own choice, not a workspace's — the same target every
			// other settings write here uses.
			await vscode.workspace.getConfiguration().update('workbench.startupEditor', 'none', vscode.ConfigurationTarget.Global);
		}),
		vscode.commands.registerCommand(PROBE_EXTERNAL_COMMAND, (): Promise<ExternalPiInfo> => probeExternalPi()),
		vscode.commands.registerCommand(IMPORT_PREVIEW_COMMAND, (): ProfilePreview & { profile: string } =>
			({ ...scanExternalProfile(), profile: externalProfileDir() })),
		vscode.commands.registerCommand(IMPORT_COMMAND, async (credentials: unknown) => {
			// One import at a time: the page starts it and watches the log.
			if (importLog.running) {
				return undefined;
			}
			// Credentials are the one item whose copy is the owner's own decision: the page
			// asks for them behind an unchecked box, and nothing here turns the import into
			// a way of copying `auth.json` as a side effect.
			importLog.running = true;
			importLog.lines = [];
			importLog.step = 0;
			// The total is known BEFORE the copy: the external profile's own settings name the
			// packages, so the bar never jumps backwards and never sits at zero while the copy
			// runs. Every entry is kept — strings and objects — because the ones the import
			// leaves behind are read from this same list to tell the owner where they went.
			const externalPackages = ((): unknown[] => {
				try {
					const value: unknown = JSON.parse(readFileSync(path.join(externalProfileDir(), 'settings.json'), 'utf8'));
					const packages = typeof value === 'object' && value !== null && !Array.isArray(value)
						? (value as Record<string, unknown>)['packages']
						: undefined;
					return Array.isArray(packages) ? packages : [];
				} catch {
					return [];
				}
			})();
			const leftBehind = splitLeftBehindPackages(externalPackages).leftBehind;
			importLog.total = externalPackages.length > 0 ? 3 : 2;
			try {
				logImport('Bringing your packages, connections, skills and conversations…');
				const report = importProfile({
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
				importLog.step = 1;
				// What was left behind, said once per package while it is still fresh: the copy
				// removed these declarations from the settings it brought over and nothing below
				// will install them, so the log is the only place that says where they went.
				for (const reference of leftBehind) {
					logImport(`Left ${reference} behind: this editor does not carry it. It was not installed, and its declaration was not copied.`);
				}
				// Packages: the settings copy carries the declarations, but the packages' files
				// stay in the external profile's npm tree. Install each declared source into
				// this profile, so what the import brings actually runs here.
				const settingsFile = path.join(deps.profileDir, 'settings.json');
				const settings = report.items.some(i => i.item === 'settings' && (i.status === 'copied' || i.status === 'overwritten'))
					? ((): Record<string, unknown> | undefined => {
						try {
							const value: unknown = JSON.parse(readFileSync(settingsFile, 'utf8'));
							return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
						} catch {
							return undefined;
						}
					})()
					: undefined;
				const declared = settings !== undefined && Array.isArray(settings['packages'])
					? settings['packages'].filter((entry): entry is string => typeof entry === 'string')
					: [];
				let packagesInstalled = 0;
				let packagesFailed = 0;
				let packagesSkipped = 0;
				// One npm run for the whole list, not one per package. A run per package put a
				// console window on screen for each of them — twenty packages, twenty windows —
				// and the installs do not depend on each other: npm takes the whole list in a
				// single command, exactly as any one-package install does.
				const specs: string[] = [];
				for (const source of declared) {
					// The settings copy already removed these declarations, so this only fires when
					// one survived anyway — a profile imported before the copy was filtered. Either
					// way the answer is the same: nothing installs it here.
					if (isLeftBehindPackage(source)) {
						packagesSkipped += 1;
						logImport(`Left ${source} behind: this editor does not carry it. It was not installed, and its declaration was not copied.`);
						continue;
					}
					const spec = npmInstallSpec(source);
					if (spec === undefined) {
						packagesSkipped += 1;
						logImport(`Skipping ${source} — it lives on the other machine's disk. Reinstall it here if you need it.`);
						continue;
					}
					// npm runs through a shell on Windows (npm.cmd), and a shell concatenates its
					// arguments instead of escaping them — so a spec that arrived in a profile this
					// editor did not write is validated against the whitelist before it can reach
					// that shell, and a refusal is a named line, never a passed-through argument.
					if (!isSafeNpmInstallSpec(spec)) {
						packagesSkipped += 1;
						logImport(`Refused ${source}: it does not fit the spelling this editor installs through npm's shell.`);
						continue;
					}
					specs.push(spec);
				}
				if (specs.length > 0) {
					logImport(specs.length === 1 ? `Installing ${specs[0]}…` : `Installing ${specs.length} packages…`);
					try {
						await runNpm(deps, ['install', '--save', '--no-audit', '--no-fund', ...specs]);
						packagesInstalled = specs.length;
					} catch {
						// npm is all or nothing: one source it cannot resolve would leave the whole
						// batch out. Only then is each one tried on its own, so a single bad package
						// does not take the rest of the list with it.
						for (const spec of specs) {
							try {
								await runNpm(deps, ['install', '--save', '--no-audit', '--no-fund', spec]);
								packagesInstalled += 1;
							} catch {
								packagesFailed += 1;
								logImport(`Package ${spec} could not be installed — the rest goes on.`);
							}
						}
					}
				}
				importLog.step = 2;
				// The import put the providers and MCP servers where pi reads them, but the
				// Settings pages read the editor's own rows — the stores the owner edits. What
				// just arrived is added to those rows here, so the import is visible — and
				// editable — where it is managed. A failure is a line in the log, not a break:
				// the runtime already works either way.
				await syncImportedRowsToSettings(deps, report);
				// The imported providers and models are files on disk until the editor asks
				// again: drop the caches and repaint the picker now.
				logImport('Refreshing your models and connections…');
				deps.forgetRuntime();
				deps.refreshModels();
				// The packages may have just landed on disk: the running chat session
				// still holds the pre-import pi. The next conversation loads what landed.
				deps.resetChat();
				deps.sessionsChanged();
				importLog.step = importLog.total;
				logImport('Done.');
				return { ...report, packagesInstalled, packagesFailed, packagesSkipped, credentialsImported: credentials === true };
			} finally {
				importLog.running = false;
			}
		}),
		vscode.commands.registerCommand(IMPORT_CREDENTIALS_COMMAND, () => {
			// The follow-up after an automatic import that ran without logins: this copies
			// auth.json and nothing else — the rest already came over.
			return importProfile({
				from: externalProfileDir(),
				to: deps.profileDir,
				selection: { credentials: true },
			});
		}),
		vscode.commands.registerCommand(IMPORT_SESSIONS_COMMAND, () => {
			// Conversations only. `importProfile` merges and never deletes, so this cannot cost a
			// conversation that exists here and not there.
			const report = importProfile({
				from: externalProfileDir(),
				to: deps.profileDir,
				selection: { sessions: true },
			});
			const sessions = report.items.find(entry => entry.item === 'sessions');
			// The panel re-lists even when nothing came over: an import that finds nothing must not
			// leave the owner wondering whether it ran.
			deps.sessionsChanged();
			if (sessions === undefined || sessions.status === 'failed') {
				throw new Error(`PiCode: the external pi's conversations could not be brought in — ${sessions?.reason ?? 'the copy reported nothing for them'}.`);
			}
			if (sessions.status === 'absent' || (sessions.files ?? 0) === 0) {
				void vscode.window.showInformationMessage('PiCode: your external pi has no conversations to bring in.');
				return;
			}
			void vscode.window.showInformationMessage(`PiCode: your external pi's ${sessions.files} conversations are in this profile now. Nothing was moved or deleted.`);
		}),
		vscode.commands.registerCommand(IMPORT_LOG_COMMAND, (): { running: boolean; lines: string[]; step: number; total: number } => ({ ...importLog, lines: [...importLog.lines] })),
	];
}

/** The sentence an error carries, whatever threw it. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A file's text; throws so the caller decides what a missing file means. */
function readTextFile(file: string): string {
	return readFileSync(file, 'utf8');
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
 * Runs npm inside the profile's npm project — the directory where pi installs packages and
 * the one whose `package.json` carries the install-script approvals.
 *
 * The run is planned by `npm-run.ts`: node over npm's own CLI script, a real arguments
 * array, no shell — so no argument can be split on a space the way a shell concatenating
 * its arguments splits them. The shim fallback (when npm's CLI script cannot be found)
 * shells out with every argument quoted, which is also how pi's own package manager runs
 * the npm on the PATH; the whitelist stays in front of the specs either way.
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
	const plan = planNpmRun([...args], { npmCli: deps.npmCli });
	return new Promise<void>((resolve, reject) => {
		execFile(
			plan.file,
			plan.args,
			{
				cwd: project,
				env: npmRunEnv(plan, { ...process.env, PI_CODING_AGENT_DIR: deps.profileDir }),
				windowsHide: true,
				shell: plan.shell,
			},
			error => (error === null ? resolve() : reject(error)),
		);
	});
}
