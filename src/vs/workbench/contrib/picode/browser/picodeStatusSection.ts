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
const RESTART_COMMAND = 'picode.pi.restart';
const CLEAN_CACHE_COMMAND = 'picode.pi.cleanCache';
const OPEN_PROFILE_COMMAND = 'picode.pi.openProfile';
const UPDATE_COMMAND = 'picode.updates.apply';
const CHECK_UPDATES_COMMAND = 'picode.updates.check';
const VOICE_DOWNLOAD_COMMAND = 'picode.voice.download';
const VOICE_CANCEL_COMMAND = 'picode.voice.cancel';
const VOICE_REMOVE_COMMAND = 'picode.voice.remove';
const OPEN_PROVIDERS_COMMAND = 'picode.providersModels.open';
const THINKING_TOGGLE_COMMAND = 'picode.pi.toggleThinking';
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

/** A count in the fewest characters that still read right: 950, 12.4k, 1.2M. */
function compact(value: number): string {
	if (value < 1000) {
		return String(value);
	}
	if (value < 1_000_000) {
		return `${Number((value / 1000).toFixed(value < 10_000 ? 1 : 0))}k`;
	}
	return `${Number((value / 1_000_000).toFixed(1))}M`;
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
		const targets = data.updates?.targets ?? [];
		const updatesPill: IPill = data.updates === undefined
			? { text: localize('picodeStatusUpdatesPillNever', "Never checked"), tone: 'off' }
			: targets.length === 0
				? { text: localize('picodeStatusUpdatesPillCurrent', "Up to date"), tone: 'ok' }
				: { text: localize('picodeStatusUpdatesPillBehind', "{0} to update", targets.length), tone: 'warn' };
		this.renderHero(data, updatesPill);

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

		// Updates: only what is behind. The state, when it was looked at and "check again" are in the figures above.
		if (targets.length > 0) {
			this.renderCard(localize('picodeStatusCardUpdates', "Updates"), Codicon.cloudDownload, card => {
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
				accent: 'orange',
				actions: [
					{ label: localize('picodeStatusUpdateAll', "Update all"), icon: Codicon.cloudDownload, title: localize('picodeStatusUpdateDescription', "Update pi, its packages and the memory engine."), command: UPDATE_COMMAND, primary: true },
				],
			});
		}

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

		// Session: the model, context and cost are in the figures above; here, the rest of its numbers.
		this.renderCard(localize('picodeStatusCardSession', "Session"), Codicon.pulse, card => {
			const stats: { label: string; value: string }[] = [];
			if (data.inputTokens !== undefined || data.outputTokens !== undefined) {
				stats.push({ label: localize('picodeStatusTokensIn', "Tokens in"), value: compact(data.inputTokens ?? 0) });
				stats.push({ label: localize('picodeStatusTokensOut', "Tokens out"), value: compact(data.outputTokens ?? 0) });
			}
			if (data.cacheRead !== undefined && data.cacheWrite !== undefined) {
				stats.push({ label: localize('picodeStatusCacheRead', "Cache read"), value: compact(data.cacheRead) });
				stats.push({ label: localize('picodeStatusCacheWrite', "Cache write"), value: compact(data.cacheWrite) });
			}
			if (stats.length > 0) {
				this.addStats(card, stats);
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
		}, {
			accent: 'teal',
			actions: [
				{ label: localize('picodeStatusCleanCacheShort', "Clean model cache"), icon: Codicon.trash, title: localize('picodeStatusCleanCacheDescription', "Drop the model cache so pi rebuilds its list."), command: CLEAN_CACHE_COMMAND, danger: true },
			],
		});

		// Dictation: whether the speech engine is on this machine, with the one thing to do about it.
		const voice = data.voice;
		if (voice !== undefined && voice.state !== 'unsupported') {
			const pill: IPill = voice.state === 'ready'
				? { text: localize('picodeStatusVoicePillReady', "Ready"), tone: 'ok' }
				: voice.state === 'downloading'
					? { text: localize('picodeStatusVoicePillDownloading', "Downloading {0}%", voice.percent), tone: 'warn' }
					: { text: localize('picodeStatusVoicePillOff', "Not installed"), tone: 'off' };
			this.renderCard(localize('picodeStatusCardVoice', "Dictation"), Codicon.mic, card => {
				if (voice.state === 'ready') {
					this.addRow(card, Codicon.check, localize('picodeStatusVoiceReadyRow', "Speech to text"), localize('picodeStatusVoiceReadyValue', "Works on your computer"));
				} else {
					this.addRow(card, Codicon.cloudDownload, localize('picodeStatusVoiceSizeRow', "One-time download"), localize('picodeStatusVoiceSizeValue', "About {0} MB", voice.sizeMb));
					if (voice.state === 'not-installed' && voice.error !== undefined) {
						this.addRow(card, Codicon.warning, localize('picodeStatusVoiceFailedRow', "Last try"), localize('picodeStatusVoiceFailedValue', "Could not finish downloading"));
					}
				}
			}, {
				pill,
				accent: 'orange',
				actions: voice.state === 'ready'
					? [{ label: localize('picodeStatusVoiceRemove', "Remove"), icon: Codicon.trash, title: localize('picodeStatusVoiceRemoveTitle', "Take dictation off this computer."), command: VOICE_REMOVE_COMMAND }]
					: voice.state === 'downloading'
						? [{ label: localize('picodeStatusVoiceCancel', "Cancel"), icon: Codicon.debugStop, title: localize('picodeStatusVoiceCancelTitle', "Stop downloading. What was fetched is kept."), command: VOICE_CANCEL_COMMAND }]
						: [{ label: localize('picodeStatusVoiceDownload', "Download"), icon: Codicon.cloudDownload, title: localize('picodeStatusVoiceDownloadTitle', "Download dictation (about {0} MB). It runs on your computer.", voice.sizeMb), command: VOICE_DOWNLOAD_COMMAND, primary: true }],
			});
		}

		// Several folders: one line each. A single folder's branch and changes are in the figures above.
		if (data.projects !== undefined && data.projects.length > 0) {
			this.renderCard(localize('picodeStatusCardProject', "Project"), Codicon.gitBranch, card => {
				for (const project of data.projects!) {
					const row = DOM.append(card, $('.row'));
					this.addRowTitle(row, Codicon.repo, project.name);
					const value = DOM.append(row, $('.value.picode-status-diff'));
					DOM.append(value, $('span.picode-status-branch')).textContent = project.branch !== undefined && project.branch.length > 0 ? project.branch : localize('picodeStatusNoBranch', "no branch");
					if (project.changes !== undefined && project.changes > 0) {
						if (project.insertions !== undefined) {
							DOM.append(value, $('span.added')).textContent = `+${project.insertions.toLocaleString()}`;
						}
						if (project.deletions !== undefined) {
							DOM.append(value, $('span.removed')).textContent = `−${project.deletions.toLocaleString()}`;
						}
					} else {
						DOM.append(value, $('span')).textContent = localize('picodeStatusClean', "clean");
					}
				}
			}, { accent: 'green', wide: true });
		}

		if (data.jobs !== undefined && data.jobs.length > 0) {
			this.renderCard(localize('picodeStatusCardJobs', "Background jobs"), Codicon.tasklist, card => {
				for (const job of data.jobs!) {
					this.addRow(card, Codicon.terminal, job.label ?? localize('picodeStatusJob', "job"), job.command ?? '');
				}
			}, { accent: 'purple', wide: true });
		}

		if (data.error !== undefined) {
			this.renderCard(localize('picodeStatusCardError', "Error"), Codicon.warning, card => {
				this.addRow(card, Codicon.error, localize('picodeStatusError', "Error"), data.error!);
			}, { alwaysVisible: true, accent: 'red', wide: true });
		}

		this.applyFilter();
	}

	/** The page at a glance: the figures someone opens it for, each in its own tile. */
	private renderHero(data: IStatusData, updates: IPill): void {
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

		const updatesTile = tile(updates.tone === 'warn' ? Codicon.cloudDownload : updates.tone === 'ok' ? Codicon.passFilled : Codicon.circleSlash,
			updates.tone === 'warn' ? 'orange' : updates.tone === 'ok' ? 'green' : 'blue',
			localize('picodeStatusCardUpdates', "Updates"), updates.text,
			data.updates?.checkedAt !== undefined ? this.relativeTime(data.updates.checkedAt) : undefined);
		updatesTile.classList.add(`tone-${updates.tone}`);
		const check = this.addButton(updatesTile, { label: '', icon: Codicon.refresh, title: localize('picodeStatusCheckUpdatesTitle', "Look for new versions of pi, its packages and the memory engine."), command: CHECK_UPDATES_COMMAND });
		check.element.classList.add('picode-status-tile-action');
		check.element.setAttribute('aria-label', localize('picodeStatusCheckUpdates', "Check again"));

		const model = data.model ?? data.defaultModel;
		if (model !== undefined) {
			tile(Codicon.hubot, 'purple', localize('picodeStatusModel', "Model"), model, data.thinkingLevel);
		}

		if (data.ctxTokens !== undefined && data.ctxWindow !== undefined && data.ctxWindow > 0) {
			const percent = Math.max(0, Math.min(100, data.ctxTokens / data.ctxWindow * 100));
			const level = percent >= 95 ? 'danger' : percent >= 80 ? 'warn' : 'ok';
			const contextTile = tile(Codicon.window, 'teal', localize('picodeStatusContext', "Context"), `${Math.round(percent)}%`, `${compact(data.ctxTokens)} / ${compact(data.ctxWindow)}`, element => {
				const ring = DOM.append(element, $(`.picode-status-ring.${level}`));
				ring.style.setProperty('--picode-ring', `${percent}%`);
				ring.setAttribute('role', 'progressbar');
				ring.setAttribute('aria-valuemin', '0');
				ring.setAttribute('aria-valuemax', '100');
				ring.setAttribute('aria-valuenow', String(Math.round(percent)));
				ring.setAttribute('aria-label', localize('picodeStatusContext', "Context"));
			});
			contextTile.classList.add('with-ring');
		}

		if (data.cost !== undefined) {
			// A leading "~" marks a cost worked out from the model catalogue rather than billed.
			tile(Codicon.creditCard, 'orange', localize('picodeStatusCost', "Cost"), `${data.costEstimated ? '~' : ''}$${data.cost.toFixed(data.cost >= 1 ? 2 : 4)}`, localize('picodeStatusThisSession', "This session"));
		}

		if (data.projects === undefined || data.projects.length === 0) {
			tile(Codicon.gitBranch, 'green', localize('picodeStatusBranch', "Branch"), data.gitBranch || '—', undefined, element => {
				if (data.gitChanges === undefined || data.gitChanges === 0) {
					DOM.append(element.querySelector('.picode-status-tile-body')!, $('.picode-status-tile-sub')).textContent = localize('picodeStatusClean', "clean");
					return;
				}
				const sub = DOM.append(element.querySelector('.picode-status-tile-body')!, $('.picode-status-tile-sub.picode-status-diff'));
				DOM.append(sub, $('span')).textContent = data.gitChanges === 1
					? localize('picodeStatusOneFile', "1 file")
					: localize('picodeStatusNFiles', "{0} files", data.gitChanges);
				if (data.gitInsertions !== undefined) {
					DOM.append(sub, $('span.added')).textContent = `+${data.gitInsertions.toLocaleString()}`;
				}
				if (data.gitDeletions !== undefined) {
					DOM.append(sub, $('span.removed')).textContent = `−${data.gitDeletions.toLocaleString()}`;
				}
				// The share of lines added against removed, as a two-colour bar.
				const added = data.gitInsertions ?? 0;
				const removed = data.gitDeletions ?? 0;
				if (added + removed > 0) {
					const bar = DOM.append(element, $('.picode-status-diffbar'));
					DOM.append(bar, $('span.added')).style.width = `${added / (added + removed) * 100}%`;
					DOM.append(bar, $('span.removed')).style.width = `${removed / (added + removed) * 100}%`;
				}
			});
		}
	}

	/** Small figures side by side inside a card: a label above, the number below. */
	private addStats(card: HTMLElement, stats: readonly { label: string; value: string }[]): void {
		const grid = DOM.append(card, $('.picode-status-stats'));
		for (const stat of stats) {
			const cell = DOM.append(grid, $('.picode-status-stat'));
			DOM.append(cell, $('.picode-status-stat-value')).textContent = stat.value;
			DOM.append(cell, $('.picode-status-stat-label')).textContent = stat.label;
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
