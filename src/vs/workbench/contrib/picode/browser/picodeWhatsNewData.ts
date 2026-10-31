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
	const section = (next ? rest.slice(0, next.index) : rest).trim();
	return section || undefined;
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
