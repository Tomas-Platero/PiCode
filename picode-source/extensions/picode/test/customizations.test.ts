/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The agent and skill discovery, run on its own.
 *
 * `node --test` runs this file directly (Node's own type stripping), which is why `customizations.ts`
 * carries no `vscode`: the walk, the frontmatter and the precedence between a profile's copy and a
 * project's are the parts worth exercising, and none of them needs an editor.
 */

import assert from 'assert';
import { test } from 'node:test';
import {
	agentRoots,
	coalesce,
	discoverAgents,
	discoverSkills,
	frontmatterList,
	frontmatterText,
	parseFrontmatter,
	skillRoots,
	type DirectoryEntry,
	type FsReader,
} from '../src/customizations.ts';

/**
 * A made-up filesystem.
 *
 * Paths are compared with `/` separators because the discovery builds them with `path.join`, which
 * uses `\` on Windows — the one thing a test of a walk must not be sensitive to.
 */
function fakeFs(files: Readonly<Record<string, string>>): FsReader {
	const normalized = new Map(Object.entries(files).map(([key, value]) => [toPosix(key), value]));
	const entriesOf = (dir: string): readonly DirectoryEntry[] => {
		const prefix = `${toPosix(dir)}/`;
		const found = new Map<string, boolean>();
		for (const key of normalized.keys()) {
			if (!key.startsWith(prefix)) {
				continue;
			}
			const rest = key.slice(prefix.length);
			const slash = rest.indexOf('/');
			found.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1);
		}
		return [...found].map(([name, directory]) => ({ name, directory })).sort((left, right) => left.name.localeCompare(right.name));
	};
	return {
		entries: entriesOf,
		text: file => normalized.get(toPosix(file)),
		exists: target => {
			const wanted = toPosix(target);
			return normalized.has(wanted) || [...normalized.keys()].some(key => key.startsWith(`${wanted}/`));
		},
	};
}

function toPosix(target: string): string {
	return target.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** An agent file as the profile's own copies look: a header, then the instructions. */
function agentFile(name: string, description: string): string {
	return `---\nname: ${name}\ndescription: ${description}\ntools:\n  - read\n  - grep\n---\n\nYou are ${name}.\n`;
}

const PROFILE = '/profile';
const FOLDER = '/project';

/* ------------------------------------------------------------------ *
 * Frontmatter
 * ------------------------------------------------------------------ */

test('parseFrontmatter reads the header sample-skill ships and leaves the instructions alone', () => {
	const text = agentFile('explore-agent', 'Read-only exploration and mapping.');

	const parsed = parseFrontmatter(text);

	assert.strictEqual(frontmatterText(parsed, 'name'), 'explore-agent');
	assert.strictEqual(frontmatterText(parsed, 'description'), 'Read-only exploration and mapping.');
	// The `- read` lines are the list form, and the header's indentation is not part of the value.
	assert.deepStrictEqual(frontmatterList(parsed, 'tools'), ['read', 'grep']);
	// The body is the instructions, not the header.
	assert.strictEqual(parsed.body, 'You are explore-agent.');
});

test('parseFrontmatter accepts inline lists, quotes and CRLF, and a file without a header', () => {
	const inline = parseFrontmatter('---\r\nname: "jd-judge-a"\r\ntools: [read, bash]\r\n---\r\nJudge it.\r\n');
	assert.strictEqual(frontmatterText(inline, 'name'), 'jd-judge-a');
	assert.deepStrictEqual(frontmatterList(inline, 'tools'), ['read', 'bash']);
	assert.strictEqual(inline.body, 'Judge it.');

	// No header at all: the whole file is the instructions, and the name comes from the file.
	const plain = parseFrontmatter('Just instructions.');
	assert.deepStrictEqual(plain.data, {});
	assert.strictEqual(plain.body, 'Just instructions.');

	// A header that is only a header: no instructions to run.
	assert.strictEqual(parseFrontmatter('---\nname: empty\n---\n').body, '');
});

test('frontmatterText and frontmatterList answer nothing for a missing or wrong-shaped field', () => {
	const parsed = parseFrontmatter('---\nempty:\ndescription:   \ntools:\n---\nBody');
	assert.strictEqual(frontmatterText(parsed, 'empty'), undefined);
	assert.strictEqual(frontmatterText(parsed, 'description'), undefined);
	assert.strictEqual(frontmatterText(parsed, 'missing'), undefined);
	assert.deepStrictEqual(frontmatterList(parsed, 'missing'), []);
	assert.deepStrictEqual(frontmatterList(parsed, 'tools'), []);
});

/* ------------------------------------------------------------------ *
 * Agents
 * ------------------------------------------------------------------ */

test('agentRoots follows the runtime: the profile first, then each folder, and subagents last', () => {
	assert.deepStrictEqual(agentRoots(PROFILE, []).map(root => ({ dir: toPosix(root.dir), source: root.source })), [
		{ dir: '/profile/agents', source: 'user' },
		{ dir: '/profile/subagents', source: 'user' },
	]);

	const roots = agentRoots(PROFILE, [FOLDER, '/other']);
	assert.deepStrictEqual(roots.map(root => toPosix(root.dir)), [
		'/profile/agents',
		'/profile/subagents',
		'/project/.pi/agents',
		'/project/.pi/subagents',
		'/other/.pi/agents',
		'/other/.pi/subagents',
	]);
	assert.deepStrictEqual(roots.slice(2).map(root => root.source), ['local', 'local', 'local', 'local']);
});

test('discoverAgents reads the profile and the project, sorts by name and lets the project win', () => {
	const read = fakeFs({
		'/profile/agents/jd-judge-a.md': agentFile('jd-judge-a', 'The profile copy.'),
		'/profile/agents/worker-agent.md': agentFile('worker-agent', 'Bounded implementation.'),
		'/profile/agents/notes.md': 'No header, just instructions.',
		'/profile/agents/nested/ignored.md': agentFile('nested', 'Not directly under agents.'),
		'/profile/agents/empty.md': '---\nname: empty\n---\n',
		'/project/.pi/agents/jd-judge-a.md': agentFile('jd-judge-a', 'The project copy.'),
		'/project/.pi/subagents/sdd-apply.md': agentFile('sdd-apply', 'Apply a change.'),
	});

	const agents = discoverAgents(agentRoots(PROFILE, [FOLDER]), read);

	assert.deepStrictEqual(agents.map(agent => agent.name), ['jd-judge-a', 'notes', 'sdd-apply', 'worker-agent']);
	// The project's copy replaced the profile's, and `subagents/` beats `agents/` in its scope.
	assert.strictEqual(agents[0].description, 'The project copy.');
	assert.strictEqual(agents[0].source, 'local');
	// A file with no header is still an agent, named after itself.
	assert.strictEqual(agents[1].description, undefined);
	assert.strictEqual(agents[3].source, 'user');
	// A header with no instructions is not an agent, and a nested file is not one either.
	assert.ok(!agents.some(agent => agent.name === 'empty' || agent.name === 'nested'));
});

test('discoverAgents reads the `.agent.md` names the installer writes', () => {
	const read = fakeFs({
		'/profile/agents/explore-agent.agent.md': agentFile('explore-agent', 'Exploration.'),
		'/profile/agents/README.txt': 'not an agent',
	});

	const agents = discoverAgents(agentRoots(PROFILE, []), read);

	assert.deepStrictEqual(agents.map(agent => toPosix(agent.file)), ['/profile/agents/explore-agent.agent.md']);
	assert.strictEqual(agents[0].name, 'explore-agent');
});

/* ------------------------------------------------------------------ *
 * Skills
 * ------------------------------------------------------------------ */

test('skillRoots puts the packages first and the project last, so the owner wins', () => {
	const roots = skillRoots(PROFILE, [FOLDER], ['/profile/npm/node_modules/sample-plugin/skills']);

	assert.deepStrictEqual(roots.map(root => ({ dir: toPosix(root.dir), source: root.source })), [
		{ dir: '/profile/npm/node_modules/sample-plugin/skills', source: 'plugin' },
		{ dir: '/profile/skills', source: 'user' },
		{ dir: '/project/.pi/skills', source: 'local' },
	]);
});

test('discoverSkills finds SKILL.md directories, and standalone files only at the root', () => {
	const read = fakeFs({
		'/profile/skills/sample-skill/SKILL.md': '---\nname: sample-skill\ndescription: The harness.\n---\nDo the work.',
		'/profile/skills/_shared/review-ledger-contract.md': 'Shared fragments, not a skill.',
		'/profile/skills/category/deep/SKILL.md': '---\ndescription: Nested.\n---\nBody.',
		'/profile/skills/standalone.md': '---\nname: standalone\n---\nBody.',
		'/profile/skills/.hidden/SKILL.md': '---\nname: hidden\n---\nBody.',
		'/profile/skills/node_modules/pkg/SKILL.md': '---\nname: vendored\n---\nBody.',
	});

	const skills = discoverSkills(skillRoots(PROFILE, []), read);

	// `_shared` holds a document, not a skill; a dot-directory and `node_modules` are never walked.
	assert.deepStrictEqual(skills.map(skill => skill.name), ['deep', 'sample-skill', 'standalone']);
	assert.strictEqual(skills[1].description, 'The harness.');
	// A skill is named by its folder when its header does not name it.
	assert.strictEqual(skills[0].name, 'deep');
	assert.ok(!skills.some(skill => skill.name === 'review-ledger-contract' || skill.name === 'hidden' || skill.name === 'vendored'));
});

test('discoverSkills keeps one row per name, and the profile copy is the one that survives', () => {
	const body = '---\nname: sample-skill\ndescription: The harness.\n---\nDo the work.';
	const read = fakeFs({
		// pi installs a package's skills into the profile too, so the same skill is on disk twice.
		'/profile/npm/node_modules/sample-plugin/skills/sample-skill/SKILL.md': body,
		'/profile/skills/sample-skill/SKILL.md': body,
		// A project may override a name of its own; then the project's file is the one that wins.
		'/project/.pi/skills/branch-pr/SKILL.md': '---\ndescription: The project copy.\n---\nBody.',
		'/profile/skills/branch-pr/SKILL.md': '---\ndescription: The profile copy.\n---\nBody.',
	});

	const skills = discoverSkills(skillRoots(PROFILE, [FOLDER], ['/profile/npm/node_modules/sample-plugin/skills']), read);

	assert.deepStrictEqual(skills.map(skill => skill.name), ['branch-pr', 'sample-skill']);
	assert.strictEqual(skills.length, 2);
	assert.strictEqual(skills[0].description, 'The project copy.');
	assert.strictEqual(skills[0].source, 'local');
	assert.strictEqual(toPosix(skills[1].file), '/profile/skills/sample-skill/SKILL.md');
	assert.strictEqual(skills[1].source, 'user');
});

test('the walk does not descend into a directory that already holds a SKILL.md', () => {
	const read = fakeFs({
		'/profile/skills/one/SKILL.md': '---\nname: one\n---\nBody.',
		'/profile/skills/one/references/SKILL.md': '---\nname: nested-reference\n---\nBody.',
	});

	const skills = discoverSkills(skillRoots(PROFILE, []), read);

	assert.deepStrictEqual(skills.map(skill => skill.name), ['one']);
});

/* ------------------------------------------------------------------ *
 * Telling the chat that something changed
 * ------------------------------------------------------------------ */

test('coalesce runs once for a burst of changes, and again for the next one', () => {
	const scheduled: Array<{ run: () => void; delayMs: number }> = [];
	let fired = 0;
	const trigger = coalesce(200, (run, delayMs) => scheduled.push({ run, delayMs }), () => { fired += 1; });

	// A save, a checkout and an install in a row: one scheduled run, at the delay asked for.
	trigger();
	trigger();
	trigger();
	assert.strictEqual(scheduled.length, 1);
	assert.strictEqual(scheduled[0].delayMs, 200);
	assert.strictEqual(fired, 0);

	scheduled[0].run();
	assert.strictEqual(fired, 1);

	// Nothing is pending any more, so the next change is scheduled again.
	trigger();
	assert.strictEqual(scheduled.length, 2);
});
