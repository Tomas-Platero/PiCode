/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';

/**
 * Where the distribution is and where its pi lives: two pure rules, in a file with no `vscode`
 * import, so that the setup window's host — plain Node, no editor — can use them without loading
 * `runtime.ts`, which needs the editor. `node --test` runs this file directly.
 */

/**
 * The runtime root: PiCode's own pi, installed by the build at its pinned version.
 *
 * Spelled out here for callers, because it is also where the profile's `@earendil-works/*`
 * versions come from (`packages-install.ts`): the profile carries a copy of the same family for
 * npm's sake, and the only version that copy may have is the one in force here.
 */
export function piRuntimeRoot(distributionRoot: string): string {
	return path.join(distributionRoot, 'resources', 'pi-runtime');
}

/**
 * The distribution root, from the editor's own application root.
 *
 * In a pack the editor's code lives at `<root>/resources/app`, so the distribution — the folder
 * that holds `resources/pi-runtime`, `resources/memory` and `data/` — is two levels up. In a
 * source tree (`npm run dev`) the application root **is** the repository, and that is where the
 * dev loop links the pi runtime (`build/dev.mjs`) and where the profile's `data/` folder sits.
 *
 * The editor's own start-up code decides the same thing the same way
 * (`src/vs/code/electron-main/picodeOnboarding.ts`, `distributionRootOf`): the setup window and
 * the connector must name one root, or a setup would write a profile the chat never reads.
 *
 * Deriving it from this extension's folder, as it was done, counted four levels up from
 * `resources/app/extensions/picode` — right in a pack, and the drive root in a source tree,
 * where pi was looked for in `D:\resources` and the profile made in `D:\data`.
 */
export function distributionRootOf(appRoot: string): string {
	if (!/[\\/]resources[\\/]app$/.test(appRoot)) {
		return appRoot;
	}
	// The separators decide the flavour, so the answer is the same wherever it is computed.
	const flavour = appRoot.includes('\\') ? path.win32 : path.posix;
	return flavour.dirname(flavour.dirname(appRoot));
}
