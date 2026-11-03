/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How many lines a folder's uncommitted changes add and remove — the `+N −M` the Agent layout's
 * status column shows under Changes. Tracked files come from `git diff --numstat HEAD`; new files
 * git does not track yet count every line as added, the way a commit of them would.
 */

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

export const DIFF_STAT_COMMAND = 'picode.git.diffStat';

export interface DiffStat {
	readonly added: number;
	readonly removed: number;
}

/** New files bigger than this are skipped: they are build output or data, not code to review. */
const MAX_NEW_FILE_BYTES = 2 * 1024 * 1024;

/** Sums `git diff --numstat` output; binary files (`-	-	name`) carry no line counts and are skipped. */
export function parseNumstat(text: string): DiffStat {
	let added = 0;
	let removed = 0;
	for (const line of text.split('\n')) {
		const [plus, minus] = line.split('\t');
		const a = Number(plus);
		const r = Number(minus);
		if (plus !== '' && minus !== undefined && Number.isInteger(a) && Number.isInteger(r)) {
			added += a;
			removed += r;
		}
	}
	return { added, removed };
}

/** Lines in a new file, as git would count them: a last line without a newline still counts. */
export function countLines(text: string): number {
	if (text.length === 0 || text.includes('\0')) {
		return 0; // empty, or binary
	}
	const breaks = text.split('\n').length - 1;
	return text.endsWith('\n') ? breaks : breaks + 1;
}

function git(cwd: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
	});
}

/** The folder's uncommitted `+N −M`; undefined when it is not a git repository (or git is missing). */
export async function diffStat(cwd: string): Promise<DiffStat | undefined> {
	let tracked: DiffStat;
	let untracked: string;
	try {
		tracked = parseNumstat(await git(cwd, ['diff', '--numstat', 'HEAD']));
		untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
	} catch {
		return undefined;
	}
	let added = tracked.added;
	for (const file of untracked.split('\0').filter(Boolean)) {
		const full = path.join(cwd, file);
		try {
			if ((await stat(full)).size <= MAX_NEW_FILE_BYTES) {
				added += countLines(await readFile(full, 'utf8'));
			}
		} catch {
			// Gone since git listed it: nothing to count.
		}
	}
	return { added, removed: tracked.removed };
}
