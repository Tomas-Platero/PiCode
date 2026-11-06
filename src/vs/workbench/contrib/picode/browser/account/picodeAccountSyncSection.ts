/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IUserDataSyncEnablementService, IUserDataSyncService, SyncResource, SyncStatus } from '../../../../../platform/userDataSync/common/userDataSync.js';
import { registerAccountSection } from './picodeAccountSections.js';
import { IPicodeProEntitlement } from './picodeProEntitlement.js';

const $ = DOM.$;

/** The switch the Chats row flips; the connector reads it to back chats up in the background. */
const CHATS_SETTING = 'picode.sync.chats';

/** What the user can switch on or off, in the order they read it, said in plain words. */
const CATEGORIES: readonly { readonly resource: SyncResource; readonly label: string; readonly description: string }[] = [
	{ resource: SyncResource.PiProfile, label: localize('picodeSyncAgents', "Agents and skills"), description: localize('picodeSyncAgentsDescription', "Your agents, subagents and skills.") },
	{ resource: SyncResource.Settings, label: localize('picodeSyncSettings', "Settings"), description: localize('picodeSyncSettingsDescription', "Your editor preferences.") },
	{ resource: SyncResource.Keybindings, label: localize('picodeSyncShortcuts', "Keyboard shortcuts"), description: localize('picodeSyncShortcutsDescription', "The keys you changed.") },
	{ resource: SyncResource.Snippets, label: localize('picodeSyncSnippets', "Snippets"), description: localize('picodeSyncSnippetsDescription', "Text you insert with a short word.") },
	{ resource: SyncResource.Extensions, label: localize('picodeSyncExtensions', "Extensions"), description: localize('picodeSyncExtensionsDescription', "The extensions you installed.") },
	{ resource: SyncResource.GlobalState, label: localize('picodeSyncLayout', "Layout"), description: localize('picodeSyncLayoutDescription', "How the editor looks and opens.") },
];

class PicodeAccountSyncSection extends Disposable {

	private readonly renderStore = this._register(new DisposableStore());

	constructor(
		private readonly container: HTMLElement,
		@IPicodeProEntitlement private readonly entitlement: IPicodeProEntitlement,
		@IUserDataSyncService private readonly userDataSyncService: IUserDataSyncService,
		@IUserDataSyncEnablementService private readonly enablementService: IUserDataSyncEnablementService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => { if (e.affectsConfiguration(CHATS_SETTING)) { this.render(); } }));
		this.render();
		this._register(this.entitlement.onDidChange(() => this.render()));
		this._register(this.userDataSyncService.onDidChangeStatus(() => this.render()));
		this._register(this.userDataSyncService.onDidChangeLastSyncTime(() => this.render()));
		this._register(this.enablementService.onDidChangeEnablement(() => this.render()));
		this._register(this.enablementService.onDidChangeResourceEnablement(() => this.render()));
	}

	private render(): void {
		this.renderStore.clear();
		DOM.clearNode(this.container);
		const page = DOM.append(this.container, $('.picode-account-page'));
		DOM.append(page, $('h2')).textContent = localize('picodeSyncTitle', "Cloud sync");

		if (!this.entitlement.isPro) {
			DOM.append(page, $('p.picode-account-lead')).textContent = this.entitlement.signedIn
				? localize('picodeSyncNeedsPro', "Cloud sync comes with the Pro plan. Upgrade from Overview to turn it on.")
				: localize('picodeSyncNeedsAccount', "Sign in with a Pro account to keep your setup in the cloud.");
			return;
		}

		const enabled = this.enablementService.isEnabled();
		const status = this.userDataSyncService.status;
		const summary = DOM.append(page, $('.picode-account-card'));
		const tone = !enabled ? 'off' : status === SyncStatus.HasConflicts ? 'warn' : status === SyncStatus.Syncing ? 'busy' : 'ok';
		const state = DOM.append(summary, $(`span.picode-account-sync-state.${tone}`));
		if (!enabled) {
			state.appendChild(renderIcon(Codicon.circleSlash));
			DOM.append(state, $('span')).textContent = localize('picodeSyncOff', "Sync is off");
		} else if (status === SyncStatus.HasConflicts) {
			state.appendChild(renderIcon(Codicon.warning));
			DOM.append(state, $('span')).textContent = localize('picodeSyncNeedsAttention', "Needs your attention");
		} else if (status === SyncStatus.Syncing) {
			state.appendChild(renderIcon(Codicon.sync));
			DOM.append(state, $('span')).textContent = localize('picodeSyncSyncing', "Syncing…");
		} else {
			state.appendChild(renderIcon(Codicon.passFilled));
			DOM.append(state, $('span')).textContent = localize('picodeSyncUpToDate', "Up to date");
		}
		const last = this.userDataSyncService.lastSyncTime;
		const note = DOM.append(summary, $('span.picode-account-muted'));
		note.style.marginLeft = 'auto';
		note.textContent = enabled
			? (last !== undefined ? localize('picodeSyncLast', "Last synced {0}", fromNow(last, true)) : '')
			: localize('picodeSyncOffLine', "Turn it on to keep your setup in the cloud.");

		const actions = DOM.append(page, $('.picode-account-actions'));
		if (enabled) {
			this.button(actions, localize('picodeSyncNow', "Sync now"), false, 'workbench.userDataSync.actions.syncNow');
			this.button(actions, localize('picodeSyncTurnOff', "Turn off"), true, 'workbench.userDataSync.actions.turnOff');
		} else {
			this.button(actions, localize('picodeSyncTurnOn', "Turn on sync"), false, 'workbench.userDataSync.actions.turnOn');
		}

		DOM.append(page, $('h3')).textContent = localize('picodeSyncWhat', "What is synced");
		const list = DOM.append(page, $('.picode-account-list'));
		for (const { resource, label, description } of CATEGORIES) {
			const row = DOM.append(list, $('label.picode-account-row'));
			const box = DOM.append(row, $('input')) as HTMLInputElement;
			box.setAttribute('type', 'checkbox');
			box.checked = this.enablementService.isResourceEnabled(resource);
			box.disabled = !enabled;
			const text = DOM.append(row, $('.picode-account-row-text'));
			DOM.append(text, $('strong')).textContent = label;
			DOM.append(text, $('span')).textContent = description;
			this.renderStore.add(DOM.addDisposableListener(box, DOM.EventType.CHANGE, () => this.enablementService.setResourceEnablement(resource, box.checked)));
		}

		this.renderChats(list);
	}

	/**
	 * Chats are one more row of the list. They are copied by the connector, one file per chat, while the
	 * switch is on; *Restore* brings the copies back on this computer.
	 */
	private renderChats(list: HTMLElement): void {
		// The button sits beside the label, not inside it, so pressing it does not flip the switch.
		const row = DOM.append(list, $('.picode-account-row'));
		const toggle = DOM.append(row, $('label.picode-account-row-label'));
		const box = DOM.append(toggle, $('input')) as HTMLInputElement;
		box.setAttribute('type', 'checkbox');
		box.checked = this.configurationService.getValue<boolean>(CHATS_SETTING) === true;
		const text = DOM.append(toggle, $('.picode-account-row-text'));
		DOM.append(text, $('strong')).textContent = localize('picodeSyncChats', "Chats");
		DOM.append(text, $('span')).textContent = localize('picodeSyncChatsDescription', "Your chats of the last 7 days.");
		this.renderStore.add(DOM.addDisposableListener(box, DOM.EventType.CHANGE, () => { void this.configurationService.updateValue(CHATS_SETTING, box.checked); }));
		const restore = this.renderStore.add(new Button(row, { ...defaultButtonStyles, secondary: true }));
		restore.label = localize('picodeSyncRestore', "Restore");
		this.renderStore.add(restore.onDidClick(() => { void this.commandService.executeCommand('picode.restoreSessions'); }));
	}

	private button(parent: HTMLElement, label: string, secondary: boolean, commandId: string): void {
		const button = this.renderStore.add(new Button(parent, { ...defaultButtonStyles, secondary }));
		button.label = label;
		this.renderStore.add(button.onDidClick(() => { void this.commandService.executeCommand(commandId); }));
	}
}

registerAccountSection({
	id: 'sync',
	label: localize('picodeSyncLabel', "Cloud sync"),
	icon: Codicon.cloud,
	order: 10,
	create: (instantiationService: IInstantiationService, container: HTMLElement) => instantiationService.createInstance(PicodeAccountSyncSection, container),
});
