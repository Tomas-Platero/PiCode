/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The agent profile of the chat in front, beside the effort level in the chat input: `🤖 work ▾`.
 * Clicking it lists the profiles; picking one makes it the default and moves this chat to it, and
 * "Only for this chat" moves this chat alone. With a single profile there is nothing to switch, so
 * the chip is not there.
 */

import './media/picodeChatProfileChip.css';
import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { BaseActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
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

class ProfileChipActionViewItem extends BaseActionViewItem {
	private host: HTMLElement | undefined;
	private chip: HTMLElement | undefined;

	constructor(
		action: IAction,
		private readonly model: ProfileChipModel,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(undefined, action);
		this._register(model.onDidChange(() => this.paint()));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		this.host = container;
		this.chip = append(container, $('a.picode-profile-chip'));
		this.chip.setAttribute('role', 'button');
		this.chip.tabIndex = 0;
		this._register(addDisposableListener(this.chip, EventType.CLICK, () => void this.pick()));
		this._register(addDisposableListener(this.chip, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				void this.pick();
			}
		}));
		this.paint();
	}

	private paint(): void {
		const view = this.model.view;
		if (!this.chip || !this.host) {
			return;
		}
		const shown = view !== undefined && !view.invalid && !view.unsaved && view.profiles.length > 1;
		this.host.style.display = shown ? '' : 'none';
		this.chip.replaceChildren();
		if (!shown) {
			return;
		}
		const name = this.model.current() ?? '';
		append(this.chip, $(`span${ThemeIcon.asCSSSelector(Codicon.robot)}`));
		append(this.chip, $('span.picode-profile-chip-name')).textContent = name;
		append(this.chip, $(`span${ThemeIcon.asCSSSelector(Codicon.chevronDown)}`));
		this.chip.title = localize('picode.profileChip.hint', "Agent profile: {0}. Click to switch.", name);
		this.chip.setAttribute('aria-label', this.chip.title);
	}

	/** Where the profile in use comes from, in the words of the picker's title. */
	private origin(view: IProfilesView): string {
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

	private async pick(): Promise<void> {
		await this.model.refresh();
		const view = this.model.view;
		if (view === undefined) {
			return;
		}
		type Item = IQuickPickItem & { readonly run: () => Promise<unknown> };
		const current = this.model.current();
		const use = (name: string, mode: 'default' | 'session') => async () => {
			await this.commandService.executeCommand('picode.agentProfiles.use', { name, mode, ask: false });
			await this.model.refresh();
		};
		const items: Array<Item | IQuickPickSeparator> = view.profiles.map(profile => ({
			label: profile.name,
			iconClass: profile.name === current ? ThemeIcon.asClassName(Codicon.check) : undefined,
			description: profile.name === view.active ? localize('picode.profileChip.default', "Default") : undefined,
			run: use(profile.name, 'default'),
		}));
		items.push({ type: 'separator' });
		items.push({
			label: localize('picode.profileChip.onlyHere', "Only for this chat..."),
			iconClass: ThemeIcon.asClassName(Codicon.commentDiscussion),
			run: async () => {
				const chosen = await this.quickInputService.pick(view.profiles.map(profile => ({ label: profile.name })), {
					title: localize('picode.profileChip.onlyHereTitle', "Agent profile for this chat only"),
					placeHolder: localize('picode.profileChip.onlyHereHint', "New chats keep {0}", view.active ?? ''),
				});
				if (chosen !== undefined) {
					await use(chosen.label, 'session')();
				}
			},
		});
		items.push({
			label: localize('picode.profileChip.manage', "Manage agent profiles"),
			iconClass: ThemeIcon.asClassName(Codicon.settingsGear),
			run: () => this.commandService.executeCommand('picode.providersModels.open', 'agents'),
		});
		const chosen = await this.quickInputService.pick(items, { title: this.origin(view), placeHolder: localize('picode.profileChip.placeholder', "Switch the agents to another profile") }) as Item | undefined;
		await chosen?.run();
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
