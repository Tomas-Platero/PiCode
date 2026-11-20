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
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IUserDataSyncEnablementService, IUserDataSyncService, SyncResource, SyncStatus } from '../../../../../platform/userDataSync/common/userDataSync.js';
import { IUserDataSyncMachine, IUserDataSyncMachinesService, isWebPlatform } from '../../../../../platform/userDataSync/common/userDataSyncMachines.js';
import { AccountStatus, IUserDataSyncWorkbenchService } from '../../../../services/userDataSync/common/userDataSync.js';
import { registerAccountSection } from './picodeAccountSections.js';
import { IPicodeProEntitlement } from './picodeProEntitlement.js';

const $ = DOM.$;

/** The switch the Chats tile flips; the connector reads it to back chats up in the background. */
const CHATS_SETTING = 'picode.sync.chats';

/** VS Code's own sync commands, run from the buttons of this page. */
const COMMANDS = {
	turnOn: 'workbench.userDataSync.actions.turnOn',
	turnOff: 'workbench.userDataSync.actions.turnOff',
	syncNow: 'workbench.userDataSync.actions.syncNow',
	signIn: 'workbench.userData.actions.signin',
	conflicts: 'workbench.userDataSync.actions.showConflicts',
	backups: 'workbench.userDataSync.actions.showSyncedData',
	clearCloud: 'workbench.actions.syncData.reset',
	restoreChats: 'picode.restoreSessions',
};

interface ICategory {
	readonly resource: SyncResource;
	readonly icon: ThemeIcon;
	readonly label: string;
	readonly description: string;
}

/**
 * Everything the cloud keeps, in the order it is read: what pi uses first, then the editor. Every
 * resource the sync engine moves has its tile, so nothing travels without the owner seeing it here.
 */
const CATEGORIES: readonly ICategory[] = [
	{ resource: SyncResource.PiProfile, icon: Codicon.robot, label: localize('picodeSyncAgents', "Agents and skills"), description: localize('picodeSyncAgentsDetail', "Agents, subagents, skills, agent profiles with their backup models, and pi's MCP servers.") },
	{ resource: SyncResource.Profiles, icon: Codicon.account, label: localize('picodeSyncProfiles', "Editor profiles"), description: localize('picodeSyncProfilesDetail', "Your editor profiles and the agent profile each one uses.") },
	{ resource: SyncResource.Settings, icon: Codicon.settingsGear, label: localize('picodeSyncSettings', "Settings"), description: localize('picodeSyncSettingsDescription', "Your editor preferences.") },
	{ resource: SyncResource.Keybindings, icon: Codicon.keyboard, label: localize('picodeSyncShortcuts', "Keyboard shortcuts"), description: localize('picodeSyncShortcutsDescription', "The keys you changed.") },
	{ resource: SyncResource.Extensions, icon: Codicon.extensions, label: localize('picodeSyncExtensions', "Extensions"), description: localize('picodeSyncExtensionsDescription', "The extensions you installed.") },
	{ resource: SyncResource.Snippets, icon: Codicon.symbolSnippet, label: localize('picodeSyncSnippets', "Snippets"), description: localize('picodeSyncSnippetsDescription', "Text you insert with a short word.") },
	{ resource: SyncResource.Tasks, icon: Codicon.tasklist, label: localize('picodeSyncTasks', "Tasks"), description: localize('picodeSyncTasksDetail', "The tasks you set up to build or run your projects.") },
	{ resource: SyncResource.Mcp, icon: Codicon.mcp, label: localize('picodeSyncEditorMcp', "Editor MCP servers"), description: localize('picodeSyncEditorMcpDetail', "MCP servers you added to the editor itself.") },
	{ resource: SyncResource.GlobalState, icon: Codicon.layout, label: localize('picodeSyncLayout', "Layout"), description: localize('picodeSyncLayoutDescription', "How the editor looks and opens.") },
];

type Tone = 'ok' | 'busy' | 'warn' | 'off';

class PicodeAccountSyncSection extends Disposable {

	private readonly renderStore = this._register(new DisposableStore());
	/** The computers on this account, read once per change: reading them is a call to the cloud. */
	private machines: IUserDataSyncMachine[] | undefined;
	private machinesLoading = false;

	constructor(
		private readonly container: HTMLElement,
		@IPicodeProEntitlement private readonly entitlement: IPicodeProEntitlement,
		@IUserDataSyncService private readonly userDataSyncService: IUserDataSyncService,
		@IUserDataSyncEnablementService private readonly enablementService: IUserDataSyncEnablementService,
		@IUserDataSyncWorkbenchService private readonly workbenchService: IUserDataSyncWorkbenchService,
		@IUserDataSyncMachinesService private readonly machinesService: IUserDataSyncMachinesService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		const rerender = () => this.render();
		this._register(this.configurationService.onDidChangeConfiguration(e => { if (e.affectsConfiguration(CHATS_SETTING)) { rerender(); } }));
		this._register(this.entitlement.onDidChange(rerender));
		this._register(this.userDataSyncService.onDidChangeStatus(rerender));
		this._register(this.userDataSyncService.onDidChangeConflicts(rerender));
		this._register(this.userDataSyncService.onDidChangeLastSyncTime(rerender));
		this._register(this.workbenchService.onDidChangeAccountStatus(rerender));
		this._register(this.enablementService.onDidChangeEnablement(() => { this.machines = undefined; rerender(); }));
		this._register(this.enablementService.onDidChangeResourceEnablement(rerender));
		this._register(this.machinesService.onDidChange(() => { this.machines = undefined; rerender(); }));
		this.render();
	}

	private render(): void {
		// Keep the reader's place: the page repaints on every sync tick.
		const scroller = this.container.closest('.picode-account-content');
		const scrollTop = scroller?.scrollTop ?? 0;
		this.renderStore.clear();
		DOM.clearNode(this.container);
		const page = DOM.append(this.container, $('.picode-account-page.picode-sync-page'));
		DOM.append(page, $('h2')).textContent = localize('picodeSyncTitle', "Cloud sync");
		DOM.append(page, $('p.picode-account-lead')).textContent = localize('picodeSyncLead', "Your setup, the same on every computer you sign in to.");

		if (!this.entitlement.isPro) {
			this.renderLocked(page);
		} else {
			const enabled = this.enablementService.isEnabled();
			this.renderStatus(page, enabled);
			this.renderCategories(page, enabled);
			if (enabled) {
				this.renderMachines(page);
				this.renderCloudData(page);
			}
		}
		if (scroller) {
			scroller.scrollTop = scrollTop;
		}
	}

	private renderLocked(page: HTMLElement): void {
		const card = DOM.append(page, $('.picode-sync-hero.off'));
		DOM.append(card, $('.picode-sync-hero-icon')).appendChild(renderIcon(Codicon.cloud));
		const text = DOM.append(card, $('.picode-sync-hero-text'));
		DOM.append(text, $('strong')).textContent = localize('picodeSyncProOnly', "Cloud sync is part of Pro");
		DOM.append(text, $('span')).textContent = this.entitlement.signedIn
			? localize('picodeSyncNeedsPro', "Cloud sync comes with the Pro plan. Upgrade from Overview to turn it on.")
			: localize('picodeSyncNeedsAccount', "Sign in with a Pro account to keep your setup in the cloud.");
		const actions = DOM.append(card, $('.picode-sync-hero-actions'));
		this.button(actions, localize('picodeSyncSeeOverview', "Go to Overview"), false, 'picode.account.open', 'overview');
	}

	/** One card that answers "is my setup safe in the cloud?" and holds the actions that change it. */
	private renderStatus(page: HTMLElement, enabled: boolean): void {
		const status = this.userDataSyncService.status;
		const signedOut = enabled && this.workbenchService.accountStatus === AccountStatus.Unavailable;
		const conflicts = this.userDataSyncService.conflicts.length;
		const tone: Tone = !enabled ? 'off' : signedOut || conflicts > 0 ? 'warn' : status === SyncStatus.Syncing ? 'busy' : 'ok';

		const card = DOM.append(page, $(`.picode-sync-hero.${tone}`));
		const icon = DOM.append(card, $('.picode-sync-hero-icon'));
		const text = DOM.append(card, $('.picode-sync-hero-text'));
		const title = DOM.append(text, $('strong'));
		const line = DOM.append(text, $('span'));
		const actions = DOM.append(card, $('.picode-sync-hero-actions'));

		if (!enabled) {
			icon.appendChild(renderIcon(Codicon.cloud));
			title.textContent = localize('picodeSyncOff', "Sync is off");
			line.textContent = localize('picodeSyncOffDetail', "Choose below what to keep in the cloud, then turn it on.");
			// The tiles below are what the owner chose, so VS Code's own list is not asked a second time.
			this.button(actions, localize('picodeSyncTurnOn', "Turn on sync"), false, COMMANDS.turnOn, { skipConfigure: true });
			return;
		}
		if (signedOut) {
			icon.appendChild(renderIcon(Codicon.warning));
			title.textContent = localize('picodeSyncSignedOut', "Sign in to keep syncing");
			line.textContent = localize('picodeSyncSignedOutDetail', "Your session ended. Nothing is sent until you sign in again.");
			this.button(actions, localize('picodeSyncSignIn', "Sign in"), false, COMMANDS.signIn);
			this.button(actions, localize('picodeSyncTurnOff', "Turn off"), true, COMMANDS.turnOff);
			return;
		}
		if (conflicts > 0) {
			icon.appendChild(renderIcon(Codicon.warning));
			title.textContent = localize('picodeSyncNeedsAttention', "Needs your attention");
			line.textContent = conflicts === 1
				? localize('picodeSyncOneConflict', "One part changed here and in the cloud. Choose which to keep.")
				: localize('picodeSyncConflicts', "{0} parts changed here and in the cloud. Choose which to keep.", conflicts);
			this.button(actions, localize('picodeSyncResolve', "Resolve"), false, COMMANDS.conflicts);
			this.button(actions, localize('picodeSyncTurnOff', "Turn off"), true, COMMANDS.turnOff);
			return;
		}

		const last = this.userDataSyncService.lastSyncTime;
		const account = this.workbenchService.current?.accountName;
		if (status === SyncStatus.Syncing) {
			icon.appendChild(renderIcon(ThemeIcon.modify(Codicon.sync, 'spin')));
			title.textContent = localize('picodeSyncSyncing', "Syncing…");
		} else {
			icon.appendChild(renderIcon(Codicon.passFilled));
			title.textContent = localize('picodeSyncUpToDate', "Up to date");
		}
		const when = last !== undefined ? localize('picodeSyncLast', "Last synced {0}", fromNow(last, true)) : localize('picodeSyncNeverYet', "First sync on its way");
		line.textContent = account ? localize('picodeSyncLastWithAccount', "{0} · {1}", when, account) : when;
		const now = this.button(actions, localize('picodeSyncNow', "Sync now"), false, COMMANDS.syncNow);
		now.enabled = status !== SyncStatus.Syncing;
		this.button(actions, localize('picodeSyncTurnOff', "Turn off"), true, COMMANDS.turnOff);
	}

	private renderCategories(page: HTMLElement, enabled: boolean): void {
		const head = DOM.append(page, $('.picode-sync-head'));
		DOM.append(head, $('h3')).textContent = localize('picodeSyncWhat', "What is synced");
		const count = CATEGORIES.filter(c => this.enablementService.isResourceEnabled(c.resource)).length
			+ (this.chatsOn() ? 1 : 0);
		DOM.append(head, $('span.picode-account-muted')).textContent = localize('picodeSyncCount', "{0} of {1}", count, CATEGORIES.length + 1);

		const grid = DOM.append(page, $('.picode-sync-grid'));
		const conflicted = new Set(this.userDataSyncService.conflicts.map(c => c.syncResource));
		for (const category of CATEGORIES) {
			const on = this.enablementService.isResourceEnabled(category.resource);
			const tile = this.tile(grid, category.icon, category.label, category.description, on, value => this.enablementService.setResourceEnablement(category.resource, value));
			this.tileState(tile, this.stateOf(enabled, on, conflicted.has(category.resource)));
		}
		this.renderChats(grid, enabled);
	}

	/**
	 * Chats are one more tile. They are copied by the connector, one file per chat, while the switch
	 * is on; *Restore* brings the copies back on this computer.
	 */
	private renderChats(grid: HTMLElement, enabled: boolean): void {
		const on = this.chatsOn();
		const tile = this.tile(grid, Codicon.commentDiscussion, localize('picodeSyncChats', "Chats"), localize('picodeSyncChatsDescription', "Your chats of the last 7 days."), on, value => { void this.configurationService.updateValue(CHATS_SETTING, value); });
		const foot = this.tileState(tile, this.stateOf(enabled, on, false));
		const restore = this.renderStore.add(new Button(foot, { ...defaultButtonStyles, secondary: true }));
		restore.label = localize('picodeSyncRestore', "Restore");
		restore.element.classList.add('picode-sync-small-button');
		this.renderStore.add(restore.onDidClick(() => { void this.commandService.executeCommand(COMMANDS.restoreChats); }));
	}

	private chatsOn(): boolean {
		return this.configurationService.getValue<boolean>(CHATS_SETTING) === true;
	}

	private stateOf(enabled: boolean, on: boolean, conflicted: boolean): { tone: Tone; icon: ThemeIcon; label: string } {
		if (!on) {
			return { tone: 'off', icon: Codicon.circleSlash, label: localize('picodeSyncTileOff', "Stays on this computer") };
		}
		if (!enabled) {
			return { tone: 'off', icon: Codicon.cloud, label: localize('picodeSyncTileReady', "Syncs when sync is on") };
		}
		if (conflicted) {
			return { tone: 'warn', icon: Codicon.warning, label: localize('picodeSyncTileConflict', "Changed in two places") };
		}
		if (this.userDataSyncService.status === SyncStatus.Syncing) {
			return { tone: 'busy', icon: ThemeIcon.modify(Codicon.sync, 'spin'), label: localize('picodeSyncSyncing', "Syncing…") };
		}
		return { tone: 'ok', icon: Codicon.passFilled, label: localize('picodeSyncTileSynced', "In the cloud") };
	}

	private tile(grid: HTMLElement, icon: ThemeIcon, label: string, description: string, on: boolean, change: (value: boolean) => void): HTMLElement {
		const tile = DOM.append(grid, $(`.picode-sync-tile${on ? '.on' : ''}`));
		const head = DOM.append(tile, $('label.picode-sync-tile-head'));
		DOM.append(head, $('.picode-sync-tile-icon')).appendChild(renderIcon(icon));
		DOM.append(head, $('strong')).textContent = label;
		const box = DOM.append(head, $('input.picode-sync-switch')) as HTMLInputElement;
		box.type = 'checkbox';
		box.setAttribute('role', 'switch');
		box.checked = on;
		box.setAttribute('aria-label', label);
		this.renderStore.add(DOM.addDisposableListener(box, DOM.EventType.CHANGE, () => change(box.checked)));
		DOM.append(tile, $('p.picode-sync-tile-text')).textContent = description;
		return tile;
	}

	private tileState(tile: HTMLElement, state: { tone: Tone; icon: ThemeIcon; label: string }): HTMLElement {
		const foot = DOM.append(tile, $('.picode-sync-tile-foot'));
		const badge = DOM.append(foot, $(`span.picode-sync-tile-state.${state.tone}`));
		badge.appendChild(renderIcon(state.icon));
		DOM.append(badge, $('span')).textContent = state.label;
		return foot;
	}

	/** The computers that share this setup, so the owner sees where it goes. */
	private renderMachines(page: HTMLElement): void {
		if (this.workbenchService.accountStatus !== AccountStatus.Available) {
			return;
		}
		DOM.append(page, $('h3')).textContent = localize('picodeSyncMachines', "Your computers");
		const list = DOM.append(page, $('.picode-account-list'));
		if (this.machines === undefined) {
			DOM.append(list, $('.picode-account-row.picode-account-muted')).textContent = localize('picodeSyncMachinesLoading', "Looking for your computers…");
			this.loadMachines();
			return;
		}
		const machines = this.machines.filter(m => !m.disabled).sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.name.localeCompare(b.name));
		if (machines.length === 0) {
			DOM.append(list, $('.picode-account-row.picode-account-muted')).textContent = localize('picodeSyncMachinesNone', "No computers yet. This one appears after its first sync.");
			return;
		}
		for (const machine of machines) {
			const row = DOM.append(list, $('.picode-account-row'));
			DOM.append(row, $('.picode-sync-tile-icon')).appendChild(renderIcon(machine.platform && isWebPlatform(machine.platform) ? Codicon.globe : Codicon.deviceDesktop));
			DOM.append(DOM.append(row, $('.picode-account-row-text')), $('strong')).textContent = machine.name;
			if (machine.isCurrent) {
				DOM.append(row, $('span.picode-account-badge')).textContent = localize('picodeSyncThisComputer', "This computer");
			}
		}
	}

	private loadMachines(): void {
		if (this.machinesLoading) {
			return;
		}
		this.machinesLoading = true;
		this.machinesService.getMachines().then(machines => {
			this.machines = machines;
		}, () => {
			this.machines = [];
		}).finally(() => {
			this.machinesLoading = false;
			if (!this._store.isDisposed) {
				this.render();
			}
		});
	}

	/** What is already in the cloud: earlier copies, and the way to wipe it. */
	private renderCloudData(page: HTMLElement): void {
		DOM.append(page, $('h3')).textContent = localize('picodeSyncCloudData', "Your data in the cloud");
		const list = DOM.append(page, $('.picode-account-list'));
		this.linkRow(list, Codicon.history, localize('picodeSyncBackups', "Earlier copies"), localize('picodeSyncBackupsDetail', "See what was synced and bring back an earlier copy."), localize('picodeSyncOpen', "Open"), COMMANDS.backups);
		this.linkRow(list, Codicon.trash, localize('picodeSyncClear', "Delete from the cloud"), localize('picodeSyncClearDetail', "Removes your synced data from the cloud. This computer keeps its own."), localize('picodeSyncDelete', "Delete…"), COMMANDS.clearCloud);
	}

	private linkRow(list: HTMLElement, icon: ThemeIcon, label: string, description: string, action: string, commandId: string): void {
		const row = DOM.append(list, $('.picode-account-row'));
		DOM.append(row, $('.picode-sync-tile-icon')).appendChild(renderIcon(icon));
		const text = DOM.append(row, $('.picode-account-row-text'));
		DOM.append(text, $('strong')).textContent = label;
		DOM.append(text, $('span')).textContent = description;
		this.button(row, action, true, commandId);
	}

	private button(parent: HTMLElement, label: string, secondary: boolean, commandId: string, ...args: unknown[]): Button {
		const button = this.renderStore.add(new Button(parent, { ...defaultButtonStyles, secondary }));
		button.label = label;
		this.renderStore.add(button.onDidClick(() => { void this.commandService.executeCommand(commandId, ...args); }));
		return button;
	}
}

registerAccountSection({
	id: 'sync',
	label: localize('picodeSyncLabel', "Cloud sync"),
	icon: Codicon.cloud,
	order: 10,
	create: (instantiationService: IInstantiationService, container: HTMLElement) => instantiationService.createInstance(PicodeAccountSyncSection, container),
});
