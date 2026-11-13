/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/picodeWhatsNew.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { language as platformLanguage } from '../../../../base/common/platform.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { PICODE_STATUS_CONTAINER_ID, sidebarSideColumn } from '../../../browser/parts/sidebar/sidebarSideColumn.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { getProFeatures, IPicodeProEntitlement } from './account/picodeProEntitlement.js';
import { PICODE_LAYOUT_SETTING, picodeLayoutOf } from './picodeLayoutStyle.js';
import { IWhatsNewHighlight, WhatsNewAction, WhatsNewPreview } from './picodeWhatsNewHighlights.js';

export interface IWhatsNewWindowOptions {
	readonly version: string;
	readonly subtitle: string;
	readonly highlights: readonly IWhatsNewHighlight[];
	/** The releases' list of changes, as Markdown; it may arrive after the window opened. */
	readonly changes: Promise<string | undefined>;
	/** The update stays inside one line of versions (2.0.0 to 2.0.1): that list is the bugs fixed since. */
	readonly fixesOnly: boolean;
	readonly releaseUrl: string;
}

export interface IWhatsNewWindowServices {
	readonly layoutService: IWorkbenchLayoutService;
	readonly commandService: ICommandService;
	readonly configurationService: IConfigurationService;
	readonly openerService: IOpenerService;
	readonly markdownRendererService: IMarkdownRendererService;
	readonly paneCompositeService: IPaneCompositePartService;
	readonly entitlement: IPicodeProEntitlement;
	readonly productService: IProductService;
}

/** How long each step of a playing demo stays on screen. */
const DEMO_STEP_MS = 1600;

const OPEN_ACCOUNT_COMMAND = 'picode.account.open';
const SWITCH_LAYOUT_COMMAND = 'picode.appearance.switchLayout';
const EDITOR_TASKS_COMMAND = 'workbench.view.extension.picode-status';
const OPEN_IMPORT_COMMAND = 'picode.import.open';
const OPEN_SETTINGS_COMMAND = 'workbench.action.openSettings';
const NEW_TERMINAL_COMMAND = 'workbench.action.terminal.new';
const SHOW_EXTENSIONS_COMMAND = 'workbench.view.extensions';
const CHOOSE_SECTIONS_COMMAND = 'picode.status.chooseSections';
/** The multi-file diff editor's list of changed files (see `multiDiffEditor.contribution.ts`). */
const FILE_LIST_SETTING = 'multiDiffEditor.experimental.fileList';

/**
 * What changed, as a window over the editor: one page per novelty, each explained for the person
 * using PiCode, with a small demo they can play with and a button that does the real thing. The
 * window stays open while a layout changes behind it, so the difference can be seen at once.
 */
export function showWhatsNewWindow(options: IWhatsNewWindowOptions, services: IWhatsNewWindowServices): void {
	const disposables = new DisposableStore();
	const pageStore = disposables.add(new DisposableStore());
	const close = () => disposables.dispose();

	const backdrop = append(services.layoutService.activeContainer, $('.picode-whatsnew-backdrop'));
	disposables.add({ dispose: () => backdrop.remove() });
	const title = localize('picodeWhatsNew.heading', "What's new in PiCode");
	const card = append(backdrop, $('.picode-whatsnew', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' }));

	const header = append(card, $('.picode-whatsnew-header'));
	append(header, $(`span.picode-whatsnew-header-icon${ThemeIcon.asCSSSelector(Codicon.sparkle)}`));
	const heading = append(header, $('.picode-whatsnew-heading'));
	const titleRow = append(heading, $('.picode-whatsnew-title'));
	append(titleRow, $('span')).textContent = title;
	append(titleRow, $('span.picode-whatsnew-version')).textContent = options.version;
	append(heading, $('.picode-whatsnew-subtitle')).textContent = options.subtitle;
	const closeButton = append(header, $(`button.picode-whatsnew-close${ThemeIcon.asCSSSelector(Codicon.close)}`, { type: 'button', title: localize('picodeWhatsNew.close', "Close") }));

	const body = append(card, $('.picode-whatsnew-body'));
	const nav = append(body, $('.picode-whatsnew-nav', { role: 'tablist', 'aria-orientation': 'vertical' }));
	const page = append(body, $('.picode-whatsnew-page', { role: 'tabpanel', tabindex: '0' }));

	const footer = append(card, $('.picode-whatsnew-footer'));
	const fullNotes = append(footer, $('button.picode-whatsnew-link', { type: 'button' }));
	fullNotes.textContent = localize('picodeWhatsNew.full', "Full release notes");
	append(footer, $('.picode-whatsnew-spacer'));
	const counter = append(footer, $('span.picode-whatsnew-counter'));
	const back = append(footer, $('button.picode-whatsnew-button.secondary', { type: 'button' }));
	back.textContent = localize('picodeWhatsNew.back', "Back");
	const next = append(footer, $('button.picode-whatsnew-button', { type: 'button' }));

	const highlights = [...options.highlights.filter(h => h.plan === 'pro'), ...options.highlights.filter(h => h.plan === 'free')];
	let changes: string | undefined;
	let active = 0;
	const changesTitle = () => options.fixesOnly ? localize('picodeWhatsNew.bugsFixed', "Bugs fixed") : localize('picodeWhatsNew.allChanges', "All changes");
	const pageCount = () => highlights.length + (changes ? 1 : 0);

	const renderNav = () => {
		clearNode(nav);
		let group: string | undefined;
		highlights.forEach((highlight, index) => {
			if (highlight.plan !== group) {
				group = highlight.plan;
				const heading = append(nav, $(`.picode-whatsnew-nav-group.${group}`));
				append(heading, $(`span${ThemeIcon.asCSSSelector(group === 'pro' ? Codicon.star : Codicon.heart)}`));
				append(heading, $('span')).textContent = group === 'pro' ? localize('picodeWhatsNew.group.pro', "PiCode Pro") : localize('picodeWhatsNew.group.free', "Free for everyone");
			}
			navRow(highlight.icon, highlight.title, index);
		});
		if (changes) {
			navRow(Codicon.listUnordered, changesTitle(), highlights.length);
		}
	};
	const navRow = (icon: ThemeIcon, label: string, index: number) => {
		const row = append(nav, $('button.picode-whatsnew-nav-row', { type: 'button', role: 'tab', 'aria-selected': String(index === active) }));
		row.classList.toggle('active', index === active);
		append(row, $(`span${ThemeIcon.asCSSSelector(icon)}`));
		append(row, $('span.picode-whatsnew-nav-label')).textContent = label;
		pageStore.add(addDisposableListener(row, EventType.CLICK, () => go(index)));
	};

	const go = (index: number) => {
		active = Math.max(0, Math.min(index, pageCount() - 1));
		render();
		page.scrollTop = 0;
	};

	const render = () => {
		pageStore.clear();
		renderNav();
		clearNode(page);
		const highlight = highlights[active];
		if (highlight) {
			renderHighlight(page, highlight, pageStore, services, close, render);
		} else if (changes) {
			append(page, $('h2.picode-whatsnew-page-title')).textContent = changesTitle();
			const rendered = services.markdownRendererService.render(new MarkdownString(changes));
			pageStore.add(rendered);
			page.appendChild(rendered.element).classList.add('picode-whatsnew-changes');
		}
		renderFooter();
	};

	const renderFooter = () => {
		counter.textContent = `${active + 1} / ${pageCount()}`;
		back.style.visibility = active === 0 ? 'hidden' : 'visible';
		next.textContent = active >= pageCount() - 1 ? localize('picodeWhatsNew.done', "Done") : localize('picodeWhatsNew.next', "Next");
	};

	disposables.add(addDisposableListener(next, EventType.CLICK, () => {
		if (active >= pageCount() - 1) {
			close();
		} else {
			go(active + 1);
		}
	}));
	disposables.add(addDisposableListener(back, EventType.CLICK, () => go(active - 1)));
	disposables.add(addDisposableListener(closeButton, EventType.CLICK, close));
	disposables.add(addDisposableListener(fullNotes, EventType.CLICK, () => void services.openerService.open(URI.parse(options.releaseUrl))));
	disposables.add(addDisposableListener(backdrop, EventType.MOUSE_DOWN, e => {
		if (e.target === backdrop) {
			close();
		}
	}));
	disposables.add(addDisposableListener(card, EventType.KEY_DOWN, e => {
		const event = new StandardKeyboardEvent(e);
		if (event.equals(KeyCode.Escape)) {
			event.preventDefault();
			close();
		} else if (event.equals(KeyCode.DownArrow) || event.equals(KeyCode.RightArrow)) {
			event.preventDefault();
			go(active + 1);
		} else if (event.equals(KeyCode.UpArrow) || event.equals(KeyCode.LeftArrow)) {
			event.preventDefault();
			go(active - 1);
		}
	}));
	// A layout changed from the button: the page says the new state.
	disposables.add(services.configurationService.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration(PICODE_LAYOUT_SETTING)) {
			render();
		}
	}));

	void options.changes.then(markdown => {
		if (markdown && !disposables.isDisposed) {
			changes = markdown;
			if (highlights[active]) {
				// One more page in the list; the one being read (and its demo) is left as it is.
				renderNav();
				renderFooter();
			} else {
				// Nothing of our own to show: this is the only page, and it was blank until now.
				render();
			}
		}
	});

	render();
	card.focus();
}

function renderHighlight(page: HTMLElement, highlight: IWhatsNewHighlight, store: DisposableStore, services: IWhatsNewWindowServices, close: () => void, rerender: () => void): void {
	const tag = append(page, $(`.picode-whatsnew-tag.${highlight.plan}`));
	append(tag, $(`span${ThemeIcon.asCSSSelector(highlight.plan === 'pro' ? Codicon.star : Codicon.heart)}`));
	append(tag, $('span')).textContent = highlight.plan === 'free'
		? localize('picodeWhatsNew.group.free', "Free for everyone")
		: services.entitlement.plan === 'pro'
			? localize('picodeWhatsNew.tag.yours', "Included in your plan")
			: localize('picodeWhatsNew.group.pro', "With PiCode Pro");
	append(page, $('h2.picode-whatsnew-page-title')).textContent = highlight.title;
	append(page, $('p.picode-whatsnew-summary')).textContent = highlight.summary;
	const demo = append(page, $('.picode-whatsnew-demo'));
	PREVIEWS[highlight.preview](demo, store, services);
	const list = append(page, $('ul.picode-whatsnew-points'));
	for (const point of highlight.points) {
		append(list, $('li')).textContent = point;
	}
	if (highlight.action) {
		const button = append(page, $('button.picode-whatsnew-button.try', { type: 'button' }));
		const action = highlight.action;
		// A Pro novelty can be read and played with by anyone; using it for real takes the plan.
		const locked = highlight.plan === 'pro' && !services.entitlement.isPro;
		button.textContent = locked ? localize('picodeUpgradeToPro', "Upgrade to Pro") : actionLabel(action, services);
		store.add(addDisposableListener(button, EventType.CLICK, () => locked ? openPlans(services, close) : runAction(action, services, close, rerender)));
	}
}

function actionLabel(action: WhatsNewAction, services: IWhatsNewWindowServices): string {
	switch (action) {
		case 'switchLayout':
			return picodeLayoutOf(services.configurationService) === 'agent'
				? localize('picodeWhatsNew.useEditor', "Switch to the Editor layout")
				: localize('picodeWhatsNew.useAgent', "Switch to the Agent layout");
		case 'connect':
			return localize('picodeWhatsNew.connect', "Connect GitHub or Jira");
		case 'openAccount':
			return localize('picodeWhatsNew.openAccount', "Open my account");
		case 'showTasks':
			return localize('picodeWhatsNew.showTasks', "Show my tasks");
		case 'openImport':
			return localize('picodeWhatsNew.openImport', "Open Import");
		case 'fileList':
			return services.configurationService.getValue<boolean>(FILE_LIST_SETTING)
				? localize('picodeWhatsNew.fileListOff', "Turn off the file list")
				: localize('picodeWhatsNew.fileListOn', "Turn on the file list");
		case 'excludeSetting':
			return localize('picodeWhatsNew.excludeSetting', "Open the hidden files setting");
		case 'newTerminal':
			return localize('picodeWhatsNew.newTerminal', "Open a terminal");
		case 'browseExtensions':
			return localize('picodeWhatsNew.browseExtensions', "Browse extensions");
		case 'chooseSections':
			return localize('picodeWhatsNew.chooseSections', "Choose my sections");
		case 'showStatus':
			return localize('picodeWhatsNew.showStatus', "Open Status");
		case 'openProviders':
			return localize('picodeWhatsNew.openProviders', "Open Providers");
		case 'addProject':
			return localize('picodeWhatsNew.addProject', "Add a project");
	}
}

/** The plans page; without one on record, the Account window, which has its own way there. */
function openPlans(services: IWhatsNewWindowServices, close: () => void): void {
	const origin = services.productService.picode?.webOrigin;
	if (origin) {
		void services.openerService.open(URI.parse(`${origin}/pricing`));
	} else {
		close();
		void services.commandService.executeCommand(OPEN_ACCOUNT_COMMAND);
	}
}

function runAction(action: WhatsNewAction, services: IWhatsNewWindowServices, close: () => void, rerender: () => void): void {
	switch (action) {
		case 'switchLayout':
			// The window stays: the point is to see the difference behind it.
			void services.commandService.executeCommand(SWITCH_LAYOUT_COMMAND).then(rerender);
			return;
		case 'connect':
		case 'openAccount':
			close();
			void services.commandService.executeCommand(OPEN_ACCOUNT_COMMAND);
			return;
		case 'openImport':
			close();
			void services.commandService.executeCommand(OPEN_IMPORT_COMMAND);
			return;
		case 'openProviders':
			close();
			void services.commandService.executeCommand('picode.providersModels.open', 'providers');
			return;
		case 'addProject':
			close();
			void services.commandService.executeCommand('addRootFolder');
			return;
		case 'fileList':
			// The window stays and its button says the new state.
			void services.configurationService.updateValue(FILE_LIST_SETTING, !services.configurationService.getValue<boolean>(FILE_LIST_SETTING)).then(rerender);
			return;
		case 'excludeSetting':
			close();
			void services.commandService.executeCommand(OPEN_SETTINGS_COMMAND, { query: 'files.exclude' });
			return;
		case 'newTerminal':
			close();
			void services.commandService.executeCommand(NEW_TERMINAL_COMMAND);
			return;
		case 'browseExtensions':
			close();
			void services.commandService.executeCommand(SHOW_EXTENSIONS_COMMAND);
			return;
		case 'chooseSections':
			close();
			void services.commandService.executeCommand(CHOOSE_SECTIONS_COMMAND);
			return;
		case 'showTasks':
		case 'showStatus':
			close();
			if (picodeLayoutOf(services.configurationService) !== 'agent') {
				void services.commandService.executeCommand(EDITOR_TASKS_COMMAND);
			} else if (!sidebarSideColumn.visible) {
				void services.paneCompositeService.openPaneComposite(PICODE_STATUS_CONTAINER_ID, ViewContainerLocation.Sidebar);
			}
			return;
	}
}

// -- The demos: drawn with the theme's own colours, with made-up content, and touching nothing real ----

const PREVIEWS: Record<WhatsNewPreview, (parent: HTMLElement, store: DisposableStore, services: IWhatsNewWindowServices) => void> = {
	layout: layoutPreview,
	issues: issuesPreview,
	plan: planPreview,
	job: jobPreview,
	plans: plansPreview,
	sync: syncPreview,
	import: importPreview,
	changedFiles: changedFilesPreview,
	exclude: excludePreview,
	terminalDialogs: terminalDialogsPreview,
	problems: problemsPreview,
	statusSections: statusSectionsPreview,
	context: contextPreview,
	providers: providersPreview,
	projects: projectsPreview,
};

/** A caption for the demo, and a button that plays it again. */
function demoBar(parent: HTMLElement, caption: string, store: DisposableStore, replay?: () => void): void {
	const bar = append(parent, $('.picode-whatsnew-demo-bar'));
	append(bar, $(`span${ThemeIcon.asCSSSelector(Codicon.play)}`));
	append(bar, $('span.picode-whatsnew-demo-caption')).textContent = caption;
	if (replay) {
		const button = append(bar, $('button.picode-whatsnew-link', { type: 'button' }));
		button.textContent = localize('picodeWhatsNew.replay', "Play again");
		store.add(addDisposableListener(button, EventType.CLICK, replay));
	}
}

function layoutPreview(parent: HTMLElement, store: DisposableStore, services: IWhatsNewWindowServices): void {
	const current = picodeLayoutOf(services.configurationService);
	demoBar(parent, localize('picodeWhatsNew.layout.demo', "Pick one to see the layout."), store);
	const tabs = append(parent, $('.picode-whatsnew-tabs', { role: 'tablist' }));
	const stage = append(parent, $('.picode-whatsnew-layout'));
	const zone = (css: string, label: string, accent = false) => {
		const element = append(stage, $(`.picode-whatsnew-zone.${css}`));
		element.classList.toggle('accent', accent);
		element.textContent = label;
	};
	const draw = (layout: 'agent' | 'editor') => {
		for (const tab of Array.from(tabs.children)) {
			tab.classList.toggle('active', (tab as HTMLElement).dataset.layout === layout);
		}
		clearNode(stage);
		stage.className = `picode-whatsnew-layout ${layout}`;
		if (layout === 'agent') {
			zone('sessions', localize('picodeWhatsNew.zone.sessions', "Sessions"));
			zone('chat', localize('picodeWhatsNew.zone.chat', "Chat"), true);
			zone('side', localize('picodeWhatsNew.zone.status', "Status and files"));
		} else {
			zone('explorer', localize('picodeWhatsNew.zone.files', "Files"));
			zone('code', localize('picodeWhatsNew.zone.code', "Code"), true);
			zone('terminal', localize('picodeWhatsNew.zone.terminal', "Terminal"));
			zone('chat', localize('picodeWhatsNew.zone.chat', "Chat"));
		}
	};
	for (const [layout, label] of [['agent', 'Agent'], ['editor', 'Editor']] as const) {
		const tab = append(tabs, $('button.picode-whatsnew-tab', { type: 'button', role: 'tab' }));
		tab.dataset.layout = layout;
		tab.textContent = label;
		store.add(addDisposableListener(tab, EventType.CLICK, () => draw(layout)));
	}
	draw(current);
}

function plansPreview(parent: HTMLElement, store: DisposableStore, services: IWhatsNewWindowServices): void {
	demoBar(parent, localize('picodeWhatsNew.account.demo', "Compare the plans."), store);
	const tabs = append(parent, $('.picode-whatsnew-tabs', { role: 'tablist' }));
	const list = append(parent, $('.picode-whatsnew-list'));
	const row = (icon: ThemeIcon, label: string, detail?: string) => {
		const element = append(list, $('.picode-whatsnew-row.feature'));
		append(element, $(`span.picode-whatsnew-row-icon${ThemeIcon.asCSSSelector(icon)}`));
		const text = append(element, $('.picode-whatsnew-row-text'));
		append(text, $('span.picode-whatsnew-row-label')).textContent = label;
		if (detail) {
			append(text, $('span.picode-whatsnew-row-detail')).textContent = detail;
		}
	};
	const draw = (plan: 'free' | 'pro') => {
		for (const tab of Array.from(tabs.children)) {
			tab.classList.toggle('active', (tab as HTMLElement).dataset.plan === plan);
		}
		clearNode(list);
		if (plan === 'free') {
			row(Codicon.check, localize('picodeWhatsNew.account.free1', "The full editor, no limits"));
			row(Codicon.check, localize('picodeWhatsNew.account.free2', "The agent, chat and memory, with your own AI providers"));
			row(Codicon.check, localize('picodeWhatsNew.account.free3', "Both layouts, all themes and languages"));
			row(Codicon.check, localize('picodeWhatsNew.account.free4', "A free PiCode account"));
		} else {
			row(Codicon.check, localize('picodeWhatsNew.account.proAll', "Everything in Free, plus:"));
			// The same list the Account window shows, so the two can never disagree.
			for (const feature of getProFeatures().filter(candidate => candidate.available)) {
				row(feature.icon, feature.label, feature.description);
			}
		}
	};
	for (const [plan, label] of [['free', localize('picodeAccountPlanFree', "Free")], ['pro', localize('picodeAccountPlanPro', "Pro")]] as const) {
		const tab = append(tabs, $('button.picode-whatsnew-tab', { type: 'button', role: 'tab' }));
		tab.dataset.plan = plan;
		tab.textContent = label;
		store.add(addDisposableListener(tab, EventType.CLICK, () => draw(plan)));
	}
	draw(services.entitlement.plan === 'pro' ? 'pro' : 'free');
}

function syncPreview(parent: HTMLElement, store: DisposableStore): void {
	demoBar(parent, localize('picodeWhatsNew.sync.demo', "Flip a few switches. Nothing really changes here."), store);
	const parts = [
		{ label: localize('picodeSyncAgents', "Agents and skills"), on: true },
		{ label: localize('picodeSyncSettings', "Settings"), on: true },
		{ label: localize('picodeSyncShortcuts', "Keyboard shortcuts"), on: false },
		{ label: localize('picodeSyncChats', "Chats"), on: false },
	];
	const list = append(parent, $('.picode-whatsnew-list'));
	const result = append(parent, $('.picode-whatsnew-sync-result'));
	const count = () => {
		result.textContent = localize('picodeWhatsNew.sync.result', "{0} of {1} will travel with you.", parts.filter(part => part.on).length, parts.length);
	};
	for (const part of parts) {
		const label = append(list, $('label.picode-whatsnew-row.toggle'));
		const input = append(label, $('input', { type: 'checkbox' })) as HTMLInputElement;
		input.checked = part.on;
		append(label, $('span.picode-whatsnew-row-label')).textContent = part.label;
		store.add(addDisposableListener(input, EventType.CHANGE, () => {
			part.on = input.checked;
			count();
		}));
	}
	count();
}

function importPreview(parent: HTMLElement, store: DisposableStore): void {
	demoBar(parent, localize('picodeWhatsNew.import.demo', "Tick a few items. Nothing is really imported here."), store);
	const sources = [
		{ id: 'pi', label: localize('picodeWhatsNew.import.tabPi', "Your other pi"), items: ['gentle-pi', 'pi-plan-widget', 'pi-tools', 'pi-search'] },
		{ id: 'code', label: localize('picodeWhatsNew.import.tabCode', "VS Code"), items: ['dracula-theme.theme-dracula', 'esbenp.prettier-vscode', 'editor.fontSize'] },
	];
	const ticked = new Map<string, Set<string>>(sources.map(source => [source.id, new Set(source.items.slice(0, 1))]));
	const tabs = append(parent, $('.picode-whatsnew-tabs', { role: 'tablist' }));
	const list = append(parent, $('.picode-whatsnew-list'));
	const result = append(parent, $('.picode-whatsnew-sync-result'));
	const draw = (sourceId: string) => {
		for (const tab of Array.from(tabs.children)) {
			tab.classList.toggle('active', (tab as HTMLElement).dataset.source === sourceId);
		}
		const source = sources.find(candidate => candidate.id === sourceId)!;
		const mine = ticked.get(sourceId)!;
		clearNode(list);
		const count = () => {
			result.textContent = localize('picodeWhatsNew.import.result', "{0} of {1} selected.", mine.size, source.items.length);
		};
		for (const item of source.items) {
			const label = append(list, $('label.picode-whatsnew-row.toggle'));
			const input = append(label, $('input', { type: 'checkbox' })) as HTMLInputElement;
			input.checked = mine.has(item);
			append(label, $('span.picode-whatsnew-row-label')).textContent = item;
			store.add(addDisposableListener(input, EventType.CHANGE, () => {
				if (input.checked) {
					mine.add(item);
				} else {
					mine.delete(item);
				}
				count();
			}));
		}
		count();
	};
	for (const source of sources) {
		const tab = append(tabs, $('button.picode-whatsnew-tab', { type: 'button', role: 'tab' }));
		tab.dataset.source = source.id;
		tab.textContent = source.label;
		store.add(addDisposableListener(tab, EventType.CLICK, () => draw(source.id)));
	}
	draw('pi');
}

function issuesPreview(parent: HTMLElement, store: DisposableStore): void {
	demoBar(parent, localize('picodeWhatsNew.issues.demo', "Drag a card to another column."), store);
	const board = append(parent, $('.picode-whatsnew-board'));
	const columns = [
		{ name: localize('picodeWhatsNew.board.todo', "To do"), cards: [{ key: 'DEMO-12', title: localize('picodeWhatsNew.board.card1', "The sign-in button does nothing"), priority: 'high' }] },
		{ name: localize('picodeWhatsNew.board.doing', "In progress"), cards: [{ key: 'DEMO-9', title: localize('picodeWhatsNew.board.card2', "Translate the settings page"), priority: 'medium' }] },
		{ name: localize('picodeWhatsNew.board.done', "Done"), cards: [{ key: 'DEMO-4', title: localize('picodeWhatsNew.board.card3', "Faster start-up"), priority: 'low' }] },
	];
	let dragged: HTMLElement | undefined;
	for (const column of columns) {
		const element = append(board, $('.picode-whatsnew-column'));
		append(element, $('.picode-whatsnew-column-title')).textContent = column.name;
		const list = append(element, $('.picode-whatsnew-column-cards'));
		for (const item of column.cards) {
			const card = append(list, $(`.picode-whatsnew-card.${item.priority}`, { draggable: 'true' }));
			append(card, $('.picode-whatsnew-card-title')).textContent = item.title;
			append(card, $('.picode-whatsnew-card-key')).textContent = item.key;
			store.add(addDisposableListener(card, EventType.DRAG_START, e => {
				dragged = card;
				e.dataTransfer?.setData('text/plain', item.key);
				card.classList.add('dragging');
			}));
			store.add(addDisposableListener(card, EventType.DRAG_END, () => card.classList.remove('dragging')));
		}
		store.add(addDisposableListener(element, EventType.DRAG_OVER, e => {
			e.preventDefault();
			element.classList.add('over');
		}));
		store.add(addDisposableListener(element, EventType.DRAG_LEAVE, () => element.classList.remove('over')));
		store.add(addDisposableListener(element, EventType.DROP, e => {
			e.preventDefault();
			element.classList.remove('over');
			if (dragged) {
				list.appendChild(dragged);
			}
		}));
	}
}

/** Runs `steps` one after another, and again from the start when asked. */
function playDemo(steps: number, store: DisposableStore, draw: (step: number) => void): () => void {
	const timers = store.add(new DisposableStore());
	const play = () => {
		timers.clear();
		for (let step = 0; step < steps; step++) {
			timers.add(disposableTimeout(() => draw(step), step * DEMO_STEP_MS));
		}
	};
	return play;
}

function planPreview(parent: HTMLElement, store: DisposableStore): void {
	const activity = [
		'read src/login.ts',
		'edit src/login.ts',
		'npm test',
	];
	const steps = [
		localize('picodeWhatsNew.plan.step1', "Find the bug"),
		localize('picodeWhatsNew.plan.step2', "Fix it"),
		localize('picodeWhatsNew.plan.step3', "Run the tests"),
	];
	let list: HTMLElement;
	const play = playDemo(steps.length + 1, store, current => {
		clearNode(list);
		const head = append(list, $('.picode-whatsnew-row.head'));
		append(head, $(`span${ThemeIcon.asCSSSelector(Codicon.checklist)}`));
		append(head, $('span.picode-whatsnew-row-label')).textContent = localize('picodeWhatsNew.plan.name', "Plan");
		append(head, $('span.picode-whatsnew-row-detail')).textContent = `${Math.min(current, steps.length)}/${steps.length}`;
		steps.forEach((label, index) => {
			const state = index < current ? 'done' : index === current ? 'doing' : 'pending';
			const row = append(list, $(`.picode-whatsnew-row.step.${state}`));
			const icon = state === 'done' ? Codicon.check : state === 'doing' ? Codicon.loading : Codicon.circleOutline;
			append(row, $(`span.picode-whatsnew-row-icon${ThemeIcon.asCSSSelector(icon)}`));
			append(row, $('span.picode-whatsnew-row-label')).textContent = label;
			if (state === 'doing') {
				append(row, $('span.picode-whatsnew-row-detail')).textContent = activity[index];
			}
		});
	});
	demoBar(parent, localize('picodeWhatsNew.plan.demo', "Watch a plan move."), store, play);
	list = append(parent, $('.picode-whatsnew-list'));
	play();
}

function jobPreview(parent: HTMLElement, store: DisposableStore): void {
	const name = localize('picodeWhatsNew.job.name', "Build the project");
	let stage: HTMLElement;
	const play = playDemo(3, store, step => {
		clearNode(stage);
		const tasks = append(stage, $('.picode-whatsnew-list'));
		const running = step < 2;
		const group = append(tasks, $('.picode-whatsnew-row.head'));
		append(group, $(`span${ThemeIcon.asCSSSelector(running ? Codicon.sync : Codicon.history)}`));
		append(group, $('span.picode-whatsnew-row-label')).textContent = running ? localize('picodeWhatsNew.job.running', "Running") : localize('picodeWhatsNew.job.finished', "Finished");
		const row = append(tasks, $(`.picode-whatsnew-row.step.${running ? 'doing' : 'done'}`));
		append(row, $(`span.picode-whatsnew-row-icon${ThemeIcon.asCSSSelector(running ? Codicon.loading : Codicon.check)}`));
		append(row, $('span.picode-whatsnew-row-label')).textContent = name;
		append(row, $('span.picode-whatsnew-row-detail')).textContent = running ? localize('picodeWhatsNew.job.minutes', "{0} min", step + 1) : localize('picodeWhatsNew.job.done', "done");
		if (!running) {
			const chat = append(stage, $('.picode-whatsnew-chat'));
			append(chat, $('.picode-whatsnew-bubble.event')).textContent = localize('picodeWhatsNew.job.event', "Background job finished: {0}", name);
			append(chat, $('.picode-whatsnew-bubble')).textContent = localize('picodeWhatsNew.job.reply', "The build went well, with no errors.");
		}
	});
	demoBar(parent, localize('picodeWhatsNew.job.demo', "A job ends after the agent is done, and you still hear about it."), store, play);
	stage = append(parent, $('.picode-whatsnew-job'));
	play();
}

/** A row of tabs; picking one marks it and calls `draw` with its id. Returns the picker. */
function demoTabs<T extends string>(parent: HTMLElement, store: DisposableStore, tabs: readonly (readonly [T, string])[], draw: (id: T) => void): (id: T) => void {
	const bar = append(parent, $('.picode-whatsnew-tabs', { role: 'tablist' }));
	const pick = (id: T) => {
		for (const tab of Array.from(bar.children)) {
			tab.classList.toggle('active', (tab as HTMLElement).dataset.tab === id);
		}
		draw(id);
	};
	for (const [id, label] of tabs) {
		const tab = append(bar, $('button.picode-whatsnew-tab', { type: 'button', role: 'tab' }));
		tab.dataset.tab = id;
		tab.textContent = label;
		store.add(addDisposableListener(tab, EventType.CLICK, () => pick(id)));
	}
	return pick;
}

function changedFilesPreview(parent: HTMLElement, store: DisposableStore): void {
	demoBar(parent, localize('picodeWhatsNew.changedFiles.demo', "Click a file in the list, or hide the list."), store);
	const files: { path: string; added: number; removed: number; lines: [string, string][] }[] = [
		{ path: 'src/login.ts', added: 4, removed: 2, lines: [['-', 'if (user) {'], ['+', 'if (user && user.active) {'], [' ', '  signIn(user);'], ['-', '}'], ['+', '} else {'], ['+', '  showError();'], ['+', '}']] },
		{ path: 'src/session.ts', added: 1, removed: 1, lines: [[' ', 'const timeout ='], ['-', '  30 * 60;'], ['+', '  8 * 60 * 60;']] },
		{ path: 'README.md', added: 2, removed: 0, lines: [[' ', '## Sign in'], ['+', 'Inactive accounts see'], ['+', 'a clear message.']] },
	];
	let selected = 0;
	let showList = true;
	const toggle = append(parent, $('label.picode-whatsnew-row.toggle'));
	const input = append(toggle, $('input', { type: 'checkbox' })) as HTMLInputElement;
	input.checked = showList;
	append(toggle, $('span.picode-whatsnew-row-label')).textContent = localize('picodeWhatsNew.changedFiles.toggle', "Show the list of files");
	const stage = append(parent, $('.picode-whatsnew-diff'));
	const draw = () => {
		clearNode(stage);
		stage.classList.toggle('with-list', showList);
		if (showList) {
			const list = append(stage, $('.picode-whatsnew-diff-files'));
			files.forEach((file, index) => {
				const row = append(list, $('button.picode-whatsnew-diff-file', { type: 'button' }));
				row.classList.toggle('active', index === selected);
				append(row, $(`span${ThemeIcon.asCSSSelector(Codicon.file)}`));
				append(row, $('span.picode-whatsnew-diff-path')).textContent = file.path;
				append(row, $('span.picode-whatsnew-diff-added')).textContent = `+${file.added}`;
				append(row, $('span.picode-whatsnew-diff-removed')).textContent = `-${file.removed}`;
				store.add(addDisposableListener(row, EventType.CLICK, () => {
					selected = index;
					draw();
				}));
			});
		}
		const view = append(stage, $('.picode-whatsnew-diff-view'));
		const file = files[selected];
		append(view, $('.picode-whatsnew-diff-title')).textContent = file.path;
		for (const [kind, text] of file.lines) {
			const line = append(view, $('.picode-whatsnew-diff-line'));
			line.classList.toggle('added', kind === '+');
			line.classList.toggle('removed', kind === '-');
			line.textContent = `${kind} ${text}`;
		}
	};
	store.add(addDisposableListener(input, EventType.CHANGE, () => {
		showList = input.checked;
		draw();
	}));
	draw();
}

function excludePreview(parent: HTMLElement, store: DisposableStore): void {
	demoBar(parent, localize('picodeWhatsNew.exclude.demo', "Hide the folder, then keep one part of it."), store);
	const rules = { hide: true, keep: false };
	const options = append(parent, $('.picode-whatsnew-list'));
	const stage = append(parent, $('.picode-whatsnew-exclude'));
	const tree = append(stage, $('.picode-whatsnew-tree'));
	const json = append(stage, $('pre.picode-whatsnew-json'));
	const entries: { name: string; depth: number; folder?: boolean; hidden?: () => boolean }[] = [
		{ name: 'src', depth: 0, folder: true },
		{ name: 'index.ts', depth: 1 },
		{ name: 'node_modules', depth: 0, folder: true, hidden: () => rules.hide && !rules.keep },
		{ name: '@types', depth: 1, folder: true, hidden: () => rules.hide && !rules.keep },
		{ name: 'lodash', depth: 1, folder: true, hidden: () => rules.hide },
		{ name: 'package.json', depth: 0 },
	];
	const draw = () => {
		clearNode(tree);
		for (const entry of entries) {
			if (entry.hidden?.()) {
				continue;
			}
			const row = append(tree, $('.picode-whatsnew-tree-row'));
			row.style.paddingLeft = `${4 + entry.depth * 14}px`;
			append(row, $(`span${ThemeIcon.asCSSSelector(entry.folder ? Codicon.folder : Codicon.file)}`));
			append(row, $('span')).textContent = entry.name;
		}
		const lines = ['"files.exclude": {'];
		if (rules.hide) {
			lines.push(`  "node_modules": true${rules.keep ? ',' : ''}`);
		}
		if (rules.keep) {
			lines.push('  "!node_modules/@types": true');
		}
		lines.push('}');
		json.textContent = lines.join('\n');
	};
	const option = (label: string, key: 'hide' | 'keep') => {
		const row = append(options, $('label.picode-whatsnew-row.toggle'));
		const input = append(row, $('input', { type: 'checkbox' })) as HTMLInputElement;
		input.checked = rules[key];
		append(row, $('span.picode-whatsnew-row-label')).textContent = label;
		store.add(addDisposableListener(input, EventType.CHANGE, () => {
			rules[key] = input.checked;
			draw();
		}));
	};
	option(localize('picodeWhatsNew.exclude.hide', "Hide node_modules"), 'hide');
	option(localize('picodeWhatsNew.exclude.keep', "...but keep node_modules/@types"), 'keep');
	draw();
}

function terminalDialogsPreview(parent: HTMLElement, store: DisposableStore): void {
	let mode: 'before' | 'now' = 'now';
	let stage: HTMLElement;
	const play = playDemo(2, store, step => {
		clearNode(stage);
		stage.className = `picode-whatsnew-dialogs ${mode}`;
		const editor = append(stage, $('.picode-whatsnew-window'));
		append(editor, $('.picode-whatsnew-window-title')).textContent = 'PiCode';
		append(editor, $('.picode-whatsnew-window-terminal')).textContent = '> az login';
		if (step > 0) {
			const dialog = append(stage, $('.picode-whatsnew-dialog'));
			append(dialog, $(`span${ThemeIcon.asCSSSelector(Codicon.key)}`));
			append(dialog, $('span')).textContent = localize('picodeWhatsNew.terminalDialogs.dialog', "Sign in to your account");
		}
		result.textContent = step === 0
			? ''
			: mode === 'now'
				? localize('picodeWhatsNew.terminalDialogs.now', "The window opens in front, ready to use.")
				: localize('picodeWhatsNew.terminalDialogs.before', "The window opened behind the editor, out of sight.");
	});
	demoBar(parent, localize('picodeWhatsNew.terminalDialogs.demo', "Run a command that asks you to sign in."), store, play);
	const pick = demoTabs(parent, store, [['before', localize('picodeWhatsNew.before', "Before")], ['now', localize('picodeWhatsNew.now', "Now")]], picked => {
		mode = picked;
		play();
	});
	stage = append(parent, $('.picode-whatsnew-dialogs'));
	const result = append(parent, $('.picode-whatsnew-sync-result'));
	pick('now');
}

function providersPreview(parent: HTMLElement, store: DisposableStore): void {
	const timers = store.add(new DisposableStore());
	// Made-up accounts; clicking one plays the real flow: the browser wait, then the tick.
	const all = [
		{ id: 'chatgpt', name: 'ChatGPT', note: localize('picodeWhatsNew.providers.demoChatgpt', "ChatGPT Plus or Pro"), hue: 160 },
		{ id: 'claude', name: 'Claude', note: localize('picodeWhatsNew.providers.demoClaude', "Claude Pro or Max"), hue: 20 },
		{ id: 'copilot', name: 'GitHub Copilot', note: localize('picodeWhatsNew.providers.demoCopilot', "GitHub Copilot"), hue: 260 },
	];
	let connected: string[] = [];
	let busy: { id: string; done: boolean } | undefined;
	demoBar(parent, localize('picodeWhatsNew.providers.demo', "Pick an account and watch it connect."), store, () => {
		timers.clear();
		connected = [];
		busy = undefined;
		draw();
	});
	const stage = append(parent, $('.picode-whatsnew-list.picode-whatsnew-providers'));
	const mark = (provider: { name: string; hue: number }) => {
		const element = $('span.picode-whatsnew-provider-mark');
		element.textContent = provider.name.slice(0, 1);
		element.style.background = `hsl(${provider.hue} 55% 34%)`;
		return element;
	};
	const draw = () => {
		clearNode(stage);
		if (connected.length > 0) {
			append(stage, $('.picode-whatsnew-row.head')).textContent = localize('picodePv.connected', "Connected");
			for (const id of connected) {
				const provider = all.find(candidate => candidate.id === id)!;
				const row = append(stage, $('.picode-whatsnew-provider.connected'));
				row.appendChild(mark(provider));
				append(row, $('span.picode-whatsnew-row-label')).textContent = provider.name;
				append(row, $('span.picode-whatsnew-provider-pill')).textContent = localize('picodePv.signedIn', "Signed in");
			}
		}
		const grid = append(stage, $('.picode-whatsnew-provider-grid'));
		for (const provider of all.filter(candidate => !connected.includes(candidate.id))) {
			const active = busy?.id === provider.id;
			const tile = append(grid, $('button.picode-whatsnew-provider', { type: 'button' })) as HTMLButtonElement;
			tile.classList.toggle('active', active);
			tile.disabled = busy !== undefined && !active;
			tile.appendChild(mark(provider));
			const text = append(tile, $('span.picode-whatsnew-provider-text'));
			append(text, $('span.picode-whatsnew-provider-name')).textContent = provider.name;
			append(text, $('span.picode-whatsnew-provider-note')).textContent = active
				? (busy!.done ? localize('picodePv.connectedNow', "Connected. Its models are ready to use.") : localize('picodePv.waitingBrowser', "Waiting for your browser..."))
				: provider.note;
			if (active) {
				append(tile, $(busy!.done ? `span.picode-whatsnew-provider-done${ThemeIcon.asCSSSelector(Codicon.passFilled)}` : 'span.picode-whatsnew-provider-pulse'));
			} else {
				append(tile, $('span.picode-whatsnew-provider-pill')).textContent = localize('picodePv.signIn', "Sign in");
			}
			store.add(addDisposableListener(tile, EventType.CLICK, () => {
				if (busy !== undefined) {
					return;
				}
				busy = { id: provider.id, done: false };
				draw();
				timers.add(disposableTimeout(() => {
					busy = { id: provider.id, done: true };
					draw();
				}, 1600));
				timers.add(disposableTimeout(() => {
					busy = undefined;
					connected = [...connected, provider.id];
					draw();
				}, 2700));
			}));
		}
	};
	draw();
}

function projectsPreview(parent: HTMLElement, store: DisposableStore): void {
	// Made-up folders: the + brings in one more, the cross on a row takes it out again.
	const spare = ['docs', 'mobile-app'];
	let projects = ['web', 'api'];
	const reset = () => {
		projects = ['web', 'api'];
		draw();
	};
	demoBar(parent, localize('picodeWhatsNew.projects.demo', "Add a project with +, or remove one with its cross."), store, reset);
	const stage = append(parent, $('.picode-whatsnew-list'));
	const draw = () => {
		clearNode(stage);
		const head = append(stage, $('.picode-whatsnew-row.head'));
		append(head, $('span.picode-whatsnew-row-label')).textContent = `${localize('picode.sessions.projects', "Projects")} · ${projects.length}`;
		const next = spare.find(name => !projects.includes(name));
		const add = append(head, $(`button.picode-whatsnew-link${ThemeIcon.asCSSSelector(Codicon.add)}`, { type: 'button' })) as HTMLButtonElement;
		add.title = localize('picode.sessions.addProject', "Add a project to this workspace");
		add.disabled = next === undefined;
		store.add(addDisposableListener(add, EventType.CLICK, () => {
			if (next !== undefined) {
				projects = [...projects, next];
				draw();
			}
		}));
		for (const name of projects) {
			const row = append(stage, $('.picode-whatsnew-row'));
			append(row, $(`span.picode-whatsnew-row-icon${ThemeIcon.asCSSSelector(Codicon.folder)}`));
			append(row, $('span.picode-whatsnew-row-label')).textContent = name;
			const remove = append(row, $(`button.picode-whatsnew-link${ThemeIcon.asCSSSelector(Codicon.close)}`, { type: 'button' })) as HTMLButtonElement;
			remove.title = localize('picode.sessions.projectRemove', "Remove from Workspace");
			remove.disabled = projects.length === 1;
			store.add(addDisposableListener(remove, EventType.CLICK, () => {
				projects = projects.filter(candidate => candidate !== name);
				draw();
			}));
		}
		const chats = append(stage, $('.picode-whatsnew-row.head'));
		append(chats, $('span.picode-whatsnew-row-label')).textContent = localize('picode.sessions.conversations', "Conversations");
		const chat = append(stage, $('.picode-whatsnew-row'));
		append(chat, $(`span.picode-whatsnew-row-icon${ThemeIcon.asCSSSelector(Codicon.commentDiscussion)}`));
		append(chat, $('span.picode-whatsnew-row-label')).textContent = localize('picodeWhatsNew.projects.demoChat', "Fix the sign-in button");
	};
	draw();
}

function contextPreview(parent: HTMLElement, store: DisposableStore): void {
	demoBar(parent, localize('picodeWhatsNew.context.demo', "Compact the conversation and watch the room come back."), store);
	// A made-up conversation in a 200k window: compacting shrinks the messages to a summary.
	const window = 200_000;
	const reserve = 16_000;
	const fixed = [
		{ id: 'project', label: localize('picode.overview.contextProject', "Project instructions"), tokens: 6_000 },
		{ id: 'pi', label: localize('picode.overview.contextPi', "pi instructions"), tokens: 4_000 },
		{ id: 'skills', label: localize('picode.overview.contextSkills', "Skills"), tokens: 3_000 },
		{ id: 'tools', label: localize('picode.overview.contextTools', "pi tools"), tokens: 9_000 },
		{ id: 'mcp', label: localize('picode.overview.contextMcp', "MCP tools"), tokens: 12_000 },
	];
	let messages = 118_000;
	const stage = append(parent, $('.picode-whatsnew-list.picode-whatsnew-context'));
	const format = (tokens: number) => `${Number((tokens / 1000).toFixed(1))}k`;
	const draw = () => {
		clearNode(stage);
		const parts = [{ id: 'messages', label: localize('picode.overview.contextMessages', "Messages"), tokens: messages }, ...fixed];
		const used = parts.reduce((total, part) => total + part.tokens, 0);
		const head = append(stage, $('.picode-whatsnew-row.head'));
		append(head, $('span.picode-whatsnew-row-label')).textContent = localize('picode.overview.contextPercent', "{0}% used", Math.round((used / window) * 100));
		append(head, $('span.picode-whatsnew-row-detail')).textContent = `${format(used)} / ${format(window)}`;
		const bar = append(stage, $('.picode-whatsnew-context-bar'));
		for (const part of [...parts, { id: 'reserve', tokens: reserve }]) {
			append(bar, $(`.picode-whatsnew-context-piece.${part.id}`)).style.width = `${(part.tokens / window) * 100}%`;
		}
		for (const part of parts) {
			const row = append(stage, $('.picode-whatsnew-row'));
			append(row, $(`span.picode-whatsnew-context-swatch.${part.id}`));
			append(row, $('span.picode-whatsnew-row-label')).textContent = part.label;
			append(row, $('span.picode-whatsnew-row-detail')).textContent = format(part.tokens);
		}
		const room = append(stage, $('.picode-whatsnew-row'));
		append(room, $('span.picode-whatsnew-context-swatch.free'));
		append(room, $('span.picode-whatsnew-row-label')).textContent = localize('picode.overview.contextFree', "Room before compacting");
		append(room, $('span.picode-whatsnew-row-detail')).textContent = format(Math.max(0, window - reserve - used));
		const button = append(stage, $('button.picode-whatsnew-button.secondary', { type: 'button' })) as HTMLButtonElement;
		button.textContent = localize('picode.overview.contextCompact', "Compact session");
		button.disabled = messages < 20_000;
		store.add(addDisposableListener(button, EventType.CLICK, () => {
			messages = 9_000;
			draw();
		}));
	};
	draw();
}

function statusSectionsPreview(parent: HTMLElement, store: DisposableStore): void {
	demoBar(parent, localize('picodeWhatsNew.statusSections.demo', "Fold a section with its arrow, or untick it to hide it."), store);
	// Made-up sections; Environment has no arrow, as in the real column.
	const sections = [
		{ id: 'environment', title: localize('picode.overview.environment', "Environment"), rows: [localize('picode.overview.thisComputer', "This computer")], open: true, shown: true, foldable: false },
		{ id: 'tasks', title: localize('picode.overview.tasks', "Tasks"), rows: [localize('picode.overview.idle', "Nothing running")], open: true, shown: true, foldable: true },
		{ id: 'jira', title: localize('picodeIssuesJiraTitle', "Jira issues"), rows: [localize('picodeWhatsNew.board.card1', "The sign-in button does nothing"), localize('picodeWhatsNew.board.card2', "Translate the settings page")], open: false, shown: true, foldable: true },
		{ id: 'memory', title: localize('picode.overview.memory', "Memory"), rows: [localize('picodeWhatsNew.statusSections.memoryRow', "10 memories")], open: true, shown: true, foldable: true },
	];
	const stage = append(parent, $('.picode-whatsnew-exclude'));
	const column = append(stage, $('.picode-whatsnew-tree'));
	const ticks = append(stage, $('.picode-whatsnew-list'));
	const draw = () => {
		clearNode(column);
		for (const section of sections.filter(candidate => candidate.shown)) {
			const title = append(column, $('.picode-whatsnew-tree-row.picode-whatsnew-section-title'));
			if (section.foldable) {
				append(title, $(`span${ThemeIcon.asCSSSelector(section.open ? Codicon.chevronDown : Codicon.chevronRight)}`));
				title.classList.add('clickable');
				store.add(addDisposableListener(title, EventType.CLICK, () => {
					section.open = !section.open;
					draw();
				}));
			}
			append(title, $('span')).textContent = section.title;
			if (section.open) {
				for (const text of section.rows) {
					const row = append(column, $('.picode-whatsnew-tree-row'));
					row.style.paddingLeft = '22px';
					append(row, $('span')).textContent = text;
				}
			}
		}
	};
	for (const section of sections) {
		const label = append(ticks, $('label.picode-whatsnew-row.toggle'));
		const input = append(label, $('input', { type: 'checkbox' })) as HTMLInputElement;
		input.checked = section.shown;
		append(label, $('span.picode-whatsnew-row-label')).textContent = section.title;
		store.add(addDisposableListener(input, EventType.CHANGE, () => {
			section.shown = input.checked;
			draw();
		}));
	}
	draw();
}

function problemsPreview(parent: HTMLElement, store: DisposableStore): void {
	demoBar(parent, localize('picodeWhatsNew.problems.demo', "Compare a big file with many problems."), store);
	// A file with 1,200 problems: before, only the first 500 were underlined.
	const total = 1200;
	const lines = ['const a = undefinedValue;', 'let b: number = "text";', 'callMissing();', 'import { gone } from "./gone";', 'const c = a.missing.deep;', 'return;'];
	const format = (value: number) => value.toLocaleString(platformLanguage);
	let stage: HTMLElement;
	const pick = demoTabs(parent, store, [['before', localize('picodeWhatsNew.before', "Before")], ['now', localize('picodeWhatsNew.now', "Now")]], mode => {
		clearNode(stage);
		const code = append(stage, $('.picode-whatsnew-diff-view'));
		lines.forEach((text, index) => {
			const line = append(code, $('.picode-whatsnew-diff-line'));
			const number = index * 240 + 1;
			append(line, $('span.picode-whatsnew-code-number')).textContent = String(number);
			const content = append(line, $('span')) as HTMLElement;
			content.textContent = text;
			// Lines past the old limit stay plain before; now every problem is underlined.
			content.classList.toggle('picode-whatsnew-squiggle', mode === 'now' || number <= 500);
		});
		const count = append(stage, $('.picode-whatsnew-row'));
		append(count, $(`span.picode-whatsnew-row-icon${ThemeIcon.asCSSSelector(Codicon.warning)}`));
		append(count, $('span.picode-whatsnew-row-label')).textContent = localize('picodeWhatsNew.problems.count', "Underlined in this file: {0} of {1}", format(mode === 'before' ? 500 : total), format(total));
	});
	stage = append(parent, $('.picode-whatsnew-extension'));
	pick('now');
}
