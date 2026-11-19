/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The agent profile of the chat in front, beside the effort level in the chat input: `🤖 work`.
 * Clicking it opens the same kind of dropdown as the effort level. With a single profile there is
 * nothing to switch, so the chip is not there.
 */

import { $, reset } from '../../../../base/browser/dom.js';
import { renderLabelWithIcons } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Action, IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { ActionWidgetDropdownActionViewItem } from '../../../../platform/actions/browser/actionWidgetDropdownActionViewItem.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction, IActionWidgetDropdownActionProvider } from '../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';

const PROFILE_CHIP_COMMAND = 'picode.chat.profileChip';

/** The part of `picode.agentProfiles.state` the chip reads. */
interface IProfilesView {
	readonly profiles: readonly { readonly name: string }[];
	readonly active?: string;
	readonly unsaved: boolean;
	readonly invalid: boolean;
	readonly resolved: { readonly name?: string; readonly source: 'local' | 'repo' | 'default' };
	readonly editorProfile?: string;
	readonly chat?: string;
}

/** The profiles as the connector reads them; read again when the window or the chat in front changes. */
class ProfileChipModel extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	view: IProfilesView | undefined;
	private last = '';

	constructor(
		private readonly commandService: ICommandService,
		chatWidgetService: IChatWidgetService,
		hostService: IHostService,
	) {
		super();
		this._register(hostService.onDidChangeFocus(focused => { if (focused) { void this.refresh(); } }));
		this._register(chatWidgetService.onDidChangeFocusedWidget(() => void this.refresh()));
		void this.refresh();
	}

	async refresh(): Promise<void> {
		let view: IProfilesView | undefined;
		try {
			view = await this.commandService.executeCommand<IProfilesView>('picode.agentProfiles.state');
		} catch {
			view = undefined;
		}
		const key = JSON.stringify(view ?? null);
		if (key !== this.last) {
			this.last = key;
			this.view = view;
			this._onDidChange.fire();
		}
	}

	/** The profile this chat answers with, as far as the editor knows. */
	current(): string | undefined {
		return this.view?.chat ?? this.view?.resolved.name ?? this.view?.active;
	}
}

/**
 * The chip, with the same dropdown under it as the effort level beside it: the profiles with a check
 * on the one in use; picking one makes it the default and moves this chat, and the button on a row
 * moves this chat alone. "Manage agent profiles" sits at the bottom.
 */
class ProfileChipActionViewItem extends ActionWidgetDropdownActionViewItem {
	private host: HTMLElement | undefined;

	constructor(
		action: IAction,
		private readonly model: ProfileChipModel,
		@ICommandService commandService: ICommandService,
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		const use = (name: string, mode: 'default' | 'session') => async () => {
			await commandService.executeCommand('picode.agentProfiles.use', { name, mode, ask: false });
			await model.refresh();
		};
		const actionProvider: IActionWidgetDropdownActionProvider = {
			getActions: () => {
				const view = model.view;
				const current = model.current();
				return (view?.profiles ?? []).map(profile => ({
					...action,
					id: `picode.agentProfile.${profile.name}`,
					label: profile.name,
					tooltip: '',
					enabled: true,
					checked: profile.name === current,
					...(profile.name === view?.active ? { description: localize('picode.profileChip.default', "Default") } : {}),
					toolbarActions: [new Action(
						`picode.agentProfile.${profile.name}.here`,
						localize('picode.profileChip.onlyHereShort', "Only for this chat"),
						ThemeIcon.asClassName(Codicon.commentDiscussion),
						true,
						use(profile.name, 'session'),
					)],
					run: use(profile.name, 'default'),
				} satisfies IActionWidgetDropdownAction));
			},
		};
		super(action, {
			actionProvider,
			actionBarActions: [new Action(
				'picode.agentProfile.manage',
				localize('picode.profileChip.manage', "Manage agent profiles"),
				ThemeIcon.asClassName(Codicon.settingsGear),
				true,
				() => commandService.executeCommand('picode.providersModels.open', 'agents'),
			)],
			reporter: { id: 'PicodeAgentProfilePicker', name: 'PicodeAgentProfilePicker' },
			listOptions: { minWidth: 220 },
		}, actionWidgetService, keybindingService, contextKeyService, telemetryService);
		this._register(model.onDidChange(() => this.paint()));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		this.host = container;
		container.classList.add('chat-input-picker-item', 'picode-profile-chip-item');
		this.paint();
	}

	/** Shown only when there is a profile to switch to. */
	private paint(): void {
		const view = this.model.view;
		const shown = view !== undefined && !view.invalid && !view.unsaved && view.profiles.length > 1;
		if (this.host) {
			this.host.style.display = shown ? '' : 'none';
		}
		if (this.element) {
			this.renderLabel(this.element);
		}
	}

	protected override renderLabel(element: HTMLElement): IDisposable | null {
		this.setAriaLabelAttributes(element);
		const name = this.model.current() ?? '';
		reset(element, ...renderLabelWithIcons(`$(${Codicon.robot.id})`), $('span.chat-input-picker-label', undefined, name));
		const view = this.model.view;
		const hint = view === undefined ? name : `${origin(view)}: ${name}`;
		element.setAttribute('aria-label', localize('picode.profileChip.hint', "Agent profile: {0}. Click to switch.", name));
		element.title = hint;
		return null;
	}
}

/** Where the profile in use comes from, in a few words. */
function origin(view: IProfilesView): string {
	if (view.chat !== undefined && view.chat !== view.resolved.name) {
		return localize('picode.profileChip.fromChat', "Agent profile · chosen for this chat");
	}
	switch (view.resolved.source) {
		case 'local': return localize('picode.profileChip.fromLocal', "Agent profile · pinned to this project");
		case 'repo': return localize('picode.profileChip.fromRepo', "Agent profile · shared with this repository");
		default: return view.editorProfile === view.active
			? localize('picode.profileChip.fromEditor', "Agent profile · from your editor profile")
			: localize('picode.profileChip.fromDefault', "Agent profile · your default");
	}
}

registerAction2(class ProfileChipAction extends Action2 {
	constructor() {
		super({
			id: PROFILE_CHIP_COMMAND,
			title: localize2('picode.profileChip.title', "Switch Agent Profile"),
			icon: Codicon.robot,
			f1: false,
			menu: {
				id: MenuId.ChatInput,
				// Just before the usage ring (3.6), after the effort level.
				order: 3.55,
				group: 'navigation',
				when: ContextKeyExpr.and(
					ChatContextKeys.enabled,
					ChatContextKeys.location.isEqualTo(ChatAgentLocation.Chat),
					ChatContextKeys.inQuickChat.negate()),
			},
		});
	}

	async run(_accessor: ServicesAccessor): Promise<void> {
		// The view item opens the picker; the action itself only places it in the bar.
	}
});

class PicodeProfileChipContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.picodeProfileChip';

	constructor(
		@ICommandService commandService: ICommandService,
		@IChatWidgetService chatWidgetService: IChatWidgetService,
		@IHostService hostService: IHostService,
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const model = this._register(new ProfileChipModel(commandService, chatWidgetService, hostService));
		this._register(actionViewItemService.register(MenuId.ChatInput, PROFILE_CHIP_COMMAND, action => instantiationService.createInstance(ProfileChipActionViewItem, action, model)));
	}
}

registerWorkbenchContribution2(PicodeProfileChipContribution.ID, PicodeProfileChipContribution, WorkbenchPhase.AfterRestored);
