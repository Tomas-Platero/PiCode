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
import { IUserDataSyncMachine, IUserDataSyncMachinesService } from '../../../../../platform/userDataSync/common/userDataSyncMachines.js';
import { PI_PROFILE_PARTS, PI_PROFILE_SKIP_SETTING, PiProfilePart, skippedPiProfileParts } from '../../../../../platform/userDataSync/common/piProfileContent.js';
import { AccountStatus, IUserDataSyncWorkbenchService } from '../../../../services/userDataSync/common/userDataSync.js';
import { registerAccountSection } from './picodeAccountSections.js';
import { IPicodeProEntitlement } from './picodeProEntitlement.js';

const $ = DOM.$;

/** The switch the Chats row flips; the connector reads it to back chats up in the background. */
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

/** One row of the page: what it is, the colour of its icon, and how its switch is read and set. */
interface IItem {
	readonly id: string;
	readonly icon: ThemeIcon;
	/** A `--vscode-charts-*` colour, so every row is told apart at a glance and follows the theme. */
	readonly color: string;
	readonly label: string;
	readonly description: string;
	/** The sync engine's resource, or none for Chats, which the connector copies on its own. */
	readonly resource?: SyncResource;
	/** For the agents' rows: the part of that resource the row switches (`piProfileContent.ts`). */
	readonly part?: PiProfilePart;
}

interface IGroup {
	readonly label: string;
	readonly items: readonly IItem[];
	/** One line under the group, for what it leaves out on purpose. */
	readonly note?: string;
}

const CHATS_ID = 'chats';

/**
 * Everything the cloud keeps, in two groups: what pi uses, then the editor. Every resource the sync
 * engine moves has its row, so nothing travels without the owner seeing it here.
 */
const GROUPS: readonly IGroup[] = [
	{
		label: localize('picodeSyncGroupAgents', "Agents and chats"),
		items: [
			{ id: 'agents', resource: SyncResource.PiProfile, part: 'agents', icon: Codicon.robot, color: 'purple', label: localize('picodeSyncPartAgents', "Agents"), description: localize('picodeSyncPartAgentsDetail', "Your agents and the chains they run.") },
			{ id: 'subagents', resource: SyncResource.PiProfile, part: 'subagents', icon: Codicon.organization, color: 'blue', label: localize('picodeSyncPartSubagents', "Subagents"), description: localize('picodeSyncPartSubagentsDetail', "The helpers your agents hand work to.") },
			{ id: 'skills', resource: SyncResource.PiProfile, part: 'skills', icon: Codicon.mortarBoard, color: 'green', label: localize('picodeSyncPartSkills', "Skills"), description: localize('picodeSyncPartSkillsDetail', "What your agents know how to do.") },
			{ id: 'agentProfiles', resource: SyncResource.PiProfile, part: 'agentProfiles', icon: Codicon.layers, color: 'orange', label: localize('picodeSyncPartProfiles', "Agent profiles"), description: localize('picodeSyncPartProfilesDetail', "Which model each agent uses, with its backup models.") },
			{ id: 'mcp', resource: SyncResource.PiProfile, part: 'mcp', icon: Codicon.mcp, color: 'red', label: localize('picodeSyncPartMcp', "MCP servers"), description: localize('picodeSyncPartMcpDetail', "The servers your agents connect to.") },
			{ id: 'models', resource: SyncResource.PiProfile, part: 'models', icon: Codicon.chip, color: 'yellow', label: localize('picodeSyncPartModels', "Models and providers"), description: localize('picodeSyncPartModelsDetail', "The providers and models you added.") },
			{ id: 'agentSettings', resource: SyncResource.PiProfile, part: 'agentSettings', icon: Codicon.settings, color: 'blue', label: localize('picodeSyncPartSettings', "Agent settings"), description: localize('picodeSyncPartSettingsDetail', "Default model, package list, how the agent talks and how chats start.") },
			{ id: 'memory', resource: SyncResource.PiProfile, part: 'memory', icon: Codicon.note, color: 'purple', label: localize('picodeSyncPartMemory', "Memory notes"), description: localize('picodeSyncPartMemoryDetail', "The notes your agents saved.") },
			{ id: CHATS_ID, icon: Codicon.commentDiscussion, color: 'blue', label: localize('picodeSyncChats', "Chats"), description: localize('picodeSyncChatsDescription', "Your chats of the last 7 days.") },
		],
		note: localize('picodeSyncKeysStay', "Keys and sign-ins stay on each computer: MCP servers and providers travel without them."),
	},
	{
		label: localize('picodeSyncGroupEditor', "Editor"),
		items: [
			{ id: 'profiles', resource: SyncResource.Profiles, icon: Codicon.account, color: 'purple', label: localize('picodeSyncProfiles', "Editor profiles"), description: localize('picodeSyncProfilesDetail', "Your editor profiles and the agent profile each one uses.") },
			{ id: 'settings', resource: SyncResource.Settings, icon: Codicon.settingsGear, color: 'blue', label: localize('picodeSyncSettings', "Settings"), description: localize('picodeSyncSettingsDescription', "Your editor preferences.") },
			{ id: 'keys', resource: SyncResource.Keybindings, icon: Codicon.keyboard, color: 'orange', label: localize('picodeSyncShortcuts', "Keyboard shortcuts"), description: localize('picodeSyncShortcutsDescription', "The keys you changed.") },
			{ id: 'extensions', resource: SyncResource.Extensions, icon: Codicon.extensions, color: 'green', label: localize('picodeSyncExtensions', "Extensions"), description: localize('picodeSyncExtensionsDescription', "The extensions you installed.") },
			{ id: 'snippets', resource: SyncResource.Snippets, icon: Codicon.symbolSnippet, color: 'yellow', label: localize('picodeSyncSnippets', "Snippets"), description: localize('picodeSyncSnippetsDescription', "Text you insert with a short word.") },
			{ id: 'tasks', resource: SyncResource.Tasks, icon: Codicon.tasklist, color: 'red', label: localize('picodeSyncTasks', "Tasks"), description: localize('picodeSyncTasksDetail', "The tasks you set up to build or run your projects.") },
			{ id: 'mcp', resource: SyncResource.Mcp, icon: Codicon.mcp, color: 'green', label: localize('picodeSyncEditorMcp', "Editor MCP servers"), description: localize('picodeSyncEditorMcpDetail', "MCP servers you added to the editor itself.") },
			{ id: 'layout', resource: SyncResource.GlobalState, icon: Codicon.layout, color: 'orange', label: localize('picodeSyncLayout', "Layout"), description: localize('picodeSyncLayoutDescription', "How the editor looks and opens.") },
		],
	},
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
		this._register(this.configurationService.onDidChangeConfiguration(e => { if (e.affectsConfiguration(CHATS_SETTING) || e.affectsConfiguration(PI_PROFILE_SKIP_SETTING)) { rerender(); } }));
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
		const head = DOM.append(page, $('.picode-sync-title'));
		DOM.append(head, $('h2')).textContent = localize('picodeSyncTitle', "Cloud sync");
		DOM.append(head, $('p.picode-account-lead')).textContent = localize('picodeSyncLead', "Your setup, the same on every computer you sign in to.");

		if (!this.entitlement.isPro) {
			this.renderLocked(page);
		} else {
			const enabled = this.enablementService.isEnabled();
			this.renderHero(page, enabled);
			for (const group of GROUPS) {
				this.renderGroup(page, group, enabled);
			}
			if (enabled) {
				this.renderCloudData(page);
			}
		}
		if (scroller) {
			scroller.scrollTop = scrollTop;
		}
	}

	private renderLocked(page: HTMLElement): void {
		const hero = DOM.append(page, $('.picode-sync-hero.off'));
		this.renderFlow(hero, 'off', false);
		const body = DOM.append(hero, $('.picode-sync-hero-body'));
		const text = DOM.append(body, $('.picode-sync-hero-text'));
		DOM.append(text, $('strong')).textContent = localize('picodeSyncProOnly', "Cloud sync is part of Pro");
		DOM.append(text, $('span')).textContent = this.entitlement.signedIn
			? localize('picodeSyncNeedsPro', "Cloud sync comes with the Pro plan. Upgrade from Overview to turn it on.")
			: localize('picodeSyncNeedsAccount', "Sign in with a Pro account to keep your setup in the cloud.");
		this.button(DOM.append(body, $('.picode-sync-hero-actions')), localize('picodeSyncSeeOverview', "Go to Overview"), false, 'picode.account.open', 'overview');
	}

	/**
	 * The answer to "is my setup safe in the cloud?": a drawing of where it goes (this computer, the
	 * cloud, the other computers), the state in words, and the actions that change it.
	 */
	private renderHero(page: HTMLElement, enabled: boolean): void {
		const status = this.userDataSyncService.status;
		const signedOut = enabled && this.workbenchService.accountStatus === AccountStatus.Unavailable;
		const conflicts = this.userDataSyncService.conflicts.length;
		const tone: Tone = !enabled ? 'off' : signedOut || conflicts > 0 ? 'warn' : status === SyncStatus.Syncing ? 'busy' : 'ok';

		const hero = DOM.append(page, $(`.picode-sync-hero.${tone}`));
		this.renderFlow(hero, tone, enabled && !signedOut);
		const body = DOM.append(hero, $('.picode-sync-hero-body'));
		const text = DOM.append(body, $('.picode-sync-hero-text'));
		const title = DOM.append(text, $('strong'));
		const line = DOM.append(text, $('span'));
		const actions = DOM.append(body, $('.picode-sync-hero-actions'));

		if (!enabled) {
			title.textContent = localize('picodeSyncOff', "Sync is off");
			line.textContent = localize('picodeSyncOffDetail', "Choose below what to keep in the cloud, then turn it on.");
			// The rows below are what the owner chose, so VS Code's own list is not asked a second time.
			this.button(actions, localize('picodeSyncTurnOn', "Turn on sync"), false, COMMANDS.turnOn, { skipConfigure: true });
			return;
		}
		if (signedOut) {
			title.textContent = localize('picodeSyncSignedOut', "Sign in to keep syncing");
			line.textContent = localize('picodeSyncSignedOutDetail', "Your session ended. Nothing is sent until you sign in again.");
			this.button(actions, localize('picodeSyncSignIn', "Sign in"), false, COMMANDS.signIn);
			this.button(actions, localize('picodeSyncTurnOff', "Turn off"), true, COMMANDS.turnOff);
			return;
		}
		if (conflicts > 0) {
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
		title.textContent = status === SyncStatus.Syncing ? localize('picodeSyncSyncing', "Syncing…") : localize('picodeSyncUpToDate', "Up to date");
		const when = last !== undefined ? localize('picodeSyncLast', "Last synced {0}", fromNow(last, true)) : localize('picodeSyncNeverYet', "First sync on its way");
		line.textContent = account ? localize('picodeSyncLastWithAccount', "{0} · {1}", when, account) : when;
		const now = this.button(actions, localize('picodeSyncNow', "Sync now"), false, COMMANDS.syncNow);
		now.enabled = status !== SyncStatus.Syncing;
		this.button(actions, localize('picodeSyncTurnOff', "Turn off"), true, COMMANDS.turnOff);
	}

	/** This computer — the cloud — the other computers on the account, joined by lines that move while syncing. */
	private renderFlow(hero: HTMLElement, tone: Tone, live: boolean): void {
		const flow = DOM.append(hero, $('.picode-sync-flow'));
		flow.setAttribute('aria-hidden', 'true');
		this.flowNode(flow, Codicon.deviceDesktop, localize('picodeSyncThisComputer', "This computer"));
		DOM.append(flow, $(`.picode-sync-flow-line${tone === 'busy' ? '.moving' : ''}`));
		const cloud = DOM.append(flow, $('.picode-sync-flow-cloud'));
		cloud.appendChild(renderIcon(tone === 'warn' ? Codicon.warning : tone === 'busy' ? ThemeIcon.modify(Codicon.sync, 'spin') : tone === 'ok' ? Codicon.check : Codicon.cloud));
		DOM.append(flow, $(`.picode-sync-flow-line${tone === 'busy' ? '.moving' : ''}`));
		const others = this.flowNode(flow, Codicon.vm, this.othersLabel(live));
		const names = this.machines?.filter(m => !m.isCurrent && !m.disabled).map(m => m.name);
		if (names?.length) {
			others.title = names.join('\n');
		}
	}

	private flowNode(flow: HTMLElement, icon: ThemeIcon, label: string): HTMLElement {
		const node = DOM.append(flow, $('.picode-sync-flow-node'));
		DOM.append(node, $('.picode-sync-flow-device')).appendChild(renderIcon(icon));
		DOM.append(node, $('span')).textContent = label;
		return node;
	}

	private othersLabel(live: boolean): string {
		if (!live) {
			return localize('picodeSyncFlowOthersOff', "Your other computers");
		}
		if (this.machines === undefined) {
			this.loadMachines();
			return '…';
		}
		const count = this.machines.filter(m => !m.isCurrent && !m.disabled).length;
		return count === 0 ? localize('picodeSyncFlowOthersNone', "No other computers yet")
			: count === 1 ? localize('picodeSyncFlowOthersOne', "1 other computer")
				: localize('picodeSyncFlowOthers', "{0} other computers", count);
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

	private renderGroup(page: HTMLElement, group: IGroup, enabled: boolean): void {
		const head = DOM.append(page, $('.picode-sync-head'));
		DOM.append(head, $('h3')).textContent = group.label;
		const on = group.items.filter(item => this.isOn(item)).length;
		DOM.append(head, $('span.picode-account-muted')).textContent = localize('picodeSyncCount', "{0} of {1}", on, group.items.length);
		const card = DOM.append(page, $('.picode-sync-card'));
		const conflicted = new Set(this.userDataSyncService.conflicts.map(c => c.syncResource));
		for (const item of group.items) {
			this.renderItem(card, item, enabled, item.resource !== undefined && conflicted.has(item.resource));
		}
		if (group.note) {
			const note = DOM.append(page, $('p.picode-sync-note'));
			note.appendChild(renderIcon(Codicon.lock));
			DOM.append(note, $('span')).textContent = group.note;
		}
	}

	private renderItem(card: HTMLElement, item: IItem, enabled: boolean, conflicted: boolean): void {
		const on = this.isOn(item);
		const row = DOM.append(card, $(`.picode-sync-item${on ? '.on' : ''}`));
		const label = DOM.append(row, $('label.picode-sync-item-label'));
		const icon = DOM.append(label, $('.picode-sync-item-icon'));
		icon.style.setProperty('--picode-sync-item-color', `var(--vscode-charts-${item.color})`);
		icon.appendChild(renderIcon(item.icon));
		const text = DOM.append(label, $('.picode-sync-item-text'));
		const name = DOM.append(text, $('strong'));
		DOM.append(name, $('span')).textContent = item.label;
		// The state shows only when it says something: in the cloud, or changed in two places.
		if (on && enabled && this.workbenchService.accountStatus === AccountStatus.Available) {
			const state = DOM.append(name, $(`span.picode-sync-item-state${conflicted ? '.warn' : ''}`));
			state.appendChild(renderIcon(conflicted ? Codicon.warning : Codicon.passFilled));
			state.title = conflicted ? localize('picodeSyncTileConflict', "Changed in two places") : localize('picodeSyncTileSynced', "In the cloud");
		}
		DOM.append(text, $('span')).textContent = item.description;
		if (!on) {
			row.title = localize('picodeSyncTileOff', "Stays on this computer");
		}

		if (item.id === CHATS_ID) {
			const restore = this.renderStore.add(new Button(row, { ...defaultButtonStyles, secondary: true }));
			restore.label = localize('picodeSyncRestore', "Restore");
			restore.element.classList.add('picode-sync-small-button');
			this.renderStore.add(restore.onDidClick(() => { void this.commandService.executeCommand(COMMANDS.restoreChats); }));
		}
		const box = DOM.append(row, $('input.picode-sync-switch')) as HTMLInputElement;
		box.type = 'checkbox';
		box.setAttribute('role', 'switch');
		box.checked = on;
		box.setAttribute('aria-label', item.label);
		this.renderStore.add(DOM.addDisposableListener(box, DOM.EventType.CHANGE, () => { void this.setOn(item, box.checked); }));
		// The whole label flips the switch too, the way a settings row does.
		this.renderStore.add(DOM.addDisposableListener(label, DOM.EventType.CLICK, e => {
			e.preventDefault();
			void this.setOn(item, !on);
		}));
	}

	private isOn(item: IItem): boolean {
		if (item.resource === undefined) {
			return this.configurationService.getValue<boolean>(CHATS_SETTING) === true;
		}
		const on = this.enablementService.isResourceEnabled(item.resource);
		return item.part === undefined ? on : on && !this.skippedParts().has(item.part);
	}

	private skippedParts(): Set<PiProfilePart> {
		return skippedPiProfileParts(this.configurationService.getValue(PI_PROFILE_SKIP_SETTING));
	}

	private async setOn(item: IItem, value: boolean): Promise<void> {
		if (item.resource === undefined) {
			await this.configurationService.updateValue(CHATS_SETTING, value);
			return;
		}
		if (item.part === undefined) {
			this.enablementService.setResourceEnablement(item.resource, value);
			return;
		}
		// An agents' row switches its part; the agents' sync as a whole runs while any part is on.
		const wasOn = this.enablementService.isResourceEnabled(item.resource);
		const skipped = wasOn ? this.skippedParts() : new Set<PiProfilePart>(PI_PROFILE_PARTS);
		if (value) {
			skipped.delete(item.part);
		} else {
			skipped.add(item.part);
		}
		await this.configurationService.updateValue(PI_PROFILE_SKIP_SETTING, PI_PROFILE_PARTS.filter(part => skipped.has(part)));
		this.enablementService.setResourceEnablement(item.resource, skipped.size < PI_PROFILE_PARTS.length);
	}

	/** What is already in the cloud: earlier copies, and the way to wipe it. Quiet, at the end. */
	private renderCloudData(page: HTMLElement): void {
		const foot = DOM.append(page, $('.picode-sync-foot'));
		this.footLink(foot, Codicon.history, localize('picodeSyncBackups', "Earlier copies"), localize('picodeSyncBackupsDetail', "See what was synced and bring back an earlier copy."), COMMANDS.backups);
		this.footLink(foot, Codicon.trash, localize('picodeSyncClear', "Delete from the cloud"), localize('picodeSyncClearDetail', "Removes your synced data from the cloud. This computer keeps its own."), COMMANDS.clearCloud);
	}

	private footLink(foot: HTMLElement, icon: ThemeIcon, label: string, tooltip: string, commandId: string): void {
		const link = DOM.append(foot, $('button.picode-sync-foot-link'));
		link.setAttribute('type', 'button');
		link.title = tooltip;
		link.appendChild(renderIcon(icon));
		DOM.append(link, $('span')).textContent = label;
		this.renderStore.add(DOM.addDisposableListener(link, DOM.EventType.CLICK, () => { void this.commandService.executeCommand(commandId); }));
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
	description: localize('picodeSyncDescription', "Your setup on every computer you sign in to."),
	keywords: ['sync', 'backup', 'cloud', 'devices'],
	create: (instantiationService: IInstantiationService, container: HTMLElement) => instantiationService.createInstance(PicodeAccountSyncSection, container),
});
