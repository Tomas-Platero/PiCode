/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

/**
 * pi's **agents** and **skills**, as the editor's chat needs to see them.
 *
 * The chat's management page has to list what the pi in force actually loads, and pi keeps its own
 * customizations in its own places — never in the GitHub/Copilot folders the editor looks at by
 * itself. This module finds them, from the profile in force (`runtime.ts`, same discipline as
 * `status-data.ts`: pi's profile for the internal runtime, the machine's for the external one) and
 * from the open folders.
 *
 * ## The directories are pi's, not ours
 *
 * Every path below was read off the runtime that loads it, so nothing here is invented:
 *
 * - Agents: the runtime's agent config — `<profile>/agents`, `<profile>/subagents`,
 *   `<workspace>/.pi/agents`, `<workspace>/.pi/subagents`. Discovery order is **precedence**
 *   order there: a later directory replaces an earlier definition of the same name, so the project
 *   beats the profile and `subagents/` beats `agents/` within each scope. That is exactly the rule
 *   implemented here.
 * - Skills: pi's `docs/skills.md` and `dist/core/package-manager.js:203` — a skill is a directory
 *   containing `SKILL.md`, discovered recursively under `<profile>/skills`, `<workspace>/.pi/skills`
 *   and a package's own skill directory. At the **root** of a pi skill directory a standalone
 *   `.md` file is a skill too (`mode === "pi" && dir === root`); nested standalone files are not.
 * - The two directories pi also reads that this module deliberately does **not**: the Agent Skills
 *   locations `<home>/.agents/skills` and `<workspace>/.agents/skills` (`package-manager.js:1976`),
 *   because reaching into the machine's home is not this connector's business. Reported, not faked.
 *
 * ## No `vscode` import
 *
 * The discovery and the frontmatter parsing are the parts worth exercising, and `node --test` runs
 * this file directly (Node's own type stripping, which is also why the sibling modules are imported
 * for types only). What needs the editor — the providers, the watchers, the `Uri`s — is in
 * `extension.ts`.
 */

/** Where the chat shows a resource came from. The values of `vscode.ChatResourceSource`. */
export type ResourceSource = 'user' | 'local' | 'plugin';

/** One entry of a directory, reduced to what the walk needs. */
export interface DirectoryEntry {
	readonly name: string;
	readonly directory: boolean;
}

/**
 * The filesystem, as this module uses it.
 *
 * Injected rather than called directly so the walk can be exercised with a made-up tree: a missing
 * directory, a file nobody can read, or a name that is a file in one test and a directory in the
 * next are all things that decide what the owner sees, and none of them needs a real disk.
 */
export interface FsReader {
	/** The entries of `dir`, or an empty list when it does not exist or cannot be read. */
	entries(dir: string): readonly DirectoryEntry[];
	/** The file's text, or `undefined` when it does not exist or cannot be read. */
	text(file: string): string | undefined;
	/** Whether anything is there at all. */
	exists(target: string): boolean;
}

/** Whether a path is a directory, following a symlink when it is one. */
function isDirectory(target: string): boolean {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

/** The real filesystem, for the editor to hand to the discovery below. */
export function nodeFs(): FsReader {
	return {
		entries(dir) {
			try {
				return readdirSync(dir, { withFileTypes: true }).map(entry => ({
					name: entry.name,
					// A symlinked directory is a directory: pi follows them (`statSync` in
					// `collectSkillEntries`), and a skill tree reached through one is real.
					directory: entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(path.join(dir, entry.name))),
				}));
			} catch {
				// Absent or unreadable is "nothing there", which is what the first run is.
				return [];
			}
		},
		text(file) {
			try {
				return readFileSync(file, 'utf8');
			} catch {
				return undefined;
			}
		},
		exists(target) {
			try {
				statSync(target);
				return true;
			} catch {
				return false;
			}
		},
	};
}

/* ------------------------------------------------------------------ *
 * Frontmatter
 * ------------------------------------------------------------------ */

/** One frontmatter block: its keys and the file's body after it. */
export interface Frontmatter {
	readonly data: Readonly<Record<string, string | readonly string[]>>;
	readonly body: string;
}

function unquoted(value: string): string {
	const trimmed = value.trim();
	const quoted = (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"));
	return quoted && trimmed.length >= 2 ? trimmed.slice(1, -1) : trimmed;
}

function inlineList(value: string): string[] {
	return value.slice(1, -1).split(',').map(unquoted).filter(item => item.length > 0);
}

/**
 * Just enough YAML for an agent or a skill header: `key: scalar`, `key: [a, b]`, and `key:`
 * followed by `- item` lines.
 *
 * The same three shapes, and the same "anything else stays a plain string" rule, the runtime's
 * own `parseFrontmatter` implements — because these are the same files it parses, and a header
 * it reads as a list must not become a sentence here.
 */
export function parseFrontmatter(text: string): Frontmatter {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!match) {
		return { data: {}, body: text.trim() };
	}
	const data: Record<string, string | readonly string[]> = {};
	let listKey: string | undefined;
	for (const raw of match[1].split(/\r?\n/)) {
		const item = /^\s*-\s+(.*)$/.exec(raw);
		if (item && listKey !== undefined) {
			(data[listKey] as string[]).push(unquoted(item[1]));
			continue;
		}
		const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
		if (!pair) {
			continue;
		}
		const trimmed = pair[2].trim();
		if (trimmed.length === 0) {
			// A key with nothing after it introduces the `- item` list that follows.
			data[pair[1]] = [];
			listKey = pair[1];
			continue;
		}
		listKey = undefined;
		data[pair[1]] = trimmed.startsWith('[') && trimmed.endsWith(']') ? inlineList(trimmed) : unquoted(trimmed);
	}
	return { data, body: match[2].trim() };
}

/** A scalar header field, trimmed; lists and absent keys are not one. */
export function frontmatterText(frontmatter: Frontmatter, key: string): string | undefined {
	const value = frontmatter.data[key];
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

/** A header field as a list, accepting the comma-separated form too. */
export function frontmatterList(frontmatter: Frontmatter, key: string): readonly string[] {
	const value = frontmatter.data[key];
	if (value === undefined) {
		return [];
	}
	const items: readonly string[] = typeof value === 'string' ? value.split(',') : value;
	return items.map(item => item.trim()).filter(item => item.length > 0);
}

/* ------------------------------------------------------------------ *
 * Agents
 * ------------------------------------------------------------------ */

/** A directory to look in, and where what it holds came from. */
export interface ResourceRoot {
	readonly dir: string;
	readonly source: ResourceSource;
}

/** One agent file, as the chat needs it. */
export interface AgentResource {
	/** The definition's name: its `name` header, or the file's own name. */
	readonly name: string;
	readonly description?: string;
	/** The agent file itself. */
	readonly file: string;
	readonly source: ResourceSource;
}

/** The file suffix an agent definition can have. */
const MARKDOWN = '.md';

/**
 * Where pi's agents are, in precedence order — later wins.
 *
 * The runtime's `agentDirectories` is the authority, including its choice to place `subagents/`
 * after `agents/` inside each scope.
 */
export function agentRoots(profileDir: string, workspaceFolders: readonly string[]): readonly ResourceRoot[] {
	const roots: ResourceRoot[] = [
		{ dir: path.join(profileDir, 'agents'), source: 'user' },
		{ dir: path.join(profileDir, 'subagents'), source: 'user' },
	];
	for (const folder of workspaceFolders) {
		roots.push(
			{ dir: path.join(folder, '.pi', 'agents'), source: 'local' },
			{ dir: path.join(folder, '.pi', 'subagents'), source: 'local' },
		);
	}
	return roots;
}

/** The `.md` files directly under `dir`, sorted, or nothing when it is not there. */
function markdownFiles(dir: string, read: FsReader): readonly string[] {
	return read.entries(dir)
		.filter(entry => !entry.directory && entry.name.toLowerCase().endsWith(MARKDOWN))
		.map(entry => entry.name)
		.sort();
}

/** The definition an agent file holds, or `undefined` when it holds no instructions. */
export function agentFrom(file: string, text: string, source: ResourceSource): AgentResource | undefined {
	const frontmatter = parseFrontmatter(text);
	if (frontmatter.body.length === 0) {
		// A header with nothing after it defines nothing to run; the runtime treats it as an
		// error and leaves the file out, and so does this.
		return undefined;
	}
	const declared = frontmatterText(frontmatter, 'name');
	const description = frontmatterText(frontmatter, 'description');
	return {
		name: declared ?? path.basename(file).replace(/\.md$/i, ''),
		...(description === undefined ? {} : { description }),
		file,
		source,
	};
}

/**
 * Every agent of the profile and the open folders, one entry per **name**.
 *
 * A later root replaces an earlier definition with the same name — the project's `jd-judge-a`
 * wins over the profile's copy, which is what pi does — and the result is sorted by name so the
 * list does not jump around between listings.
 */
export function discoverAgents(roots: readonly ResourceRoot[], read: FsReader): readonly AgentResource[] {
	const agents = new Map<string, AgentResource>();
	for (const root of roots) {
		for (const name of markdownFiles(root.dir, read)) {
			const file = path.join(root.dir, name);
			const text = read.text(file);
			if (text === undefined) {
				continue;
			}
			const agent = agentFrom(file, text, root.source);
			if (agent !== undefined) {
				agents.set(agent.name, agent);
			}
		}
	}
	return [...agents.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/* ------------------------------------------------------------------ *
 * Skills
 * ------------------------------------------------------------------ */

/** The file that makes a directory a skill. */
export const SKILL_FILE = 'SKILL.md';

/** One skill, as the chat needs it. */
export interface SkillResource {
	/** The skill's name: its `name` header, or the folder that holds it. */
	readonly name: string;
	readonly description?: string;
	/** The skill's `SKILL.md`. */
	readonly file: string;
	readonly source: ResourceSource;
}

/**
 * How deep the walk below goes before it gives up.
 *
 * pi itself walks without a limit; a cap keeps a pathological tree from turning a listing into a
 * long walk while still reaching every layout pi documents (a category folder with skills under
 * it). Deeper trees are reported as a known gap rather than silently half-listed.
 */
const MAX_SKILL_DEPTH = 4;

/** The directories under `dir` worth descending into: no hidden ones, never `node_modules`. */
function subdirectories(dir: string, read: FsReader): readonly string[] {
	return read.entries(dir)
		.filter(entry => entry.directory && !entry.name.startsWith('.') && entry.name !== 'node_modules')
		.map(entry => entry.name)
		.sort();
}

/**
 * The skill files under one root.
 *
 * The rules are pi's: a directory holding a `SKILL.md` **is** a skill and is not searched further;
 * otherwise the walk descends. A standalone `.md` file counts only at the root of the root, which
 * is where pi accepts one.
 */
function skillFiles(root: string, read: FsReader): readonly string[] {
	const found: string[] = [];
	const walk = (dir: string, depth: number): void => {
		const entries = read.entries(dir);
		if (entries.some(entry => !entry.directory && entry.name === SKILL_FILE)) {
			found.push(path.join(dir, SKILL_FILE));
			return;
		}
		if (depth === 0) {
			for (const entry of entries) {
				if (!entry.directory && entry.name.toLowerCase().endsWith(MARKDOWN)) {
					found.push(path.join(dir, entry.name));
				}
			}
		}
		if (depth >= MAX_SKILL_DEPTH) {
			return;
		}
		for (const name of subdirectories(dir, read)) {
			walk(path.join(dir, name), depth + 1);
		}
	};
	walk(root, 0);
	return found;
}

/** One skill, or `undefined` when the file holds no `name` and no usable folder name. */
function skillFrom(file: string, text: string, source: ResourceSource): SkillResource | undefined {
	const frontmatter = parseFrontmatter(text);
	// pi's own name for a skill is the folder that holds it (`getSkillFolderName` on the editor's
	// side works the same way), and the header's `name` is the portable spelling of it.
	const folder = path.basename(path.dirname(file));
	const declared = frontmatterText(frontmatter, 'name');
	const name = declared ?? (path.basename(file).toLowerCase() === SKILL_FILE.toLowerCase() ? folder : path.basename(file).replace(/\.md$/i, ''));
	if (name.length === 0) {
		return undefined;
	}
	const description = frontmatterText(frontmatter, 'description');
	return {
		name,
		...(description === undefined ? {} : { description }),
		file,
		source,
	};
}

/**
 * Where pi's skills are, in precedence order — later wins.
 *
 * A package's skills come first so that the owner's own copy of the same skill wins: a package
 * installs its skills **into** `<profile>/skills` (the same files, byte-identical in both
 * places), and listing the package's copy as well would show every skill twice.
 */
export function skillRoots(
	profileDir: string,
	workspaceFolders: readonly string[],
	packageDirs: readonly string[] = [],
): readonly ResourceRoot[] {
	const roots: ResourceRoot[] = packageDirs.map(dir => ({ dir, source: 'plugin' as ResourceSource }));
	roots.push({ dir: path.join(profileDir, 'skills'), source: 'user' });
	for (const folder of workspaceFolders) {
		roots.push({ dir: path.join(folder, '.pi', 'skills'), source: 'local' });
	}
	return roots;
}

/** Every skill of the profile, the open folders and the installed packages, one entry per name. */
export function discoverSkills(roots: readonly ResourceRoot[], read: FsReader): readonly SkillResource[] {
	const skills = new Map<string, SkillResource>();
	for (const root of roots) {
		for (const file of skillFiles(root.dir, read)) {
			const text = read.text(file);
			if (text === undefined) {
				continue;
			}
			const skill = skillFrom(file, text, root.source);
			if (skill !== undefined) {
				skills.set(skill.name, skill);
			}
		}
	}
	return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/* ------------------------------------------------------------------ *
 * Telling the chat that something changed
 * ------------------------------------------------------------------ */

/**
 * Calls `fire` at most once per `delayMs`, after the last trigger.
 *
 * A file watcher fires once per file of a save, and a whole-tree write (an install, a `git
 * checkout`) fires it many times in a row; every one of those would make the editor re-read and
 * re-list the customizations. Dropping the triggers that arrive inside the window is safe here
 * because the run they were coalesced into reads what is on disk **at that moment**, not what the
 * event said — so the last change of a burst is never the one that is lost.
 *
 * The wait is handed to `schedule`, which is injected so the coalescing can be exercised without
 * waiting for a clock.
 */
export function coalesce(delayMs: number, schedule: (run: () => void, delayMs: number) => void, fire: () => void): () => void {
	let pending = false;
	return () => {
		if (pending) {
			return;
		}
		pending = true;
		schedule(() => {
			pending = false;
			fire();
		}, delayMs);
	};
}
