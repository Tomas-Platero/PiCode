// Memory wiring: the durable agent's half of the memory protocol.
//
// The words are not written here. PiCode's connector writes them into the profile
// (`memory-protocol.md`) so the chat and this agent cannot drift into telling the model
// two different things about the same memory. This file only decides *when* they are shown.
//
// The rule is the same one the chat follows: the protocol appears only when `engram`
// actually connected. A durable run told to call `mem_search` with no such tool spends a
// turn learning what this process already knew.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";

/** The protocol as the connector wrote it, or `undefined` when there is nothing to read. */
export function loadMemoryProtocol(profileDir) {
	const file = join(profileDir, "memory-protocol.md");
	if (!existsSync(file)) return undefined;
	try {
		const text = readFileSync(file, "utf8").trim();
		return text === "" ? undefined : text;
	} catch {
		return undefined;
	}
}

/** Whether a settled bridge holds a connected `engram` server. */
export function memoryIsConnected(connections) {
	return (connections ?? []).some((connection) => connection.name === "engram" && connection.status === "connected");
}

/**
 * The section itself. Static text on purpose: it is decided once, when the bridge settles, so
 * the prompt is deterministic within a process and the provider's prompt cache stays warm.
 */
export function makeMemoryExtension(protocol) {
	return defineExtension({
		name: "memory",
		sections: [section("memory", () => protocol)],
	});
}
