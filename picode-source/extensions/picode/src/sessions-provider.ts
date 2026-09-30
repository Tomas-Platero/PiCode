/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

/**
 * pi's sessions, in the editor's Sessions panel.
 *
 * The editor's own "Local" group comes from the chat service's index; pi's session files
 * (the JSONL transcripts under `<agentDir>/sessions`) belong to no pipeline at all — this
 * provider is the bridge. It lists the transcripts as a `pi` group, opens one as a read
 * only history, and fires the change event whenever the profile's sessions have moved
 * (the import is what brings a whole tree over at once).
 *
 * Session file shape (pi's own, version 3): the first line is a `session` record with the
 * id, timestamp and cwd; the rest are `message` records whose `message.role` is `user`,
 * `assistant` or `toolResult` and whose `message.content` is a list of typed parts —
 * `text`, `thinking`, tool payloads. The listing reads the first user text for the label;
 * the content maps user messages to request turns and assistant *text* to response turns
 * (thinking and tool results stay out of the replay — they are pi's plumbing).
 */

/** One mapped turn of a replayed session. */
export interface PiSessionTurn {
	readonly role: 'user' | 'assistant';
	readonly text: string;
}

/** One session file as the panel lists it. */
export interface PiSessionFile {
	/** The pi session id (the uuid in the file name and the first line). */
	readonly id: string;
	/** The file, for the content read. */
	readonly file: string;
	/** The first user prompt — the label the panel shows. */
	readonly label: string;
	/** Last modified, newest first in the list. */
	readonly mtime: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The text of one content part list: only `text` parts, `thinking` stays out. */
function textOfContent(content: unknown): string {
	if (!Array.isArray(content)) {
		return '';
	}
	const parts: string[] = [];
	for (const part of content) {
		if (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string') {
			parts.push(part['text']);
		}
	}
	return parts.join('\n\n').trim();
}

/** Reads a JSONL transcript, entry by entry; a broken line is skipped, not fatal. */
function* entries(text: string): Generator<Record<string, unknown>> {
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			continue;
		}
		try {
			const value: unknown = JSON.parse(trimmed);
			if (isRecord(value)) {
				yield value;
			}
		} catch {
			// A half-written line is "not there", not an error: the file may be mid-write.
		}
	}
}

/** The first user prompt in the transcript, or `undefined` when it has none yet. */
export function firstUserPrompt(text: string): string | undefined {
	for (const entry of entries(text)) {
		if (entry['type'] !== 'message') {
			continue;
		}
		const message = entry['message'];
		if (isRecord(message) && message['role'] === 'user') {
			const text = textOfContent(message['content']);
			if (text.length > 0) {
				return text;
			}
		}
	}
	return undefined;
}

/** The replayed conversation: user prompts and assistant answers, in order. */
export function sessionTurns(text: string): PiSessionTurn[] {
	const turns: PiSessionTurn[] = [];
	for (const entry of entries(text)) {
		if (entry['type'] !== 'message') {
			continue;
		}
		const message = entry['message'];
		if (!isRecord(message)) {
			continue;
		}
		const role = message['role'];
		if (role === 'user') {
			const text = textOfContent(message['content']);
			if (text.length > 0) {
				turns.push({ role: 'user', text });
			}
		} else if (role === 'assistant') {
			const text = textOfContent(message['content']);
			if (text.length > 0) {
				turns.push({ role: 'assistant', text });
			}
		}
	}
	return turns;
}

/** The file system the listing reads, injectable for tests. */
export interface SessionsFs {
	read(file: string): string;
	list(dir: string): string[];
	mtime(file: string): number;
}

const nodeFs: SessionsFs = {
	read: file => {
		try {
			return readFileSync(file, 'utf8');
		} catch {
			return '';
		}
	},
	list: dir => {
		try {
			return readdirSync(dir).map(name => path.join(dir, name));
		} catch {
			return [];
		}
	},
	mtime: file => {
		try {
			return statSync(file).mtimeMs;
		} catch {
			return 0;
		}
	},
};

/**
 * Cached listing per transcript, keyed by absolute file path: the label and id computed
 * from the file's contents, remembered against the mtime they were computed from.
 *
 * The listing walks the whole `sessions/` tree on every panel refresh, and pi's transcripts
 * are append-only JSONL — a file's label only changes when the file does. Keying on the
 * mtime alone means an edit that leaves the mtime untouched (same-second rewrite) would
 * serve a stale label; acceptable for a transcript listing, where pi appends and the mtime
 * moves with every write.
 */
const listingCache = new Map<string, { mtime: number; label: string; id: string }>();

/**
 * pi's per-project session folder name, replicating the runtime's own encoding
 * (pi `dist/core/session-manager.js`, `getDefaultSessionDirPath`): the resolved cwd
 * with any leading separator stripped, every `/`, `\` and `:` turned into `-`,
 * wrapped in `--` … `--` — e.g. `D:\repositorios\PiCode` → `--D--repositorios-PiCode--`.
 */
export function piProjectSlug(cwd: string): string {
	return `--${path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/**
 * Lists the session transcripts of the given workspace folders only.
 *
 * pi keeps one folder per project under `sessions/`, named by the project's cwd
 * (see `piProjectSlug`); the panel must show the sessions of the folders actually
 * open, never the whole profile. With no workspace open, or when no per-project
 * folder matches, the listing is empty — there is no fall-back to every project.
 *
 * On Windows the folder-name match is case-insensitive: NTFS folds case, and the
 * drive letter's case in a workspace path may differ from the case pi recorded
 * when the sessions were created.
 */
export function listWorkspaceSessionFiles(
	sessionsDir: string,
	workspacePaths: readonly string[],
	fs: SessionsFs = nodeFs,
): PiSessionFile[] {
	if (workspacePaths.length === 0) {
		return [];
	}
	const slugs = new Set(workspacePaths.map(piProjectSlug));
	const foldedSlugs = new Set([...slugs].map(slug => slug.toLowerCase()));
	const dirs: string[] = [];
	for (const entry of fs.list(sessionsDir)) {
		const name = path.basename(entry);
		if (slugs.has(name) || (process.platform === 'win32' && foldedSlugs.has(name.toLowerCase()))) {
			dirs.push(entry);
		}
	}
	return listFromDirs(dirs, fs);
}

/**
 * The listing shared by every entry point: walks the given roots (pi's per-project
 * folders, or the whole `sessions/` tree), newest first; the label is the first
 * user prompt, falling back to the file's own timestamp.
 *
 * Each transcript's label and id are read from `listingCache` when the file's mtime still
 * matches the cached one, so an unchanged tree costs a `stat` per file instead of a full
 * read of every transcript. Entries for files the walk no longer sees are dropped.
 */
function listFromDirs(roots: readonly string[], fs: SessionsFs): PiSessionFile[] {
	const files: PiSessionFile[] = [];
	const stack = [...roots];
	const visited = new Set<string>(stack);
	const seen = new Set<string>();
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const entry of fs.list(dir)) {
			if (!entry.endsWith('.jsonl')) {
				// A project folder: pi's per-project grouping. Walk it once — a cycle
				// in the tree (or a lying listing) must not hang the panel.
				if (!visited.has(entry)) {
					visited.add(entry);
					stack.push(entry);
				}
				continue;
			}
			seen.add(entry);
			const mtime = fs.mtime(entry);
			const cached = listingCache.get(entry);
			let label: string;
			let id: string;
			if (cached !== undefined && cached.mtime === mtime) {
				({ label, id } = cached);
			} else {
				// New or modified file: read it and remember the label until it moves again.
				const firstPrompt = firstUserPrompt(fs.read(entry))
					?? path.basename(entry).replace(/\.jsonl$/, '');
				const idMatch = path.basename(entry).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
				label = firstPrompt.length > 80 ? `${firstPrompt.slice(0, 80)}…` : firstPrompt;
				id = idMatch?.[1] ?? path.basename(entry, '.jsonl');
				listingCache.set(entry, { mtime, label, id });
			}
			files.push({
				id,
				file: entry,
				label,
				mtime,
			});
		}
	}
	for (const cached of listingCache.keys()) {
		if (!seen.has(cached)) {
			listingCache.delete(cached);
		}
	}
	return files.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Lists every session transcript under the profile's `sessions/` directory, across
 * all of pi's per-project folders. The panel uses `listWorkspaceSessionFiles` instead;
 * this remains the unfiltered walk for callers that genuinely want every project.
 */
export function listSessionFiles(sessionsDir: string, fs: SessionsFs = nodeFs): PiSessionFile[] {
	return listFromDirs([sessionsDir], fs);
}
