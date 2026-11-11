/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { clearPendingExtensions, readPendingExtensions } from './import-catalog';
import { l10n } from './l10n.ts';

/**
 * Installs the extensions the Import window queued.
 *
 * The window runs outside the editor, so it can only write the ids to a small file. Here, inside
 * the editor, each id goes through the same gallery installer the theme picker uses; the file is
 * emptied first so a slow install is never started twice by a second window focus.
 */
export function registerPendingExtensions(userDataPath: string): vscode.Disposable[] {
	let running = false;
	const installPending = async (): Promise<void> => {
		if (running) { return; }
		const ids = readPendingExtensions(userDataPath);
		if (ids.length === 0) { return; }
		running = true;
		clearPendingExtensions(userDataPath);
		try {
			const failed: string[] = [];
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: l10n.t('Installing the extensions you imported…') }, async () => {
				for (const id of ids) {
					try {
						await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
					} catch {
						failed.push(id);
					}
				}
			});
			if (failed.length === 0) {
				void vscode.window.showInformationMessage(l10n.t('Your imported extensions are installed.'));
			} else {
				void vscode.window.showWarningMessage(l10n.t('{0} of the imported extensions are not available here: {1}', failed.length, failed.join(', ')));
			}
		} finally {
			running = false;
		}
	};
	void installPending();
	return [vscode.window.onDidChangeWindowState(state => { if (state.focused) { void installPending(); } })];
}
