/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/picodeUsageStatus.css';
import { $, addDisposableListener, append, clearNode, EventType, getActiveWindow } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';

/**
 * NaN's subscription usage, from the status bar.
 *
 * The counter shows the share of the allowance the chat's model has used; a click opens a panel
 * where the notifications center opens, with every metered model of the account in one table —
 * the same facts the pi TUI's usage overlay shows. The connector reads the quota
 * (`picode.usage.read`); this side only draws it.
 */

/** The connector's answer: `UsagePanelData` in `status-contract.ts`. */
interface IUsageWindow {
	readonly label: string;
	readonly usedPercent: number;
	readonly resetAt: number | null;
}

interface IUsageModel {
	readonly name: string;
	readonly used: number;
	readonly cap: number;
	readonly usedPercent: number;
	readonly resetAt: number | null;
	readonly window?: IUsageWindow;
	readonly limitReached: boolean;
	readonly current: boolean;
}

interface IUsageData {
	readonly models: readonly IUsageModel[];
	readonly periodStart: number | null;
	readonly fresh: boolean;
	readonly fetchedAt: number;
}

const READ_COMMAND = 'picode.usage.read';
const TOGGLE_COMMAND = 'picode.usage.toggle';
const ENTRY_ID = 'status.picode.usage';
const NAN_DASHBOARD = 'https://cloud.nan.builders';

/** Reads between network reads are free: the connector caches each one for a minute. */
const REFRESH_MS = 15_000;

function isUsageData(value: unknown): value is IUsageData {
	return typeof value === 'object' && value !== null && Array.isArray((value as IUsageData).models) && (value as IUsageData).models.length > 0;
}

/** Tokens as people read them: `3.00B`, `299M`, `12k`. */
function tokens(value: number): string {
	if (value >= 1e9) {
		return `${(value / 1e9).toFixed(2)}B`;
	}
	if (value >= 1e6) {
		return `${Math.round(value / 1e6)}M`;
	}
	if (value >= 1e3) {
		return `${Math.round(value / 1e3)}k`;
	}
	return String(Math.round(value));
}

function percent(value: number): string {
	return `${Math.round(value * 10) / 10}%`;
}

/** `5d 4h`, `3h 10m`, `12m`: how long until a reset. */
function until(at: number, now: number): string {
	const minutes = Math.max(0, Math.round((at - now) / 60_000));
	const days = Math.floor(minutes / 1_440);
	const hours = Math.floor((minutes % 1_440) / 60);
	if (days > 0) {
		return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	}
	return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes % 60}m`;
}

function day(at: number): string {
	return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dateTime(at: number): string {
	return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The model the counter speaks for: the one in use, by its tightest window. */
function counterOf(data: IUsageData): { readonly text: string; readonly kind: IStatusbarEntry['kind'] } {
	const current = data.models.find(model => model.current);
	if (current === undefined) {
		return { text: '$(pulse) NaN', kind: 'standard' };
	}
	const used = Math.max(current.usedPercent, current.window?.usedPercent ?? 0);
	if (current.limitReached || used >= 100) {
		return { text: `$(error) ${localize('picodeUsageLimit', "Limit reached")}`, kind: 'error' };
	}
	return { text: `$(pulse) ${Math.round(used)}%`, kind: used >= 80 ? 'warning' : 'standard' };
}

/** The panel itself: where the notifications center sits, drawn from the last reading. */
class UsagePanel extends Disposable {

	private readonly element: HTMLElement;
	private readonly title: HTMLElement;
	private readonly body: HTMLElement;
	private readonly visibleStore = this._register(new DisposableStore());
	private _visible = false;
	/** When an outside click last closed the panel. */
	closedAt = 0;

	constructor(
		container: HTMLElement,
		private readonly onRefresh: () => void,
		private readonly onHidden: () => void,
		private readonly openerService: IOpenerService,
	) {
		super();
		this.element = append(container, $('.picode-usage-center'));
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-label', localize('picodeUsageAria', "Subscription usage"));
		this.element.tabIndex = -1;

		const header = append(this.element, $('.picode-usage-header'));
		this.title = append(header, $('.picode-usage-title'));
		const actions = append(header, $('.picode-usage-actions'));
		this.action(actions, Codicon.refresh, localize('picodeUsageRefresh', "Refresh"), () => this.onRefresh());
		this.action(actions, Codicon.linkExternal, localize('picodeUsageDashboard', "Open the NaN dashboard"), () => { void this.openerService.open(URI.parse(NAN_DASHBOARD)); });
		this.action(actions, Codicon.close, localize('picodeUsageClose', "Close"), () => this.hide());

		this.body = append(this.element, $('.picode-usage-body'));
		this._register(toDisposable(() => this.element.remove()));
	}

	get visible(): boolean {
		return this._visible;
	}

	private action(parent: HTMLElement, icon: ThemeIcon, label: string, run: () => void): void {
		const button = append(parent, $('a.picode-usage-action'));
		button.classList.add(...ThemeIcon.asClassNameArray(icon));
		button.title = label;
		button.setAttribute('aria-label', label);
		button.setAttribute('role', 'button');
		button.tabIndex = 0;
		this._register(addDisposableListener(button, EventType.CLICK, () => run()));
		this._register(addDisposableListener(button, EventType.KEY_DOWN, event => {
			const key = new StandardKeyboardEvent(event);
			if (key.equals(KeyCode.Enter) || key.equals(KeyCode.Space)) {
				run();
			}
		}));
	}

	show(data: IUsageData | undefined): void {
		this.render(data);
		if (this._visible) {
			return;
		}
		this._visible = true;
		this.element.classList.add('visible');
		this.element.focus();
		const target = getActiveWindow();
		this.visibleStore.add(addDisposableListener(target.document, EventType.KEY_DOWN, event => {
			if (new StandardKeyboardEvent(event).equals(KeyCode.Escape)) {
				this.hide();
			}
		}, true));
		// A click anywhere else closes it. A click on the counter closes it here too, and the toggle
		// that follows reads `closedAt` so it does not open it again.
		this.visibleStore.add(addDisposableListener(target.document, EventType.MOUSE_DOWN, event => {
			const node = event.target as Node | null;
			if (node !== null && !this.element.contains(node)) {
				this.closedAt = Date.now();
				this.hide();
			}
		}, true));
	}

	hide(): void {
		if (!this._visible) {
			return;
		}
		this._visible = false;
		this.visibleStore.clear();
		this.element.classList.remove('visible');
		this.onHidden();
	}

	render(data: IUsageData | undefined): void {
		const now = Date.now();
		clearNode(this.body);
		const resets = data?.models.map(model => model.resetAt).filter((at): at is number => at !== null) ?? [];
		const end = resets.length > 0 ? Math.min(...resets) : undefined;
		this.title.textContent = data?.periodStart !== null && data?.periodStart !== undefined && end !== undefined
			? localize('picodeUsageTitlePeriod', "NaN usage · {0} → {1}", day(data.periodStart), day(end))
			: localize('picodeUsageTitle', "NaN usage");

		if (data === undefined) {
			append(this.body, $('.picode-usage-note')).textContent = localize('picodeUsageNone', "No subscription usage to show.");
			return;
		}

		const table = append(this.body, $('table.picode-usage-table'));
		const head = append(append(table, $('thead')), $('tr'));
		for (const label of [localize('picodeUsageModel', "Model"), localize('picodeUsageUsed', "Used"), localize('picodeUsageCap', "Cap"), localize('picodeUsageUsage', "Usage"), localize('picodeUsageLeft', "Left")]) {
			append(head, $('th')).textContent = label;
		}
		const rows = append(table, $('tbody'));
		for (const model of data.models) {
			const row = append(rows, $('tr'));
			row.classList.toggle('current', model.current);
			row.classList.toggle('spent', model.limitReached || model.usedPercent >= 100);
			const nameCell = append(row, $('td.picode-usage-name'));
			if (model.current) {
				append(nameCell, $('span.picode-usage-dot')).title = localize('picodeUsageInUse', "In use in the chat");
			}
			append(nameCell, $('span')).textContent = model.name;
			append(row, $('td.picode-usage-num')).textContent = tokens(model.used);
			append(row, $('td.picode-usage-num')).textContent = tokens(model.cap);
			const usageCell = append(row, $('td.picode-usage-meter'));
			const bar = append(usageCell, $('.picode-usage-bar'));
			const fill = append(bar, $('.picode-usage-fill'));
			fill.style.width = `${Math.max(0, Math.min(100, model.usedPercent))}%`;
			fill.classList.toggle('warn', model.usedPercent >= 80 && model.usedPercent < 100);
			fill.classList.toggle('full', model.usedPercent >= 100);
			append(usageCell, $('span.picode-usage-percent')).textContent = percent(model.usedPercent);
			append(row, $('td.picode-usage-num')).textContent = percent(Math.max(0, 100 - model.usedPercent));

			const lines = [model.resetAt === null ? undefined : localize('picodeUsageRowReset', "Resets {0} (in {1})", dateTime(model.resetAt), until(model.resetAt, now))];
			if (model.window !== undefined) {
				lines.push(localize('picodeUsageRowWindow', "{0}: {1} used", model.window.label, percent(model.window.usedPercent)));
			}
			row.title = lines.filter((line): line is string => line !== undefined).join('\n');
		}

		// One line per reset date: most models share the account's, a few run on their own.
		const byReset = new Map<number, string[]>();
		for (const model of data.models) {
			if (model.resetAt !== null) {
				byReset.set(model.resetAt, [...(byReset.get(model.resetAt) ?? []), model.name]);
			}
		}
		const dates = [...byReset.entries()].sort(([left], [right]) => left - right);
		for (const [at, names] of dates) {
			const line = append(this.body, $('.picode-usage-note'));
			append(line, $('span.codicon.codicon-history'));
			append(line, $('span')).textContent = dates.length === 1
				? localize('picodeUsageResetAll', "Resets {0} (in {1})", dateTime(at), until(at, now))
				: localize('picodeUsageResetSome', "{0}: resets {1} (in {2})", names.join(', '), dateTime(at), until(at, now));
		}
		append(this.body, $('.picode-usage-note.dim')).textContent = data.fresh
			? localize('picodeUsageExplain', "Percentages are of each model's monthly cap.")
			: localize('picodeUsageStale', "Could not refresh: showing the last reading.");
	}
}

/** The counter and its panel, one per window. */
class PicodeUsageStatusContribution extends Disposable {

	static readonly ID = 'picode.usageStatus';

	private entry: IStatusbarEntryAccessor | undefined;
	private data: IUsageData | undefined;
	private readonly panel: UsagePanel;
	private reading = false;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IOpenerService openerService: IOpenerService,
	) {
		super();
		this.panel = this._register(new UsagePanel(layoutService.mainContainer, () => void this.refresh(), () => this.paint(), openerService));
		this._register(CommandsRegistry.registerCommand(TOGGLE_COMMAND, () => {
			// The mouse-down on the counter already closed it: this click means "close", not "reopen".
			if (Date.now() - this.panel.closedAt < 500) {
				return;
			}
			if (this.panel.visible) {
				this.panel.hide();
				return;
			}
			this.panel.show(this.data);
			this.paint();
			void this.refresh();
		}));
		const handle = setInterval(() => void this.refresh(), REFRESH_MS);
		this._register(toDisposable(() => clearInterval(handle)));
		this._register(toDisposable(() => this.entry?.dispose()));
		void this.refresh();
	}

	private async refresh(): Promise<void> {
		if (this.reading) {
			return;
		}
		this.reading = true;
		try {
			const answer = await this.commandService.executeCommand<unknown>(READ_COMMAND);
			this.data = isUsageData(answer) ? answer : undefined;
		} catch {
			// The connector has not started yet, or AI is off: nothing to count.
			this.data = undefined;
		} finally {
			this.reading = false;
		}
		this.paint();
		if (this.panel.visible) {
			this.panel.render(this.data);
		}
	}

	private paint(): void {
		if (this.data === undefined) {
			this.entry?.dispose();
			this.entry = undefined;
			return;
		}
		const counter = counterOf(this.data);
		const current = this.data.models.find(model => model.current);
		const entry: IStatusbarEntry = {
			name: localize('picodeUsageName', "Subscription usage"),
			text: counter.text,
			ariaLabel: localize('picodeUsageEntryAria', "NaN subscription usage"),
			tooltip: current === undefined
				? localize('picodeUsageTooltipAccount', "NaN subscription usage")
				: localize('picodeUsageTooltip', "{0}: {1} of this month's cap used", current.name, percent(current.usedPercent)),
			kind: counter.kind,
			command: TOGGLE_COMMAND,
			showBeak: this.panel.visible,
		};
		if (this.entry === undefined) {
			this.entry = this.statusbarService.addEntry(entry, ENTRY_ID, StatusbarAlignment.RIGHT, -100);
		} else {
			this.entry.update(entry);
		}
	}
}

registerWorkbenchContribution2(PicodeUsageStatusContribution.ID, PicodeUsageStatusContribution, WorkbenchPhase.AfterRestored);
