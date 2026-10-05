/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The panel listing, grouped by project.
 *
 * In workspace mode the sessions of the area are listed as their own group — never as a
 * session of the folder pi happened to run in — with one group per folder beside it, and a
 * cap per group so one busy project cannot turn the panel into an endless list. The rules
 * run here with a memory file system, without the editor.
 */

import assert from 'assert';
import { test } from 'node:test';
import { listSessionGroups, piProjectSlug, type SessionsFs } from '../src/sessions-provider.ts';

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
const WEB_SLUG = piProjectSlug(WEB);
const BOT_SLUG = piProjectSlug(BOT);
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

test('each group holds only its own project\'s sessions, area first', () => {
	const [areaFile, areaContent] = transcript('2026_a', 'D:\\repos', AREA_SLUG, 30);
	const [webFile, webContent] = transcript('2026_w', WEB, WEB_SLUG, 20);
	const [botFile, botContent] = transcript('2026_b', BOT, BOT_SLUG, 10);
	const groups = listSessionGroups('/sessions', [
		{ label: 'Artictempest (workspace area)', slugs: [AREA_SLUG] },
		{ label: 'web', slugs: [WEB_SLUG] },
		{ label: 'bot', slugs: [BOT_SLUG] },
	], 8, memoryFs({ [areaFile]: areaContent, [webFile]: webContent, [botFile]: botContent }));
	assert.deepStrictEqual(groups.map(group => group.label), ['Artictempest (workspace area)', 'web', 'bot']);
	assert.deepStrictEqual(groups.map(group => group.files.map(file => file.label)), [['de 2026_a'], ['de 2026_w'], ['de 2026_b']]);
});

test('a root-level transcript lands in the group its header names, never in the area group', () => {
	const [webFile, webContent] = transcript('2026_w', WEB, WEB_SLUG, 20);
	const [, rootContent] = transcript('2026_r', WEB, WEB_SLUG, 15);
	const groups = listSessionGroups('/sessions', [
		{ label: 'Artictempest (workspace area)', slugs: [AREA_SLUG] },
		{ label: 'web', slugs: [WEB_SLUG] },
	], 8, memoryFs({
		[webFile]: webContent,
		// A pre-area transcript filed at the sessions root: its header says which project it belongs to.
		'/sessions/2026_r.jsonl': rootContent,
	}));
	assert.deepStrictEqual(groups[0].files, []);
	assert.deepStrictEqual(groups[1].files.map(file => file.label).sort(), ['de 2026_r', 'de 2026_w']);
});

test('the cap holds per group, newest first, and never across groups', () => {
	const files: Record<string, string> = {};
	for (let i = 0; i < 6; i++) {
		const [file, content] = transcript(`2026_w${i}`, WEB, WEB_SLUG, 100 + i);
		files[file] = content;
	}
	const [areaFile, areaContent] = transcript('2026_a', 'D:\\repos', AREA_SLUG, 200);
	files[areaFile] = areaContent;
	const groups = listSessionGroups('/sessions', [
		{ label: 'Artictempest (workspace area)', slugs: [AREA_SLUG] },
		{ label: 'web', slugs: [WEB_SLUG] },
	], 3, memoryFs(files));
	assert.strictEqual(groups[0].files.length, 1);
	assert.strictEqual(groups[1].files.length, 3);
	// Newest first within the group: mtimes rise with i, so the cap keeps the highest.
	assert.deepStrictEqual(groups[1].files.map(file => file.id), ['2026_w5', '2026_w4', '2026_w3']);
});

test('a group whose folder has no sessions yet is empty, not absent', () => {
	const groups = listSessionGroups('/sessions', [
		{ label: 'Artictempest (workspace area)', slugs: [AREA_SLUG] },
		{ label: 'bot', slugs: [BOT_SLUG] },
	], 8, memoryFs({}));
	assert.deepStrictEqual(groups.map(group => group.label), ['Artictempest (workspace area)', 'bot']);
	assert.deepStrictEqual(groups.map(group => group.files), [[], []]);
});
