/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { ACTION_ID_NEW_CHAT } from '../../chat/browser/actions/chatActions.js';
import { AgentSessionsControl } from '../../chat/browser/agentSessions/agentSessionsControl.js';
import { AgentSessionsFilter, AgentSessionsGrouping } from '../../chat/browser/agentSessions/agentSessionsFilter.js';
import { PICODE_LAYOUT_SETTING } from './picodeLayoutStyle.js';
import { PICODE_AGENT_SEARCH_COMMAND_ID, PICODE_AGENT_SEARCH_ICON, PICODE_CUSTOMIZATION_COMMAND_ID, PICODE_CUSTOMIZATION_ICON } from './picodeAgentSearch.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { PICODE_AUTH_PROVIDER_ID, PICODE_EMAIL_STORAGE_KEY, PICODE_PLAN_STORAGE_KEY } from './picodeAccountProvider.js';
import { GlobalCompositeBar } from '../../../browser/parts/globalCompositeBar.js';
import { IColorTheme } from '../../../../platform/theme/common/themeService.js';
import { badgeBackground, badgeForeground, foreground } from '../../../../platform/theme/common/colorRegistry.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';

/**
 * The Agent layout's left column: new session, search, and every session by date.
 *
 * The same list the chat shows beside itself in the Editor layout (`AgentSessionsControl`), given a
 * column of its own so the chat can take the centre. It only exists in the Agent layout; in the
 * Editor layout the chat keeps its own list and this view stays hidden.
 */
export const PICODE_SESSIONS_CONTAINER_ID = 'workbench.view.picodeSessions';
export const PICODE_SESSIONS_VIEW_ID = 'workbench.view.picodeSessions.list';

class PicodeAgentSessionsView extends ViewPane {

	private control: AgentSessionsControl | undefined;

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
		@ICommandService private readonly commandService: ICommandService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		const root = append(parent, $('.picode-sessions'));

		// The actions on top, as rows of text rather than icons: new session, search (a window in the
		// middle of the screen) and the chat's customization page; then the list's own tools.
		const actions = append(root, $('.picode-sessions-actions'));
		const createNewChat = () => this.commandService.executeCommand(ACTION_ID_NEW_CHAT);
		const row = (icon: ThemeIcon, label: string, run: () => unknown) => {
			const button = append(actions, $('button.picode-sessions-row', { type: 'button' }));
			append(button, $(`span${ThemeIcon.asCSSSelector(icon)}`));
			append(button, $('span.label')).textContent = label;
			this._register(addDisposableListener(button, EventType.CLICK, () => void run()));
		};
		row(Codicon.add, localize('picode.sessions.new', "New session"), createNewChat);
		row(PICODE_AGENT_SEARCH_ICON, localize('picode.sessions.search', "Search"), () => this.commandService.executeCommand(PICODE_AGENT_SEARCH_COMMAND_ID));
		row(PICODE_CUSTOMIZATION_ICON, localize('picode.sessions.customization', "Customization"), () => this.commandService.executeCommand(PICODE_CUSTOMIZATION_COMMAND_ID));

		const toolbarRow = append(actions, $('.picode-sessions-toolbar-row'));
		// The open project's name, rather than a second "Sessions" under the column's own title.
		const heading = append(toolbarRow, $('span.picode-sessions-heading'));
		const showProject = () => {
			heading.textContent = this.workspaceService.getWorkspace().folders[0]?.name ?? localize('picode.sessions.noProject', "No project open");
		};
		showProject();
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(showProject));
		const toolbarContainer = append(toolbarRow, $('.picode-sessions-toolbar'));
		const toolbar = this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, toolbarContainer, MenuId.AgentSessionsToolbar, {
			menuOptions: { shouldForwardArgs: true }
		}));

		// No filter menu of its own: the chat view already owns the one menu id those actions use,
		// and two owners would register the same commands twice.
		const filter = this._register(this.instantiationService.createInstance(AgentSessionsFilter, {
			groupResults: () => AgentSessionsGrouping.Date,
		}));

		const listContainer = append(root, $('.picode-sessions-list'));
		const control = this.control = this._register(this.instantiationService.createInstance(AgentSessionsControl, listContainer, {
			source: 'picodeAgentSessions',
			filter,
			overrideStyles: this.getLocationBasedColors().listOverrideStyles,
			createNewChat,
			getHoverPosition: () => HoverPosition.RIGHT,
			trackActiveEditorSession: () => true,
		}));
		toolbar.context = control;
		this._register(this.onDidChangeBodyVisibility(visible => control.setVisible(visible)));

		// Who is signed in, and the settings, at the foot of the column: the workbench's own Accounts
		// (avatar, sign-in and its menu) and Manage buttons, the same ones the icon bar carries, with
		// the account's name and plan between them.
		const footer = append(root, $('.picode-sessions-footer'));
		const globalBar = this._register(this.instantiationService.createInstance(GlobalCompositeBar,
			() => [],
			(theme: IColorTheme) => ({
				activeForegroundColor: theme.getColor(foreground),
				inactiveForegroundColor: theme.getColor(foreground),
				badgeBackground: theme.getColor(badgeBackground),
				badgeForeground: theme.getColor(badgeForeground),
			}),
			{ position: () => HoverPosition.ABOVE },
		));
		globalBar.create(footer);
		const identity = append(footer, $('.picode-sessions-identity'));
		const name = append(identity, $('span.picode-sessions-account-name'));
		const plan = append(identity, $('span.picode-sessions-plan'));
		// The name opens the Account window: plan, cloud sync and the Pro features.
		identity.style.cursor = 'pointer';
		identity.setAttribute('role', 'button');
		identity.tabIndex = 0;
		identity.title = localize('picode.sessions.openAccount', "Open your account");
		this._register(addDisposableListener(identity, EventType.CLICK, () => this.commandService.executeCommand('picode.account.open')));
		this._register(addDisposableListener(identity, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				void this.commandService.executeCommand('picode.account.open');
			}
		}));

		const render = (label: string | undefined) => {
			name.textContent = label ?? localize('picode.sessions.signedOut', "Not signed in");
			const tier = label ? this.storageService.get(PICODE_PLAN_STORAGE_KEY, StorageScope.APPLICATION) : undefined;
			plan.textContent = tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : '';
			plan.style.display = tier ? '' : 'none';
		};
		const showAccount = async () => {
			// The account provider registers, and restores its session, after this column can first
			// paint, and asking it before then can wait a long time: the email it kept from the last
			// sign-in (erased on sign-out) is painted at once, and its own answer replaces it.
			const remembered = this.storageService.get(PICODE_EMAIL_STORAGE_KEY, StorageScope.APPLICATION) || undefined;
			render(remembered);
			try {
				const sessions = await this.authenticationService.getSessions(PICODE_AUTH_PROVIDER_ID);
				render(sessions[0]?.account.label ?? remembered);
			} catch {
				// Not registered yet: the remembered email stays, and the registration asks again.
			}
		};
		this._register(this.authenticationService.onDidChangeSessions(e => {
			if (e.providerId === PICODE_AUTH_PROVIDER_ID) {
				void showAccount();
			}
		}));
		this._register(this.authenticationService.onDidRegisterAuthenticationProvider(e => {
			if (e.id === PICODE_AUTH_PROVIDER_ID) {
				void showAccount();
			}
		}));
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, PICODE_PLAN_STORAGE_KEY, this._store)(() => void showAccount()));
		void showAccount();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		const actionsHeight = this.element.querySelector('.picode-sessions-actions')?.getBoundingClientRect().height ?? 0;
		const footerHeight = this.element.querySelector('.picode-sessions-footer')?.getBoundingClientRect().height ?? 0;
		this.control?.layout(Math.max(0, height - actionsHeight - footerHeight), width);
	}

	override focus(): void {
		super.focus();
		this.control?.focus();
	}
}

const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: PICODE_SESSIONS_CONTAINER_ID,
	title: localize2('picode.sessions.container', "Sessions"),
	icon: Codicon.commentDiscussion,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [PICODE_SESSIONS_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: PICODE_SESSIONS_CONTAINER_ID,
	hideIfEmpty: true,
	order: 0,
}, ViewContainerLocation.AuxiliaryBar, { doNotRegisterOpenCommand: true });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: PICODE_SESSIONS_VIEW_ID,
	name: localize2('picode.sessions.view', "Sessions"),
	containerIcon: Codicon.commentDiscussion,
	ctorDescriptor: new SyncDescriptor(PicodeAgentSessionsView),
	canToggleVisibility: false,
	canMoveView: false,
	// Only the Agent layout has a sessions column; the Editor layout keeps the list inside the chat.
	when: ContextKeyExpr.equals(`config.${PICODE_LAYOUT_SETTING}`, 'agent'),
}], container);
