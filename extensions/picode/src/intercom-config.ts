/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How pi-intercom starts its broker inside PiCode.
 *
 * pi-intercom lets pi sessions talk to each other through a small broker process it starts on
 * demand. By default it launches that broker with `node` when the current process is not Node
 * itself — and an editor is not, so on a machine without Node every session would fail to connect.
 * Its own `<agent dir>/intercom/config.json` takes a `brokerCommand` and `brokerArgs`, so the
 * broker is started with the editor's binary instead, acting as Node (`ELECTRON_RUN_AS_NODE`, which
 * `pointChildPiAtThisPi` already sets for every child), and tsx loaded the way pi-intercom would
 * load it itself.
 *
 * Only the two keys are written: whatever else the owner put in that file stays. No `vscode`
 * import, so `node --test` runs this file directly.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The file pi-intercom reads its settings from, inside the agent directory. */
export function intercomConfigFile(profileDir: string): string {
	return path.join(profileDir, 'intercom', 'config.json');
}

/** tsx's loader as the profile's npm tree installs it (pi-intercom depends on it). */
export function tsxLoaderFile(profileDir: string): string {
	return path.join(profileDir, 'npm', 'node_modules', 'tsx', 'dist', 'loader.mjs');
}

/**
 * The config text with the broker launch set, keeping every other key.
 *
 * `undefined` text is a first run. Text that is not a JSON object is the owner's file gone wrong,
 * and is left alone rather than replaced by a guess — pi-intercom then reports it itself.
 */
export function withIntercomBroker(text: string | undefined, command: string, args: readonly string[]): { readonly text: string | undefined; readonly changed: boolean } {
	let root: Record<string, unknown> = {};
	if (text !== undefined) {
		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				return { text, changed: false };
			}
			root = parsed as Record<string, unknown>;
		} catch {
			return { text, changed: false };
		}
	}
	const sameArgs = Array.isArray(root['brokerArgs']) && root['brokerArgs'].length === args.length && args.every((arg, index) => (root['brokerArgs'] as unknown[])[index] === arg);
	if (root['brokerCommand'] === command && sameArgs) {
		return { text, changed: false };
	}
	return { text: `${JSON.stringify({ ...root, brokerCommand: command, brokerArgs: [...args] }, undefined, 2)}\n`, changed: true };
}

/** Points pi-intercom's broker at the editor's binary, in PiCode's own profile. */
export function applyIntercomBroker(profileDir: string, editorBinary: string): void {
	const file = intercomConfigFile(profileDir);
	let existing: string | undefined;
	try {
		existing = fs.readFileSync(file, 'utf8');
	} catch {
		existing = undefined;
	}
	const result = withIntercomBroker(existing, editorBinary, ['--import', pathToFileURL(tsxLoaderFile(profileDir)).href]);
	if (result.changed && result.text !== undefined) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, result.text, { mode: 0o600 });
	}
}
