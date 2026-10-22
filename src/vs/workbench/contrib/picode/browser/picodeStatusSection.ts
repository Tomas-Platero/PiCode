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
 * the providers, the session's usage and cost, the project's git, the update check, the durable
 * daemon, the subscription meter, the background jobs. The cards below draw exactly that, and
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

/** The durable daemon's answer. */
interface IDurableStatus {
	readonly up?: boolean;
	readonly work?: readonly { readonly taskId?: string }[];
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
	readonly targets?: readonly { readonly name: string; readonly installed: string; readonly latest: string }[];
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
	readonly durable?: IDurableStatus;
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

		this.renderCard(localize('picodeStatusCardHost', "Host"), Codicon.server, (card) => {
			const runtime = data.runtime === 'external' ? localize('picodeStatusExternal', "External (on the PATH)") : localize('picodeStatusInternal', "Internal (bundled)");
			this.addLine(card, Codicon.vm, localize('picodeStatusRuntime', "Runtime"), runtime);
			if (data.piVersion !== undefined) {
				this.addLine(card, Codicon.tag, localize('picodeStatusPiVersion', "pi version"), data.piVersion);
			}
			const profile = data.runtime === 'external' ? localize('picodeStatusProfileExternal', "the machine's pi profile") : localize('picodeStatusProfileInternal', "PiCode's own profile");
			this.addLine(card, Codicon.folder, localize('picodeStatusProfile', "Profile"), profile);
		});

		if (data.providers !== undefined && data.providers.length > 0) {
			this.renderCard(localize('picodeStatusCardProviders', "Providers"), Codicon.account, (card) => {
				for (const provider of data.providers!) {
					const origin = provider.declared ? localize('picodeStatusProviderDeclared', "declared") : (provider.models ? localize('picodeStatusProviderModels', "models in pi") : localize('picodeStatusProviderInPi', "in pi"));
					this.addLine(card, Codicon.plug, provider.id, origin);
				}
				if (data.defaultModel !== undefined) {
					this.addLine(card, Codicon.star, localize('picodeStatusDefaultModel', "Default model"), data.defaultModel);
				}
				const settingsButton = this.addButton(card, localize('picodeStatusOpenProviderSettings', "Open provider settings"), Codicon.gear, () => {
					void this.commandService.executeCommand(OPEN_PROVIDER_SETTINGS_COMMAND);
				});
				void settingsButton;
			});
		}

		if (data.ctxTokens !== undefined || data.cost !== undefined || data.model !== undefined) {
			this.renderCard(localize('picodeStatusCardSession', "Session"), Codicon.pulse, (card) => {
				if (data.model !== undefined) {
					this.addLine(card, Codicon.hubot, localize('picodeStatusModel', "Model"), data.model);
				}
				if (data.thinkingLevel !== undefined) {
					this.addLine(card, Codicon.lightbulb, localize('picodeStatusThinking', "Thinking"), data.thinkingLevel);
				}
				if (data.reasoning !== undefined) {
					// The line says which level the model thinks at; this button says whether that
					// thinking is written into the chat. It used to be a click on the row itself, and
					// a row that is a command is a row nobody finds.
					const hidden = data.reasoning === 'hidden';
					this.addButton(card, hidden ? localize('picodeStatusShowThinking', "Show thinking") : localize('picodeStatusHideThinking', "Hide thinking"), Codicon.lightbulb, () => {
						void this.commandService.executeCommand(THINKING_TOGGLE_COMMAND);
					});
				}
				if (data.ctxTokens !== undefined && data.ctxWindow !== undefined) {
					this.addLine(card, Codicon.window, localize('picodeStatusContext', "Context"), `${data.ctxTokens.toLocaleString()} / ${data.ctxWindow.toLocaleString()}`);
				}
				if (data.cost !== undefined) {
					this.addLine(card, Codicon.creditCard, localize('picodeStatusCost', "Cost"), `$${data.cost.toFixed(4)}`);
				}
				if (data.inputTokens !== undefined || data.outputTokens !== undefined) {
					this.addLine(card, Codicon.symbolNumber, localize('picodeStatusTokens', "Tokens"), `${(data.inputTokens ?? 0).toLocaleString()} in · ${(data.outputTokens ?? 0).toLocaleString()} out`);
				}
				if (data.cacheRead !== undefined && data.cacheWrite !== undefined) {
					this.addLine(card, Codicon.archive, localize('picodeStatusCache', "Cache read / write"), `${data.cacheRead.toLocaleString()} / ${data.cacheWrite.toLocaleString()}`);
				}
			});
		}

		if (data.gitBranch !== undefined || (data.projects !== undefined && data.projects.length > 0)) {
			this.renderCard(localize('picodeStatusCardProject', "Project"), Codicon.gitBranch, (card) => {
				if (data.gitBranch !== undefined) {
					const changes = data.gitChanges === undefined ? '' : ` · ${data.gitChanges} files`;
					const lines = data.gitInsertions !== undefined && data.gitDeletions !== undefined ? ` · +${data.gitInsertions} −${data.gitDeletions}` : '';
					this.addLine(card, Codicon.gitBranch, localize('picodeStatusBranch', "Branch"), `${data.gitBranch}${changes}${lines}`);
				}
				if (data.projects !== undefined) {
					for (const project of data.projects) {
						const branch = project.branch || '—';
						const changes = project.changes === undefined ? '' : ` · ${project.changes} files`;
						this.addLine(card, Codicon.folder, project.name, `${branch}${changes}`);
					}
				}
			});
		}

		if (data.updates !== undefined) {
			this.renderCard(localize('picodeStatusCardUpdates', "Updates"), Codicon.cloudDownload, (card) => {
				const targets = data.updates!.targets ?? [];
				if (targets.length === 0) {
					this.addLine(card, Codicon.check, localize('picodeStatusUpToDate', "Everything is up to date"), '');
				} else {
					for (const target of targets) {
						this.addLine(card, Codicon.cloudDownload, target.name, `${target.installed} → ${target.latest}`);
					}
					const updateButton = this.addButton(card, localize('picodeStatusUpdate', "Update pi"), Codicon.cloudDownload, () => {
						void this.commandService.executeCommand(UPDATE_COMMAND);
					});
					void updateButton;
				}
				const checkButton = this.addButton(card, localize('picodeStatusCheckUpdates', "Check again"), Codicon.refresh, () => {
					void this.commandService.executeCommand(CHECK_UPDATES_COMMAND);
				});
				void checkButton;
			});
		}

		if (data.subscription !== undefined && data.subscription.windows.length > 0) {
			this.renderCard(localize('picodeStatusCardSubscription', "Model subscription"), Codicon.creditCard, (card) => {
				for (const window of data.subscription!.windows) {
					this.addLine(card, Codicon.clock, window.label, `${window.usedPercent}% used`);
				}
			});
		}

		if (data.durable !== undefined) {
			this.renderCard(localize('picodeStatusCardDurable', "Durable agent"), Codicon.layers, (card) => {
				const up = data.durable!.up === true;
				this.addLine(card, Codicon.pulse, localize('picodeStatusDurableState', "State"), up ? localize('picodeStatusDurableUp', "Running") : localize('picodeStatusDurableDown', "Not running"));
				const work = data.durable!.work ?? [];
				if (work.length > 0) {
					this.addLine(card, Codicon.sync, localize('picodeStatusDurableWork', "In flight"), String(work.length));
				}
			});
		}

		if (data.jobs !== undefined && data.jobs.length > 0) {
			this.renderCard(localize('picodeStatusCardJobs', "Background jobs"), Codicon.tasklist, (card) => {
				for (const job of data.jobs!) {
					this.addLine(card, Codicon.terminal, job.label ?? localize('picodeStatusJob', "job"), job.command ?? '');
				}
			});
		}

		if (data.error !== undefined) {
			this.renderCard(localize('picodeStatusCardError', "Error"), Codicon.warning, (card) => {
				const line = DOM.append(card, $('.picode-status-line'));
				const iconEl = DOM.append(line, $('span.picode-status-line-icon'));
				iconEl.appendChild(renderIcon(Codicon.error));
				const message = DOM.append(line, $('.picode-status-value'));
				message.textContent = data.error!;
				line.classList.add('picode-status-error');
			});
		}

		this.renderCard(localize('picodeStatusCardActions', "Actions"), Codicon.zap, (card) => {
			this.addActionButton(card, localize('picodeStatusRestart', "Restart pi"), Codicon.refresh, localize('picodeStatusRestartDescription', "Reset the chat session and reload the window."), () => {
				void this.commandService.executeCommand(RESTART_COMMAND);
			});
			this.addActionButton(card, localize('picodeStatusUpdate', "Update pi"), Codicon.cloudDownload, localize('picodeStatusUpdateDescription', "Update pi and its packages."), () => {
				void this.commandService.executeCommand(UPDATE_COMMAND);
			});
			this.addActionButton(card, localize('picodeStatusCleanCache', "Clean cache"), Codicon.trash, localize('picodeStatusCleanCacheDescription', "Drop the model cache so pi rebuilds its list."), () => {
				void this.commandService.executeCommand(CLEAN_CACHE_COMMAND);
			});
			this.addActionButton(card, localize('picodeStatusOpenProfile', "Open profile"), Codicon.folderOpened, localize('picodeStatusOpenProfileDescription', "Reveal the profile in force in the file explorer."), () => {
				void this.commandService.executeCommand(OPEN_PROFILE_COMMAND);
			});
			this.addActionButton(card, localize('picodeStatusOpenSettings', "Settings"), Codicon.gear, localize('picodeStatusOpenSettingsDescription', "Open PiCode's settings."), () => {
				void this.commandService.executeCommand('workbench.action.openSettings', 'picode');
			});
		}, true);

		this.applyFilter();
	}

	/** Builds one card and hands its body to `build`. */
	private renderCard(title: string, icon: { readonly id: string }, build: (card: HTMLElement) => void, alwaysVisible = false): void {
		const card = DOM.append(this.cardsContainer, $('.picode-status-card'));
		const header = DOM.append(card, $('.picode-status-card-header'));
		const iconSpan = DOM.append(header, $('span.picode-status-card-icon'));
		iconSpan.appendChild(renderIcon(ThemeIcon.fromId(icon.id)));
		const titleSpan = DOM.append(header, $('span'));
		titleSpan.textContent = title;
		build(card);
		this.cards.push({ element: card, text: (card.textContent ?? '').toLowerCase(), alwaysVisible });
	}

	/** Appends a label/value line, with the icon that says what kind of fact it is. */
	private addLine(card: HTMLElement, icon: { readonly id: string }, label: string, value: string): void {
		const line = DOM.append(card, $('.picode-status-line'));
		const labelEl = DOM.append(line, $('.picode-status-label'));
		const iconEl = DOM.append(labelEl, $('span.picode-status-line-icon'));
		iconEl.appendChild(renderIcon(ThemeIcon.fromId(icon.id)));
		DOM.append(labelEl, $('span')).textContent = label;
		if (value.length > 0) {
			const valueEl = DOM.append(line, $('.picode-status-value'));
			valueEl.textContent = value;
		}
	}

	/**
	 * Hides the cards that do not carry the filter's word, and says so when none does.
	 *
	 * The Actions card stays: the filter narrows what the status *says*, and hiding the buttons
	 * would take away the only way to act on what is left.
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

	/** Appends a small secondary button to a card. */
	private addButton(card: HTMLElement, label: string, icon: { readonly id: string }, onClick: () => void): Button {
		const button = this.rowDisposables.add(new Button(card, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		button.label = `$(${icon.id}) ${label}`;
		this.rowDisposables.add(button.onDidClick(onClick));
		return button;
	}

	/** Appends a full-width action button to the Actions card. */
	private addActionButton(card: HTMLElement, label: string, icon: { readonly id: string }, description: string, onClick: () => void): void {
		const row = DOM.append(card, $('.picode-status-action'));
		const button = this.rowDisposables.add(new Button(row, { ...defaultButtonStyles, supportIcons: true }));
		button.label = `$(${icon.id}) ${label}`;
		button.setTitle(description);
		this.rowDisposables.add(button.onDidClick(onClick));
		const desc = DOM.append(row, $('.picode-status-action-description'));
		desc.textContent = description;
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