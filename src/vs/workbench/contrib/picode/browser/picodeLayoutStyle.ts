/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/picodeAgentLayout.css';
import './media/picodeChatParts.css';
import { localize, localize2 } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { timeout } from '../../../../base/common/async.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IsAuxiliaryWindowContext } from '../../../common/contextkeys.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchLayoutService, LayoutSettings, Parts, Position, positionFromString, positionToString } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { sidebarSideColumn } from '../../../browser/parts/sidebar/sidebarSideColumn.js';

/**
 * How PiCode is laid out: **Agent** (the chat is the work) or **Editor** (the code is the work).
 *
 * Agent is not a second window, unlike VS Code's Agents Window: it is the same workbench with its
 * columns moved, the way the desktop agents arrange them — the chat on the left with its sessions
 * list beside it, a review side bar on the right (files, changes, search) with its views as tabs on
 * top, no icon bar and no status bar, and the workbench's own floating-panel look
 * (`workbench.experimental.modernUI`). The editor only takes space while a file is open.
 *
 * It is built from the workbench's own settings (side bar on the right puts the secondary side bar,
 * where the chat lives, on the left), so every part keeps working as VS Code wrote it. The values
 * those settings had before are kept and given back when the Editor layout returns.
 * The setup window writes the layout key (`onboarding-settings.ts`).
 */
export const PICODE_LAYOUT_SETTING = 'picode.appearance.layout';

export type PicodeLayout = 'agent' | 'editor';

const PICODE_AGENT_LAYOUT_CLASS = 'picode-agent';
const PICODE_LAYOUT_BLINK_CLASS = 'picode-layout-blink';

/** The workbench settings the Agent layout sets, and the value each takes there. */
const AGENT_SETTINGS: ReadonlyArray<readonly [string, unknown]> = [
	[LayoutSettings.MODERN_UI, true],
	['workbench.sideBar.location', 'right'],
	[LayoutSettings.ACTIVITY_BAR_LOCATION, 'top'],
	['workbench.statusBar.visible', false],
];

/** Where the values those settings had before the Agent layout are kept (per machine). */
const SAVED_SETTINGS_KEY = 'picode.layout.editorSettings';

/**
 * Where each view goes in the Agent layout, and where it returns in the Editor one.
 *
 * The chat moves to the bottom panel, which the Agent layout docks on the left between the sessions
 * column (secondary side bar) and the editor; the panel's other views (terminal, problems, output,
 * debug console) become tabs of the review side bar on the right.
 */
const CHAT_CONTAINER_ID = 'workbench.panel.chat';
const REVIEW_TABS_FROM_PANEL = ['terminal', 'workbench.panel.markers', 'workbench.panel.output', 'workbench.panel.repl'];
const SESSIONS_CONTAINER_ID = 'workbench.view.picodeSessions';
const EXPLORER_CONTAINER_ID = 'workbench.view.explorer';
const STATUS_CONTAINER_ID = 'workbench.view.picodeStatus';

/** Where the side bar keeps its tabs' order (the activity bar's record, which the side bar shares). */
const PINNED_TABS_KEY = 'workbench.activity.pinnedViewlets2';

/** The review bar's tabs, in the order the Agent layout puts them. */
const REVIEW_TAB_ORDER = [
	'workbench.view.picodeStatus',
	'workbench.view.explorer',
	'workbench.view.search',
	'workbench.view.scm',
	'terminal',
	'workbench.panel.markers',
	'workbench.panel.output',
	'workbench.panel.repl',
	'workbench.view.debug',
	'workbench.view.extensions',
];

/** Tabs the panel brought that the Agent layout keeps off the review bar's row (problems, output, debug console). */
const SELDOM_USED_TABS = ['workbench.panel.markers', 'workbench.panel.output', 'workbench.panel.repl'];

/** Whether those tabs already left the row once. */
const TABS_TRIMMED_KEY = 'picode.layout.reviewTabsTrimmed';

/** Where the panel's position before the Agent layout is kept. */
const SAVED_PANEL_POSITION_KEY = 'picode.layout.editorPanelPosition';

/** Whether the bottom panel was open in the Editor layout: the Agent layout uses it for the chat and always shows it. */
const SAVED_PANEL_VISIBLE_KEY = 'picode.layout.editorPanelVisible';

/** The sessions column's width when the Agent layout starts. */
const AGENT_SESSIONS_WIDTH = 260;

/** The review side bar's width when the Agent layout is first arranged: one column, with only Status in it. */
const AGENT_REVIEW_WIDTH = 320;

/** Set once a workspace's Agent columns are arranged: later starts keep what the user left. */
const AGENT_ARRANGED_KEY = 'picode.layout.agentArranged';

/** The chat's share of what the review side bar leaves, while a file is open beside it. */
const AGENT_CHAT_SHARE_WITH_EDITOR = 0.5;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'picode',
	title: 'PiCode',
	properties: {
		[PICODE_LAYOUT_SETTING]: {
			type: 'string',
			enum: ['agent', 'editor'],
			enumDescriptions: [
				localize('picode.appearance.layout.agent', "The chat in the centre with your sessions beside it, and files, changes and search on the right."),
				localize('picode.appearance.layout.editor', "The code in the centre, the chat on the side: the classic editor layout."),
			],
			default: 'editor',
			markdownDescription: localize('picode.appearance.layout', "How PiCode is laid out. You can switch any time; nothing is lost."),
		},
	},
});

export function picodeLayoutOf(configurationService: IConfigurationService): PicodeLayout {
	return configurationService.getValue<string>(PICODE_LAYOUT_SETTING) === 'agent' ? 'agent' : 'editor';
}

class PicodeLayoutContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.picodeLayout';

	/** Whether this window moved its own columns for the Agent layout (and must move them back). */
	private arranged = false;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
		@IEditorService private readonly editorService: IEditorService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
	) {
		super();
		const layout = picodeLayoutOf(this.configurationService);
		this.applyClass(layout);
		if (layout === 'agent') {
			void this.enterAgent();
		} else {
			void this.leaveAgent();
		}

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PICODE_LAYOUT_SETTING)) {
				const next = picodeLayoutOf(this.configurationService);
				this.applyClass(next);
				this.blink();
				void (next === 'agent' ? this.enterAgent() : this.leaveAgent());
			}
		}));
		this._register(this.layoutService.onDidAddContainer(({ container }) => {
			container.classList.toggle(PICODE_AGENT_LAYOUT_CLASS, picodeLayoutOf(this.configurationService) === 'agent');
		}));
		// In the Agent layout the editor gives its room back to the chat when the last file closes;
		// the workbench already brings it back when one opens, and the columns are sized again.
		this._register(this.editorService.onDidVisibleEditorsChange(() => {
			if (picodeLayoutOf(this.configurationService) !== 'agent') {
				return;
			}
			if (this.editorService.visibleEditors.length === 0) {
				this.hideEditorArea();
			} else {
				// Once the workbench has brought the editor back: the chat and the file share the room.
				void timeout(0).then(() => this.sizeColumns());
			}
		}));
	}

	private blinkTimer: ReturnType<typeof setTimeout> | undefined;

	/** The robot on the layout button blinks while the columns move. */
	private blink(): void {
		const containers = [...this.layoutService.containers];
		for (const container of containers) {
			container.classList.remove(PICODE_LAYOUT_BLINK_CLASS);
			// Read layout so a second switch in a row restarts the animation.
			void container.offsetWidth;
			container.classList.add(PICODE_LAYOUT_BLINK_CLASS);
		}
		if (this.blinkTimer !== undefined) {
			clearTimeout(this.blinkTimer);
		}
		this.blinkTimer = setTimeout(() => {
			this.blinkTimer = undefined;
			for (const container of containers) {
				container.classList.remove(PICODE_LAYOUT_BLINK_CLASS);
			}
		}, 900);
	}

	override dispose(): void {
		if (this.blinkTimer !== undefined) {
			clearTimeout(this.blinkTimer);
		}
		super.dispose();
	}

	private applyClass(layout: PicodeLayout): void {
		for (const container of this.layoutService.containers) {
			container.classList.toggle(PICODE_AGENT_LAYOUT_CLASS, layout === 'agent');
		}
	}

	private async enterAgent(): Promise<void> {
		// Keep what the Editor layout had, once: a second window or a restart must not overwrite it
		// with the Agent values.
		if (this.storageService.get(SAVED_SETTINGS_KEY, StorageScope.APPLICATION) === undefined) {
			const saved: Record<string, unknown> = {};
			for (const [key] of AGENT_SETTINGS) {
				saved[key] = this.configurationService.inspect(key).userValue;
			}
			this.storageService.store(SAVED_SETTINGS_KEY, JSON.stringify(saved), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		for (const [key, value] of AGENT_SETTINGS) {
			if (this.configurationService.getValue(key) !== value) {
				await this.configurationService.updateValue(key, value, ConfigurationTarget.USER);
			}
		}

		// The panel's position belongs to each window (it is kept per workspace), so each keeps its own.
		if (this.storageService.get(SAVED_PANEL_POSITION_KEY, StorageScope.WORKSPACE) === undefined && this.layoutService.getPanelPosition() !== Position.LEFT) {
			this.storageService.store(SAVED_PANEL_POSITION_KEY, positionToString(this.layoutService.getPanelPosition()), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}

		// Read only while the panel is still the Editor layout's: once the chat lives in it, it is always open.
		const chatContainer = this.viewDescriptorService.getViewContainerById(CHAT_CONTAINER_ID);
		if (this.storageService.get(SAVED_PANEL_VISIBLE_KEY, StorageScope.WORKSPACE) === undefined && chatContainer !== null && this.viewDescriptorService.getViewContainerLocation(chatContainer) !== ViewContainerLocation.Panel) {
			this.storageService.store(SAVED_PANEL_VISIBLE_KEY, this.layoutService.isVisible(Parts.PANEL_PART), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}

		// The columns' sizes and the bar's open view are set the first time only: after that the
		// workbench restores what the user left, and a start never undoes it.
		const firstTime = this.storageService.get(AGENT_ARRANGED_KEY, StorageScope.WORKSPACE) === undefined;
		this.arranged = true;
		this.layoutService.setAuxiliaryBarMaximized(false);
		this.moveContainer(CHAT_CONTAINER_ID, ViewContainerLocation.Panel);
		for (const id of REVIEW_TABS_FROM_PANEL) {
			this.moveContainer(id, ViewContainerLocation.Sidebar);
		}
		this.moveContainer(SESSIONS_CONTAINER_ID, ViewContainerLocation.AuxiliaryBar);
		this.layoutService.setPanelPosition(Position.LEFT);
		this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
		this.layoutService.setPartHidden(false, Parts.PANEL_PART);
		void this.paneCompositeService.openPaneComposite(SESSIONS_CONTAINER_ID, ViewContainerLocation.AuxiliaryBar);
		void this.paneCompositeService.openPaneComposite(CHAT_CONTAINER_ID, ViewContainerLocation.Panel);
		if (this.editorService.visibleEditors.length === 0) {
			this.hideEditorArea();
		}
		if (!firstTime) {
			// Every start opens on Status, not on whichever tab the bar was left on (the workbench
			// restores that one, usually the file explorer). A wide bar already shows Status as its column.
			await timeout(0);
			if (!sidebarSideColumn.visible) {
				void this.paneCompositeService.openPaneComposite(STATUS_CONTAINER_ID, ViewContainerLocation.Sidebar);
			}
			return;
		}
		// After the settings above have moved the parts: sizes are only meaningful in the new grid.
		await timeout(0);
		this.sizeColumns(true);
		this.orderReviewTabs();
		this.storageService.store(AGENT_ARRANGED_KEY, true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		// The bar starts with Status alone; once it is laid out narrow, Status is a tab to open.
		await timeout(0);
		const status = await this.paneCompositeService.openPaneComposite(STATUS_CONTAINER_ID, ViewContainerLocation.Sidebar);
		if (!status) {
			void this.paneCompositeService.openPaneComposite(EXPLORER_CONTAINER_ID, ViewContainerLocation.Sidebar);
		}
	}

	/**
	 * The review bar's tabs in a working order: status, files, search, source control, then the
	 * terminal and what the panel brought (problems, output, debug console), then debugging and
	 * extensions. Any other tab keeps its place after those. The bar keeps its order in the same
	 * record the user's own drags write to (and listens to it), so this rewrites that record.
	 */
	private orderReviewTabs(): void {
		let items: { id: string; pinned?: boolean }[];
		try {
			items = JSON.parse(this.storageService.get(PINNED_TABS_KEY, StorageScope.PROFILE, '[]'));
		} catch {
			return;
		}
		if (!Array.isArray(items) || items.length === 0) {
			return;
		}
		const rank = (id: string) => {
			const index = REVIEW_TAB_ORDER.indexOf(id);
			return index === -1 ? REVIEW_TAB_ORDER.length : index;
		};
		let ordered = items.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item.id) - rank(b.item.id) || a.index - b.index).map(({ item }) => item);
		// Once: the tabs seldom used here leave the row (their shortcuts, and a right click on the
		// row, still bring them). Done only the first time, so a tab put back by hand stays.
		const trimmed = this.storageService.getBoolean(TABS_TRIMMED_KEY, StorageScope.PROFILE, false);
		if (!trimmed) {
			ordered = ordered.map(item => SELDOM_USED_TABS.includes(item.id) ? { ...item, pinned: false } : item);
			this.storageService.store(TABS_TRIMMED_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
		}
		if (!trimmed || ordered.some((item, index) => item !== items[index])) {
			this.storageService.store(PINNED_TABS_KEY, JSON.stringify(ordered), StorageScope.PROFILE, StorageTarget.USER);
		}
	}

	/**
	 * The chat takes what the side columns leave, or half of it beside a file. The side columns get
	 * their starting widths only when the Agent layout starts (`resetSides`); otherwise they keep
	 * whatever they have, so a file opening never undoes a width set by hand or by PiCode itself
	 * (the review bar narrows for the changes tab).
	 */
	private sizeColumns(resetSides = false): void {
		const { width } = this.layoutService.mainContainerDimension;
		const sessions = resetSides ? Math.min(AGENT_SESSIONS_WIDTH, Math.round(width * 0.22)) : this.layoutService.getSize(Parts.AUXILIARYBAR_PART).width;
		const review = resetSides ? Math.min(AGENT_REVIEW_WIDTH, Math.round(width * 0.33)) : this.layoutService.getSize(Parts.SIDEBAR_PART).width;
		const rest = width - sessions - review;
		const chat = this.editorService.visibleEditors.length === 0 ? rest : Math.round(rest * AGENT_CHAT_SHARE_WITH_EDITOR);
		// The chat first and the side columns last: resizing a part takes room from its neighbours,
		// and the side columns are the ones whose widths must stick.
		this.layoutService.setSize(Parts.PANEL_PART, { width: chat, height: this.layoutService.getSize(Parts.PANEL_PART).height });
		this.layoutService.setSize(Parts.AUXILIARYBAR_PART, { width: sessions, height: this.layoutService.getSize(Parts.AUXILIARYBAR_PART).height });
		this.layoutService.setSize(Parts.SIDEBAR_PART, { width: review, height: this.layoutService.getSize(Parts.SIDEBAR_PART).height });
	}

	private async leaveAgent(): Promise<void> {
		// The settings are shared by every window: the first window back in the Editor layout gives
		// them back and drops the record; the others find it gone and only move their own columns.
		const raw = this.storageService.get(SAVED_SETTINGS_KEY, StorageScope.APPLICATION);
		if (raw !== undefined) {
			this.storageService.remove(SAVED_SETTINGS_KEY, StorageScope.APPLICATION);
			let saved: Record<string, unknown> = {};
			try {
				saved = JSON.parse(raw);
			} catch {
				// A damaged record gives the defaults back, which is the classic layout.
			}
			for (const [key] of AGENT_SETTINGS) {
				await this.configurationService.updateValue(key, saved[key], ConfigurationTarget.USER);
			}
		}

		// The columns, always — whether or not this window found the record: when this window moved
		// them, or the chat still lives in the bottom panel (the Agent layout's mark, left behind by
		// an earlier start). Another window may already have moved the shared views back.
		const chat = this.viewDescriptorService.getViewContainerById(CHAT_CONTAINER_ID);
		const rearranged = chat !== null && this.viewDescriptorService.getViewContainerLocation(chat) === ViewContainerLocation.Panel;
		const panelPosition = this.storageService.get(SAVED_PANEL_POSITION_KEY, StorageScope.WORKSPACE);
		if (!rearranged && !this.arranged && panelPosition === undefined) {
			return;
		}
		this.arranged = false;
		// Closed unless the person had it open: the Agent layout's chat is no reason to show the terminal.
		const panelWasOpen = this.storageService.getBoolean(SAVED_PANEL_VISIBLE_KEY, StorageScope.WORKSPACE, false);
		this.storageService.remove(SAVED_PANEL_VISIBLE_KEY, StorageScope.WORKSPACE);
		this.storageService.remove(SAVED_PANEL_POSITION_KEY, StorageScope.WORKSPACE);
		this.storageService.remove(AGENT_ARRANGED_KEY, StorageScope.WORKSPACE);
		this.moveContainer(CHAT_CONTAINER_ID, ViewContainerLocation.AuxiliaryBar);
		for (const id of REVIEW_TABS_FROM_PANEL) {
			this.moveContainer(id, ViewContainerLocation.Panel);
		}
		this.layoutService.setPanelPosition(positionFromString(panelPosition ?? 'bottom'));
		this.layoutService.setPartHidden(!panelWasOpen, Parts.PANEL_PART);
		this.layoutService.setPartHidden(false, Parts.EDITOR_PART);
		this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		void this.paneCompositeService.openPaneComposite(CHAT_CONTAINER_ID, ViewContainerLocation.AuxiliaryBar);
	}

	/** With no file open the centre is the chat's: the editor steps aside. */
	private hideEditorArea(): void {
		this.layoutService.setPartHidden(true, Parts.EDITOR_PART);
		this.sizeColumns();
	}

	private moveContainer(id: string, location: ViewContainerLocation): void {
		const container = this.viewDescriptorService.getViewContainerById(id);
		if (container && this.viewDescriptorService.getViewContainerLocation(container) !== location) {
			this.viewDescriptorService.moveViewContainerToLocation(container, location, undefined, 'picode.layout');
		}
	}
}

// AfterRestored: moving the columns needs the restored layout underneath it.
registerWorkbenchContribution2(PicodeLayoutContribution.ID, PicodeLayoutContribution, WorkbenchPhase.AfterRestored);

registerAction2(class SwitchLayoutAction extends Action2 {
	constructor() {
		super({
			id: 'picode.appearance.switchLayout',
			title: localize2('picode.appearance.switchLayout', "Switch Layout (Agent / Editor)"),
			category: localize2('picode.category', "PiCode"),
			f1: true,
			icon: Codicon.robot,
			// Lit while the Agent layout is on, like the side bar toggles beside it.
			toggled: ContextKeyExpr.equals(`config.${PICODE_LAYOUT_SETTING}`, 'agent'),
			// First of the layout buttons at the right of the title bar.
			menu: {
				id: MenuId.LayoutControlMenu,
				group: 'navigation',
				order: -1,
				when: IsAuxiliaryWindowContext.negate(),
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const next: PicodeLayout = picodeLayoutOf(configurationService) === 'agent' ? 'editor' : 'agent';
		await configurationService.updateValue(PICODE_LAYOUT_SETTING, next, ConfigurationTarget.USER);
	}
});

/**
 * "Reset Layout": every part where VS Code puts it, as if the Agent layout had never been used.
 *
 * It does not depend on what the Agent layout remembers: whatever the settings and the views hold
 * — from this version or an earlier one — the settings it sets are cleared, the chat goes back to
 * the side, the terminal and the other panel views to the bottom, and every part is shown.
 */
registerAction2(class ResetLayoutAction extends Action2 {
	constructor() {
		super({
			id: 'picode.appearance.resetLayout',
			title: localize2('picode.appearance.resetLayout', "Reset Layout to Default"),
			category: localize2('picode.category', "PiCode"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const viewDescriptorService = accessor.get(IViewDescriptorService);
		const paneCompositeService = accessor.get(IPaneCompositePartService);
		const storageService = accessor.get(IStorageService);

		// Editor first, so the Agent arrangement does not start again while this runs.
		await configurationService.updateValue(PICODE_LAYOUT_SETTING, 'editor', ConfigurationTarget.USER);
		for (const [key] of AGENT_SETTINGS) {
			await configurationService.updateValue(key, undefined, ConfigurationTarget.USER);
		}
		storageService.remove(SAVED_SETTINGS_KEY, StorageScope.APPLICATION);
		storageService.remove(SAVED_PANEL_POSITION_KEY, StorageScope.WORKSPACE);

		const place = (id: string, location: ViewContainerLocation) => {
			const container = viewDescriptorService.getViewContainerById(id);
			if (container && viewDescriptorService.getViewContainerLocation(container) !== location) {
				viewDescriptorService.moveViewContainerToLocation(container, location, undefined, 'picode.layout');
			}
		};
		place(CHAT_CONTAINER_ID, ViewContainerLocation.AuxiliaryBar);
		for (const id of REVIEW_TABS_FROM_PANEL) {
			place(id, ViewContainerLocation.Panel);
		}

		layoutService.setAuxiliaryBarMaximized(false);
		layoutService.setPanelPosition(Position.BOTTOM);
		for (const part of [Parts.ACTIVITYBAR_PART, Parts.SIDEBAR_PART, Parts.EDITOR_PART, Parts.PANEL_PART, Parts.AUXILIARYBAR_PART, Parts.STATUSBAR_PART]) {
			layoutService.setPartHidden(false, part);
		}
		void paneCompositeService.openPaneComposite(CHAT_CONTAINER_ID, ViewContainerLocation.AuxiliaryBar);
	}
});
