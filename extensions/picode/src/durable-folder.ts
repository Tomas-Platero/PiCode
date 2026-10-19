/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which folder the durable agent is looked for in, decided in one pure place.
 *
 * `durable.ts` imports `vscode` and so cannot be loaded by `node --test`; the search order is the
 * rule the owner feels — `picode.durable.folder` either finds the agent or says exactly where it
 * looked — so it lives here beside `durable-spawn.ts` and `durable-client.ts`, which are pure for
 * the same reason.
 *
 * The roots, in the order they are tried, and why each one is in the list:
 *
 *  1. **every open workspace folder** — a project that carries its own copy wins, which is what
 *     lets the agent be worked on inside the project it is being tried in;
 *  2. **the repository a packed build sits in** — `PiCode-win32-x64` is unpacked *inside* the PiCode
 *     source tree, so its agent is up there, and that is how the live copy is used while the owner
 *     works in some other project;
 *  3. **what this installation ships** — `<app>/resources/durable`. This is the candidate that
 *     works *wherever PiCode is installed*: an installed editor has no repository above it, and the
 *     folder that happens to be open is somebody else's project. It does not come from the setting's
 *     value: the agent is carried by the installation, not by whatever the setting is spelled as.
 *
 * An absolute value never reaches this list: it is the owner's own answer, used as given.
 */

import { join, resolve } from 'path';

/** The folder the default setting names, resolved against the roots below when relative. */
export const DEFAULT_DURABLE_FOLDER = 'picode-source/durable';

/** Where a build puts the agent inside its own installation, under `resources/`. */
export const SHIPPED_DURABLE_FOLDER = 'durable';

/**
 * The folders to try, in order, for a configured value that is relative.
 *
 * Pure: nothing here touches the disk. `durable.ts` walks the list and takes the first one that
 * holds a `cli.js`, which is what keeps "where is the agent" one rule instead of three.
 */
export function durableFolderCandidates(configured: string, workspaceFolders: readonly string[], appRoot: string): string[] {
	return [
		...workspaceFolders.map(folder => join(folder, configured)),
		resolve(appRoot, '..', '..', '..', configured),
		resolve(appRoot, '..', SHIPPED_DURABLE_FOLDER)
	];
}
