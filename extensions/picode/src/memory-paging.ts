/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The rules behind the Memory lists, apart from the editor so they run under `node --test`.
 *
 * Measured against engine 3.6.0: `/observations` ignores `offset`, so a longer page is a longer
 * `limit`; `/search` answers 10 rows by default and never more than 20 per project, whatever
 * `limit` says, and matches project names without regard to case. `/observations` narrows by
 * `scope` but ignores `type`, and neither route can change the order.
 */

/** The most `/search` answers for one project. */
export const SEARCH_LIMIT = 20;

/** How many memories remain past the ones shown; 0 when the engine has nothing more to give. */
export function remainingMemories(shown: number, loaded: number, askedFor: number, total: number): number {
	if (total <= shown) {
		return 0;
	}
	// More in hand than on screen, or a full page: a short page means the engine ran out, whatever its count says.
	return shown < loaded || loaded >= askedFor ? total - shown : 0;
}

/** The project name the engine files a repository under: its remote's last segment, in lower case. */
export function projectFromRemote(remote: string | undefined): string | undefined {
	const name = remote?.trim().replace(/[\\/]+$/, '').split(/[\\/:]/).pop()?.replace(/\.git$/i, '').toLowerCase();
	return name === undefined || name === '' ? undefined : name;
}

export interface OpenFolder {
	readonly name: string;
	readonly remote?: string;
}

/**
 * The stored projects behind the open folders: the repository's name first, because that is where
 * the engine saves, then the folder's. A folder with nothing saved still shows, at zero, and two
 * folders of one repository show once.
 */
export function openProjects<P extends { readonly name: string; readonly memories: number }>(folders: readonly OpenFolder[], listed: readonly P[]): (P | { readonly name: string; readonly memories: number })[] {
	const find = (name: string | undefined) => name === undefined ? undefined : listed.find(project => project.name.toLowerCase() === name.toLowerCase());
	const seen = new Set<string>();
	const open: (P | { readonly name: string; readonly memories: number })[] = [];
	for (const folder of folders) {
		const project = find(projectFromRemote(folder.remote)) ?? find(folder.name) ?? { name: folder.name, memories: 0 };
		const key = project.name.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			open.push(project);
		}
	}
	return open;
}

/** What the person narrowed the memories to; an empty list means no narrowing on that side. */
export interface MemoryFilter {
	readonly types: readonly string[];
	readonly scopes: readonly string[];
	readonly days?: number;
}

export const NO_FILTER: MemoryFilter = { types: [], scopes: [] };

export function isFiltering(filter: MemoryFilter): boolean {
	return filter.types.length > 0 || filter.scopes.length > 0 || filter.days !== undefined;
}

/** The engine writes `2026-11-05 14:50:53`, in UTC, without saying so. */
function parseEngineDate(text: string): number {
	return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text) ? `${text.replace(' ', 'T')}Z` : text);
}

export function matchesFilter(row: { readonly type: string; readonly scope: string; readonly updatedAt: string; readonly createdAt: string }, filter: MemoryFilter, now: number): boolean {
	if (filter.types.length > 0 && !filter.types.includes(row.type.toLowerCase())) {
		return false;
	}
	if (filter.scopes.length > 0 && !filter.scopes.includes(row.scope.toLowerCase())) {
		return false;
	}
	if (filter.days === undefined) {
		return true;
	}
	const at = parseEngineDate(row.updatedAt || row.createdAt);
	return !Number.isNaN(at) && now - at <= filter.days * 86_400_000;
}

/** What `/search` can narrow itself: one type and one scope. The rest is narrowed on the rows it answers. */
export function searchFilterParams(filter: MemoryFilter): string {
	return (filter.types.length === 1 ? `&type=${encodeURIComponent(filter.types[0])}` : '')
		+ (filter.scopes.length === 1 ? `&scope=${encodeURIComponent(filter.scopes[0])}` : '');
}
