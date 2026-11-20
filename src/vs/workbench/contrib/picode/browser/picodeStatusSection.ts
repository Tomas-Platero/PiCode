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
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { aiCustomizationManagementSectionRegistry, IAICustomizationManagementSectionContribution, IAICustomizationManagementSectionWidget } from '../../chat/browser/aiCustomization/aiCustomizationManagementSectionRegistry.js';
import { AICustomizationManagementSection } from '../../chat/common/aiCustomizationWorkspaceService.js';
import { createServiceLogo, displayNameOf } from './picodeServiceLogo.js';

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

/** The last status read, kept for the window and across starts, so the page never opens empty. */
const LAST_STATUS_KEY = 'picode.status.last';
let lastStatus: IStatusData | undefined;
let lastStatusText: string | undefined;
const RESTART_COMMAND = 'picode.pi.restart';
const OPEN_PROFILE_COMMAND = 'picode.pi.openProfile';
const OPEN_PROVIDERS_COMMAND = 'picode.providersModels.open';
const REFRESH_MS = 5_000;

/** The state pastille in a card's header: a word, and the tone that colours it. */
/** The colour a card wears, so the page reads as groups at a glance. */
type Accent = 'blue' | 'green' | 'purple' | 'orange' | 'teal' | 'red';

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

/** Dictation's state, as the connector reports it (`voice-controller.ts`). */
type IVoiceStatus =
	| { readonly state: 'unsupported' }
	| { readonly state: 'not-installed'; readonly sizeMb: number; readonly error?: string }
	| { readonly state: 'downloading'; readonly sizeMb: number; readonly percent: number }
	| { readonly state: 'ready' };

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
	readonly costEstimated?: boolean;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly jobs?: readonly { readonly label?: string; readonly command?: string }[];
	readonly updates?: IUpdatesSnapshot;
	readonly voice?: IVoiceStatus;
	readonly error?: string;
}

/** The fields the page draws, and only those: the fingerprint must not move with the meters. */
function fingerprintOf(data: IStatusData): string {
	const { runtime, piVersion, providers, defaultModel, model, thinkingLevel, reasoning, gitBranch, gitChanges, gitInsertions, gitDeletions, projects, ctxTokens, ctxWindow, cost, costEstimated, inputTokens, outputTokens, cacheRead, cacheWrite, jobs, updates, voice, error } = data;
	return JSON.stringify({ runtime, piVersion, providers, defaultModel, model, thinkingLevel, reasoning, gitBranch, gitChanges, gitInsertions, gitDeletions, projects, ctxTokens, ctxWindow, cost, costEstimated, inputTokens, outputTokens, cacheRead, cacheWrite, jobs, updates, voice, error });
}

export class PicodeStatusSection extends Disposable implements IAICustomizationManagementSectionWidget {

	private readonly root: HTMLElement;
	private readonly filterInput: HTMLInputElement;
	private readonly noMatch: HTMLElement;
	private readonly hero: HTMLElement;
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
		@IStorageService private readonly storageService: IStorageService,
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
		this.hero = DOM.append(this.root, $('.picode-status-hero'));
		this.cardsContainer = DOM.append(this.root, $('.picode-status-cards'));
		this.emptyContainer = DOM.append(this.root, $('.picode-status-empty'));
		this.emptyContainer.textContent = localize('picodeStatusSectionEmpty', "The status is not available yet — it will appear in a moment.");
		this.noMatch = DOM.append(this.root, $('.picode-status-empty.picode-status-nomatch'));

		this.interval = setInterval(() => {
			if (this.root.isConnected && this.root.offsetParent !== null) {
				void this.refresh();
			}
		}, REFRESH_MS);

		// The last reading shows at once, even from a previous start; the fresh one replaces it when it comes.
		const remembered = lastStatus ?? this.readRemembered();
		if (remembered !== undefined) {
			this.fingerprint = fingerprintOf(remembered);
			this.render(remembered);
		}
		void this.refresh();
	}

	private readRemembered(): IStatusData | undefined {
		try {
			const text = this.storageService.get(LAST_STATUS_KEY, StorageScope.PROFILE);
			return text === undefined ? undefined : JSON.parse(text) as IStatusData;
		} catch {
			return undefined;
		}
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
		const text = JSON.stringify(data);
		if (text !== lastStatusText) {
			lastStatusText = text;
			this.storageService.store(LAST_STATUS_KEY, text, StorageScope.PROFILE, StorageTarget.MACHINE);
		}
		lastStatus = data;
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
		this.setBusy(button, action, true);
		try {
			await this.commandService.executeCommand(action.command, ...(action.args ?? []));
		} catch {
			// The command shows its own error; the page only stops waiting.
		} finally {
			this.running.delete(key);
			if (!this._store.isDisposed) {
				this.setBusy(button, action, false);
				void this.refresh(true);
			}
		}
	}

	/** A busy button swaps its own icon for a spinner: a spinning cloud or folder reads as a glitch. */
	private setBusy(button: Button, action: IAction, busy: boolean): void {
		button.enabled = !busy;
		button.element.classList.toggle('busy', busy);
		button.label = `$(${busy ? `${Codicon.loading.id}~spin` : action.icon.id}) ${action.label}`;
	}

	private render(data: IStatusData | undefined): void {
		this.rowDisposables.clear();
		DOM.clearNode(this.hero);
		DOM.clearNode(this.cardsContainer);
		DOM.clearNode(this.emptyContainer);
		this.cards = [];

		if (data === undefined) {
			this.emptyContainer.textContent = localize('picodeStatusSectionEmpty', "The status is not available yet — it will appear in a moment.");
			this.noMatch.textContent = '';
			return;
		}

		const external = data.runtime === 'external';
		this.renderHero(data);

		// pi: where it runs and the profile it reads; its version is in the figures above.
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
			accent: 'blue',
			actions: [
				{ label: localize('picodeStatusOpenProfileShort', "Open profile"), icon: Codicon.folderOpened, title: localize('picodeStatusOpenProfileDescription', "Reveal the profile in force in the file explorer."), command: OPEN_PROFILE_COMMAND },
				{ label: localize('picodeStatusRestartShort', "Restart pi"), icon: Codicon.debugRestart, title: localize('picodeStatusRestartDescription', "Reset the chat session and reload the window."), command: RESTART_COMMAND },
			],
		});

		if (data.providers !== undefined && data.providers.length > 0) {
			this.renderCard(localize('picodeStatusCardProviders', "Providers"), Codicon.account, card => {
				const chips = DOM.append(card, $('.picode-status-chips'));
				for (const provider of data.providers!) {
					const state = provider.subscription
						? localize('picodeStatusProviderSignedIn', "Signed in")
						: provider.credential
							? localize('picodeStatusProviderKey', "Key saved")
							: localize('picodeStatusProviderReady', "Set up");
					const chip = DOM.append(chips, $('.picode-status-chip'));
					chip.classList.add(provider.subscription ? 'account' : provider.credential ? 'key' : 'local');
					DOM.append(chip, $('.picode-status-chip-logo')).appendChild(createServiceLogo(provider.id));
					const text = DOM.append(chip, $('.picode-status-chip-text'));
					DOM.append(text, $('span.picode-status-chip-name')).textContent = provider.id === 'openai-codex' ? 'ChatGPT' : provider.id === 'anthropic' ? 'Claude' : displayNameOf(provider.id);
					DOM.append(text, $('span.picode-status-chip-state')).textContent = state;
				}
				// The figures above already show the default model when no session has picked one.
				if (data.defaultModel !== undefined && data.model !== undefined && data.model !== data.defaultModel) {
					this.addRow(card, Codicon.star, localize('picodeStatusDefaultModel', "Default model"), data.defaultModel);
				}
			}, {
				accent: 'purple',
				actions: [
					{ label: localize('picodeStatusAgentModelsShort', "Agent models"), icon: Codicon.hubot, title: localize('picodeStatusAgentModelsDescription', "The model each agent answers with."), command: OPEN_PROVIDERS_COMMAND, args: ['agents'] },
					{ label: localize('picodeStatusManageProviders', "Manage"), icon: Codicon.gear, title: localize('picodeStatusManageProvidersTitle', "Add, sign in to or remove providers."), command: OPEN_PROVIDERS_COMMAND, args: ['providers'] },
				],
			});
		}

		if (data.error !== undefined) {
			this.renderCard(localize('picodeStatusCardError', "Error"), Codicon.warning, card => {
				this.addRow(card, Codicon.error, localize('picodeStatusError', "Error"), data.error!);
			}, { alwaysVisible: true, accent: 'red', wide: true });
		}

		this.applyFilter();
	}

	/** The page at a glance: the figures someone opens it for, each in its own tile. */
	private renderHero(data: IStatusData): void {
		const tile = (icon: ThemeIcon, accent: Accent, label: string, value: string, sub?: string, extra?: (tile: HTMLElement) => void) => {
			const element = DOM.append(this.hero, $(`.picode-status-tile.accent-${accent}`));
			DOM.append(element, $('.picode-status-tile-icon')).appendChild(renderIcon(icon));
			const body = DOM.append(element, $('.picode-status-tile-body'));
			DOM.append(body, $('.picode-status-tile-label')).textContent = label;
			const valueEl = DOM.append(body, $('.picode-status-tile-value'));
			valueEl.textContent = value;
			valueEl.title = value;
			if (sub !== undefined && sub.length > 0) {
				const subEl = DOM.append(body, $('.picode-status-tile-sub'));
				subEl.textContent = sub;
				subEl.title = sub;
			}
			extra?.(element);
			return element;
		};

		tile(Codicon.terminal, 'blue', localize('picodeStatusPiVersion', "pi version"), data.piVersion ?? '—',
			data.runtime === 'external' ? localize('picodeStatusExternalShort', "On the PATH") : localize('picodeStatusInternalShort', "Bundled"));

		const model = data.model ?? data.defaultModel;
		if (model !== undefined) {
			tile(Codicon.hubot, 'purple', localize('picodeStatusModel', "Model"), model, data.thinkingLevel);
		}

	}

	/** Builds one card and hands its body to `build`; the card's buttons sit in its header. */
	private renderCard(title: string, icon: ThemeIcon, build: (card: HTMLElement) => void, options: { alwaysVisible?: boolean; pill?: IPill; actions?: readonly IAction[]; accent?: Accent; wide?: boolean } = {}): void {
		const card = DOM.append(this.cardsContainer, $('.picode-status-card'));
		card.classList.add(`accent-${options.accent ?? 'blue'}`);
		card.classList.toggle('wide', options.wide === true);
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
		// The headline figures are the page at a glance; while searching, only the cards answer.
		this.hero.classList.toggle('picode-status-filtered-out', term.length > 0);
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

	/** Appends a compact button; while its command runs it stays disabled, across redraws too. */
	private addButton(parent: HTMLElement, action: IAction): Button {
		const button = this.rowDisposables.add(new Button(parent, { ...defaultButtonStyles, secondary: action.primary !== true, supportIcons: true, title: action.title }));
		button.label = `$(${action.icon.id}) ${action.label}`;
		button.element.classList.add('picode-status-btn');
		button.element.classList.toggle('danger', action.danger === true);
		if (this.running.has(`${action.command}:${JSON.stringify(action.args ?? [])}`)) {
			this.setBusy(button, action, true);
		}
		this.rowDisposables.add(button.onDidClick(() => void this.run(action, button)));
		return button;
	}
}

const contribution: IAICustomizationManagementSectionContribution = {
	id: AICustomizationManagementSection.Status,
	label: localize('picodeAgentOverviewLabel', "Overview"),
	icon: Codicon.dashboard,
	description: localize('picodeAgentOverviewDescription', "The pi in force, its model and the providers it can use."),
	keywords: ['status', 'pi', 'version', 'restart', 'profile', 'model', 'providers'],
	supportsHarness: () => true,
	create: (instantiationService, container) => instantiationService.createInstance(PicodeStatusSection, container),
};
aiCustomizationManagementSectionRegistry.register(contribution);
