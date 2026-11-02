/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The editor's own language, prepared while the setup window is open.
 *
 * The setup runs **before** the editor exists, and the editor's language is fixed when the program
 * starts, so a language chosen here cannot be applied live. What it can do is have everything
 * ready: the language pack (Microsoft's, from Open VSX) is downloaded in the background while the
 * person walks through the steps, and left in the editor's data folder with a note saying what it
 * is. The editor, on its first start, installs it and VS Code's own prompt offers the restart.
 *
 * No `vscode` import: this runs in the setup's backend process, where there is no extension host.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/** The languages PiCode translates, each with the name Microsoft gives its language pack on Open VSX. */
export const LANGUAGE_PACKS: Readonly<Record<string, string>> = {
	cs: 'cs',
	de: 'de',
	es: 'es',
	fr: 'fr',
	it: 'it',
	ja: 'ja',
	ko: 'ko',
	pl: 'pl',
	'pt-br': 'pt-BR',
	ru: 'ru',
	tr: 'tr',
	'zh-cn': 'zh-hans',
	'zh-tw': 'zh-hant',
};

/** Where, inside the editor's user data, the downloaded pack waits for the editor. */
export const LANGUAGE_FOLDER = 'picode-language';

/** The note the editor reads at its first start. */
export const PENDING_FILE = 'pending.json';

const REGISTRY = 'https://open-vsx.org/api/MS-CEINTL/vscode-language-pack-';
const REGISTRY_HOST = 'open-vsx.org';

/** What the editor needs to install the pack: which language, and the file. */
export interface PendingLanguage {
	readonly language: string;
	readonly label: string;
	readonly pack: string;
	readonly version: string;
	readonly file: string;
	/** The setup was the first run: the editor switches to the language by itself, instead of asking. */
	readonly firstRun: boolean;
}

/**
 * How the preparation ended:
 *  * `ready`: the pack is downloaded and waits for the editor's first start;
 *  * `current`: the editor already runs in that language;
 *  * `installed`: the pack is already installed, so there is nothing to fetch;
 *  * `unsupported`: no pack is known for that language (English included);
 *  * `offline`: the pack could not be fetched; the editor opens as it is.
 */
export type LanguageOutcome = 'ready' | 'current' | 'installed' | 'unsupported' | 'offline';

/** The pack name for a language code, or `undefined` when PiCode has none. */
export function languagePackOf(language: string): string | undefined {
	return Object.prototype.hasOwnProperty.call(LANGUAGE_PACKS, language) ? LANGUAGE_PACKS[language] : undefined;
}

/** The language the editor is showing, from what the main process set when it started. */
export function editorLanguage(env: NodeJS.ProcessEnv = process.env): string {
	try {
		const config = JSON.parse(env['VSCODE_NLS_CONFIG'] ?? '') as { resolvedLanguage?: unknown; userLocale?: unknown };
		const language = typeof config.resolvedLanguage === 'string' ? config.resolvedLanguage : typeof config.userLocale === 'string' ? config.userLocale : 'en';
		return language.toLowerCase();
	} catch {
		return 'en';
	}
}

/** Whether Microsoft's pack for that language is already among the installed extensions. */
export function packInstalled(extensionsPath: string | undefined, pack: string): boolean {
	if (extensionsPath === undefined || !existsSync(extensionsPath)) {
		return false;
	}
	const prefix = `ms-ceintl.vscode-language-pack-${pack.toLowerCase()}-`;
	try {
		return readdirSync(extensionsPath).some(name => name.toLowerCase().startsWith(prefix));
	} catch {
		return false;
	}
}

/** What the preparation reaches out to: two reads of the registry, replaceable in tests. */
export interface LanguageIo {
	fetchJson(url: string): Promise<unknown>;
	/** Saves the file at `url` to `destination`, whole or not at all. */
	download(url: string, destination: string): Promise<void>;
}

/** The real thing: the registry over HTTPS, a minute at most per request. */
export const registryIo: LanguageIo = {
	async fetchJson(url) {
		const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) {
			throw new Error(`the registry answered ${response.status}`);
		}
		return response.json();
	},
	async download(url, destination) {
		const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
		if (!response.ok) {
			throw new Error(`the registry answered ${response.status}`);
		}
		const bytes = Buffer.from(await response.arrayBuffer());
		// A language pack is hundreds of kilobytes: anything tiny is an error page, not a pack.
		if (bytes.length < 10_000) {
			throw new Error('the download is too small to be a language pack');
		}
		const partial = `${destination}.part`;
		writeFileSync(partial, bytes);
		renameSync(partial, destination);
	},
};

/** The registry only hands out files from its own host: anything else in its answer is not trusted. */
function fromRegistry(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' && parsed.hostname === REGISTRY_HOST;
	} catch {
		return false;
	}
}

function forget(folder: string): void {
	try {
		rmSync(folder, { recursive: true, force: true });
	} catch {
		// A folder that cannot be removed is left; the editor ignores it without a note.
	}
}

export interface PrepareInput {
	/** The setup page's language code: `es`, `pt-br`, `zh-cn`… */
	readonly language: string;
	/** The language's own name, for the editor's prompt. */
	readonly label: string;
	/** The editor's user data directory. */
	readonly userDataPath: string;
	/** The folder installed extensions live in, when known. */
	readonly extensionsPath?: string;
	/** Whether this is the installation's first setup. */
	readonly firstRun?: boolean;
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * Gets the language pack ready for the editor's first start. Never throws: an offline machine, a
 * registry that is down or a full disk end as `offline`, and the editor opens in the language it has.
 */
export async function prepareEditorLanguage(input: PrepareInput, io: LanguageIo = registryIo): Promise<LanguageOutcome> {
	const folder = path.join(input.userDataPath, LANGUAGE_FOLDER);
	const language = input.language.toLowerCase();
	const pack = languagePackOf(language);
	if (editorLanguage(input.env) === language) {
		forget(folder);
		return 'current';
	}
	if (pack === undefined) {
		return 'unsupported';
	}
	if (packInstalled(input.extensionsPath, pack)) {
		forget(folder);
		return 'installed';
	}
	try {
		const meta = await io.fetchJson(`${REGISTRY}${pack}/latest`) as { version?: unknown; files?: { download?: unknown } } | undefined;
		const version = typeof meta?.version === 'string' ? meta.version : '';
		const download = typeof meta?.files?.download === 'string' ? meta.files.download : '';
		if (!/^\d+\.\d+\.\d+$/.test(version) || !fromRegistry(download)) {
			return 'offline';
		}
		mkdirSync(folder, { recursive: true });
		const file = path.join(folder, `${pack}-${version}.vsix`);
		if (!existsSync(file)) {
			await io.download(download, file);
		}
		const pending: PendingLanguage = { language, label: input.label.slice(0, 40), pack, version, file, firstRun: input.firstRun === true };
		writeFileSync(path.join(folder, PENDING_FILE), JSON.stringify(pending));
		return 'ready';
	} catch {
		return 'offline';
	}
}
