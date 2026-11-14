/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/picodeUsageMeter.css';
import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { BaseActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
import { AICustomizationManagementSection } from '../../chat/common/aiCustomizationWorkspaceService.js';
import { Emitter } from '../../../../base/common/event.js';

/**
 * The plan's limits beside the thinking level in the chat input: a small ring that fills with how
 * much of the subscription the chat's model is on has been used, in its tightest window, and the
 * detail of each window on hover. It shows always there: filled for a plan with limits (ChatGPT,
 * Claude, NaN); clicking it opens Usage limits in Chat Settings.
 */

/** The connector's light reading: only the plan meters and the provider list. */
const SUBSCRIPTIONS_COMMAND = 'picode.setup.subscriptions';
const USAGE_METER_COMMAND = 'picode.chat.usageMeter';
/** The last figures read, kept across restarts so the ring is filled the moment the window opens. */
const SNAPSHOT_STORAGE_KEY = 'picode.usageMeter.lastSnapshot';
/** Figures older than this are not worth showing while the first read is on its way. */
const SNAPSHOT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
/**
 * Sign-ins whose plan limits the connector reads on its own (ChatGPT has a usage page); any other
 * sign-in only reports them with a chat answer, so there is nothing to wait for before one.
 */
const METERED_SIGN_INS = new Set(['openai-codex']);
/** The connector caches its network reads for a minute; asking every half minute costs nothing. */
const REFRESH_MS = 30_000;
/** Until the first answer: the connector may still be starting when the window opens. */
const RETRY_MS = 5_000;

interface IWindow {
	readonly label: string;
	readonly usedPercent: number;
	readonly resetAt: number | null;
}

interface IMeter {
	readonly meter?: string;
	readonly provider?: string;
	readonly current?: boolean;
	readonly windows: readonly IWindow[];
	readonly limitReached?: boolean;
}

interface IStatusSlice {
	readonly subscriptions?: readonly IMeter[];
	readonly providers?: readonly { readonly id: string; readonly subscription?: boolean }[];
}

interface IUsageSnapshot {
	readonly provider: string | undefined;
	readonly windows: readonly IWindow[];
	readonly limitReached: boolean;
}

/**
 * The figures saved by the last window, if recent enough. A window whose reset time has passed has
 * started over, so it counts as unused until the fresh read says otherwise.
 */
function restoreSnapshot(storageService: IStorageService, now: number): IUsageSnapshot | undefined {
	try {
		const saved = JSON.parse(storageService.get(SNAPSHOT_STORAGE_KEY, StorageScope.APPLICATION) ?? 'null') as { at?: unknown; snapshot?: IUsageSnapshot } | null;
		if (saved === null || typeof saved.at !== 'number' || now - saved.at > SNAPSHOT_MAX_AGE_MS || saved.snapshot === undefined || !Array.isArray(saved.snapshot.windows) || saved.snapshot.windows.length === 0) {
			return undefined;
		}
		const windows = saved.snapshot.windows.map(window => window.resetAt !== null && window.resetAt <= now ? { ...window, usedPercent: 0, resetAt: null } : window);
		return { provider: saved.snapshot.provider, windows, limitReached: saved.snapshot.limitReached === true && windows.every(window => window.resetAt !== null) };
	} catch {
		return undefined;
	}
}

function providerName(id: string | undefined): string {
	switch (id) {
		case 'nan': return 'NaN';
		case 'openai-codex': return 'ChatGPT';
		case 'anthropic': return 'Claude';
		default: return id ?? '';
	}
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

function toneOf(percent: number, limitReached: boolean): 'ok' | 'warn' | 'danger' {
	return limitReached || percent >= 95 ? 'danger' : percent >= 80 ? 'warn' : 'ok';
}

/** "Resets at 1:20 p.m." today, "Resets Thu, 5:00 a.m." on another day. */
function resetsAt(resetAt: number): string {
	const when = new Date(resetAt);
	const now = new Date();
	const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	if (when.toDateString() === now.toDateString()) {
		return localize('picodeUsageMeter.resetsToday', "Resets at {0}", time);
	}
	const day = when.toLocaleDateString(undefined, { weekday: 'short' });
	return localize('picodeUsageMeter.resetsOn', "Resets {0}, {1}", day, time);
}

/** Reads the limits of the chat's current plan and keeps them for the ring; one reader per window. */
class UsageMeterModel extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private _snapshot: IUsageSnapshot | undefined;
	get snapshot(): IUsageSnapshot | undefined { return this._snapshot; }

	private timer: ReturnType<typeof setTimeout> | undefined;

	/** Whether a read has answered at all: before it, an empty ring means "still reading", after it "no plan". */
	private _answered = false;
	get answered(): boolean { return this._answered; }

	constructor(
		private readonly commandService: ICommandService,
		private readonly hostService: IHostService,
		private readonly storageService: IStorageService,
	) {
		super();
		// Last session's figures straight away; the first read replaces them a few seconds later.
		this._snapshot = restoreSnapshot(storageService, Date.now());
		this._register({ dispose: () => clearTimeout(this.timer) });
		// Coming back to the window is when someone looks at the ring: read at once.
		this._register(hostService.onDidChangeFocus(focused => {
			if (focused) {
				void this.refresh();
			}
		}));
		void this.refresh();
	}

	/** The next read: soon while nothing has been read yet (the connector may still be starting), then every half minute. */
	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			// A window in the background has nobody looking at the ring; focus brings the next read.
			if (this.hostService.hasFocus) {
				void this.refresh();
			}
		}, this._answered ? REFRESH_MS : RETRY_MS);
	}

	async refresh(): Promise<void> {
		try {
			await this.read();
		} finally {
			this.schedule();
		}
	}

	private async read(): Promise<void> {
		let data: IStatusSlice | undefined;
		try {
			data = await this.commandService.executeCommand<IStatusSlice>(SUBSCRIPTIONS_COMMAND);
		} catch {
			data = undefined;
		}
		// A failed read (the connector still starting, a busy moment) changes nothing: the ring keeps
		// what it last showed and the next read tries again.
		if (data === undefined) {
			return;
		}
		const metered = (data.subscriptions ?? []).filter(meter => meter.windows.length > 0);
		let current = metered.filter(meter => meter.current === true);
		// Before the first message no model is answering yet: the plan listed first (the one the chat
		// is set to, when it has one) stands in, so the ring is there from the start.
		if (current.length === 0 && metered.length > 0) {
			current = metered.filter(meter => meter.provider === metered[0].provider);
		}
		let next: IUsageSnapshot | undefined = current.length === 0 ? undefined : {
			provider: current[0].provider,
			windows: current.flatMap(meter => meter.windows),
			limitReached: current.some(meter => meter.limitReached === true),
		};
		// The provider's usage page can miss one read (slow or busy) while the account is still signed
		// in: keep the last figures rather than emptying the ring until the next good read.
		if (next === undefined && this._snapshot !== undefined && (data.providers ?? []).some(provider => provider.id === this._snapshot!.provider && provider.subscription === true)) {
			next = this._snapshot;
		}
		// Signed in to a plan but no figures yet (its usage page has not answered): still reading, so the
		// ring keeps asking every few seconds instead of saying there is no plan.
		const awaitingPlan = next === undefined && (data.providers ?? []).some(provider => provider.subscription === true && METERED_SIGN_INS.has(provider.id));
		const firstAnswer = !this._answered;
		this._answered = !awaitingPlan;
		if (awaitingPlan) {
			return;
		}
		if (!firstAnswer && JSON.stringify(next) === JSON.stringify(this._snapshot)) {
			return;
		}
		this._snapshot = next;
		if (next === undefined) {
			this.storageService.remove(SNAPSHOT_STORAGE_KEY, StorageScope.APPLICATION);
		} else {
			this.storageService.store(SNAPSHOT_STORAGE_KEY, JSON.stringify({ at: Date.now(), snapshot: next }), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		this._onDidChange.fire();
	}
}

class UsageMeterActionViewItem extends BaseActionViewItem {

	private ring: SVGCircleElement | undefined;
	private button: HTMLElement | undefined;

	constructor(
		action: IAction,
		private readonly meter: UsageMeterModel,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super(undefined, action);
		this._register(meter.onDidChange(() => this.paint()));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('picode-usage-meter-item');
		const button = this.button = append(container, $('a.action-label.picode-usage-meter', { role: 'button', tabIndex: 0 }));
		const svg = button.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('width', '14');
		svg.setAttribute('height', '14');
		svg.setAttribute('aria-hidden', 'true');
		const track = button.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
		const fill = button.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
		for (const circle of [track, fill]) {
			circle.setAttribute('cx', '8');
			circle.setAttribute('cy', '8');
			circle.setAttribute('r', '6');
			circle.setAttribute('fill', 'none');
			circle.setAttribute('stroke-width', '2.4');
			svg.appendChild(circle);
		}
		track.classList.add('track');
		fill.classList.add('fill');
		fill.setAttribute('pathLength', '100');
		fill.setAttribute('transform', 'rotate(-90 8 8)');
		fill.setAttribute('stroke-linecap', 'round');
		this.ring = fill;
		button.appendChild(svg);

		this._register(this.hoverService.setupDelayedHover(button, () => ({
			content: this.hoverContent(button.ownerDocument),
			position: { hoverPosition: HoverPosition.ABOVE },
			appearance: { showPointer: true, compact: true },
		})));
		this._register(addDisposableListener(button, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.onClick();
			}
		}));
		this.paint();
	}

	private worst(): { percent: number; tone: 'ok' | 'warn' | 'danger' } {
		const snapshot = this.meter.snapshot;
		if (snapshot === undefined) {
			return { percent: 0, tone: 'ok' };
		}
		const percent = Math.max(0, ...snapshot.windows.map(window => clampPercent(window.usedPercent)));
		return { percent, tone: toneOf(percent, snapshot.limitReached) };
	}

	private paint(): void {
		if (!this.ring || !this.button) {
			return;
		}
		const { percent, tone } = this.worst();
		this.ring.setAttribute('stroke-dasharray', `${percent} 100`);
		this.button.classList.remove('ok', 'warn', 'danger');
		this.button.classList.add(tone);
		const snapshot = this.meter.snapshot;
		this.button.classList.toggle('empty', snapshot === undefined);
		this.button.setAttribute('aria-label', snapshot === undefined
			? localize('picodeUsageMeter.title', "Plan usage limits")
			: localize('picodeUsageMeter.aria', "{0} plan: {1}% used", providerName(snapshot.provider), percent));
	}

	private hoverContent(document: Document): HTMLElement {
		const root = document.createElement('div');
		root.className = 'picode-usage-meter-hover';
		const snapshot = this.meter.snapshot;
		const head = append(root, $('.picode-usage-meter-hover-head'));
		append(head, $('span.title')).textContent = snapshot?.provider !== undefined
			? localize('picodeUsageMeter.titleWith', "Plan usage limits · {0}", providerName(snapshot.provider))
			: localize('picodeUsageMeter.title', "Plan usage limits");
		append(head, $('span.hint')).textContent = localize('picodeUsageMeter.seeAll', "Click to see all");
		if (snapshot === undefined) {
			append(root, $('.picode-usage-meter-hover-empty')).textContent = this.meter.answered
				? localize('picodeUsageMeter.none', "No plan with limits to show for this model.")
				: localize('picodeUsageMeter.reading', "Reading your plan's limits…");
			return root;
		}
		for (const window of snapshot.windows) {
			const percent = clampPercent(window.usedPercent);
			const row = append(root, $('.picode-usage-meter-hover-row'));
			const line = append(row, $('.line'));
			append(line, $('span.name')).textContent = window.label.length > 0 ? window.label[0].toUpperCase() + window.label.slice(1) : window.label;
			const detail = append(line, $('span.detail'));
			if (window.resetAt !== null) {
				append(detail, $('span.reset')).textContent = resetsAt(window.resetAt);
			}
			append(detail, $('span.percent')).textContent = `${percent}%`;
			const bar = append(row, $(`.bar.${toneOf(percent, snapshot.limitReached && percent >= 100)}`));
			append(bar, $('span')).style.width = `${percent}%`;
		}
		return root;
	}

	override onClick(): void {
		void this.meter.refresh();
		void this.actionRunner.run(this.action);
	}

	protected override updateEnabled(): void {
		// Always clickable: the ring only shows while there is something to read.
	}

}

registerAction2(class OpenUsageLimitsAction extends Action2 {
	constructor() {
		super({
			id: USAGE_METER_COMMAND,
			title: localize2('picodeUsageMeter.open', "Show Plan Usage Limits"),
			icon: Codicon.dashboard,
			f1: false,
			menu: {
				id: MenuId.ChatInput,
				// Right after the thinking level (3.5).
				order: 3.6,
				group: 'navigation',
				// Always there: an empty ring says why on hover (still reading, or no plan with limits).
				when: ContextKeyExpr.and(
					ChatContextKeys.enabled,
					ChatContextKeys.location.isEqualTo(ChatAgentLocation.Chat),
					ChatContextKeys.inQuickChat.negate()),
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('aiCustomization.openManagementEditor', AICustomizationManagementSection.UsageLimits);
	}
});

class PicodeUsageMeterContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.picodeUsageMeter';

	constructor(
		@ICommandService commandService: ICommandService,
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IHostService hostService: IHostService,
		@IStorageService storageService: IStorageService,
	) {
		super();
		const meter = this._register(new UsageMeterModel(commandService, hostService, storageService));
		this._register(actionViewItemService.register(MenuId.ChatInput, USAGE_METER_COMMAND, action => instantiationService.createInstance(UsageMeterActionViewItem, action, meter)));
	}
}

registerWorkbenchContribution2(PicodeUsageMeterContribution.ID, PicodeUsageMeterContribution, WorkbenchPhase.AfterRestored);
