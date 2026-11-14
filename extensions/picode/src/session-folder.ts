/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * A saved conversation whose folder is gone.
 *
 * A transcript remembers the folder it was written in. When that folder was moved, renamed or
 * deleted, opening the conversation from the list used to carry on silently in the open folder
 * and leave the old, missing one in the file for good. pi 1.5.2 asks instead, and so does the
 * editor: carry on here, or copy the conversation into the open folder so the next time it
 * opens without asking.
 *
 * Pure on purpose: no `vscode`, so the decision can be tested with real directories.
 */

import { statSync } from 'node:fs';
import * as path from 'node:path';

/** What the owner can choose when a conversation's folder is gone. */
export type LostFolderChoice = 'continue' | 'copy' | 'cancel';

function isDirectory(candidate: string): boolean {
	try {
		return statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The folder a transcript was written in, when it is gone; `undefined` when there is nothing to
 * ask: no folder in the header, the folder is still there, or it is the folder the chat runs in
 * anyway.
 *
 * @param headerCwd the `cwd` of the transcript's first record
 * @param runsIn the folder the chat runs in now
 * @param isThere how a folder is checked; the real disk by default
 */
export function lostFolderOf(headerCwd: unknown, runsIn: string, isThere: (folder: string) => boolean = isDirectory): string | undefined {
	if (typeof headerCwd !== 'string' || headerCwd.length === 0) {
		return undefined;
	}
	if (path.resolve(headerCwd) === path.resolve(runsIn)) {
		return undefined;
	}
	return isThere(headerCwd) ? undefined : headerCwd;
}
