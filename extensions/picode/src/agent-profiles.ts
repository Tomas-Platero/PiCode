/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isThinkingLevel, modelRefOf, readAgentModels, type ThinkingLevel } from './gentle-models.ts';
import { l10n } from './l10n.ts';

/**
 * Gentle AI's agent profiles: named sets of "which model each agent answers with", which
 * `/gentle:profiles` switches between in the terminal.
 *
 * The files are Gentle's own and keep Gentle's shapes, so the terminal and the editor read the same
 * thing:
 * - `<profile>/gentle-ai/profiles.json` — `{ kind, version, active?, profiles: { <name>: { <agent>:
 *   { model?, thinking?, tier? } } }, workflow?: { <name>: { orchestratorMode } } }`. `orchestrator` is a
 *   reserved key inside a profile, not an agent.
 * - `<profile>/gentle-ai/profile-fallbacks.json` — the backup models, keyed by profile.
 * - `<git common dir>/gentle-ai/profile-pin.json` (this computer only) and
 *   `<worktree>/.pi/gentle-ai/profile.json` (committed): the profile a repository's subagents use.
 *
 * Edits change only the keys they are about and keep everything else in the file, so whatever a newer
 * Gentle adds survives the editor. Applying a profile is Gentle's job (it rewrites several files and
 * rolls back on failure); see `agent-profiles-live.ts`.
 *
 * No `vscode` import, so `node --test` runs this file directly. What it says in words goes through
 * the editor's own translator.
 */

export const PROFILES_KIND = 'gentle-pi.agent_model_profiles';
const PIN_KIND = 'gentle-pi.agent_model_profile_pin';
const FALLBACKS_KIND = 'gentle-pi.profile_model_fallbacks';
/** Gentle's reserved key for the main agent inside a profile. */
export const ORCHESTRATOR = 'orchestrator';
/** Gentle's rule for a profile name. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const SAFE_AGENT = /^[A-Za-z0-9._:@/+%-]+$/;
const TIERS = ['standard', 'fast'] as const;
export type Tier = typeof TIERS[number];
export type OrchestratorMode = 'organic' | 'full-delegation';

export interface ProfileRoute {
	model?: string;
	thinking?: ThinkingLevel;
	tier?: Tier;
}

export interface AgentProfile {
	readonly name: string;
	/** Agent → route, with `orchestrator` for the main agent. */
	readonly routes: Readonly<Record<string, ProfileRoute>>;
	readonly mode: OrchestratorMode;
	/** How many backup models the profile lists, over all its agents. */
	readonly fallbacks: number;
}

export interface AgentProfilesState {
	readonly profiles: readonly AgentProfile[];
	/** The default profile: what new chats start with. */
	readonly active?: string;
	/** No profiles file yet: the one profile shown is what is in effect today, not saved as a profile. */
	readonly unsaved: boolean;
	/** The profiles file exists but could not be read; nothing can be changed until it is fixed. */
	readonly invalid: boolean;
	/** The profiles a repository asks for: this computer's pin and the committed one. */
	readonly pins: { readonly local?: string; readonly repo?: string };
	/** The folder is a repository, so a profile can be pinned to it. */
	readonly pinnable: boolean;
}

/** The name the unsaved profile and a first save use: Gentle seeds the same one. */
export const CURRENT_PROFILE = 'current';

export function profilesFile(profileDir: string): string {
	return path.join(profileDir, 'gentle-ai', 'profiles.json');
}

function fallbacksFile(profileDir: string): string {
	return path.join(profileDir, 'gentle-ai', 'profile-fallbacks.json');
}

export function isProfileName(value: unknown): value is string {
	return typeof value === 'string' && NAME.test(value) && !RESERVED_NAMES.has(value);
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Read = { readonly status: 'missing' } | { readonly status: 'invalid' } | { readonly status: 'ok'; readonly raw: Json };

function readJson(file: string): Read {
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return { status: 'missing' };
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? { status: 'ok', raw: parsed } : { status: 'invalid' };
	} catch {
		return { status: 'invalid' };
	}
}

/** Writes the file whole, through a temporary one, so a crash never leaves half a file. */
function writeJson(file: string, value: Json): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8');
	fs.renameSync(temporary, file);
}

function routeOf(value: unknown): ProfileRoute | undefined {
	if (typeof value === 'string') {
		const model = modelRefOf(value);
		return model === undefined ? undefined : { model };
	}
	if (!isRecord(value)) {
		return undefined;
	}
	const route: ProfileRoute = {};
	const model = modelRefOf(value['model']);
	if (model !== undefined) {
		route.model = model;
	}
	const thinking = isThinkingLevel(value['thinking']) ? value['thinking'] : value['effort'];
	if (isThinkingLevel(thinking)) {
		route.thinking = thinking;
	}
	if ((TIERS as readonly unknown[]).includes(value['tier'])) {
		route.tier = value['tier'] as Tier;
	}
	return route;
}

function routesOf(value: unknown): Record<string, ProfileRoute> {
	const routes: Record<string, ProfileRoute> = {};
	if (isRecord(value)) {
		for (const [agent, entry] of Object.entries(value)) {
			const route = routeOf(entry);
			if (route !== undefined && SAFE_AGENT.test(agent)) {
				routes[agent] = route;
			}
		}
	}
	return routes;
}

function modeOf(raw: Json, name: string): OrchestratorMode {
	const workflow = raw['workflow'];
	const entry = isRecord(workflow) ? workflow[name] : undefined;
	return isRecord(entry) && entry['orchestratorMode'] === 'full-delegation' ? 'full-delegation' : 'organic';
}

function fallbackCounts(profileDir: string): Map<string, number> {
	const counts = new Map<string, number>();
	const read = readJson(fallbacksFile(profileDir));
	const profiles = read.status === 'ok' ? read.raw['profiles'] : undefined;
	if (isRecord(profiles)) {
		for (const [name, chains] of Object.entries(profiles)) {
			let count = 0;
			if (isRecord(chains)) {
				for (const chain of Object.values(chains)) {
					count += Array.isArray(chain) ? chain.length : 0;
				}
			}
			counts.set(name, count);
		}
	}
	return counts;
}

/* ------------------------------------------------------------------ pins */

/** The repository a folder is in: its worktree root and the clone's shared git folder. */
export function repositoryOf(cwd: string | undefined): { readonly root: string; readonly common: string } | undefined {
	if (cwd === undefined) {
		return undefined;
	}
	for (let folder = path.resolve(cwd); ; folder = path.dirname(folder)) {
		const dotGit = path.join(folder, '.git');
		let stat: fs.Stats | undefined;
		try {
			stat = fs.statSync(dotGit);
		} catch {
			stat = undefined;
		}
		if (stat?.isDirectory()) {
			return { root: folder, common: dotGit };
		}
		if (stat?.isFile()) {
			// A linked worktree: `.git` names its own git folder, whose `commondir` names the clone's.
			try {
				const gitDir = path.resolve(folder, fs.readFileSync(dotGit, 'utf8').replace(/^gitdir:\s*/, '').trim());
				let common = gitDir;
				try {
					common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
				} catch {
					// Not a worktree's git folder: it is the clone's own.
				}
				return { root: folder, common };
			} catch {
				return undefined;
			}
		}
		if (path.dirname(folder) === folder) {
			return undefined;
		}
	}
}

export type PinSource = 'local' | 'repo';

function pinFile(repository: { readonly root: string; readonly common: string }, source: PinSource): string {
	return source === 'local'
		? path.join(repository.common, 'gentle-ai', 'profile-pin.json')
		: path.join(repository.root, '.pi', 'gentle-ai', 'profile.json');
}

function readPin(file: string): string | undefined {
	const read = readJson(file);
	if (read.status !== 'ok' || read.raw['kind'] !== PIN_KIND) {
		return undefined;
	}
	const profile = read.raw['profile'];
	return isProfileName(profile) ? profile : undefined;
}

/* ------------------------------------------------------------------ state */

export function agentProfilesState(profileDir: string, cwd?: string): AgentProfilesState {
	const repository = repositoryOf(cwd);
	const pins = repository === undefined ? {} : {
		...(readPin(pinFile(repository, 'local')) === undefined ? {} : { local: readPin(pinFile(repository, 'local')) }),
		...(readPin(pinFile(repository, 'repo')) === undefined ? {} : { repo: readPin(pinFile(repository, 'repo')) }),
	};
	const read = readJson(profilesFile(profileDir));
	if (read.status === 'invalid') {
		return { profiles: [], unsaved: false, invalid: true, pins, pinnable: repository !== undefined };
	}
	if (read.status === 'missing') {
		// What Gentle would seed: one profile holding the routing in effect.
		const models = readAgentModels(profileDir);
		const routes = models.status === 'ok' ? routesOf(models.models) : {};
		return {
			profiles: [{ name: CURRENT_PROFILE, routes, mode: 'organic', fallbacks: 0 }],
			active: CURRENT_PROFILE,
			unsaved: true,
			invalid: false,
			pins,
			pinnable: repository !== undefined,
		};
	}
	const raw = read.raw;
	const counts = fallbackCounts(profileDir);
	const stored = isRecord(raw['profiles']) ? raw['profiles'] : {};
	const profiles = Object.keys(stored)
		.filter(isProfileName)
		.sort((a, b) => a.localeCompare(b))
		.map(name => ({ name, routes: routesOf(stored[name]), mode: modeOf(raw, name), fallbacks: counts.get(name) ?? 0 }));
	const active = typeof raw['active'] === 'string' && profiles.some(profile => profile.name === raw['active']) ? raw['active'] as string : undefined;
	return { profiles, ...(active === undefined ? {} : { active }), unsaved: false, invalid: false, pins, pinnable: repository !== undefined };
}

/* ------------------------------------------------------------------ edits */

/** One edit from the settings page, the chat's chip, or an editor profile. */
export type ProfileEdit =
	| { readonly type: 'create'; readonly name: string; readonly from?: string }
	| { readonly type: 'rename'; readonly name: string; readonly to: string }
	| { readonly type: 'delete'; readonly name: string }
	| { readonly type: 'route'; readonly name: string; readonly agent: string; readonly model?: string; readonly thinking?: string; readonly tier?: string }
	| { readonly type: 'mode'; readonly name: string; readonly mode: string }
	| { readonly type: 'pin'; readonly source: PinSource; readonly name?: string }
	/** Only the default marker, for when no chat runs to let Gentle apply it (Gentle writes it too). */
	| { readonly type: 'active'; readonly name: string };

/** Why an edit was refused, in words for the person who asked. */
export class ProfileEditError extends Error { }

/** The profiles file as it stands, or the one Gentle would seed when there is none. */
function loadForEdit(profileDir: string): Json {
	const read = readJson(profilesFile(profileDir));
	if (read.status === 'invalid') {
		throw new ProfileEditError(l10n.t('The agent profiles file could not be read. Fix or delete it, then try again.'));
	}
	if (read.status === 'ok') {
		return { ...read.raw, profiles: isRecord(read.raw['profiles']) ? { ...read.raw['profiles'] } : {} };
	}
	const models = readAgentModels(profileDir);
	return {
		kind: PROFILES_KIND,
		version: 1,
		active: CURRENT_PROFILE,
		profiles: { [CURRENT_PROFILE]: models.status === 'ok' ? models.models : {} },
	};
}

function requireName(value: unknown): string {
	if (!isProfileName(value)) {
		throw new ProfileEditError(l10n.t('Use letters, numbers, dots, dashes or underscores, up to 64, starting with a letter or number.'));
	}
	return value;
}

function requireProfile(profiles: Json, name: string): Json {
	const value = profiles[name];
	if (!Object.prototype.hasOwnProperty.call(profiles, name)) {
		throw new ProfileEditError(l10n.t('There is no profile called {0}.', name));
	}
	return isRecord(value) ? { ...value } : {};
}

function pinnedNames(cwd: string | undefined): Set<string> {
	const repository = repositoryOf(cwd);
	const names = new Set<string>();
	if (repository !== undefined) {
		for (const source of ['local', 'repo'] as const) {
			const pinned = readPin(pinFile(repository, source));
			if (pinned !== undefined) {
				names.add(pinned);
			}
		}
	}
	return names;
}

function renameKey(record: unknown, from: string, to: string): unknown {
	if (!isRecord(record) || !Object.prototype.hasOwnProperty.call(record, from)) {
		return record;
	}
	const next: Json = {};
	for (const [key, value] of Object.entries(record)) {
		next[key === from ? to : key] = value;
	}
	return next;
}

function dropKey(record: unknown, key: string): unknown {
	if (!isRecord(record)) {
		return record;
	}
	const next = { ...record };
	delete next[key];
	return next;
}

/**
 * Applies one edit to Gentle's files and returns the state after it. Deleting the default profile or
 * one a repository pins is refused, as Gentle refuses it.
 */
export function editAgentProfiles(profileDir: string, cwd: string | undefined, edit: ProfileEdit): AgentProfilesState {
	if (edit.type === 'pin') {
		const repository = repositoryOf(cwd);
		if (repository === undefined) {
			throw new ProfileEditError(l10n.t('Open a folder that is a Git repository to pin a profile to it.'));
		}
		const file = pinFile(repository, edit.source);
		if (edit.name === undefined) {
			fs.rmSync(file, { force: true });
		} else {
			const name = requireName(edit.name);
			requireProfile(loadForEdit(profileDir)['profiles'] as Json, name);
			writeJson(file, { kind: PIN_KIND, version: 1, profile: name });
		}
		return agentProfilesState(profileDir, cwd);
	}

	const file = loadForEdit(profileDir);
	const profiles = file['profiles'] as Json;
	switch (edit.type) {
		case 'create': {
			const name = requireName(edit.name);
			if (Object.prototype.hasOwnProperty.call(profiles, name)) {
				throw new ProfileEditError(l10n.t('A profile called {0} already exists.', name));
			}
			const source = edit.from === undefined ? undefined : requireProfile(profiles, edit.from);
			profiles[name] = source ?? {};
			if (edit.from !== undefined && modeOf(file, edit.from) === 'full-delegation') {
				file['workflow'] = { ...(isRecord(file['workflow']) ? file['workflow'] : {}), [name]: { orchestratorMode: 'full-delegation' } };
			}
			break;
		}
		case 'rename': {
			const to = requireName(edit.to);
			requireProfile(profiles, edit.name);
			if (Object.prototype.hasOwnProperty.call(profiles, to)) {
				throw new ProfileEditError(l10n.t('A profile called {0} already exists.', to));
			}
			file['profiles'] = renameKey(profiles, edit.name, to);
			file['workflow'] = renameKey(file['workflow'], edit.name, to);
			if (file['active'] === edit.name) {
				file['active'] = to;
			}
			renameInFallbacks(profileDir, edit.name, to);
			renamePins(cwd, edit.name, to);
			break;
		}
		case 'delete': {
			requireProfile(profiles, edit.name);
			if (file['active'] === edit.name) {
				throw new ProfileEditError(l10n.t('This is the default profile. Make another one the default first.'));
			}
			if (pinnedNames(cwd).has(edit.name)) {
				throw new ProfileEditError(l10n.t('This project uses this profile. Unpin it first.'));
			}
			delete profiles[edit.name];
			file['workflow'] = dropKey(file['workflow'], edit.name);
			break;
		}
		case 'route': {
			const profile = requireProfile(profiles, edit.name);
			if (!SAFE_AGENT.test(edit.agent)) {
				throw new ProfileEditError(l10n.t('That is not an agent name.'));
			}
			const route: Json = {};
			if (edit.model !== undefined && edit.model !== '') {
				const model = modelRefOf(edit.model);
				if (model === undefined) {
					throw new ProfileEditError(l10n.t('Write the model as provider/model, without spaces.'));
				}
				route['model'] = model;
			}
			if (edit.thinking !== undefined && edit.thinking !== '') {
				if (!isThinkingLevel(edit.thinking)) {
					throw new ProfileEditError(l10n.t('That is not an effort level.'));
				}
				route['thinking'] = edit.thinking;
			}
			if (edit.tier === 'fast') {
				route['tier'] = 'fast';
			}
			profile[edit.agent] = route;
			profiles[edit.name] = profile;
			break;
		}
		case 'mode': {
			requireProfile(profiles, edit.name);
			const workflow = isRecord(file['workflow']) ? { ...file['workflow'] } : {};
			if (edit.mode === 'full-delegation') {
				workflow[edit.name] = { orchestratorMode: 'full-delegation' };
			} else if (edit.mode === 'organic') {
				// Gentle never writes the default mode.
				delete workflow[edit.name];
			} else {
				throw new ProfileEditError(l10n.t('That is not a way of working.'));
			}
			file['workflow'] = workflow;
			break;
		}
		case 'active': {
			requireProfile(profiles, edit.name);
			file['active'] = edit.name;
			break;
		}
	}
	if (isRecord(file['workflow']) && Object.keys(file['workflow']).length === 0) {
		delete file['workflow'];
	}
	writeJson(profilesFile(profileDir), file);
	return agentProfilesState(profileDir, cwd);
}

function renameInFallbacks(profileDir: string, from: string, to: string): void {
	const read = readJson(fallbacksFile(profileDir));
	if (read.status === 'ok' && read.raw['kind'] === FALLBACKS_KIND && isRecord(read.raw['profiles']) && Object.prototype.hasOwnProperty.call(read.raw['profiles'], from)) {
		writeJson(fallbacksFile(profileDir), { ...read.raw, profiles: renameKey(read.raw['profiles'], from, to) });
	}
}

function renamePins(cwd: string | undefined, from: string, to: string): void {
	const repository = repositoryOf(cwd);
	if (repository !== undefined) {
		for (const source of ['local', 'repo'] as const) {
			const file = pinFile(repository, source);
			if (readPin(file) === from) {
				writeJson(file, { kind: PIN_KIND, version: 1, profile: to });
			}
		}
	}
}

/**
 * The profile a new chat in this folder starts with and why, most specific first, the way Gentle
 * resolves it: this computer's pin, the repository's, then the default. Pins only move the
 * subagents; the main agent always follows the default.
 */
export function resolvedProfile(state: AgentProfilesState): { readonly name?: string; readonly source: 'local' | 'repo' | 'default' } {
	const known = (name: string | undefined) => name !== undefined && state.profiles.some(profile => profile.name === name);
	if (known(state.pins.local)) {
		return { name: state.pins.local, source: 'local' };
	}
	if (known(state.pins.repo)) {
		return { name: state.pins.repo, source: 'repo' };
	}
	return { ...(state.active === undefined ? {} : { name: state.active }), source: 'default' };
}
