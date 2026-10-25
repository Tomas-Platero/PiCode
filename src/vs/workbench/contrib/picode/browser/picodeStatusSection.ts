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
 * the providers, the session's usage and cost, the project's git, the update check, the subscription
 * meter, the background jobs. The cards below draw exactly that, and
 * the Actions card turns the things the owner does most often into buttons — restart, update,
 * clean the cache, open the profile, open the settings — instead of instructions to type.
 *
 * Nothing is invented here: a fact the connector cannot obtain stays absent, and the card for it
 * is not drawn. The reading happens on a timer, the same five-second rhythm the activity-bar tree
 * used, so the numbers stay live while the page is open.
 */

const STATUS_DATA_COMMAND = 'picode.setup.status';
const RESTART_COMMAND = 'picode.pi.restart';
const CLEAN_CACHE_COMMAND = 'picode.pi.cleanCache';
const OPEN_PROFILE_COMMAND = 'picode.pi.openProfile';
const UPDATE_COMMAND = 'picode.updates.apply';
const CHECK_UPDATES_COMMAND = 'picode.updates.check';
const OPEN_PROVIDER_SETTINGS_COMMAND = 'picode.status.openProviderSettings';
const THINKING_TOGGLE_COMMAND = 'picode.pi.toggleThinking';
const AGENT_MODELS_COMMAND = 'picode.agents.chooseModels';

/** The state pastille in a card's header: a word, and the tone that colours it. */
interface IPill {
	readonly text: string;
	readonly tone: 'ok' | 'warn' | 'off';
}

/** The shape of one provider row, as the status command reports it. */
interface IProviderRow {
	readonly id: string;
	readonly declared?: boolean;
	readonly models?: boolean;
	readonly credential?: boolean;
}

/** One folder's git facts. */
interface IProjectRow {
	readonly name: string;
	readonly branch?: string;
	readonly changes?: number;
	readonly insertions?: number;
	readonly deletions?: number;
}

/** A subscription window. */
interface ISubscriptionWindow {
	readonly label: string;
	readonly usedPercent: number;
	readonly resetAt: number;
}

interface ISubscriptionStatus {
	readonly windows: readonly ISubscriptionWindow[];
}

interface IUpdatesSnapshot {
	readonly checkedAt?: number;
	readonly targets?: readonly { readonly kind?: 'runtime' | 'package'; readonly name: string; readonly installed: string; readonly latest: string }[];
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
	readonly subscription?: ISubscriptionStatus;
	readonly jobs?: readonly { readonly label?: string; readonly command?: string }[];
	readonly updates?: IUpdatesSnapshot;
	readonly error?: string;
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
	/** The two-card groups on screen, so the filter can hide one that has nothing left to show. */
	/** Buttons of the cards on screen; cleared and refilled on every render. */
	private readonly rowDisposables = this._register(new DisposableStore());
	/** Guards a slow status answer against a newer render. */
	private renderSequence = 0;
	/** Coalesces the refreshes `layout` asks for. */
	private layoutTimer: ReturnType<typeof setTimeout> | undefined;

	get element(): HTMLElement {
		return this.root;
	}

	constructor(
		container: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this.root = DOM.append(container, $('.picode-status-section'));

		const description = DOM.append(this.root, $('.picode-status-section-description'));
		description.textContent = localize('picodeStatusSectionDescription', "PiCode's own state: the pi in force, the session, the project, and what can be done about them.");

		this.cardsContainer = DOM.append(this.root, $('.picode-status-cards'));
		this.emptyContainer = DOM.append(this.root, $('.picode-status-empty'));
		this.emptyContainer.textContent = localize('picodeStatusSectionEmpty', "The status is not available yet — it will appear in a moment.");

		// The filter survives the refresh: the cards move under it, never the other way round.
		const filterRow = DOM.append(this.root, $('.picode-status-filter'));
		const magnifier = DOM.append(filterRow, $('.picode-status-filter-icon'));
		magnifier.classList.add(...ThemeIcon.asClassNameArray(Codicon.search));
		this.filterInput = DOM.append(filterRow, $('input.picode-status-filter-input')) as HTMLInputElement;
		this.filterInput.type = 'text';
		this.filterInput.placeholder = localize('picodeStatusFilterPlaceholder', "Filter the status");
		this._register(DOM.addDisposableListener(this.filterInput, DOM.EventType.INPUT, () => this.applyFilter()));
		this.noMatch = DOM.append(this.root, $('.picode-status-empty.picode-status-nomatch'));

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
		if (this.layoutTimer !== undefined) {
			clearTimeout(this.layoutTimer);
			this.layoutTimer = undefined;
		}
		super.dispose();
	}

	private async refresh(): Promise<void> {
		const sequence = ++this.renderSequence;
		let data: IStatusData | undefined;
		try {
			data = await this.commandService.executeCommand<IStatusData>(STATUS_DATA_COMMAND);
		} catch {
			// The connector is not answering yet; keep what is on screen.
		}
		if (sequence !== this.renderSequence) {
			return;
		}
		this.render(data);
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
		this.renderCard(localize('picodeStatusCardHost', "Host"), Codicon.server, card => {
			const external = data.runtime === 'external';
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
					// The panel is PiCode's own: "PiCode's" in the value is context the label already
					// gives, and it was the text that broke the strip into two uneven lines.
					value: external
						? localize('picodeStatusProfileMachineShort', "Machine profile")
						: localize('picodeStatusProfileOwnShort', "Own profile"),
					title: external
						? localize('picodeStatusProfileExternal', "the machine's pi profile")
						: localize('picodeStatusProfileInternal', "PiCode's own profile"),
				},
			]);
		});

		// Updates: one card, a headline fact and its button.
		const updatesCard = (parent: HTMLElement): void => {
			const targets = data.updates?.targets ?? [];
			const checked = data.updates?.checkedAt;
			const pill: IPill = data.updates === undefined
				? { text: localize('picodeStatusUpdatesPillNever', "Never checked"), tone: 'off' }
				: targets.length === 0
					? { text: localize('picodeStatusUpdatesPillCurrent', "Up to date"), tone: 'ok' }
					: { text: localize('picodeStatusUpdatesPillBehind', "{0} to update", targets.length), tone: 'warn' };
			this.renderCard(localize('picodeStatusCardUpdates', "Updates"), Codicon.cloudDownload, card => {
				this.addRowButton(card, Codicon.history, localize('picodeStatusUpdatesChecked', "Last check"), checked === undefined
					? localize('picodeStatusUpdatesNever', "never")
					: this.relativeTime(checked), localize('picodeStatusCheckUpdates', "Check again"), Codicon.refresh, () => {
					void this.commandService.executeCommand(CHECK_UPDATES_COMMAND);
				});
				// What the update covers is said once, and each row says which part it is: the pi
				// runtime itself, or one of the packages it loads.
				if (targets.length > 0) {
					this.addRow(card, Codicon.package, localize('picodeStatusUpdatesCovers', "Covers"), localize('picodeStatusUpdatesCoversValue', "pi and its packages"));
					for (const target of targets) {
						const kind = target.kind === 'package' ? localize('picodeStatusUpdatesPackage', "Package") : localize('picodeStatusUpdatesRuntime', "pi");
						this.addRow(card, Codicon.cloudDownload, `${kind} · ${target.name}`, `${target.installed} → ${target.latest}`);
					}
				}
			}, { parent, pill });
		};

		updatesCard(this.cardsContainer);

		if (data.providers !== undefined && data.providers.length > 0) {
			this.renderCard(localize('picodeStatusCardProviders', "Providers"), Codicon.account, card => {
				for (const provider of data.providers!) {
					const origin = provider.declared ? localize('picodeStatusProviderDeclared', "declared") : (provider.models ? localize('picodeStatusProviderModels', "models in pi") : localize('picodeStatusProviderInPi', "in pi"));
					this.addRow(card, Codicon.plug, provider.id, origin);
				}
				if (data.defaultModel !== undefined) {
					this.addRow(card, Codicon.star, localize('picodeStatusDefaultModel', "Default model"), data.defaultModel);
				}
				this.addActionRow(card, localize('picodeStatusOpenProviderSettings', "Open provider settings"), Codicon.gear, undefined, () => {
					void this.commandService.executeCommand(OPEN_PROVIDER_SETTINGS_COMMAND);
				});
				this.addActionRow(card, localize('picodeStatusAgentModels', "Choose models for agents"), Codicon.hubot, localize('picodeStatusAgentModelsDescription', "The model each agent answers with."), () => {
					void this.commandService.executeCommand(AGENT_MODELS_COMMAND);
				});
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
				this.addActionRow(card, hidden
					? localize('picodeStatusShowThinking', "Show thinking")
					: localize('picodeStatusHideThinking', "Hide thinking"), Codicon.lightbulb, localize('picodeStatusThinkingDescription', "Whether the model's reasoning is shown in the chat."), () => {
					void this.commandService.executeCommand(THINKING_TOGGLE_COMMAND);
				});
			}
			if (data.ctxTokens !== undefined && data.ctxWindow !== undefined) {
				this.addRow(card, Codicon.window, localize('picodeStatusContext', "Context"), `${data.ctxTokens.toLocaleString()} / ${data.ctxWindow.toLocaleString()}`);
			}
			if (data.cost !== undefined) {
				this.addRow(card, Codicon.creditCard, localize('picodeStatusCost', "Cost"), `$${data.cost.toFixed(4)}`);
			}
			if (data.inputTokens !== undefined || data.outputTokens !== undefined) {
				this.addRow(card, Codicon.symbolNumber, localize('picodeStatusTokens', "Tokens"), `${(data.inputTokens ?? 0).toLocaleString()} in · ${(data.outputTokens ?? 0).toLocaleString()} out`);
			}
			if (data.cacheRead !== undefined && data.cacheWrite !== undefined) {
				this.addRow(card, Codicon.archive, localize('picodeStatusCache', "Cache read / write"), `${data.cacheRead.toLocaleString()} / ${data.cacheWrite.toLocaleString()}`);
			}
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
			const changes = data.gitChanges === undefined
				? '—'
				: data.gitInsertions !== undefined && data.gitDeletions !== undefined
					? `${data.gitChanges} · +${data.gitInsertions.toLocaleString()} −${data.gitDeletions.toLocaleString()}`
					: String(data.gitChanges);
			this.addRow(card, Codicon.gitBranch, localize('picodeStatusBranch', "Branch"), data.gitBranch || '—');
			this.addRow(card, Codicon.diff, localize('picodeStatusChanges', "Changes"), changes);
		});

		if (data.subscription !== undefined) {
			this.renderCard(localize('picodeStatusCardSubscription', "Model subscription"), Codicon.creditCard, card => {
				for (const window of data.subscription!.windows) {
					this.addRow(card, Codicon.clock, window.label, `${window.usedPercent}% used`);
				}
			});
		}

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
			});
		}

		this.renderCard(localize('picodeStatusCardActions', "Actions"), Codicon.zap, card => {
			this.addActionRow(card, localize('picodeStatusRestart', "Restart pi"), Codicon.refresh, localize('picodeStatusRestartDescription', "Reset the chat session and reload the window."), () => {
				void this.commandService.executeCommand(RESTART_COMMAND);
			});
			this.addActionRow(card, localize('picodeStatusUpdate', "Update pi"), Codicon.cloudDownload, localize('picodeStatusUpdateDescription', "Update pi and its packages."), () => {
				void this.commandService.executeCommand(UPDATE_COMMAND);
			});
			// The only destructive one: it throws away a cache that pi would otherwise keep.
			this.addActionRow(card, localize('picodeStatusCleanCache', "Clean cache"), Codicon.trash, localize('picodeStatusCleanCacheDescription', "Drop the model cache so pi rebuilds its list."), () => {
				void this.commandService.executeCommand(CLEAN_CACHE_COMMAND);
			}, true);
			this.addActionRow(card, localize('picodeStatusOpenProfile', "Open profile"), Codicon.folderOpened, localize('picodeStatusOpenProfileDescription', "Reveal the profile in force in the file explorer."), () => {
				void this.commandService.executeCommand(OPEN_PROFILE_COMMAND);
			});
			this.addActionRow(card, localize('picodeStatusOpenSettings', "Settings"), Codicon.gear, localize('picodeStatusOpenSettingsDescription', "Open PiCode's settings."), () => {
				void this.commandService.executeCommand('workbench.action.openSettings', 'picode');
			});
		}, { alwaysVisible: true });

		this.applyFilter();
	}

	/** Builds one card and hands its body to `build`. */
	private renderCard(title: string, icon: { readonly id: string }, build: (card: HTMLElement) => void, options: { alwaysVisible?: boolean; parent?: HTMLElement; pill?: IPill } = {}): void {
		const card = DOM.append(options.parent ?? this.cardsContainer, $('.picode-status-card'));
		const header = DOM.append(card, $('.card-head'));
		const iconSpan = DOM.append(header, $('span.picode-status-card-icon'));
		iconSpan.appendChild(renderIcon(ThemeIcon.fromId(icon.id)));
		const titleSpan = DOM.append(header, $('span.grow'));
		titleSpan.textContent = title;
		if (options.pill !== undefined) {
			const pill = DOM.append(header, $(`.pill.${options.pill.tone}`));
			DOM.append(pill, $('.dot'));
			DOM.append(pill, $('span')).textContent = options.pill.text;
		}
		build(card);
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

	/** A fact: what it is on the left, what it says on the right, on one line each. */
	private addRow(card: HTMLElement, icon: { readonly id: string }, label: string, value: string): void {
		const row = DOM.append(card, $('.row'));
		this.addRowTitle(row, icon, label);
		if (value.length > 0) {
			const valueEl = DOM.append(row, $('.value'));
			valueEl.textContent = value;
			valueEl.title = value;
		}
	}

	/** A fact whose right-hand side is a button: the headline row of Updates. */
	private addRowButton(card: HTMLElement, icon: { readonly id: string }, label: string, value: string, buttonLabel: string, buttonIcon: { readonly id: string }, onClick: () => void): void {
		const row = DOM.append(card, $('.row'));
		const text = this.addRowTitle(row, icon, label);
		if (value.length > 0) {
			const valueEl = DOM.append(text, $('.picode-status-row-text'));
			valueEl.textContent = value;
		}
		this.addButton(row, buttonLabel, buttonIcon, onClick);
	}

	/**
	 * An action: what it does on the left, the button that does it on the right.
	 *
	 * The button is last in the markup and first in the reading order of the row it closes; the grid
	 * gives it its own column, so every button of the card lines up on the same edge whatever the
	 * description's length.
	 */
	private addActionRow(card: HTMLElement, label: string, icon: { readonly id: string }, description: string | undefined, onClick: () => void, danger = false): void {
		const row = DOM.append(card, $('.row'));
		const text = this.addRowTitle(row, icon, label);
		if (description !== undefined) {
			const desc = DOM.append(text, $('.picode-status-row-text'));
			desc.textContent = description;
			desc.title = description;
		}
		const button = this.addButton(row, label, icon, onClick);
		if (danger) {
			button.element.classList.add('danger');
		}
	}

	/** The left-hand column of a row: icon and title, in bold, as the row's name. */
	private addRowTitle(row: HTMLElement, icon: { readonly id: string }, label: string): HTMLElement {
		const text = DOM.append(row, $('.text'));
		const title = DOM.append(text, $('b'));
		const iconEl = DOM.append(title, $('span.picode-status-row-icon'));
		iconEl.appendChild(renderIcon(ThemeIcon.fromId(icon.id)));
		DOM.append(title, $('span')).textContent = label;
		return text;
	}

	/**
	 * Hides the cards that do not carry the filter's word, and says so when none does.
	 *
	 * The Actions card stays: the filter narrows what the status *says*, and hiding the buttons
	 * would take away the only way to act on what is left. A two-card group leaves with its cards.
	 */
	private applyFilter(): void {
		const term = this.filterInput.value.trim().toLowerCase();
		let visible = 0;
		for (const card of this.cards) {
			const match = card.alwaysVisible || term.length === 0 || card.text.includes(term);
			card.element.classList.toggle('picode-status-filtered-out', !match);
			if (match) {
				visible++;
			}
		}
		this.noMatch.textContent = visible === 0
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

	/** Appends a secondary button to a row. Fixed width, so a column of them lines up. */
	private addButton(row: HTMLElement, label: string, icon: { readonly id: string }, onClick: () => void): Button {
		const button = this.rowDisposables.add(new Button(row, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		button.label = `$(${icon.id}) ${label}`;
		button.element.classList.add('picode-status-btn');
		this.rowDisposables.add(button.onDidClick(onClick));
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