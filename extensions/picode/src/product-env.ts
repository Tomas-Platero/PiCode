/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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

/** `env` with the product's variables laid over it; the product's values win. */
export function withProductEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...env, ...PRODUCT_ENV };
}

/** Sets the product's variables on this process, so everything it starts inherits them. */
export function applyProductEnv(target: NodeJS.ProcessEnv = process.env): void {
	Object.assign(target, PRODUCT_ENV);
}
