/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';

/**
 * The environment the product fixes for pi and for every package install it runs.
 *
 * - `GENTLE_PI_SKIP_GENTLE_AI_INSTALL`: gentle-pi's install script would otherwise download or
 *   compile a helper program (on Windows, from source with a Go toolchain). The product does not
 *   let a package's install script fetch anything: the helper is not installed, and the review
 *   operations that need it stay off.
 * - `DO_NOT_TRACK` and `GENTLE_AI_TELEMETRY`: the two switches Gentle AI honours to send no usage
 *   data. PiCode sends nothing, so they are set for pi and for the helper it may start.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

/** The variables, with the value each one must have. */
export const PRODUCT_ENV: Readonly<Record<string, string>> = Object.freeze({
	GENTLE_PI_SKIP_GENTLE_AI_INSTALL: '1',
	DO_NOT_TRACK: '1',
	GENTLE_AI_TELEMETRY: '0',
});

/**
 * The signal that tells gentle-pi it runs under an interactive host with a screen of its own: it
 * then asks through the chat's dialogs and publishes its subagents' live state, which the Tasks
 * block draws (`gentle-agents-store.ts`). Only pi in this window needs it, so it is set on this
 * process (`applyProductEnv`) and not laid over every npm run; gentle-pi strips it from its own
 * children.
 */
export const HOST_ENV: Readonly<Record<string, string>> = Object.freeze({
	GENTLE_SHELL_INTERACTIVE_HOST: '1',
});

/**
 * Where gentle-pi keeps its own files — its settings, its scratch folders, its notes — as a folder
 * of PiCode's own profile. Left to itself it uses `~/.pi/gentle-ai`, which is the machine's own pi:
 * PiCode never reads or writes there.
 */
export function configHomeEnv(profileDir: string): Readonly<Record<string, string>> {
	return { GENTLE_PI_CONFIG_HOME: path.join(profileDir, 'gentle-ai') };
}

/** `env` with the product's variables laid over it; the product's values win. */
export function withProductEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...env, ...PRODUCT_ENV };
}

/**
 * Sets the product's variables, the host signal and — when the profile is known — gentle-pi's home
 * on this process, so everything it starts inherits them.
 */
export function applyProductEnv(target: NodeJS.ProcessEnv = process.env, profileDir?: string): void {
	Object.assign(target, PRODUCT_ENV, HOST_ENV, profileDir === undefined ? {} : configHomeEnv(profileDir));
}
