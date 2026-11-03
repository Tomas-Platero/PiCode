/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { fork } from 'child_process';
import type { WorkerChannel } from './voice-session';

/**
 * Starts the listening process (`voice-worker.ts`) as a child of the extension host.
 *
 * It runs on the editor's own Node (`ELECTRON_RUN_AS_NODE`), never on a Node found on the PATH:
 * the engine was tried against that one. Its output is drained and dropped — sherpa-onnx writes
 * progress lines to stdout, and a pipe nobody reads would eventually stall the child.
 */
export function forkVoiceWorker(script: string): WorkerChannel {
	const child = fork(script, [], {
		execPath: process.execPath,
		env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
		silent: true,
		windowsHide: true,
	});
	child.stdout?.resume();
	child.stderr?.resume();
	return {
		send: message => { child.send(message); },
		onMessage: listener => { child.on('message', message => listener(message as Record<string, unknown>)); },
		onExit: listener => { child.on('exit', listener); child.on('error', listener); },
		kill: () => { child.kill(); },
	};
}
