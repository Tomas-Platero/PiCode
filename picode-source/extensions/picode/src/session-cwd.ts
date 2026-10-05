/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The working directory a chat session runs in, picked so that it exists.
 *
 * The chat used to hand pi the workspace's first folder as-is. A multi-root workspace keeps a
 * folder in `workspaceFolders` even when it is not on disk — moved, renamed, deleted, or added
 * from a `.code-workspace` whose path no longer resolves — and pi accepted such a directory
 * silently: a session tolerates a missing cwd, but everything pi spawns **into** that directory
 * fails, and Node reports a spawn whose `cwd` does not exist as ENOENT naming the command
 * (`spawn node ENOENT`, `spawn C:\WINDOWS\system32\cmd.exe ENOENT`) — the MCP "need attention"
 * wall the owner saw, pointing at eight commands that were all fine. The rule here is the one
 * that removes the whole class: the session's directory is the first workspace folder that
 * exists on disk, the home directory when none does, and every folder skipped is reported so
 * the sentence the owner reads is about the folder, not about a command.
 *
 * Pure on purpose: no `vscode`, so the chat's handler (`agent.ts`) decides and these tests can
 * exercise the decision with real directories.
 */

import { statSync } from 'node:fs';

/** What a resolution decided: where pi runs, and which folders were skipped for it. */
export interface SessionCwd {
	/** The directory pi runs in: the first workspace folder that exists, else the home one. */
	readonly cwd: string;
	/** Workspace folders skipped because they are not directories on disk, in the editor's order. */
	readonly missing: readonly string[];
}

/** True only for a directory that is there right now. A file with the same name is not. */
function isDirectory(candidate: string): boolean {
	try {
		return statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Picks the session directory from the open folders, in the editor's order.
 *
 * `home` is the caller's `os.homedir()`, passed in rather than resolved here so the fallback is
 * visible to the caller — and to the tests.
 */
export function resolveSessionCwd(folders: readonly string[], home: string): SessionCwd {
	const missing: string[] = [];
	for (const folder of folders) {
		if (isDirectory(folder)) {
			return { cwd: folder, missing };
		}
		missing.push(folder);
	}
	// No folder is on disk: pi still has to run somewhere real, and the home directory is the
	// one place that exists without this editor guessing at the workspace.
	return { cwd: home, missing };
}
