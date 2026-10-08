/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
	/**
	 * The transcript this one was launched from, when its own header names a `parentSession`.
	 *
	 * pi files a **delegation** — a subagent's work, a fork — as a session of its own, under
	 * the same project folder as the conversation that launched it, with the launching
	 * transcript's path in its header. That one field is the difference between a conversation
	 * the owner had and an agent the editor ran: without it a single prompt that asked for three
	 * agents leaves four rows that look alike, and the agents crowd the conversations out of the
	 * panel's per-project cap.
	 */
	readonly parent?: string;
	/**
	 * The role of the transcript's own **last** message entry.
	 *
	 * pi appends an entry once its message is complete, so the last entry is what the turn is
	 * doing: `assistant` — the agent answered and owes nothing; `user` or `toolResult` — it was
	 * handed something and still owes an answer. `undefined` when the file carries no message at
	 * all. It is the only state signal an append-only transcript holds, and it is read, never
	 * guessed from a clock.
	 */
	readonly lastRole?: 'user' | 'assistant' | 'toolResult';
}

/**
 * The transcripts the panel lists: the **conversations**, never the agents' own.
 *
 * A delegation is a session of its own on disk (see `PiSessionFile.parent`) and belongs in the
 * agents view, which exists for it. Leaving it in the conversations list is not merely noise:
 * the panel caps each project at eight rows, so a prompt that launched three agents pushes the
 * owner's own conversations past the cap — they leave the list while the agents are written and
 * come back afterwards.
 */
export function conversationFiles(files: readonly PiSessionFile[]): PiSessionFile[] {
	return files.filter(file => file.parent === undefined);
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

/**
 * The separator `withContext` puts between what the editor adds and what the owner wrote
 * (`context.ts`): who the agent is, then the editor's context, then `---`, then the request.
 */
const CONTEXT_SEPARATOR = '\n\n---\n\n';

/**
 * The owner's own words in an opening message.
 *
 * Every message the editor sends is prefixed with a frame naming the agent and what the editor
 * is showing, and that frame ends with `CONTEXT_SEPARATOR`. The list is a list of the owner's
 * conversations, so the label has to be what **he** wrote: labelling with the frame is how seven
 * rows end up reading exactly the same, which is what his own screenshot shows. Nothing is
 * guessed — a message the frame did not produce (a conversation written by the pi CLI) has no
 * separator before it and is returned whole, and a frame with nothing after it is left as it is
 * rather than becoming an empty label.
 */
export function ownerPrompt(text: string): string {
	const at = text.indexOf(CONTEXT_SEPARATOR);
	// The frame is the only thing that precedes the separator, and both frames say where they come
	// from. A horizontal rule the owner typed himself is not a frame, and must not cut his text.
	if (at === -1 || !text.slice(0, at).includes('PiCode editor')) {
		return text;
	}
	const asked = text.slice(at + CONTEXT_SEPARATOR.length).trim();
	return asked.length > 0 ? asked : text;
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
	/**
	 * The entries of a directory, or `undefined` when it could not be read at all.
	 *
	 * The difference is the whole point: an empty directory means "there are no sessions here", and
	 * a directory that could not be read means **nothing at all** — and on Windows the second is
	 * real and momentary (the profile is being written while the panel asks). A walk that cannot
	 * tell them apart publishes its own failure as "your sessions are gone", which is exactly what
	 * the owner kept seeing.
	 */
	list(dir: string): string[] | undefined;
	mtime(file: string): number;
}

/**
 * What a walk produced, and whether it could finish.
 *
 * `complete` is the difference between "these projects have no sessions" and "I could not read
 * them": a directory that refused to be read (see `SessionsFs.list`) sets it false, and a caller
 * that cares — the panel — holds what it already had instead of publishing the failure as fact.
 */
interface WalkResult {
	readonly files: PiSessionFile[];
	readonly complete: boolean;
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
			// `undefined`, never `[]`: see the interface. A directory that refused to be read is not an
			// empty one, and saying it is empties the panel.
			return undefined;
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
const listingCache = new Map<string, { mtime: number; label: string; id: string; parent?: string; lastRole?: PiSessionFile['lastRole'] }>();

/** The project slug a transcript's own header records, cached against the mtime it was read at. */
const headerSlugCache = new Map<string, { mtime: number; slug: string | undefined }>();

/**
 * The per-project slug a transcript at the sessions root belongs to, read from its session
 * header's `cwd` (the header is the only place a root-level file names its project).
 * `undefined` when the file does not open with a session record carrying a cwd.
 */
function rootTranscriptSlug(entry: string, fs: SessionsFs): string | undefined {
	const mtime = fs.mtime(entry);
	const cached = headerSlugCache.get(entry);
	if (cached !== undefined && cached.mtime === mtime) {
		return cached.slug;
	}
	const header = sessionHeader(fs.read(entry));
	const cwd = header?.['cwd'];
	const slug = typeof cwd === 'string' && cwd.length > 0 ? piProjectSlug(cwd) : undefined;
	headerSlugCache.set(entry, { mtime, slug });
	return slug;
}

/** Forgets cached header slugs for transcripts the walk no longer sees. */
function pruneHeaderSlugCache(seen: ReadonlySet<string>): void {
	for (const cached of headerSlugCache.keys()) {
		if (!seen.has(cached)) {
			headerSlugCache.delete(cached);
		}
	}
}

/**
 * The hash half of an area slug (`--area-<name>-<hash8>--`), case-folded.
 *
 * The hash covers the area's folder list (see `areaSessionSlug`) and is the part of the
 * slug that actually identifies the area; the name between the dashes is the editor's
 * window name, which is derived, not chosen — the same folders under a re-named window
 * spell a different slug. Matching goes by the hash for exactly that reason.
 */
const AREA_SLUG_HASH = /^--area-.+-([0-9a-f]{8})--$/;

function areaSlugHash(slug: string): string | undefined {
	return AREA_SLUG_HASH.exec(slug)?.[1]?.toLowerCase();
}

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
 * The slugs a window lists conversations from.
 *
 * The owner, twice, and the second time because the first fix read him loosely: «me salen sesiones
 * tanto de proyectos (carpetas) como del workspace. Yo solo quiero ver si estoy en un workspace las
 * de workspace» / «me siguen saliendo todas las sesiones en el workspace al cargar un workspace».
 *
 * So a window that **is** a workspace lists the workspace's own conversations and nothing else: the
 * sessions filed under the area's slug, which are the ones this window's chats wrote. The folders'
 * sessions are the folders' — a project's history belongs to that project and shows when it is
 * opened on its own, not gathered up by a workspace that happens to contain it. That is the whole
 * point of the area's own filing identity (`workspace-area.ts`): without it every area conversation
 * would read as a session of whichever folder pi happened to run in, and a list of *the workspace's*
 * sessions could not exist.
 *
 * A window that is a single folder lists that folder's, and a workspace with no area identity falls
 * back to the folders rather than to nothing.
 */
export function listedSessionSlugs(
	mode: 'folder' | 'workspace',
	areaSlug: string | undefined,
	workspacePaths: readonly string[],
): string[] {
	if (mode === 'workspace' && areaSlug !== undefined) {
		return [areaSlug];
	}
	return workspacePaths.map(piProjectSlug);
}

/**
 * The prefix every identity of one area shares: `--area-<name>-`.
 *
 * An area slug is `--area-<name>-<hash8>--`, and the hash is what an identity is. The **name** is the
 * workspace's own (`vscode.workspace.name`) and therefore stable, so the prefix is what says "this
 * folder belongs to that workspace" — `undefined` when the slug is not an area's (a project slug, or
 * anything else), in which case there is no family to gather.
 */
export function areaFamilyPrefix(areaSlug: string): string | undefined {
	const match = /^(--area-.+)-[0-9a-f]{8}$/.exec(areaSlug.replace(/--$/, ''));
	return match === null ? undefined : `${match[1]}-`;
}

/**
 * Every folder name on disk that belongs to the same area as `areaSlug`, and whether the
 * directory could be read at all.
 *
 * Two things move an area's filing folder without moving its sessions, and each rule catches
 * what the other misses:
 *
 - the **identity** (the hash): a window without a saved workspace file hashes its folder list,
   and folders open and close as the owner works — `…-513d6f42--` became `…-19976c25--`. Same
   area name, different hash: gathered by the name prefix (`areaFamilyPrefix`).
 - the **name**: a window with no workspace file takes its name from the editor, and the same
   folders can be spelled differently a moment later — the hash covers the folder list and is
   unchanged. Same hash, different name: gathered by the hash (`areaSlugHash`).
 *
 * A saved workspace file pins both (identity is the file's path, name is its own), and then the
 * family is one folder — which is the shape the union collapses to when nothing moved.
 */
function areaFamily(sessionsDir: string, areaSlug: string, fs: SessionsFs): { names: string[]; read: boolean } {
	const entries = fs.list(sessionsDir);
	if (entries === undefined) {
		return { names: [], read: false };
	}
	const prefix = areaFamilyPrefix(areaSlug);
	const hash = areaSlugHash(areaSlug);
	const names = entries.map(entry => path.basename(entry)).filter(name =>
		(prefix !== undefined && name.startsWith(prefix))
		|| (hash !== undefined && areaSlugHash(name) === hash));
	return { names, read: true };
}

/**
 * The conversations of one area, whichever identity they were filed under.
 *
 * An area's identity was once a hash of the folders it had open, and that list is not stable: a
 * window reports one folder while the workspace is still being restored, and the owner opens and
 * closes folders as he works. Every one of those moments renamed the area — `…-513d6f42--` became
 * `…-19976c25--` — and a listing that looked only for the name it had just computed found a folder
 * with no sessions in it and dropped every row («primero me salen 8 sesiones y luego 5»).
 *
 * The sessions do not move when the identity does: they are where they were written. So the listing
 * asks for **every** folder this workspace ever filed under — same area name, any identity — and
 * the current one is only the fall-back for a workspace that has no sessions yet. Nothing is
 * orphaned, and a folder added or removed cannot empty the panel.
 */
export function listAreaConversations(
	sessionsDir: string,
	areaSlug: string,
	cap?: number,
	fs: SessionsFs = nodeFs,
): PiSessionFile[] {
	return areaConversationsReport(sessionsDir, areaSlug, cap, fs).files;
}

/** One area's conversations, and whether the walk could be trusted to have seen them all. */
export interface AreaListing {
	/** The rows, newest first. A readonly property over the list that was just built. */
	readonly files: PiSessionFile[];
	/**
	 * False when a directory that holds these sessions could not be read.
	 *
	 * The panel needs this and not the files alone: an area whose folder refused to be read comes
	 * back with **no** rows, and publishing that as "the area has no sessions" is what emptied the
	 * panel on the owner's machine — while the profile was busy being written, every so often. An
	 * incomplete listing is not a listing of fewer sessions; it is no answer at all.
	 */
	readonly complete: boolean;
}

/**
 * The area's conversations, with the honest answer about whether they could all be read.
 *
 * The directory is read once here, for the family, and again by the walk; **both** reads count. The
 * first is what finds the identities this workspace filed under, the second is what walks into
 * them, and either failing means the area was not really looked at.
 */
export function areaConversationsReport(
	sessionsDir: string,
	areaSlug: string,
	cap?: number,
	fs: SessionsFs = nodeFs,
): AreaListing {
	const family = areaFamily(sessionsDir, areaSlug, fs);
	const report = conversationsReport(sessionsDir, family.names.length > 0 ? family.names : [areaSlug], cap, fs);
	return { files: report.files, complete: family.read && report.complete };
}

/** The conversations filed under the given slugs, with the same honest answer as an area's. */
export function conversationsReport(
	sessionsDir: string,
	slugs: Iterable<string>,
	cap?: number,
	fs: SessionsFs = nodeFs,
): AreaListing {
	const walk = listBySlugs(sessionsDir, new Set(slugs), fs);
	const conversations = conversationFiles(walk.files);
	return {
		files: cap === undefined ? conversations : conversations.slice(0, Math.max(cap, 0)),
		complete: walk.complete,
	};
}

/**
 * Every folder on disk that belongs to the same area as `areaSlug` — same name, any identity.
 *
 * The listing needs them all (above), and so does opening a session by id: a row the panel shows
 * must resolve when it is clicked, and a conversation filed under an identity the current folder
 * list no longer computes is exactly the one that would otherwise not open.
 */
export function areaFamilySlugs(sessionsDir: string, areaSlug: string, fs: SessionsFs = nodeFs): string[] {
	// A read that failed is "no family found", and the caller that needs the difference asks for it
	// itself (`areaConversationsReport`): here the fall-back is the slug it was given.
	return areaFamily(sessionsDir, areaSlug, fs).names;
}

/**
 * The conversations a window shows: every transcript filed under `slugs`, newest first.
 *
 * **One list, because a window is one thing.** The slugs are the window's own
 * (`runtime.ts` `projectSlugsOfWindow()`: the area's when there is one, then each open folder's),
 * so a conversation is listed once and no row has to say which project it belongs to — the
 * owner's own instruction: «Yo solo quiero ver si estoy en un workspace las de workspace», and
 * the label that said *«Artictempest (Workspace) (workspace area)»* was repeating the same word
 * twice on every row. What tells two rows apart is the title and the date, which is what the
 * panel already puts on them.
 *
 * **Conversations, never the agents they launched** (see `conversationFiles`): counting them spent
 * the list on delegations — an afternoon of them pushed the owner's own history out of the panel
 * entirely.
 *
 * `cap` is the caller's, and the panel passes none: the limit existed to stop **one busy project**
 * from turning a list of groups into an endless one, and a single list of the owner's own workspace
 * is what it asks to see, in a panel that scrolls and searches. A cap here would silently hide the
 * older rows with nothing to say they exist — the reading the owner already reported as «salen
 * menos».
 *
 * With no projects to look at the listing is empty, and there is no fall-back to every project
 * in the profile: the panel shows the sessions of what is open, not somebody else's history.
 */
export function listProjectConversations(
	sessionsDir: string,
	slugs: Iterable<string>,
	cap?: number,
	fs: SessionsFs = nodeFs,
): PiSessionFile[] {
	return conversationsReport(sessionsDir, slugs, cap, fs).files;
}

/**
 * Every transcript of the projects the caller named, by slug — the conversations **and** the
 * agents' own transcripts, newest first.
 *
 * This is the walk behind opening a session by id: a transcript the conversations list leaves
 * out (a delegation's) must still open when the agents view asks for it, and the project filter
 * must be the same one the panel used, or the id would resolve in one surface and not the other.
 *
 * A transcript filed directly under `sessions/` (rather than in a project folder — what the
 * editor's chat wrote before it filed them properly) is matched by the cwd its own session header
 * records. On Windows the folder-name match folds case: NTFS does, and the drive letter's case in
 * a workspace path may differ from the case pi recorded when the sessions were created.
 */
export function listProjectSessionFiles(
	sessionsDir: string,
	slugs: Iterable<string>,
	fs: SessionsFs = nodeFs,
): PiSessionFile[] {
	return listBySlugs(sessionsDir, new Set(slugs), fs).files;
}

/**
 * Lists the transcripts filed under the given per-project slugs, newest first. Root-level
 * transcripts match the same way: by the project slug their own session header records.
 */
function listBySlugs(sessionsDir: string, slugs: ReadonlySet<string>, fs: SessionsFs): WalkResult {
	if (slugs.size === 0) {
		return { files: [], complete: true };
	}
	const foldedSlugs = new Set([...slugs].map(slug => slug.toLowerCase()));
	// Area requests match by hash, not by whole name: the name inside an area slug is the
	// editor's window name and it has changed spelling before (saved workspace, re-titled
	// window), which filed the same area under more than one folder. The hash — the part
	// built from the folder list — is the identity; every `--area-…-<hash>--` folder on
	// disk belongs to the group whose requested slug carries the same hash, so a session
	// never leaves the panel because the window's name did.
	const areaHashes = new Set([...slugs].map(areaSlugHash).filter((hash): hash is string => hash !== undefined));
	const matches = (name: string): boolean =>
		slugs.has(name)
		|| (process.platform === 'win32' && foldedSlugs.has(name.toLowerCase()))
		|| (areaHashes.has(areaSlugHash(name) ?? ''));
	const dirs: string[] = [];
	// Transcripts filed directly under `sessions/` — pi itself files every session under a
	// per-project folder, but a session created with an explicit session directory lands at
	// the root, and the editor's chat used to create exactly those. Their project is not
	// their path but their header: read it and match it the way the folders were matched,
	// so conversations the chat has already saved surface without a migration.
	const rootFiles: string[] = [];
	const rootEntries = new Set<string>();
	const entries = fs.list(sessionsDir);
	// The directory itself could not be read: nothing can be said about what is in it.
	if (entries === undefined) {
		return { files: [], complete: false };
	}
	for (const entry of entries) {
		if (entry.endsWith('.jsonl')) {
			rootEntries.add(entry);
			const slug = rootTranscriptSlug(entry, fs);
			if (slug !== undefined && (slugs.has(slug) || (process.platform === 'win32' && foldedSlugs.has(slug.toLowerCase())))) {
				rootFiles.push(entry);
			}
			continue;
		}
		const name = path.basename(entry);
		if (matches(name)) {
			dirs.push(entry);
		}
	}
	const walk = listFromDirs(dirs, rootFiles, fs);
	// The header cache keeps every root transcript seen this refresh, matched or not; the
	// entries left over belong to files that are gone.
	pruneHeaderSlugCache(rootEntries);
	return walk;
}

/**
 * The listing shared by every slug-matched entry point: walks the per-project folders whose
 * names are in `slugs` plus any pre-matched transcript files (`extraFiles` — root-level files
 * a caller matched by their own header), newest first; the label is the first user prompt,
 * falling back to the file's own timestamp.
 *
 * Each transcript's label and id are read from `listingCache` when the file's mtime still
 * matches the cached one, so an unchanged tree costs a `stat` per file instead of a full
 * read of every transcript. Entries for files the walk no longer sees are dropped.
 */
function listFromDirs(roots: readonly string[], extraFiles: readonly string[], fs: SessionsFs): WalkResult {
	const files: PiSessionFile[] = [];
	const stack = [...roots];
	const visited = new Set<string>(stack);
	const seen = new Set<string>();
	let complete = true;
	while (stack.length > 0) {
		const dir = stack.pop()!;
		const entries = fs.list(dir);
		if (entries === undefined) {
			// A project folder that refused to be read: its sessions are missing from this walk, so the
			// walk is incomplete rather than quiet about them.
			complete = false;
			continue;
		}
		for (const entry of entries) {
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
			files.push(describeTranscript(entry, fs));
		}
	}
	// The pre-matched files, described through the same cache; a file both matched at
	// the root and inside a walked project folder is one file, listed once.
	for (const entry of extraFiles) {
		if (!seen.has(entry)) {
			seen.add(entry);
			files.push(describeTranscript(entry, fs));
		}
	}
	for (const cached of listingCache.keys()) {
		if (!seen.has(cached)) {
			listingCache.delete(cached);
		}
	}
	// Newest first, and **the same order every time**: the mtime alone leaves files written
	// together — an import brings a whole tree over at once — in whatever order the directory
	// happened to list them, and a panel that reorders itself with nothing having happened is a
	// panel the owner cannot read. The id, and then the path, settles every tie by content.
	return { files: files.sort((a, b) => (b.mtime - a.mtime) || compareText(a.id, b.id) || compareText(a.file, b.file)), complete };
}

/** A text order that depends on the text alone — no locale, so it is the same on any machine. */
function compareText(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	return a < b ? -1 : 1;
}

/**
 * `next`, with every row whose content did not change kept as the **same object** it was.
 *
 * The bridge that carries these rows to the panel diffs them **by reference** — see
 * `computeItemsDelta` in `extHostChatSessions.ts` — and skips the update entirely when the
 * delta comes out empty. A listing that builds a fresh object per row on every refresh
 * therefore reads, on the panel's side, as *every session changing at once*: the whole list is
 * republished, the model rebuilds a session object for every row, and the view repaints itself
 * — the rows it does not draw for a moment read as sessions that went away and came back.
 * Handing back the row built last time whenever nothing about it changed is what makes an
 * unchanged refresh cost nothing, and a changed one carry only what changed.
 */
export function reuseRows<T>(
	previous: readonly T[],
	next: readonly T[],
	key: (row: T) => string,
	unchanged: (before: T, after: T) => boolean,
): T[] {
	const remembered = new Map<string, T>();
	for (const row of previous) {
		remembered.set(key(row), row);
	}
	return next.map(row => {
		const last = remembered.get(key(row));
		return last !== undefined && unchanged(last, row) ? last : row;
	});
}

/** One transcript's listing entry, from or into the mtime-keyed cache. */
function describeTranscript(entry: string, fs: SessionsFs): PiSessionFile {
	const stat = fs.mtime(entry);
	const cached = listingCache.get(entry);
	// `0` is not a transcript written in 1970: it is a file that could not be read this time
	// round, and pi is appending to the live one while the panel looks at it. Keeping the
	// remembered mtime and label holds that session where the owner last saw it; reporting the
	// epoch and the file's uuid instead would rename one row, sort it below every other one, and
	// — under the panel's per-group cap — drop it out of the listing until the next refresh.
	const mtime = stat === 0 && cached !== undefined ? cached.mtime : stat;
	if (cached !== undefined && cached.mtime === mtime) {
		return { id: cached.id, file: entry, label: cached.label, mtime, parent: cached.parent, lastRole: cached.lastRole };
	}
	// New or modified file: read it once and remember what it says until it moves again. The
	// three questions — which conversation this is, who launched it, and what its last turn is
	// doing — are all answered from that one read.
	const text = fs.read(entry);
	const header = sessionHeader(text);
	const opening = firstUserPrompt(text);
	const firstPrompt = (opening === undefined ? '' : ownerPrompt(opening))
		|| path.basename(entry).replace(/\.jsonl$/, '');
	const idMatch = path.basename(entry).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
	const label = firstPrompt.length > 80 ? `${firstPrompt.slice(0, 80)}…` : firstPrompt;
	const id = idMatch?.[1] ?? path.basename(entry, '.jsonl');
	const parent = typeof header?.parentSession === 'string' ? header.parentSession : undefined;
	const lastRole = lastMessageRole(text);
	listingCache.set(entry, { mtime, label, id, parent, lastRole });
	return { id, file: entry, label, mtime, parent, lastRole };
}

/**
 * The role of the transcript's **last** message entry.
 *
 * Read from the end, because that is where the answer is: pi appends an entry when the message
 * is complete, so a turn still in flight has none yet and the newest message is what it was
 * handed. Entries that are not the agent's own messages (`custom_message`, `context_edit`, a
 * marker) are passed over rather than read as an answer.
 */
function lastMessageRole(text: string): PiSessionFile['lastRole'] {
	const lines = text.split('\n');
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index].trim();
		if (line === '') {
			continue;
		}
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			// A half-written last line, which is what a transcript looks like mid-append.
			continue;
		}
		if (!isRecord(entry) || entry.type !== 'message' || !isRecord(entry.message)) {
			continue;
		}
		const role = entry.message.role;
		if (role === 'user' || role === 'assistant' || role === 'toolResult') {
			return role;
		}
	}
	return undefined;
}

/**
 * The listing the panel may be given when the listing could not be built.
 *
 * A listing is not "nothing to say": the panel takes it literally and removes every row it does not
 * see. So what comes back is a **claim** — "these projects have these sessions" — and it is only
 * true when the projects were known **and** the walk could read everything it needed. Both halves
 * have bitten the owner:
 *
 * - a window whose workspace had not been resolved yet has no project to walk, and that is exactly
 *   when the panel asks (the provider registers as the extension activates);
 * - a directory that refused to be read (Windows, a profile being written while the panel asks)
 *   comes back with no rows at all — the same "everything is gone" as a real deletion, from a
 *   momentary failure nobody sees.
 *
 * While the answer cannot be stood behind, the last real listing is the honest one. `publishable`
 * is what says so: the projects are known **and** the walk was complete.
 */
export function listingForPanel<T>(built: T[], previous: T[] | undefined, publishable: boolean): T[] {
	return !publishable && previous !== undefined ? previous : built;
}

/**
 * Lists every session transcript under the profile's `sessions/` directory, across
 * all of pi's per-project folders. The panel asks for what a window covers instead
 * (`conversationsReport` / `areaConversationsReport`); this remains the unfiltered walk for
 * callers that genuinely want every project.
 */
export function listSessionFiles(sessionsDir: string, fs: SessionsFs = nodeFs): PiSessionFile[] {
	return listFromDirs([sessionsDir], [], fs).files;
}

/* ------------------------------------------------------------------ *
 * The session backup's key rules, beside pi's slug and free of the editor
 * ------------------------------------------------------------------ */

/** One transcript found on disk, ready to be hashed and uploaded. */
export interface PiBackupFile {
	/** The relative key: `<project-slug>/<file name>`. */
	readonly key: string;
	/** The absolute path on this machine. */
	readonly file: string;
	/** Raw size, for the too-large skip rule. */
	readonly bytes: number;
	/** Local modification time (ms), for the rolling-window filter. */
	readonly mtime: number;
}

/** The file system a backup run reads and writes; injectable for tests. */
export interface BackupFs {
	read(file: string): Buffer;
	write(file: string, content: Buffer): void;
	exists(file: string): boolean;
	size(file: string): number;
	mtime(file: string): number;
	isDirectory(file: string): boolean;
	list(dir: string): string[];
}

/** The machine's real file system. */
export const nodeBackupFs: BackupFs = {
	read: file => readFileSync(file),
	write: (file, content) => {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, content);
	},
	exists: file => existsSync(file),
	size: file => statSync(file).size,
	mtime: file => statSync(file).mtimeMs,
	isDirectory: file => {
		try {
			return statSync(file).isDirectory();
		} catch {
			return false;
		}
	},
	list: dir => {
		try {
			return readdirSync(dir);
		} catch {
			// A missing sessions directory is "no sessions", not a crash.
			return [];
		}
	},
};

/** The SHA-1 of a transcript's raw bytes: the identity the incremental run remembers. */
export function sessionContentHash(content: Buffer): string {
	return createHash('sha1').update(content).digest('hex');
}

/**
 * The slug half of a backup key, case-folded where the file system folds case.
 *
 * On Windows a path's case is not part of its identity: NTFS preserves the case it is given
 * but matches without it, and pi records the cwd exactly as the editor handed it over — so
 * the same project can be spelled `C:\demo` in one session and `c:\demo` in another. Two
 * keys differing only in case would back one file up twice and restore it as two projects,
 * so the fold happens at the only two places a key is built, and every later lookup stays
 * an exact one.
 */
function foldBackupSlug(slug: string): string {
	return process.platform === 'win32' ? slug.toLowerCase() : slug;
}

/**
 * Every transcript under the sessions directory, as relative keys.
 *
 * pi files transcripts one directory per project cwd (`piProjectSlug`), each file named
 * `<timestamp>_<session id>.jsonl`; only `*.jsonl` files are backups, anything else in those
 * directories is not a session. A stray file at the root, or a directory that is not a
 * project's, contributes nothing rather than crashing the walk.
 */
export function listSessionBackupFiles(sessionsDir: string, backupFs: BackupFs = nodeBackupFs): PiBackupFile[] {
	const files: PiBackupFile[] = [];
	for (const slug of backupFs.list(sessionsDir)) {
		const projectDir = path.join(sessionsDir, slug);
		if (!backupFs.isDirectory(projectDir)) {
			continue;
		}
		for (const name of backupFs.list(projectDir)) {
			if (!name.endsWith('.jsonl')) {
				continue;
			}
			const file = path.join(projectDir, name);
			try {
				files.push({ key: `${foldBackupSlug(slug)}/${name}`, file, bytes: backupFs.size(file), mtime: backupFs.mtime(file) });
			} catch {
				// A transcript that vanished between the listing and the stat is skipped, not fatal.
			}
		}
	}
	return files;
}

/** The transcript's first record as an object, or `undefined` when the file is not a session transcript. */
function sessionHeader(text: string): Record<string, unknown> | undefined {
	const firstLineEnd = text.indexOf('\n') === -1 ? text.length : text.indexOf('\n');
	try {
		const value: unknown = JSON.parse(text.slice(0, firstLineEnd).trim());
		return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The relative key a transcript's own content spells.
 *
 * pi writes the session's id, timestamp and cwd into the first record, and the file is named
 * after the timestamp and the id inside the project folder of the cwd — so a restored ref can
 * always find its own way home without the key travelling anywhere. `undefined` means the
 * content does not open with a session record and this ref cannot be placed.
 */
export function sessionKeyFromTranscript(text: string): string | undefined {
	const header = sessionHeader(text);
	const id = header?.['id'];
	const timestamp = header?.['timestamp'];
	const cwd = header?.['cwd'];
	if (typeof id !== 'string' || id.length === 0
		|| typeof timestamp !== 'string' || timestamp.length === 0
		|| typeof cwd !== 'string' || cwd.length === 0) {
		return undefined;
	}
	// The file name pi writes: the timestamp with its colons folded to dashes, then the id.
	const name = `${timestamp.replace(/:/g, '-')}_${id}.jsonl`;
	return `${foldBackupSlug(piProjectSlug(cwd))}/${name}`;
}
