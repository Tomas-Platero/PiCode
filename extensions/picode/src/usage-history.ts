/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { lstat, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Gentle's bounded projection: session content and paths are never returned. */
export interface UsageHistory {
	readonly totals: { readonly totalTokens: number };
	readonly byDay: readonly { readonly day: string; readonly tokens: number }[];
	readonly byProvider: readonly { readonly provider: string; readonly tokens: number }[];
}

interface HistoryAdapter {
	load(roots: readonly string[]): Promise<unknown[]>;
	project(sessions: unknown[], query: { range: '30d'; scope: 'all'; cwd: undefined; now: number }): UsageHistory;
}

type AdapterLoader = (profile: string, runtimeRoot: string) => Promise<HistoryAdapter | undefined>;
type InspectPath = (entry: string) => Promise<{ isSymbolicLink(): boolean }>;

/** Refuse links and Windows junctions in every component, including the data root itself. */
async function isUnlinkedPath(target: string, inspect: InspectPath): Promise<boolean> {
	const absolute = path.resolve(target);
	const root = path.parse(absolute).root;
	let current = root;
	for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		if ((await inspect(current)).isSymbolicLink()) {
			return false;
		}
	}
	return true;
}

/** Load Gentle's own collector and projection, without loading its default two-home extension. */
async function loadGentleHistory(profile: string, runtimeRoot: string): Promise<HistoryAdapter | undefined> {
	const requireRuntime = createRequire(path.join(runtimeRoot, 'package.json'));
	const { createJiti } = requireRuntime('jiti') as { createJiti: (filename: string, options: object) => { import(filename: string): Promise<Record<string, unknown>> } };
	const jiti = createJiti(path.join(runtimeRoot, 'package.json'), { fsCache: false });
	const library = path.join(profile, 'npm', 'node_modules', 'gentle-pi', 'lib');
	const collector = await jiti.import(path.join(library, 'stats-collector.ts'));
	const projection = await jiti.import(path.join(library, 'desktop-rpc-stats.ts'));
	if (typeof collector.createStatsLoader !== 'function' || typeof projection.projectDesktopUsageStats !== 'function') {
		return undefined;
	}
	const loader = (collector.createStatsLoader as () => { load(roots: readonly string[]): Promise<unknown[]> })();
	return { load: roots => loader.load(roots), project: projection.projectDesktopUsageStats as HistoryAdapter['project'] };
}

/** Reads only the product profile; unavailable packages or inaccessible history return no data. */
export async function readUsageHistory(dataRoot: string, runtimeRoot: string, loadAdapter: AdapterLoader = loadGentleHistory, inspect: InspectPath = lstat): Promise<UsageHistory | undefined> {
	try {
		const profile = path.join(dataRoot, 'pi-agent');
		if (!(await isUnlinkedPath(path.join(profile, 'sessions'), inspect))) {
			return undefined;
		}
		const [actualProfile, sessions] = await Promise.all([realpath(profile), realpath(path.join(profile, 'sessions'))]);
		const relative = path.relative(actualProfile, sessions);
		if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			return undefined;
		}
		const adapter = await loadAdapter(profile, runtimeRoot);
		if (adapter === undefined) {
			return undefined;
		}
		// Loading the package can take time: a path that was safe before loading may
		// have been replaced while the adapter was being resolved.
		if (!(await isUnlinkedPath(path.join(profile, 'sessions'), inspect)) || await realpath(path.join(profile, 'sessions')) !== sessions) {
			return undefined;
		}
		const records = await adapter.load([sessions]);
		if (!(await isUnlinkedPath(path.join(profile, 'sessions'), inspect)) || await realpath(path.join(profile, 'sessions')) !== sessions) {
			return undefined;
		}
		return adapter.project(records, { range: '30d', scope: 'all', cwd: undefined, now: Date.now() });
	} catch {
		return undefined;
	}
}
