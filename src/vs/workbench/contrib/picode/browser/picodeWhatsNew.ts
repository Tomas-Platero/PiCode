/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { URI } from '../../../../base/common/uri.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { composeWhatsNew, extractWhatChanged, readHistory, shouldShowWhatsNew, whatsNewHistoryUrl, whatsNewSince, WhatsNewEntry } from './picodeWhatsNewData.js';

const LAST_VERSION_KEY = 'picode.whatsNew.lastVersion';
/** The core's own key (`ProductContribution` in contrib/update): the editor version of the last start. */
const EDITOR_LAST_VERSION_KEY = 'releaseNotes/lastVersion';
const RELEASES_API = 'https://api.github.com/repos/Tomas-Platero/PiCode/releases/tags/';

/**
 * Looks up what changed and shows it in a small window. `last` is the version the person updated
 * from: every version they skipped since then is shown too, below this one. Returns false when
 * there is nothing to show.
 */
async function showWhatsNew(version: string, last: string, requestService: IRequestService, dialogService: IDialogService, openerService: IOpenerService, productService: IProductService): Promise<boolean> {
	const [notes, history] = await Promise.all([fetchNotes(requestService, version), fetchHistory(requestService, productService.quality)]);
	const current = notes ? { version, notes } : history.find(entry => entry.version === version);
	if (!current) {
		return false;
	}
	const entries = whatsNewSince(last, current, history);
	const markdown = composeWhatsNew(entries);
	if (!markdown) {
		return false;
	}

	const releaseUrl = `${productService.releaseNotesUrl ?? 'https://github.com/Tomas-Platero/PiCode/releases'}/tag/v${version}`;
	await dialogService.prompt({
		message: localize('picodeWhatsNew.title', "PiCode {0} is ready", version),
		detail: entries.length > 1
			? localize('picodeWhatsNew.subtitleSince', "Here is what changed since {0}.", last)
			: localize('picodeWhatsNew.subtitle', "Here is what changed since the last version."),
		buttons: [
			{ label: localize('picodeWhatsNew.close', "Close"), run: () => undefined },
			{ label: localize('picodeWhatsNew.full', "Full release notes"), run: () => openerService.open(URI.parse(releaseUrl)) },
		],
		custom: { markdownDetails: [{ markdown: new MarkdownString(markdown) }] },
	});
	return true;
}

async function fetchNotes(requestService: IRequestService, version: string): Promise<string | undefined> {
	try {
		const context = await requestService.request({
			type: 'GET',
			url: RELEASES_API + encodeURIComponent(`v${version}`),
			headers: { 'Accept': 'application/vnd.github+json' },
			callSite: 'picodeWhatsNew',
		}, CancellationToken.None);
		if (context.res.statusCode !== 200) {
			return undefined;
		}
		const release = await asJson<{ body?: string }>(context);
		return release?.body ? extractWhatChanged(release.body) : undefined;
	} catch {
		return undefined;
	}
}

/** The summaries of the releases this channel replaced. Empty when the file cannot be reached: the window then shows this version alone. */
async function fetchHistory(requestService: IRequestService, quality: string | undefined): Promise<WhatsNewEntry[]> {
	const url = whatsNewHistoryUrl(quality);
	if (!url) {
		return [];
	}
	try {
		const context = await requestService.request({ type: 'GET', url, callSite: 'picodeWhatsNew' }, CancellationToken.None);
		if (context.res.statusCode !== 200) {
			return [];
		}
		return readHistory(await asJson<unknown>(context));
	} catch {
		return [];
	}
}

/**
 * After PiCode updates, shows a small window with what changed in the new version, and in
 * every version skipped on the way there.
 * Does nothing on a first install (the update that brought this window in counts as an update,
 * see `shouldShowWhatsNew`), when the version has not changed, when the user turned
 * release notes off (the same `update.showReleaseNotes` switch VS Code uses), or when the
 * release has no summary or cannot be reached.
 */
export class PicodeWhatsNewContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.picodeWhatsNew';

	private readonly editorLast: string;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IProductService private readonly productService: IProductService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IHostService hostService: IHostService,
		@IRequestService private readonly requestService: IRequestService,
		@IDialogService private readonly dialogService: IDialogService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		// Read now, at startup: the core's release-notes check stores this start's version over
		// it a moment later, and then an update could no longer be told from a first install.
		this.editorLast = this.storageService.get(EDITOR_LAST_VERSION_KEY, StorageScope.APPLICATION, '');
		// The window itself waits until the editor has settled, as it always did.
		lifecycleService.when(LifecyclePhase.Eventually).then(() => hostService.hadLastFocus()).then(hadLastFocus => {
			if (hadLastFocus) {
				return this.run();
			}
			return undefined;
		}).catch(() => { /* a missing summary must never get in the way of starting */ });
	}

	private async run(): Promise<void> {
		const current = this.productService.picodeVersion;
		if (!current) {
			return;
		}

		const last = this.storageService.get(LAST_VERSION_KEY, StorageScope.APPLICATION, '');
		this.storageService.store(LAST_VERSION_KEY, current, StorageScope.APPLICATION, StorageTarget.MACHINE);
		const show = shouldShowWhatsNew({ last, current, editorLast: this.editorLast, editorCurrent: this.productService.version });
		if (!show || !this.configurationService.getValue<boolean>('update.showReleaseNotes')) {
			return;
		}

		await showWhatsNew(current, last, this.requestService, this.dialogService, this.openerService, this.productService);
	}
}

// BlockRestore, not Eventually: the constructor must read the core's key before the core's
// release-notes check (LifecyclePhase.Restored) replaces it. The constructor only reads storage;
// the window itself still waits for the Eventually phase, focus and the network.
registerWorkbenchContribution2(PicodeWhatsNewContribution.ID, PicodeWhatsNewContribution, WorkbenchPhase.BlockRestore);

registerAction2(class ShowWhatsNewAction extends Action2 {
	constructor() {
		super({
			id: 'picode.showWhatsNew',
			title: localize2('picodeWhatsNew.command', "Show What's New"),
			category: localize2('picode.category', "PiCode"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const productService = accessor.get(IProductService);
		const notificationService = accessor.get(INotificationService);
		const version = productService.picodeVersion;
		const shown = version && await showWhatsNew(version, '', accessor.get(IRequestService), accessor.get(IDialogService), accessor.get(IOpenerService), productService);
		if (!shown) {
			notificationService.info(localize('picodeWhatsNew.none', "There are no release notes for this version yet."));
		}
	}
});
