/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Button } from '../../../../../base/browser/ui/button/button.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';

/**
 * The one button a locked Pro page shows: it opens the plans page. Locked means exactly that and
 * nothing more, so there is no text about what is behind the lock.
 */
export function renderUpgradeButton(parent: HTMLElement, store: DisposableStore, openerService: IOpenerService, productService: IProductService): void {
	const origin = productService.picode?.webOrigin;
	if (!origin) {
		return;
	}
	const button = store.add(new Button(parent, { ...defaultButtonStyles }));
	button.label = localize('picodeUpgradeToPro', "Upgrade to Pro");
	store.add(button.onDidClick(() => { void openerService.open(URI.parse(`${origin}/pricing`)); }));
}
