/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../../../nls.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { SyncDescriptor } from '../../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../../../platform/registry/common/platform.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../../browser/parts/views/viewPane.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry, ViewContainer } from '../../../../../common/views.js';
import { PICODE_LAYOUT_SETTING } from '../../picodeLayoutStyle.js';
import { IPicodeProEntitlement } from '../picodeProEntitlement.js';
import { PicodeStatusIssues } from './picodeStatusIssues.js';

/**
 * The issues of GitHub and Jira in the Editor layout: one more view in the PiCode container, next to
 * Tasks and Memory. It is the same panel the Agent layout shows in its Status column, so the two
 * layouts never disagree about what is open.
 *
 * It exists only for a Pro account (`picode.account.isPro`): without one the view is not listed at
 * all, and the Account window is where the plan is explained.
 */
export const PICODE_ISSUES_VIEW_ID = 'picode.status.issues';

/** Whether the signed-in account is Pro: what the views that only Pro accounts get ask. */
export const PICODE_IS_PRO_CONTEXT = new RawContextKey<boolean>('picode.account.isPro', false);

/** The container the connector declares for its views (`extensions/picode/package.json`). */
const PICODE_VIEW_CONTAINER_ID = 'workbench.view.extension.picode-status';

class PicodeIssuesView extends ViewPane {

	private readonly panel = this._register(new MutableDisposable<PicodeStatusIssues>());

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
		const host = append(parent, $('.picode-overview.picode-issues-view'));
		// The panel draws and refreshes itself; it is read only while the view is on screen.
		const show = (visible: boolean): void => {
			if (!visible) {
				this.panel.clear();
			} else if (!this.panel.value) {
				this.panel.value = this.instantiationService.createInstance(PicodeStatusIssues, host);
			}
		};
		this._register(this.onDidChangeBodyVisibility(show));
		show(this.isBodyVisible());
	}
}

/** Keeps the context key true while the signed-in account is Pro. */
class PicodeProContext extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.picodeProContext';

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IPicodeProEntitlement entitlement: IPicodeProEntitlement,
	) {
		super();
		const key = PICODE_IS_PRO_CONTEXT.bindTo(contextKeyService);
		const update = (): void => key.set(entitlement.isPro);
		update();
		this._register(entitlement.onDidChange(update));
	}
}

registerWorkbenchContribution2(PicodeProContext.ID, PicodeProContext, WorkbenchPhase.BlockRestore);

/** The container comes from the connector's manifest, so it may not exist yet: the view joins it when it does. */
function registerView(container: ViewContainer): void {
	Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
		id: PICODE_ISSUES_VIEW_ID,
		name: localize2('picodeIssuesViewName', "Issues"),
		containerIcon: Codicon.issues,
		ctorDescriptor: new SyncDescriptor(PicodeIssuesView),
		canToggleVisibility: true,
		canMoveView: false,
		order: 3,
		when: ContextKeyExpr.and(
			PICODE_IS_PRO_CONTEXT,
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
