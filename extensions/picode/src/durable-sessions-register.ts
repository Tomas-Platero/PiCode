/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DaemonClient, daemonEndpoint } from './durable-client';
import { durableFolder } from './durable';
import { listingForPanel, reuseRows } from './sessions-provider';
import { onConversationTouched } from './chat-record';
import type { DurableConversationRow } from './durable-tasks';
import { piDurableResumeHandler } from './sessions-resume';
import {
	conversationInWorkspace,
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

/**
 * While an import is converting transcripts, the poll stands down: the conversion adds
 * conversations one by one, and re-listing between each is what made the panel flash —
 * rows appearing for one refresh and gone the next, a hundred times over. One fire when
 * the pass ends is the only announcement it needs.
 */
export const DURABLE_IMPORT_PAUSE: { active: boolean } = { active: false };

/** How often the panel is told to look again, when the daemon's answer moved. */
const POLL_MS = 5_000;

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
	/** Where pi lives and where its logs go: the continuation runs pi in this window. */
	readonly deps: { readonly distributionRoot: string; readonly log: (line: string) => void };
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
	// The listing chain: `provideChatSessionItems` runs on it so two asks never interleave
	// (see the provider below).
	let listingChain: Promise<unknown> = Promise.resolve();
	// Per-conversation transcripts, keyed by id and the entry count they were read at: the
	// transcript is read once per *change*, not once per refresh. The daemon is the sole
	// writer and its ids are never reused, so a cached snapshot cannot go stale silently.
	const cache = new Map<number, { entriesCount: number; snapshot: unknown }>();
	// What the last poll saw: `up` plus the digest, or `down` — the daemon answered nothing.
	let lastPoll: { up: boolean; digest: string } | undefined = undefined;
	// The commit event the content-provider interface carries; no untitled durable chats
	// exist any more (durable is not a chat engine), so nothing fires it today.
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

	/** One panel row from one mapped conversation — the thrower `buildListing` skips. */
	function buildRow(row: ReturnType<typeof durableSessionRows>[number]): vscode.ChatSessionItem {
		// The timing is optional at this boundary, and an honest undefined beats a
		// 1970: a conversation with no timestamps shows no date, not "57y ago".
		const timing = row.created === undefined
			? undefined
			: { created: row.created, lastRequestStarted: undefined, lastRequestEnded: row.lastActivity };
		// A conversation whose last turn is an unanswered prompt is the owner's
		// to pick up ("te toca") — the chat was closed mid-work, and the row
		// must not dress that up as "completed".
		const status = row.inFlight === undefined
			? undefined
			: row.inFlight ? vscode.ChatSessionStatus.InProgress
				: row.owes ? vscode.ChatSessionStatus.NeedsInput : vscode.ChatSessionStatus.Completed;
		return {
			resource: vscode.Uri.from({ scheme: DURABLE_SESSION_SCHEME, path: `/${row.id}` }),
			label: row.label,
			iconPath: new vscode.ThemeIcon('server-process'),
			...(row.note.length > 0 ? { description: row.note } : {}),
			...(status === undefined ? {} : { status }),
			...(timing === undefined ? {} : { timing }),
		};
	}

	/** The listing, built for the panel from whatever the daemon answered — one connection. */
	/** The window's folders, as the paths a conversation's cwd is matched against. */
	function workspacePaths(): readonly string[] {
		return (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
	}

	async function buildListing(): Promise<vscode.ChatSessionItem[]> {
		return withDurableDaemon(async client => {
			// The window lists its own project's conversations: the daemon answers with every
			// conversation it holds, and the cwd each one runs in decides what belongs here.
			// Filtering BEFORE the cache refresh also keeps the other projects' transcripts
			// out of the per-conversation reads a listing does.
			const paths = workspacePaths();
			const inScope = (await daemonConversations(client)).filter((conversation: DurableConversationRow) => conversationInWorkspace(conversation, paths));
			await refreshCache(client, inScope);
			// One conversation that cannot be mapped must not empty the list: a throw here
			// published nothing — the panel flashed to empty and back on the next poll, the
			// owner's "aparecen y desaparecen". The row is skipped and the reason is logged.
			const built = durableSessionRows(inScope, snapshotOf).flatMap(row => {
				try {
					return [buildRow(row)];
				} catch (error) {
					options.deps.log(`durable listing: conversation ${row.id} did not map — ${error instanceof Error ? error.message : String(error)}`);
					return [];
				}
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
		provideChatSessionItems: (token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> => {
			// One listing at a time, on a chain: two concurrent calls (a poll and a refresh)
			// would each build from a different moment and publish interleaved arrays — the
			// bridge diffs by reference, so the churn reads as rows appearing and vanishing.
			const run = listingChain.then(async () => {
				if (token.isCancellationRequested) {
					return lastItems ?? [];
				}
			try {
				lastItems = listingForPanel(await buildListing(), lastItems, true);
			} catch {
					// The daemon did not answer. When a listing has NEVER succeeded (the
					// window's first moments, the spawn still booting or walking its storage
					// cold), an empty publish here is what emptied the panel at startup —
					// the owner read it as the sessions vanishing. A few bounded retries
					// wait it out; once a real listing stands, the poll's next tick is
					// soon enough and the last real listing keeps standing meanwhile.
					if (lastItems === undefined) {
						for (let attempt = 0; attempt < 5 && !token.isCancellationRequested; attempt++) {
							await new Promise(resolve => setTimeout(resolve, 1000));
							if (token.isCancellationRequested) {
								break;
							}
							try {
								lastItems = listingForPanel(await buildListing(), lastItems, true);
								break;
							} catch {
								// Still coming up; one more bounded wait.
							}
						}
					}
				}
				return lastItems ?? [];
			});
			listingChain = run.catch(() => undefined);
			return run;
		},
		provideChatSessionContent: async (resource: vscode.Uri, token: vscode.CancellationToken) => {
			const untitled = isUntitledSession(resource);
			const id = untitled ? undefined : Number(resource.path.split('/').pop());
			// The continuation runs **pi** in this window over the conversation's own history
			// (`piDurableResumeHandler`) and records each turn back into durable. The daemon
			// never converses — that was the two-heads defect this file used to carry.
			const requestHandler: vscode.ChatRequestHandler | undefined = id !== undefined && Number.isFinite(id)
				? piDurableResumeHandler(id, options.deps)
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

	/** One poll: read the list, compare with what was known, fire only on a move. */
	const poll = async (): Promise<void> => {
		if (DURABLE_IMPORT_PAUSE.active) {
			return; // the import announces itself when it is done; polling mid-pass is the flash
		}
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
	// The recorder's own pulse: a conversation opened for a new chat, or a turn recorded
	// into one, refreshes the panel AT ONCE — the poll below is only the safety net for
		// changes that happen outside this window (the TUI, a continuation elsewhere).
	const recorderListener = onConversationTouched(() => changedEmitter.fire());
	void poll(); // the first answer, so the panel does not wait for the first tick
	return {
		fireChanged: () => changedEmitter.fire(),
		dispose: () => {
			recorderListener.dispose();
			clearIntervalFn(timer);
			contentRegistration.dispose();
			registration.dispose();
			changedEmitter.dispose();
		},
	};
}
