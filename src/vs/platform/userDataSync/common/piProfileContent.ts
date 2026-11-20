/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the agents' part of the cloud sync is made of, and how secrets are kept out of it.
 *
 * Parts: the cloud sync page shows one row per part, with its own switch. A part that is switched
 * off is left out of the merge on both sides: this computer neither sends nor takes its files, and
 * the copy in the cloud stays as it is for the other computers.
 *
 * Secrets: `models.json` (providers and models) and `mcp.json` (MCP servers) may hold keys written
 * in full. The cloud only encrypts on the server, so keys never leave the computer: they are taken
 * out before the file is compared or sent, and put back from this computer's own copy when a file
 * comes down. A value that only points at a key (an environment variable, a command) is not a
 * secret and travels as it is.
 *
 * No imports, so the rules can be tested on their own.
 */

/** The parts of the agents' sync, in the order the page lists them. */
export const PI_PROFILE_PARTS = ['agents', 'subagents', 'skills', 'agentProfiles', 'mcp', 'models', 'agentSettings', 'memory'] as const;
export type PiProfilePart = typeof PI_PROFILE_PARTS[number];

/** The setting that lists the parts switched off (`picode.sync.agentsSkip`). */
export const PI_PROFILE_SKIP_SETTING = 'picode.sync.agentsSkip';

/** The part a synced file belongs to, by its path inside the profile (`skills/x/SKILL.md`, `models.json`). */
export function piProfilePartOf(key: string): PiProfilePart {
	const top = key.split('/')[0];
	switch (top) {
		case 'subagents':
		case 'subagents.json':
			return 'subagents';
		case 'skills':
			return 'skills';
		case 'mcp.json':
		case 'mcp-adapter.json':
			return 'mcp';
		case 'models.json':
			return 'models';
		case 'settings.json':
		case 'trust.json':
			return 'agentSettings';
		case 'memory':
			return 'memory';
		case 'gentle-ai':
			return key === 'gentle-ai/persona.json' || key === 'gentle-ai/permission-mode.json' ? 'agentSettings' : 'agentProfiles';
		default:
			// `agents`, `chains`, `specpi`: the agents and what they run.
			return 'agents';
	}
}

/** The parts switched off, read from the setting's raw value; anything unknown is ignored. */
export function skippedPiProfileParts(value: unknown): Set<PiProfilePart> {
	const parts = new Set<PiProfilePart>();
	if (Array.isArray(value)) {
		for (const item of value) {
			if ((PI_PROFILE_PARTS as readonly unknown[]).includes(item)) {
				parts.add(item as PiProfilePart);
			}
		}
	}
	return parts;
}

type Json = { [key: string]: unknown };

/**
 * Where the keys of each file live: the container of each entry (a provider, a server) and the
 * fields of that container that can hold a key.
 */
const SECRET_FILES: Record<string, { readonly root: string; readonly fields: readonly string[]; readonly maps: readonly string[] }> = {
	'models.json': { root: 'providers', fields: ['apiKey'], maps: ['headers'] },
	'mcp.json': { root: 'mcpServers', fields: ['apiKey', 'token', 'bearerToken'], maps: ['env', 'headers', 'oauth'] },
};

/** Whether a file of the profile can carry keys and goes through `scrubSecrets` / `restoreSecrets`. */
export function hasSecrets(key: string): boolean {
	return Object.prototype.hasOwnProperty.call(SECRET_FILES, key);
}

/**
 * Whether a value only points at a key instead of holding it: an environment variable (`OMNI_KEY`,
 * `$OMNI_KEY`, `${OMNI_KEY}`, `${env:OMNI_KEY}`), a command that prints it (`!op read …`), or an
 * auth scheme around such a reference (`Bearer ${GITHUB_TOKEN}`). Empty values say nothing either.
 * A bare upper-case word counts as a variable name only with an underscore or when short: a long
 * one without (`AKIAIOSFODNN7EXAMPLE`) is how some keys look.
 */
export function isSecretReference(value: unknown): boolean {
	if (typeof value !== 'string') {
		return true;
	}
	const text = value.trim();
	if (text === '' || text.startsWith('!') || (/^[A-Z][A-Z0-9_]*$/.test(text) && (text.includes('_') || text.length < 16))) {
		return true;
	}
	const rest = text.replace(/\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, '');
	return rest !== text && /^\s*(?:Bearer|Basic|Token)?\s*$/i.test(rest);
}

function isJson(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parse(text: string): Json | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return isJson(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function serialize(value: Json): string {
	return JSON.stringify(value, null, 2) + '\n';
}

/** Calls `visit` for every place a key can sit: the container, the object holding the field, and the field. */
function forEachSecretSlot(key: string, json: Json, visit: (entry: string, holder: Json, path: string, field: string) => void): void {
	const spec = SECRET_FILES[key];
	const root = json[spec.root];
	if (!isJson(root)) {
		return;
	}
	for (const [entry, value] of Object.entries(root)) {
		if (!isJson(value)) {
			continue;
		}
		for (const field of spec.fields) {
			visit(entry, value, '', field);
		}
		for (const map of spec.maps) {
			const holder = value[map];
			if (isJson(holder)) {
				for (const field of Object.keys(holder)) {
					visit(entry, holder, map, field);
				}
			}
		}
	}
}

/**
 * The file as it may leave this computer: every key written in full is taken out. Returns
 * `undefined` when the file cannot be read as JSON, so it is not sent at all rather than sent whole.
 */
export function scrubSecrets(key: string, text: string): string | undefined {
	const json = parse(text);
	if (!json) {
		return undefined;
	}
	forEachSecretSlot(key, json, (_entry, holder, _path, field) => {
		if (Object.prototype.hasOwnProperty.call(holder, field) && !isSecretReference(holder[field])) {
			delete holder[field];
		}
	});
	return serialize(json);
}

/**
 * The file that came down, with this computer's own keys put back: for each provider or server it
 * still has, a key this computer holds is restored where the incoming file has none. A key is never
 * taken from the cloud, so a computer that never had one keeps asking for it.
 */
export function restoreSecrets(key: string, incoming: string, local: string | undefined): string {
	const json = parse(incoming);
	const own = local === undefined ? undefined : parse(local);
	if (!json || !own) {
		return incoming;
	}
	const kept = new Map<string, unknown>();
	forEachSecretSlot(key, own, (entry, holder, path, field) => {
		if (Object.prototype.hasOwnProperty.call(holder, field) && !isSecretReference(holder[field])) {
			kept.set(JSON.stringify([entry, path, field]), holder[field]);
		}
	});
	if (kept.size === 0) {
		return incoming;
	}
	const spec = SECRET_FILES[key];
	const root = json[spec.root];
	if (!isJson(root)) {
		return incoming;
	}
	for (const [slot, value] of kept) {
		const [entry, path, field] = JSON.parse(slot) as [string, string, string];
		const container = root[entry];
		if (!isJson(container)) {
			continue;
		}
		let holder: Json;
		if (path === '') {
			holder = container;
		} else {
			const existing = container[path];
			holder = isJson(existing) ? existing : (container[path] = {}) as Json;
		}
		if (!Object.prototype.hasOwnProperty.call(holder, field)) {
			holder[field] = value;
		}
	}
	return serialize(json);
}
