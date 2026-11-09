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
		case 'showTasks':
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
