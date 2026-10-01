/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationWelcomePromptLaunchers.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { ScrollbarVisibility } from '../../../../../base/common/scrollable.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import type { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { AICustomizationManagementSection } from './aiCustomizationManagement.js';
import { agentIcon, instructionsIcon, pluginIcon, skillIcon, hookIcon, toolsIcon } from './aiCustomizationIcons.js';
import { IAICustomizationWorkspaceService } from '../../common/aiCustomizationWorkspaceService.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import type { IAICustomizationWelcomePageImplementation, ICustomizationMigrationCategorySummary, IWelcomePageCallbacks } from './aiCustomizationWelcomePage.js';

const $ = DOM.$;

interface IPromptLaunchersCategoryDescription {
	readonly id: AICustomizationManagementSection;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly description: string;
	readonly promptType?: PromptsType;
}

interface IStandaloneCustomizationDescription {
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly description: string;
	readonly commandId: string;
}

export class PromptLaunchersAICustomizationWelcomePage extends Disposable implements IAICustomizationWelcomePageImplementation {

	private readonly cardDisposables = this._register(new DisposableStore());

	readonly container: HTMLElement;
	private readonly scrollable: DomScrollableElement;
	private cardsContainer: HTMLElement | undefined;
	private firstCard: HTMLElement | undefined;
	private heading: HTMLElement | undefined;
	private visibleSectionIds = new Set<AICustomizationManagementSection>();

	private migrationCategories: readonly ICustomizationMigrationCategorySummary[] = [];

	private readonly categoryDescriptions: IPromptLaunchersCategoryDescription[] = [
		{
			id: AICustomizationManagementSection.Agents,
			label: localize('agents', "Agents"),
			icon: agentIcon,
			description: localize('agentsDesc', "Define custom agents with specialized personas, tool access, and instructions for specific tasks."),
			promptType: PromptsType.agent,
		},
		{
			id: AICustomizationManagementSection.Skills,
			label: localize('skills', "Skills"),
			icon: skillIcon,
			description: localize('skillsDesc', "Create reusable skill files that provide domain-specific knowledge and workflows."),
			promptType: PromptsType.skill,
		},
		{
			id: AICustomizationManagementSection.Instructions,
			label: localize('instructions', "Instructions"),
			icon: instructionsIcon,
			description: localize('instructionsDesc', "Set always-on instructions that guide AI behavior across your workspace or user profile."),
			promptType: PromptsType.instructions,
		},
		{
			id: AICustomizationManagementSection.Hooks,
			label: localize('hooks', "Hooks"),
			icon: hookIcon,
			description: localize('hooksDesc', "Configure automated actions triggered by events like saving files or running tasks."),
			promptType: PromptsType.hook,
		},
		{
			id: AICustomizationManagementSection.McpServers,
			label: localize('mcpServers', "MCP Servers"),
			icon: Codicon.server,
			description: localize('mcpServersDesc', "Connect external tool servers that extend AI capabilities with custom tools and data sources."),
		},
		{
			id: AICustomizationManagementSection.Plugins,
			label: localize('plugins', "Packages"),
			icon: pluginIcon,
			description: localize('pluginsDesc', "Extend pi with packages that add extensions, skills, prompts, and MCP servers."),
		},
		{
			id: AICustomizationManagementSection.Tools,
			label: localize('tools', "Tools"),
			icon: toolsIcon,
			description: localize('toolsDesc', "Enable or disable the tools available to chat."),
		},
	];

	private readonly standaloneCustomizations: IStandaloneCustomizationDescription[] = [
		// Empty on purpose: the Voice Mode and Dictation cards this mechanism used
		// to render are VS Code editor concepts with no pi equivalent, so they must
		// not appear in this window (AGENTS.md, "La ventana de gestión del chat
		// habla de pi, no de Copilot"). The rendering path stays so a future
		// standalone customization has a home that already works.
	];

	constructor(
		parent: HTMLElement,
		private readonly callbacks: IWelcomePageCallbacks,
		private readonly commandService: ICommandService,
		private readonly workspaceService: IAICustomizationWorkspaceService,
		private harnessLabel: string,
	) {
		super();

		this.container = $('.welcome-prompts-content-container');
		this.scrollable = this._register(new DomScrollableElement(this.container, {
			horizontal: ScrollbarVisibility.Hidden,
			vertical: ScrollbarVisibility.Auto,
			useShadows: false,
		}));
		const scrollableNode = this.scrollable.getDomNode();
		scrollableNode.classList.add('welcome-prompts-scrollable');
		parent.appendChild(scrollableNode);

		// Re-scan whenever the wrapper changes size so the scrollbar reflects
		// the current overflow state. rebuildCards() scans after content changes.
		const resizeObserver = this._register(new DOM.DisposableResizeObserver('AICustomizationWelcomePagePromptLaunchers.scrollable', () => this.scrollable.scanDomNode()));
		this._register(resizeObserver.observe(scrollableNode));

		const welcomeInner = DOM.append(this.container, $('.welcome-prompts-inner'));

		this.heading = DOM.append(welcomeInner, $('h2.welcome-prompts-heading'));
		this.updateHeading();

		const subtitle = DOM.append(welcomeInner, $('p.welcome-prompts-subtitle'));
		subtitle.textContent = localize('welcomeSubtitle', "Tailor how agents work in your projects. Configure workspace customizations for the entire team, or create personal ones that follow you across projects.");

		this.cardsContainer = DOM.append(welcomeInner, $('.welcome-prompts-cards'));
	}

	rebuildCards(visibleSectionIds: ReadonlySet<AICustomizationManagementSection>): void {
		if (!this.cardsContainer) {
			return;
		}
		this.visibleSectionIds = new Set(visibleSectionIds);

		this.cardDisposables.clear();
		DOM.clearNode(this.cardsContainer);
		this.firstCard = undefined;

		for (const category of this.categoryDescriptions) {
			if (!visibleSectionIds.has(category.id)) {
				continue;
			}

			const card = DOM.append(this.cardsContainer, $('.welcome-prompts-card'));
			card.setAttribute('tabindex', '0');
			card.setAttribute('role', 'button');
			if (!this.firstCard) {
				this.firstCard = card;
			}

			const cardHeader = DOM.append(card, $('.welcome-prompts-card-header'));
			const iconEl = DOM.append(cardHeader, $('.welcome-prompts-card-icon'));
			iconEl.classList.add(...ThemeIcon.asClassNameArray(category.icon));
			const labelEl = DOM.append(cardHeader, $('span.welcome-prompts-card-label'));
			labelEl.textContent = category.label;

			const descEl = DOM.append(card, $('p.welcome-prompts-card-description'));
			descEl.textContent = category.description;

			const footer = DOM.append(card, $('.welcome-prompts-card-footer'));
			if (category.promptType) {
				const generateBtn = DOM.append(footer, $('button.welcome-prompts-card-action'));
				generateBtn.textContent = localize('new', "New...");
				generateBtn.setAttribute('aria-label', localize('newCategoryAriaLabel', "New {0}...", category.label));
				this.cardDisposables.add(DOM.addDisposableListener(generateBtn, 'click', e => {
					e.stopPropagation();
					this.callbacks.closeEditor();
					if (this.workspaceService.isSessionsWindow) {
						const typeLabel = category.label.toLowerCase().replace(/s$/, '');
						this.callbacks.prefillChat(`Create me a custom ${typeLabel} that `, { isPartialQuery: true, newChat: true });
					} else {
						this.workspaceService.generateCustomization(category.promptType!);
					}
				}));
			} else {
				const browseBtn = DOM.append(footer, $('button.welcome-prompts-card-action'));
				browseBtn.textContent = localize('browse', "Browse...");
				browseBtn.setAttribute('aria-label', localize('browseCategoryAriaLabel', "Browse {0}...", category.label));
				this.cardDisposables.add(DOM.addDisposableListener(browseBtn, 'click', e => {
					e.stopPropagation();
					this.callbacks.selectSectionWithMarketplace(category.id);
				}));
			}

			this.cardDisposables.add(DOM.addDisposableListener(card, 'click', () => {
				this.callbacks.selectSection(category.id);
			}));
			this.cardDisposables.add(DOM.addDisposableListener(card, 'keydown', e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					this.callbacks.selectSection(category.id);
				}
			}));
		}

		if (!this.workspaceService.isSessionsWindow) {
			for (const customization of this.standaloneCustomizations) {
				this.renderStandaloneCustomization(customization);
			}
		}

		for (const category of this.migrationCategories) {
			this.renderCustomizationMigrationCard(category);
		}

		// Content changed — recompute scroll dimensions.
		this.scrollable.scanDomNode();
	}

	private renderStandaloneCustomization(customization: IStandaloneCustomizationDescription): void {
		if (!this.cardsContainer) {
			return;
		}

		const card = DOM.append(this.cardsContainer, $('.welcome-prompts-card'));
		card.setAttribute('tabindex', '0');
		card.setAttribute('role', 'button');
		if (!this.firstCard) {
			this.firstCard = card;
		}

		const cardHeader = DOM.append(card, $('.welcome-prompts-card-header'));
		const iconEl = DOM.append(cardHeader, $('.welcome-prompts-card-icon'));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(customization.icon));
		const labelEl = DOM.append(cardHeader, $('span.welcome-prompts-card-label'));
		labelEl.textContent = customization.label;

		const descEl = DOM.append(card, $('p.welcome-prompts-card-description'));
		descEl.textContent = customization.description;

		const footer = DOM.append(card, $('.welcome-prompts-card-footer'));
		const configureButton = DOM.append(footer, $('button.welcome-prompts-card-action'));
		configureButton.textContent = localize('configure', "Configure...");
		configureButton.setAttribute('aria-label', localize('configureCategoryAriaLabel', "Configure {0}...", customization.label));

		const configure = () => {
			void this.commandService.executeCommand(customization.commandId);
		};
		this.cardDisposables.add(DOM.addDisposableListener(configureButton, 'click', e => {
			e.stopPropagation();
			configure();
		}));
		this.cardDisposables.add(DOM.addDisposableListener(card, 'click', configure));
		this.cardDisposables.add(DOM.addDisposableListener(card, 'keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				configure();
			}
		}));
	}

	setMigrationCategories(categories: readonly ICustomizationMigrationCategorySummary[]): void {
		const didChange = categories.length !== this.migrationCategories.length
			|| categories.some((category, index) => {
				const previous = this.migrationCategories[index];
				return previous.id !== category.id
					|| previous.count !== category.count
					|| previous.description !== category.description;
			});
		this.migrationCategories = categories;
		if (didChange) {
			this.rebuildCards(this.visibleSectionIds);
		}
	}

	setHarnessLabel(label: string): void {
		if (this.harnessLabel === label) {
			return;
		}
		this.harnessLabel = label;
		this.updateHeading();
	}

	private updateHeading(): void {
		if (this.heading) {
			this.heading.textContent = localize('welcomeHeadingWithHarness', "Agent Customizations for {0}", this.harnessLabel);
		}
	}

	private renderCustomizationMigrationCard(category: ICustomizationMigrationCategorySummary): void {
		if (!this.cardsContainer) {
			return;
		}

		const migrationCard = DOM.append(this.cardsContainer, $('.welcome-prompts-card.welcome-prompts-migration-card'));

		const cardHeader = DOM.append(migrationCard, $('.welcome-prompts-card-header'));
		const iconEl = DOM.append(cardHeader, $('.welcome-prompts-card-icon'));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.sync));
		const labelEl = DOM.append(cardHeader, $('span.welcome-prompts-card-label'));
		labelEl.textContent = category.label;

		const descEl = DOM.append(migrationCard, $('p.welcome-prompts-card-description'));
		descEl.textContent = category.description;

		const footer = DOM.append(migrationCard, $('.welcome-prompts-card-footer'));
		const migrateBtn = DOM.append(footer, $('button.welcome-prompts-card-action'));
		migrateBtn.textContent = category.actionLabel;
		migrateBtn.setAttribute('aria-label', category.actionAriaLabel);
		if (!this.firstCard) {
			this.firstCard = migrateBtn;
		}
		this.cardDisposables.add(DOM.addDisposableListener(migrateBtn, 'click', () => this.callbacks.migrateCustomizations(category.id)));
	}

	focus(): void {
		// Focus the first focusable card so focus stays inside the welcome page
		// rather than escaping to the surrounding workbench editor.
		this.firstCard?.focus();
	}
}
