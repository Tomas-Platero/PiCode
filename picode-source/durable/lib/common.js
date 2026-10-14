// Shared setup: models + registry + harness over SQLite in .data/.
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { AgentDoc, Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { loadOmniProvider, profileModelProblem } from "./profile.js";
import { ProofTools, SubagentExtension } from "./extensions.js";

export const CTX = BACKGROUND_CONTEXT;
/**
 * Where the daemon keeps its own storage: `sessions.sqlite`, its WAL files, the daemon log.
 *
 * `.data/` beside this folder by default, which is what the repository's own runs and the proofs
 * use. PiCode names it when *it* starts the agent (`PICODE_DURABLE_DATA`), because an editor ships
 * this folder inside its own installation: anything written there dies with an uninstall, and the
 * conversations are the one thing a durable agent exists to keep. The editor points it at its own
 * data directory instead, beside the pi profile the daemon already reads (`PI_AGENT_PROFILE`).
 */
export const DATA_DIR =
	process.env.PICODE_DURABLE_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".data");

/** The ONE shared CLI database — never numbered, never per-run. The daemon owns it; the direct commands open it only when no daemon is running. */
export const SHARED_DB = "sessions.sqlite";

/** Path of a named database file inside .data/. */
export function dbPath(name) {
	return path.join(DATA_DIR, name);
}

/**
 * Delete a proof database (+ WAL/SHM) so a fresh run of a proof starts clean.
 * One database per proof: proof1.sqlite, proof2.sqlite, proof3.sqlite.
 */
export function resetDatabase(name) {
	mkdirSync(DATA_DIR, { recursive: true });
	for (const suffix of ["", "-shm", "-wal"]) {
		rmSync(dbPath(name) + suffix, { force: true });
	}
}

export const MODEL = { provider: process.env.PI_AGENT_PROVIDER || "omni", modelId: process.env.PI_AGENT_MODEL || "auto" };

export async function openHarness({ db = process.env.PI_DURABLE_DB || "session.sqlite", extensions = [] } = {}) {
	const sqlitePath = dbPath(db);
	const models = createModels();
	// A profile with no usable provider is a normal state (a fresh install has one), not a
	// crash: open the harness WITHOUT a provider so the storage serves (ping, sessions,
	// subscribe), and report the reason on the returned `profileProblem` for the caller to
	// act on — the daemon prints it and fails every run with it; the direct commands
	// refuse with it. Nothing here swallows the fact; nothing here dies of it either.
	const profileProblem = profileModelProblem();
	if (profileProblem) {
		console.error(`[profile] ${profileProblem}`);
	} else {
		models.setProvider(loadOmniProvider());
	}

	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(ProofTools);
	registry.install(SubagentExtension); // brings the sleep-based tools and the subagent anchor task
	for (const extension of extensions) registry.install(extension); // CLI-only extensions (guard, skills); proofs stay untouched

	const storage = await openNodeSqliteStorage(sqlitePath);
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
			onReport: (error) => console.error("[harness report]", error?.message ?? error),
		},
		CTX,
	);
	return { harness, models, registry, sqlitePath, storage, profileProblem };
}

/**
 * Every conversation in the shared database, one row per conversation: id,
 * entry count, newest entry (a proxy for last activity), and its relation
 * (`fork of …` or subagent).
 *
 * NOTE: the README/spec's Session.scanConversations is not on the runtime
 * Harness; read the storage directly, serialized on the session line.
 */
export async function listConversations(harness, storage) {
	const records = await harness.readOnLine(async () => {
		const items = [];
		let cursor;
		for (;;) {
			const page = await storage.scanConversations({}, 100, cursor, CTX);
			items.push(...page.items);
			// The storage page carries its continuation in `next` (types.d.ts `Page<T, C>`):
			// reading anything else broke the loop after the first page, which is how the
			// panel came to list only the first hundred conversations of a grown database.
			cursor = page.next;
			if (!cursor) break;
		}
		return items;
	});
	const rows = [];
	const counts = await indexedEntryCounts(storage);
	for (const record of records) {
		const counted = counts !== undefined
			? await countConversationIndexed(counts, record.id, harness, storage)
			: await countConversation(harness, storage, record.id);
		rows.push({
			id: record.id,
			entries: counted.count,
			newest: describeNewest(counted.newest),
			note: record.owner ? `subagent (task ${record.owner.taskId})` : record.parent ? `fork of ${record.parent.conversationId}` : "",
			...(counted.cwd === undefined ? {} : { cwd: counted.cwd }),
		});
	}
	return rows;
}

/**
 * Every conversation's entry count in ONE grouped query — the SQLite storage's own
 * database is the daemon's to read, and the index makes the whole listing a constant
 * cost no matter how many conversations or entries it holds. This is what keeps a new
 * conversation's `open` from queueing behind a listing that used to walk the world.
 * `undefined` when the storage is not SQLite (or the schema moved): the caller falls
 * back to the per-conversation incremental path.
 */
async function indexedEntryCounts(storage) {
	const db = storage?.db;
	if (db === undefined || typeof db.all !== "function") {
		return undefined;
	}
	try {
		const rows = await db.all("SELECT conversation_id AS id, COUNT(*) AS count, MAX(id) AS maxId FROM entries GROUP BY conversation_id");
		return new Map(rows.map((row) => [row.id, row]));
	} catch {
		return undefined;
	}
}

/**
 * One conversation's listing data from the grouped counts: the count is the query's own
 * answer, and the only per-conversation reads happen when the conversation's top entry
 * moved (the newest record for the row's summary, the agent document for its cwd). A
 * conversation nobody touched costs nothing at all.
 */
async function countConversationIndexed(counts, conversationId, harness, storage) {
	const known = countedConversations.get(conversationId);
	const row = counts.get(conversationId);
	const count = row?.count ?? known?.count ?? 0;
	const maxId = Number(row?.maxId ?? known?.newestId ?? 0);
	const moved = known === undefined || maxId > Number(known.newestId ?? 0);
	let newest = known?.newest;
	if (moved) {
		const page = await harness.readOnLine(() => storage.scanEntries({ conversationId }, 1, undefined, CTX));
		newest = page.items[0] ?? newest;
	}
	let cwd = known?.cwd;
	// A conversation whose cwd is missing or still the daemon's home may have been re-homed
	// by the import's repair pass since the last listing — its agent document is re-read
	// until a real project cwd stands, so the panel picks the repair up at once.
	if (moved || cwd === undefined || cwd === os.homedir()) {
		try {
			cwd = (await harness.snapshot(AgentDoc, conversationId, CTX))?.cwd;
		} catch {
			cwd = known?.cwd;
		}
	}
	const counted = { count, newestId: maxId, newest, cwd };
	countedConversations.set(conversationId, counted);
	return counted;
}

/**
 * Per-conversation counts, remembered between listings.
 *
 * The count is what the editor's sessions panel reads to decide whether a conversation's
 * transcript changed, and recomputing it meant walking EVERY entry of EVERY conversation
 * on EVERY listing — with a grown database, the listing itself was the slowness the owner
 * could feel. Entries carry session-assigned integers in insertion order, so the storage
 * answers "what arrived after entry N" with one indexed read: a listing only reads what
 * is new since the last one, and an unmoved conversation costs a cached lookup.
 */
const countedConversations = new Map();

async function countConversation(harness, storage, conversationId) {
	const known = countedConversations.get(conversationId);
	let count;
	let newest;
	let newestId;
	if (known === undefined) {
		// First sighting since the daemon started: one full walk, then remembered. One page
		// of 1000 would freeze the count (and with it the panel's change digest) once a
		// conversation grew past that page, so the walk keeps paging.
		count = 0;
		newestId = 0;
		let entriesCursor;
		for (;;) {
			const page = await harness.readOnLine(() => storage.scanEntries({ conversationId }, 1000, entriesCursor, CTX));
			if (newest === undefined) newest = page.items[0];
			count += page.items.length;
			const leading = Number(page.items[0]?.id);
			if (Number.isFinite(leading) && leading > newestId) newestId = leading;
			entriesCursor = page.next;
			if (!entriesCursor) break;
		}
	} else {
		// The warm path: entries newer than the last one seen, by id — one indexed read
		// when nothing moved, paged only while full pages of new entries keep arriving.
		count = known.count;
		newestId = known.newestId;
		newest = known.newest;
		let cursor;
		for (;;) {
			const page = await harness.readOnLine(() => storage.scanEntries({ conversationId, minEntryId: known.newestId + 1 }, 1000, cursor, CTX));
			if (page.items.length > 0) {
				count += page.items.length;
				const leading = Number(page.items[0].id);
				if (Number.isFinite(leading) && leading > newestId) {
					newestId = leading;
					newest = page.items[0];
				}
			}
			if (page.items.length < 1000) break;
			cursor = page.next;
			if (!cursor) break;
		}
	}
	// The conversation's working directory — the project it belongs to. The editor's
	// sessions panel filters by it: a window lists its own project's conversations, not
	// every conversation the daemon ever held. Read when the conversation was first seen
	// or has grown, and also while its cwd is missing or still the daemon's home — a
	// conversation re-homed by the import's repair pass has its project picked up at the
	// very next listing. An unreadable agent document is not a row killer; the row just
	// arrives without a cwd and lands in the unfiltered bucket.
	let cwd = known?.cwd;
	if (known === undefined || count !== known.count || cwd === undefined || cwd === os.homedir()) {
		try {
			cwd = (await harness.snapshot(AgentDoc, conversationId, CTX))?.cwd;
		} catch {
			cwd = known?.cwd;
		}
	}
	const counted = { count, newestId, newest, cwd };
	countedConversations.set(conversationId, counted);
	return counted;
}

/** Concatenated text of a pi-ai assistant message (content may be a string, array, or missing). */
export function textOf(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b?.type === "text")
		.map((b) => b.text)
		.join("");
}

/**
 * Text of a transcript entry: EntryRecord.model holds the entry's model
 * messages (pi.assistant holds the AssistantMessage there); some payloads put
 * them in `data`.
 */
export function entryText(entry) {
	const messages = Array.isArray(entry?.model) ? entry.model : Array.isArray(entry?.data) ? entry.data : [];
	return messages.map((m) => textOf(m)).join(" ").trim();
}

/** The settled submission's answer, fetched by entry id from the transcript. */
export async function answerText(root, settled, context = CTX) {
	if (settled?.status !== "done") return null;
	const view = await root.viewState(context);
	const entries = view.value?.entries ?? [];
	const answerEntry = entries.find((e) => e.id === settled.answer) ?? entries.findLast((e) => e.kind === "pi.assistant");
	return answerEntry ? entryText(answerEntry) : null;
}

export const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** "entry 12 (pi.assistant)" — entry ids are session-assigned integers. */
function describeNewest(entry) {
	return entry ? `entry ${entry.id} (${entry.kind})` : "never";
}

/**
 * The project directory a conversation belongs to, read from its own transcript.
 *
 * Conversations opened before the daemon recorded each one's working directory carry the
 * daemon's home directory as their cwd, and a per-project sessions panel shows them
 * nowhere. Their project IS on record though: the editor's recorded turns open with a
 * context frame that names the workspace (`- Workspace: <path>`, an area block's
 * "this session's is <path>"). One existing directory out of that frame, home excluded.
 */
export function projectCwdFromTranscript(entries, home = os.homedir()) {
	const text = entries.map((entry) => entryText(entry)).join("\n");
	const candidates = [];
	const workspace = /^- Workspace: (.+)$/m.exec(text);
	if (workspace) candidates.push(workspace[1]);
	const sessionCwd = /this session's is (.+)$/m.exec(text);
	if (sessionCwd) candidates.push(sessionCwd[1]);
	for (const match of text.matchAll(/^- .+ — (.+)$/gm)) {
		candidates.push(match[1]);
	}
	for (const raw of candidates) {
		const candidate = raw.trim().replace(/[.`,]+$/, "").trim();
		if (candidate.length === 0 || candidate === home) continue;
		try {
			if (existsSync(candidate) && statSync(candidate).isDirectory()) {
				return candidate;
			}
		} catch {
			// A path that cannot be stat'ed is not a project; try the next candidate.
		}
	}
	return undefined;
}

/**
 * One-time repair: write the real working directory back into every conversation whose
 * agent document carries none (the daemon's home). The first user entries name the
 * project; the recovered path goes into the conversation's own agent document, where the
 * listing already reads it — no sidecar, no second source of truth. Idempotent: a
 * conversation with a project cwd is skipped, so every daemon start after the first
 * finds nothing to do.
 */
export async function backfillConversationCwds(harness, storage) {
	const home = os.homedir();
	const records = [];
	let cursor;
	for (;;) {
		const page = await harness.readOnLine(() => storage.scanConversations({}, 100, cursor, CTX));
		records.push(...page.items);
		cursor = page.next;
		if (!cursor) break;
	}
	let fixed = 0;
	for (const record of records) {
		try {
			const state = await harness.snapshot(AgentDoc, record.id, CTX);
			if (state?.cwd !== undefined && state.cwd !== home) continue;
			const page = await harness.readOnLine(() => storage.scanEntries({ conversationId: record.id, order: "ascending" }, 30, undefined, CTX));
			const project = projectCwdFromTranscript(page.items, home);
			if (project === undefined) continue;
			const conversation = await harness.conversation(record.id, CTX);
			await conversation.configure({ cwd: project }, CTX);
			fixed++;
		} catch {
			// One unrecoverable conversation must not stop the backfill; it stays where
			// it is and the next start can try again.
		}
	}
	if (fixed > 0) {
		console.error(`[daemon] backfilled the working directory of ${fixed} conversation(s) from their transcripts`);
	}
}
