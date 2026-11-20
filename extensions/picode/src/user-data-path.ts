/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The editor's user-data folder, from the connector's global storage. The storage is
 * `<userData>/User/globalStorage/<extension>` in the default editor profile and
 * `<userData>/User/profiles/<id>/globalStorage/<extension>` in any other, so counting levels alone
 * lands inside `User/profiles` as soon as someone switches profile.
 */

import * as path from 'node:path';

export function userDataPathOf(globalStorage: string): string {
	const paths = globalStorage.includes('\\') ? path.win32 : path.posix;
	let folder = paths.dirname(paths.dirname(globalStorage)); // .../User or .../User/profiles/<id>
	const parent = paths.dirname(folder);
	if (paths.basename(parent) === 'profiles' && paths.basename(paths.dirname(parent)) === 'User') {
		folder = paths.dirname(parent);
	}
	return paths.dirname(folder);
}
