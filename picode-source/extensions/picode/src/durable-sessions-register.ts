/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as os from 'node:os';
import { DaemonClient, daemonEndpoint } from './durable-client';
import { durableFolder } from './durable';
import { listingForPanel, reuseRows } from './sessions-provider';
import { resolveSessionCwd } from './session-cwd';
import type { DurableConversationRow } from './durable-tasks';
import { DurableRunStreamMapper } from './durable-run-stream';
import {
	durableSessionRows,
	durableSessionTurns,
	sessionsDigest,
	type DurableSnapshotLike,
	DURABLE_SESSION_SCHEME,
} from './durable-sessions';

/**
 * The durable daemon's conversations, in the editor's Sessions panel — the third source,
 * next to the editor's Local list and pi's transcripts.
 *
 * The daemon carries no per-conversation timestamp of its own, so the row's dates come from
 * the transcript's own messages; a transcript that could not be read leaves the row with no
 * date claim rather than an invented one. A daemon that is down leaves the last real listing
 * standing: an empty panel would read as "your durable conversations are gone", which is
 * exactly what a stopped daemon is not — the storage outlives the process.
 *
 * The `durable` session type registers imperatively, the way `pi` does — the editor derives
 * the filter entry from the registration itself, so no `chatSessions` contribution in
 * `package.json` is needed. The URI scheme and the session type are the same string, which
 * is what makes a row openable (`getChatSessionType` reads the scheme).
 */

/** How long one daemon conversation may take to answer, said in milliseconds. */
const DAEMON_TIMEOUT_MS = 4000;

/** How often the panel is told to look again, when the daemon's answer moved. */
const POLL_MS = 15_000;

/** One bounded conversation with the daemon; the client is closed either way. */
async function withDurableDaemon<T>(body: (client: DaemonClient) => Promise<T>): Promise<T> {
	const client = await DaemonClient.connect(daemonEndpoint(durableFolder()), DAEMON_TIMEOUT_MS);
	try {
		return await body(client);
	} finally {
		client.close();
	}
}

/** The daemon's `sessions` answer, as the rows the mapping reads. */
async function daemonConversations(client: DaemonClient): Promise<readonly DurableConversationRow[]> {
	const sessions = await client.request('sessions') as { conversations?: readonly DurableConversationRow[] } | undefined;
	return sessions?.conversations ?? [];
}

/**
 * One conversation's transcript, read the only way the protocol offers: a watched snapshot,
 * on the caller's connection — a listing is ONE conversation with the daemon, not one per row.
 */
async function daemonSnapshot(client: DaemonClient, conversationId: number): Promise<unknown> {
	const subscribed = await client.request('subscribe', { conversationId }) as { snapshot?: unknown } | undefined;
	try {
		await client.request('unsubscribe', { conversationId });
	} catch {
		// The next read unsubscribes again; a stale watch is the daemon's to reap.
	}
	return subscribed?.snapshot;
}

/** A JSON object from an unknown value, or `undefined` when it is not one. */
function jsonRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

/**
 * Whether the resource names a chat that has no conversation yet — the shape
 * `getResourceForNewChatSession` gives every new session of a contributed type
 * (`durable:/untitled-<uuid>`).
 */
function isUntitledSession(resource: vscode.Uri): boolean {
	return resource.path.startsWith('/untitled-');
}

/**
 * What one registration owns, returned so the tests can drive the clock.
 *
 * The poll asks the daemon only for the conversation list (a `sessions` call the status
 * panel already pays for every five seconds, in a heavier form) and fires the panel's
 * change event **only when the digest moved** — a conversation added, removed, or grown.
 * A daemon that is down changes nothing and fires nothing: the last real listing stays
 * standing, and the panel is never told "everything is gone".
 */
export interface DurableSessionsHandle {
	readonly fireChanged: () => void;
	readonly dispose: () => void;
}

/** The pieces the registration needs that a test may want to replace. */
export interface DurableSessionsOptions {
	/** The chat participant the content provider registers under (the connector's own). */
	readonly participant: vscode.ChatParticipant;
	/** The poll cadence, in milliseconds; the real panel never passes this — tests do. */
	readonly pollMs?: number;
	/** The clock-owning timer factory; `setInterval` unless a test hands another one in. */
	readonly setIntervalFn?: (body: () => void, ms: number) => unknown;
	readonly clearIntervalFn?: (timer: unknown) => void;
}

/**
 * Registers the `durable` session type: the rows the panel lists, the transcript it opens,
 * and the poll that keeps both honest while the window is open.
 */
export function registerDurableSessionsProvider(options: DurableSessionsOptions): vscode.Disposable & DurableSessionsHandle {
	const changedEmitter = new vscode.EventEmitter<void>();
	// The last listing the panel accepted — the same bridge rule the pi provider keeps:
	// a refresh that cannot be stood behind returns what the panel already has, never [].
	let lastItems: vscode.ChatSessionItem[] | undefined = undefined;
	// Per-conversation transcripts, keyed by id and the entry count they were read at: the
	// transcript is read once per *change*, not once per refresh. The daemon is the sole
	// writer and its ids are never reused, so a cached snapshot cannot go stale silently.
	const cache = new Map<number, { entriesCount: number; snapshot: unknown }>();
	// What the last poll saw: `up` plus the digest, or `down` — the daemon answered nothing.
	let lastPoll: { up: boolean; digest: string } | undefined = undefined;
	// The untitled → real rebind: when the first prompt of a new durable chat creates the
	// conversation, the editor migrates the open chat (editor tab or sidebar) onto the real
	// resource — history re-resolves from the daemon, editing state transfers, queued sends
	// follow. Only the two URIs cross the wire (`mainThreadChatSessions`).
	const committed = new vscode.EventEmitter<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }>();

	/** The cached transcript for one conversation, or `undefined` when none was ever read. */
	function snapshotOf(conversation: DurableConversationRow): DurableSnapshotLike | undefined {
		return cache.get(conversation.id)?.snapshot as DurableSnapshotLike | undefined;
	}

	/**
	 * Refresh the cache for the conversations whose entry count moved, on the caller's one
	 * connection. A transcript that would not be read keeps its cache — a momentary failure
	 * must not rename the row — and a conversation never read stays unread: it will show as
	 * an honest `Conversation N` with no date claim, never a guess from a clock.
	 */
	async function refreshCache(client: DaemonClient, conversations: readonly DurableConversationRow[]): Promise<void> {
		for (const conversation of conversations) {
			if (typeof conversation.id !== 'number' || !Number.isFinite(conversation.id)) {
				continue;
			}
			const entriesCount = typeof conversation.entries === 'number' ? conversation.entries : -1;
			const cached = cache.get(conversation.id);
			if (cached !== undefined && cached.entriesCount === entriesCount) {
				continue;
			}
			try {
				cache.set(conversation.id, { entriesCount, snapshot: await daemonSnapshot(client, conversation.id) as DurableSnapshotLike });
			} catch {
				// Keep what the cache holds; nothing is written on a failed read.
			}
		}
	}

	/** The listing, built for the panel from whatever the daemon answered — one connection. */
	async function buildListing(): Promise<vscode.ChatSessionItem[]> {
		return withDurableDaemon(async client => {
			const conversations = await daemonConversations(client);
			await refreshCache(client, conversations);
			const built = durableSessionRows(conversations, snapshotOf).map(row => {
				// The timing is optional at this boundary, and an honest undefined beats a
				// 1970: a conversation with no timestamps shows no date, not "57y ago".
				const timing = row.created === undefined
					? undefined
					: { created: row.created, lastRequestStarted: undefined, lastRequestEnded: row.lastActivity };
				return {
					resource: vscode.Uri.from({ scheme: DURABLE_SESSION_SCHEME, path: `/${row.id}` }),
					label: row.label,
					iconPath: new vscode.ThemeIcon('server-process'),
					...(row.note.length > 0 ? { description: row.note } : {}),
					...(row.inFlight === undefined
						? {}
						: { status: row.inFlight ? vscode.ChatSessionStatus.InProgress : vscode.ChatSessionStatus.Completed }),
					...(timing === undefined ? {} : { timing }),
				};
			});
			// The rows nobody touched come back as the objects the panel already has: the
			// bridge compares them by reference, and rebuilding one per refresh is what
			// makes the whole list republish — and blink — on every refresh (`reuseRows`).
			return reuseRows(
				lastItems ?? [],
				built,
				item => item.resource.toString(),
				(before, after) => before.label === after.label
					&& before.description === after.description
					&& before.status === after.status
					&& before.timing?.created === after.timing?.created
					&& before.timing?.lastRequestEnded === after.timing?.lastRequestEnded,
			);
		});
	}

	const provider: vscode.ChatSessionItemProvider & vscode.ChatSessionContentProvider = {
		onDidChangeChatSessionItems: changedEmitter.event,
		onDidCommitChatSessionItem: committed.event,
		provideChatSessionItems: async (token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> => {
			if (token.isCancellationRequested) {
				return lastItems ?? [];
			}
			try {
				lastItems = listingForPanel(await buildListing(), lastItems, true);
			} catch {
				// The daemon did not answer: the last real listing stands. An empty publish
				// here would read as "every durable conversation is gone", which a stopped
				// daemon is not — the storage outlives the process.
			}
			return lastItems ?? [];
		},
		provideChatSessionContent: async (resource: vscode.Uri, token: vscode.CancellationToken) => {
			const untitled = isUntitledSession(resource);
			const id = untitled ? undefined : Number(resource.path.split('/').pop());
			const requestHandler: vscode.ChatRequestHandler | undefined = untitled || (id !== undefined && Number.isFinite(id))
				? (request, _context, response, requestToken) => runDurableTurn(resource, untitled, request, response, requestToken)
				: undefined;
			const readSession: vscode.ChatSession = { history: [], requestHandler };
			if (token.isCancellationRequested || untitled || id === undefined || !Number.isFinite(id)) {
				// A new chat starts empty; a resource that names no conversation has nothing to replay.
				return readSession;
			}
			try {
				const history: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> = [];
				for (const turn of durableSessionTurns(await withDurableDaemon(client => daemonSnapshot(client, id)))) {
					if (turn.role === 'user') {
						history.push(new vscode.ChatRequestTurn2(turn.text, undefined, [], DURABLE_SESSION_SCHEME, [], undefined, undefined, undefined, undefined));
					} else {
						history.push(new vscode.ChatResponseTurn2(
							[new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(turn.text))],
							{},
							DURABLE_SESSION_SCHEME,
						));
					}
				}
				return { ...readSession, history };
			} catch {
				// The daemon would not tell: an empty interactive transcript, not a pretend one.
				return readSession;
			}
		},
	};

	/**
	 * One turn of a durable chat: the prompt to the daemon, the daemon's live events into
	 * the chat.
	 *
	 * A NEW chat's resource carries no conversation yet (`untitled-…`): the daemon creates
	 * one on the first turn, and once its run settles the chat migrates onto the real
	 * resource. An existing conversation is run as it is. Every prompt runs in the session
	 * directory — the first workspace folder that exists on disk, the home one otherwise —
	 * so the agent's tools work on the owner's project, not wherever the daemon was started.
	 */
	async function runDurableTurn(
		resource: vscode.Uri,
		untitled: boolean,
		request: vscode.ChatRequest,
		response: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<void> {
		const prompt = typeof request.prompt === 'string' && request.prompt.trim().length > 0 ? request.prompt : undefined;
		if (prompt === undefined) {
			return;
		}
		const cwd = resolveSessionCwd((vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath), os.homedir()).cwd;
		let conversationId: number | undefined = untitled ? undefined : Number(resource.path.split('/').pop());
		const mapper = new DurableRunStreamMapper();
		try {
			await withDurableDaemon(async client => {
				if (conversationId === undefined) {
					const opened = await client.request('open', { cwd }) as { conversationId?: number } | undefined;
					conversationId = typeof opened?.conversationId === 'number' ? opened.conversationId : undefined;
				}
				if (conversationId === undefined) {
					throw new Error('the daemon created no conversation for the prompt');
				}
				// Subscribed BEFORE the run is submitted, so no delta of the answer can be missed;
				// the events ride the same connection, matched by id like any response.
				await client.request('subscribe', { conversationId });
				const offEvent = client.onEvent(message => {
					const events = jsonRecord(message)?.['events'];
					if (!Array.isArray(events)) {
						return;
					}
					for (const event of events) {
						const out = mapper.consume(event);
						if (out.markdown !== undefined) {
							response.markdown(out.markdown);
						} else if (out.progress !== undefined) {
							response.progress(out.progress);
						} else if (out.warning !== undefined) {
							response.warning(out.warning);
						}
					}
				});
				const cancel = token.onCancellationRequested(() => {
					void client.request('cancel', { conversationId }).catch(() => { /* the run settling is the answer */ });
				});
				try {
					const run = await client.request('run', { conversationId, prompt, cwd }) as { status?: string; reason?: string } | undefined;
					if (run?.status !== undefined && run.status !== 'done') {
						response.warning(run.reason !== undefined
							? `The run ended without an answer (${run.reason}).`
							: 'The run ended without an answer.');
					}
				} finally {
					offEvent();
					cancel.dispose();
					try {
						await client.request('unsubscribe', { conversationId });
					} catch {
						// The next turn unsubscribes again; a stale watch is the daemon's to reap.
					}
				}
			});
		} catch (error) {
			response.warning(`${error instanceof Error ? error.message : String(error)}`);
		}
		// The rebind happens AFTER the run settles, never mid-response: the editor migrates
		// the open chat onto the real resource, and the history re-resolves from the daemon.
		if (untitled && conversationId !== undefined) {
			committed.fire({
				original: { resource, label: '' },
				modified: { resource: vscode.Uri.from({ scheme: DURABLE_SESSION_SCHEME, path: `/${conversationId}` }), label: '' },
			});
		}
	}

	/** One poll: read the list, compare with what was known, fire only on a move. */
	const poll = async (): Promise<void> => {
		let next: { up: boolean; digest: string };
		try {
			next = await withDurableDaemon(async client => ({ up: true, digest: sessionsDigest(await daemonConversations(client)) }));
		} catch {
			next = { up: false, digest: '' };
		}
		const previous = lastPoll;
		lastPoll = next;
		// A daemon that came up, or whose conversations moved, is worth a refresh; a poll
		// that saw the same thing again is not. Going down never fires: the listing to keep
		// is the last real one, and the panel already holds it.
		const moved = next.up && (!previous?.up || previous.digest !== next.digest);
		if (moved) {
			changedEmitter.fire();
		}
	};

	const setIntervalFn = options.setIntervalFn ?? ((body: () => void, ms: number) => setInterval(body, ms));
	const clearIntervalFn = options.clearIntervalFn ?? ((timer: unknown) => clearInterval(timer as ReturnType<typeof setInterval>));
	const timer = setIntervalFn(() => { void poll(); }, options.pollMs ?? POLL_MS);

	const registration = vscode.chat.registerChatSessionItemProvider(DURABLE_SESSION_SCHEME, provider);
	const contentRegistration = vscode.chat.registerChatSessionContentProvider(DURABLE_SESSION_SCHEME, provider, options.participant);
	void poll(); // the first answer, so the panel does not wait for the first tick
	return {
		fireChanged: () => changedEmitter.fire(),
		dispose: () => {
			clearIntervalFn(timer);
			contentRegistration.dispose();
			registration.dispose();
			changedEmitter.dispose();
		},
	};
}
