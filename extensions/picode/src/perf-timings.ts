/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * How long the connector's recurring work takes, kept in memory for this window. It exists so a
 * performance change can be compared with numbers: `picode.perf.report` opens the table.
 */

interface Timing {
	count: number;
	totalMs: number;
	maxMs: number;
	lastMs: number;
}

const timings = new Map<string, Timing>();

export function recordTiming(label: string, ms: number): void {
	const timing = timings.get(label) ?? { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
	timing.count++;
	timing.totalMs += ms;
	timing.maxMs = Math.max(timing.maxMs, ms);
	timing.lastMs = ms;
	timings.set(label, timing);
}

/** Times a piece of work, sync or async; a failure counts too and still reaches the caller. */
export function timed<T>(label: string, work: () => T): T {
	const start = performance.now();
	const done = () => recordTiming(label, performance.now() - start);
	let result: T;
	try {
		result = work();
	} catch (error) {
		done();
		throw error;
	}
	if (result instanceof Promise) {
		return result.finally(done) as T;
	}
	done();
	return result;
}

/** The table, slowest total first. */
export function timingReport(): string {
	const rows = [...timings.entries()].sort(([, a], [, b]) => b.totalMs - a.totalMs).map(([label, timing]) =>
		`| ${label} | ${timing.count} | ${(timing.totalMs / timing.count).toFixed(1)} | ${timing.maxMs.toFixed(1)} | ${timing.lastMs.toFixed(1)} |`);
	return ['| Work | Runs | Average ms | Slowest ms | Last ms |', '| --- | --- | --- | --- | --- |', ...rows, ''].join('\n');
}

export function resetTimings(): void {
	timings.clear();
}
