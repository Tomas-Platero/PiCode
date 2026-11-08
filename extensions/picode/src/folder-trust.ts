/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { isProjectTrusted, projectSettingsOption, type ProjectSettingsSdk } from './project-trust';

/**
 * The option every start of pi passes, answered from this window's workspace trust
 * (see `project-trust.ts`). Without it pi loads the folder's `.pi` unasked.
 */
export function settingsForFolder<Settings>(sdk: ProjectSettingsSdk<Settings>, cwd: string, agentDir: string | undefined): { settingsManager: Settings } {
	const folders = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
	return projectSettingsOption(sdk, cwd, agentDir, isProjectTrusted(cwd, vscode.workspace.isTrusted, folders));
}
