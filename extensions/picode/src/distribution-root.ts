/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';

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
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */
export function distributionRootOf(appRoot: string): string {
	if (!/[\\/]resources[\\/]app$/.test(appRoot)) {
		return appRoot;
	}
	// The separators decide the flavour, so the answer is the same wherever it is computed.
	const flavour = appRoot.includes('\\') ? path.win32 : path.posix;
	return flavour.dirname(flavour.dirname(appRoot));
}
