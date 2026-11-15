/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The skills PiCode itself gives pi (`extensions/picode/skills/<name>/SKILL.md`), as pi's
 * `additionalSkillPaths`.
 *
 * Each skill's own folder is passed, not `skills/`: pi loads every `.md` at the root of a path it
 * is given as a skill, so handing it `skills/` would turn the folder's README into one.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The folders under `<connectorRoot>/skills` that hold a `SKILL.md`, sorted; none when there is no such folder. */
export function bundledSkillPaths(connectorRoot: string): string[] {
	const root = path.join(connectorRoot, 'skills');
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'SKILL.md')))
		.map(entry => path.join(root, entry.name))
		.sort();
}
