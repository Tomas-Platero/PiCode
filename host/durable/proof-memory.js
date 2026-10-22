// Proof: the durable agent gets the memory protocol, and only when engram actually connects.
//
// What it does, with nothing of the owner's touched: builds a throwaway profile that declares
// ONLY engram (a real connect, a real store), connects the bridge, and checks the three claims
// this wiring makes —
//
//   1. engram connects like any other server and its 19 tools are deferred, not dumped in the prompt;
//   2. the protocol is read from the profile, which is the file PiCode's connector writes, so the
//      chat and this agent cannot tell the model two different things;
//   3. without a protocol in the profile there is no section — memory trouble never invents rules.
//
// The store is the user's real one (~/.engram): the point is the path, not a fixture. Nothing is
// written to it: connectMcpServers only lists tools.
//
// Run: node host/durable/proof-memory.js
// Needs: an engram on PATH (or PICODE_ENGRAM=/absolute/path/to/engram).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeMcpConnections, connectBridge, mcpPromptCost } from "./lib/mcp.js";
import { loadMemoryProtocol, makeMemoryExtension, memoryIsConnected } from "./lib/memory.js";

const binary = process.env.PICODE_ENGRAM || "engram";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "picode-memory-proof-"));
fs.writeFileSync(
	path.join(profile, "mcp.json"),
	JSON.stringify({ mcpServers: { engram: { command: binary, args: ["mcp", "--tools=agent"] } } }, null, 2)
);

const STUB = "PROTOCOL UNDER TEST: search before answering, save what outlives the conversation.";

function check(what, ok) {
	console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
	if (!ok) process.exitCode = 1;
}

const settled = await connectBridge(true, profile);
try {
	const engram = settled.connections.find((connection) => connection.name === "engram");
	check(`engram connected (${engram?.status}, ${engram?.tools.length ?? 0} tools)`, engram?.status === "connected");
	check("the wiring sees it as the memory", memoryIsConnected(settled.connections) === true);

	const cost = mcpPromptCost(settled.connections);
	check(`tools are deferred, not declared (${(cost.deferredBytes / 1024).toFixed(1)} KiB)`, cost.deferredBytes < 8 * 1024);

	// No protocol file yet: no section, even though engram is connected.
	check("no protocol in the profile means no section", loadMemoryProtocol(profile) === undefined);

	fs.writeFileSync(path.join(profile, "memory-protocol.md"), STUB + "\n");
	const protocol = loadMemoryProtocol(profile);
	check("the protocol is read from the profile", protocol === STUB);

	const extension = makeMemoryExtension(protocol);
	const section = extension.sections?.find((candidate) => candidate.key === "memory");
	const rendered = await section?.render({}, {});
	check("the section renders the protocol", rendered === STUB);
	check("the sections carries the memory key, so pi tags it <memory>", section?.key === "memory");

	// The chat's own rule, mirrored: no tools, no section.
	const withoutTools = (protocolText, names) =>
		names.includes("mem_search") && names.includes("mem_save") ? protocolText : undefined;
	check("a session without the tools gets nothing to obey", withoutTools(STUB, ["read", "bash"]) === undefined);
} finally {
	await closeMcpConnections(settled.connections);
	fs.rmSync(profile, { recursive: true, force: true });
}

console.log(process.exitCode === 1 ? "\nthe memory wiring is NOT what it claims" : "\nthe memory wiring is what it claims");
