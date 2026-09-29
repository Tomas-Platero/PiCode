/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isInterpolated, isRecord, normalizeDialect } from './declarations';
import { NAME_PATTERN, type McpServerSetting } from './mcpServers';

/**
 * What an imported profile means to **the editor's own settings**.
 *
 * The import copies `models.json` and `mcp.json` into PiCode's own profile, and that is
 * enough for the runtime: pi reads those files and the providers and servers work from the
 * next conversation. But the Settings pages read two editor settings — `picode.providers`
 * and `picode.mcp.servers` — which are the stores the owner edits and the ones the editor
 * projects *into* pi's files. An import that only touches the profile leaves the Settings
 * pages blind to what just arrived, and the owner would see a working provider that no
 * settings row explains.
 *
 * This module reads the copied files back into the shape those settings rows hold, so the
 * import flow can add what is missing to the rows. Three rules hold throughout:
 *
 * - **Literal keys never travel.** Only pi's own interpolations (`$NAME`, `!command`) may
 *   appear in a settings row; a literal credential stays in the profile's own files
 *   (`auth.json`, or `models.json` as the import wrote it), because the editor's settings
 *   are shared and synchronized and are no place for a secret.
 * - **The owner's rows win.** An id or name the settings already declare is left exactly as
 *   it is; the import only adds what is missing.
 * - **Nothing throws.** These files were written by another machine's pi and may hold
 *   anything; an entry that cannot be read as a row is skipped, not fatal.
 *
 * No `vscode` import: the reading is pure, like `mcpServers.ts`, so it can be exercised by
 * running it.
 */

/** One provider, as the `picode.providers` settings row holds it. */
export interface ImportedProviderRow {
	readonly id: string;
	readonly endpoint: string;
	readonly api: string;
	/** Only when the entry's `apiKey` is one of pi's own interpolations. Never a literal. */
	readonly key?: string;
}

/**
 * The providers of a copied `models.json`, as settings rows.
 *
 * A provider whose entry does not read as one — no usable id, no `http(s)` address — is
 * skipped: it would not survive the settings reader anyway, and a row that cannot connect
 * is noise, not information.
 */
export function providerRowsFromModelsFile(modelsJson: unknown): ImportedProviderRow[] {
	if (!isRecord(modelsJson)) {
		return [];
	}
	const providers = modelsJson['providers'];
	if (!isRecord(providers)) {
		return [];
	}
	const rows: ImportedProviderRow[] = [];
	for (const [id, entry] of Object.entries(providers)) {
		if (!isRecord(entry)) {
			continue;
		}
		const providerId = id.trim();
		const baseUrl = typeof entry['baseUrl'] === 'string' ? entry['baseUrl'].trim() : '';
		if (providerId.length === 0 || !/^https?:\/\//.test(baseUrl)) {
			continue;
		}
		const apiKey = typeof entry['apiKey'] === 'string' ? entry['apiKey'].trim() : '';
		rows.push({
			id: providerId,
			endpoint: baseUrl.replace(/\/$/, ''),
			api: normalizeDialect(typeof entry['api'] === 'string' ? entry['api'] : undefined),
			...(apiKey.length > 0 && isInterpolated(apiKey) ? { key: apiKey } : {}),
		});
	}
	return rows;
}

/**
 * One server name, sanitized into the shape the settings row requires, or `undefined` when
 * nothing usable is left.
 *
 * A name from another machine's file is not held to a standard: characters the settings
 * pattern does not accept become `-`, and leading characters it would still refuse (a name
 * that began with a symbol) are dropped. An empty result is no name.
 */
function sanitizedServerName(raw: unknown): string | undefined {
	if (typeof raw !== 'string') {
		return undefined;
	}
	let name = raw.trim().replace(/[^a-zA-Z0-9._-]/g, '-');
	while (name.length > 0 && !/^[a-z0-9]/i.test(name)) {
		name = name.slice(1);
	}
	return name.length > 0 && NAME_PATTERN.test(name) ? name : undefined;
}

/**
 * The servers of a copied `mcp.json`, as settings rows.
 *
 * A local server (`command`) and a remote one (`type: "http"` with a `url`) are the two
 * shapes the adapter documents and the settings row can express. An `Authorization: Bearer`
 * header becomes the row's key — a header a person typed by hand; anything else there is
 * left in the file, which the adapter still reads. An entry that is neither shape, or whose
 * name cannot be made to fit, is skipped.
 */
export function mcpRowsFromMcpFile(mcpJson: unknown): McpServerSetting[] {
	if (!isRecord(mcpJson)) {
		return [];
	}
	const servers = mcpJson['mcpServers'];
	if (!isRecord(servers)) {
		return [];
	}
	const rows: McpServerSetting[] = [];
	for (const [rawName, entry] of Object.entries(servers)) {
		if (!isRecord(entry)) {
			continue;
		}
		const name = sanitizedServerName(rawName);
		if (name === undefined) {
			continue;
		}
		const command = typeof entry['command'] === 'string' ? entry['command'].trim() : '';
		if (command.length > 0) {
			const args = Array.isArray(entry['args'])
				? entry['args'].filter((piece): piece is string => typeof piece === 'string')
				: [];
			rows.push({ name, transport: 'stdio', target: command, args: args.join(' '), key: '' });
			continue;
		}
		const url = typeof entry['url'] === 'string' ? entry['url'].trim() : '';
		if (entry['type'] === 'http' && url.length > 0) {
			const headers = isRecord(entry['headers']) ? entry['headers'] : undefined;
			const authorization = typeof headers?.['Authorization'] === 'string' ? headers['Authorization'].trim() : '';
			rows.push({
				name,
				transport: 'http',
				target: url,
				args: '',
				key: authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '',
			});
		}
	}
	return rows;
}

/**
 * Both lists, as one: what the owner already has, then what the import brought.
 *
 * The rows already in the settings are the owner's own edits, and an import never clobbers
 * them: a row whose id is already declared — on either side, whichever way the owner wrote
 * it — is skipped. Rows without an id cannot be told apart and are all kept.
 */
export function mergeRowsById<T>(current: readonly T[], imported: readonly T[], idOf: (row: T) => string): T[] {
	const merged = [...current];
	const seen = new Set<string>();
	for (const row of current) {
		const id = idOf(row);
		if (id.length > 0) {
			seen.add(id);
		}
	}
	for (const row of imported) {
		const id = idOf(row);
		if (id.length === 0 || !seen.has(id)) {
			if (id.length > 0) {
				seen.add(id);
			}
			merged.push(row);
		}
	}
	return merged;
}
