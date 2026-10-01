/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, Dimension, addDisposableListener, append, clearNode, reset } from '../../../../base/browser/dom.js';
import { renderFormattedText } from '../../../../base/browser/formattedTextRenderer.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { renderLabelWithIcons } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Toggle } from '../../../../base/browser/ui/toggle/toggle.js';
import { coalesce, equals } from '../../../../base/common/arrays.js';
import { Delayer, Throttler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILink, LinkedText } from '../../../../base/common/linkedText.js';
import { parse } from '../../../../base/common/marshalling.js';
import { Schemas, matchesScheme } from '../../../../base/common/network.js';
import { OS } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { assertReturnsDefined } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import './media/gettingStarted.css';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { localize } from '../../../../nls.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IUserDataSyncService } from '../../../../platform/userDataSync/common/userDataSync.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Link } from '../../../../platform/opener/browser/link.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService, TelemetryLevel } from '../../../../platform/telemetry/common/telemetry.js';
import { getTelemetryLevel } from '../../../../platform/telemetry/common/telemetryUtils.js';
import { defaultButtonStyles, defaultKeybindingLabelStyles, defaultToggleStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkspaceContextService, UNKNOWN_EMPTY_WINDOW_WORKSPACE } from '../../../../platform/workspace/common/workspace.js';
import { OpenFileFolderAction, OpenFolderAction, OpenFolderViaWorkspaceAction } from '../../../browser/actions/workspaceActions.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { WorkbenchStateContext } from '../../../common/contextkeys.js';
import { IEditorOpenContext, IEditorSerializer } from '../../../common/editor.js';
import { IWebviewElement, IWebviewService } from '../../webview/browser/webview.js';
import './gettingStartedColors.js';
import { GettingStartedDetailsRenderer } from './gettingStartedDetailsRenderer.js';
import { PiCodeSetup, renderPiCodeSetup } from './picodeSetup.js';
import { gettingStartedCheckedCodicon, gettingStartedUncheckedCodicon } from './gettingStartedIcons.js';
import { GettingStartedEditorOptions, GettingStartedInput } from './gettingStartedInput.js';
import { IResolvedWalkthrough, IResolvedWalkthroughStep, IWalkthroughsService, hiddenEntriesConfigurationKey, parseDescription } from './gettingStartedService.js';
import { RestoreWalkthroughsConfigurationValue, restoreWalkthroughsConfigurationKey } from './startupPage.js';
import { GroupsOrder, IEditorGroup, IEditorGroupsService, preferredSideBySideGroupDirection } from '../../../services/editor/common/editorGroupsService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { canShowAgentsBanner, createAgentsBanner } from '../../chat/browser/agentSessions/agentSessionsBanner.js';
import { IChatEntitlementService } from '../../../services/chat/common/chatEntitlementService.js';
import { AccessibilityVerbositySettingId } from '../../accessibility/browser/accessibilityConfiguration.js';
import { AccessibleViewAction } from '../../accessibility/browser/accessibleViewActions.js';
import { KeybindingLabel } from '../../../../base/browser/ui/keybindingLabel/keybindingLabel.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';

const SLIDE_TRANSITION_TIME_MS = 250;
const configurationKey = 'workbench.startupEditor';

export const inWelcomeContext = new RawContextKey<boolean>('inWelcome', false);

type GettingStartedActionClassification = {
	command: { classification: 'PublicNonPersonalData'; purpose: 'FeatureInsight'; comment: 'The command being executed on the getting started page.' };
	walkthroughId: { classification: 'PublicNonPersonalData'; purpose: 'FeatureInsight'; comment: 'The walkthrough which the command is in' };
	argument: { classification: 'PublicNonPersonalData'; purpose: 'FeatureInsight'; comment: 'The arguments being passed to the command' };
	owner: 'lramos15';
	comment: 'Help understand what actions are most commonly taken on the getting started page';
};

type GettingStartedActionEvent = {
	command: string;
	walkthroughId: string | undefined;
	argument: string | undefined;
};

const REDUCED_MOTION_KEY = 'workbench.welcomePage.preferReducedMotion';

/** The setup facts the connector answers with (`picode.setup.getState`). */
/** The sentence an error carries, whatever threw it. */
/**
 * PiCode's mark, drawn as strokes, in the colors of the theme.
 *
 * Inlined in the DOM rather than loaded as an image for the same reason the editor's empty
 * watermark is a stroke drawing: a plated logo at this size reads as a dark block, and an
 * image with a fixed stroke color cannot follow the theme. The body strokes are
 * `currentColor` (the theme's foreground), and the accents keep PiCode's own blue on every
 * theme. No background: only the silhouette is drawn.
 */
function buildProductLogo(): HTMLElement {
	const SVG_NS = 'http://www.w3.org/2000/svg';
	const ACCENT = '#3B9BFF';

	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 1024 1024');
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('product-logo-svg');

	const group = document.createElementNS(SVG_NS, 'g');
	group.setAttribute('transform', 'translate(0,92)');
	group.setAttribute('fill', 'none');
	group.setAttribute('stroke', 'currentColor');
	group.setAttribute('stroke-width', '84');
	group.setAttribute('stroke-linecap', 'round');
	group.setAttribute('stroke-linejoin', 'round');

	const path = (d: string, width: number, color: string) => {
		const p = document.createElementNS(SVG_NS, 'path');
		p.setAttribute('d', d);
		p.setAttribute('stroke-width', String(width));
		if (color !== 'currentColor') { p.setAttribute('stroke', color); }
		group.appendChild(p);
	};
	const dot = (cx: number, cy: number, r: number, color: string) => {
		const c = document.createElementNS(SVG_NS, 'circle');
		c.setAttribute('cx', String(cx));
		c.setAttribute('cy', String(cy));
		c.setAttribute('r', String(r));
		c.setAttribute('fill', color);
		// The group carries the stroke, and the dots of the mark are fills: without an explicit
		// `none` they would inherit the group's 84-unit stroke and render as blobs (the eyes
		// became the whole face). The source SVG says the same on every circle.
		c.setAttribute('stroke', 'none');
		group.appendChild(c);
	};

	path('M512 200 V152', 60, 'currentColor');
	dot(512, 112, 48, ACCENT);
	path('M360 640 V262 Q360 200 422 200 H602 Q664 200 664 262 V640', 84, 'currentColor');
	path('M268 432 H756', 84, 'currentColor');
	dot(452, 316, 34, ACCENT);
	dot(572, 316, 34, ACCENT);
	path('M424 590 L360 660 L424 730', 84, ACCENT);
	path('M600 590 L664 660 L600 730', 84, ACCENT);

	svg.appendChild(group);
	const container = $('div.product-logo');
	container.appendChild(svg);
	return container;
}

export class GettingStartedPage extends EditorPane {

	public static readonly ID = 'gettingStartedPage';

	private inProgressScroll = Promise.resolve();

	private readonly dispatchListeners: DisposableStore = new DisposableStore();
	private readonly stepDisposables: DisposableStore = new DisposableStore();
	private readonly detailsPageDisposables: DisposableStore = new DisposableStore();
	private readonly mediaDisposables: DisposableStore = new DisposableStore();

	// Ensure that the these are initialized before use.
	// Currently initialized before use in buildCategoriesSlide and scrollToCategory
	private gettingStartedCategories!: IResolvedWalkthrough[];

	private currentWalkthrough: IResolvedWalkthrough | undefined;
	private prevWalkthrough: IResolvedWalkthrough | undefined;

	private categoriesPageScrollbar: DomScrollableElement | undefined;
	private detailsPageScrollbar: DomScrollableElement | undefined;

	private readonly detailsScrollbar = this._register(new MutableDisposable<DomScrollableElement>());

	private buildSlideThrottle = this._register(new Throttler());

	private container: HTMLElement;

	private contextService: IContextKeyService;

	private stepsSlide!: HTMLElement;
	private categoriesSlide!: HTMLElement;
	private stepsContent!: HTMLElement;
	private stepMediaComponent!: HTMLElement;
	private webview!: IWebviewElement;

	private layoutMarkdown: (() => void) | undefined;

	private detailsRenderer: GettingStartedDetailsRenderer;

	private readonly categoriesSlideDisposables: DisposableStore;

	/** The container the setup section renders into, kept so an action can re-render it. */
	private setupContainer: HTMLElement | undefined;
	/** The setup renderer's handle; disposed before the section is rendered again. */
	private setupRenderer: PiCodeSetup | undefined;

	get editorInput(): GettingStartedInput | undefined {
		return this._input as GettingStartedInput | undefined;
	}

	constructor(
		group: IEditorGroup,
		@ICommandService private readonly commandService: ICommandService,
	@IUserDataSyncService private readonly userDataSyncService: IUserDataSyncService,
		@IProductService private readonly productService: IProductService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IWalkthroughsService private readonly gettingStartedService: IWalkthroughsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ITelemetryService telemetryService: ITelemetryService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IFileService private readonly fileService: IFileService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IWorkbenchThemeService protected override readonly themeService: IWorkbenchThemeService,
		@IStorageService private storageService: IStorageService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IEditorGroupsService private readonly groupsService: IEditorGroupsService,
		@IContextKeyService contextService: IContextKeyService,
		@IHostService private readonly hostService: IHostService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
		@IExtensionResourceLoaderService private readonly extensionResourceLoaderService: IExtensionResourceLoaderService,
	) {

		super(GettingStartedPage.ID, group, telemetryService, themeService, storageService);

		this.container = $('.gettingStartedContainer',
			{
				role: 'document',
				tabindex: 0,
				'aria-label': localize('welcomeAriaLabel', "Overview of how to get up to speed with your editor.")
			});
		this.stepMediaComponent = $('.getting-started-media');
		this.stepMediaComponent.id = generateUuid();

		this.categoriesSlideDisposables = this._register(new DisposableStore());

		this.detailsRenderer = new GettingStartedDetailsRenderer(this.fileService, this.notificationService, this.extensionService, this.languageService);

		this.contextService = this._register(contextService.createScoped(this.container));
		inWelcomeContext.bindTo(this.contextService).set(true);

		this.gettingStartedCategories = this.gettingStartedService.getWalkthroughs();

		this._register(this.dispatchListeners);

		const rerender = () => {
			this.gettingStartedCategories = this.gettingStartedService.getWalkthroughs();
			if (this.currentWalkthrough) {
				const existingSteps = this.currentWalkthrough.steps.map(step => step.id);
				const newCategory = this.gettingStartedCategories.find(category => this.currentWalkthrough?.id === category.id);
				if (newCategory) {
					const newSteps = newCategory.steps.map(step => step.id);
					if (!equals(newSteps, existingSteps)) {
						this.buildSlideThrottle.queue(() => this.buildCategoriesSlide());
					}
				}
			} else {
				this.buildSlideThrottle.queue(() => this.buildCategoriesSlide());
			}
		};

		this._register(this.gettingStartedService.onDidAddWalkthrough(rerender));
		this._register(this.gettingStartedService.onDidRemoveWalkthrough(rerender));

		this._register(this.gettingStartedService.onDidChangeWalkthrough(category => {
			const ourCategory = this.gettingStartedCategories.find(c => c.id === category.id);
			if (!ourCategory) { return; }

			ourCategory.title = category.title;
			ourCategory.description = category.description;

			// eslint-disable-next-line no-restricted-syntax
			this.container.querySelectorAll<HTMLDivElement>(`[x-category-title-for="${category.id}"]`).forEach(step => (step as HTMLDivElement).innerText = ourCategory.title);
			// eslint-disable-next-line no-restricted-syntax
			this.container.querySelectorAll<HTMLDivElement>(`[x-category-description-for="${category.id}"]`).forEach(step => (step as HTMLDivElement).innerText = ourCategory.description);
		}));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(REDUCED_MOTION_KEY)) {
				this.container.classList.toggle('animatable', this.shouldAnimate());
			}
		}));

		this._register(this.gettingStartedService.onDidProgressStep(step => {
			const category = this.gettingStartedCategories.find(c => c.id === step.category);
			if (!category) { throw Error('Could not find category with ID: ' + step.category); }
			const ourStep = category.steps.find(_step => _step.id === step.id);
			if (!ourStep) {
				throw Error('Could not find step with ID: ' + step.id);
			}

			const stats = this.getWalkthroughCompletionStats(category);
			if (!ourStep.done && stats.stepsComplete === stats.stepsTotal - 1) {
				this.hideCategory(category.id);
			}

			ourStep.done = step.done;

			if (category.id === this.currentWalkthrough?.id) {
				// eslint-disable-next-line no-restricted-syntax
				const badgeelements = assertReturnsDefined(this.window.document.querySelectorAll(`[data-done-step-id="${step.id}"]`));
				badgeelements.forEach(badgeelement => {
					if (step.done) {
						badgeelement.setAttribute('aria-checked', 'true');
						badgeelement.parentElement?.setAttribute('aria-checked', 'true');
						badgeelement.classList.remove(...ThemeIcon.asClassNameArray(gettingStartedUncheckedCodicon));
						badgeelement.classList.add('complete', ...ThemeIcon.asClassNameArray(gettingStartedCheckedCodicon));
						badgeelement.setAttribute('aria-label', localize('stepDone', "{0}: Completed", step.title));
					}
					else {
						badgeelement.setAttribute('aria-checked', 'false');
						badgeelement.parentElement?.setAttribute('aria-checked', 'false');
						badgeelement.classList.remove('complete', ...ThemeIcon.asClassNameArray(gettingStartedCheckedCodicon));
						badgeelement.classList.add(...ThemeIcon.asClassNameArray(gettingStartedUncheckedCodicon));
						badgeelement.setAttribute('aria-label', localize('stepNotDone', "{0}: Not completed", step.title));
					}
				});
				if (step.done) {
					status(localize('stepAutoCompleted', "Step {0} completed", step.title));
				}
			}
			this.updateCategoryProgress();
		}));

		this._register(this.storageService.onWillSaveState((e) => {
			if (e.reason !== WillSaveStateReason.SHUTDOWN) {
				return;
			}

			if (this.workspaceContextService.getWorkspace().folders.length !== 0) {
				return;
			}

			if (!this.editorInput || !this.currentWalkthrough || !this.editorInput.selectedCategory || !this.editorInput.selectedStep) {
				return;
			}

			const editorPane = this.groupsService.activeGroup.activeEditorPane;
			if (!(editorPane instanceof GettingStartedPage)) {
				return;
			}

			// Save the state of the walkthrough so we can restore it on reload
			const restoreData: RestoreWalkthroughsConfigurationValue = { folder: UNKNOWN_EMPTY_WINDOW_WORKSPACE.id, category: this.editorInput.selectedCategory, step: this.editorInput.selectedStep };
			this.storageService.store(
				restoreWalkthroughsConfigurationKey,
				JSON.stringify(restoreData),
				StorageScope.PROFILE, StorageTarget.MACHINE);
		}));
	}

	// remove when 'workbench.welcomePage.preferReducedMotion' deprecated
	private shouldAnimate() {
		if (this.configurationService.getValue(REDUCED_MOTION_KEY)) {
			return false;
		}
		if (this.accessibilityService.isMotionReduced()) {
			return false;
		}
		return true;
	}

	private getWalkthroughCompletionStats(walkthrough: IResolvedWalkthrough): { stepsComplete: number; stepsTotal: number } {
		const activeSteps = walkthrough.steps.filter(s => this.contextService.contextMatchesRules(s.when));
		return {
			stepsComplete: activeSteps.filter(s => s.done).length,
			stepsTotal: activeSteps.length,
		};
	}

	override async setInput(newInput: GettingStartedInput, options: GettingStartedEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken) {
		await super.setInput(newInput, options, context, token);
		const selectedCategory = options?.selectedCategory ?? newInput.selectedCategory;
		const selectedStep = options?.selectedStep ?? newInput.selectedStep;
		await this.applyInput({ ...options, selectedCategory, selectedStep });
	}

	override async setOptions(options: GettingStartedEditorOptions | undefined): Promise<void> {
		super.setOptions(options);
		if (!this.editorInput) {
			return;
		}

		if (
			this.editorInput.selectedCategory !== options?.selectedCategory ||
			this.editorInput.selectedStep !== options?.selectedStep
		) {
			await this.applyInput(options);
		}
	}

	private async applyInput(options: GettingStartedEditorOptions | undefined): Promise<void> {
		if (!this.editorInput) {
			return;
		}
		this.editorInput.showTelemetryNotice = options?.showTelemetryNotice ?? true;
		this.editorInput.selectedCategory = options?.selectedCategory;
		this.editorInput.selectedStep = options?.selectedStep;
		this.editorInput.returnToCommand = options?.returnToCommand;

		this.container.classList.remove('animatable');
		await this.buildCategoriesSlide(options?.preserveFocus);
		if (this.shouldAnimate()) {
			setTimeout(() => this.container.classList.add('animatable'), 0);
		}
	}

	async makeCategoryVisibleWhenAvailable(categoryID: string, stepId?: string) {
		this.scrollToCategory(categoryID, stepId);
	}

	private registerDispatchListeners() {
		this.dispatchListeners.clear();

		// eslint-disable-next-line no-restricted-syntax
		this.container.querySelectorAll('[x-dispatch]').forEach(element => {
			const dispatch = element.getAttribute('x-dispatch') ?? '';
			let command, argument;
			if (dispatch.startsWith('openLink:https')) {
				[command, argument] = ['openLink', dispatch.replace('openLink:', '')];
			} else {
				[command, argument] = dispatch.split(':');
			}
			if (command) {
				this.dispatchListeners.add(addDisposableListener(element, 'click', (e) => {
					e.stopPropagation();
					this.runDispatchCommand(command, argument);
				}));
				this.dispatchListeners.add(addDisposableListener(element, 'keyup', (e) => {
					const keyboardEvent = new StandardKeyboardEvent(e);
					e.stopPropagation();
					switch (keyboardEvent.keyCode) {
						case KeyCode.Enter:
						case KeyCode.Space:
							this.runDispatchCommand(command, argument);
							return;
					}
				}));
			}
		});
	}

	private async runDispatchCommand(command: string, argument: string) {
		this.commandService.executeCommand('workbench.action.keepEditor');
		this.telemetryService.publicLog2<GettingStartedActionEvent, GettingStartedActionClassification>('gettingStarted.ActionExecuted', { command, argument, walkthroughId: this.currentWalkthrough?.id });
		switch (command) {
			case 'scrollPrev': {
				this.scrollPrev();
				break;
			}
			case 'skip': {
				this.runSkip();
				break;
			}
			case 'openFolder': {
				if (this.contextService.contextMatchesRules(ContextKeyExpr.and(WorkbenchStateContext.isEqualTo('workspace')))) {
					this.commandService.executeCommand(OpenFolderViaWorkspaceAction.ID);
				} else {
					this.commandService.executeCommand('workbench.action.files.openFolder');
				}
				break;
			}
			case 'selectCategory': {
				this.telemetryService.publicLog2<GettingStartedActionEvent, GettingStartedActionClassification>('gettingStarted.ActionExecuted', { command: 'selectCategory', argument, walkthroughId: this.currentWalkthrough?.id });
				this.scrollToCategory(argument);
				this.gettingStartedService.markWalkthroughOpened(argument);
				break;
			}
			case 'hideCategory': {
				this.hideCategory(argument);
				break;
			}
			// Use selectTask over selectStep to keep telemetry consistant:https://github.com/microsoft/vscode/issues/122256
			case 'selectTask': {
				this.selectStep(argument);
				break;
			}
			case 'toggleStepCompletion': {
				this.toggleStepCompletion(argument);
				break;
			}
			case 'allDone': {
				this.markAllStepsComplete();
				break;
			}
			case 'nextSection': {
				const next = this.currentWalkthrough?.next;
				if (next) {
					this.prevWalkthrough = this.currentWalkthrough;
					this.scrollToCategory(next);
				} else {
					console.error('Error scrolling to next section of', this.currentWalkthrough);
				}
				break;
			}
			case 'openLink': {
				this.openerService.open(argument);
				break;
			}
			default: {
				console.error('Dispatch to', command, argument, 'not defined');
				break;
			}
		}
	}

	private hideCategory(categoryId: string) {
		const selectedCategory = this.gettingStartedCategories.find(category => category.id === categoryId);
		if (!selectedCategory) { throw Error('Could not find category with ID ' + categoryId); }
		this.setHiddenCategories([...this.getHiddenCategories().add(categoryId)]);
	}

	private markAllStepsComplete() {
		if (this.currentWalkthrough) {
			this.currentWalkthrough?.steps.forEach(step => {
				if (!step.done) {
					this.gettingStartedService.progressStep(step.id);
				}
			});
			this.hideCategory(this.currentWalkthrough?.id);
			this.scrollPrev();
		} else {
			throw Error('No walkthrough opened');
		}
	}

	private toggleStepCompletion(argument: string) {
		const stepToggle = assertReturnsDefined(this.currentWalkthrough?.steps.find(step => step.id === argument));
		if (stepToggle.done) {
			this.gettingStartedService.deprogressStep(argument);
		} else {
			this.gettingStartedService.progressStep(argument);
		}
	}

	private getHiddenCategories(): Set<string> {
		return new Set(JSON.parse(this.storageService.get(hiddenEntriesConfigurationKey, StorageScope.PROFILE, '[]')));
	}

	private setHiddenCategories(hidden: string[]) {
		this.storageService.store(
			hiddenEntriesConfigurationKey,
			JSON.stringify(hidden),
			StorageScope.PROFILE,
			StorageTarget.USER);
	}

	private currentMediaComponent: string | undefined = undefined;
	private currentMediaType: string | undefined = undefined;
	private async buildMediaComponent(stepId: string, forceRebuild: boolean = false) {
		if (!this.currentWalkthrough) {
			throw Error('no walkthrough selected');
		}
		const stepToExpand = assertReturnsDefined(this.currentWalkthrough.steps.find(step => step.id === stepId));

		if (!forceRebuild && this.currentMediaComponent === stepId) { return; }
		this.currentMediaComponent = stepId;

		this.stepDisposables.clear();

		this.stepDisposables.add({
			dispose: () => {
				this.currentMediaComponent = undefined;
			}
		});

		if (this.currentMediaType !== stepToExpand.media.type) {
			this.mediaDisposables.clear();

			this.currentMediaType = stepToExpand.media.type;

			this.mediaDisposables.add(toDisposable(() => {
				this.currentMediaType = undefined;
			}));

			clearNode(this.stepMediaComponent);

			if (stepToExpand.media.type === 'svg') {
				this.webview = this.mediaDisposables.add(this.webviewService.createWebviewElement({ title: undefined, options: { disableServiceWorker: true }, contentOptions: {}, extension: undefined }));
				this.webview.mountTo(this.stepMediaComponent, this.window);
			} else if (stepToExpand.media.type === 'markdown') {
				this.webview = this.mediaDisposables.add(this.webviewService.createWebviewElement({ options: {}, contentOptions: { localResourceRoots: [stepToExpand.media.root], allowScripts: true }, title: '', extension: undefined }));
				this.webview.mountTo(this.stepMediaComponent, this.window);
			} else if (stepToExpand.media.type === 'video') {
				this.webview = this.mediaDisposables.add(this.webviewService.createWebviewElement({ options: {}, contentOptions: { localResourceRoots: [stepToExpand.media.root], allowScripts: true }, title: '', extension: undefined }));
				this.webview.mountTo(this.stepMediaComponent, this.window);
			}
		}

		if (stepToExpand.media.type === 'image') {

			this.stepsContent.classList.add('image');
			this.stepsContent.classList.remove('markdown');
			this.stepsContent.classList.remove('video');

			const media = stepToExpand.media;
			const mediaElement = $<HTMLImageElement>('img');
			clearNode(this.stepMediaComponent);
			this.stepMediaComponent.appendChild(mediaElement);
			mediaElement.setAttribute('alt', media.altText);
			this.updateMediaSourceForColorMode(mediaElement, media.path);

			this.stepDisposables.add(addDisposableListener(this.stepMediaComponent, 'click', () => {
				const hrefs = stepToExpand.description.map(lt => lt.nodes.filter((node): node is ILink => typeof node !== 'string').map(node => node.href)).flat();
				if (hrefs.length === 1) {
					const href = hrefs[0];
					if (href.startsWith('http')) {
						this.telemetryService.publicLog2<GettingStartedActionEvent, GettingStartedActionClassification>('gettingStarted.ActionExecuted', { command: 'runStepAction', argument: href, walkthroughId: this.currentWalkthrough?.id });
						this.openerService.open(href);
					}
				}
			}));

			this.stepDisposables.add(this.themeService.onDidColorThemeChange(() => this.updateMediaSourceForColorMode(mediaElement, media.path)));

		}
		else if (stepToExpand.media.type === 'svg') {
			this.stepsContent.classList.add('image');
			this.stepsContent.classList.remove('markdown');
			this.stepsContent.classList.remove('video');

			const media = stepToExpand.media;
			this.webview.setHtml(await this.detailsRenderer.renderSVG(media.path));

			let isDisposed = false;
			this.stepDisposables.add(toDisposable(() => { isDisposed = true; }));

			this.stepDisposables.add(this.themeService.onDidColorThemeChange(async () => {
				// Render again since color vars change
				const body = await this.detailsRenderer.renderSVG(media.path);
				if (!isDisposed) { // Make sure we weren't disposed of in the meantime
					this.webview.setHtml(body);
				}
			}));

			this.stepDisposables.add(addDisposableListener(this.stepMediaComponent, 'click', () => {
				const hrefs = stepToExpand.description.map(lt => lt.nodes.filter((node): node is ILink => typeof node !== 'string').map(node => node.href)).flat();
				if (hrefs.length === 1) {
					const href = hrefs[0];
					if (href.startsWith('http')) {
						this.telemetryService.publicLog2<GettingStartedActionEvent, GettingStartedActionClassification>('gettingStarted.ActionExecuted', { command: 'runStepAction', argument: href, walkthroughId: this.currentWalkthrough?.id });
						this.openerService.open(href);
					}
				}
			}));

			this.stepDisposables.add(this.webview.onDidClickLink(link => {
				if (matchesScheme(link, Schemas.https) || matchesScheme(link, Schemas.http) || (matchesScheme(link, Schemas.command))) {
					this.openerService.open(link, { allowCommands: true });
				}
			}));

		}
		else if (stepToExpand.media.type === 'markdown') {

			this.stepsContent.classList.remove('image');
			this.stepsContent.classList.add('markdown');
			this.stepsContent.classList.remove('video');

			const media = stepToExpand.media;

			const rawHTML = await this.detailsRenderer.renderMarkdown(media.path, media.base);
			this.webview.setHtml(rawHTML);

			const serializedContextKeyExprs = rawHTML.match(/checked-on=\"([^'][^"]*)\"/g)?.map(attr => attr.slice('checked-on="'.length, -1)
				.replace(/&#39;/g, '\'')
				.replace(/&amp;/g, '&'));

			const postTrueKeysMessage = () => {
				const enabledContextKeys = serializedContextKeyExprs?.filter(expr => this.contextService.contextMatchesRules(ContextKeyExpr.deserialize(expr)));
				if (enabledContextKeys) {
					this.webview.postMessage({
						enabledContextKeys
					});
				}
			};

			if (serializedContextKeyExprs) {
				const contextKeyExprs = coalesce(serializedContextKeyExprs.map(expr => ContextKeyExpr.deserialize(expr)));
				const watchingKeys = new Set(contextKeyExprs.flatMap(expr => expr.keys()));

				this.stepDisposables.add(this.contextService.onDidChangeContext(e => {
					if (e.affectsSome(watchingKeys)) { postTrueKeysMessage(); }
				}));
			}

			let isDisposed = false;
			this.stepDisposables.add(toDisposable(() => { isDisposed = true; }));

			this.stepDisposables.add(this.webview.onDidClickLink(link => {
				if (matchesScheme(link, Schemas.https) || matchesScheme(link, Schemas.http) || (matchesScheme(link, Schemas.command))) {
					const toSide = link.startsWith('command:toSide:');
					if (toSide) {
						link = link.replace('command:toSide:', 'command:');
						this.focusSideEditorGroup();
					}
					this.openerService.open(link, { allowCommands: true, openToSide: toSide });
				}
			}));

			if (rawHTML.indexOf('<code>') >= 0) {
				// Render again when Theme changes since syntax highlighting of code blocks may have changed
				this.stepDisposables.add(this.themeService.onDidColorThemeChange(async () => {
					const body = await this.detailsRenderer.renderMarkdown(media.path, media.base);
					if (!isDisposed) { // Make sure we weren't disposed of in the meantime
						this.webview.setHtml(body);
						postTrueKeysMessage();
					}
				}));
			}

			const layoutDelayer = new Delayer(50);

			this.layoutMarkdown = () => {
				layoutDelayer.trigger(() => {
					this.webview.postMessage({ layoutMeNow: true });
				});
			};

			this.stepDisposables.add(layoutDelayer);
			this.stepDisposables.add({ dispose: () => this.layoutMarkdown = undefined });

			postTrueKeysMessage();

			this.stepDisposables.add(this.webview.onMessage(async e => {
				const message: string = e.message as string;
				if (message.startsWith('command:')) {
					this.openerService.open(message, { allowCommands: true });
				} else if (message.startsWith('setTheme:')) {
					const themeId = message.slice('setTheme:'.length);
					const theme = (await this.themeService.getColorThemes()).find(theme => theme.settingsId === themeId);
					if (theme) {
						this.themeService.setColorTheme(theme.id, ConfigurationTarget.USER);
					}
				} else {
					console.error('Unexpected message', message);
				}
			}));
		}
		else if (stepToExpand.media.type === 'video') {
			this.stepsContent.classList.add('video');
			this.stepsContent.classList.remove('markdown');
			this.stepsContent.classList.remove('image');

			const media = stepToExpand.media;

			const themeType = this.themeService.getColorTheme().type;
			const videoPath = media.path[themeType];
			const videoPoster = media.poster ? media.poster[themeType] : undefined;
			const altText = media.altText ? media.altText : localize('videoAltText', "Video for {0}", stepToExpand.title);
			const rawHTML = await this.detailsRenderer.renderVideo(videoPath, videoPoster, altText);
			this.webview.setHtml(rawHTML);

			let isDisposed = false;
			this.stepDisposables.add(toDisposable(() => { isDisposed = true; }));

			this.stepDisposables.add(this.themeService.onDidColorThemeChange(async () => {
				// Render again since color vars change
				const themeType = this.themeService.getColorTheme().type;
				const videoPath = media.path[themeType];
				const videoPoster = media.poster ? media.poster[themeType] : undefined;
				const body = await this.detailsRenderer.renderVideo(videoPath, videoPoster, altText);

				if (!isDisposed) { // Make sure we weren't disposed of in the meantime
					this.webview.setHtml(body);
				}
			}));
		}
	}

	async selectStepLoose(id: string) {
		if (!this.editorInput) {
			return;
		}
		// Allow passing in id with a category appended or with just the id of the step
		if (id.startsWith(`${this.editorInput.selectedCategory}#`)) {
			this.selectStep(id);
		} else {
			const toSelect = this.editorInput.selectedCategory + '#' + id;
			this.selectStep(toSelect);
		}
	}

	private provideScreenReaderUpdate(): string {
		if (this.configurationService.getValue(AccessibilityVerbositySettingId.Walkthrough)) {
			const kbLabel = this.keybindingService.lookupKeybinding(AccessibleViewAction.id)?.getAriaLabel();
			return kbLabel ? localize('acessibleViewHint', "Inspect this in the accessible view ({0}).\n", kbLabel) : localize('acessibleViewHintNoKbOpen', "Inspect this in the accessible view via the command Open Accessible View which is currently not triggerable via keybinding.\n");
		}
		return '';
	}

	private async selectStep(id: string | undefined, delayFocus = true, preserveFocus?: boolean) {
		if (!this.editorInput) {
			return;
		}
		if (id) {
			// eslint-disable-next-line no-restricted-syntax
			let stepElement = this.container.querySelector<HTMLDivElement>(`[data-step-id="${id}"]`);
			if (!stepElement) {
				// Selected an element that is not in-context, just fallback to whatever.
				// eslint-disable-next-line no-restricted-syntax
				stepElement = this.container.querySelector<HTMLDivElement>(`[data-step-id]`);
				if (!stepElement) {
					// No steps around... just ignore.
					return;
				}
				id = assertReturnsDefined(stepElement.getAttribute('data-step-id'));
			}
			// eslint-disable-next-line no-restricted-syntax
			stepElement.parentElement?.querySelectorAll<HTMLElement>('.expanded').forEach(node => {
				if (node.getAttribute('data-step-id') !== id) {
					node.classList.remove('expanded');
					node.setAttribute('aria-expanded', 'false');
					// eslint-disable-next-line no-restricted-syntax
					const codiconElement = node.querySelector('.codicon');
					if (codiconElement) {
						codiconElement.removeAttribute('tabindex');
					}
				}
			});
			if (!preserveFocus) {
				setTimeout(() => (stepElement as HTMLElement).focus(), delayFocus && this.shouldAnimate() ? SLIDE_TRANSITION_TIME_MS : 0);
			}

			this.editorInput.selectedStep = id;

			stepElement.classList.add('expanded');
			stepElement.setAttribute('aria-expanded', 'true');
			this.buildMediaComponent(id, true);
			// eslint-disable-next-line no-restricted-syntax
			const codiconElement = stepElement.querySelector('.codicon');
			if (codiconElement) {
				codiconElement.setAttribute('tabindex', '0');
			}
			this.gettingStartedService.progressByEvent('stepSelected:' + id);
			const step = this.currentWalkthrough?.steps?.find(step => step.id === id);
			if (step) {
				stepElement.setAttribute('aria-label', `${this.provideScreenReaderUpdate()} ${step.title}`);
			}
		} else {
			this.editorInput.selectedStep = undefined;
		}

		this.detailsPageScrollbar?.scanDomNode();
		this.detailsScrollbar.value?.scanDomNode();
	}

	private updateMediaSourceForColorMode(element: HTMLImageElement, sources: { hcDark: URI; hcLight: URI; dark: URI; light: URI }) {
		const themeType = this.themeService.getColorTheme().type;
		const src = sources[themeType].toString(true).replace(/ /g, '%20');
		element.srcset = src.toLowerCase().endsWith('.svg') ? src : (src + ' 1.5x');
	}

	protected createEditor(parent: HTMLElement) {
		if (this.detailsPageScrollbar) { this.detailsPageScrollbar.dispose(); }
		if (this.categoriesPageScrollbar) { this.categoriesPageScrollbar.dispose(); }

		this.categoriesSlide = $('.gettingStartedSlideCategories.gettingStartedSlide');

		const prevButton = $('button.prev-button.button-link', { 'x-dispatch': 'scrollPrev' }, $('span.scroll-button.codicon.codicon-chevron-left'), $('span.moreText', {}, localize('goBack', "Go Back")));
		this.stepsSlide = $('.gettingStartedSlideDetails.gettingStartedSlide', {}, prevButton);

		this.stepsContent = $('.gettingStartedDetailsContent', {});

		this.detailsPageScrollbar = this._register(new DomScrollableElement(this.stepsContent, { className: 'full-height-scrollable', vertical: ScrollbarVisibility.Hidden }));
		this.categoriesPageScrollbar = this._register(new DomScrollableElement(this.categoriesSlide, { className: 'full-height-scrollable categoriesScrollbar', vertical: ScrollbarVisibility.Hidden }));

		this.stepsSlide.appendChild(this.detailsPageScrollbar.getDomNode());

		const gettingStartedPage = $('.gettingStarted', {}, this.categoriesPageScrollbar.getDomNode(), this.stepsSlide);
		this.container.appendChild(gettingStartedPage);

		this.categoriesPageScrollbar.scanDomNode();
		this.detailsPageScrollbar.scanDomNode();

		parent.appendChild(this.container);
	}

	private async buildCategoriesSlide(preserveFocus?: boolean) {

		this.categoriesSlideDisposables.clear();
		const showOnStartupCheckbox = new Toggle({
			icon: Codicon.check,
			actionClassName: 'getting-started-checkbox',
			isChecked: this.configurationService.getValue(configurationKey) === 'welcomePage',
			title: localize('checkboxTitle', "When checked, this page will be shown on startup."),
			...defaultToggleStyles
		});
		showOnStartupCheckbox.domNode.id = 'showOnStartup';
		const showOnStartupLabel = $('label.caption', { for: 'showOnStartup' }, localize('welcomePage.showOnStartup', "Show welcome page on startup"));
		const onShowOnStartupChanged = () => {
			if (showOnStartupCheckbox.checked) {
				this.telemetryService.publicLog2<GettingStartedActionEvent, GettingStartedActionClassification>('gettingStarted.ActionExecuted', { command: 'showOnStartupChecked', argument: undefined, walkthroughId: this.currentWalkthrough?.id });
				this.configurationService.updateValue(configurationKey, 'welcomePage');
			} else {
				this.telemetryService.publicLog2<GettingStartedActionEvent, GettingStartedActionClassification>('gettingStarted.ActionExecuted', { command: 'showOnStartupUnchecked', argument: undefined, walkthroughId: this.currentWalkthrough?.id });
				this.configurationService.updateValue(configurationKey, 'none');
			}
		};
		this.categoriesSlideDisposables.add(showOnStartupCheckbox);
		this.categoriesSlideDisposables.add(showOnStartupCheckbox.onChange(() => {
			onShowOnStartupChanged();
		}));
		this.categoriesSlideDisposables.add(addDisposableListener(showOnStartupLabel, 'click', () => {
			showOnStartupCheckbox.checked = !showOnStartupCheckbox.checked;
			onShowOnStartupChanged();
		}));

		const header = $('.header', {},
			buildProductLogo(),
			$('h1.product-name.caption', {}, this.productService.nameLong),
			$('p.subtitle.description', {}, localize({ key: 'gettingStarted.editingEvolved', comment: ['Shown as subtitle on the Welcome page.'] }, "Editing evolved"))
		);

		// PiCode's welcome is its own, not the inherited start page: the agent is built in, so
		// the page carries the setup itself — the same window, no popups — and the way into a folder.
		const setupContainer = this.setupContainer = $('div.setup-section');
		const welcomeColumn = $('.categories-column.categories-column-left', {},
			$('p.welcome-intro.description', {}, localize('welcome.intro', "PiCode is your editor and your coding agent in one: pi, Gentle AI, your providers and your themes are all part of it. Set up once and start working — you can change any of this later.")),
			setupContainer,
			$('ul.welcome-actions', {},
				this.welcomeAction('openFolder', 'folder', localize('welcome.openFolder', "Open Folder"), undefined),
			)
		);

		const footerChildren: HTMLElement[] = [];
		if (canShowAgentsBanner(this.chatEntitlementService)) {
			const agentsBanner = createAgentsBanner(
				{
					cssClass: 'getting-started-category.agents-banner',
					source: 'welcomePage',
				},
				this.commandService,
				this.telemetryService,
			);
			this.categoriesSlideDisposables.add(agentsBanner.disposables);
			footerChildren.push(agentsBanner.element);
		}
		footerChildren.push($('p.showOnStartup', {},
			showOnStartupCheckbox.domNode,
			showOnStartupLabel,
		));

		const footer = $('.footer', {}, ...footerChildren);

		reset(this.categoriesSlide, $('.gettingStartedCategoriesContainer', {}, header, welcomeColumn, footer,));
		this.categoriesPageScrollbar?.scanDomNode();

		this.updateCategoryProgress();
		this.registerDispatchListeners();
		void this.renderSetupSection();

		const editorInput = this.editorInput;
		if (editorInput?.selectedCategory) {
			this.currentWalkthrough = this.gettingStartedCategories.find(category => category.id === editorInput.selectedCategory);

			if (!this.currentWalkthrough) {
				this.gettingStartedCategories = this.gettingStartedService.getWalkthroughs();
				this.currentWalkthrough = this.gettingStartedCategories.find(category => category.id === editorInput.selectedCategory);
				if (this.currentWalkthrough) {
					this.buildCategorySlide(editorInput.selectedCategory, editorInput.selectedStep, preserveFocus);
					this.setSlide('details');
					return;
				}
			}
			else {
				this.buildCategorySlide(editorInput.selectedCategory, editorInput.selectedStep, preserveFocus);
				this.setSlide('details');
				return;
			}
		}

		if (this.editorInput?.showTelemetryNotice && this.productService.openToWelcomeMainPage) {
			const telemetryNotice = $('p.telemetry-notice');
			this.buildTelemetryFooter(telemetryNotice);
			footer.appendChild(telemetryNotice);
		}

		this.setSlide('categories');
	}

	/** One row of the welcome column: what it does, and one line saying what it is. */
	private welcomeAction(dispatch: string, icon: string, label: string, detail: string | undefined): HTMLElement {
		const text = $('.welcome-action-text', {}, $('span.welcome-action-label', {}, label));
		if (detail !== undefined) {
			text.appendChild($('span.welcome-action-detail', {}, detail));
		}
		return $('li', {},
			$('button.welcome-action.button-link', { 'x-dispatch': dispatch, 'tabindex': 0, 'title': detail ?? label },
				$(`span.codicon.codicon-${icon}`),
				text,
			)
		);
	}

	/**
	 * The setup, rendered into the welcome page itself by its own module.
	 *
	 * The page owns the container and the lifecycle; `picodeSetup.ts` owns the cards, the
	 * facts they show and the calls they make. The previous handle is disposed before a new
	 * one is made, because this slide can be rebuilt at any time.
	 */
	private async renderSetupSection(): Promise<void> {
		if (this.setupContainer === undefined) { return; }
		this.setupRenderer?.dispose();
		this.setupRenderer = this._register(renderPiCodeSetup(this.setupContainer, {
			commandService: this.commandService,
			userDataSyncService: this.userDataSyncService,
			themeService: this.themeService,
			extensionResourceLoaderService: this.extensionResourceLoaderService,
		}));
		this.registerDispatchListeners();
	}

	layout(size: Dimension) {
		this.detailsScrollbar.value?.scanDomNode();

		this.categoriesPageScrollbar?.scanDomNode();
		this.detailsPageScrollbar?.scanDomNode();

		if (this.editorInput?.selectedStep && this.currentMediaType) {
			this.mediaDisposables.clear();
			this.stepDisposables.clear();
			this.buildMediaComponent(this.editorInput.selectedStep);
		}

		this.layoutMarkdown?.();

		this.container.classList.toggle('height-constrained', size.height <= 600);
		this.container.classList.toggle('width-constrained', size.width <= 400);
		this.container.classList.toggle('width-semi-constrained', size.width <= 950);

		this.categoriesPageScrollbar?.scanDomNode();
		this.detailsPageScrollbar?.scanDomNode();
		this.detailsScrollbar.value?.scanDomNode();
	}

	private updateCategoryProgress() {
		// eslint-disable-next-line no-restricted-syntax
		this.window.document.querySelectorAll('.category-progress').forEach(element => {
			const categoryID = element.getAttribute('x-data-category-id');
			const category = this.gettingStartedCategories.find(c => c.id === categoryID);
			if (!category) { return; }

			const stats = this.getWalkthroughCompletionStats(category);

			// eslint-disable-next-line no-restricted-syntax
			const bar = assertReturnsDefined(element.querySelector('.progress-bar-inner')) as HTMLDivElement;
			bar.setAttribute('aria-valuemin', '0');
			bar.setAttribute('aria-valuenow', '' + stats.stepsComplete);
			bar.setAttribute('aria-valuemax', '' + stats.stepsTotal);
			const progress = (stats.stepsComplete / stats.stepsTotal) * 100;
			bar.style.width = `${progress}%`;

			(element.parentElement as HTMLElement).classList.toggle('no-progress', stats.stepsComplete === 0);

			if (stats.stepsTotal === stats.stepsComplete) {
				bar.title = localize('gettingStarted.allStepsComplete', "All {0} steps complete!", stats.stepsComplete);
			}
			else {
				bar.title = localize('gettingStarted.someStepsComplete', "{0} of {1} steps complete", stats.stepsComplete, stats.stepsTotal);
			}
		});
	}

	private async scrollToCategory(categoryID: string, stepId?: string) {

		if (!this.gettingStartedCategories.some(c => c.id === categoryID)) {
			this.gettingStartedCategories = this.gettingStartedService.getWalkthroughs();
		}

		const ourCategory = this.gettingStartedCategories.find(c => c.id === categoryID);
		if (!ourCategory) {
			throw Error('Could not find category with ID: ' + categoryID);
		}

		this.inProgressScroll = this.inProgressScroll.then(async () => {
			if (!this.editorInput) {
				return;
			}
			reset(this.stepsContent);
			this.editorInput.selectedCategory = categoryID;
			this.editorInput.selectedStep = stepId;
			this.editorInput.walkthroughPageTitle = ourCategory.walkthroughPageTitle;
			this.currentWalkthrough = ourCategory;
			this.buildCategorySlide(categoryID, stepId);
			this.setSlide('details');
		});
	}

	private focusSideEditorGroup() {
		const fullSize = this.groupsService.getPart(this.group).contentDimension;
		if (!fullSize || fullSize.width <= 700 || this.container.classList.contains('width-constrained') || this.container.classList.contains('width-semi-constrained')) { return; }
		if (this.groupsService.count === 1) {
			const editorGroupSplitDirection = preferredSideBySideGroupDirection(this.configurationService);
			const sideGroup = this.groupsService.addGroup(this.groupsService.groups[0], editorGroupSplitDirection);
			this.groupsService.activateGroup(sideGroup);
		}

		const nonGettingStartedGroup = this.groupsService.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE).find(group => !(group.activeEditor instanceof GettingStartedInput));
		if (nonGettingStartedGroup) {
			this.groupsService.activateGroup(nonGettingStartedGroup);
			nonGettingStartedGroup.focus();
		}
	}
	private runStepCommand(href: string) {

		const isCommand = href.startsWith('command:');
		const toSide = href.startsWith('command:toSide:');
		const command = href.replace(/command:(toSide:)?/, 'command:');

		this.telemetryService.publicLog2<GettingStartedActionEvent, GettingStartedActionClassification>('gettingStarted.ActionExecuted', { command: 'runStepAction', argument: href, walkthroughId: this.currentWalkthrough?.id });

		if (toSide) {
			this.focusSideEditorGroup();
		}
		if (isCommand) {
			const commandURI = URI.parse(command);

			// execute as command
			let args = [];
			try {
				args = parse(decodeURIComponent(commandURI.query));
			} catch {
				// ignore and retry
				try {
					args = parse(commandURI.query);
				} catch {
					// ignore error
				}
			}
			if (!Array.isArray(args)) {
				args = [args];
			}

			// If a step is requesting the OpenFolder action to be executed in an empty workspace...
			if ((commandURI.path === OpenFileFolderAction.ID.toString() ||
				commandURI.path === OpenFolderAction.ID.toString()) &&
				this.workspaceContextService.getWorkspace().folders.length === 0) {

				const selectedStepIndex = this.currentWalkthrough?.steps.findIndex(step => step.id === this.editorInput?.selectedStep);

				// and there are a few more steps after this step which are yet to be completed...
				if (selectedStepIndex !== undefined &&
					selectedStepIndex > -1 &&
					this.currentWalkthrough?.steps.slice(selectedStepIndex + 1).some(step => !step.done)) {
					const restoreData: RestoreWalkthroughsConfigurationValue = { folder: UNKNOWN_EMPTY_WINDOW_WORKSPACE.id, category: this.editorInput?.selectedCategory, step: this.editorInput?.selectedStep };

					// save state to restore after reload
					this.storageService.store(
						restoreWalkthroughsConfigurationKey,
						JSON.stringify(restoreData),
						StorageScope.PROFILE, StorageTarget.MACHINE);
				}
			}

			this.commandService.executeCommand(commandURI.path, ...args).then(result => {
				const toOpen = (result as { openFolder?: URI })?.openFolder;
				if (toOpen) {
					if (!URI.isUri(toOpen)) {
						console.warn('Warn: Running walkthrough command', href, 'yielded non-URI `openFolder` result', toOpen, '. It will be disregarded.');
						return;
					}
					const restoreData: RestoreWalkthroughsConfigurationValue = { folder: toOpen.toString(), category: this.editorInput?.selectedCategory, step: this.editorInput?.selectedStep };
					this.storageService.store(
						restoreWalkthroughsConfigurationKey,
						JSON.stringify(restoreData),
						StorageScope.PROFILE, StorageTarget.MACHINE);
					this.hostService.openWindow([{ folderUri: toOpen }]);
				}
			});
		} else {
			this.openerService.open(command, { allowCommands: true });
		}

		if (!isCommand && (href.startsWith('https://') || href.startsWith('http://'))) {
			this.gettingStartedService.progressByEvent('onLink:' + href);
		}
	}

	private buildMarkdownDescription(container: HTMLElement, text: LinkedText[]) {
		while (container.firstChild) { container.firstChild.remove(); }

		for (const linkedText of text) {
			if (linkedText.nodes.length === 1 && typeof linkedText.nodes[0] !== 'string') {
				const node = linkedText.nodes[0];
				const buttonContainer = append(container, $('.button-container'));
				const button = new Button(buttonContainer, { title: node.title, supportIcons: true, ...defaultButtonStyles });

				const isCommand = node.href.startsWith('command:');
				const command = node.href.replace(/command:(toSide:)?/, 'command:');

				button.label = node.label;
				button.onDidClick(e => {
					e.stopPropagation();
					e.preventDefault();
					this.runStepCommand(node.href);
				}, null, this.detailsPageDisposables);

				if (isCommand) {
					const keybinding = this.getKeyBinding(command);
					if (keybinding) {
						const shortcutMessage = $('span.shortcut-message', {}, localize('gettingStarted.keyboardTip', 'Tip: Use keyboard shortcut '));
						container.appendChild(shortcutMessage);
						const label = new KeybindingLabel(shortcutMessage, OS, { ...defaultKeybindingLabelStyles });
						label.set(keybinding);
						this.detailsPageDisposables.add(label);
					}
				}

				this.detailsPageDisposables.add(button);
			} else {
				const p = append(container, $('p'));
				for (const node of linkedText.nodes) {
					if (typeof node === 'string') {
						const labelWithIcon = renderLabelWithIcons(node);
						for (const element of labelWithIcon) {
							if (typeof element === 'string') {
								p.appendChild(renderFormattedText(element, { renderCodeSegments: true }, $('span')));
							} else {
								p.appendChild(element);
							}
						}
					} else {
						const nodeWithTitle: ILink = matchesScheme(node.href, Schemas.http) || matchesScheme(node.href, Schemas.https) ? { ...node, title: node.href } : node;
						const link = this.instantiationService.createInstance(Link, p, nodeWithTitle, { opener: (href) => this.runStepCommand(href) });
						this.detailsPageDisposables.add(link);
					}
				}
			}
		}
		return container;
	}

	override clearInput() {
		this.stepDisposables.clear();
		super.clearInput();
	}

	private buildCategorySlide(categoryID: string, selectedStep?: string, preserveFocus?: boolean) {
		if (!this.editorInput) {
			return;
		}


		this.extensionService.whenInstalledExtensionsRegistered().then(() => {
			// Remove internal extension id specifier from exposed id's
			this.extensionService.activateByEvent(`onWalkthrough:${categoryID.replace(/[^#]+#/, '')}`);
		});

		this.detailsPageDisposables.clear();
		this.mediaDisposables.clear();

		const category = this.gettingStartedCategories.find(category => category.id === categoryID);
		if (!category) {
			throw Error('could not find category with ID ' + categoryID);
		}

		const descriptionContainer = $('.category-description.description.max-lines-3', { 'x-category-description-for': category.id });
		this.buildMarkdownDescription(descriptionContainer, parseDescription(category.description));

		const categoryDescriptorComponent =
			$('.getting-started-category',
				{},
				$('.category-description-container', {},
					$('h2.category-title.max-lines-3', { 'x-category-title-for': category.id }, ...renderLabelWithIcons(category.title)),
					descriptionContainer));

		const stepListContainer = $('.step-list-container');

		this.detailsPageDisposables.add(addDisposableListener(stepListContainer, 'keydown', (e) => {
			const event = new StandardKeyboardEvent(e);
			const currentStepIndex = () =>
				category.steps.findIndex(e => e.id === this.editorInput?.selectedStep);

			if (event.keyCode === KeyCode.UpArrow) {
				const toExpand = category.steps.filter((step, index) => index < currentStepIndex() && this.contextService.contextMatchesRules(step.when));
				if (toExpand.length) {
					this.selectStep(toExpand[toExpand.length - 1].id, false);
				}
			}
			if (event.keyCode === KeyCode.DownArrow) {
				const toExpand = category.steps.find((step, index) => index > currentStepIndex() && this.contextService.contextMatchesRules(step.when));
				if (toExpand) {
					this.selectStep(toExpand.id, false);
				}
			}
		}));

		let renderedSteps: IResolvedWalkthroughStep[] | undefined = undefined;

		const contextKeysToWatch = new Set(category.steps.flatMap(step => step.when.keys()));

		const buildStepList = () => {

			category.steps.sort((a, b) => a.order - b.order);
			const toRender = category.steps
				.filter(step => this.contextService.contextMatchesRules(step.when));

			if (equals(renderedSteps, toRender, (a, b) => a.id === b.id)) {
				return;
			}

			renderedSteps = toRender;

			reset(stepListContainer, ...renderedSteps
				.map(step => {
					const codicon = $('.codicon' + (step.done ? '.complete' + ThemeIcon.asCSSSelector(gettingStartedCheckedCodicon) : ThemeIcon.asCSSSelector(gettingStartedUncheckedCodicon)),
						{
							'data-done-step-id': step.id,
							'x-dispatch': 'toggleStepCompletion:' + step.id,
							'role': 'checkbox',
							'aria-checked': step.done ? 'true' : 'false',
							'aria-label': step.done
								? localize('stepDone', "{0}: Completed", step.title)
								: localize('stepNotDone', "{0}: Not completed", step.title),
						});

					const container = $('.step-description-container', { 'x-step-description-for': step.id });
					this.buildMarkdownDescription(container, step.description);

					const stepTitle = $('h3.step-title.max-lines-3', { 'x-step-title-for': step.id });
					reset(stepTitle, ...renderLabelWithIcons(step.title));

					const stepDescription = $('.step-container', {},
						stepTitle,
						container,
					);

					if (step.media.type === 'image') {
						stepDescription.appendChild(
							$('.image-description', { 'aria-label': localize('imageShowing', "Image showing {0}", step.media.altText) }),
						);
					} else if (step.media.type === 'video') {
						stepDescription.appendChild(
							$('.video-description', { 'aria-label': localize('videoShowing', "Video showing {0}", step.media.altText) }),
						);
					}

					return $('button.getting-started-step',
						{
							'x-dispatch': 'selectTask:' + step.id,
							'data-step-id': step.id,
							'aria-expanded': 'false',
							'aria-checked': step.done ? 'true' : 'false',
							'role': 'button',
						},
						codicon,
						stepDescription);
				}));
		};

		buildStepList();

		this.detailsPageDisposables.add(this.contextService.onDidChangeContext(e => {
			if (e.affectsSome(contextKeysToWatch) && this.currentWalkthrough && this.editorInput) {
				buildStepList();
				this.registerDispatchListeners();
				this.selectStep(this.editorInput.selectedStep, false);
			}
		}));

		const showNextCategory = this.gettingStartedCategories.find(_category => _category.id === category.next);

		const stepsContainer = $(
			'.getting-started-detail-container', { 'role': 'list' },
			stepListContainer,
			$('.done-next-container', {},
				$('button.button-link.all-done', { 'x-dispatch': 'allDone' }, $('span.codicon.codicon-check-all'), localize('allDone', "Mark Done")),
				...(showNextCategory
					? [$('button.button-link.next', { 'x-dispatch': 'nextSection' }, localize('nextOne', "Next Section"), $('span.codicon.codicon-arrow-right'))]
					: []),
			)
		);
		this.detailsScrollbar.value = new DomScrollableElement(stepsContainer, { className: 'steps-container' });
		const stepListComponent = this.detailsScrollbar.value.getDomNode();

		const categoryFooter = $('.getting-started-footer');
		if (this.editorInput.showTelemetryNotice && getTelemetryLevel(this.configurationService) !== TelemetryLevel.NONE && this.productService.enableTelemetry) {
			this.buildTelemetryFooter(categoryFooter);
		}

		reset(this.stepsContent, categoryDescriptorComponent, stepListComponent, this.stepMediaComponent, categoryFooter);

		const toExpand = category.steps.find(step => this.contextService.contextMatchesRules(step.when) && !step.done) ?? category.steps[0];
		this.selectStep(selectedStep ?? toExpand.id, !selectedStep, preserveFocus);

		this.detailsScrollbar.value?.scanDomNode();
		this.detailsPageScrollbar?.scanDomNode();

		this.registerDispatchListeners();
	}

	private buildTelemetryFooter(parent: HTMLElement) {
		const privacyStatementCopy = localize('privacy statement', "privacy statement");
		const privacyStatementButton = `[${privacyStatementCopy}](command:workbench.action.openPrivacyStatementUrl)`;

		const optOutCopy = localize('optOut', "opt out");
		const optOutButton = `[${optOutCopy}](command:settings.filterByTelemetry)`;

		const text = localize({ key: 'footer', comment: ['fist substitution is "vs code", second is "privacy statement", third is "opt out".'] },
			"{0} collects usage data. Read our {1} and learn how to {2}.", this.productService.nameShort, privacyStatementButton, optOutButton);

		const renderedContents = this.detailsPageDisposables.add(this.markdownRendererService.render({ value: text, isTrusted: true }));
		parent.append(renderedContents.element);
	}

	private getKeyBinding(command: string) {
		command = command.replace(/^command:/, '');
		return this.keybindingService.lookupKeybinding(command);
	}

	private async scrollPrev() {
		this.inProgressScroll = this.inProgressScroll.then(async () => {
			if (this.prevWalkthrough && this.prevWalkthrough !== this.currentWalkthrough) {
				this.currentWalkthrough = this.prevWalkthrough;
				this.prevWalkthrough = undefined;
				this.makeCategoryVisibleWhenAvailable(this.currentWalkthrough.id);
			} else if (this.editorInput?.returnToCommand) {
				// Execute the specified command to return to the origin page
				this.commandService.executeCommand(this.editorInput.returnToCommand);
			} else {
				this.currentWalkthrough = undefined;
				if (this.editorInput) {
					this.editorInput.selectedCategory = undefined;
					this.editorInput.selectedStep = undefined;
					this.editorInput.showTelemetryNotice = false;
					this.editorInput.walkthroughPageTitle = undefined;
				}

				this.selectStep(undefined);
				this.setSlide('categories');
				this.container.focus();
			}
		});
	}

	private runSkip() {
		this.commandService.executeCommand('workbench.action.closeActiveEditor');
	}

	escape() {
		if (this.editorInput?.selectedCategory) {
			this.scrollPrev();
		} else {
			this.runSkip();
		}
	}

	private setSlide(toEnable: 'details' | 'categories', firstLaunch: boolean = false) {
		// eslint-disable-next-line no-restricted-syntax
		const slideManager = assertReturnsDefined(this.container.querySelector('.gettingStarted'));
		if (toEnable === 'categories') {
			slideManager.classList.remove('showDetails');
			slideManager.classList.add('showCategories');
			// eslint-disable-next-line no-restricted-syntax
			this.container.querySelector<HTMLButtonElement>('.prev-button.button-link')!.style.display = 'none';
			// eslint-disable-next-line no-restricted-syntax
			this.container.querySelector('.gettingStartedSlideDetails')!.querySelectorAll('button').forEach(button => button.disabled = true);
			// eslint-disable-next-line no-restricted-syntax
			this.container.querySelector('.gettingStartedSlideCategories')!.querySelectorAll('button').forEach(button => button.disabled = false);
			// eslint-disable-next-line no-restricted-syntax
			this.container.querySelector('.gettingStartedSlideCategories')!.querySelectorAll('input').forEach(button => button.disabled = false);
		} else {
			slideManager.classList.add('showDetails');
			slideManager.classList.remove('showCategories');
			// eslint-disable-next-line no-restricted-syntax
			const prevButton = this.container.querySelector<HTMLButtonElement>('.prev-button.button-link');
			prevButton!.style.display = this.editorInput?.showWelcome || this.editorInput?.returnToCommand || this.prevWalkthrough ? 'block' : 'none';
			// eslint-disable-next-line no-restricted-syntax
			const moreTextElement = prevButton!.querySelector('.moreText');
			moreTextElement!.textContent = firstLaunch ? localize('welcome', "Welcome") : localize('goBack', "Go Back");

			// eslint-disable-next-line no-restricted-syntax
			this.container.querySelector('.gettingStartedSlideDetails')!.querySelectorAll('button').forEach(button => button.disabled = false);
			// eslint-disable-next-line no-restricted-syntax
			this.container.querySelector('.gettingStartedSlideCategories')!.querySelectorAll('button').forEach(button => button.disabled = true);
			// eslint-disable-next-line no-restricted-syntax
			this.container.querySelector('.gettingStartedSlideCategories')!.querySelectorAll('input').forEach(button => button.disabled = true);
		}
	}

	override focus() {
		super.focus();

		const active = this.container.ownerDocument.activeElement;

		let parent = this.container.parentElement;
		while (parent && parent !== active) {
			parent = parent.parentElement;
		}

		if (parent) {
			// Only set focus if there is no other focued element outside this chain.
			// This prevents us from stealing back focus from other focused elements such as quick pick due to delayed load.
			this.container.focus();
		}
	}
}

export class GettingStartedInputSerializer implements IEditorSerializer {
	public canSerialize(editorInput: GettingStartedInput): boolean {
		return true;
	}

	public serialize(editorInput: GettingStartedInput): string {
		return JSON.stringify({ selectedCategory: editorInput.selectedCategory, selectedStep: editorInput.selectedStep });
	}

	public deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): GettingStartedInput {

		return instantiationService.invokeFunction(accessor => {
			try {
				const { selectedCategory, selectedStep } = JSON.parse(serializedEditorInput);
				return new GettingStartedInput({ selectedCategory, selectedStep });
			} catch { }
			return new GettingStartedInput({});

		});
	}
}
