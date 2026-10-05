/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { externalSdkEntry } from './piLocate';
import { sdkCandidates } from './piSdk';
import { areaSessionSlug } from './workspace-area';

/**
 * Which pi runs as the editor's agent, and whose configuration it uses.
 *
 * One question, one answer. The internal pi is PiCode's own: the program pinned under
 * `resources/pi-runtime` and the profile inside the distribution (`data/pi-agent`), both
 * written only by PiCode. The external pi is the one on the machine's PATH with its own
 * profile (pi resolves `~/.pi/agent` by itself): PiCode **reads** it and never writes to it,
 * so everything PiCode projects for pi — providers, MCP servers, credentials — keeps living
 * in PiCode's own profile regardless of this choice.
 *
 * The answer is consumed in exactly two shapes:
 *
 * - `sdkEntryCandidates()` — where the SDK is loaded from. The empty list in external mode
 *   means "there is no pi on this machine's PATH", and the loader says so instead of
 *   silently falling back to the internal one.
 * - `chatAgentDir()` — the `agentDir` the chat's sessions run against. `undefined` in
 *   external mode is deliberate: it means "do not set the directory", so pi resolves its own
 *   default exactly as it does from a terminal.
 */

/** The runtime modes the wizard and the setting offer. */
export type PiRuntimeMode = 'internal' | 'external';

/** The setting the choice is stored in. */
export const PICODE_RUNTIME_SETTING = 'picode.pi.runtime';

/** The project scope the chat works in: one folder, or the workspace area. */
export type PiProjectMode = 'auto' | 'workspace' | 'folder';

/** The setting the choice is stored in. */
export const PICODE_PROJECT_MODE_SETTING = 'picode.pi.projectMode';

/** One root of the area, named the way the editor shows it to the owner. */
export interface PiProjectRoot {
	/** The folder's name in the editor — what the owner says in prompts ("the bot"). */
	readonly name: string;
	/** The folder's absolute path, even when the folder is not on disk. */
	readonly path: string;
}

/** The area's own identity, present only in workspace mode. */
export interface PiAreaIdentity {
	/** The area's name, as the editor names the window (the workspace file, or the folder). */
	readonly name: string;
	/** The session-filing slug of the whole area (see `areaSessionSlug`). */
	readonly slug: string;
}

/** Where pi runs and what it is told about, resolved from the setting and the open folders. */
export interface PiProjectScope {
	/** The mode in force, with `auto` already resolved against the open folders. */
	readonly mode: 'folder' | 'workspace';
	/** The folder pi runs in: the workspace's first. `undefined` when no folder is open. */
	readonly cwd: string | undefined;
	/** Every folder the mode covers, in the editor's own order. */
	readonly folders: readonly string[];
	/** The area's roots, named as the editor shows them. Empty in folder mode. */
	readonly roots: readonly PiProjectRoot[];
	/** The area's own identity for filing and listing. `undefined` in folder mode. */
	readonly area: PiAreaIdentity | undefined;
}

/** Reads the owner's project-scope choice, as stored. Anything unrecognised means `auto`. */
export function readProjectMode(): PiProjectMode {
	// The root configuration with the FULL key, for the same reason `readRuntimeMode` does:
	// the constant is the registered setting's name, and a section configuration would
	// prepend `picode` again, landing on a key nobody registered.
	const configured = vscode.workspace.getConfiguration().get<string>(PICODE_PROJECT_MODE_SETTING);
	return configured === 'workspace' || configured === 'folder' ? configured : 'auto';
}

/**
 * Resolves the setting against the workspace as it is open right now.
 *
 * pi's SDK takes one working directory, so the mode never changes where pi runs — the
 * workspace's first folder is the base either way. What the mode changes is what pi
 * **is and is told**: in `workspace` mode the session is a session of the **area** —
 * it files under an identity of the area's own (`area`), and the context names every
 * root (`roots`) so "the bot" or "the web" resolves to a folder without asking — while
 * `folder` mode keeps the first folder alone: one project, its own sessions, no area.
 * `auto` follows how the window is open — one folder is that folder, several folders are
 * the area. A saved `.code-workspace` adds nothing to the decision: it is the folder
 * count that says how wide the window is.
 */
export function resolveProjectScope(): PiProjectScope {
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	const folders = workspaceFolders.map(folder => folder.uri.fsPath);
	const mode = readProjectMode();
	const workspace = mode === 'workspace' || (mode === 'auto' && folders.length > 1);
	if (!workspace) {
		return { mode: 'folder', cwd: folders[0], folders: folders.slice(0, 1), roots: [], area: undefined };
	}
	// The area's name is the one the editor already shows the owner: the workspace file's
	// name for a saved area, the folder's name for a window opened on folders alone.
	const name = vscode.workspace.name ?? (folders[0] === undefined ? 'area' : path.basename(folders[0]));
	return {
		mode: 'workspace',
		cwd: folders[0],
		folders,
		roots: workspaceFolders.map(folder => ({ name: folder.name, path: folder.uri.fsPath })),
		area: { name, slug: areaSessionSlug(folders, name) },
	};
}

/** The mode in force. Anything unrecognised means the internal pi. */
export function readRuntimeMode(): PiRuntimeMode {
	// The root configuration with the FULL key: this constant is the registered setting's
	// name (`picode.pi.runtime`), and a section configuration would prepend `picode` again,
	// landing on a key nobody registered — which reads as "internal" forever.
	const configured = vscode.workspace.getConfiguration().get<string>(PICODE_RUNTIME_SETTING);
	return configured === 'external' ? 'external' : 'internal';
}

/** PiCode's own profile, inside the distribution. Every PiCode write lands here. */
export function internalProfileDir(distributionRoot: string): string {
	return path.join(distributionRoot, 'data', 'pi-agent');
}

/** Where the SDK is loaded from, for the mode in force. */
export function sdkEntryCandidates(distributionRoot: string): string[] {
	if (readRuntimeMode() === 'external') {
		const entry = externalSdkEntry();
		return entry === undefined ? [] : [entry];
	}
	return sdkCandidates(distributionRoot);
}

/**
 * The profile the chat's pi sessions run against.
 *
 * The internal profile when the internal pi runs; `undefined` for the external one, which
 * is not a gap but the instruction to let pi use its own directory.
 */
export function chatAgentDir(distributionRoot: string): string | undefined {
	return readRuntimeMode() === 'internal' ? internalProfileDir(distributionRoot) : undefined;
}
