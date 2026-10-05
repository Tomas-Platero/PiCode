/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * How the editor spawns the durable daemon, decided in one pure place.
 *
 * `durable.ts` imports `vscode` and so cannot be loaded by `node --test`; the spawn
 * decision is the editor's half of the daemon's lifetime contract and is the part worth
 * pinning with tests, so it lives here with no `vscode` import — next to
 * `durable-client.ts`, which carries the other half (the wire). If the daemon's contract
 * changes (`experimental/durable/lib/daemon.js`), this file moves with it.
 *
 * The contract: the daemon's life is the editor's life. It is spawned ATTACHED (never
 * `detached`), and its stdin is a pipe this process holds open and never writes. The
 * daemon is told (`PICODE_PARENT_PIPE=1`) to stop itself — through the same graceful
 * path as its `shutdown` method — when that pipe reads EOF, which is what the kernel
 * does to it when this process dies in ANY way: clean exit, crash, `taskkill /F`, a
 * hard machine shutdown. Nothing is polled and no id is checked, so a stale pid reused
 * by another process cannot keep a dead editor's daemon alive: the pipe itself is the
 * proof of life.
 */

/** The daemon stops itself when its stdin reads EOF (see its `serve` in lib/daemon.js). */
export const PICODE_PARENT_PIPE_ENV = 'PICODE_PARENT_PIPE';

/** The spawn plan for `node cli.js serve`, exactly as the editor must issue it. */
export interface DaemonSpawnPlan {
	readonly command: string;
	readonly args: readonly string[];
	/**
	 * stdin is the lifeline: a pipe the editor holds open and never writes. stdout and
	 * stderr go to the daemon log's file descriptor when there is one, `ignore` otherwise.
	 */
	readonly stdio: readonly ['pipe', number | 'ignore', number | 'ignore'];
	/** Never detached: a background service is exactly what the daemon must not be. */
	readonly detached: false;
	/** The child's environment: the caller's, plus the lifeline instruction. */
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** Build the spawn plan for the daemon at `cliFile`. */
export function daemonSpawnPlan(cliFile: string, baseEnv: NodeJS.ProcessEnv, logFd: number | undefined): DaemonSpawnPlan {
	return {
		command: 'node',
		args: [cliFile, 'serve'],
		stdio: ['pipe', logFd ?? 'ignore', logFd ?? 'ignore'],
		detached: false,
		env: { ...baseEnv, [PICODE_PARENT_PIPE_ENV]: '1' },
	};
}
