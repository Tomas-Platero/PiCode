/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Whether pi may load what a folder brings with it.
 *
 * A folder's `.pi` holds extensions, packages, settings and MCP servers: code that runs with the
 * owner's permissions as soon as pi loads it. pi trusts every project unless its `SettingsManager`
 * is told otherwise, and its own trust prompt only exists in its terminal, so the answer has to
 * come from the editor's workspace trust. This file is pure so `node --test` can run it.
 */

import * as path from 'node:path';

/**
 * True only for a folder of a trusted window, or a folder inside one. A conversation resumed in
 * some other folder is not covered by the trust the owner gave this window.
 */
export function isProjectTrusted(cwd: string, workspaceTrusted: boolean, folders: readonly string[]): boolean {
	if (!workspaceTrusted) {
		return false;
	}
	return folders.some(folder => {
		const relative = path.relative(folder, cwd);
		return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
	});
}

/** The part of pi's SDK that builds its settings. */
export interface ProjectSettingsSdk<Settings> {
	readonly SettingsManager: {
		create(cwd: string, agentDir: string | undefined, options: { projectTrusted: boolean }): Settings;
	};
}

/** What `createAgentSessionServices` needs to know the answer. */
export function projectSettingsOption<Settings>(
	sdk: ProjectSettingsSdk<Settings>,
	cwd: string,
	agentDir: string | undefined,
	trusted: boolean,
): { settingsManager: Settings } {
	return { settingsManager: sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: trusted }) };
}
