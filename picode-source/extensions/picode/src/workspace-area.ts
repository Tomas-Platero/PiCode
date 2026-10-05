/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The workspace area as a session sees it: its identity, and what the session is told.
 *
 * In workspace mode the chat session is a session of the **area** — every folder open in the
 * editor — not of its first folder. Two things follow, and both are decided here so they can
 * be exercised without the editor:
 *
 * - **the filing identity**: pi files a transcript under one folder per project cwd
 *   (`piProjectSlug`), so a session of the area filed under the first folder's slug would
 *   look, forever, like a session *of that folder*. `areaSessionSlug` derives a slug of the
 *   area's own — built from the whole folder list, so it is stable across window reloads and
 *   cannot collide with any single folder's slug.
 * - **the context**: the session runs in one directory (pi's SDK takes one cwd, and a shell
 *   has one working directory at a time), so what makes edits and commands land where the
 *   owner means is *information*: every root named the way the editor names it, with its
 *   path, a rule for matching a named project to its root, and the honest limit — address
 *   files by their absolute path under the right root, and make a command's own target the
 *   root it is meant for.
 *
 * Pure on purpose: no `vscode`. The chat's handler (`agent.ts`) reads the editor and calls
 * into here; the tests run these rules with real paths.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';

/** One root of the area, as the session is told about it. */
export interface AreaRoot {
	/** The name the editor shows for this folder — the name the owner says in prompts. */
	readonly name: string;
	/** The folder's absolute path on disk (as the editor holds it, even when it is not there). */
	readonly path: string;
	/** Whether the folder exists on disk right now. A missing one is named, not hidden. */
	readonly onDisk: boolean;
}

/** Characters a session-folder name keeps; everything else folds to `-`. */
function sanitizeNamePart(name: string): string {
	return name.replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * The session-filing slug of the area: `--area-<name>-<hash>--`.
 *
 * The hash covers the area's folder list, resolved and sorted, so the same folders in a
 * different open order are the same area, and two areas that merely share a workspace name
 * are not. The name keeps the folder on disk readable; the hash is what makes it the area's
 * own — pi's per-project slugs are encodings of one path (`--D--repos-Project--`), and an
 * area slug is an encoding of no path at all.
 */
export function areaSessionSlug(folders: readonly string[], areaName: string | undefined): string {
	const resolved = [...new Set(folders.map(folder => path.resolve(folder)))].sort();
	const hash = createHash('sha1').update(resolved.join('\n')).digest('hex').slice(0, 8);
	const name = sanitizeNamePart(areaName !== undefined && areaName.length > 0 ? areaName : 'area');
	return `--area-${name}-${hash}--`;
}

/** The example a context block quotes for running a command in a root other than the session's. */
function commandExample(roots: readonly AreaRoot[], sessionCwd: string): string | undefined {
	const other = roots.find(root => root.onDisk && root.path !== sessionCwd);
	return other === undefined ? undefined : `cd "${other.path}" && <command>`;
}

/**
 * What the session is told about the area, in the terms it works with.
 *
 * Three rules, stated once per message: match a named project to its root (the owner says
 * "the web" or "the bot" and means a folder, not this session's directory), address a file
 * by its absolute path under the right root, and — said honestly, because it cannot be
 * engineered away — a shell has one working directory at a time, so a command for another
 * root must carry that root as its own target.
 *
 * `undefined` when there are no roots to name: an empty block is noise, not context.
 */
export function areaContextBlock(roots: readonly AreaRoot[], sessionCwd: string): string | undefined {
	if (roots.length === 0) {
		return undefined;
	}
	const rootLines = roots.map(root =>
		`- ${root.name} — ${root.path}${root.onDisk ? '' : ' (open in the workspace but not on disk: nothing can be read from or written there)'}`);
	const example = commandExample(roots, sessionCwd);
	const commandRule = example === undefined
		? `- A shell has one working directory at a time, and this session's is ${sessionCwd}. To run a command for another root, make that root the command's own target, and say which root each command ran in.`
		: `- A shell has one working directory at a time, and this session's is ${sessionCwd}. To run a command for another root, make that root the command's own target — for example: ${example} — and say which root each command ran in.`;
	return [
		'Workspace area: this session covers every folder open in the editor, not a single project.',
		'',
		'The area\'s roots:',
		...rootLines,
		'',
		'Rules for working in the area:',
		'- When the owner names a project (a folder name, or a short name like "the web" or "the bot"), match it to one of the roots above and work in that root. Do not assume every request is about the folder this session runs in.',
		'- Address a file by its absolute path under the right root.',
		commandRule,
	].join('\n') + '\n';
}
