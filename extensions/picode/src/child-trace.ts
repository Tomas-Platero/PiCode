/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcess } from 'node:child_process';

/**
 * A timeline of the child pi processes gentle-pi starts for its subagents.
 *
 * gentle-pi ends a subagent by stopping its process and waiting one second for the exit to be
 * seen; when it is not, the agent is marked failed ("child exit unconfirmed after 1000ms") even
 * though its answer was complete. Whether the process was slow to go, or the editor was too busy
 * to hear it go, cannot be told from the Tasks block, so this records what each child did and
 * when: started, asked to stop, exited, closed — and how long the editor stood still in between.
 * One short line per event, in the connector's own log. It changes nothing about how the process
 * runs.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

/** The part of `child_process` this wraps. */
export interface SpawnModule {
	spawn: (command: string, args?: readonly string[], options?: unknown) => ChildProcess;
}

/** Whether a spawn is one of gentle-pi's child pi processes: the editor's binary over a pi `cli.js`. */
export function isChildPi(command: string, args: readonly string[] | undefined, editorBinary: string): boolean {
	return command === editorBinary && args !== undefined && typeof args[0] === 'string' && /[\\/]cli\.js$/.test(args[0]);
}

/**
 * The longest the editor stood still while a timer of `intervalMs` was waiting, in milliseconds
 * (zero when it ran on time).
 */
export function lateness(expectedAt: number, firedAt: number): number {
	return Math.max(0, firedAt - expectedAt);
}

/**
 * Wraps `spawn` so each child pi leaves its timeline in `log`. Returns how to put the original
 * back. Safe to call more than once: a wrapped spawn is not wrapped again.
 */
export function traceChildPi(
	module: SpawnModule,
	log: (line: string) => void,
	editorBinary: string = process.execPath,
	now: () => number = Date.now,
	setTimer: (body: () => void, ms: number) => unknown = (body, ms) => setInterval(body, ms),
	clearTimer: (timer: unknown) => void = timer => clearInterval(timer as ReturnType<typeof setInterval>),
): () => void {
	const original = module.spawn;
	if ((original as { __picodeTraced?: boolean }).__picodeTraced === true) {
		return () => undefined;
	}
	const wrapped = function (this: unknown, command: string, args?: readonly string[], options?: unknown): ChildProcess {
		const child = original.call(this, command, args, options as never);
		if (!isChildPi(command, args, editorBinary)) {
			return child;
		}
		const started = now();
		const at = (): string => `+${now() - started}ms`;
		log(`child pi ${child.pid ?? '?'}: started`);
		// How long the editor stood still: a timer that fires late says the editor was busy.
		const tick = 100;
		let expected = now() + tick;
		let worst = 0;
		const timer = setTimer(() => {
			const late = lateness(expected, now());
			if (late > worst) {
				worst = late;
			}
			expected = now() + tick;
		}, tick);
		const originalKill = child.kill.bind(child);
		child.kill = ((signal?: NodeJS.Signals | number): boolean => {
			const done = originalKill(signal);
			log(`child pi ${child.pid ?? '?'}: asked to stop (${String(signal ?? 'SIGTERM')}, accepted: ${done}) ${at()}`);
			return done;
		}) as ChildProcess['kill'];
		child.once('exit', (code, signal) => log(`child pi ${child.pid ?? '?'}: exit event (code ${String(code)}, signal ${String(signal)}) ${at()}`));
		child.once('close', () => {
			clearTimer(timer);
			log(`child pi ${child.pid ?? '?'}: closed ${at()}; the editor stood still up to ${worst}ms while it ran`);
		});
		child.once('disconnect', () => log(`child pi ${child.pid ?? '?'}: channel closed ${at()}`));
		child.once('error', error => log(`child pi ${child.pid ?? '?'}: error ${error.message} ${at()}`));
		return child;
	} as SpawnModule['spawn'];
	(wrapped as { __picodeTraced?: boolean }).__picodeTraced = true;
	module.spawn = wrapped;
	return () => {
		if (module.spawn === wrapped) {
			module.spawn = original;
		}
	};
}
