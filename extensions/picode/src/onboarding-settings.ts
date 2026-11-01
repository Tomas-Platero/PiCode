/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ImportItem, ImportSelection } from './profile-import';

/**
 * The setup window's writes: which files, merged how, and what may never be guessed.
 *
 * Split away from `onboarding-host.ts` for one practical reason as well as a structural one: this
 * module has no runtime dependency on its neighbours, so the rules it carries — merge, never
 * replace; refuse to write over a file that could not be read; credentials only when they were
 * asked for — can be run against a throwaway directory by a test, instead of being described in
 * a comment and trusted.
 *
 * The paths are always handed in. Nothing here resolves a profile by guessing where a product is
 * installed: the main process knows, and it says.
 */

/** Where everything lives, as the main process resolved it. */
export interface SetupPaths {
	/** The distribution root: `<root>` in a pack, the repository in a dev run. */
	readonly distributionRoot: string;
	/** PiCode's own pi profile — the only write target of every command. */
	readonly profileDir: string;
	/** The editor's user data directory: `settings.json` lives under `User/` in it. */
	readonly userDataPath: string;
}

/** The environment names the main process hands a host run. */
export const HOST_ENV = {
	distributionRoot: 'PICODE_ONBOARDING_DISTRIBUTION_ROOT',
	profileDir: 'PICODE_ONBOARDING_PROFILE_DIR',
	userDataPath: 'PICODE_ONBOARDING_USER_DATA',
} as const;

/** Reads the paths out of the environment, or `undefined` when the caller forgot one. */
export function setupPathsFromEnv(env: NodeJS.ProcessEnv): SetupPaths | undefined {
	const distributionRoot = env[HOST_ENV.distributionRoot];
	const profileDir = env[HOST_ENV.profileDir];
	const userDataPath = env[HOST_ENV.userDataPath];
	if (distributionRoot === undefined || profileDir === undefined || userDataPath === undefined) {
		return undefined;
	}
	return { distributionRoot, profileDir, userDataPath };
}

/* ------------------------------------------------------------------ *
 * The editor's own settings.json — the same file the editor reads next
 * ------------------------------------------------------------------ */

/** The editor's user settings file. */
export function editorSettingsPath(paths: SetupPaths): string {
	return path.join(paths.userDataPath, 'User', 'settings.json');
}

/**
 * The editor settings, read as they are.
 *
 * JSON with comments is what the editor itself writes when a person edits the file by hand, so
 * the small subset of `//` and block comments is stripped before parsing. A file that still
 * cannot be read is reported as unreadable and **not** overwritten: the alternative is replacing
 * an owner's settings with three keys.
 */
export function readEditorSettings(paths: SetupPaths): { value: Record<string, unknown>; readable: boolean } {
	const file = editorSettingsPath(paths);
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		// No file yet on a first run: an empty settings object is exactly what it holds.
		return { value: {}, readable: true };
	}
	try {
		const value: unknown = JSON.parse(stripJsonComments(text));
		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			return { value: value as Record<string, unknown>, readable: true };
		}
		return { value: {}, readable: false };
	} catch {
		return { value: {}, readable: false };
	}
}

/**
 * Removes `//` and block comments, leaving string contents alone.
 *
 * A URL full of slashes is a string, not a comment — the two-character check is why this walks
 * the text instead of reaching for a regular expression.
 */
export function stripJsonComments(text: string): string {
	let out = '';
	let inString = false;
	let inLine = false;
	let inBlock = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		const next = text[index + 1];
		if (inLine) {
			if (char === '\n') {
				inLine = false;
				out += char;
			}
			continue;
		}
		if (inBlock) {
			if (char === '*' && next === '/') {
				inBlock = false;
				index += 1;
			}
			continue;
		}
		if (inString) {
			out += char;
			if (char === '\\') {
				out += next ?? '';
				index += 1;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
			continue;
		}
		if (char === '/' && next === '/') {
			inLine = true;
			index += 1;
			continue;
		}
		if (char === '/' && next === '*') {
			inBlock = true;
			index += 1;
			continue;
		}
		out += char;
	}
	return out;
}

/** One editor setting, when it holds text — the only shape the setup reads. */
export function readEditorSetting(paths: SetupPaths, key: string): string | undefined {
	const value = readEditorSettings(paths).value[key];
	return typeof value === 'string' ? value : undefined;
}

/**
 * Merges keys into the editor's user settings.
 *
 * Merged, never replaced: the shipped `settings.json` carries the fonts, the terminal profile and
 * the theme, and a setup that rewrote the file would take every one of them away.
 */
export function writeEditorSettings(paths: SetupPaths, patch: Record<string, unknown>): { written: boolean; reason?: string } {
	const file = editorSettingsPath(paths);
	const { value, readable } = readEditorSettings(paths);
	if (!readable) {
		return { written: false, reason: `${file} could not be read, so it was left untouched` };
	}
	const next = { ...value, ...patch };
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(next, undefined, '\t')}\n`);
	return { written: true };
}

/* ------------------------------------------------------------------ *
 * pi's own profile
 * ------------------------------------------------------------------ */

/** The profile's `settings.json`, read defensively: pi creates it on first use. */
export function readProfileSettings(paths: SetupPaths): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(readFileSync(path.join(paths.profileDir, 'settings.json'), 'utf8'));
		return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Merges keys into pi's own settings file. */
export function writeProfileSettings(paths: SetupPaths, patch: Record<string, unknown>): void {
	const file = path.join(paths.profileDir, 'settings.json');
	const settings = { ...readProfileSettings(paths), ...patch };
	mkdirSync(paths.profileDir, { recursive: true });
	writeFileSync(file, `${JSON.stringify(settings, undefined, '\t')}\n`);
}

/**
 * The editor switches the extras step may set, and nothing else.
 *
 * A whitelist, not a settings writer: the window is a page, and a page that can write any key
 * into an owner's settings is a page that can break an editor it never sees. Each key here is
 * one the product already declares and reads.
 */
export const EXTRA_SETTINGS: Readonly<Record<string, string>> = {
	mcp: 'picode.mcp.enabled',
	context: 'picode.context.attach',
	// Asks the editor to download dictation when it opens. The window itself downloads nothing: a
	// 700 MB transfer belongs where its progress can be seen and cancelled (the Status page).
	voice: 'picode.voice.downloadOnStart',
};

/** Turns the extras on or off, ignoring any key the product does not declare. */
export function setExtras(paths: SetupPaths, values: Record<string, unknown>): Record<string, boolean> {
	const patch: Record<string, unknown> = {};
	const applied: Record<string, boolean> = {};
	for (const [name, key] of Object.entries(EXTRA_SETTINGS)) {
		if (typeof values[name] === 'boolean') {
			patch[key] = values[name];
			applied[name] = values[name];
		}
	}
	if (Object.keys(patch).length > 0) {
		writeEditorSettings(paths, patch);
	}
	return applied;
}

/**
 * Asks the editor to sign in to PiCode's own account when it starts.
 *
 * The setup cannot do it here: the callback is a `picode://` URL the workbench answers, and the
 * session is a refresh token kept in secret storage that only the editor's account provider
 * writes. Duplicating that flow before the editor exists would be a second implementation of the
 * thing that must not diverge. So the window records the request and the editor honours it once.
 */
export function setAccountSignInOnStart(paths: SetupPaths): void {
	writeEditorSettings(paths, { 'picode.account.signInOnStart': true });
}

/**
 * Hands the editor the **session** the setup minted: refresh token, uid, email.
 *
 * The one-time code cannot travel: the setup already exchanged it to learn who signed in, and it is
 * single-use — handing a spent code to the editor is exactly the "already used" error. The refresh
 * token is the editor's own session, and it is what the editor stores after a normal sign-in.
 *
 * It waits in the settings file only until the editor's first start, which moves it into encrypted
 * secret storage and clears it. A secret on disk for one launch is the price of signing in before
 * the editor exists.
 */
export function setPendingSession(paths: SetupPaths, session: { refreshToken: string; uid: string; email: string }): void {
	const refreshToken = typeof session.refreshToken === 'string' ? session.refreshToken.trim() : '';
	if (refreshToken.length === 0) {
		throw new Error('there is no session to hand over');
	}
	writeEditorSettings(paths, {
		// The order itself: "the editor must be signed in with this". The editor adopts it on its
		// next start, stores it encrypted and clears every pending field.
		'picode.account.signInOnStart': false,
		'picode.account.pendingRefreshToken': refreshToken,
		'picode.account.pendingUid': typeof session.uid === 'string' ? session.uid : '',
		'picode.account.pendingEmail': typeof session.email === 'string' ? session.email : '',
		// A code left over from an earlier attempt is spent by definition.
		'picode.account.pendingCode': '',
	});
}

/** Forgets the pending session: after "sign out", nothing should be adopted. */
export function clearPendingSession(paths: SetupPaths): void {
	writeEditorSettings(paths, {
		'picode.account.pendingRefreshToken': '',
		'picode.account.pendingUid': '',
		'picode.account.pendingEmail': '',
		'picode.account.pendingCode': '',
	});
}

/**
 * Hands the editor the code the setup already obtained, so it can finish the sign-in silently.
 *
 * The window cannot mint the session itself: the token lives in the editor's secret storage. It can
 * get the code, though, and the editor trades it at start — no second browser, no second click.
 */
export function setPendingAccountCode(paths: SetupPaths, code: string): void {
	const value = typeof code === 'string' ? code.trim() : '';
	if (value.length === 0) {
		throw new Error('there is no code to hand over');
	}
	// A sign-in that just happened cancels any earlier sign-out request: the newest wish wins.
	writeEditorSettings(paths, { 'picode.account.pendingCode': value, 'picode.account.signOutOnStart': false });
}

/** Forgets the code the window obtained: nothing for the editor to redeem. */
export function clearPendingAccountCode(paths: SetupPaths): void {
	writeEditorSettings(paths, { 'picode.account.pendingCode': '' });
}

/**
 * Asks the editor to drop the PiCode session it holds when it starts.
 *
 * Same reason as the sign-in: the session is a refresh token in the editor's secret storage, and
 * this window has no business writing there. It records the request; the editor honours it once.
 */
export function setAccountSignOutOnStart(paths: SetupPaths): void {
	writeEditorSettings(paths, { 'picode.account.signOutOnStart': true });
}

/**
 * Clears the hand-over the editor has just consumed.
 *
 * Written **here**, by the connector, and not through the editor's configuration service: the
 * account keys are declared `included: false` so they never appear as rows in Settings, and that
 * same flag makes them unwritable through `configurationService.updateValue` — the editor refuses
 * with "not a registered configuration". The connector writes the file directly, which is also what
 * the setup window already does.
 */
export function clearAccountHandover(paths: SetupPaths): void {
	writeEditorSettings(paths, {
		'picode.account.pendingRefreshToken': '',
		'picode.account.pendingUid': '',
		'picode.account.pendingEmail': '',
		'picode.account.pendingCode': '',
		'picode.account.signOutOnStart': false,
		// The order to sign in at start is consumed here too: the editor reads it, acts, and asks
		// this to erase it — it cannot erase it itself (see the comment on the account keys).
		'picode.account.signInOnStart': false,
	});
}

/** Drops only the sign-out request, leaving a pending sign-in untouched. */
export function clearSignOutRequest(paths: SetupPaths): void {
	writeEditorSettings(paths, { 'picode.account.signOutOnStart': false });
}

/** Publishes who the editor is signed in as, for the setup window to read. Empty means signed out. */
export function publishAccountSession(paths: SetupPaths, email: string): void {
	writeEditorSettings(paths, { 'picode.account.sessionEmail': typeof email === 'string' ? email : '' });
}

/**
 * How much of the editor travels with a chat message.
 *
 * The same three names the product's own setting declares (`picode.context.mode`), validated
 * here rather than passed through: the window is a page, and a page that can write an arbitrary
 * value into a setting is a page that can leave the editor reading something it does not know.
 */
export const CONTEXT_MODES = ['project', 'file', 'selection'] as const;

/** The mode that will be in force after this call, after refusing anything else. */
export function setContextMode(paths: SetupPaths, mode: string): 'project' | 'file' | 'selection' {
	if (mode !== 'project' && mode !== 'file' && mode !== 'selection') {
		throw new Error('the context mode is project, file or selection');
	}
	writeEditorSettings(paths, { 'picode.context.mode': mode });
	return mode;
}

/** Applies a theme: the setting the editor reads on start, in the file it reads it from. */
export function setTheme(paths: SetupPaths, id: string): void {
	if (typeof id !== 'string' || id.trim().length === 0) {
		throw new Error('a theme needs a name');
	}
	writeEditorSettings(paths, { 'workbench.colorTheme': id.trim() });
}

/** Chooses which pi runs. The external one is only ever *chosen*, never written. */
export function setRuntime(paths: SetupPaths, runtime: string): void {
	if (runtime !== 'internal' && runtime !== 'external') {
		throw new Error('the pi is either internal or external');
	}
	writeEditorSettings(paths, { 'picode.pi.runtime': runtime });
}

/** The pi packages the profile declares (pi installs them on first use). */
export function readPackages(paths: SetupPaths): string[] {
	const declared = readProfileSettings(paths)['packages'];
	return Array.isArray(declared) ? declared.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Declares pi packages in the profile.
 *
 * Declared, not installed: pi installs what its `packages` list names the first time it loads,
 * and the editor already does the same for a profile that names one (`ensureProfilePackages`).
 * Running npm from here would need a console window, a network wait and a progress bar in a
 * window whose only job is to get somebody to their editor.
 */
export function setPackages(paths: SetupPaths, options: { add?: readonly string[]; remove?: readonly string[] }): string[] {
	const current = new Set(readPackages(paths));
	for (const name of options.remove ?? []) {
		current.delete(name);
	}
	for (const name of options.add ?? []) {
		if (typeof name === 'string' && name.trim().length > 0) {
			current.add(name.trim());
		}
	}
	writeProfileSettings(paths, { packages: [...current] });
	return [...current];
}

/** Makes a model the profile's default, and the one a new conversation opens with. */
export function setModel(paths: SetupPaths, ref: string): void {
	if (typeof ref !== 'string' || !ref.includes('/')) {
		throw new Error('a default model is provider/model');
	}
	const slash = ref.indexOf('/');
	writeProfileSettings(paths, { defaultProvider: ref.slice(0, slash), defaultModel: ref });
	// The chat resolves `chat.defaultModel` against the model's **own id** — the one the connector
	// declares as `<provider>/<model>` — not against the editor's qualified `picode/<provider>/<model>`
	// identifier. A qualified value matches nothing, and the setting then does nothing at all.
	writeEditorSettings(paths, { 'chat.defaultModel': ref });
}

/* ------------------------------------------------------------------ *
 * What the import is asked for
 * ------------------------------------------------------------------ */

/** The categories the import card offers, in the order they are copied. */
export const IMPORT_CATEGORIES: readonly ImportItem[] = ['settings', 'models', 'mcp', 'skills', 'memory', 'sessions'];

/**
 * Turns the card's ticks into the selection the copier receives.
 *
 * The two rules that matter live here rather than in the page:
 *
 * - an item that was not ticked is simply **absent** from the selection, which the copier reads
 *   as `declined` and never opens;
 * - `credentials` only ever appears when the second argument is exactly `true`. A page that
 *   forgets to pass it gets an import without logins, which is the way round this has to fail.
 */
export function buildImportSelection(chosen: readonly string[], credentials: boolean): ImportSelection {
	const selection: Record<string, boolean> = {};
	for (const item of IMPORT_CATEGORIES) {
		if (chosen.includes(item)) {
			selection[item] = true;
		}
	}
	if (credentials === true) {
		selection['credentials'] = true;
	}
	return selection as ImportSelection;
}
