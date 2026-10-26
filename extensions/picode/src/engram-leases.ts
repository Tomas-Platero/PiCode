/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Who still needs the memory engine: the last PiCode window out stops it, and only if PiCode started it.
 *
 * Every window of the editor writes a small file with its own process id (a **lease**) while it is
 * open. The window that actually starts the engine also writes a marker with the engine's process id.
 * When a window closes it takes its lease away and drops the leases of windows that are no longer
 * running (a crash leaves one behind). If no lease is left **and** the marker is there, the engine is
 * PiCode's to stop, and its process id is handed back. An engine that somebody else started has no
 * marker, so it is never stopped from here, however many windows come and go.
 *
 * No `vscode` import: the rules are about files and process ids, so they run on their own in tests.
 */

import * as fs from 'fs';
import * as path from 'path';

const LEASES_FOLDER = 'leases';
const OWNER_FILE = 'engine-started-by-picode';

/** Whether a process with this id is running; injectable so a test needs no real process. */
export type IsAlive = (pid: number) => boolean;

/** The real check: signal 0 asks the system without disturbing the process. */
export const processIsAlive: IsAlive = pid => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists and is not ours to signal: still running.
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
};

function leasesDir(dir: string): string {
	return path.join(dir, LEASES_FOLDER);
}

/** This window is open and may use the engine. */
export function takeLease(dir: string, pid: number): void {
	fs.mkdirSync(leasesDir(dir), { recursive: true });
	fs.writeFileSync(path.join(leasesDir(dir), String(pid)), String(Date.now()));
}

/** PiCode started the engine with this process id: it is PiCode's to stop. */
export function markEngineStarted(dir: string, enginePid: number): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, OWNER_FILE), String(enginePid));
}

/** The leases of windows that are still running, after removing the ones that are not. */
function liveLeases(dir: string, isAlive: IsAlive): number[] {
	const folder = leasesDir(dir);
	let names: string[];
	try {
		names = fs.readdirSync(folder);
	} catch {
		return [];
	}
	const live: number[] = [];
	for (const name of names) {
		const pid = Number(name);
		if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
			live.push(pid);
			continue;
		}
		try {
			fs.rmSync(path.join(folder, name), { force: true });
		} catch {
			// A lease that cannot be removed is only noise: it names a process that is gone.
		}
	}
	return live;
}

/**
 * This window is closing.
 *
 * Returns the engine's process id when this was the last window and PiCode started that engine, so
 * the caller stops it; otherwise nothing. The marker is removed together with the answer, so a second
 * window closing at the same moment cannot ask for the same stop twice.
 */
export function leaveEngine(dir: string, pid: number, isAlive: IsAlive = processIsAlive): number | undefined {
	try {
		fs.rmSync(path.join(leasesDir(dir), String(pid)), { force: true });
	} catch {
		// Nothing to remove: the lease was never taken or is already gone.
	}
	if (liveLeases(dir, isAlive).length > 0) {
		return undefined;
	}
	const ownerFile = path.join(dir, OWNER_FILE);
	let text: string;
	try {
		text = fs.readFileSync(ownerFile, 'utf8');
	} catch {
		return undefined;
	}
	try {
		fs.rmSync(ownerFile, { force: true });
	} catch {
		// If the marker stays, the next last window asks again; the stop itself is harmless to repeat.
	}
	const enginePid = Number(text.trim());
	return Number.isInteger(enginePid) && enginePid > 0 ? enginePid : undefined;
}
