/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A transcript written before its first message, in pi's own format.
 *
 * pi only writes a conversation to disk once it has one, so a session started on a branch would
 * be missing from the Sessions list until the owner spoke. PiCode writes the header and a
 * `session_info` entry (the display name, the branch) itself; pi opens that file like any other
 * and appends the conversation to it. The first prompt then names the row, as for every session.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** A time-ordered UUID (version 7), the shape pi gives its session ids. */
export function uuidv7(now: number = Date.now()): string {
	const bytes = randomBytes(16);
	const time = BigInt(now);
	for (let index = 0; index < 6; index++) {
		bytes[index] = Number((time >> BigInt(8 * (5 - index))) & 0xffn);
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x70;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Writes a new transcript in `sessionDir` for a session running in `cwd`, named `name`. */
export function writeNamedTranscript(sessionDir: string, cwd: string, name: string, now: number = Date.now()): { readonly id: string; readonly file: string } {
	const id = uuidv7(now);
	const timestamp = new Date(now).toISOString();
	const file = path.join(sessionDir, `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`);
	const header = { type: 'session', version: 3, id, timestamp, cwd };
	const info = { type: 'session_info', id: randomBytes(4).toString('hex'), parentId: null, timestamp, name: name.replace(/[\r\n]+/g, ' ').trim() };
	fs.mkdirSync(sessionDir, { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(info)}\n`, { flag: 'wx' });
	return { id, file };
}
