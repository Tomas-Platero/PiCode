/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/picodeUsageLimitsSection.css';
import { $ } from '../../../../base/browser/dom.js';
import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { aiCustomizationManagementSectionRegistry, IAICustomizationManagementSectionContribution, IAICustomizationManagementSectionWidget } from '../../chat/browser/aiCustomization/aiCustomizationManagementSectionRegistry.js';
import { AICustomizationManagementSection } from '../../chat/common/aiCustomizationWorkspaceService.js';
import { createServiceLogo } from './picodeServiceLogo.js';

/**
 * The Usage limits section of Chat Settings: how much of each plan is left, and when it resets.
 *
 * It reads the same answer as the Status section (`picode.setup.status`, its `subscriptions`) and
 * draws one tile per metered model, grouped by the provider the plan belongs to. A provider with
 * nothing to read draws nothing; with no meter at all, the page says how to get one.
 */

const STATUS_DATA_COMMAND = 'picode.setup.status';
const OPEN_PROVIDERS_COMMAND = 'picode.providersModels.open';
const NAN_DASHBOARD = 'https://cloud.nan.builders';
/** The connector caches each network read for a minute; reading it more often costs nothing. */
const REFRESH_MS = 15_000;

interface IWindow {
	readonly label: string;
	readonly usedPercent: number;
	readonly resetAt: number | null;
	readonly used?: number;
	readonly cap?: number;
}

interface IMeter {
	readonly meter?: string;
	readonly provider?: string;
	readonly current?: boolean;
	readonly windows: readonly IWindow[];
	readonly limitReached?: boolean;
	readonly fresh?: boolean;
}

interface IStatusSlice {
	readonly subscription?: IMeter;
	readonly subscriptions?: readonly IMeter[];
}

type Tone = 'ok' | 'warn' | 'danger';

/** The terminal's own thresholds: a warning from 80% and an error from 95%. */
function toneOf(percent: number, limitReached: boolean): Tone {
	return limitReached || percent >= 95 ? 'danger' : percent >= 80 ? 'warn' : 'ok';
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

/** The provider as people call it. */
function providerName(id: string | undefined): string {
	switch (id) {
		case 'nan': return 'NaN';
		case 'openai-codex': return 'ChatGPT';
		case 'anthropic': return 'Claude';
		case undefined: return localize('picodeUsageLimitsOtherProvider', "Plan");
		default: return id;
	}
}

/** The window in words, capitalised: "Billing period", "4-hour window". */
function windowName(label: string): string {
	return label.length > 0 ? label[0].toUpperCase() + label.slice(1) : label;
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

/** How long until a window resets, in the shortest words that are still true: 40m, 2h 33m, 3d 5h. */
function formatResetIn(resetAt: number): string {
	const minutes = Math.max(0, Math.round((resetAt - Date.now()) / 60_000));
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return minutes % 60 > 0 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	return hours % 24 > 0 ? `${days}d ${hours % 24}h` : `${days}d`;
}

export class PicodeUsageLimitsSection extends Disposable implements IAICustomizationManagementSectionWidget {

	private readonly root: HTMLElement;
	private readonly summary: HTMLElement;
	private readonly body: HTMLElement;
	private readonly updatedLabel: HTMLElement;
	private readonly refreshButton: Button;
	private readonly renderDisposables = this._register(new DisposableStore());
	private renderSequence = 0;
	/** What is on screen, so a refresh that changes nothing leaves the page (and its buttons) alone. */
	private fingerprint: string | undefined;
	private readAt: number | undefined;
	private layoutTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly interval: ReturnType<typeof setInterval>;

	get element(): HTMLElement {
		return this.root;
	}

	constructor(
		container: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();

		this.root = DOM.append(container, $('.picode-limits'));

		const head = DOM.append(this.root, $('.picode-limits-head'));
		const intro = DOM.append(head, $('.picode-limits-intro'));
		DOM.append(intro, $('.picode-limits-description')).textContent = localize('picodeUsageLimitsDescription', "How much of each plan you have used, and when it resets.");
		this.updatedLabel = DOM.append(intro, $('.picode-limits-updated'));
		this.refreshButton = this._register(new Button(head, { ...defaultButtonStyles, secondary: true, supportIcons: true, title: localize('picodeUsageLimitsRefreshTitle', "Read the limits again") }));
		this.refreshButton.label = `$(${Codicon.refresh.id}) ${localize('picodeUsageLimitsRefresh', "Refresh")}`;
		this.refreshButton.element.classList.add('picode-limits-btn');
		this._register(this.refreshButton.onDidClick(() => void this.refresh(true)));

		this.summary = DOM.append(this.root, $('.picode-limits-summary'));
		this.body = DOM.append(this.root, $('.picode-limits-body'));
		DOM.append(this.body, $('.picode-limits-empty')).textContent = localize('picodeUsageLimitsLoading', "Reading your limits…");

		// Live while the page is open; a hidden page does not read.
		this.interval = setInterval(() => {
			if (this.root.isConnected && this.root.offsetParent !== null) {
				void this.refresh();
			} else {
				this.paintUpdated();
			}
		}, REFRESH_MS);

		void this.refresh();
	}

	layout(_dimension: DOM.Dimension): void {
		if (this.layoutTimer !== undefined) {
			clearTimeout(this.layoutTimer);
		}
		this.layoutTimer = setTimeout(() => {
			this.layoutTimer = undefined;
			void this.refresh();
		}, 250);
	}

	override dispose(): void {
		clearInterval(this.interval);
		if (this.layoutTimer !== undefined) {
			clearTimeout(this.layoutTimer);
		}
		super.dispose();
	}

	private async refresh(manual = false): Promise<void> {
		const sequence = ++this.renderSequence;
		if (manual) {
			this.refreshButton.enabled = false;
			this.root.classList.add('busy');
		}
		let data: IStatusSlice | undefined;
		try {
			data = await this.commandService.executeCommand<IStatusSlice>(STATUS_DATA_COMMAND);
		} catch {
			// The connector is not answering yet; keep what is on screen.
		} finally {
			if (manual) {
				this.refreshButton.enabled = true;
				this.root.classList.remove('busy');
			}
		}
		if (sequence !== this.renderSequence && !manual) {
			return;
		}
		if (data === undefined) {
			if (this.fingerprint === undefined) {
				DOM.clearNode(this.body);
				DOM.append(this.body, $('.picode-limits-empty')).textContent = localize('picodeUsageLimitsUnavailable', "Your limits are not available yet — they will appear in a moment.");
			}
			return;
		}
		this.readAt = Date.now();
		const meters = data.subscriptions ?? (data.subscription === undefined ? [] : [data.subscription]);
		const fingerprint = JSON.stringify(meters);
		if (fingerprint !== this.fingerprint) {
			this.fingerprint = fingerprint;
			this.render(meters);
		} else {
			// Same numbers; only the "resets in" countdowns move.
			this.paintCountdowns();
		}
		this.paintUpdated();
	}

	private paintUpdated(): void {
		if (this.readAt === undefined) {
			this.updatedLabel.textContent = '';
			return;
		}
		const seconds = Math.round((Date.now() - this.readAt) / 1000);
		this.updatedLabel.textContent = seconds < 60
			? localize('picodeUsageLimitsUpdatedNow', "Updated just now")
			: localize('picodeUsageLimitsUpdatedAgo', "Updated {0} min ago", Math.floor(seconds / 60));
	}

	private paintCountdowns(): void {
		for (const element of this.body.querySelectorAll<HTMLElement>('[data-reset-at]')) {
			element.textContent = localize('picodeUsageLimitsResetsIn', "Resets in {0}", formatResetIn(Number(element.dataset.resetAt)));
		}
	}

	private render(meters: readonly IMeter[]): void {
		this.renderDisposables.clear();
		DOM.clearNode(this.summary);
		DOM.clearNode(this.body);

		const metered = meters.filter(meter => meter.windows.length > 0);
		if (metered.length === 0) {
			this.renderEmpty();
			return;
		}

		// The summary: how many plans are fine, close, and out — the answer before the detail.
		const tones = metered.map(meter => toneOf(Math.max(...meter.windows.map(window => clampPercent(window.usedPercent))), meter.limitReached === true));
		const counts = { ok: tones.filter(t => t === 'ok').length, warn: tones.filter(t => t === 'warn').length, danger: tones.filter(t => t === 'danger').length };
		this.addStat(Codicon.pass, counts.ok, localize('picodeUsageLimitsStatOk', "with room"), 'ok');
		this.addStat(Codicon.warning, counts.warn, localize('picodeUsageLimitsStatWarn', "near the limit"), 'warn');
		this.addStat(Codicon.error, counts.danger, localize('picodeUsageLimitsStatDanger', "at the limit"), 'danger');

		// One group per provider, in the order the connector gave (the provider in use first).
		const groups = new Map<string, IMeter[]>();
		for (const meter of metered) {
			const key = meter.provider ?? '';
			groups.set(key, [...(groups.get(key) ?? []), meter]);
		}
		for (const [provider, group] of groups) {
			this.renderGroup(provider.length > 0 ? provider : undefined, group);
		}
	}

	private addStat(icon: ThemeIcon, count: number, label: string, tone: Tone): void {
		const stat = DOM.append(this.summary, $(`.picode-limits-stat.${tone}`));
		stat.classList.toggle('zero', count === 0);
		DOM.append(stat, $('span.picode-limits-stat-icon')).appendChild(renderIcon(icon));
		DOM.append(stat, $('span.picode-limits-stat-count')).textContent = String(count);
		DOM.append(stat, $('span.picode-limits-stat-label')).textContent = label;
	}

	private renderEmpty(): void {
		const empty = DOM.append(this.body, $('.picode-limits-none'));
		DOM.append(empty, $('.picode-limits-none-icon')).appendChild(renderIcon(Codicon.graph));
		DOM.append(empty, $('.picode-limits-none-title')).textContent = localize('picodeUsageLimitsNoneTitle', "No plan limits to show");
		DOM.append(empty, $('.picode-limits-none-text')).textContent = localize('picodeUsageLimitsNoneText', "Sign in to a provider with a plan — NaN, ChatGPT or Claude — and its limits appear here.");
		const button = this.renderDisposables.add(new Button(empty, { ...defaultButtonStyles, supportIcons: true }));
		button.label = `$(${Codicon.plug.id}) ${localize('picodeUsageLimitsOpenProviders', "Open providers")}`;
		button.element.classList.add('picode-limits-btn');
		this.renderDisposables.add(button.onDidClick(() => void this.commandService.executeCommand(OPEN_PROVIDERS_COMMAND, 'providers')));
	}

	private renderGroup(provider: string | undefined, meters: readonly IMeter[]): void {
		const section = DOM.append(this.body, $('.picode-limits-group'));
		const head = DOM.append(section, $('.picode-limits-group-head'));
		if (provider !== undefined) {
			head.appendChild(createServiceLogo(provider, provider === 'nan' ? NAN_DASHBOARD : undefined));
		} else {
			DOM.append(head, $('span.picode-limits-group-icon')).appendChild(renderIcon(Codicon.creditCard));
		}
		DOM.append(head, $('span.picode-limits-group-name')).textContent = providerName(provider);
		DOM.append(head, $('span.picode-limits-group-count')).textContent = meters.length === 1
			? localize('picodeUsageLimitsOneModel', "1 model")
			: localize('picodeUsageLimitsModels', "{0} models", meters.length);
		if (meters.some(meter => meter.fresh === false)) {
			const stale = DOM.append(head, $('span.picode-limits-stale'));
			stale.appendChild(renderIcon(Codicon.history));
			DOM.append(stale, $('span')).textContent = localize('picodeUsageLimitsStale', "Last known reading");
		}
		DOM.append(head, $('span.grow'));
		if (provider === 'nan') {
			const link = DOM.append(head, $('a.picode-limits-link', { href: NAN_DASHBOARD, role: 'button', tabindex: '0' }));
			link.appendChild(renderIcon(Codicon.linkExternal));
			DOM.append(link, $('span')).textContent = localize('picodeUsageLimitsDashboard', "Open dashboard");
			const open = (event: Event) => {
				event.preventDefault();
				void this.openerService.open(URI.parse(NAN_DASHBOARD), { openExternal: true });
			};
			this.renderDisposables.add(DOM.addDisposableListener(link, DOM.EventType.CLICK, open));
			this.renderDisposables.add(DOM.addDisposableListener(link, DOM.EventType.KEY_DOWN, (event: KeyboardEvent) => {
				if (event.key === 'Enter' || event.key === ' ') {
					open(event);
				}
			}));
		}

		const grid = DOM.append(section, $('.picode-limits-grid'));
		for (const meter of meters) {
			this.renderTile(grid, meter);
		}
	}

	private renderTile(grid: HTMLElement, meter: IMeter): void {
		const peak = Math.max(...meter.windows.map(window => clampPercent(window.usedPercent)));
		const tone = toneOf(peak, meter.limitReached === true);
		const tile = DOM.append(grid, $(`.picode-limits-tile.${tone}`));
		tile.classList.toggle('current', meter.current === true);

		const head = DOM.append(tile, $('.picode-limits-tile-head'));
		const name = DOM.append(head, $('span.picode-limits-tile-name'));
		name.textContent = meter.meter && meter.meter.length > 0 ? meter.meter : providerName(meter.provider);
		name.title = name.textContent;
		if (meter.current === true) {
			const badge = DOM.append(head, $('span.picode-limits-badge.current'));
			badge.appendChild(renderIcon(Codicon.circleFilled));
			DOM.append(badge, $('span')).textContent = localize('picodeUsageLimitsInUse', "In use");
		}
		if (meter.limitReached === true) {
			DOM.append(head, $('span.picode-limits-badge.danger')).textContent = localize('picodeUsageLimitsReached', "Limit reached");
		}

		for (const window of meter.windows) {
			const percent = clampPercent(window.usedPercent);
			const windowTone = toneOf(percent, meter.limitReached === true && percent >= 100);
			const row = DOM.append(tile, $(`.picode-limits-window.${windowTone}`));

			const top = DOM.append(row, $('.picode-limits-window-top'));
			const label = DOM.append(top, $('span.picode-limits-window-label'));
			label.appendChild(renderIcon(window.label.startsWith('billing') ? Codicon.calendar : Codicon.clock));
			DOM.append(label, $('span')).textContent = windowName(window.label);
			const value = DOM.append(top, $('span.picode-limits-window-value'));
			DOM.append(value, $('strong')).textContent = `${percent}%`;
			DOM.append(value, $('span')).textContent = localize('picodeUsageLimitsUsed', "used");

			const bar = DOM.append(row, $('.picode-limits-bar'));
			bar.setAttribute('role', 'progressbar');
			bar.setAttribute('aria-valuemin', '0');
			bar.setAttribute('aria-valuemax', '100');
			bar.setAttribute('aria-valuenow', String(percent));
			bar.setAttribute('aria-label', `${name.textContent} · ${windowName(window.label)}`);
			DOM.append(bar, $('.picode-limits-bar-fill')).style.width = `${percent}%`;

			const foot = DOM.append(row, $('.picode-limits-window-foot'));
			const left = DOM.append(foot, $('span'));
			if (window.used !== undefined && window.cap !== undefined && window.cap > 0) {
				left.textContent = localize('picodeUsageLimitsTokens', "{0} of {1} tokens", tokens(window.used), tokens(window.cap));
			} else {
				left.textContent = localize('picodeUsageLimitsLeft', "{0}% left", 100 - percent);
			}
			if (window.resetAt !== null) {
				const reset = DOM.append(foot, $('span.picode-limits-reset'));
				reset.dataset.resetAt = String(window.resetAt);
				reset.textContent = localize('picodeUsageLimitsResetsIn', "Resets in {0}", formatResetIn(window.resetAt));
				reset.title = new Date(window.resetAt).toLocaleString();
			}
		}
	}
}

const contribution: IAICustomizationManagementSectionContribution = {
	id: AICustomizationManagementSection.UsageLimits,
	label: localize('picodeUsageLimitsSectionLabel', "Usage limits"),
	icon: Codicon.graph,
	description: localize('picodeUsageLimitsSectionDescription', "How much of each plan you have used, and when it resets."),
	supportsHarness: () => true,
	create: (instantiationService, container) => instantiationService.createInstance(PicodeUsageLimitsSection, container),
};
aiCustomizationManagementSectionRegistry.register(contribution);
