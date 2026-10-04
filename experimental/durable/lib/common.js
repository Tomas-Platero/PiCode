// Shared setup: models + registry + harness over SQLite in .data/.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { loadOmniProvider } from "./profile.js";
import { ProofTools, SubagentExtension } from "./extensions.js";

export const CTX = BACKGROUND_CONTEXT;
export const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".data");

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

export async function openHarness({ db = process.env.PI_DURABLE_DB || "session.sqlite" } = {}) {
	const sqlitePath = dbPath(db);
	const models = createModels();
	models.setProvider(loadOmniProvider());

	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(ProofTools);
	registry.install(SubagentExtension); // brings the sleep-based tools and the subagent anchor task

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
	return { harness, models, registry, sqlitePath };
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
