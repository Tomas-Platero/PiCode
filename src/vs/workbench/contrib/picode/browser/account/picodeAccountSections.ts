/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/picodeAccount.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { aiCustomizationManagementSectionRegistry } from '../../../chat/browser/aiCustomization/aiCustomizationManagementSectionRegistry.js';
import { AICustomizationManagementSection } from '../../../chat/common/aiCustomizationWorkspaceService.js';
import { accountLinkTarget } from '../settings/picodeSettingsData.js';

/** The Settings page an account link points at (`picode.account.open <page>`). */
export function accountPageSection(page: string | undefined): AICustomizationManagementSection {
	return accountLinkTarget(page);
}

/** One page of the account, shown under Account in the Settings window. */
export interface IPicodeAccountSection {
	/** The page's old name in account links: `overview`, `sync`, `connections` or `privacy`. */
	readonly id: 'overview' | 'sync' | 'connections' | 'privacy';
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly description: string;
	/** Extra words the Settings search box finds this page by. */
	readonly keywords?: readonly string[];
	create(instantiationService: IInstantiationService, container: HTMLElement): IDisposable;
}

export function registerAccountSection(section: IPicodeAccountSection): void {
	aiCustomizationManagementSectionRegistry.register({
		id: accountLinkTarget(section.id),
		label: section.label,
		icon: section.icon,
		description: section.description,
		keywords: section.keywords,
		supportsHarness: () => true,
		create: (instantiationService, container) => {
			// The account pages scroll inside their own box, as they did in their own window.
			const scroller = DOM.append(container, DOM.$('.picode-account-content'));
			const page = section.create(instantiationService, scroller);
			return toDisposable(() => {
				page.dispose();
				scroller.remove();
			});
		},
	});
}
