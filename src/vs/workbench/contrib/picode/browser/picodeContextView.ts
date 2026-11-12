/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry, ViewContainer } from '../../../common/views.js';
import { PicodeAgentOverview } from './picodeAgentOverviewView.js';
import { PICODE_LAYOUT_SETTING } from './picodeLayoutStyle.js';

/**
 * Where the focused chat's context goes, in the Editor layout: one more view of the PiCode container,
 * next to Tasks and Memory. It draws the Context section of the Agent layout's Status with the same
 * code, so the two layouts look alike.
 */
export const PICODE_CONTEXT_VIEW_ID = 'picode.status.context';

/** The container the connector declares for its views (`extensions/picode/package.json`). */
const PICODE_VIEW_CONTAINER_ID = 'workbench.view.extension.picode-status';

class PicodeContextView extends ViewPane {

	private readonly overview = this._register(new MutableDisposable<PicodeAgentOverview>());

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
		const host = append(parent, $('.picode-context-view'));
		// Read only while the view is on screen.
		const show = (visible: boolean): void => {
			if (!visible) {
				this.overview.clear();
			} else if (!this.overview.value) {
				host.textContent = '';
				this.overview.value = this.instantiationService.createInstance(PicodeAgentOverview, host, 'context');
			}
		};
		this._register(this.onDidChangeBodyVisibility(show));
		show(this.isBodyVisible());
	}
}

/** The container comes from the connector's manifest, so it may not exist yet: the view joins it when it does. */
function registerView(container: ViewContainer): void {
	Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
		id: PICODE_CONTEXT_VIEW_ID,
		name: localize2('picodeContextViewName', "Context"),
		containerIcon: Codicon.dashboard,
		ctorDescriptor: new SyncDescriptor(PicodeContextView),
		canToggleVisibility: true,
		canMoveView: false,
		// First, as in the Agent layout's Status.
		order: 0,
		when: ContextKeyExpr.and(
			ContextKeyExpr.notEquals(`config.${PICODE_LAYOUT_SETTING}`, 'agent'),
			ContextKeyExpr.not('config.chat.disableAIFeatures'),
		),
	}], container);
}

const containers = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
let registered = false;
const join = (container: ViewContainer | undefined): void => {
	if (!registered && container?.id === PICODE_VIEW_CONTAINER_ID) {
		registered = true;
		registerView(container);
	}
};
join(containers.get(PICODE_VIEW_CONTAINER_ID));
containers.onDidRegister(({ viewContainer }) => join(viewContainer));
