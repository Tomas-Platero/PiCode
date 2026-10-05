/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DaemonClient, daemonEndpoint } from './durable-client';
import { durableWorkRows, snapshotInFlight, type DurableWorkRow } from './durable-tasks';

/**
 * The durable agent, seen from the editor.
 *
 * The agent is the repository's `experimental/durable` program: a headless daemon that owns
 * its conversations in SQLite and serves local clients over a named pipe. This module is
 * the editor's client for it — nothing more. It starts and stops the daemon, asks it what
 * it holds (`ping` / `sessions`), lets the owner open a conversation's transcript and send
 * a prompt through it, and answers the status panel's one question: is the daemon up, and
 * what does it hold **right now**.
 *
 * It does not touch the agent's storage, and it never opens the SQLite file — only the
 * daemon does that. Nothing here reads or writes anything outside PiCode's own surfaces:
 * the daemon's own profile is PiCode's internal one (`data/pi-agent`), which it resolves
 * itself.
 */

/** Where the editor looks for the durable agent, as the settings spell it. */
export const PICODE_DURABLE_FOLDER_SETTING = 'picode.durable.folder';

/** The folder the default setting names, resolved against the workspace when relative. */
export const DEFAULT_DURABLE_FOLDER = 'experimental/durable';

/** One conversation as the daemon's `sessions` lists it. */
interface DurableConversationRow {
	readonly id: number;
	readonly entries: number;
	readonly newest: string;
	readonly note: string;
}

/** What the status panel draws for the Durable section: only what the daemon answered. */
export interface DurableStatus {
	/** True only when the daemon answered a `ping`. */
	readonly up: boolean;
	readonly endpoint: string;
	/** Conversations the daemon holds, from `sessions`. */
	readonly conversations?: number;
	/** Conversations owned by a background subagent task, from the `sessions` notes. */
	readonly subagentTasks?: number;
	/** Live event streams the daemon is fanning out, from `ping`. */
	readonly streams?: number;
	readonly pid?: number;
	readonly uptimeMs?: number;
	/**
	 * The durable work worth one row each (`durable-tasks.ts`): the subagent-owned
	 * conversations and any conversation with a run in flight, each with the state its
	 * snapshot actually carries. Absent when the daemon is down — the section then says
	 * so instead of listing rows nobody read.
	 */
	readonly work?: readonly DurableWorkRow[];
	/** Why the daemon could not be read, when it is up but would not answer. */
	readonly error?: string;
}

/**
 * The folder that holds the agent's `cli.js`, from the setting.
 *
 * A relative path is resolved against the workspace folders: the setting's default points at
 * the repository's `experimental/durable`, which exists when the editor is opened on this
 * repository. When nothing resolves, the answer is `undefined` — the commands say so in one
 * sentence rather than guessing a path.
 */
export function durableFolder(): string | undefined {
	const configured = vscode.workspace.getConfiguration('picode').get<string>(PICODE_DURABLE_FOLDER_SETTING)
		?? DEFAULT_DURABLE_FOLDER;
	const trimmed = configured.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	if (path.isAbsolute(trimmed)) {
		return trimmed;
	}
	const folders = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
	for (const folder of folders) {
		const candidate = path.join(folder, trimmed);
		if (fs.existsSync(path.join(candidate, 'cli.js'))) {
			return candidate;
		}
	}
	// Nothing on disk matched; with a folder open the first one is still the honest guess —
	// the commands that need `cli.js` will say exactly that it is missing.
	return folders.length > 0 ? path.join(folders[0], trimmed) : undefined;
}

/**
 * The pi extension that hands work to the daemon (`durable_send`, `durable_list`,
 * `durable_read`), as the chat's session loads it.
 *
 * It lives next to the durable folder — the `picode.durable.folder` setting names the
 * folder, the bridge is its `../pi-durable-bridge/extension.ts` sibling — and it is only
 * real when the file is on disk: `undefined` means "no bridge here", which the caller
 * treats as "the chat runs without it", never as an error.
 */
export function durableBridgeExtensionPath(): string | undefined {
	const folder = durableFolder();
	if (folder === undefined) {
		return undefined;
	}
	const candidate = path.join(folder, '..', 'pi-durable-bridge', 'extension.ts');
	return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * How many conversations one status reading snapshots for their live run state.
 *
 * Each snapshot costs a `subscribe`/`unsubscribe` round-trip on the local pipe; the cap
 * keeps a panel refresh bounded when a daemon has collected dozens of conversations. The
 * subagent-owned ones are read first, because they are the rows the list exists for.
 */
const MAX_SNAPSHOTS_PER_READ = 16;

/** One bounded conversation with the daemon; the client is closed either way. */
async function withDaemon<T>(timeoutMs: number, body: (client: DaemonClient) => Promise<T>): Promise<T> {
	const client = await DaemonClient.connect(daemonEndpoint(durableFolder()), timeoutMs);
	try {
		return await body(client);
	} finally {
		client.close();
	}
}

/** The daemon's answer about itself, or the honest "not running" — never a hang. */
export async function readDurableStatus(): Promise<DurableStatus> {
	const endpoint = daemonEndpoint(durableFolder());
	try {
		return await withDaemon(1500, async client => {
			const ping = await client.request('ping') as { pid?: number; uptimeMs?: number; streams?: number };
			const sessions = await client.request('sessions') as { conversations?: readonly DurableConversationRow[] };
			const conversations = sessions.conversations ?? [];
			// Live state, conversation by conversation: `subscribe` answers with the
			// conversation's snapshot, whose `run` presence is the protocol's own "in
			// flight". A conversation that cannot be snapshotted is recorded as unknown
			// rather than read as idle — the row says so instead of guessing.
			const subagentFirst = [...conversations].sort((a, b) =>
				Number(b.note?.startsWith('subagent') ?? false) - Number(a.note?.startsWith('subagent') ?? false) || a.id - b.id);
			const inFlight = new Map<number, boolean | undefined>();
			for (const row of subagentFirst.slice(0, MAX_SNAPSHOTS_PER_READ)) {
				try {
					const subscribed = await client.request('subscribe', { conversationId: row.id }) as { snapshot?: unknown };
					inFlight.set(row.id, snapshotInFlight(subscribed?.snapshot));
				} catch {
					inFlight.set(row.id, undefined);
				}
				try {
					await client.request('unsubscribe', { conversationId: row.id });
				} catch {
					// The next refresh unsubscribes again; a stale watch is the daemon's to reap.
				}
			}
			return {
				up: true,
				endpoint,
				conversations: conversations.length,
				subagentTasks: conversations.filter(row => row.note.startsWith('subagent')).length,
				streams: ping.streams,
				pid: ping.pid,
				uptimeMs: ping.uptimeMs,
				work: durableWorkRows(conversations, inFlight),
			};
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { up: false, endpoint, error: message };
	}
}

/**
 * Concatenated text of a pi-ai assistant message (content may be a string, an array of
 * blocks, or missing) — copied from `experimental/durable/lib/common.js`'s `textOf`, for
 * the same reason the wire client is copied: the connector cannot import from there.
 */
function textOf(message: unknown): string {
	const record = message as { content?: unknown } | null | undefined;
	const content = record?.content;
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	return content
		.map(block => (block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
		.join('');
}

/** Text of one transcript entry — copied from `experimental/durable/lib/common.js`'s `entryText`. */
function entryText(entry: unknown): string {
	const record = entry as { model?: unknown; data?: unknown } | null | undefined;
	const messages = Array.isArray(record?.model) ? record.model : Array.isArray(record?.data) ? record.data : [];
	return messages.map(textOf).join(' ').trim();
}

/** A transcript entry's role, as a person reading the output channel would want it. */
function entryRole(kind: unknown): string {
	const name = typeof kind === 'string' ? kind.replace(/^pi\./, '') : 'entry';
	return name;
}

/** The snapshot's entries, as readable lines for the output channel. */
function renderSnapshot(snapshot: unknown): string {
	const entries = (snapshot as { entries?: unknown } | null | undefined)?.entries;
	if (!Array.isArray(entries) || entries.length === 0) {
		return '(no entries in the snapshot)';
	}
	const lines: string[] = [];
	for (const entry of entries) {
		const record = entry as { id?: unknown; kind?: unknown } | null | undefined;
		const text = entryText(entry);
		lines.push(`[${entryRole(record?.kind)}] ${text.length > 0 ? text : '(no text)'}`);
	}
	return lines.join('\n');
}

/** The output channel the durable answers land in, created once. */
let durableChannel: vscode.OutputChannel | undefined;
function outputChannel(): vscode.OutputChannel {
	durableChannel ??= vscode.window.createOutputChannel('PiCode Durable');
	return durableChannel;
}

/** The daemon's error as one honest sentence. */
function daemonUnavailableSentence(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * What the agent has to be told about THIS editor before it starts: which pi profile to read
 * and which settings file to obey.
 *
 * Without them the agent falls back to its own defaults, and for a portable or side-by-side
 * build those point at a different PiCode install entirely — so the agent would read the other
 * one's profile and settings. That is the mixing this exists to prevent.
 */
export interface DurableAgentPaths {
	/** `data/pi-agent` inside this distribution: the profile the editor itself uses. */
	readonly agentProfile: string;
	/** This editor's user settings file, whose `picode.durable.*` keys the agent honours. */
	readonly userSettingsFile: string;
}

/** "PiCode: Start Durable Agent": run `cli.js serve` in the durable folder and wait for it to answer. */
async function startDurableAgent(paths: DurableAgentPaths): Promise<void> {
	const folder = durableFolder();
	const cliFile = folder === undefined ? undefined : path.join(folder, 'cli.js');
	if (cliFile === undefined || !fs.existsSync(cliFile)) {
		// Two different problems, said differently. With no folder open there is nothing for a
		// relative path to resolve against, and telling someone to change a setting they never
		// set is not an answer — it sends them looking in the wrong place.
		void vscode.window.showWarningMessage(folder === undefined
			? `PiCode: the durable agent lives inside the PiCode repository, and it is looked for at "${DEFAULT_DURABLE_FOLDER}" relative to an open folder — none is open. Open the repository folder, or set "picode.durable.folder" to an absolute path.`
			: `PiCode: the durable agent folder was not found — "${folder}" holds no cli.js. Set "picode.durable.folder" to the folder that does.`,
		);
		return;
	}
	const current = await readDurableStatus();
	if (current.up) {
		void vscode.window.showInformationMessage(`PiCode: the durable agent is already running at ${current.endpoint} (pid ${current.pid}).`);
		return;
	}
	const child = spawn('node', [cliFile, 'serve'], {
		cwd: folder,
		detached: true,
		stdio: 'ignore',
		windowsHide: true,
		env: { ...process.env, PI_AGENT_PROFILE: paths.agentProfile, PICODE_USER_SETTINGS: paths.userSettingsFile },
	});
	child.unref();
	const endpoint = current.endpoint;
	for (let attempt = 0; attempt < 20; attempt++) {
		await new Promise(resolve => setTimeout(resolve, 500));
		const status = await readDurableStatus();
		if (status.up) {
			void vscode.window.showInformationMessage(
				`PiCode: durable agent started at ${endpoint} (pid ${status.pid}, ${status.conversations ?? 0} conversation(s)).`,
			);
			return;
		}
	}
	void vscode.window.showWarningMessage(
		`PiCode: the durable agent was started but did not answer at ${endpoint} within 10 s — run "node cli.js serve" in ${folder} by hand to see why.`,
	);
}

/** "PiCode: Stop Durable Agent": ask the daemon to shut down through the protocol. */
async function stopDurableAgent(): Promise<void> {
	try {
		await withDaemon(2500, client => client.request('shutdown') as Promise<unknown>);
		void vscode.window.showInformationMessage('PiCode: the durable agent stopped.');
	} catch (error) {
		void vscode.window.showInformationMessage(
			`PiCode: the durable agent is not running — nothing to stop (${daemonUnavailableSentence(error)}).`,
		);
	}
}

/** The conversations the daemon holds, as quick-pick rows; `undefined` when cancelled or empty. */
async function pickConversation(rows: readonly DurableConversationRow[], subject: string, includeNew: boolean): Promise<number | 'new' | undefined> {
	const items: Array<vscode.QuickPickItem & { value?: number | 'new' }> = [
		...(includeNew ? [{ label: 'New conversation', description: 'the durable agent creates one', value: 'new' as const }] : []),
		...rows.map(row => ({
			label: `Conversation ${row.id}`,
			description: `${row.entries} entries${row.note.length > 0 ? ` · ${row.note}` : ''}`,
			detail: `last entry: ${row.newest}`,
			value: row.id,
		})),
	];
	if (items.length === 0) {
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(items, { placeHolder: subject });
	return picked?.value;
}

/** The effective model and agent the settings name, sent along with `open`. */
function modelAndAgentParams(): Record<string, unknown> {
	const configuration = vscode.workspace.getConfiguration('picode');
	const params: Record<string, unknown> = {};
	const model = configuration.get<string>('durable.model')?.trim();
	const agent = configuration.get<string>('durable.agent')?.trim();
	if (model) {
		params['model'] = model;
	}
	if (agent) {
		params['agent'] = agent;
	}
	return params;
}

/** "PiCode: Show Durable Conversations": pick one, and read its transcript into the output channel. */
async function showDurableConversations(): Promise<void> {
	try {
		await withDaemon(2500, async client => {
			const sessions = await client.request('sessions') as { conversations?: readonly DurableConversationRow[] };
			const rows = sessions.conversations ?? [];
			if (rows.length === 0) {
				void vscode.window.showInformationMessage('PiCode: the durable agent holds no conversations yet — send it a prompt first.');
				return;
			}
			const picked = await pickConversation(rows, 'Which durable conversation to open', false);
			if (picked === undefined) {
				return;
			}
			const subscribed = await client.request('subscribe', { conversationId: picked }) as { snapshot?: unknown };
			const channel = outputChannel();
			channel.appendLine(`--- Conversation ${picked} · ${new Date().toLocaleString()} ---`);
			channel.appendLine(renderSnapshot(subscribed.snapshot));
			channel.appendLine('');
			channel.show(true);
		});
	} catch (error) {
		void vscode.window.showWarningMessage(`PiCode: the durable agent could not be read (${daemonUnavailableSentence(error)}).`);
	}
}

/** "PiCode: Send a Prompt to the Durable Agent": open (or create) a conversation and run the prompt. */
async function sendDurablePrompt(): Promise<void> {
	try {
		await withDaemon(2500, async client => {
			const sessions = await client.request('sessions') as { conversations?: readonly DurableConversationRow[] };
			const picked = await pickConversation(sessions.conversations ?? [], 'Which durable conversation to send the prompt to', true);
			if (picked === undefined) {
				return;
			}
			const prompt = await vscode.window.showInputBox({ prompt: 'Prompt for the durable agent', placeHolder: 'What should it do?' });
			if (prompt === undefined || prompt.trim().length === 0) {
				return;
			}
			const answer = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Durable agent is thinking…' },
				async () => {
					const opened = await client.request('open', picked === 'new' ? modelAndAgentParams() : { conversationId: picked, ...modelAndAgentParams() }) as { conversationId: number };
					return { conversationId: opened.conversationId, ...(await client.request('run', { conversationId: opened.conversationId, prompt }) as { status?: string; answer?: string | null }) };
				},
			);
			const channel = outputChannel();
			channel.appendLine(`--- Conversation ${answer.conversationId} · ${new Date().toLocaleString()} ---`);
			channel.appendLine(`[you] ${prompt}`);
			channel.appendLine(`[assistant] ${answer.answer ?? `(run ended with status "${answer.status}", no answer text)`}`);
			channel.appendLine('');
			channel.show(true);
			void vscode.window.showInformationMessage(
				`PiCode: conversation ${answer.conversationId} settled — the answer is in the "PiCode Durable" output channel.`,
			);
		});
	} catch (error) {
		void vscode.window.showWarningMessage(`PiCode: the prompt could not be sent (${daemonUnavailableSentence(error)}).`);
	}
}

/** Registers the four durable commands; the caller collects the disposables. */
export function registerDurableCommands(paths: DurableAgentPaths): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand('picode.durable.start', () => startDurableAgent(paths)),
		vscode.commands.registerCommand('picode.durable.stop', stopDurableAgent),
		vscode.commands.registerCommand('picode.durable.list', showDurableConversations),
		vscode.commands.registerCommand('picode.durable.send', sendDurablePrompt),
	];
}
