/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { createServiceLogo } from '../picodeServiceLogo.js';
import { registerAccountSection } from './picodeAccountSections.js';
import { getConnectors, IPicodeConnector } from './picodeConnectors.js';
import { IPicodeProEntitlement } from './picodeProEntitlement.js';

const $ = DOM.$;

class PicodeConnectionsSection extends Disposable {

	private readonly renderStore = this._register(new DisposableStore());

	constructor(
		private readonly container: HTMLElement,
		@IPicodeProEntitlement private readonly entitlement: IPicodeProEntitlement,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.render();
		this._register(this.entitlement.onDidChange(() => this.render()));
	}

	private render(): void {
		this.renderStore.clear();
		DOM.clearNode(this.container);
		const page = DOM.append(this.container, $('.picode-account-page'));
		DOM.append(page, $('h2')).textContent = localize('picodeConnectionsTitle', "Connections");
		DOM.append(page, $('p.picode-account-lead')).textContent = this.entitlement.isPro
			? localize('picodeConnectionsLead', "Bring the work you already track into the chat.")
			: localize('picodeConnectionsLeadLocked', "Bring the work you already track into the chat. Connections come with the Pro plan.");

		const grid = DOM.append(page, $('.picode-account-grid'));
		for (const connector of getConnectors()) {
			this.renderCard(grid, connector);
		}
	}

	private renderCard(grid: HTMLElement, connector: IPicodeConnector): void {
		const card = DOM.append(grid, $('.picode-account-tile'));
		const head = DOM.append(card, $('.picode-account-tile-head'));
		head.appendChild(createServiceLogo(connector.serviceId));
		DOM.append(head, $('strong')).textContent = connector.label;
		DOM.append(card, $('p.picode-account-muted')).textContent = connector.description;

		const foot = DOM.append(card, $('.picode-account-tile-foot'));
		if (!connector.available) {
			DOM.append(foot, $('span.picode-account-state')).textContent = localize('picodeConnectorSoon', "Coming soon");
			return;
		}
		if (!this.entitlement.isPro) {
			const state = DOM.append(foot, $('span.picode-account-state'));
			state.appendChild(renderIcon(Codicon.lock));
			DOM.append(state, $('span')).textContent = localize('picodeConnectorProOnly', "Pro");
			return;
		}
		const command = connector.connectCommand;
		const connect = this.renderStore.add(new Button(foot, { ...defaultButtonStyles }));
		connect.label = localize('picodeConnectorConnect', "Connect");
		connect.enabled = command !== undefined;
		this.renderStore.add(connect.onDidClick(() => { if (command) { void this.commandService.executeCommand(command); } }));
	}
}

registerAccountSection({
	id: 'connections',
	label: localize('picodeConnectionsLabel', "Connections"),
	icon: Codicon.plug,
	order: 15,
	create: (instantiationService: IInstantiationService, container: HTMLElement) => instantiationService.createInstance(PicodeConnectionsSection, container),
});
