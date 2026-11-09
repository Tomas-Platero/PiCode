/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Closing PiCode's own memory engine before an update replaces the folder it runs from.
 *
 * The engine travels inside the installation (`<app>/resources/memory/engram.exe`). The window that
 * started it stops it when it closes, but when the editor quits to update, that window is told to
 * stop and exits in a fraction of a second: an engine that outlives it keeps its files open, and the
 * updater then cannot delete the folder ("Access denied"). So the main process, once every window is
 * gone and right before the installer starts, closes any engine running from the folder being
 * replaced. Only by where the program is: another program's engine (one installed on its own, under
 * its own folder) is never touched, and neither is anything that is not the engine.
 *
 * Kept free of other PiCode modules so a test can load it on its own (`node --test`).
 */

import { execFileSync } from 'child_process';
import { dirname, join, resolve } from 'path';

/** A process running the engine, with the program it was started from. */
export interface IRunningEngine {
	readonly pid: number;
	readonly path: string;
}

export interface IMemoryEngineProcesses {
	list(): readonly IRunningEngine[];
	kill(pid: number): void;
}

/** Where the installation's engine lives, from the folder the editor's code is in (`<install>/resources/app`). */
export function memoryFolderOf(appRoot: string): string {
	return join(dirname(appRoot), 'memory');
}

/** Whether `file` is inside `folder`. Windows paths are compared without regard to case. */
export function isInsideFolder(file: string, folder: string, ignoreCase: boolean): boolean {
	const normal = (value: string) => {
		const full = resolve(value).replace(/[\\/]+$/, '');
		return ignoreCase ? full.toLowerCase() : full;
	};
	const inside = normal(folder);
	const candidate = normal(file);
	return candidate.startsWith(inside + '\\') || candidate.startsWith(inside + '/');
}

/** Stops every engine started from `folder` and returns their process ids. A failure to stop one never stops the others. */
export function stopEnginesInside(folder: string, processes: IMemoryEngineProcesses, ignoreCase = process.platform === 'win32'): number[] {
	const stopped: number[] = [];
	for (const engine of processes.list()) {
		if (!Number.isInteger(engine.pid) || engine.pid <= 0 || !isInsideFolder(engine.path, folder, ignoreCase)) {
			continue;
		}
		try {
			processes.kill(engine.pid);
			stopped.push(engine.pid);
		} catch {
			// Already gone, or not ours to stop: the updater will say so if it still cannot go on.
		}
	}
	return stopped;
}

/** Reads the output of the system listing: one `pid|path` per line, anything else is ignored. */
export function readRunningEngines(output: string): IRunningEngine[] {
	const engines: IRunningEngine[] = [];
	for (const line of output.split(/\r?\n/)) {
		const bar = line.indexOf('|');
		const pid = Number(line.slice(0, bar));
		const path = line.slice(bar + 1).trim();
		if (bar > 0 && Number.isInteger(pid) && pid > 0 && path !== '') {
			engines.push({ pid, path });
		}
	}
	return engines;
}

/** The real thing, on Windows: the engines the system is running, and a way to stop one. */
export const systemMemoryEngines: IMemoryEngineProcesses = {
	list: () => {
		try {
			const output = execFileSync('powershell.exe', [
				'-NoProfile', '-NonInteractive', '-Command',
				// Where the program is comes from the system, not from anything the engine says about itself.
				'Get-Process -Name engram -ErrorAction SilentlyContinue | Where-Object { $_.Path } | ForEach-Object { \'{0}|{1}\' -f $_.Id, $_.Path }'
			], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
			return readRunningEngines(output);
		} catch {
			return [];
		}
	},
	kill: pid => process.kill(pid)
};
