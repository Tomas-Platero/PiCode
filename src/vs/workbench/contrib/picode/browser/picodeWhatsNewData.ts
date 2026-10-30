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
