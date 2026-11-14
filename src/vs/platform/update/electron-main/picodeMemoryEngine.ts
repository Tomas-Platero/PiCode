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
import { readdirSync, readFileSync, rmSync } from 'fs';
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

/** What the quit-time stop reads and does, injectable so a test needs no real files or processes. */
export interface IEngineMarkerIo {
	read(file: string): string | undefined;
	list(dir: string): readonly string[];
	remove(file: string): void;
	isAlive(pid: number): boolean;
	isEngine(pid: number): boolean;
	kill(pid: number): void;
}

/** The folders where PiCode's engine can run from: the owner's updated copy and the installation's own. */
export function picodeEngineFolders(appRoot: string, home: string): string[] {
	return [join(home, '.picode', 'memory'), memoryFolderOf(appRoot)];
}

/** The windows still using the engine of `folder` (each keeps a lease named by its process id). */
export function liveEngineLeases(folder: string, io: Pick<IEngineMarkerIo, 'list' | 'isAlive'>): number[] {
	return io.list(join(folder, 'leases')).map(Number).filter(pid => Number.isInteger(pid) && pid > 0 && io.isAlive(pid));
}

/**
 * The editor is quitting: stops the engine PiCode started, in each folder, when no window uses it.
 *
 * Each window stops it itself when it is the last to close, but a window that goes down abruptly (a
 * crash, a forced close, a quit that does not wait for it) never gets to, and the engine is left
 * running on its own with files of the editor open. The main process outlives every window, so it
 * looks once more: only an engine named by PiCode's marker (one somebody else started has none),
 * only when no window of any PiCode still holds a lease, and only if that process is still the engine.
 */
export function stopEngineLeftByPicode(folders: readonly string[], io: IEngineMarkerIo): number[] {
	const stopped: number[] = [];
	for (const folder of new Set(folders.map(folder => resolve(folder)))) {
		if (liveEngineLeases(folder, io).length > 0) {
			continue;
		}
		const marker = join(folder, 'engine-started-by-picode');
		const pid = Number(io.read(marker)?.trim());
		if (!Number.isInteger(pid) || pid <= 0) {
			continue;
		}
		try {
			io.remove(marker);
		} catch {
			// A marker that stays names a process that is gone: the next look finds nothing to stop.
		}
		if (!io.isAlive(pid) || !io.isEngine(pid)) {
			continue;
		}
		try {
			io.kill(pid);
			stopped.push(pid);
		} catch {
			// Already gone.
		}
	}
	return stopped;
}

/** The real world for {@link stopEngineLeftByPicode}. */
export const systemEngineMarkerIo: IEngineMarkerIo = {
	read: file => {
		try {
			return readFileSync(file, 'utf8');
		} catch {
			return undefined;
		}
	},
	list: dir => {
		try {
			return readdirSync(dir);
		} catch {
			return [];
		}
	},
	remove: file => rmSync(file, { force: true }),
	isAlive: pid => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === 'EPERM';
		}
	},
	isEngine: pid => {
		try {
			const answer = process.platform === 'win32'
				? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
				: execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 5000 });
			return answer.toLowerCase().includes('engram');
		} catch {
			return false;
		}
	},
	kill: pid => process.kill(pid)
};

/**
 * When the editor quits: waits a moment for the closing windows to let go of the engine (each drops
 * its lease as it goes), then stops the one PiCode started if nobody uses it any more.
 */
export async function stopPicodeEngineOnQuit(appRoot: string, home: string, io: IEngineMarkerIo = systemEngineMarkerIo, waitMs = 3000): Promise<number[]> {
	const folders = picodeEngineFolders(appRoot, home);
	for (let waited = 0; waited < waitMs && folders.some(folder => liveEngineLeases(folder, io).length > 0); waited += 200) {
		await new Promise<void>(done => setTimeout(done, 200));
	}
	return stopEngineLeftByPicode(folders, io);
}
