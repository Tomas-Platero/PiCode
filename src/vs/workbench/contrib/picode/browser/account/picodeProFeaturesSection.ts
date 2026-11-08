/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerAccountSection } from './picodeAccountSections.js';
import { getProFeatures, IPicodeProEntitlement } from './picodeProEntitlement.js';

const $ = DOM.$;

class PicodeProFeaturesSection extends Disposable {

	constructor(
		private readonly container: HTMLElement,
		@IPicodeProEntitlement private readonly entitlement: IPicodeProEntitlement,
	) {
		super();
		this.render();
		this._register(this.entitlement.onDidChange(() => this.render()));
	}

	private render(): void {
		DOM.clearNode(this.container);
		const page = DOM.append(this.container, $('.picode-account-page'));
		DOM.append(page, $('h2')).textContent = localize('picodeProFeaturesTitle', "Pro features");
		if (!this.entitlement.isPro) {
			DOM.append(page, $('p.picode-account-lead')).textContent = localize('picodeProFeaturesLocked', "These come with the Pro plan. Upgrade from Overview to unlock them.");
		}
		const list = DOM.append(page, $('.picode-account-list'));
		for (const feature of getProFeatures()) {
			const row = DOM.append(list, $('.picode-account-row'));
			row.appendChild(renderIcon(feature.icon));
			const text = DOM.append(row, $('.picode-account-row-text'));
			DOM.append(text, $('strong')).textContent = feature.label;
			DOM.append(text, $('span')).textContent = feature.description;
			const state = DOM.append(row, $('span.picode-account-state'));
			if (!feature.available) {
				state.textContent = localize('picodeProFeatureSoon', "Coming soon");
			} else if (this.entitlement.isPro) {
				state.appendChild(renderIcon(Codicon.check));
				DOM.append(state, $('span')).textContent = localize('picodeProFeatureOn', "Included");
			} else {
				state.appendChild(renderIcon(Codicon.lock));
				DOM.append(state, $('span')).textContent = localize('picodeProFeatureLocked', "Pro");
			}
		}
	}
}

registerAccountSection({
	id: 'proFeatures',
	label: localize('picodeProFeaturesLabel', "Pro features"),
	icon: Codicon.star,
	order: 20,
	create: (instantiationService: IInstantiationService, container: HTMLElement) => instantiationService.createInstance(PicodeProFeaturesSection, container),
});
