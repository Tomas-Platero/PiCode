/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { PICODE_STATUS_CONTAINER_ID } from '../../../browser/parts/sidebar/sidebarSideColumn.js';
import { PICODE_LAYOUT_SETTING } from './picodeLayoutStyle.js';
import { PICODE_STATUS_COLUMN_SHOWN, PicodeAgentOverview } from './picodeAgentOverviewView.js';
import { pickStatusSections } from './picodeStatusSections.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';

/**
 * The status panel of the Agent layout as a view of the review side bar, so it is one of the bar's
 * tabs and keeps its icon in the row at the top.
 *
 * While the bar is wide, the same panel is its own column beside the bar's view
 * (`picodeAgentOverviewView.ts`, `sidebarSideColumn.ts`) and this tab hides; when the bar gets too
 * narrow for two columns, the column goes and this tab comes back to the row of icons.
 */
export const PICODE_STATUS_VIEW_ID = 'workbench.view.picodeStatus.panel';

class PicodeStatusView extends ViewPane {

	private readonly overview = this._register(new MutableDisposable<PicodeAgentOverview>());
	private host: HTMLElement | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		this.host = parent;
		this._register(this.onDidChangeBodyVisibility(() => this.show(this.isBodyVisible())));
		this.show(this.isBodyVisible());
	}

	/** Read only while the panel is on screen: the tab keeps its place while another view is open. */
	private show(visible: boolean): void {
		if (!visible || !this.host) {
			this.overview.clear();
			return;
		}
		if (this.overview.value) {
			return;
		}
		this.host.textContent = '';
		this.overview.value = this.instantiationService.createInstance(PicodeAgentOverview, this.host);
	}
}

const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: PICODE_STATUS_CONTAINER_ID,
	title: localize2('picode.status.container', "Status"),
	icon: Codicon.dashboard,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [PICODE_STATUS_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: PICODE_STATUS_CONTAINER_ID,
	hideIfEmpty: true,
	// First of the bar: the panel the Agent layout shows beside it.
	order: -1,
}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: true });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: PICODE_STATUS_VIEW_ID,
	name: localize2('picode.status.view', "Status"),
	containerIcon: Codicon.dashboard,
	ctorDescriptor: new SyncDescriptor(PicodeStatusView),
	canToggleVisibility: false,
	canMoveView: false,
	// Agent layout only, and only while the bar is too narrow for the column.
	when: ContextKeyExpr.and(ContextKeyExpr.equals(`config.${PICODE_LAYOUT_SETTING}`, 'agent'), PICODE_STATUS_COLUMN_SHOWN.negate()),
}], container);

registerAction2(class PicodeChooseStatusSectionsAction extends Action2 {
	constructor() {
		super({
			id: 'picode.status.chooseSections',
			title: localize2('picode.status.chooseSections', "Show or Hide Status Sections"),
			category: localize2('picode.category', "PiCode"),
			icon: Codicon.eye,
			f1: true,
			menu: { id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', PICODE_STATUS_VIEW_ID), group: '1_sections' },
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return pickStatusSections(accessor.get(IQuickInputService), accessor.get(IStorageService));
	}
});
