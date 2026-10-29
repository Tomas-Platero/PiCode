/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/picodeStatusSection.css';
import { $ } from '../../../../base/browser/dom.js';
import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { aiCustomizationManagementSectionRegistry, IAICustomizationManagementSectionContribution, IAICustomizationManagementSectionWidget } from '../../chat/browser/aiCustomization/aiCustomizationManagementSectionRegistry.js';
import { AICustomizationManagementSection } from '../../chat/common/aiCustomizationWorkspaceService.js';

/**
 * The Status section of the Agent Customizations page, as PiCode owns it.
 *
 * One read answers the whole panel (`picode.setup.status`): the pi in force and its version,
 * the providers, the session's usage and cost, the project's git, the update check, the background
 * jobs. Each card carries its own actions as buttons in its header — restart, check, update, clean
 * the cache — instead of instructions to type. The plan allowances have their own section
 * (`picodeUsageLimitsSection.ts`).
 *
 * Nothing is invented here: a fact the connector cannot obtain stays absent, and the card for it
 * is not drawn. The reading repeats every five seconds while the page is visible; a reading that
 * changed nothing leaves the DOM alone, so a button is never swapped out from under a click.
 */

const STATUS_DATA_COMMAND = 'picode.setup.status';
const RESTART_COMMAND = 'picode.pi.restart';
const CLEAN_CACHE_COMMAND = 'picode.pi.cleanCache';
const OPEN_PROFILE_COMMAND = 'picode.pi.openProfile';
const UPDATE_COMMAND = 'picode.updates.apply';
const CHECK_UPDATES_COMMAND = 'picode.updates.check';
const OPEN_PROVIDERS_COMMAND = 'picode.providersModels.open';
const THINKING_TOGGLE_COMMAND = 'picode.pi.toggleThinking';
const REFRESH_MS = 5_000;

/** The state pastille in a card's header: a word, and the tone that colours it. */
interface IPill {
	readonly text: string;
	readonly tone: 'ok' | 'warn' | 'off';
}

/** A button a card offers: the command it runs, and what it says. */
interface IAction {
	readonly label: string;
	readonly icon: ThemeIcon;
	/** What the button does, in a sentence: its tooltip. */
	readonly title: string;
	readonly command: string;
	readonly args?: readonly unknown[];
	readonly primary?: boolean;
	/** Throws something away: painted in the error colour. */
	readonly danger?: boolean;
}

/** The shape of one provider row, as the status command reports it. */
interface IProviderRow {
	readonly id: string;
	readonly declared?: boolean;
	readonly models?: boolean;
	readonly credential?: boolean;
	readonly subscription?: boolean;
}

/** One folder's git facts. */
interface IProjectRow {
	readonly name: string;
	readonly branch?: string;
	readonly changes?: number;
	readonly insertions?: number;
	readonly deletions?: number;
}

interface IUpdatesSnapshot {
	readonly checkedAt?: number;
	readonly targets?: readonly { readonly kind?: 'runtime' | 'package' | 'engine'; readonly name: string; readonly installed: string; readonly latest: string }[];
}

/** The slice of the status answer this section reads. */
interface IStatusData {
	readonly runtime?: string;
	readonly piVersion?: string;
	readonly providers?: readonly IProviderRow[];
	readonly defaultModel?: string;
	readonly model?: string;
	readonly thinkingLevel?: string;
	readonly reasoning?: 'shown' | 'hidden';
	readonly gitBranch?: string;
	readonly gitChanges?: number;
	readonly gitInsertions?: number;
	readonly gitDeletions?: number;
	readonly projects?: readonly IProjectRow[];
	readonly ctxTokens?: number;
	readonly ctxWindow?: number;
	readonly cost?: number;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly jobs?: readonly { readonly label?: string; readonly command?: string }[];
	readonly updates?: IUpdatesSnapshot;
	readonly error?: string;
}

/** The fields the page draws, and only those: the fingerprint must not move with the meters. */
function fingerprintOf(data: IStatusData): string {
	const { runtime, piVersion, providers, defaultModel, model, thinkingLevel, reasoning, gitBranch, gitChanges, gitInsertions, gitDeletions, projects, ctxTokens, ctxWindow, cost, inputTokens, outputTokens, cacheRead, cacheWrite, jobs, updates, error } = data;
	return JSON.stringify({ runtime, piVersion, providers, defaultModel, model, thinkingLevel, reasoning, gitBranch, gitChanges, gitInsertions, gitDeletions, projects, ctxTokens, ctxWindow, cost, inputTokens, outputTokens, cacheRead, cacheWrite, jobs, updates, error });
}

export class PicodeStatusSection extends Disposable implements IAICustomizationManagementSectionWidget {

	private readonly root: HTMLElement;
	private readonly filterInput: HTMLInputElement;
	private readonly noMatch: HTMLElement;
	private readonly cardsContainer: HTMLElement;
	private readonly emptyContainer: HTMLElement;
	/**
	 * What each card says, so the filter can hide the ones that do not carry the word without
	 * rebuilding anything: a refresh that arrived while the owner was typing must not steal the
	 * cursor, so the input is built once and only the cards come and go.
	 */
	private cards: { readonly element: HTMLElement; readonly text: string; readonly alwaysVisible: boolean }[] = [];
	/** Buttons of the cards on screen; cleared and refilled on every render. */
	private readonly rowDisposables = this._register(new DisposableStore());
	/** Guards a slow status answer against a newer render. */
	private renderSequence = 0;
	/** What is on screen; a reading with the same fingerprint is not drawn again. */
	private fingerprint: string | undefined;
	/** The commands running from a button, so the button stays busy across a redraw. */
	private readonly running = new Set<string>();
	/** Coalesces the refreshes `layout` asks for. */
	private layoutTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly interval: ReturnType<typeof setInterval>;

	get element(): HTMLElement {
		return this.root;
	}

	constructor(
		container: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this.root = DOM.append(container, $('.picode-status-section'));

		// The filter sits on top, where a search box is looked for, and survives every refresh; the
		// way into the settings sits beside it, the one action that is about none of the cards.
		const toolbar = DOM.append(this.root, $('.picode-status-toolbar'));
		const filterRow = DOM.append(toolbar, $('.picode-status-filter'));
		const magnifier = DOM.append(filterRow, $('.picode-status-filter-icon'));
		magnifier.classList.add(...ThemeIcon.asClassNameArray(Codicon.search));
		this.filterInput = DOM.append(filterRow, $('input.picode-status-filter-input')) as HTMLInputElement;
		this.filterInput.type = 'text';
		this.filterInput.placeholder = localize('picodeStatusFilterPlaceholder', "Filter the status");
		this._register(DOM.addDisposableListener(this.filterInput, DOM.EventType.INPUT, () => this.applyFilter()));
		const settings = this._register(new Button(toolbar, { ...defaultButtonStyles, secondary: true, supportIcons: true, title: localize('picodeStatusOpenSettingsDescription', "Open PiCode's settings.") }));
		settings.label = `$(${Codicon.settingsGear.id}) ${localize('picodeStatusOpenSettings', "Settings")}`;
		settings.element.classList.add('picode-status-btn');
		this._register(settings.onDidClick(() => void this.commandService.executeCommand('workbench.action.openSettings', 'picode')));

		this.cardsContainer = DOM.append(this.root, $('.picode-status-cards'));
		this.emptyContainer = DOM.append(this.root, $('.picode-status-empty'));
		this.emptyContainer.textContent = localize('picodeStatusSectionEmpty', "The status is not available yet — it will appear in a moment.");
		this.noMatch = DOM.append(this.root, $('.picode-status-empty.picode-status-nomatch'));

		this.interval = setInterval(() => {
			if (this.root.isConnected && this.root.offsetParent !== null) {
				void this.refresh();
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
			this.layoutTimer = undefined;
		}
		super.dispose();
	}

	private async refresh(force = false): Promise<void> {
		const sequence = ++this.renderSequence;
		let data: IStatusData | undefined;
		try {
			data = await this.commandService.executeCommand<IStatusData>(STATUS_DATA_COMMAND);
		} catch {
			// The connector is not answering yet; keep what is on screen.
		}
		if (sequence !== this.renderSequence || this._store.isDisposed) {
			return;
		}
		if (data === undefined) {
			if (this.fingerprint === undefined) {
				this.render(undefined);
			}
			return;
		}
		const fingerprint = fingerprintOf(data);
		if (!force && fingerprint === this.fingerprint) {
			return;
		}
		this.fingerprint = fingerprint;
		this.render(data);
	}

	/** Runs a button's command, keeps the button busy until it answers, then reads the status again. */
	private async run(action: IAction, button: Button): Promise<void> {
		const key = `${action.command}:${JSON.stringify(action.args ?? [])}`;
		if (this.running.has(key)) {
			return;
		}
		this.running.add(key);
		this.setBusy(button, true);
		try {
			await this.commandService.executeCommand(action.command, ...(action.args ?? []));
		} catch {
			// The command shows its own error; the page only stops waiting.
		} finally {
			this.running.delete(key);
			if (!this._store.isDisposed) {
				this.setBusy(button, false);
				void this.refresh(true);
			}
		}
	}

	private setBusy(button: Button, busy: boolean): void {
		button.enabled = !busy;
		button.element.classList.toggle('busy', busy);
	}

	private render(data: IStatusData | undefined): void {
		this.rowDisposables.clear();
		DOM.clearNode(this.cardsContainer);
		DOM.clearNode(this.emptyContainer);
		this.cards = [];

		if (data === undefined) {
			this.emptyContainer.textContent = localize('picodeStatusSectionEmpty', "The status is not available yet — it will appear in a moment.");
			this.noMatch.textContent = '';
			return;
		}

		// Host: the three facts of the pi in force, as one strip. As a vertical list it spent a
		// screen's height on three words, and the panel is mostly width, not height.
		const external = data.runtime === 'external';
		this.renderCard(localize('picodeStatusCardHost', "Host"), Codicon.server, card => {
			this.addFacts(card, [
				{
					label: localize('picodeStatusRuntime', "Runtime"),
					value: external ? localize('picodeStatusExternal', "External (on the PATH)") : localize('picodeStatusInternal', "Internal (bundled)"),
					title: external
						? localize('picodeStatusRuntimeExternalTitle', "pi runs from the machine's PATH, not from the copy PiCode ships.")
						: localize('picodeStatusRuntimeInternalTitle', "pi runs from the copy that ships inside PiCode."),
				},
				{
					label: localize('picodeStatusPiVersion', "pi version"),
					value: data.piVersion ?? '—',
					title: data.piVersion ?? localize('picodeStatusPiVersionUnknown', "pi did not report a version."),
				},
				{
					label: localize('picodeStatusProfile', "Profile"),
					value: external
						? localize('picodeStatusProfileMachineShort', "Machine profile")
						: localize('picodeStatusProfileOwnShort', "Own profile"),
					title: external
						? localize('picodeStatusProfileExternal', "the machine's pi profile")
						: localize('picodeStatusProfileInternal', "PiCode's own profile"),
				},
			]);
		}, {
			actions: [
				{ label: localize('picodeStatusOpenProfileShort', "Open profile"), icon: Codicon.folderOpened, title: localize('picodeStatusOpenProfileDescription', "Reveal the profile in force in the file explorer."), command: OPEN_PROFILE_COMMAND },
				{ label: localize('picodeStatusRestartShort', "Restart pi"), icon: Codicon.debugRestart, title: localize('picodeStatusRestartDescription', "Reset the chat session and reload the window."), command: RESTART_COMMAND },
			],
		});

		// Updates: the state in the header pill, what is behind as rows, the two things to do as buttons.
		const targets = data.updates?.targets ?? [];
		const checked = data.updates?.checkedAt;
		const pill: IPill = data.updates === undefined
			? { text: localize('picodeStatusUpdatesPillNever', "Never checked"), tone: 'off' }
			: targets.length === 0
				? { text: localize('picodeStatusUpdatesPillCurrent', "Up to date"), tone: 'ok' }
				: { text: localize('picodeStatusUpdatesPillBehind', "{0} to update", targets.length), tone: 'warn' };
		this.renderCard(localize('picodeStatusCardUpdates', "Updates"), Codicon.cloudDownload, card => {
			this.addRow(card, Codicon.history, localize('picodeStatusUpdatesChecked', "Last check"), checked === undefined
				? localize('picodeStatusUpdatesNever', "never")
				: this.relativeTime(checked));
			for (const target of targets) {
				const kind = target.kind === 'package'
					? localize('picodeStatusUpdatesPackage', "Package")
					: target.kind === 'engine'
						? localize('picodeStatusUpdatesEngine', "Memory")
						: localize('picodeStatusUpdatesRuntime', "pi");
				const icon = target.kind === 'engine' ? Codicon.database : target.kind === 'package' ? Codicon.package : Codicon.terminal;
				this.addRow(card, icon, `${kind} · ${target.name}`, `${target.installed} → ${target.latest}`);
			}
		}, {
			pill,
			actions: [
				{ label: localize('picodeStatusCheckUpdates', "Check again"), icon: Codicon.refresh, title: localize('picodeStatusCheckUpdatesTitle', "Look for new versions of pi, its packages and the memory engine."), command: CHECK_UPDATES_COMMAND },
				...(targets.length === 0 ? [] : [{ label: localize('picodeStatusUpdateAll', "Update all"), icon: Codicon.cloudDownload, title: localize('picodeStatusUpdateDescription', "Update pi, its packages and the memory engine."), command: UPDATE_COMMAND, primary: true }]),
			],
		});

		if (data.providers !== undefined && data.providers.length > 0) {
			this.renderCard(localize('picodeStatusCardProviders', "Providers"), Codicon.account, card => {
				for (const provider of data.providers!) {
					const state = provider.subscription
						? localize('picodeStatusProviderSignedIn', "Signed in")
						: provider.credential
							? localize('picodeStatusProviderKey', "Key saved")
							: localize('picodeStatusProviderReady', "Set up");
					this.addRow(card, Codicon.plug, provider.id, state);
				}
				if (data.defaultModel !== undefined) {
					this.addRow(card, Codicon.star, localize('picodeStatusDefaultModel', "Default model"), data.defaultModel);
				}
			}, {
				actions: [
					{ label: localize('picodeStatusAgentModelsShort', "Agent models"), icon: Codicon.hubot, title: localize('picodeStatusAgentModelsDescription', "The model each agent answers with."), command: OPEN_PROVIDERS_COMMAND, args: ['agents'] },
					{ label: localize('picodeStatusManageProviders', "Manage"), icon: Codicon.gear, title: localize('picodeStatusManageProvidersTitle', "Add, sign in to or remove providers."), command: OPEN_PROVIDERS_COMMAND, args: ['providers'] },
				],
			});
		}

		this.renderCard(localize('picodeStatusCardSession', "Session"), Codicon.pulse, card => {
			if (data.model !== undefined) {
				this.addRow(card, Codicon.hubot, localize('picodeStatusModel', "Model"), data.model);
			}
			if (data.thinkingLevel !== undefined) {
				this.addRow(card, Codicon.lightbulb, localize('picodeStatusThinking', "Thinking"), data.thinkingLevel);
			}
			if (data.reasoning !== undefined) {
				const hidden = data.reasoning === 'hidden';
				this.addRowButton(card, hidden ? Codicon.eyeClosed : Codicon.eye, localize('picodeStatusReasoning', "Reasoning in chat"), hidden
					? localize('picodeStatusReasoningHidden', "Hidden")
					: localize('picodeStatusReasoningShown', "Shown"), {
					label: hidden ? localize('picodeStatusShow', "Show") : localize('picodeStatusHide', "Hide"),
					icon: hidden ? Codicon.eye : Codicon.eyeClosed,
					title: localize('picodeStatusThinkingDescription', "Whether the model's reasoning is shown in the chat."),
					command: THINKING_TOGGLE_COMMAND,
				});
			}
			if (data.ctxTokens !== undefined && data.ctxWindow !== undefined && data.ctxWindow > 0) {
				this.addMeterRow(card, Codicon.window, localize('picodeStatusContext', "Context"), data.ctxTokens / data.ctxWindow * 100, `${data.ctxTokens.toLocaleString()} / ${data.ctxWindow.toLocaleString()}`);
			}
			if (data.inputTokens !== undefined || data.outputTokens !== undefined) {
				this.addRow(card, Codicon.symbolNumber, localize('picodeStatusTokens', "Tokens"), `${(data.inputTokens ?? 0).toLocaleString()} in · ${(data.outputTokens ?? 0).toLocaleString()} out`);
			}
			if (data.cacheRead !== undefined && data.cacheWrite !== undefined) {
				this.addRow(card, Codicon.archive, localize('picodeStatusCache', "Cache read / write"), `${data.cacheRead.toLocaleString()} / ${data.cacheWrite.toLocaleString()}`);
			}
			if (data.cost !== undefined) {
				this.addRow(card, Codicon.creditCard, localize('picodeStatusCost', "Cost"), `$${data.cost.toFixed(4)}`);
			}
		}, {
			actions: [
				{ label: localize('picodeStatusCleanCacheShort', "Clean model cache"), icon: Codicon.trash, title: localize('picodeStatusCleanCacheDescription', "Drop the model cache so pi rebuilds its list."), command: CLEAN_CACHE_COMMAND, danger: true },
			],
		});

		this.renderCard(localize('picodeStatusCardProject', "Project"), Codicon.gitBranch, card => {
			if (data.projects !== undefined) {
				for (const project of data.projects) {
					const branch = project.branch !== undefined && project.branch.length > 0 ? project.branch : localize('picodeStatusNoBranch', "no branch");
					const changes = project.changes !== undefined ? `${project.changes} ${project.changes === 1 ? localize('picodeStatusFile', "file") : localize('picodeStatusFiles', "files")}` : localize('picodeStatusClean', "clean");
					this.addRow(card, Codicon.repo, project.name, `${branch} · ${changes}`);
				}
				return;
			}
			this.addRow(card, Codicon.gitBranch, localize('picodeStatusBranch', "Branch"), data.gitBranch || '—');
			if (data.gitChanges !== undefined) {
				this.addDiffRow(card, data.gitChanges, data.gitInsertions, data.gitDeletions);
			}
		});

		if (data.jobs !== undefined && data.jobs.length > 0) {
			this.renderCard(localize('picodeStatusCardJobs', "Background jobs"), Codicon.tasklist, card => {
				for (const job of data.jobs!) {
					this.addRow(card, Codicon.terminal, job.label ?? localize('picodeStatusJob', "job"), job.command ?? '');
				}
			});
		}

		if (data.error !== undefined) {
			this.renderCard(localize('picodeStatusCardError', "Error"), Codicon.warning, card => {
				this.addRow(card, Codicon.error, localize('picodeStatusError', "Error"), data.error!);
			}, { alwaysVisible: true });
		}

		this.applyFilter();
	}

	/** Builds one card and hands its body to `build`; the card's buttons sit in its header. */
	private renderCard(title: string, icon: ThemeIcon, build: (card: HTMLElement) => void, options: { alwaysVisible?: boolean; pill?: IPill; actions?: readonly IAction[] } = {}): void {
		const card = DOM.append(this.cardsContainer, $('.picode-status-card'));
		const header = DOM.append(card, $('.card-head'));
		const iconSpan = DOM.append(header, $('span.picode-status-card-icon'));
		iconSpan.appendChild(renderIcon(icon));
		const titleSpan = DOM.append(header, $('span.grow'));
		titleSpan.textContent = title;
		if (options.pill !== undefined) {
			const pill = DOM.append(header, $(`.pill.${options.pill.tone}`));
			DOM.append(pill, $('.dot'));
			DOM.append(pill, $('span')).textContent = options.pill.text;
		}
		if (options.actions !== undefined && options.actions.length > 0) {
			const bar = DOM.append(header, $('.card-actions'));
			for (const action of options.actions) {
				this.addButton(bar, action);
			}
		}
		const before = card.childElementCount;
		build(card);
		card.classList.toggle('head-only', card.childElementCount === before);
		this.cards.push({ element: card, text: (card.textContent ?? '').toLowerCase(), alwaysVisible: options.alwaysVisible === true });
	}

	/** The Host strip: small label above, value below, three of them side by side. */
	private addFacts(card: HTMLElement, fields: readonly { label: string; value: string; title?: string }[]): void {
		const strip = DOM.append(card, $('.kv'));
		for (const field of fields) {
			const cell = DOM.append(strip, $('div'));
			const label = DOM.append(cell, $('small'));
			label.textContent = field.label;
			const value = DOM.append(cell, $('span.val'));
			value.textContent = field.value;
			value.title = field.title ?? field.value;
		}
	}

	/** A fact: what it is on the left, what it says on the right. */
	private addRow(card: HTMLElement, icon: ThemeIcon, label: string, value: string): HTMLElement {
		const row = DOM.append(card, $('.row'));
		this.addRowTitle(row, icon, label);
		if (value.length > 0) {
			const valueEl = DOM.append(row, $('.value'));
			valueEl.textContent = value;
			valueEl.title = value;
		}
		return row;
	}

	/** A fact with a bar under its name: how full something is, the numbers on the right. */
	private addMeterRow(card: HTMLElement, icon: ThemeIcon, label: string, percent: number, value: string): void {
		const clamped = Math.max(0, Math.min(100, percent));
		const row = this.addRow(card, icon, label, value);
		const text = row.querySelector<HTMLElement>('.text')!;
		const bar = DOM.append(text, $('.picode-status-meter'));
		bar.classList.add(clamped >= 95 ? 'danger' : clamped >= 80 ? 'warn' : 'ok');
		bar.setAttribute('role', 'progressbar');
		bar.setAttribute('aria-valuemin', '0');
		bar.setAttribute('aria-valuemax', '100');
		bar.setAttribute('aria-valuenow', String(Math.round(clamped)));
		bar.setAttribute('aria-label', label);
		DOM.append(bar, $('.picode-status-meter-fill')).style.width = `${clamped}%`;
	}

	/** The project's changes: files, then the added and removed lines in their own colours. */
	private addDiffRow(card: HTMLElement, files: number, insertions: number | undefined, deletions: number | undefined): void {
		const row = DOM.append(card, $('.row'));
		this.addRowTitle(row, Codicon.diff, localize('picodeStatusChanges', "Changes"));
		const value = DOM.append(row, $('.value.picode-status-diff'));
		DOM.append(value, $('span')).textContent = files === 1
			? localize('picodeStatusOneFile', "1 file")
			: localize('picodeStatusNFiles', "{0} files", files);
		if (insertions !== undefined) {
			DOM.append(value, $('span.added')).textContent = `+${insertions.toLocaleString()}`;
		}
		if (deletions !== undefined) {
			DOM.append(value, $('span.removed')).textContent = `−${deletions.toLocaleString()}`;
		}
	}

	/** A fact whose right-hand side is its own switch: the value, then the button that changes it. */
	private addRowButton(card: HTMLElement, icon: ThemeIcon, label: string, value: string, action: IAction): void {
		const row = DOM.append(card, $('.row.with-button'));
		this.addRowTitle(row, icon, label);
		const side = DOM.append(row, $('.row-side'));
		DOM.append(side, $('.value')).textContent = value;
		this.addButton(side, action);
	}

	/** The left-hand column of a row: icon and title, as the row's name. */
	private addRowTitle(row: HTMLElement, icon: ThemeIcon, label: string): HTMLElement {
		const text = DOM.append(row, $('.text'));
		const title = DOM.append(text, $('b'));
		const iconEl = DOM.append(title, $('span.picode-status-row-icon'));
		iconEl.appendChild(renderIcon(icon));
		DOM.append(title, $('span')).textContent = label;
		return text;
	}

	/**
	 * Hides the cards that do not carry the filter's word, and says so when none does.
	 *
	 * The always-visible cards stay: the filter narrows what the status *says*, and hiding the
	 * buttons would take away the only way to act on what is left.
	 */
	private applyFilter(): void {
		const term = this.filterInput.value.trim().toLowerCase();
		let visible = 0;
		for (const card of this.cards) {
			const match = card.alwaysVisible || term.length === 0 || card.text.includes(term);
			card.element.classList.toggle('picode-status-filtered-out', !match);
			if (match && !card.alwaysVisible) {
				visible++;
			}
		}
		this.noMatch.textContent = visible === 0 && term.length > 0
			? localize('picodeStatusNoMatch', "Nothing here says \"{0}\".", term)
			: '';
	}

	/**
	 * How long ago something happened, in the shortest words that are still true.
	 *
	 * The update check stores the moment it ran; a timestamp is not an answer a person wants in
	 * front of them, and "3 min ago" saves the arithmetic.
	 */
	private relativeTime(when: number): string {
		const seconds = Math.max(0, Math.round((Date.now() - when) / 1000));
		if (seconds < 60) {
			return localize('picodeStatusJustNow', "just now");
		}
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) {
			return localize('picodeStatusMinutesAgo', "{0} min ago", minutes);
		}
		const hours = Math.floor(minutes / 60);
		if (hours < 24) {
			return localize('picodeStatusHoursAgo', "{0} h ago", hours);
		}
		return localize('picodeStatusDaysAgo', "{0} d ago", Math.floor(hours / 24));
	}

	/** Appends a compact button; while its command runs it stays disabled, across redraws too. */
	private addButton(parent: HTMLElement, action: IAction): Button {
		const button = this.rowDisposables.add(new Button(parent, { ...defaultButtonStyles, secondary: action.primary !== true, supportIcons: true, title: action.title }));
		button.label = `$(${action.icon.id}) ${action.label}`;
		button.element.classList.add('picode-status-btn');
		button.element.classList.toggle('danger', action.danger === true);
		if (this.running.has(`${action.command}:${JSON.stringify(action.args ?? [])}`)) {
			this.setBusy(button, true);
		}
		this.rowDisposables.add(button.onDidClick(() => void this.run(action, button)));
		return button;
	}
}

const contribution: IAICustomizationManagementSectionContribution = {
	id: AICustomizationManagementSection.Status,
	label: localize('picodeStatusSectionLabel', "Status"),
	icon: Codicon.dashboard,
	description: localize('picodeStatusSectionNavigationDescription', "PiCode's state: the pi in force, the session, the project, and what can be done about them."),
	supportsHarness: () => true,
	create: (instantiationService, container) => instantiationService.createInstance(PicodeStatusSection, container),
};
aiCustomizationManagementSectionRegistry.register(contribution);
