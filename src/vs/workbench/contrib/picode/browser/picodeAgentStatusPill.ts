/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/picodeAgentStatusPill.css';
import { $, append, clearNode, hide, show } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { localize } from '../../../../nls.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { chatInputStackSlotClass, ChatInputStackSlot, setChatInputStackSlot } from '../../chat/browser/widget/input/chatInputStack.js';
import type { IChatWidget } from '../../chat/browser/chat.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { agentStatusOf, pillFace, pillTooltipLine, type PillStatus } from './picodeAgentStatusData.js';

/**
 * The agent-status pill above the chat input, as PiCode owns it.
 *
 * When the agent works, the answer to "what is it doing, what did I leave running, and how
 * much is queued?" lives in the transcript, which scrolls on and is per session. This pill
 * is that answer where the owner is looking: one line for the turn in flight — what it is
 * doing right now, and how many requests are waiting with a Cancel for them — and one line
 * for the background jobs still running. Nothing at all when the agent is idle.
 *
 * The connector **pushes** the facts (`picode.picodeAgentStatusChanged`, filled from the
 * same events the chat draws); the pill never polls, so a window where the connector has
 * not been woken shows no pill and does no work. The pill only re-renders on a push and on
 * the minute tick that moves the elapsed times.
 */

/** The internal command the connector calls with its status. */
const PUSH_COMMAND_ID = 'picode.picodeAgentStatusChanged';

/** The connector's command that returns without running every turn waiting for its slot. */
const CANCEL_QUEUED_COMMAND = 'picode.cancelQueuedTurns';

/** How often the elapsed times move while the pill is showing something. */
const TICK_MS = 60_000;

/** The status the last push carried, as one shared answer for every chat's pill. */
let latestStatus: PillStatus | undefined;
const onStatusChanged = new Emitter<PillStatus | undefined>();

CommandsRegistry.registerCommand(PUSH_COMMAND_ID, (_accessor, raw: unknown) => {
	const status = agentStatusOf(raw);
	const changed = JSON.stringify(status) !== JSON.stringify(latestStatus);
	latestStatus = status;
	if (changed) {
		onStatusChanged.fire(status);
	}
});

/** One chat's pill: the element in that chat's input stack, and what it draws. */
class PicodeAgentStatusPill extends Disposable {

	private readonly element: HTMLElement;
	private readonly turnRow: HTMLElement;
	private readonly jobsRow: HTMLElement;
	/** The minute tick, run only while the pill is showing something. */
	private readonly tick = this._register(new MutableDisposable());

	constructor(
		container: HTMLElement,
		private readonly commandService: ICommandService,
	) {
		super();

		this.element = append(container, $('div.picode-agent-status-pill'));
		this.element.classList.add(chatInputStackSlotClass);
		this.turnRow = append(this.element, $('div.picode-agent-status-turn'));
		this.jobsRow = append(this.element, $('div.picode-agent-status-jobs'));

		this._register(onStatusChanged.event(() => this.render()));
		this.render();
	}

	override dispose(): void {
		setChatInputStackSlot(this.element.parentElement, ChatInputStackSlot.Empty);
		clearNode(this.element);
		this.element.remove();
		super.dispose();
	}

	private render(): void {
		const now = Date.now();
		const status = latestStatus;

		if (status === undefined) {
			this.tick.clear();
			setChatInputStackSlot(this.element.parentElement, ChatInputStackSlot.Empty);
			hide(this.element);
			return;
		}

		this.renderTurnRow(status);
		this.renderJobsRow(status, now);

		show(this.element);
		setChatInputStackSlot(this.element.parentElement, ChatInputStackSlot.Docked);
		const handle = setInterval(() => this.render(), TICK_MS);
		this.tick.value = toDisposable(() => clearInterval(handle));
	}

	/** The turn's line: what it is doing now, and the queued requests with their way out. */
	private renderTurnRow(status: PillStatus): void {
		clearNode(this.turnRow);

		if (!status.running && status.queued === 0) {
			hide(this.turnRow);
			return;
		}

		const runningLine = status.running
			? (status.activity ?? localize('picodeAgentStatusWorking', "Working"))
			: undefined;
		if (runningLine !== undefined) {
			const icon = append(this.turnRow, $('div.picode-agent-status-icon'));
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.loading), 'picode-agent-status-spin');
			append(this.turnRow, $('span.picode-agent-status-activity')).textContent = runningLine;
		}
		if (status.queued > 0) {
			append(this.turnRow, $('span.picode-agent-status-queued')).textContent =
				localize('picodeAgentStatusQueued', "{0} waiting", status.queued);
			const cancelButton = append(this.turnRow, $('a.picode-agent-status-cancel'));
			cancelButton.textContent = localize('picodeAgentStatusCancelQueued', "Cancel queued");
			cancelButton.title = localize('picodeAgentStatusCancelQueuedTooltip',
				"Every message waiting for its turn returns without running. The message being answered now is not touched.");
			this._registerOnClick(cancelButton, () => { void this.commandService.executeCommand(CANCEL_QUEUED_COMMAND); });
		}
		show(this.turnRow);
	}

	/** The jobs' line: how many are still running, and what the oldest one is. */
	private renderJobsRow(status: PillStatus, now: number): void {
		clearNode(this.jobsRow);

		const face = pillFace(status.jobs, now);
		if (face.count === 0) {
			hide(this.jobsRow);
			return;
		}

		const icon = append(this.jobsRow, $('div.picode-agent-status-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.serverProcess));
		append(this.jobsRow, $('span.picode-agent-status-count')).textContent =
			localize('picodeAgentStatusCount', "{0} background", face.count);
		if (face.detail !== undefined) {
			append(this.jobsRow, $('span.picode-agent-status-detail')).textContent = face.detail;
		}
		// The tooltip is the whole list: every job, what it runs, how long it has been running.
		this.jobsRow.title = status.jobs.map(row => pillTooltipLine(row, now)).join('\n');
		show(this.jobsRow);
	}

	/** Clicks on the pill's own elements, freed with the pill. */
	private _registerOnClick(element: HTMLElement, action: () => void): void {
		element.classList.add('picode-agent-status-action');
		element.tabIndex = 0;
		element.setAttribute('role', 'button');
		const listener = () => action();
		element.addEventListener('click', listener);
		this._register({ dispose: () => element.removeEventListener('click', listener) });
	}
}

/** Keeps one pill per chat widget, created when a widget arrives and dropped when it leaves. */
export class PicodeAgentStatusPillContribution extends Disposable {

	static readonly ID = 'picode.agentStatusPill';

	private readonly pills = new Map<IChatWidget, PicodeAgentStatusPill>();

	constructor(
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this._register(this.chatWidgetService.onDidAddWidget(widget => this.attach(widget)));
		this._register(this.chatWidgetService.onDidChangeWidgetVisibility(widget => this.attach(widget)));
		this._register(this.chatWidgetService.onDidRemoveWidget(widget => {
			this.pills.get(widget)?.dispose();
			this.pills.delete(widget);
		}));
	}

	private attach(widget: IChatWidget): void {
		if (this.pills.has(widget)) {
			return;
		}
		const container = widget.inputPart.picodeBackgroundPillContainer;
		if (container === undefined) {
			return;
		}
		this.pills.set(widget, this._register(new PicodeAgentStatusPill(container, this.commandService)));
	}

	override dispose(): void {
		for (const pill of this.pills.values()) {
			pill.dispose();
		}
		this.pills.clear();
		super.dispose();
	}
}

registerWorkbenchContribution2(PicodeAgentStatusPillContribution.ID, PicodeAgentStatusPillContribution, WorkbenchPhase.AfterRestored);
