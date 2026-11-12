/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Closing pi-intercom's broker before an update sets the profile folder aside.
 *
 * pi-intercom starts its broker detached, on the editor's own binary acting as Node, with its working
 * folder inside the profile (`<install>/data/pi-agent/intercom`). It outlives the editor (at least five
 * seconds with no sessions, a day with undelivered mail), and Windows refuses to rename a folder that
 * is a running process's working folder. The installer has to rename `<install>/data` to keep pi's
 * profile across the swap, so a broker still running makes it skip the swap and the update never
 * lands. The main process, right before the installer starts, stops the broker of this installation:
 * the editor's binary running pi-intercom's broker script from this installation's profile. Nothing
 * else is touched: not another install's broker, not one run by a separate Node.
 *
 * Kept free of other PiCode modules so a test can load it on its own (`node --test`).
 */

import { execFileSync } from 'child_process';
import { basename, dirname, join, resolve } from 'path';

/** A running process, with the program it was started from and its full command line. */
export interface IRunningProcess {
	readonly pid: number;
	readonly path: string;
	readonly commandLine: string;
}

export interface IBrokerProcesses {
	list(): readonly IRunningProcess[];
	kill(pid: number): void;
}

/** The profile folder of the installation, from the folder the editor's code is in (`<install>/resources/app`). */
export function dataFolderOf(appRoot: string): string {
	return join(dirname(dirname(appRoot)), 'data');
}

function normalize(value: string, ignoreCase: boolean): string {
	const unified = value.replace(/\//g, '\\');
	return ignoreCase ? unified.toLowerCase() : unified;
}

/** Whether `process` is pi-intercom's broker run by `editorExe` from inside `dataFolder`. */
export function isIntercomBrokerOf(process: Pick<IRunningProcess, 'path' | 'commandLine'>, editorExe: string, dataFolder: string, ignoreCase: boolean): boolean {
	if (normalize(resolve(process.path), ignoreCase) !== normalize(resolve(editorExe), ignoreCase)) {
		return false;
	}
	const commandLine = normalize(process.commandLine, ignoreCase);
	const broker = normalize(join(resolve(dataFolder), '\\'), ignoreCase);
	const at = commandLine.indexOf(broker);
	return at >= 0 && /^[^"]*?\\pi-intercom\\broker\\broker\.(?:ts|js|mjs)\b/.test(commandLine.slice(at + broker.length));
}

/** Stops every broker of this installation and returns their process ids. A failure to stop one never stops the others. */
export function stopIntercomBrokers(editorExe: string, dataFolder: string, processes: IBrokerProcesses, ignoreCase = process.platform === 'win32'): number[] {
	const stopped: number[] = [];
	for (const candidate of processes.list()) {
		if (!Number.isInteger(candidate.pid) || candidate.pid <= 0 || !isIntercomBrokerOf(candidate, editorExe, dataFolder, ignoreCase)) {
			continue;
		}
		try {
			processes.kill(candidate.pid);
			stopped.push(candidate.pid);
		} catch {
			// Already gone, or not ours to stop: the installer waits for the folder and says so if it still cannot.
		}
	}
	return stopped;
}

/** Reads the output of the system listing: one `pid|path|command line` per line, anything else is ignored. */
export function readRunningProcesses(output: string): IRunningProcess[] {
	const found: IRunningProcess[] = [];
	for (const line of output.split(/\r?\n/)) {
		const first = line.indexOf('|');
		const second = first > 0 ? line.indexOf('|', first + 1) : -1;
		if (second < 0) {
			continue;
		}
		const pid = Number(line.slice(0, first));
		const path = line.slice(first + 1, second).trim();
		const commandLine = line.slice(second + 1).trim();
		if (Number.isInteger(pid) && pid > 0 && path !== '' && commandLine !== '') {
			found.push({ pid, path, commandLine });
		}
	}
	return found;
}

/** The real thing, on Windows: the processes running the editor's binary, and a way to stop one. */
export function systemBrokerProcesses(editorExe: string): IBrokerProcesses {
	return {
		list: () => {
			try {
				const name = basename(editorExe).replace(/'/g, '\'\'');
				const output = execFileSync('powershell.exe', [
					'-NoProfile', '-NonInteractive', '-Command',
					// Where the program is comes from the system, not from anything the process says about itself.
					`Get-CimInstance Win32_Process -Filter "Name='${name}'" | Where-Object { $_.ExecutablePath -and $_.CommandLine } | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ExecutablePath, ($_.CommandLine -replace '[\\r\\n]+', ' ') }`
				], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
				return readRunningProcesses(output);
			} catch {
				return [];
			}
		},
		kill: pid => process.kill(pid)
	};
}
