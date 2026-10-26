/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INodeProcess, isMacintosh, isWindows } from './platform.js';

let safeProcess: Omit<INodeProcess, 'arch' | 'execPath'> & { arch: string | undefined; execPath: string | undefined };
declare const process: INodeProcess;

// Native sandbox environment
const vscodeGlobal = (globalThis as { vscode?: { process?: INodeProcess } }).vscode;
if (typeof vscodeGlobal !== 'undefined' && typeof vscodeGlobal.process !== 'undefined') {
	const sandboxProcess: INodeProcess = vscodeGlobal.process;
	safeProcess = {
		get platform() { return sandboxProcess.platform; },
		get arch() { return sandboxProcess.arch; },
		get env() { return sandboxProcess.env; },
		get execPath() { return sandboxProcess.execPath; },
		cwd() { return sandboxProcess.cwd(); }
	};
}

// Native node.js environment
else if (typeof process !== 'undefined' && typeof process?.versions?.node === 'string') {
	safeProcess = {
		get platform() { return process.platform; },
		get arch() { return process.arch; },
		get env() { return process.env; },
		get execPath() { return process.execPath; },
		cwd() { return process.env['VSCODE_CWD'] || process.cwd(); }
	};
}

// Web environment
else {
	safeProcess = {

		// Supported
		get platform() { return isWindows ? 'win32' : isMacintosh ? 'darwin' : 'linux'; },
		get arch() { return undefined; /* arch is undefined in web */ },

		// Unsupported
		get env() { return {}; },
		get execPath() { return ''; /* execPath is unsupported in web */ },
		cwd() { return '/'; }
	};
}

/**
 * Provides safe access to the `cwd` property in node.js, sandboxed or web
 * environments.
 *
 * Note: in web, this property is hardcoded to be `/`.
 *
 * @skipMangle
 */
export const cwd = safeProcess.cwd;

/**
 * Provides safe access to the `env` property in node.js, sandboxed or web
 * environments.
 *
 * Note: in web, this property is hardcoded to be `{}`.
 */
export const env = safeProcess.env;

/**
 * Provides safe access to the `platform` property in node.js, sandboxed or web
 * environments.
 */
export const platform = safeProcess.platform;

/**
 * Provides safe access to the `execPath` property in node.js, sandboxed or web
 * environments.
 *
 * Note: in web, this property is an empty string.
 *
 * @skipMangle
 */
export const execPath = safeProcess.execPath;

/**
 * Provides safe access to the `arch` method in node.js, sandboxed or web
 * environments.
 * Note: `arch` is `undefined` in web
 */
export const arch = safeProcess.arch;
