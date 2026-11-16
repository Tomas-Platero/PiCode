/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Where the chat in front works, beside the usage ring in the chat input. Before the first message, a
 * "Worktree" box: ticked, the first message makes a worktree on its own branch for the session. After,
 * for a session in a worktree, its branch: `⑂ picode/fix-login +12 −3`; clicking it reviews the changes.
 */

import './media/picodeSessionBranch.css';
import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { BaseActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';

const BRANCH_CHIP_COMMAND = 'picode.chat.branchChip';
const WORKTREE_BOX_COMMAND = 'picode.chat.worktreeBox';
/** How often the chip re-reads its copy while the window has focus: the agent changes files as it works. */
const REFRESH_MS = 10_000;

interface IChatCopy {
	readonly branch: string | undefined;
	readonly files: number;
	readonly added: number;
	readonly removed: number;
}

/** The "Worktree" box of a chat that has not started yet. */
interface IWorktreeOption {
	readonly available: boolean;
	readonly on: boolean;
}

/** The copy of the chat in front, read from the connector; undefined when the chat works in the project folder. */
class BranchChipModel extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	copy: IChatCopy | undefined;
	/** The box of the chat in front, while it has no message; undefined once it has. */
	option: IWorktreeOption | undefined;
	private last = '';
	private readonly chatListener = this._register(new MutableDisposable());

	constructor(
		private readonly commandService: ICommandService,
		private readonly chatWidgetService: IChatWidgetService,
		hostService: IHostService,
	) {
		super();
		this._register(chatWidgetService.onDidChangeFocusedWidget(() => this.follow()));
		this._register(chatWidgetService.onDidChangeFocusedSession(() => this.follow()));
		const timer = setInterval(() => {
			if (hostService.hasFocus) {
				void this.read();
			}
		}, REFRESH_MS);
		this._register({ dispose: () => clearInterval(timer) });
		this.follow();
	}

	/** Reads the chat in front, and again when its first message goes out (the box gives way to the branch). */
	private follow(): void {
		const model = this.chatWidgetService.lastFocusedWidget?.viewModel?.model;
		this.chatListener.value = model?.onDidChange(() => {
			if ((this.option !== undefined) !== (model.getRequests().length === 0)) {
				void this.read();
			}
		});
		void this.read();
	}

	/** The resource of the chat in front, which is how the connector knows the chat. */
	focusedChatKey(): string | undefined {
		return this.chatWidgetService.lastFocusedWidget?.viewModel?.model.sessionResource.toString();
	}

	async read(): Promise<void> {
		const key = this.focusedChatKey();
		const copy = key === undefined ? undefined : await this.commandService.executeCommand<IChatCopy>('picode.git.activeWorktree', key).catch(() => undefined);
		const fresh = this.chatWidgetService.lastFocusedWidget?.viewModel?.model.getRequests().length === 0;
		const option = key !== undefined && fresh && !copy
			? await this.commandService.executeCommand<IWorktreeOption>('picode.session.worktreeOption', key).catch(() => undefined)
			: undefined;
		const next = JSON.stringify({ copy: copy ?? null, option: option ?? null });
		if (next !== this.last) {
			this.last = next;
			this.copy = copy ?? undefined;
			this.option = option ?? undefined;
			this._onDidChange.fire();
		}
	}
}

class BranchChipActionViewItem extends BaseActionViewItem {
	private chip: HTMLElement | undefined;
	private host: HTMLElement | undefined;

	constructor(action: IAction, private readonly model: BranchChipModel) {
		super(undefined, action);
		this._register(model.onDidChange(() => this.paint()));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		this.host = container;
		container.classList.add('picode-branch-chip-item');
		this.chip = append(container, $('a.action-label.picode-branch-chip', { role: 'button', tabIndex: 0 }));
		this._register(addDisposableListener(this.chip, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.onClick();
			}
		}));
		this.paint();
	}

	override onClick(): void {
		const key = this.model.focusedChatKey();
		if (key !== undefined) {
			void this.actionRunner.run(this.action, key);
		}
	}

	private paint(): void {
		const chip = this.chip;
		const copy = this.model.copy;
		if (!chip || !this.host) {
			return;
		}
		this.host.style.display = copy?.branch ? '' : 'none';
		chip.replaceChildren();
		if (!copy?.branch) {
			return;
		}
		append(chip, $(`span${ThemeIcon.asCSSSelector(Codicon.gitBranch)}`));
		append(chip, $('span.picode-branch-chip-name')).textContent = copy.branch;
		if (copy.added > 0 || copy.removed > 0) {
			append(chip, $('span.picode-branch-chip-added')).textContent = `+${copy.added}`;
			append(chip, $('span.picode-branch-chip-removed')).textContent = `−${copy.removed}`;
		}
		chip.title = copy.files === 0
			? localize('picode.branchChip.cleanWorktree', "This session works on {0}, in its own worktree. Nothing changed yet.", copy.branch)
			: localize('picode.branchChip.changedWorktree', "This session works on {0}, in its own worktree. Click to review its changes.", copy.branch);
	}
}

/** The "Worktree" box: a checkbox and its word, like the other editors' option under a new chat. */
class WorktreeBoxActionViewItem extends BaseActionViewItem {
	private box: HTMLElement | undefined;
	private host: HTMLElement | undefined;

	constructor(action: IAction, private readonly model: BranchChipModel) {
		super(undefined, action);
		this._register(model.onDidChange(() => this.paint()));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		this.host = container;
		this.box = append(container, $('a.action-label.picode-worktree-box', { role: 'checkbox', tabIndex: 0 }));
		this._register(addDisposableListener(this.box, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.onClick();
			}
		}));
		this.paint();
	}

	override onClick(): void {
		const key = this.model.focusedChatKey();
		const option = this.model.option;
		if (key !== undefined && option?.available) {
			const run = async () => {
				await this.actionRunner.run(this.action, { key, on: !option.on });
				await this.model.read();
			};
			void run();
		}
	}

	private paint(): void {
		const box = this.box;
		const option = this.model.option;
		if (!box || !this.host) {
			return;
		}
		this.host.style.display = option?.available ? '' : 'none';
		const on = option?.on === true;
		box.classList.toggle('on', on);
		box.setAttribute('aria-checked', String(on));
		box.replaceChildren();
		const check = append(box, $('span.picode-worktree-check'));
		if (on) {
			append(check, $(`span${ThemeIcon.asCSSSelector(Codicon.check)}`));
		}
		append(box, $('span')).textContent = localize('picode.worktreeBox.label', "Worktree");
		box.title = localize('picode.worktreeBox.hint', "Work in a worktree: a copy of the project on its own branch, so this session's changes do not mix with yours or with other sessions'.");
	}
}

registerAction2(class WorktreeBoxAction extends Action2 {
	constructor() {
		super({
			id: WORKTREE_BOX_COMMAND,
			title: localize2('picode.worktreeBox.title', "Work in a Worktree"),
			icon: Codicon.gitBranch,
			f1: false,
			menu: {
				id: MenuId.ChatInput,
				// Where the branch chip shows once the session has started.
				order: 3.65,
				group: 'navigation',
				when: ContextKeyExpr.and(
					ChatContextKeys.enabled,
					ChatContextKeys.location.isEqualTo(ChatAgentLocation.Chat),
					ChatContextKeys.inQuickChat.negate()),
			},
		});
	}

	async run(accessor: ServicesAccessor, choice?: { key?: unknown; on?: unknown }): Promise<void> {
		if (typeof choice?.key === 'string') {
			await accessor.get(ICommandService).executeCommand('picode.session.setWorktree', choice.key, choice.on === true);
		}
	}
});

registerAction2(class ReviewSessionChangesAction extends Action2 {
	constructor() {
		super({
			id: BRANCH_CHIP_COMMAND,
			title: localize2('picode.branchChip.review', "Review This Session's Changes"),
			icon: Codicon.gitBranch,
			f1: false,
			menu: {
				id: MenuId.ChatInput,
				// Right after the usage ring (3.6).
				order: 3.7,
				group: 'navigation',
				when: ContextKeyExpr.and(
					ChatContextKeys.enabled,
					ChatContextKeys.location.isEqualTo(ChatAgentLocation.Chat),
					ChatContextKeys.inQuickChat.negate()),
			},
		});
	}

	async run(accessor: ServicesAccessor, chatKey?: unknown): Promise<void> {
		if (typeof chatKey === 'string') {
			await accessor.get(ICommandService).executeCommand('picode.session.reviewChanges', chatKey);
		}
	}
});

class PicodeBranchChipContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.picodeBranchChip';

	constructor(
		@ICommandService commandService: ICommandService,
		@IChatWidgetService chatWidgetService: IChatWidgetService,
		@IHostService hostService: IHostService,
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const model = this._register(new BranchChipModel(commandService, chatWidgetService, hostService));
		this._register(actionViewItemService.register(MenuId.ChatInput, BRANCH_CHIP_COMMAND, action => instantiationService.createInstance(BranchChipActionViewItem, action, model)));
		this._register(actionViewItemService.register(MenuId.ChatInput, WORKTREE_BOX_COMMAND, action => instantiationService.createInstance(WorktreeBoxActionViewItem, action, model)));
	}
}

registerWorkbenchContribution2(PicodeBranchChipContribution.ID, PicodeBranchChipContribution, WorkbenchPhase.AfterRestored);
