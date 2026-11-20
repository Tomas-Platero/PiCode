/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { SHARE_USAGE_SETTING, shouldShowUsageNotice } from './picodeUsageSharingData.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

const NOTICE_SHOWN_STORAGE_KEY = 'picode.privacy.usageNoticeShown';

/** The one-time notice for installs that updated to 2.4.1 without seeing the setup's switch. */
class PicodeUsageSharingNotice extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.picodeUsageSharingNotice';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
	) {
		super();
		const shown = storageService.getBoolean(NOTICE_SHOWN_STORAGE_KEY, StorageScope.APPLICATION, false);
		if (!shouldShowUsageNotice(configurationService.inspect(SHARE_USAGE_SETTING).userValue, shown)) {
			return;
		}
		storageService.store(NOTICE_SHOWN_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		const choose = (value: boolean) => { void configurationService.updateValue(SHARE_USAGE_SETTING, value, ConfigurationTarget.USER); };
		notificationService.prompt(
			Severity.Info,
			localize('picodeUsageNotice', "PiCode sends anonymous usage counts when it checks for updates: version, system and whether you used it today. Never your code, chats, files or account."),
			[
				{ label: localize('picodeUsageNoticeKeep', "Keep sharing"), run: () => choose(true) },
				{ label: localize('picodeUsageNoticeOff', "Turn off"), run: () => choose(false) },
			],
			{ sticky: true },
		);
	}
}

registerWorkbenchContribution2(PicodeUsageSharingNotice.ID, PicodeUsageSharingNotice, WorkbenchPhase.Eventually);
