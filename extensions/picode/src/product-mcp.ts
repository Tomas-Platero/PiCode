/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The MCP servers the product brings, offered to a profile once.
 *
 * Gentle AI provisions Context7 (up-to-date library documentation) for every runtime it sets
 * up, pi included. PiCode does the same through the profile's own `mcp.json`, with one rule a
 * pinned package does not have: a server is the owner's to remove. Each server is added the
 * first time a profile meets it and recorded in `product-seeds.json`; once recorded it is never
 * added again, so deleting it from the MCP page sticks.
 *
 * - A server of the same name already in the file is left exactly as it is (the owner's wins).
 * - A `mcp.json` that is there but does not parse is not touched and nothing is recorded: the
 *   next start tries again instead of overwriting what the owner may be fixing by hand.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

import { serverNames, type AddServerDraft } from './mcp-add.ts';

/** The file, inside the profile, that remembers which product servers were already offered. */
export const PRODUCT_SEEDS_FILE = 'product-seeds.json';

/**
 * What the product offers.
 *
 * A server here works **without an account** (its sign-in, when it has one, only lifts limits), so
 * its entry carries no `oauth` block — the Add Server flow writes `oauth: {}` for a remote server
 * with no headers, and that is what made the row ask for a sign-in — and the status rows count it
 * as usable (`worksWithoutSignIn`).
 */
export const PRODUCT_MCP_SERVERS: readonly AddServerDraft[] = [
	// Public endpoint, answers without sign-in (checked 2026-11-21).
	{ name: 'context7', transport: 'http', url: 'https://mcp.context7.com/mcp' },
];

/** Whether this entry is one of the product's servers that works with no account. */
export function worksWithoutSignIn(name: string, url: string): boolean {
	return PRODUCT_MCP_SERVERS.some(server => server.name === name && server.url === url);
}

function plainEntry(server: AddServerDraft): Record<string, unknown> {
	return { type: 'http', url: (server.url ?? '').trim() };
}

export interface ProductMcpResult {
	/** The new `mcp.json` text, when it changed. */
	readonly mcpText?: string;
	/** The new seeds text, when it changed. */
	readonly seedsText?: string;
	/** The servers added to `mcp.json` this time. */
	readonly added: readonly string[];
}

function parseObject(text: string | undefined): { ok: true; value: unknown } | { ok: false } {
	if (text === undefined || text.trim().length === 0) {
		return { ok: true, value: undefined };
	}
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

function seededNames(seeds: unknown): readonly string[] {
	if (typeof seeds !== 'object' || seeds === null || Array.isArray(seeds)) {
		return [];
	}
	const list = (seeds as Record<string, unknown>).mcpServers;
	return Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string') : [];
}

/**
 * The profile's `mcp.json` and seeds after offering every product server not offered before.
 * Pure: the caller reads both files and writes back whichever text comes out.
 */
export function withProductMcpServers(
	mcpText: string | undefined,
	seedsText: string | undefined,
	servers: readonly AddServerDraft[] = PRODUCT_MCP_SERVERS,
): ProductMcpResult {
	const mcp = parseObject(mcpText);
	if (!mcp.ok) {
		return { added: [] };
	}
	const seedsParsed = parseObject(seedsText);
	const seedsRoot = seedsParsed.ok && typeof seedsParsed.value === 'object' && seedsParsed.value !== null && !Array.isArray(seedsParsed.value)
		? { ...(seedsParsed.value as Record<string, unknown>) }
		: {};
	const seeded = seededNames(seedsRoot);
	const pending = servers.filter(server => !seeded.includes(server.name));
	if (pending.length === 0) {
		return { added: [] };
	}

	let file: unknown = mcp.value;
	const present = serverNames(file);
	const added: string[] = [];
	for (const server of pending) {
		if (!present.includes(server.name)) {
			const root: Record<string, unknown> = typeof file === 'object' && file !== null && !Array.isArray(file) ? { ...(file as Record<string, unknown>) } : {};
			const existing = root['mcpServers'];
			const servers: Record<string, unknown> = typeof existing === 'object' && existing !== null && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
			servers[server.name] = plainEntry(server);
			root['mcpServers'] = servers;
			file = root;
			added.push(server.name);
		}
	}
	seedsRoot.mcpServers = [...seeded, ...pending.map(server => server.name)];
	return {
		...(added.length > 0 ? { mcpText: `${JSON.stringify(file, null, 2)}\n` } : {}),
		seedsText: `${JSON.stringify(seedsRoot, null, '\t')}\n`,
		added,
	};
}
