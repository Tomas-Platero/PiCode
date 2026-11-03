/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pulls the "What changed" section out of a release body (the grouped summary that
 * build/release.mjs release-notes writes), without its own heading and without the
 * sections that follow it. Returns undefined when the release has no such section.
 */
export function extractWhatChanged(body: string): string | undefined {
	const match = /^##\s+What changed\s*$/m.exec(body);
	if (!match) {
		return undefined;
	}
	const rest = body.slice(match.index + match[0].length);
	const next = /^##\s+(?!#)/m.exec(rest);
	// A horizontal rule closes the section on the release page; it is layout, not part of the summary.
	const section = (next ? rest.slice(0, next.index) : rest).replace(/\r\n/g, '\n').replace(/\n-{3,}\s*$/, '').trim();
	return section || undefined;
}

/** One version's "What changed" summary, as the channel's history file keeps it. */
export interface WhatsNewEntry {
	readonly version: string;
	readonly notes: string;
}

/**
 * Where a channel keeps the summaries of its earlier releases. Each channel keeps only its newest
 * release on GitHub, so the summaries of the ones it replaced live next to the channel's update
 * feed (`build/release.mjs whats-new-history` writes it), on the branch that feed is served from.
 */
export function whatsNewHistoryUrl(quality: string | undefined): string | undefined {
	const branch = quality === 'stable' ? 'master' : quality === 'beta' || quality === 'experimental' ? quality : undefined;
	return branch && `https://raw.githubusercontent.com/Tomas-Platero/PiCode/${branch}/updates/${quality}/whats-new.json`;
}

/** Orders `0.7.10-experimental` after `0.7.9-experimental`: only the numbers count, the channel suffix does not. */
export function compareVersions(a: string, b: string): number {
	const parts = (version: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number);
	const left = parts(a);
	const right = parts(b);
	for (let i = 0; i < 3; i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

/** The well-formed entries of a history file; anything else in it is ignored. */
export function readHistory(history: unknown): WhatsNewEntry[] {
	const versions = (history as { versions?: unknown } | undefined)?.versions;
	if (!Array.isArray(versions)) {
		return [];
	}
	return versions.filter((entry): entry is WhatsNewEntry =>
		typeof entry?.version === 'string' && /^\d+\.\d+\.\d+/.test(entry.version) && typeof entry?.notes === 'string' && entry.notes.trim() !== '');
}

/**
 * What the window shows after updating from `last` to `current`: this version first, then every
 * version in between that the person skipped, newest first, at most `max` of them. `last` empty
 * (nothing known about the version before) shows this version alone.
 */
export function whatsNewSince(last: string, current: WhatsNewEntry, history: readonly WhatsNewEntry[], max = 10): WhatsNewEntry[] {
	const skipped = !last ? [] : history
		.filter(entry => compareVersions(entry.version, last) > 0 && compareVersions(entry.version, current.version) < 0)
		.sort((a, b) => compareVersions(b.version, a.version))
		.filter((entry, i, all) => i === 0 || compareVersions(entry.version, all[i - 1].version) !== 0)
		.slice(0, max);
	return [current, ...skipped];
}

/** One version's summary as it is, or several under a heading each, so it is clear which change came when. */
export function composeWhatsNew(entries: readonly WhatsNewEntry[]): string | undefined {
	if (entries.length === 0) {
		return undefined;
	}
	if (entries.length === 1) {
		return entries[0].notes;
	}
	return entries.map(entry => `## ${entry.version}\n\n${entry.notes.trim()}`).join('\n\n');
}

/**
 * Whether the window opens after this start.
 *
 * `last` is the PiCode version this window was last seen at, kept by the window itself. It is
 * empty on a first install, but ALSO on the first start of the update that brought this window
 * in: the version before it never kept one. `editorLast` tells the two apart. It is the editor
 * version the core's own release-notes check keeps (`releaseNotes/lastVersion`), read before
 * that check overwrites it on this start: present and different from this editor version
 * means the person updated; absent means a first install.
 */
export function shouldShowWhatsNew(state: { last: string; current: string; editorLast: string; editorCurrent: string }): boolean {
	const { last, current, editorLast, editorCurrent } = state;
	if (!current) {
		return false;
	}
	if (last) {
		return last !== current;
	}
	return !!editorLast && !!editorCurrent && editorLast !== editorCurrent;
}
