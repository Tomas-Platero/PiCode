/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The files a turn changed, counted and diffable.
 *
 * pi reports every file mutation with a structured event — `edit` arrives with
 * `{ path, edits }`, `write` with `{ path, content }` — but the chat only shows a one-line
 * "edit src/app.ts" while it runs: the *what changed* has nowhere to land. The owner asked
 * for it as «quiero ver qué ha cambiado en el chat», meaning the card the editor already
 * knows how to render: "Changed N files", one row per file with +N/−M, a click that opens
 * the diff.
 *
 * This module is the ledger those events feed. When a mutating tool starts, the file on disk
 * is snapshotted (that is the only moment the "before" exists — by the time the result
 * arrives, the file is already written). When the tool ends, the file is read back and the
 * lines each side gained and lost are counted. At the end of the turn the bridge turns the
 * ledger into one `ChatResponseMultiDiffPart`.
 *
 * Coverage is honest and narrow: only `edit` and `write`, the two tools whose events arrive
 * structured. A file a shell command changed is not counted, because a command's arguments
 * do not name its writes.
 *
 * The diffs themselves are the editor's multi-diff editor's job, not ours: this module only
 * counts, snapshots, and answers "what did this file read before". The bridge registers a
 * `TextDocumentContentProvider` on the before-scheme that serves those snapshots. No
 * `vscode` import here: it is arithmetic and bookkeeping, and both can be exercised by
 * running it.
 */

/** The tools whose structured arguments name the file they write. */
const FILE_MUTATION_TOOLS = new Set(['edit', 'write']);

/**
 * The URI scheme the diff's "before" side is served on.
 *
 * The multi-diff editor opens a diff between two documents; the modified side is the real
 * file, and the original side is the snapshot this turn took — a document that exists
 * nowhere on disk. A `TextDocumentContentProvider` on this scheme is what serves it (the
 * bridge registers it; see the connector).
 */
export const PICODE_BEFORE_SCHEME = 'picode-before';

/** The URI path a snapshot is served under: the whole absolute path, encoded, after a slash. */
export function beforeUriPathOf(absolutePath: string): string {
	return `/${encodeURIComponent(absolutePath)}`;
}

/** The absolute path a snapshot URI carries, the exact inverse of {@link beforeUriPathOf}. */
export function absolutePathOfBeforeUriPath(uriPath: string): string {
	return decodeURIComponent(uriPath.replace(/^\//, ''));
}

/** Whether this tool's start/end events can be ledgered. */
export function isFileMutationTool(toolName: unknown): boolean {
	return typeof toolName === 'string' && FILE_MUTATION_TOOLS.has(toolName);
}

/**
 * The file a mutating tool's arguments name, as the tool schema declares it: both `edit`
 * (`{ path, edits }`) and `write` (`{ path, content }`) carry exactly one.
 */
export function mutatedPathOf(args: unknown): string | undefined {
	if (typeof args !== 'object' || args === null) {
		return undefined;
	}
	const path = (args as { readonly path?: unknown }).path;
	return typeof path === 'string' && path.length > 0 ? path : undefined;
}

/** One changed file, as the turn's card will show it. */
export interface TurnFileEdit {
	/** Absolute path on disk. */
	readonly path: string;
	/** The content read before the tool ran; absent for a file that did not exist. */
	readonly before?: string;
	/** The content read after the tool ended. */
	readonly after: string;
	readonly added: number;
	readonly removed: number;
	/** True when the tool created the file rather than changing it. */
	readonly isNew: boolean;
}

/**
 * The snapshots, keyed by absolute path. A file edited twice in one turn keeps its first
 * "before" — that is the base the whole turn's change is measured against — and its last
 * "after".
 *
 * `null` marks a file that did not exist when the tool started, so a failed read is never
 * re-read (and never mistaken for a pending read).
 */
const beforeContent = new Map<string, string | null>();
const afterContent = new Map<string, string>();
/** The order the files first changed in, so the card lists them as they happened. */
const changedOrder: string[] = [];
/** The final ledger, filled by `recordAfter` once both reads have settled. */
const ledger = new Map<string, TurnFileEdit>();

/**
 * Every read in flight, chained so `whenEditsSettled` can wait for the last one. Reads are
 * fire-and-forget where the events arrive (the subscription is synchronous), but the turn
 * must not end before they land — hence one promise that only ever grows.
 */
let pendingReads: Promise<void> = Promise.resolve();

/** How many files keep their snapshot. Bounded memory: the oldest give way. */
const MAX_TRACKED_FILES = 64;
/** The paths whose snapshot is still held, oldest first — the eviction queue. */
const snapshotQueue: string[] = [];

/** Clears the per-turn ledger. Called when a turn starts. */
export function clearTurnEdits(): void {
	beforeContent.clear();
	afterContent.clear();
	changedOrder.length = 0;
	snapshotQueue.length = 0;
	ledger.clear();
	pendingReads = Promise.resolve();
}

/** Reads a file as UTF-8, or `undefined` when it does not exist or cannot be read. */
export type FileRead = (absolutePath: string) => Promise<string | undefined>;

/**
 * Snapshots the file before its tool runs. Fire-and-forget: the subscription that calls
 * this is synchronous, so the read chains onto `pendingReads` instead of being awaited.
 */
export function snapshotBefore(absolutePath: string, readFile: FileRead): void {
	if (beforeContent.has(absolutePath)) {
		return; // The first snapshot of a turn is the one the change is measured against.
	}
	beforeContent.set(absolutePath, null); // Reserved: a second tool call on the same file must not re-read.
	pendingReads = pendingReads.then(async () => {
		const content = await readFile(absolutePath).catch(() => undefined);
		if (content === undefined) {
			beforeContent.set(absolutePath, null);
			return;
		}
		beforeContent.set(absolutePath, content);
	});
}

/**
 * Records the file after its tool ended, and closes its ledger entry once the snapshot read
 * (if any) has landed. A failed tool did not change the file, so only success records.
 */
export function recordAfter(absolutePath: string, readFile: FileRead): void {
	pendingReads = pendingReads.then(async () => {
		const after = await readFile(absolutePath).catch(() => undefined);
		if (after === undefined) {
			return;
		}
		afterContent.set(absolutePath, after);
		if (!changedOrder.includes(absolutePath)) {
			changedOrder.push(absolutePath);
		}
		if (!snapshotQueue.includes(absolutePath)) {
			snapshotQueue.push(absolutePath);
			evictOldest();
		}
		const before = beforeContent.get(absolutePath) ?? null;
		const isNew = before === null;
		const [added, removed] = isNew
			? [countLines(after), 0]
			: countLineChanges(before, after);
		ledger.set(absolutePath, {
			path: absolutePath,
			...(isNew ? {} : { before: before as string }),
			after,
			added,
			removed,
			isNew,
		});
	});
}

/** Keeps the snapshot store bounded: the oldest held snapshots give way first.
 *
 * The ledger itself is never trimmed — the card of this turn needs every file —
 * only the heavy "before" text goes, and with it the ability to open that
 * file's diff in the multi-diff editor.
 */
function evictOldest(): void {
	while (snapshotQueue.length > MAX_TRACKED_FILES) {
		const oldest = snapshotQueue.shift();
		if (oldest === undefined) {
			return;
		}
		beforeContent.delete(oldest);
	}
}

/**
 * Resolves when every snapshot and re-read this turn started has settled. The bridge awaits
 * this before ending the turn, so the card never misses a file whose read was still in
 * flight — and never waits on one either, because every read catches its own errors.
 */
export function whenEditsSettled(): Promise<void> {
	return pendingReads;
}

/** The turn's changed files, in the order they first changed. */
export function turnFileEdits(): readonly TurnFileEdit[] {
	return changedOrder
		.map(path => ledger.get(path))
		.filter((entry): entry is TurnFileEdit => entry !== undefined);
}

/**
 * The content a file had before this session touched it, for the before-scheme content
 * provider. `undefined` when there is no snapshot (evicted, or the file is new).
 */
export function beforeContentFor(absolutePath: string): string | undefined {
	const content = beforeContent.get(absolutePath);
	return typeof content === 'string' ? content : undefined;
}

/** Line count, forgiving the trailing newline every text file ends with. */
function countLines(content: string): number {
	const lines = content.split('\n');
	if (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines.length;
}

/**
 * Lines gained and lost between two versions of a file, by longest common subsequence.
 *
 * A proper diff would compute minimal hunks; a card row needs only the two counts, and an
 * LCS of lines gives both without a diff library. The table is capped: beyond it the
 * counters fall back to "everything changed", which is the honest answer for a wholesale
 * rewrite and costs nothing to compute.
 */
export function countLineChanges(before: string, after: string): readonly [added: number, removed: number] {
	const a = before.split('\n');
	const b = after.split('\n');
	// The trailing newline splits into a final empty element on both sides; dropping it
	// keeps a file rewritten without a line-count change from reading as a change.
	if (a.length > 0 && a[a.length - 1] === '') {
		a.pop();
	}
	if (b.length > 0 && b[b.length - 1] === '') {
		b.pop();
	}
	if (a.length === 0 && b.length === 0) {
		return [0, 0];
	}
	if (a.length === 0) {
		return [b.length, 0];
	}
	if (b.length === 0) {
		return [0, a.length];
	}
	if (a.length === b.length && a.every((line, i) => line === b[i])) {
		return [0, 0];
	}

	// Two rows are enough for an LCS: each row only reads the one before it.
	if (a.length * b.length > LCS_CELL_CAP) {
		return [b.length, a.length];
	}
	let previous = new Uint32Array(b.length + 1);
	let current = new Uint32Array(b.length + 1);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			current[j] = a[i - 1] === b[j - 1]
				? previous[j - 1] + 1
				: Math.max(previous[j], current[j - 1]);
		}
		[previous, current] = [current, previous];
	}
	const common = previous[b.length];
	return [b.length - common, a.length - common];
}

/** Above this many table cells the LCS falls back to "everything changed". */
const LCS_CELL_CAP = 25_000_000;
