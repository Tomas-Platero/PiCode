/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './issues/picodeIssues.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { createServiceLogo } from '../picodeServiceLogo.js';
import { PicodeConnectorService } from './issues/picodeConnectorAuth.js';
import { IPicodeConnectorService, PicodeConnectOutcome } from './issues/picodeConnectorService.js';
import { outcomeMessage } from './issues/picodeIssueActions.js';
import { registerAccountSection } from './picodeAccountSections.js';
import { getConnectors, IPicodeConnector } from './picodeConnectors.js';
import { IPicodeProEntitlement } from './picodeProEntitlement.js';
import { renderUpgradeButton } from './picodeProUpgrade.js';

const $ = DOM.$;

/** What a connection in progress shows: the code to type (GitHub) and how to stop. */
interface IAttempt {
	cancel(): void;
	code?: string;
}

/**
 * The Connections page: every service Pro brings into the chat, and where each one is connected.
 * Signing in to a service happens here, on its card; the issues themselves are listed in the
 * Status column.
 */
class PicodeConnectionsSection extends Disposable {

	private readonly renderStore = this._register(new DisposableStore());
	private readonly attempts = new Map<PicodeConnectorService, IAttempt>();
	/** The last failed attempt's sentence, kept until the person tries again. */
	private readonly messages = new Map<PicodeConnectorService, string>();

	constructor(
		private readonly container: HTMLElement,
		@IPicodeProEntitlement private readonly entitlement: IPicodeProEntitlement,
		@ICommandService private readonly commandService: ICommandService,
		@IPicodeConnectorService private readonly connectorService: IPicodeConnectorService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IProductService private readonly productService: IProductService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super();
		this.render();
		this._register(this.entitlement.onDidChange(() => this.render()));
		this._register(this.connectorService.onDidChange(() => this.render()));
	}

	override dispose(): void {
		for (const attempt of this.attempts.values()) {
			attempt.cancel();
		}
		super.dispose();
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

	private button(parent: HTMLElement, label: string, secondary = false): Button {
		const button = this.renderStore.add(new Button(parent, { ...defaultButtonStyles, secondary }));
		button.label = label;
		return button;
	}

	private renderCard(grid: HTMLElement, connector: IPicodeConnector): void {
		const card = DOM.append(grid, $('.picode-account-tile'));
		const head = DOM.append(card, $('.picode-account-tile-head'));
		head.appendChild(createServiceLogo(connector.serviceId));
		DOM.append(head, $('strong')).textContent = connector.label;
		DOM.append(card, $('p.picode-account-muted')).textContent = connector.description;

		const foot = DOM.append(card, $('.picode-account-tile-foot'));
		const service = connector.issues;
		if (!connector.available || (service && !this.connectorService.isAvailable(service))) {
			DOM.append(foot, $('span.picode-account-state')).textContent = localize('picodeConnectorSoon', "Coming soon");
			return;
		}
		if (!this.entitlement.isPro) {
			// Locked: one button, no explanation of what is behind it.
			renderUpgradeButton(foot, this.renderStore, this.openerService, this.productService);
			return;
		}
		if (service) {
			this.renderConnection(card, foot, service);
			return;
		}
		const command = connector.connectCommand;
		const connect = this.button(foot, localize('picodeConnectorConnect', "Connect"));
		connect.enabled = command !== undefined;
		this.renderStore.add(connect.onDidClick(() => { if (command) { void this.commandService.executeCommand(command); } }));
	}

	private renderConnection(card: HTMLElement, foot: HTMLElement, service: PicodeConnectorService): void {
		const name = service === 'github' ? 'GitHub' : 'Jira';
		const attempt = this.attempts.get(service);
		if (attempt) {
			if (attempt.code) {
				DOM.append(card, $('p.picode-account-muted')).textContent = localize('picodeIssuesEnterCode', "Enter this code on GitHub:");
				DOM.append(card, $('p.picode-issues-code')).textContent = attempt.code;
			}
			const state = DOM.append(foot, $('span.picode-account-state'));
			state.appendChild(renderIcon(Codicon.loading));
			DOM.append(state, $('span')).textContent = localize('picodeIssuesWaiting', "Waiting for {0}…", name);
			const cancel = this.button(foot, localize('picodeIssuesCancel', "Cancel"), true);
			this.renderStore.add(cancel.onDidClick(() => attempt.cancel()));
			return;
		}
		if (this.connectorService.isConnected(service)) {
			const site = service === 'atlassian' ? this.connectorService.jiraSiteName : undefined;
			const state = DOM.append(foot, $('span.picode-account-state'));
			state.appendChild(renderIcon(Codicon.check));
			DOM.append(state, $('span')).textContent = site
				? localize('picodeIssuesConnectedTo', "Connected to {0}.", site)
				: localize('picodeConnectorConnected', "Connected");
			const disconnect = this.button(foot, localize('picodeIssuesDisconnect', "Disconnect"), true);
			this.renderStore.add(disconnect.onDidClick(() => { void this.connectorService.disconnect(service); }));
			return;
		}
		const message = this.messages.get(service);
		if (message) {
			DOM.append(card, $('p.picode-issues-notice')).textContent = message;
		}
		const connect = this.button(foot, localize('picodeConnectorConnect', "Connect"));
		this.renderStore.add(connect.onDidClick(() => { void this.connect(service, name); }));
	}

	private async connect(service: PicodeConnectorService, name: string): Promise<void> {
		this.messages.delete(service);
		const source = new CancellationTokenSource();
		const attempt: IAttempt = { cancel: () => source.cancel() };
		this.attempts.set(service, attempt);
		this.render();
		let outcome: PicodeConnectOutcome;
		try {
			if (service === 'github') {
				const github = await this.connectorService.beginGithub();
				attempt.cancel = () => github.cancel();
				attempt.code = github.code.userCode;
				this.render();
				// The code is copied and GitHub's page opens by itself; it stays on the card in case it is needed again.
				void this.clipboardService.writeText(github.code.userCode);
				void this.openerService.open(URI.parse(github.code.verificationUri), { openExternal: true });
				outcome = await github.done;
			} else {
				outcome = await this.connectorService.connectAtlassian(source.token);
			}
		} catch {
			outcome = 'failed';
		} finally {
			source.dispose();
			this.attempts.delete(service);
		}
		const message = outcomeMessage(outcome, name);
		if (message) {
			this.messages.set(service, message);
		}
		this.render();
	}
}

registerAccountSection({
	id: 'connections',
	label: localize('picodeConnectionsLabel', "Connections"),
	icon: Codicon.plug,
	order: 15,
	create: (instantiationService: IInstantiationService, container: HTMLElement) => instantiationService.createInstance(PicodeConnectionsSection, container),
});
