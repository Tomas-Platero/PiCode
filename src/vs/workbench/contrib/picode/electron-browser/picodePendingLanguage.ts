/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Language } from '../../../../base/common/platform.js';
import { joinPath, isEqualOrParent } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IExtensionManagementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { INativeWorkbenchEnvironmentService } from '../../../services/environment/electron-browser/environmentService.js';

/**
 * Installs the language pack the setup window downloaded.
 *
 * The setup runs before the editor exists and the editor's language is fixed when it starts, so
 * the setup can only have the pack ready: it leaves the file, and a note saying what it is, in
 * `<user data>/picode-language/` (`extensions/picode/src/display-language.ts`). This installs the
 * pack like any other extension when setup was opened from inside the editor. First-run setup
 * applies its own pack before opening a window.
 *
 * It runs at the editor's start and again whenever the window regains focus, which is how a setup
 * opened from inside the editor is picked up the moment it closes. The note is removed **before** the
 * install: a pack that fails to install must not be retried at every start. Nothing here throws,
 * and a missing note is the ordinary case.
 */
class PicodePendingLanguage extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.picodePendingLanguage';

	constructor(
		@IFileService private readonly fileService: IFileService,
		@INativeWorkbenchEnvironmentService private readonly environmentService: INativeWorkbenchEnvironmentService,
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@ILogService private readonly logService: ILogService,
		@IHostService hostService: IHostService,
	) {
		super();
		this._register(hostService.onDidChangeFocus(focused => {
			if (focused) {
				void this.run();
			}
		}));
		void this.run();
	}

	private running = false;

	private async run(): Promise<void> {
		if (this.running) {
			return;
		}
		this.running = true;
		try {
			await this.install();
		} catch (error) {
			this.logService.warn('[picode-language] the language pack could not be installed', error);
		} finally {
			this.running = false;
		}
	}

	private async install(): Promise<void> {
		const folder = joinPath(URI.file(this.environmentService.userDataPath), 'picode-language');
		const note = joinPath(folder, 'pending.json');

		let pending: { language?: unknown; file?: unknown; firstRun?: unknown };
		try {
			pending = JSON.parse((await this.fileService.readFile(note)).value.toString());
		} catch {
			return; // no note: the ordinary case
		}
		if (pending.firstRun === true && pending.language !== Language.value()) {
			return;
		}

		// Whatever happens next, the note is spent.
		await this.fileService.del(note).catch(() => undefined);

		const language = typeof pending.language === 'string' ? pending.language : '';
		const file = typeof pending.file === 'string' ? URI.file(pending.file) : undefined;
		const valid = /^[a-z]{2}(-[a-z]{2})?$/.test(language) && file !== undefined && file.path.endsWith('.vsix') && isEqualOrParent(file, folder);
		if (valid && language !== Language.value()) {
			try {
				await this.extensionManagementService.install(file, { isMachineScoped: false });
			} catch (error) {
				this.logService.warn(`[picode-language] installing the ${language} language pack failed`, error);
			}
		}
		await this.fileService.del(folder, { recursive: true }).catch(() => undefined);
	}
}

registerWorkbenchContribution2(PicodePendingLanguage.ID, PicodePendingLanguage, WorkbenchPhase.AfterRestored);
