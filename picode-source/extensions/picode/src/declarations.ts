/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProviderConfiguration } from './providers';

/**
 * The providers the owner declares **in the editor's own settings**.
 *
 * This is the surface the request came from: *"no quiero la ventanita de arriba, quiero añadir
 * items abajo con sus campos necesarios"*. A settings row can hold a list of lines, and that is
 * what this is — one provider per line, with its own fields, added in place with the editor's
 * own list widget. Nothing is asked in a floating window, and there is no dialog of ours
 * anywhere in the flow.
 *
 * The editor cannot render an array of *objects* as a form (measured: `arrayItemType` is only
 * derived for scalar items, and the array widget accepts strings, enums and numbers), so the
 * fields share one line instead of four boxes:
 *
 *     omni | https://endpoint.example/v1 | openai-completions | $OMNI_KEY
 *     id   |  the address                |  the dialect        |  the key (optional)
 *
 * Only the id and the address are required. The dialect defaults to the OpenAI-compatible one,
 * which is what almost every endpoint speaks, and the key may be left out when the provider
 * needs none.
 *
 * ## What a declaration is now
 *
 * The settings row that holds these is **a form**: one row per provider, with a name, an address,
 * a dialect and a key (`ProviderListSettingWidget`, in the core's settings editor), which the
 * owner asked for in place of a chain of dialogs. So the value is a list of records, and that is
 * the shape this module reads.
 *
 * The earlier shape — the same four fields in one line, `omni | <address> | openai | $KEY` — is
 * still read, because a settings file written yesterday must keep working after an update.
 *
 * ## Why this module has no `vscode` import
 *
 * Everything that decides what a value means, and everything that decides what pi's files then
 * hold, is here and is pure apart from reading and writing two files — so it can be exercised by
 * running it, without an editor in the way. What touches the editor (the settings read, the
 * provider the model list asks about) lives in `providers.ts`.
 */

/** One provider, as one line of the settings list declares it. */
export interface ProviderDeclaration {
	readonly id: string;
	readonly baseUrl: string;
	readonly api: string;
	/**
	 * The credential, in pi's own three forms: a literal, `$NAME` for an environment variable,
	 * or `!command`. Left out when the endpoint needs none.
	 *
	 * The environment-variable form is what the owner's own note recommends, and a literal is
	 * accepted because it is his file on his machine — but a literal here is a key in
	 * `settings.json`, not in the file pi keeps credentials in, so the reader is told.
	 */
	readonly key?: string;
}

/** The dialects the editor's providers speak, keyed by the short names a person would type. */
const DIALECTS: Readonly<Record<string, string>> = {
	openai: 'openai-completions',
	completions: 'openai-completions',
	'openai-completions': 'openai-completions',
	responses: 'openai-responses',
	'openai-responses': 'openai-responses',
	anthropic: 'anthropic-messages',
	messages: 'anthropic-messages',
	'anthropic-messages': 'anthropic-messages',
	google: 'google-generative-ai',
	gemini: 'google-generative-ai',
	'google-generative-ai': 'google-generative-ai',
};

/** What almost every endpoint speaks, and what a line that does not say gets. */
export const DEFAULT_DIALECT = 'openai-completions';

/** The id shape the rest of the connector builds model ids from, so it cannot carry a slash. */
function isProviderId(value: string): boolean {
	return /^[a-z0-9][a-z0-9._-]*$/i.test(value) && !value.includes('/');
}

function isAddress(value: string): boolean {
	return /^https?:\/\/\S+$/.test(value);
}

/**
 * One line of the settings list, read as a provider — or `undefined` when it does not describe
 * one.
 *
 * Tolerant by design: the fields are separated by `|` and may be written in any case, with or
 * without spaces, because this is typed by hand in a settings box. A line that cannot describe
 * a provider is skipped rather than guessed at, and the ones that can still connect.
 */
export function parseProviderDeclaration(line: string): ProviderDeclaration | undefined {
	if (typeof line !== 'string') {
		return undefined;
	}
	const fields = line.split('|').map(field => field.trim());
	const id = fields[0] ?? '';
	const baseUrl = fields[1] ?? '';
	if (!isProviderId(id) || !isAddress(baseUrl)) {
		return undefined;
	}

	const declared = (fields[2] ?? '').toLowerCase();
	const api = declared.length === 0 ? DEFAULT_DIALECT : DIALECTS[declared];
	if (api === undefined) {
		// An unknown dialect is refused rather than defaulted: silently sending one dialect to
		// an endpoint that speaks another is a 404 or a 400, which reads as "the provider is
		// broken" instead of "the line says something the field does not accept".
		return undefined;
	}

	const key = fields.slice(3).join('|').trim();
	return {
		id: id.toLowerCase(),
		baseUrl: baseUrl.replace(/\/$/, ''),
		api,
		...(key.length === 0 ? {} : { key }),
	};
}

/**
 * One row of the settings list, read as a provider — or `undefined` when it does not describe
 * one.
 *
 * Two shapes are accepted, and they mean the same thing: the record the form writes
 * (`{ id, endpoint, api, key }`) and the one-line form an older settings file may hold. A row
 * that cannot describe a provider is skipped rather than guessed at, and the ones that can still
 * connect.
 */
export function declarationFromValue(value: unknown): ProviderDeclaration | undefined {
	if (typeof value === 'string') {
		return parseProviderDeclaration(value);
	}
	if (!isRecord(value)) {
		return undefined;
	}

	const id = typeof value.id === 'string' ? value.id.trim().toLowerCase() : '';
	const baseUrl = typeof value.endpoint === 'string' ? value.endpoint.trim().replace(/\/$/, '') : '';
	if (!isProviderId(id) || !isAddress(baseUrl)) {
		return undefined;
	}

	const declared = (typeof value.api === 'string' ? value.api : '').trim().toLowerCase();
	const api = declared.length === 0 ? DEFAULT_DIALECT : DIALECTS[declared];
	if (api === undefined) {
		return undefined;
	}

	const key = typeof value.key === 'string' ? value.key.trim() : '';
	return { id, baseUrl, api, ...(key.length === 0 ? {} : { key }) };
}

/**
 * Every provider the settings row declares, in the order it declares them.
 *
 * The row is a list; anything else (a value somebody edited by hand into a shape the schema does
 * not allow) is read as "nothing declared" rather than as a crash on a settings read that happens
 * during activation.
 */
export function declarationsFromSetting(raw: unknown): ProviderDeclaration[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const declarations: ProviderDeclaration[] = [];
	const seen = new Set<string>();
	for (const value of raw) {
		const declaration = declarationFromValue(value);
		if (declaration === undefined || seen.has(declaration.id)) {
			continue;
		}
		seen.add(declaration.id);
		declarations.push(declaration);
	}
	return declarations;
}

/* ------------------------------------------------------------------ *
 * The shapes pi's own files use, and the merge that keeps every other provider
 * ------------------------------------------------------------------ */

/** One provider as pi's `models.json` declares it. */
export interface ProviderDraft {
	readonly id: string;
	readonly baseUrl: string;
	readonly api: string;
	/**
	 * Where the key is read from when it is not in `auth.json`.
	 *
	 * Only pi's own interpolations (`$NAME`, `!command`) are written here: a literal key goes to
	 * `auth.json`, the file pi keeps credentials in and the one it consults before this field.
	 * pi's documentation is explicit about the order — "Omit it when auth is provided by
	 * `/login`/`auth.json`" — so writing a literal here as well would put the same credential in
	 * two files, one of them the settings file that gets shared and synchronized.
	 */
	readonly apiKey?: string;
	/**
	 * Tells pi to send `Authorization: Bearer <key>`.
	 *
	 * Documented as the switch that makes the header appear, so a provider whose key was given
	 * sets it: without it, pi has a credential and does not present it, and the endpoint
	 * answers 401 while everything looks configured.
	 */
	readonly authHeader?: boolean;
}

/** One model as pi's `models.json` declares it. */
export interface ModelDraft {
	readonly id: string;
	readonly name?: string;
}

/**
 * A JSON object, for the two readers of values written by hand (a settings line, a file).
 *
 * Exported because `endpoint.ts` reads an endpoint's answer with the same guard: two spellings
 * of "is this an object" would be two places for it to be wrong.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `models.json` with this provider written into it, keeping every other provider.
 *
 * A merge and not a replacement: the owner may have several connected, and rewriting the file
 * from one form would silently drop the rest. An existing entry for the same id is replaced,
 * because that is what "connect this provider" means when it is already there.
 */
export function mergeModelsFile(existing: unknown, draft: ProviderDraft, models: readonly ModelDraft[]): Record<string, unknown> {
	const root = isRecord(existing) ? { ...existing } : {};
	const providers = isRecord(root.providers) ? { ...root.providers } : {};
	providers[draft.id] = {
		baseUrl: draft.baseUrl,
		api: draft.api,
		...(draft.apiKey === undefined || draft.apiKey.length === 0 ? {} : { apiKey: draft.apiKey }),
		...(draft.authHeader === true ? { authHeader: true } : {}),
		models: models.map(model => ({ id: model.id, ...(model.name === undefined ? {} : { name: model.name }) })),
	};
	root.providers = providers;
	return root;
}

/**
 * `auth.json` with this provider's key stored, keeping every other credential.
 *
 * pi's own shape for an API key: `{ "<provider>": { type: "api_key", key } }`. The key is
 * written **here** rather than in `models.json` when the owner gave one, because that is the
 * file pi keeps credentials in and the one it can rotate without touching the model list.
 */
export function authFileWith(existing: unknown, providerId: string, key: string): Record<string, unknown> {
	const root = isRecord(existing) ? { ...existing } : {};
	root[providerId] = { type: 'api_key', key };
	return root;
}

/* ------------------------------------------------------------------ *
 * The projection: what a declaration means to pi
 * ------------------------------------------------------------------ */

/** Reads one of pi's own files, treating "missing or broken" as "nothing there yet". */
function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		// A missing file is the first run; a broken one is a file somebody edited by hand, and
		// refusing to project anything because of it would leave the owner with no way back but a
		// text editor.
		return undefined;
	}
}

/** Writes one of pi's files the way pi writes them: two-space indentation and a final newline. */
function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	// `mode` is what keeps a credential out of other users' hands on a shared machine. pi does
	// the same with `auth.json`, and a copy created here has no business being wider.
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** Whether a key is one of pi's own interpolations (`$NAME`, `!command`) rather than a literal. */
function isInterpolated(key: string): boolean {
	return key.startsWith('$') || key.startsWith('!');
}

/**
 * Writes a file only when what it holds would change.
 *
 * The editor asks for its model list often — every time the picker opens — and each of those
 * asks projects the declarations again. Rewriting two files on every one of them would be
 * churn on the owner's disk for nothing, so an identical write is skipped.
 */
function writeIfChanged(file: string, value: unknown): void {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	try {
		if (fs.readFileSync(file, 'utf8') === text) {
			return;
		}
	} catch {
		// No file yet, which is the first run and not a failure.
	}
	writeJson(file, value);
}

/**
 * The declaration as pi's `models.json` entry.
 *
 * The credential is **not** written here when it is a literal: pi's documentation says to omit
 * `apiKey` when the credential lives in `auth.json`, which is where the projection puts it, and
 * `authHeader` is set so pi presents it — without that switch an endpoint answers 401 while
 * everything looks configured.
 *
 * `$NAME` and `!command` are the exception, and they stay here: they are pi's own
 * interpolations, and the file that reads them is this one.
 */
function draftFrom(id: string, baseUrl: string, api: string, key: string | undefined): ProviderDraft {
	const literal = key !== undefined && key.length > 0 && !isInterpolated(key);
	return {
		id,
		baseUrl: baseUrl.replace(/\/$/, ''),
		api,
		...(key !== undefined && key.length > 0 && isInterpolated(key) ? { apiKey: key } : {}),
		...(literal ? { authHeader: true } : {}),
	};
}

/**
 * Projects one declaration into the profile, so that **pi itself knows the provider**.
 *
 * pi reads two files: `models.json` for what a provider is and which models it has, and
 * `auth.json` for a credential. A provider the editor can list but pi cannot use would be a
 * model row that fails the moment the agent picks it — and the agent, not the editor, is what
 * runs here. Everything already in either file is kept: the profile is shared by every
 * provider the owner has.
 */
export function projectDeclaration(
	profileDir: string,
	declaration: ProviderDeclaration,
	modelIds: readonly string[],
): void {
	const modelsFile = path.join(profileDir, 'models.json');
	writeIfChanged(
		modelsFile,
		mergeModelsFile(
			readJson(modelsFile),
			draftFrom(declaration.id, declaration.baseUrl, declaration.api, declaration.key),
			modelIds.map(id => ({ id })),
		),
	);

	if (declaration.key !== undefined && declaration.key.length > 0 && !isInterpolated(declaration.key)) {
		const authFile = path.join(profileDir, 'auth.json');
		writeIfChanged(authFile, authFileWith(readJson(authFile), declaration.id, declaration.key));
	}
}

/**
 * The same projection for the provider the owner filled in the **editor's own provider form**.
 *
 * That form hands its values over at listing time (`options.configuration`), with the key read
 * back from the editor's secret storage, and they mean exactly what a declared line means: an
 * address, a dialect, a credential. Projecting both through one place keeps the two ways in
 * from drifting apart.
 */
export function projectConfiguration(
	profileDir: string,
	config: ProviderConfiguration,
	modelIds: readonly string[],
): void {
	if (config.endpoint === undefined) {
		return;
	}
	projectDeclaration(
		profileDir,
		{
			id: config.id ?? 'pi',
			baseUrl: config.endpoint,
			api: config.api ?? DEFAULT_DIALECT,
			...(config.apiKey === undefined ? {} : { key: config.apiKey }),
		},
		modelIds,
	);
}
