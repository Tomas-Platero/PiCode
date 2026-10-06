import * as assert from 'assert';
import { test } from 'node:test';
import { firstUserPrompt, reuseRows, sessionTurns, listSessionFiles, listWorkspaceSessionFiles, piProjectSlug, type SessionsFs } from '../src/sessions-provider.ts';

test('firstUserPrompt answers the first user text', () => {
	const jsonl = [
		'{"type":"session","version":3,"id":"abc","timestamp":"2026-09-28T09:00:00.000Z","cwd":"C:\\\\demo"}',
		'{"type":"message","id":"e1","timestamp":"2026-09-28T09:00:05.000Z","message":{"role":"user","content":[{"type":"text","text":"hola pi"}]}}',
	].join('\n');
	assert.strictEqual(firstUserPrompt(jsonl), 'hola pi');
});

test('firstUserPrompt tolerates junk and missing prompts', () => {
	assert.strictEqual(firstUserPrompt('not json'), undefined);
	assert.strictEqual(firstUserPrompt('{"type":"session","id":"x"}'), undefined);
});

test('sessionTurns maps user and assistant messages, skipping thinking and tool results', () => {
	const jsonl = [
		'{"type":"message","id":"e1","message":{"role":"user","content":[{"type":"text","text":"hola pi"}]}}',
		'{"type":"message","id":"e2","message":{"role":"assistant","content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"hola, que tal"}]}}',
		'{"type":"message","id":"e3","message":{"role":"toolResult","content":[{"type":"text","text":"output"}]}}',
		'{"type":"message","id":"e4","message":{"role":"assistant","content":[{"type":"text","text":"segunda linea"}]}}',
	].join('\n');
	assert.deepStrictEqual(sessionTurns(jsonl), [
		{ role: 'user', text: 'hola pi' },
		{ role: 'assistant', text: 'hola, que tal' },
		{ role: 'assistant', text: 'segunda linea' },
	]);
});

test('listSessionFiles walks project folders and labels from the first prompt', () => {
	const files: Record<string, string> = {
		'/sessions/--C--demo--/2026_a.jsonl': '{"type":"session","id":"a"}\n{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hola pi"}]}}',
		'/sessions/2026_b.jsonl': '{"type":"session","id":"b"}',
		'/sessions/--C--demo--/notes.txt': 'not a session',
	};
	const fs = {
		read: (file: string): string => files[file] ?? '',
		list: (dir: string): string[] => Object.keys(files)
			.filter(f => f.startsWith(dir + '/') || f === dir)
			.filter(f => !f.endsWith('.txt') || f === dir),
		mtime: (): number => 1000,
	};
	const found = listSessionFiles('/sessions', fs);
	assert.strictEqual(found.length, 2);
	assert.strictEqual(found[0].label, 'hola pi');
	assert.ok(found[1].label.length > 0);
});

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
				// A nested file is only reachable through its ancestor folders, so they are
				// listed as entries of their own, exactly like a real directory walk.
				entries.add(rest.includes('/') ? `${dir}/${rest.split('/')[0]}` : file);
			}
			return [...entries];
		},
		mtime: (): number => 1000,
	};
}

function sessionHeaderLine(id: string, cwd: string): string {
	return `{"type":"session","version":3,"id":"${id}","timestamp":"2026-10-05T12:00:00.000Z","cwd":${JSON.stringify(cwd)}}`;
}

function projectTranscript(name: string): [string, string] {
	const slug = piProjectSlug('C:\\demo');
	return [`/sessions/${slug}/${name}.jsonl`, `${sessionHeaderLine(name, 'C:\\demo')}\n{"type":"message","message":{"role":"user","content":[{"type":"text","text":"del proyecto"}]}}`];
}

function rootTranscript(name: string, cwd: string): [string, string] {
	return [`/sessions/${name}.jsonl`, `${sessionHeaderLine(name, cwd)}\n{"type":"message","message":{"role":"user","content":[{"type":"text","text":"de la raiz"}]}}`];
}

const ROOT_MATCHER: readonly string[] = ['C:\\demo'];

test('a workspace listing includes a root-level transcript whose header names the workspace', () => {
	const [projectFile, projectContent] = projectTranscript('2026_p1');
	const [rootFile, rootContent] = rootTranscript('2026_r1', 'C:\\demo');
	const found = listWorkspaceSessionFiles('/sessions', ROOT_MATCHER, memoryFs({
		[projectFile]: projectContent,
		[rootFile]: rootContent,
	}));
	assert.deepStrictEqual(found.map(file => file.label).sort(), ['de la raiz', 'del proyecto']);
});

test('a root-level transcript for another project stays out of the workspace listing', () => {
	const [projectFile, projectContent] = projectTranscript('2026_p2');
	const [rootFile, rootContent] = rootTranscript('2026_r2', 'C:\\other');
	const found = listWorkspaceSessionFiles('/sessions', ROOT_MATCHER, memoryFs({
		[projectFile]: projectContent,
		[rootFile]: rootContent,
	}));
	assert.deepStrictEqual(found.map(file => file.label), ['del proyecto']);
});

test('a root-level transcript without a session header is not matched', () => {
	const [projectFile, projectContent] = projectTranscript('2026_p3');
	const files: Record<string, string> = {
		[projectFile]: projectContent,
		'/sessions/2026_r3.jsonl': 'not a session',
	};
	const found = listWorkspaceSessionFiles('/sessions', ROOT_MATCHER, memoryFs(files));
	assert.deepStrictEqual(found.map(file => file.label).sort(), ['del proyecto']);
});

/** A listing file system whose listing order, contents and mtimes the test drives. */
function orderedFs(entries: string[], contents: (file: string) => string, mtimes: (file: string) => number): SessionsFs {
	return {
		read: file => (entries.includes(file) ? contents(file) : ''),
		list: dir => (dir === '/list' ? entries : []),
		mtime: file => (entries.includes(file) ? mtimes(file) : 0),
	};
}

/** One transcript with a prompt, so the label is something the test can recognise. */
function transcriptFor(id: string, prompt: string): string {
	return [
		`{"type":"session","version":3,"id":"${id}","timestamp":"2026-10-05T12:00:00.000Z","cwd":"C:\\\\list"}`,
		`{"type":"message","message":{"role":"user","content":[{"type":"text","text":"${prompt}"}]}}`,
	].join('\n');
}

test('a listing is the same order however the directory happens to list it', () => {
	// Three transcripts pi wrote together (an import), so the mtimes tie and the directory's
	// own order — which is not a promise — would otherwise be what the panel shows.
	const ids = ['aaaa1111-1111-1111-1111-111111111111', 'bbbb2222-2222-2222-2222-222222222222', 'cccc3333-3333-3333-3333-333333333333'];
	// The directory hands them over in an order that is neither sorted nor reversed: it is
	// whatever `readdir` felt like, which is exactly what must not reach the panel.
	const listed = ['cccc3333-3333-3333-3333-333333333333', 'aaaa1111-1111-1111-1111-111111111111', 'bbbb2222-2222-2222-2222-222222222222'];
	const files = listed.map(id => `/list/${id}.jsonl`);
	const contents = (file: string): string => transcriptFor(file.slice('/list/'.length, -'.jsonl'.length), `prompt ${file}`);
	const tied = (): number => 1000;

	const forwards = listSessionFiles('/list', orderedFs(files, contents, tied)).map(file => file.id);
	const backwards = listSessionFiles('/list', orderedFs([...files].reverse(), contents, tied)).map(file => file.id);

	assert.deepStrictEqual(forwards, [...ids].sort());
	assert.deepStrictEqual(backwards, forwards);
});

test('a transcript that cannot be read right now keeps its label and its place', () => {
	// pi appends to the live transcript while the panel looks at it, so a stat that fails is a
	// file we cannot see *this time round* — not a transcript written in 1970 whose name is its
	// uuid. Losing the remembered mtime would rename one row and sort it below every other one.
	const fresh = '/list/11111111-1111-1111-1111-111111111111.jsonl';
	const older = '/list/22222222-2222-2222-2222-222222222222.jsonl';
	const files = [fresh, older];
	const contents = (file: string): string => transcriptFor(file.slice('/list/'.length, -'.jsonl'.length), file === fresh ? 'la viva' : 'la vieja');

	const first = listSessionFiles('/list', orderedFs(files, contents, file => (file === fresh ? 9000 : 4000)));
	assert.deepStrictEqual(first.map(file => file.label), ['la viva', 'la vieja']);

	const unreadable = listSessionFiles('/list', orderedFs(files, contents, file => (file === fresh ? 0 : 4000)));
	assert.deepStrictEqual(unreadable.map(file => file.label), ['la viva', 'la vieja']);
	assert.deepStrictEqual(unreadable.map(file => file.mtime), [9000, 4000]);
});

test('reuseRows hands back the row it handed out before when nothing about it changed', () => {
	interface Row { readonly id: string; readonly label: string; readonly mtime: number; }
	const before: Row[] = [{ id: 'a', label: 'A', mtime: 1 }, { id: 'b', label: 'B', mtime: 2 }];
	const unchanged = (previous: Row, next: Row): boolean => previous.label === next.label && previous.mtime === next.mtime;
	const key = (row: Row): string => row.id;

	const same = reuseRows(before, [{ id: 'a', label: 'A', mtime: 1 }, { id: 'b', label: 'B', mtime: 2 }], key, unchanged);
	assert.strictEqual(same[0], before[0]);
	assert.strictEqual(same[1], before[1]);

	// One row moved, one arrived, one left: only the moved and the new ones are new objects.
	const changed = reuseRows(before, [{ id: 'b', label: 'B', mtime: 2 }, { id: 'c', label: 'C', mtime: 3 }], key, unchanged);
	assert.deepStrictEqual(changed.map(row => row.id), ['b', 'c']);
	assert.strictEqual(changed[0], before[1]);
	assert.notStrictEqual(changed[1], before[0]);

	const relabelled = reuseRows(before, [{ id: 'a', label: 'A renamed', mtime: 1 }], key, unchanged);
	assert.strictEqual(relabelled[0].label, 'A renamed');
	assert.notStrictEqual(relabelled[0], before[0]);
});
