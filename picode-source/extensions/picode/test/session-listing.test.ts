/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The panel's listing: **one list, and it is the window's own**.
 *
 * The owner's instruction: «Yo solo quiero ver si estoy en un workspace las de workspace», and a
 * row label that read *«Artictempest (Workspace) (workspace area)»* said the same word twice. So
 * there are no groups and no per-folder split any more: the rows are the conversations filed under
 * the slugs the window covers (`runtime.ts` `projectSlugsOfWindow` — the area's, then each open
 * folder's), newest first, capped, and never anything from a project that is not open.
 *
 * The rules run here with a memory file system, without the editor.
 */

import assert from 'assert';
import { test } from 'node:test';
import { listedSessionSlugs, listProjectConversations, piProjectSlug, type SessionsFs } from '../src/sessions-provider.ts';

/** A listing file system over a flat record of file → content, listing ancestor directories too. */
function memoryFs(files: Record<string, string>): SessionsFs {
	return {
		read: file => files[file] ?? '',
		list: dir => {
			const entries = new Set<string>();
			for (const file of Object.keys(files)) {
				if (!file.startsWith(dir + '/')) {
					continue;
				}
				const rest = file.slice(dir.length + 1);
				entries.add(rest.includes('/') ? `${dir}/${rest.split('/')[0]}` : file);
			}
			return [...entries];
		},
		// The mtime is carried in the file name (`…/m30/…`) so the tests can order sessions.
		mtime: (file: string): number => Number(file.match(/\/m(\d+)\//)?.[1] ?? 1000),
	};
}

const WEB = 'D:\\repos\\web';
const BOT = 'D:\\repos\\bot';
const OTHER = 'D:\\repos\\somewhere-else';
const WEB_SLUG = piProjectSlug(WEB);
const BOT_SLUG = piProjectSlug(BOT);
const OTHER_SLUG = piProjectSlug(OTHER);
const AREA_SLUG = '--area-Artictempest-1a2b3c4d--';

/** A transcript under `slug`, with mtime `mtime` in its path and one user prompt naming `id`. */
function transcript(id: string, cwd: string, slug: string, mtime: number): [string, string] {
	const file = `/sessions/${slug}/m${mtime}/${id}.jsonl`;
	const content = [
		JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-05T12:00:00.000Z', cwd }),
		JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `de ${id}` }] } }),
	].join('\n');
	return [file, content];
}

/** The same transcript as `transcript`, but filed as a delegation of `parentFile`. */
function delegation(id: string, cwd: string, slug: string, mtime: number, parentFile: string): [string, string] {
	const [file, content] = transcript(id, cwd, slug, mtime);
	const lines = content.split('\n');
	const header: unknown = JSON.parse(lines[0]);
	lines[0] = JSON.stringify({ ...(header as Record<string, unknown>), parentSession: parentFile });
	return [file, lines.join('\n')];
}

test('a workspace lists the workspace\u2019s own sessions, and a folder window lists the folder\u2019s', () => {
	// The owner's instruction, twice: «Yo solo quiero ver si estoy en un workspace las de
	// workspace». A folder's history is that folder's, and a workspace does not gather it up.
	assert.deepStrictEqual(listedSessionSlugs('workspace', AREA_SLUG, [WEB, BOT]), [AREA_SLUG]);
	assert.deepStrictEqual(listedSessionSlugs('folder', undefined, [WEB]), [WEB_SLUG]);
	// A workspace with no area identity falls back to the folders rather than to nothing.
	assert.deepStrictEqual(listedSessionSlugs('workspace', undefined, [WEB, BOT]), [WEB_SLUG, BOT_SLUG]);
});

test('the window is one list: the area and its folders together, newest first', () => {
	// No groups and no labels: a conversation is listed once, and the date is what orders them.
	const [areaFile, areaContent] = transcript('2026_a', 'D:\\repos', AREA_SLUG, 30);
	const [webFile, webContent] = transcript('2026_w', WEB, WEB_SLUG, 20);
	const [botFile, botContent] = transcript('2026_b', BOT, BOT_SLUG, 10);
	const found = listProjectConversations('/sessions', [AREA_SLUG, WEB_SLUG, BOT_SLUG], 8, memoryFs({
		[areaFile]: areaContent,
		[webFile]: webContent,
		[botFile]: botContent,
	}));
	assert.deepStrictEqual(found.map(file => file.id), ['2026_a', '2026_w', '2026_b']);
});

test('a project that is not open is not in the list', () => {
	const [webFile, webContent] = transcript('2026_w', WEB, WEB_SLUG, 20);
	const [otherFile, otherContent] = transcript('2026_o', OTHER, OTHER_SLUG, 90);
	const found = listProjectConversations('/sessions', [WEB_SLUG], 8, memoryFs({
		[webFile]: webContent,
		[otherFile]: otherContent,
	}));
	assert.deepStrictEqual(found.map(file => file.id), ['2026_w']);
});

test('a root-level transcript belongs to the window its own header names', () => {
	const [webFile, webContent] = transcript('2026_w', WEB, WEB_SLUG, 20);
	const [, rootContent] = transcript('2026_r', WEB, WEB_SLUG, 15);
	const found = listProjectConversations('/sessions', [WEB_SLUG], 8, memoryFs({
		[webFile]: webContent,
		// A transcript filed at the sessions root: its header says which project it belongs to.
		'/sessions/2026_r.jsonl': rootContent,
	}));
	assert.deepStrictEqual(found.map(file => file.id).sort(), ['2026_r', '2026_w']);
});

test('with no project open there is no list, and no fall-back to the whole profile', () => {
	const [webFile, webContent] = transcript('2026_w', WEB, WEB_SLUG, 20);
	assert.deepStrictEqual(listProjectConversations('/sessions', [], 8, memoryFs({ [webFile]: webContent })), []);
});

test('the cap is spent on conversations, never on the agents they launched', () => {
	// The afternoon the report describes: two conversations, and nine agents launched from them,
	// all newer. The panel's eight rows belong to the conversations — before this the agents were
	// the eight newest and both conversations were pushed out of the list entirely.
	const files: Record<string, string> = {};
	const [firstFile, firstContent] = transcript('2026_c1', WEB, WEB_SLUG, 10);
	const [secondFile, secondContent] = transcript('2026_c2', WEB, WEB_SLUG, 11);
	files[firstFile] = firstContent;
	files[secondFile] = secondContent;
	for (let i = 0; i < 9; i++) {
		const [file, content] = delegation(`2026_a${i}`, WEB, WEB_SLUG, 100 + i, firstFile);
		files[file] = content;
	}

	const found = listProjectConversations('/sessions', [WEB_SLUG], 8, memoryFs(files));
	assert.deepStrictEqual(found.map(file => file.id), ['2026_c2', '2026_c1']);
});

test('the cap keeps the newest, and the list stops there', () => {
	const files: Record<string, string> = {};
	for (let i = 0; i < 6; i++) {
		const [file, content] = transcript(`2026_w${i}`, WEB, WEB_SLUG, 100 + i);
		files[file] = content;
	}
	const found = listProjectConversations('/sessions', [WEB_SLUG], 3, memoryFs(files));
	assert.deepStrictEqual(found.map(file => file.id), ['2026_w5', '2026_w4', '2026_w3']);
});

test('a window whose projects have no sessions yet is empty, not absent', () => {
	assert.deepStrictEqual(listProjectConversations('/sessions', [AREA_SLUG, BOT_SLUG], 8, memoryFs({})), []);
});
