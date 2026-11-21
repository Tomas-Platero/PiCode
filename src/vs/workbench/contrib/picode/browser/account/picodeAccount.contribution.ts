/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { accountPageSection } from './picodeAccountSections.js';
import './picodeAccountOverviewSection.js';
import './picodeAccountSyncSection.js';
import './picodeConnectionsSection.js';
import './picodeAccountPrivacySection.js';

export const PICODE_OPEN_ACCOUNT_COMMAND = 'picode.account.open';

registerAction2(class OpenPicodeAccountAction extends Action2 {
	constructor() {
		super({
			id: PICODE_OPEN_ACCOUNT_COMMAND,
			title: localize2('picodeOpenAccount', "PiCode: Open Account"),
			f1: true,
			menu: { id: MenuId.AccountsContext, group: '0_picode', order: 0 },
		});
	}

	/**
	 * The account lives in the Settings window. `page` opens it on that page (`'sync'`,
	 * `'connections'`, `'privacy'`); without one it opens on Account › Overview.
	 */
	async run(accessor: ServicesAccessor, page?: unknown): Promise<void> {
		await accessor.get(ICommandService).executeCommand('aiCustomization.openManagementEditor', accountPageSection(typeof page === 'string' ? page : undefined));
	}
});
