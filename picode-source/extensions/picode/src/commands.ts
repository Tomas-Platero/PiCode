/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { loadPiSdk } from './piSdk';
import { chatAgentDir, internalProfileDir, readRuntimeMode, sdkEntryCandidates } from './runtime';
import { ensureProfilePackages } from './packages-install';

/**
 * pi's commands, in the editor's own chat input.
 *
 * pi's terminal owns a command registry: the builtin TUI commands plus the commands its
 * loaded extensions register through `pi.registerCommand` — `/omni` and its fellow provider
 * commands among them. This module puts the **extension** commands of the runtime in force
 * into the chat input's slash list, contributed as prompt files the editor's own slash
 * machinery lists.
 *
 * Two decisions are deliberate here:
 *
 * - **Extension commands only.** pi's builtin commands (`/model`, `/compact`, …) are the
 *   terminal's own UI — they open selectors and drive session tooling the chat's turn flow
 *   cannot host. An extension command, though, is dispatched by pi's session itself
 *   (`AgentSession.prompt` runs it immediately), so the editor only has to deliver the typed
 *   text `/name args` — which it does, because a slash prompt part keeps its text in the
 *   prompt that reaches the participant. Skills and prompt templates already reach the input
 *   through the skill provider in `extension.ts`.
 * - **The runtime in force.** The commands are read from a session built by the same SDK
 *   entry and profile a chat turn uses (`runtime.ts`), so switching `picode.pi.runtime` to
 *   the external pi switches the command list to what THAT pi has loaded. When a chat
 *   session is live, its own registry is read instead — no second session, no drift.
 *
 * The files are written into this extension's storage as real `.prompt.md` files, because
 * the editor's slash listing parses what a prompt-file provider hands over. The editor only
 * lists them; pi stays the only one who executes anything.
 */

/** One pi command, as the chat's slash list shows it. */
export interface PiCommand {
	readonly name: string;
	readonly description?: string;
}

/** A resource as the chat's prompt-file host reads it (the `name`/`description` travel; see `extension.ts`). */
interface NamedChatResource extends vscode.ChatResource {
	readonly name: string;
	readonly description?: string;
}

/** The commands a pi session's extension runner holds, read structurally. */
export function piCommandsOfRunner(piSession: unknown): readonly PiCommand[] {
	const runner = (piSession as { extensionRunner?: { getRegisteredCommands?: () => unknown } } | undefined)?.extensionRunner;
	if (typeof runner?.getRegisteredCommands !== 'function') {
		return [];
	}
	try {
		const registered = runner.getRegisteredCommands();
		if (!Array.isArray(registered)) {
			return [];
		}
		return registered.flatMap(command => {
			const record = typeof command === 'object' && command !== null ? command as Record<string, unknown> : undefined;
			const name = typeof record?.['name'] === 'string' && record['name'].length > 0
				? record['name']
				: typeof record?.['invocationName'] === 'string' && record['invocationName'].length > 0 ? record['invocationName'] : undefined;
			if (name === undefined) {
				return [];
			}
			const description = typeof record?.['description'] === 'string' && record['description'].length > 0 ? record['description'] : undefined;
			return [{ name, ...(description === undefined ? {} : { description }) } satisfies PiCommand];
		});
	} catch {
		return [];
	}
}

/** pi's runtime services, opaque here: handed back to pi to build a session from. */
interface DiscoveryServices {
	readonly [key: string]: unknown;
}

/** pi's session store, opaque here: created once and handed back to pi. */
interface DiscoverySessionManager {
	readonly [key: string]: unknown;
}

/** A throwaway discovery session, opaque here: only its command registry and `dispose` are read. */
interface DiscoverySession {
	readonly [key: string]: unknown;
}

/** pi's SDK, reduced to what opening a throwaway session for its command registry needs. */
interface DiscoverySdk {
	createAgentSessionServices(options: { cwd: string; agentDir?: string }): Promise<DiscoveryServices>;
	createAgentSessionFromServices(options: { services: DiscoveryServices; sessionManager: DiscoverySessionManager }): Promise<{ session: DiscoverySession }>;
	SessionManager: { create(cwd: string, sessionDir?: string): DiscoverySessionManager };
}

export interface PiCommandDeps {
	/** The distribution root, so the runtime in force can be found without configuration. */
	readonly distributionRoot: string;
	readonly log: (line: string) => void;
	/** The live chat session's commands and its identity, or `undefined` while no session runs. */
	readonly liveSessionCommands: () => { readonly key: string; readonly commands: readonly PiCommand[] } | undefined;
	/** Fires when the chat's session was created, replaced or dropped, so the list re-reads. */
	readonly onSessionChanged?: vscode.Event<void>;
}

/** A file name a command's prompt file can carry. */
function fileNameOf(command: PiCommand): string {
	return `${command.name.replace(/[^\p{L}\d_.-]+/gu, '-')}.prompt.md`;
}

/** The text of one command's prompt file: front matter for the description, one line of body. */
function promptFileText(command: PiCommand): string {
	const description = (command.description ?? `pi's /${command.name} command`).replace(/\s+/g, ' ');
	return `---\ndescription: ${description}\n---\n\nThe message text reaches pi as its /${command.name} command, with any arguments typed after it.\n`;
}

/** A file's text, or `undefined` when it is not there. */
function readTextFile(file: string): string | undefined {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
}

/** Opens a session of the runtime in force, reads its command registry and closes it. */
async function discoverCommands(deps: PiCommandDeps, cwd: string, agentDir: string | undefined): Promise<readonly PiCommand[]> {
	const loaded = await loadPiSdk<Partial<DiscoverySdk>>(sdkEntryCandidates(deps.distributionRoot));
	if ('problem' in loaded) {
		deps.log(`commands: ${loaded.problem}`);
		return [];
	}
	const sdk = loaded.sdk as DiscoverySdk;
	if (typeof sdk.createAgentSessionServices !== 'function'
		|| typeof sdk.createAgentSessionFromServices !== 'function'
		|| typeof sdk.SessionManager?.create !== 'function') {
		deps.log('commands: this pi does not expose the session SDK this editor expects.');
		return [];
	}
	const session = await (async () => {
		// Before pi loads anything: the profile's declared-but-missing packages are installed here
		// (hidden, one run) so pi's loader never installs one itself — its per-package installs
		// each flashed a console window on Windows.
		await ensureProfilePackages({ profileDir: internalProfileDir(deps.distributionRoot), log: deps.log });
		const services = await sdk.createAgentSessionServices({ cwd, ...(agentDir === undefined ? {} : { agentDir }) });
		const sessionManager = sdk.SessionManager.create(cwd, agentDir === undefined ? undefined : path.join(agentDir, 'sessions'));
		const created = await sdk.createAgentSessionFromServices({ services, sessionManager });
		return created.session;
	})();
	try {
		return piCommandsOfRunner(session);
	} finally {
		// The discovery session held nothing: no message ran, so pi wrote no transcript.
		try {
			(session as { dispose?: () => unknown }).dispose?.();
		} catch {
			// A session that will not close cleanly is pi's own cleanup problem; the
			// commands were already read.
		}
	}
}

/**
 * Registers the prompt-file provider that lists the runtime in force's pi commands as chat
 * slash commands.
 *
 * The listing is recomputed whenever the editor asks: a live session's registry is read
 * straight away, and without one the commands come from a throwaway discovery session,
 * cached until the session, the runtime or the folder changes. `refresh` forces a re-read
 * (a runtime switch while the window sits idle, for one).
 */
export function registerPiCommandPromptFiles(context: vscode.ExtensionContext, deps: PiCommandDeps): { refresh(): void; dispose(): void } {
	const commandsDir = path.join(context.globalStorageUri.fsPath, 'pi-commands');
	const changed = new vscode.EventEmitter<void>();
	/** The prompt files the last sync wrote, so a command that disappears loses its file. */
	let written = new Set<string>();
	/** The commands read from a throwaway discovery session, keyed by where they came from. */
	let discovery: { readonly key: string; readonly commands: readonly PiCommand[] } | undefined;
	/** The discovery in flight, so a burst of provide calls reads pi once. */
	let discovering: Promise<readonly PiCommand[]> | undefined;
	/** The last listing handed to the editor; returned again when a read fails. */
	let lastResources: NamedChatResource[] = [];

	/**
	 * pi's extension commands right now.
	 *
	 * The live chat session's own registry wins — it is the session the answers run in. The
	 * discovery key covers the runtime mode, the folder and the profile, so a switch of any
	 * of them reads again instead of serving another pi's commands.
	 */
	const currentCommands = (): Promise<readonly PiCommand[]> => {
		const live = deps.liveSessionCommands();
		if (live !== undefined) {
			return Promise.resolve(live.commands);
		}
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const agentDir = chatAgentDir(deps.distributionRoot);
		const key = [readRuntimeMode(), cwd, agentDir ?? ''].join('\u0000');
		if (discovery?.key === key) {
			return Promise.resolve(discovery.commands);
		}
		discovering ??= discoverCommands(deps, cwd, agentDir)
			.then(commands => {
				discovery = { key, commands };
				return commands;
			})
			.finally(() => { discovering = undefined; });
		return discovering;
	};

	/** Writes the prompt files the commands want now, and removes the ones it wrote before. */
	const syncFiles = (commands: readonly PiCommand[]): NamedChatResource[] => {
		fs.mkdirSync(commandsDir, { recursive: true });
		/** The files the commands want now, first command of a name wins. */
		const wanted = new Map<string, PiCommand>();
		for (const command of commands) {
			if ([...wanted.values()].some(seen => seen.name === command.name)) {
				continue;
			}
			let file = fileNameOf(command);
			for (let suffix = 2; wanted.has(file); suffix += 1) {
				file = `${fileNameOf(command).slice(0, -'.prompt.md'.length)}-${suffix}.prompt.md`;
			}
			wanted.set(file, command);
		}
		for (const previous of written) {
			if (!wanted.has(previous)) {
				try {
					fs.unlinkSync(path.join(commandsDir, previous));
				} catch {
					// Harmless: the listing comes from the provider, not the folder, and
					// the next sync tries the removal again.
				}
			}
		}
		const resources = [...wanted].map(([file, command]) => {
			const filePath = path.join(commandsDir, file);
			const text = promptFileText(command);
			if (readTextFile(filePath) !== text) {
				fs.writeFileSync(filePath, text);
			}
			return {
				uri: vscode.Uri.file(filePath),
				name: command.name,
				...(command.description === undefined ? {} : { description: command.description }),
			};
		});
		written = new Set(wanted.keys());
		return resources;
	};

	/** Re-reads pi and re-syncs the files. */
	const refreshNow = async (): Promise<NamedChatResource[]> => {
		lastResources = syncFiles(await currentCommands());
		return lastResources;
	};

	/** Re-reads and tells the chat, never throwing: a failed read keeps the last listing. */
	const refreshQuietly = (): void => {
		refreshNow()
			.then(() => changed.fire())
			.catch(error => deps.log(`commands: ${error instanceof Error ? error.message : String(error)}`));
	};

	const registration = vscode.chat.registerPromptFileProvider({
		onDidChangePromptFiles: changed.event,
		providePromptFiles: async (): Promise<vscode.ChatResource[]> => {
			try {
				return await refreshNow();
			} catch (error) {
				deps.log(`commands: ${error instanceof Error ? error.message : String(error)}`);
				return lastResources;
			}
		},
	});

	// A session created, replaced or dropped changes where the commands come from; the
	// editor's own caches only let go when the change event fires.
	if (deps.onSessionChanged !== undefined) {
		context.subscriptions.push(deps.onSessionChanged(() => changed.fire()));
	}
	context.subscriptions.push(registration, changed);

	// Warm the listing shortly after activation, so the first `/` finds the files already
	// written instead of waiting on a discovery session.
	const warmup = setTimeout(refreshQuietly, 2_000);
	context.subscriptions.push(new vscode.Disposable(() => clearTimeout(warmup)));

	return {
		refresh: refreshQuietly,
		dispose: () => {
			for (const subscriptions of [registration, changed]) {
				subscriptions.dispose();
			}
		},
	};
}
