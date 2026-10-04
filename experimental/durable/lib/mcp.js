// lib/mcp.js — the MCP bridge.
//
// pi gets most of its reach from MCP servers, and durable ships no MCP client at all, so
// this is the widest of the gaps. It reads the owner's real `mcp.json` (read-only),
// connects with **pi's own MCP library** (`@earendil-works/pi-mcp`, the same one the CLI
// uses, so the transports behave the way the owner already lives with) and registers every
// server tool as a durable tool named `mcp__<server>__<tool>`.
//
// ## The size problem, and why the tools are deferred
//
// The profile carries eleven servers and two of them alone hold more than a hundred tools.
// Declaring them all would put every one of their schemas in every request. Durable has a
// mechanism for exactly this (spec 7.3): a conversation may carry a `tools` **filter**, and
// a tool result may ask for names through `control.addTools`, which the generation's tools
// phase adds to that filter — they are offered from the next preparation on.
//
// So the conversation starts with `tools: { remove: [<every MCP tool>] }`: everything
// except the MCP tools is offered, plus `mcp_tools`, which is the only MCP-shaped thing in
// the prompt. The model searches with it and the matches become callable. `mcpPromptCost()`
// reports both numbers, so the saving is measured rather than asserted.
//
// ## Replay
//
// Durable's `replay` policy decides what happens to a call that was interrupted by a crash.
// `"safe"` reruns it; the default (`"unsafe"`) does not, and the model is told the call was
// interrupted. A read-only MCP tool is safe to rerun; anything else must not be silently
// executed twice, so it keeps the default. The server's own `readOnlyHint` annotation is
// what decides, and a server that does not annotate its tools gets the cautious treatment.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { AgentDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { McpClient, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";

/** The one MCP-shaped tool that is always offered; everything else waits to be found. */
export const DISCOVERY_TOOL = "mcp_tools";

/** How many matches one search may make callable: a search must not pull in a whole server. */
const MAX_ADD = 12;

/** How long a server has to answer before its connection is given up on. */
const CONNECT_TIMEOUT_MS = 20_000;

const DISCOVERY_DESCRIPTION =
	"Find MCP tools that are not loaded yet. MCP tools are not all in the prompt: search here with what you want to do, " +
	"and the matching tools become callable on your next turn. Omit `query` and `server` to see which servers exist.";

/**
 * A tool's durable name, following pi's own rule: everything that is not a letter, a digit
 * or `_` becomes `_`, so `mcp__dev-radius__search` and `mcp__dev_radius__search` are the
 * same name and cannot collide.
 */
export function mcpToolName(server, tool) {
	return `mcp__${String(server).replace(/[^A-Za-z0-9_]/g, "_")}__${String(tool).replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/**
 * `${VAR}` from the environment, which is what pi's own config expands. An unset variable
 * becomes the empty string, as it does there. A leading `!command` value — the other thing
 * pi expands — is deliberately left alone: running a shell command to build a credential is
 * not something this experiment should do behind the owner's back.
 */
export function expand(value) {
	if (typeof value !== "string") {
		return value;
	}
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => process.env[name] ?? "");
}

function expandMap(map) {
	const out = {};
	for (const [key, value] of Object.entries(map ?? {})) {
		out[key] = expand(String(value));
	}
	return out;
}

/**
 * The servers the owner configured: the profile's `mcp.json`, plus the project's
 * `.pi/mcp.json` when there is one. A project entry with the same name overrides the user
 * one, which is pi's own rule. Disabled servers are dropped here, so the rest of this file
 * never has to ask whether a server is meant to run.
 */
export function loadMcpConfig(profileDir, cwd = process.cwd()) {
	const servers = new Map();
	const sources = [];
	const read = (file, label) => {
		if (!existsSync(file)) {
			return;
		}
		let parsed;
		try {
			parsed = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			sources.push(`${label} (unreadable: ${error instanceof Error ? error.message : String(error)})`);
			return;
		}
		const entries = parsed?.mcpServers;
		if (!entries || typeof entries !== "object") {
			return;
		}
		for (const [name, entry] of Object.entries(entries)) {
			if (!entry || typeof entry !== "object") {
				continue;
			}
			servers.set(name, { ...(servers.get(name) ?? {}), ...entry });
		}
		sources.push(label);
	};
	read(join(profileDir, "mcp.json"), "profile mcp.json");
	read(join(cwd, ".pi", "mcp.json"), "project .pi/mcp.json");
	for (const [name, entry] of [...servers]) {
		if (entry.enabled === false) {
			servers.delete(name);
		}
	}
	return { servers, sources };
}

/**
 * Connects every server, in configuration order. One that cannot connect does not stop the
 * others: it is kept in the list with its error, because "this server is down" and "this
 * server is not configured" are different facts and the owner should see the first one.
 *
 * Servers that need OAuth fail here with pi-mcp's `McpAuthRequiredError`; the tokens the
 * owner already has live in the profile and are read by pi-mcp's own auth provider, which
 * this experiment does not wire up yet. That is reported, not hidden.
 */
export async function connectMcpServers(servers, { timeoutMs = CONNECT_TIMEOUT_MS, cwd = process.cwd() } = {}) {
	const connections = [];
	for (const [name, entry] of servers) {
		const connection = { name, entry, status: "failed", tools: [], error: undefined, client: undefined };
		connections.push(connection);
		try {
			const transport = entry.url
				? new StreamableHttpTransport({ url: entry.url, headers: expandMap(entry.headers) })
				: new StdioTransport({
					command: expand(entry.command),
					args: (entry.args ?? []).map(expand),
					cwd: entry.cwd ? expand(entry.cwd) : cwd,
					// The server's own PATH and variables, plus whatever the entry adds.
					env: { ...process.env, ...expandMap(entry.env) },
					onStderr: () => undefined,
				});
			const client = new McpClient({ name: "picode-durable-experiment", version: "0.1.0", requestTimeoutMs: timeoutMs });
			await client.connect(transport);
			connection.client = client;
			connection.tools = await client.listTools({ timeoutMs });
			connection.status = "connected";
		} catch (error) {
			connection.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			await closeMcpConnection(connection);
		}
	}
	return connections;
}

async function closeMcpConnection(connection) {
	const client = connection.client;
	connection.client = undefined;
	try {
		await client?.close();
	} catch {
		// Already gone: closing a connection that failed is allowed to fail.
	}
}

/** Every tool of every connected server, with the name the model will call it by. */
export function connectedMcpTools(connections) {
	const rows = [];
	for (const connection of connections) {
		if (connection.status !== "connected") {
			continue;
		}
		for (const tool of connection.tools) {
			rows.push({ connection, tool, fullName: mcpToolName(connection.name, tool.name) });
		}
	}
	return rows;
}

/**
 * The conversation's tools filter: every MCP tool is taken out, so the prompt carries the
 * discovery tool instead of three hundred schemas. `undefined` when there is nothing to
 * remove, because an empty `remove` list would say the same thing with more noise.
 *
 * ## Why these are `{ name }` objects and not plain strings
 *
 * `AgentState.tools` is documented — spec and types both — as `string[]` (`{ remove: string[] }`),
 * and it is: that is what gets STORED. But the runtime's `applyChange` runs the incoming list
 * through `names()`, which is `items.map((item) => item.name)` because that same helper also
 * serves `extensions`, where the items really are objects. A list of strings therefore becomes
 * `[undefined, …]`, and chord refuses the commit with "Value contains a non-JSON undefined".
 * Passing `{ name }` objects survives `names()` and is stored as the documented string list,
 * which is what the resolve path then compares against tool names. A trap worth writing down:
 * the error names neither `tools` nor the agent document.
 */
export function mcpRemoveFilter(connections) {
	const names = connectedMcpTools(connections).map(row => row.fullName);
	return names.length > 0 ? { remove: names.map(name => ({ name })) } : undefined;
}

/** What the tools cost the prompt either way, in bytes, so the deferral is not a claim. */
export function mcpPromptCost(connections) {
	const rows = connectedMcpTools(connections);
	const declaredBytes = rows.reduce((total, row) => total + JSON.stringify({
		name: row.fullName,
		description: row.tool.description ?? "",
		parameters: row.tool.inputSchema ?? {},
	}).length, 0);
	const discoveryBytes = JSON.stringify({
		name: DISCOVERY_TOOL,
		description: DISCOVERY_DESCRIPTION,
		parameters: { type: "object", properties: { query: { type: "string" }, server: { type: "string" } } },
	}).length;
	return {
		toolCount: rows.length,
		serverCount: connections.filter(connection => connection.status === "connected").length,
		declaredBytes,
		deferredBytes: discoveryBytes + renderMcpSection(connections).length,
	};
}

/** All query words must appear, the way a search box reads. No query lists the matches. */
function searchCatalog(rows, { query, server } = {}) {
	const byServer = server === undefined ? rows : rows.filter(row => row.connection.name === server);
	const words = String(query ?? "").toLowerCase().split(/\s+/).filter(word => word.length > 0);
	if (words.length === 0) {
		return byServer;
	}
	return byServer.filter(row => {
		const haystack = `${row.fullName} ${row.tool.description ?? ""}`.toLowerCase();
		return words.every(word => haystack.includes(word));
	});
}

function renderMatches(rows, added) {
	const lines = [];
	let lastServer;
	for (const row of rows) {
		if (row.connection.name !== lastServer) {
			lastServer = row.connection.name;
			lines.push(`${lastServer} (${row.connection.status}):`);
		}
		lines.push(`  ${row.fullName} — ${(row.tool.description ?? "").split("\n")[0]}`);
	}
	if (added.length > 0) {
		lines.push("", `${added.length} of them are callable from your next turn: ${added.join(", ")}`);
	} else {
		lines.push("", "Nothing became callable: search with different words.");
	}
	return lines.join("\n");
}

function describeConnection(connection) {
	if (connection.status === "connected") {
		return `- ${connection.name}: ${connection.tools.length} tools`;
	}
	return `- ${connection.name}: NOT CONNECTED (${connection.error})`;
}

function renderMcpSection(connections) {
	if (connections.length === 0) {
		return undefined;
	}
	return [
		"MCP servers, bridged from the owner's own configuration:",
		...connections.map(describeConnection),
		`Their tools are not all loaded: call ${DISCOVERY_TOOL} to search for the ones you need.`,
	].join("\n");
}

/**
 * The schema the harness validates the call against. MCP hands over JSON Schema, and
 * TypeBox is a JSON Schema with types, so it is passed through — minus `$schema`, which is
 * about documents rather than validation. A tool that declares no object schema gets an
 * empty one, which validates any call and lets the server do its own complaining.
 */
function parametersFor(tool) {
	const schema = tool.inputSchema;
	if (!schema || typeof schema !== "object" || schema.type !== "object") {
		return Type.Object({});
	}
	const rest = { ...schema };
	delete rest.$schema;
	return rest;
}

/**
 * MCP's content blocks as the ones the harness stores. Text and images map straight across;
 * anything else (audio, a resource link, an embedded blob) becomes a line of text naming
 * what it was, so a block the harness cannot carry is still visible to the model.
 */
function toContent(result) {
	const blocks = [];
	for (const block of result?.content ?? []) {
		if (block?.type === "text" && typeof block.text === "string") {
			blocks.push({ type: "text", text: block.text });
		} else if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
		} else {
			blocks.push({ type: "text", text: `[${block?.type ?? "unknown"} content the harness does not carry]` });
		}
	}
	if (blocks.length === 0 && result?.structuredContent !== undefined) {
		blocks.push({ type: "text", text: JSON.stringify(result.structuredContent) });
	}
	return blocks;
}

function mcpTool({ connection, tool, fullName }) {
	// The server's own annotation decides, and only a positive one. A tool that does not say
	// it is read-only keeps the cautious default: it is not re-run behind the owner's back.
	const readOnly = tool.annotations?.readOnlyHint === true;
	return defineTool({
		name: fullName,
		description: `[${connection.name}] ${tool.description ?? tool.name}`,
		parameters: parametersFor(tool),
		// Said outright rather than spread conditionally: the spec's default IS "unsafe", and a
		// reader should not have to know that to see which way this tool went.
		replay: readOnly ? "safe" : "unsafe",
		execute: async (args) => {
			try {
				const result = await connection.client.callTool(tool.name, args ?? {});
				return { content: toContent(result), isError: result?.isError === true };
			} catch (error) {
				return {
					content: [{ type: "text", text: `MCP call failed: ${error instanceof Error ? error.message : String(error)}` }],
					isError: true,
				};
			}
		},
	});
}

/**
 * The bridge as one extension: every tool of every connected server, the discovery tool,
 * and the short section that tells the model the servers exist. Install it in the registry;
 * the conversation is what keeps the tools out of the prompt, through `mcpRemoveFilter`.
 */
export function makeMcpExtension(connections, { maxAdd = MAX_ADD } = {}) {
	const catalog = connectedMcpTools(connections);

	const discovery = defineTool({
		name: DISCOVERY_TOOL,
		description: DISCOVERY_DESCRIPTION,
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "What you want to do, in words. All words must match." })),
			server: Type.Optional(Type.String({ description: "Limit the search to one server by name." })),
		}),
		// A search touches nothing outside the process, so it is always safe to rerun.
		replay: "safe",
		execute: async (args) => {
			const matches = searchCatalog(catalog, args ?? {});
			if (matches.length === 0) {
				return {
					content: [{
						type: "text",
						text: catalog.length === 0
							? "No MCP server is connected, so there are no MCP tools."
							: `No MCP tool matches that. ${catalog.length} tools exist across ${new Set(catalog.map(row => row.connection.name)).size} server(s).`,
					}],
				};
			}
			const added = matches.slice(0, maxAdd).map(row => row.fullName);
			return {
				content: [{ type: "text", text: renderMatches(matches, added) }],
				control: { addTools: added },
			};
		},
	});

	return defineExtension({
		name: "mcp",
		tools: [discovery, ...catalog.map(row => mcpTool(row))],
		sections: [section("mcp", () => renderMcpSection(connections))],
	});
}

/** Closes every connection. Called once, at the end of a command. */
export async function closeMcpConnections(connections) {
	for (const connection of connections) {
		await closeMcpConnection(connection);
	}
}

// --- CLI/daemon wiring: connect the profile's servers, arm the deferral ---------

export const NO_BRIDGE = { connections: [], extension: undefined, filter: undefined };

/**
 * Connects the profile's MCP servers and reports what it found, one line per server.
 *
 * The tools are registered but kept OUT of the conversation (`filter`), so what reaches the
 * prompt is the small discovery tool and not three hundred schemas. The cost line below is
 * printed for both ways round: the experiment's whole claim about size is that number.
 * Why the bridge is on or off was already printed by the [settings] lines.
 */
export async function connectBridge(enabled, profileDir) {
	if (!enabled) {
		console.error("[mcp] disabled: the agent runs without MCP tools.");
		return NO_BRIDGE;
	}
	const config = loadMcpConfig(profileDir);
	if (config.servers.size === 0) {
		console.error("[mcp] no servers configured");
		return NO_BRIDGE;
	}
	console.error(`[mcp] ${config.servers.size} server(s) configured (${config.sources.join(", ")})`);
	const connections = await connectMcpServers(config.servers);
	for (const connection of connections) {
		console.error(connection.status === "connected"
			? `[mcp] ${connection.name}: connected, ${connection.tools.length} tools`
			: `[mcp] ${connection.name}: NOT CONNECTED (${connection.error})`);
	}
	const cost = mcpPromptCost(connections);
	const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
	console.error(`[mcp] prompt cost: all ${cost.toolCount} tool(s) declared ≈ ${kib(cost.declaredBytes)}; deferred ≈ ${kib(cost.deferredBytes)}`);
	return {
		connections,
		extension: cost.toolCount > 0 ? makeMcpExtension(connections) : undefined,
		filter: mcpRemoveFilter(connections),
	};
}

/**
 * Arms the deferral on a conversation that already exists.
 *
 * Only when the conversation has no tool filter of its own: re-arming one that already
 * discovered tools would throw that discovery away and make the model search again.
 */
export async function armMcpFilter(harness, conversation, bridge, context) {
	if (!bridge.filter) return;
	const state = await harness.snapshot(AgentDoc, conversation.id, context);
	if (state?.tools == null) {
		await conversation.configure({ tools: bridge.filter }, context);
	}
}
