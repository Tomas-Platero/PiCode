/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * What decides whether the Sessions panel has to be told to look again.
 *
 * pi appends to the open transcript after every message, so the transcripts folder changes many
 * times during one answer. Telling the panel at each of those made it repaint the list over and
 * over — rows vanishing and returning while an answer streamed. The panel needs to know when a
 * conversation **begins or goes away**; a row that only grew keeps its place and is dated again
 * the next time anything asks. These two pieces keep the answer to that:
 *
 *  - a digest of the transcript file names, which changes only when one is added or removed, and
 *  - a clock rounded to the minute, which is all the panel shows ("now", "5 mins ago"), so a row
 *    that was only appended to is the same row to the panel.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

/** A moment rounded down to its minute: the finest grain the panel's dates have. */
export function coarseMinute(milliseconds: number): number {
	return Math.floor(milliseconds / 60_000) * 60_000;
}

/** The directory reads this module needs, injectable so a test needs no disk. */
export interface DigestFs {
	readonly readdir: (dir: string) => readonly string[];
}

const nodeDigestFs: DigestFs = {
	readdir: dir => {
		try {
			return fs.readdirSync(dir);
		} catch {
			return [];
		}
	},
};

/**
 * The transcripts under a profile's `sessions/` folder, as one string that changes when one is
 * added or removed and at no other time: each `<project>/<file>.jsonl`, sorted.
 */
export function transcriptDigest(sessionsDir: string, io: DigestFs = nodeDigestFs): string {
	const names: string[] = [];
	for (const project of io.readdir(sessionsDir)) {
		for (const file of io.readdir(path.join(sessionsDir, project))) {
			if (file.endsWith('.jsonl')) {
				names.push(`${project}/${file}`);
			}
		}
	}
	return names.sort().join('\n');
}
