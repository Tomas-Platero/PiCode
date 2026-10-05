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
// ## OAuth credentials, and why they are used READ-ONLY
//
// Remote servers whose `mcp.json` entry is a `url` need a bearer token. **PiCode's own
// profile** keeps them in a `mcp-auth.json` next to the `mcp.json` this bridge already
// reads (`data/pi-agent/mcp-auth.json`), written by that profile's own login. The
// external pi's directory is neither read nor written: the owner's rule is that `~/.pi`
// is never touched, for storing or for reading, so a sign-in that only exists there does
// not exist here, and this bridge says so instead of borrowing it.
//
// The file is read and never written. Not even a refresh: OAuth servers commonly ROTATE
// refresh tokens on use, so a refresh would invalidate whatever grant the profile holds
// whether or not the new tokens were kept. A token is sent only while it is still valid,
// and an expired or missing one fails with a line saying what is missing — and that nothing
// signs into that profile yet.
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
import { McpOAuthProvider } from "@earendil-works/pi-mcp/oauth";

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

// --- OAuth credentials pi already stored (READ-ONLY; see the file header) --------

/**
 * Where the profile in force keeps its MCP OAuth credentials: next to its own `mcp.json`.
 *
 * The profile is required, never inferred: the whole point of the parameter is that this
 * must be PiCode's own profile and never the external pi's directory. `PI_MCP_AUTH_FILE`
 * overrides the file itself, the same way `PI_AGENT_PROFILE` overrides the profile.
 */
export function mcpAuthPath(profileDir) {
	return process.env.PI_MCP_AUTH_FILE || join(profileDir, "mcp-auth.json");
}

/**
 * The key pi stores a server's OAuth state under, by pi's own rule (`mcpNamespace` +
 * `storeKeys` in pi-coding-agent): `mcp__<name with - → _>|<normalized URL>`. `legacyKey`
 * is the URL-only key older pi versions wrote; it is read for compatibility, never written.
 */
export function mcpAuthKey(name, serverUrl) {
	let urlKey;
	try {
		urlKey = String(new URL(serverUrl));
	} catch {
		// A `url` that cannot be parsed has no stored key to look up, and "no sign-in" is a
		// clearer outcome than a TypeError escaping the key builder.
		return {};
	}
	return { key: `mcp__${String(name).replace(/-/g, "_")}|${urlKey}`, legacyKey: urlKey };
}

/**
 * pi's `McpOAuthStateStore` over the profile's `mcp-auth.json`, READ-ONLY.
 *
 * Why read-only — so nobody "fixes" this into a refresh later: the file stores a refresh
 * token next to the access token, and many OAuth servers ROTATE refresh tokens on use. A
 * refresh here would hand out a new refresh token and leave the stored one dead — whether
 * or not the new tokens were kept — breaking the sign-ins that profile already has. So
 * `save()` throws instead of writing: every write path of the OAuth flow is unreachable by
 * design, and a future attempt fails loudly rather than quietly.
 */
class ReadOnlyMcpAuthStore {
	#file;
	#key;
	#legacyKey;
	constructor(file, name, serverUrl) {
		this.#file = file;
		({ key: this.#key, legacyKey: this.#legacyKey } = mcpAuthKey(name, serverUrl));
	}
	load() {
		try {
			const states = JSON.parse(readFileSync(this.#file, "utf8"));
			const state = states?.[this.#key] ?? states?.[this.#legacyKey];
			return state && typeof state === "object" ? state : undefined;
		} catch {
			// No file, or not JSON: the same fact as "no stored sign-in", not an error.
			return undefined;
		}
	}
	save() {
		throw new Error("the MCP bridge reads pi's mcp-auth.json READ-ONLY and never writes credentials");
	}
}

/**
 * The one line a person can act on. It does not point at `pi mcp login`, because that pi
 * is the external one and this bridge neither reads nor writes it: the sign-in has to be
 * in PiCode's own profile, and nothing signs in there yet.
 */
const loginAdvice = (name) => `PiCode's own profile needs a sign-in for "${name}", and nothing signs in there yet`;

/**
 * The transport's `authProvider` for one HTTP server, built ONLY from what pi already
 * stored. The stored `tokensExpireAt` decides BEFORE anything is sent: a token is used
 * only while it is still valid; an expired one fails with `loginAdvice` instead of a
 * doomed request. `McpOAuthProvider` is the library's own reader for this file format;
 * its flow is never started (`onRedirect` throws) and its `save()` throws, so nothing
 * here can write or refresh.
 *
 * Outcome `"none"` (pi has no sign-in for the server) is NOT an error here: the entry may
 * authenticate itself through configured `headers` (github does), so the caller decides.
 */
export function storedMcpAuth(name, serverUrl, { authFile, now = Date.now() } = {}) {
	if (typeof authFile !== "string" || authFile.length === 0) {
		throw new Error("storedMcpAuth needs the profile's mcp-auth.json path");
	}
	const store = new ReadOnlyMcpAuthStore(authFile, name, serverUrl);
	const provider = new McpOAuthProvider({
		serverUrl,
		// pi's own fallback redirect URL. Never used: no flow is ever started below.
		redirectUrl: "http://127.0.0.1/callback",
		clientMetadata: { client_name: "picode-durable-experiment" },
		store,
		onRedirect: () => {
			throw new Error(`stored sign-in unusable — ${loginAdvice(name)}`);
		},
	});
	const state = store.load();
	if (!state?.tokens?.access_token) {
		return { outcome: "none" };
	}
	if (state.tokensExpireAt !== undefined && state.tokensExpireAt <= now) {
		return { outcome: "expired", error: `stored sign-in expired — ${loginAdvice(name)}` };
	}
	return {
		outcome: "stored",
		authProvider: {
			// Re-read through the provider on every request, so a sign-in or refresh pi
			// performs in ANOTHER process while this bridge runs is picked up live —
			// consuming a rotation pi made is fine; making one here is not.
			token: async () => (await provider.tokens())?.access_token,
			onUnauthorized: async () => {
				throw new Error(`MCP server rejected the stored sign-in (expired or revoked) — ${loginAdvice(name)}, then restart`);
			},
		},
	};
}

/**
 * Connects every server, in configuration order. One that cannot connect does not stop the
 * others: it is kept in the list with its error, because "this server is down" and "this
 * server is not configured" are different facts and the owner should see the first one.
 *
 * An HTTP server whose OAuth state pi has stored gets that token on every request (valid
 * ones only — see `storedMcpAuth`). Without a stored sign-in there are two honest paths:
 * an entry that authenticates itself through `headers` connects as configured, and one
 * with neither fails fast with the `pi mcp login` line instead of a request that cannot
 * succeed. An expired stored sign-in always fails fast: a doomed request would say less.
 */
export async function connectMcpServers(servers, { profileDir, timeoutMs = CONNECT_TIMEOUT_MS, cwd = process.cwd(), authFile = mcpAuthPath(profileDir) } = {}) {
	const connections = [];
	for (const [name, entry] of servers) {
		const connection = { name, entry, status: "failed", tools: [], error: undefined, client: undefined };
		connections.push(connection);
		try {
			let authProvider;
			if (entry.url) {
				const stored = storedMcpAuth(name, entry.url, { authFile });
				const ownHeaders = entry.headers !== undefined
					&& Object.values(expandMap(entry.headers)).some(value => String(value).length > 0);
				if (stored.outcome === "stored") {
					authProvider = stored.authProvider;
				} else if (stored.outcome === "expired" || !ownHeaders) {
					connection.error = stored.error ?? `no stored sign-in — ${loginAdvice(name)}`;
					continue;
				}
				// outcome "none" with own headers: the entry authenticates itself; connect.
			}
			const transport = entry.url
				? new StreamableHttpTransport({ url: entry.url, headers: expandMap(entry.headers), authProvider })
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
 * A bounded ceiling for waiting on the bridge from outside it: every server connect is
 * itself bounded by CONNECT_TIMEOUT_MS and the servers are tried in order, so the whole
 * bridge settles within roughly one timeout per configured server (plus one of slack).
 * A caller that waits longer than this is not waiting for the bridge any more — it is
 * stuck, and should say so instead of holding a conversation's agent hostage.
 */
export function mcpBridgeWaitMs(profileDir, cwd = process.cwd()) {
	return (loadMcpConfig(profileDir, cwd).servers.size + 1) * CONNECT_TIMEOUT_MS;
}

/**
 * Connects the profile's MCP servers and reports what it found, one line per server.
 *
 * The tools are registered but kept OUT of the conversation (`filter`), so what reaches the
 * prompt is the small discovery tool and not three hundred schemas. The cost line below is
 * printed for both ways round: the experiment's whole claim about size is that number.
 * Why the bridge is on or off was already printed by the [settings] lines.
 */
export async function connectBridge(enabled, profileDir, { authFile = mcpAuthPath(profileDir) } = {}) {
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
	if ([...config.servers.values()].some(entry => entry.url)) {
		console.error(`[mcp] oauth credentials: READ-ONLY from ${authFile} (never written, never refreshed)`);
	}
	const connections = await connectMcpServers(config.servers, { profileDir, authFile });
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

/**
 * The startup guarantee, made rather than promised: every conversation that already exists
 * when the bridge settles and carries no tools filter of its own is armed with the deferral
 * filter BEFORE the MCP extension is installed into the registry. A conversation that came
 * into being while the bridge was connecting — through any path, not only the daemon's
 * waiting methods — therefore never sees the MCP tools offered unfiltered: by the time the
 * tools exist in the registry, its agent document already removes them. The count is
 * returned so the daemon can say what it did, and `armMcpFilter`'s rule decides per
 * conversation (only `tools == null` is touched), so a conversation that already discovered
 * tools keeps its additions.
 */
export async function armAllMcpFilters(harness, storage, bridge, context) {
	if (!bridge.filter) return 0;
	const ids = [];
	let cursor;
	for (;;) {
		const page = await harness.readOnLine(() => storage.scanConversations({}, 1000, cursor, context));
		for (const record of page.items) ids.push(record.id);
		cursor = page.cursor;
		if (!cursor) break;
	}
	let armed = 0;
	for (const id of ids) {
		try {
			const conversation = await harness.conversation(id, context);
			if (!conversation) continue;
			const state = await harness.snapshot(AgentDoc, id, context);
			if (state?.tools == null) {
				await conversation.configure({ tools: bridge.filter }, context);
				armed++;
			}
		} catch (error) {
			console.error(`[mcp] arming the deferral filter on conversation ${id} failed: ${error?.message ?? error}`);
		}
	}
	return armed;
}
