import * as assert from 'assert';
import { test } from 'node:test';
import { firstUserPrompt, sessionTurns, listSessionFiles, listWorkspaceSessionFiles, piProjectSlug, type SessionsFs } from '../src/sessions-provider.ts';

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
