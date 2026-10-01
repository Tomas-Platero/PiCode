/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What pi says about its own MCP servers, as the editor can show it.
 *
 * `pi mcp list --json` is pi's own answer: the state it reached for every server, the tools it found,
 * and — when it failed — the reason, which is the part nobody can guess from the outside
 * (`MCP connection closed: "no-such-command" is not recognized…`). This module reads that answer and
 * nothing else: it does not decide what a state means, so a state pi adds tomorrow still reaches the
 * screen, and it does not connect to anything.
 *
 * Everything here is pure, so the reading of pi's output can be exercised by running it — including
 * the two shapes that matter, a server that connected and one that failed.
 */

/** One server, as pi reported it. */
export interface McpServerState {
	readonly name: string;
	/** pi's own word: `connected`, `failed`, `needs-auth`… */
	readonly state: string;
	readonly tools: number;
	readonly error?: string;
}

/** What one run of `pi mcp list --json` said. */
export interface McpStateReport {
	readonly servers: readonly McpServerState[];
	/** The file-level problems, which belong to no single server: a bad entry, an unreadable file. */
	readonly errors: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One entry of pi's answer, or nothing when it is not one this module can read. */
function stateOf(entry: unknown): McpServerState | undefined {
	if (!isRecord(entry) || typeof entry['name'] !== 'string' || typeof entry['state'] !== 'string') {
		return undefined;
	}
	const error = entry['error'];
	return {
		name: entry['name'],
		state: entry['state'],
		tools: Array.isArray(entry['tools']) ? entry['tools'].length : 0,
		...(typeof error === 'string' && error.trim().length > 0 ? { error: error.trim() } : {}),
	};
}

/**
 * pi's answer, or an empty report when the output is not that answer.
 *
 * A run that printed nothing usable — a crash, a version without `--json`, a sentence on stderr — must
 * not look like "no servers": the caller decides what to say about an empty report, and this one says
 * it with no servers and no errors.
 */
export function mcpStateReport(listOutput: string): McpStateReport {
	let parsed: unknown;
	try {
		parsed = JSON.parse(listOutput);
	} catch {
		return { servers: [], errors: [] };
	}
	if (!isRecord(parsed)) {
		return { servers: [], errors: [] };
	}
	const servers = Array.isArray(parsed['servers'])
		? parsed['servers'].map(stateOf).filter((server): server is McpServerState => server !== undefined)
		: [];
	const errors = Array.isArray(parsed['errors'])
		? parsed['errors'].filter((error): error is string => typeof error === 'string')
		: [];
	return { servers, errors };
}

/** A message squashed into one line, because a notification is not a log. */
export function oneLine(text: string, max = 200): string {
	const squashed = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0).join(' · ');
	return squashed.length > max ? `${squashed.slice(0, max)}…` : squashed;
}

/**
 * The one sentence the owner reads about one server.
 *
 * pi's word is kept as it came (`connected`, `failed`, `needs-auth`), because translating it here
 * would mean inventing states this module does not know; the tool count is what makes "connected"
 * mean something, and the reason is what makes a failure actionable.
 */
export function stateSentence(server: McpServerState): string {
	const tools = server.tools === 1 ? '1 tool' : `${server.tools} tools`;
	if (server.error !== undefined) {
		return `"${server.name}": ${server.state} — ${oneLine(server.error)}`;
	}
	if (server.state === 'connected') {
		return `"${server.name}": connected, ${tools}`;
	}
	return `"${server.name}": ${server.state}`;
}
