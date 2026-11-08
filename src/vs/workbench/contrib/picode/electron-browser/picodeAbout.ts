/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../browser/media/picodeAbout.css';
import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { createNativeAboutDialogDetails } from '../../../../platform/dialogs/electron-browser/dialog.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IUpdateService, State, StateType } from '../../../../platform/update/common/update.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';

const REPOSITORY_URL = 'https://github.com/Tomas-Platero/PiCode';
const WHATS_NEW_COMMAND = 'picode.showWhatsNew';
const BEST_SCORE_KEY = 'picode.about.bugHunt.best';

/** Clicks on the mascot that start the game, and how long each one waits for the next. */
const CLICKS_TO_PLAY = 7;
const CLICK_WINDOW_MS = 1500;
const GAME_SECONDS = 15;
const BUG_EVERY_MS = 620;
const BUG_LIFE_MS = 1300;
/** How far the eyes move inside the head, in the logo's units. */
const EYE_TRAVEL = 15;

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
	const element = document.createElementNS(SVG_NS, tag);
	for (const [name, value] of Object.entries(attributes)) {
		element.setAttribute(name, String(value));
	}
	parent.appendChild(element);
	return element;
}

/** The PiCode logo (`extensions/picode/media/picode-status.svg`), with its eyes apart so they can move. */
function renderMascot(parent: HTMLElement): { readonly look: SVGGElement; readonly root: SVGSVGElement } {
	const root = svg(parent as unknown as Element, 'svg', { viewBox: '118 116 788 788', 'aria-hidden': 'true' });
	const body = svg(root, 'g', { transform: 'translate(0,92)', fill: 'none', 'stroke-width': 84, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'picode-about-body' });
	svg(body, 'path', { d: 'M512 200 V152', 'stroke-width': 60 });
	svg(body, 'circle', { cx: 512, cy: 112, r: 48, class: 'picode-about-antenna' });
	svg(body, 'path', { d: 'M360 640 V262 Q360 200 422 200 H602 Q664 200 664 262 V640' });
	svg(body, 'path', { d: 'M268 432 H756' });
	const blink = svg(body, 'g', { class: 'picode-about-blink' });
	const look = svg(blink, 'g', {});
	svg(look, 'circle', { cx: 452, cy: 316, r: 34, class: 'picode-about-eye' });
	svg(look, 'circle', { cx: 572, cy: 316, r: 34, class: 'picode-about-eye' });
	svg(body, 'path', { d: 'M424 590 L360 660 L424 730', class: 'picode-about-chevron' });
	svg(body, 'path', { d: 'M600 590 L664 660 L600 730', class: 'picode-about-chevron' });
	return { look, root };
}

let openWindow: { readonly focus: () => void } | undefined;

async function showAboutWindow(accessor: ServicesAccessor): Promise<void> {
	if (openWindow) {
		openWindow.focus();
		return;
	}
	const layoutService = accessor.get(IWorkbenchLayoutService);
	const productService = accessor.get(IProductService);
	const nativeHostService = accessor.get(INativeHostService);
	const commandService = accessor.get(ICommandService);
	const clipboardService = accessor.get(IClipboardService);
	const openerService = accessor.get(IOpenerService);
	const updateService = accessor.get(IUpdateService);
	const storageService = accessor.get(IStorageService);

	const disposables = new DisposableStore();
	const previousFocus = layoutService.activeContainer.ownerDocument.activeElement as HTMLElement | null;
	const close = () => {
		openWindow = undefined;
		disposables.dispose();
		previousFocus?.focus();
	};

	const backdrop = append(layoutService.activeContainer, $('.picode-about-backdrop'));
	disposables.add(toDisposable(() => backdrop.remove()));
	const card = append(backdrop, $('.picode-about', { role: 'dialog', 'aria-modal': 'true', 'aria-label': localize('picodeAbout.title', "About PiCode"), tabindex: '-1' }));
	openWindow = { focus: () => card.focus() };

	const closeButton = append(card, $(`button.picode-about-close${ThemeIcon.asCSSSelector(Codicon.close)}`, { type: 'button', title: localize('picodeAbout.close', "Close"), 'aria-label': localize('picodeAbout.close', "Close") }));
	disposables.add(addDisposableListener(closeButton, EventType.CLICK, close));

	/** A copy button that says so for a moment. */
	const copyFeedback = (icon: HTMLElement) => {
		const copied = ThemeIcon.asClassNameArray(Codicon.check);
		const copy = ThemeIcon.asClassNameArray(Codicon.copy);
		icon.classList.remove(...copy);
		icon.classList.add(...copied);
		disposables.add(disposableTimeout(() => {
			icon.classList.remove(...copied);
			icon.classList.add(...copy);
		}, 1200));
	};

	// -- The top: the mascot, the name and the version ---------------------------------------------

	const hero = append(card, $('.picode-about-hero'));
	const mascotButton = append(hero, $('button.picode-about-mascot', { type: 'button', 'aria-label': 'PiCode' })) as HTMLButtonElement;
	const mascot = renderMascot(mascotButton);
	const nameRow = append(hero, $('.picode-about-name'));
	append(nameRow, $('span')).textContent = 'PiCode';
	const channel = productService.quality && productService.quality !== 'stable' ? productService.quality : undefined;
	if (channel) {
		append(nameRow, $('span.picode-about-channel')).textContent = channel === 'experimental'
			? localize('picodeAbout.channel.experimental', "Experimental")
			: channel === 'beta' ? localize('picodeAbout.channel.beta', "Beta") : channel;
	}
	append(hero, $('.picode-about-tagline')).textContent = localize('picodeAbout.tagline', "The code editor with a built-in agent. Free and open source.");
	const version = productService.picodeVersion ?? productService.version;
	const versionButton = append(hero, $('button.picode-about-version', { type: 'button', title: localize('picodeAbout.copyVersion', "Copy version") }));
	append(versionButton, $('span')).textContent = localize('picodeAbout.version', "Version {0}", version.replace(/-.*$/, ''));
	const versionIcon = append(versionButton, $(`span${ThemeIcon.asCSSSelector(Codicon.copy)}`));
	disposables.add(addDisposableListener(versionButton, EventType.CLICK, () => {
		void clipboardService.writeText(version);
		copyFeedback(versionIcon);
	}));

	// The eyes follow the pointer and the light behind them too.
	disposables.add(addDisposableListener(getWindow(card), EventType.MOUSE_MOVE, (e: MouseEvent) => {
		const box = mascotButton.getBoundingClientRect();
		const dx = e.clientX - (box.left + box.width / 2);
		const dy = e.clientY - (box.top + box.height * 0.42);
		const distance = Math.max(Math.hypot(dx, dy), 1);
		const reach = Math.min(distance / 80, 1) * EYE_TRAVEL;
		mascot.look.setAttribute('transform', `translate(${(dx / distance * reach).toFixed(1)},${(dy / distance * reach).toFixed(1)})`);
		const heroBox = hero.getBoundingClientRect();
		hero.style.setProperty('--picode-about-x', `${e.clientX - heroBox.left}px`);
		hero.style.setProperty('--picode-about-y', `${e.clientY - heroBox.top}px`);
	}));

	// -- A small game behind the mascot -------------------------------------------------------------

	const gameStore = disposables.add(new DisposableStore());
	const game = append(hero, $('.picode-about-game'));
	const endGame = () => {
		gameStore.clear();
		clearNode(game);
		hero.classList.remove('playing');
	};
	const startGame = () => {
		gameStore.clear();
		clearNode(game);
		hero.classList.add('playing');
		let score = 0;
		let left = GAME_SECONDS;
		const status = append(game, $('.picode-about-game-status'));
		const paint = () => status.textContent = `🐞 ${score} · ⏱ ${left}`;
		paint();
		const field = append(game, $('.picode-about-game-field'));
		const win = getWindow(hero);
		const spawn = win.setInterval(() => {
			const bug = append(field, $(`button.picode-about-bug${ThemeIcon.asCSSSelector(Codicon.bug)}`, { type: 'button', 'aria-label': localize('picodeAbout.game.bug', "Bug") }));
			bug.style.left = `${4 + Math.random() * 84}%`;
			bug.style.top = `${4 + Math.random() * 78}%`;
			gameStore.add(disposableTimeout(() => bug.remove(), BUG_LIFE_MS));
			gameStore.add(addDisposableListener(bug, EventType.MOUSE_DOWN, e => {
				e.preventDefault();
				score++;
				paint();
				bug.remove();
			}));
		}, BUG_EVERY_MS);
		const clock = win.setInterval(() => {
			left--;
			paint();
			if (left <= 0) {
				showResult(score);
			}
		}, 1000);
		gameStore.add(toDisposable(() => {
			win.clearInterval(spawn);
			win.clearInterval(clock);
		}));
	};
	const showResult = (score: number) => {
		gameStore.clear();
		clearNode(game);
		const best = Math.max(score, storageService.getNumber(BEST_SCORE_KEY, StorageScope.APPLICATION, 0));
		storageService.store(BEST_SCORE_KEY, best, StorageScope.APPLICATION, StorageTarget.USER);
		const result = append(game, $('.picode-about-game-result'));
		append(result, $('.picode-about-game-score')).textContent = localize('picodeAbout.game.score', "Bugs fixed: {0} 🎉", score);
		append(result, $('.picode-about-game-best')).textContent = localize('picodeAbout.game.best', "Your best: {0}", best);
		const buttons = append(result, $('.picode-about-game-buttons'));
		const again = append(buttons, $('button.picode-about-button', { type: 'button' }));
		again.textContent = localize('picodeAbout.game.again', "Play again");
		gameStore.add(addDisposableListener(again, EventType.CLICK, startGame));
		const done = append(buttons, $('button.picode-about-button.secondary', { type: 'button' }));
		done.textContent = localize('picodeAbout.game.done', "Done");
		gameStore.add(addDisposableListener(done, EventType.CLICK, endGame));
	};
	let clicks = 0;
	const clickReset = disposables.add(new DisposableStore());
	disposables.add(addDisposableListener(mascotButton, EventType.CLICK, () => {
		clickReset.clear();
		clicks++;
		if (!getWindow(card).matchMedia('(prefers-reduced-motion: reduce)').matches) {
			mascot.root.animate([
				{ transform: 'translateY(0) scale(1)' },
				{ transform: 'translateY(-10px) scale(1.05)' },
				{ transform: 'translateY(0) scale(1)' },
			], { duration: 280, easing: 'ease-out' });
		}
		mascotButton.style.setProperty('--picode-about-charge', String(clicks / CLICKS_TO_PLAY));
		if (clicks >= CLICKS_TO_PLAY) {
			clicks = 0;
			mascotButton.style.removeProperty('--picode-about-charge');
			startGame();
			return;
		}
		clickReset.add(disposableTimeout(() => {
			clicks = 0;
			mascotButton.style.removeProperty('--picode-about-charge');
		}, CLICK_WINDOW_MS));
	}));

	// -- Updates ------------------------------------------------------------------------------------

	const updateRow = append(card, $('.picode-about-update'));
	const updateStore = disposables.add(new DisposableStore());
	let checked = false;
	const renderUpdate = (state: State) => {
		updateStore.clear();
		clearNode(updateRow);
		const line = (icon: ThemeIcon, text: string, button?: { readonly label: string; readonly run: () => void }, spin?: boolean) => {
			const iconNode = append(updateRow, $(`span.picode-about-update-icon${ThemeIcon.asCSSSelector(icon)}`));
			iconNode.classList.toggle('codicon-modifier-spin', !!spin);
			append(updateRow, $('span.picode-about-update-text')).textContent = text;
			if (button) {
				const node = append(updateRow, $('button.picode-about-button', { type: 'button' }));
				node.textContent = button.label;
				updateStore.add(addDisposableListener(node, EventType.CLICK, button.run));
			}
		};
		const check = {
			label: localize('picodeAbout.update.check', "Check for updates"),
			run: () => {
				checked = true;
				// Not `explicit`: the answer is said here, without the editor's own dialog on top.
				void updateService.checkForUpdates(false);
			},
		};
		switch (state.type) {
			case StateType.Disabled:
				line(Codicon.circleSlash, localize('picodeAbout.update.off', "Updates are turned off"));
				break;
			case StateType.Uninitialized:
				line(Codicon.cloud, localize('picodeAbout.update.idle', "Get the latest version"));
				break;
			case StateType.Idle:
				if (checked && state.error) {
					line(Codicon.warning, localize('picodeAbout.update.failed', "Could not check for updates"), check);
				} else if (checked) {
					line(Codicon.passFilled, localize('picodeAbout.update.latest', "You have the latest version"), check);
				} else {
					line(Codicon.cloud, localize('picodeAbout.update.idle', "Get the latest version"), check);
				}
				break;
			case StateType.CheckingForUpdates:
				line(Codicon.sync, localize('picodeAbout.update.checking', "Looking for updates…"), undefined, true);
				break;
			case StateType.AvailableForDownload:
				line(Codicon.gift, localize('picodeAbout.update.available', "An update is available"), {
					label: localize('picodeAbout.update.download', "Download"),
					run: () => void commandService.executeCommand('update.downloadNow'),
				});
				break;
			case StateType.Downloaded:
				line(Codicon.gift, localize('picodeAbout.update.downloaded', "The update is ready to install"), {
					label: localize('picodeAbout.update.install', "Install"),
					run: () => void commandService.executeCommand('update.install'),
				});
				break;
			case StateType.Ready:
				line(Codicon.gift, localize('picodeAbout.update.ready', "Restart to finish updating"), {
					label: localize('picodeAbout.update.restart', "Restart"),
					run: () => void commandService.executeCommand('update.restart'),
				});
				break;
			default:
				line(Codicon.sync, localize('picodeAbout.update.working', "Updating…"), undefined, true);
		}
	};
	renderUpdate(updateService.state);
	disposables.add(updateService.onStateChange(renderUpdate));

	// -- Where to go next ---------------------------------------------------------------------------

	const links = append(card, $('.picode-about-links'));
	const link = (icon: ThemeIcon, label: string, run: () => void) => {
		const node = append(links, $('button.picode-about-link', { type: 'button' }));
		append(node, $(`span${ThemeIcon.asCSSSelector(icon)}`));
		append(node, $('span.picode-about-link-label')).textContent = label;
		disposables.add(addDisposableListener(node, EventType.CLICK, run));
	};
	const open = (url: string) => () => void openerService.open(URI.parse(url), { openExternal: true });
	link(Codicon.sparkle, localize('picodeAbout.link.whatsNew', "What's new"), () => {
		close();
		void commandService.executeCommand(WHATS_NEW_COMMAND);
	});
	const website = productService.picode?.webOrigin;
	if (website) {
		link(Codicon.globe, localize('picodeAbout.link.website', "Website"), open(website));
	}
	link(Codicon.github, 'GitHub', open(REPOSITORY_URL));
	if (productService.reportIssueUrl) {
		link(Codicon.bug, localize('picodeAbout.link.report', "Report a problem"), open(productService.reportIssueUrl));
	}
	if (productService.licenseUrl) {
		link(Codicon.law, localize('picodeAbout.link.license', "License"), open(productService.licenseUrl));
	}

	// -- The details, folded ------------------------------------------------------------------------

	const detailsHead = append(card, $('.picode-about-details-head'));
	const toggle = append(detailsHead, $('button.picode-about-details-toggle', { type: 'button', 'aria-expanded': 'false' }));
	const chevron = append(toggle, $(`span${ThemeIcon.asCSSSelector(Codicon.chevronRight)}`));
	append(toggle, $('span')).textContent = localize('picodeAbout.details', "Technical details");
	const copyAll = append(detailsHead, $('button.picode-about-copy-all', { type: 'button' }));
	const copyAllIcon = append(copyAll, $(`span${ThemeIcon.asCSSSelector(Codicon.copy)}`));
	append(copyAll, $('span')).textContent = localize('picodeAbout.copyAll', "Copy all");
	const detailsBody = append(card, $('.picode-about-details'));
	detailsBody.hidden = true;
	disposables.add(addDisposableListener(toggle, EventType.CLICK, () => {
		detailsBody.hidden = !detailsBody.hidden;
		toggle.setAttribute('aria-expanded', String(!detailsBody.hidden));
		chevron.classList.toggle('picode-about-open', !detailsBody.hidden);
	}));

	const rowsStore = disposables.add(new DisposableStore());
	const osProperties = await nativeHostService.getOSProperties();
	if (disposables.isDisposed) {
		return;
	}
	let toCopy = '';
	const renderDetails = (agents?: { readonly piVersion?: string }) => {
		rowsStore.clear();
		clearNode(detailsBody);
		const details = createNativeAboutDialogDetails(productService, osProperties, agents);
		toCopy = details.detailsToCopy;
		// The first line is the version the top already shows; the second is the editor it is built on.
		details.details.split('\n').slice(1).forEach((text, index) => {
			const colon = text.indexOf(': ');
			const value = text.slice(colon + 2);
			if (value === 'Unknown') {
				return;
			}
			const row = append(detailsBody, $('button.picode-about-row', { type: 'button', title: localize('picodeAbout.copyRow', "Copy") }));
			append(row, $('span.picode-about-row-label')).textContent = index === 0 ? localize('picodeAbout.base', "VS Code base") : text.slice(0, colon);
			append(row, $('span.picode-about-row-value')).textContent = value;
			const icon = append(row, $(`span.picode-about-row-icon${ThemeIcon.asCSSSelector(Codicon.copy)}`));
			rowsStore.add(addDisposableListener(row, EventType.CLICK, () => {
				void clipboardService.writeText(value);
				copyFeedback(icon);
			}));
		});
	};
	renderDetails();
	disposables.add(addDisposableListener(copyAll, EventType.CLICK, () => {
		void clipboardService.writeText(toCopy);
		copyFeedback(copyAllIcon);
	}));
	// The agent's version comes from the connector, which may not be up: the window does not wait for it.
	void Promise.resolve(commandService.executeCommand<{ piVersion?: string }>('picode.setup.aboutVersions')).then(agents => {
		if (agents && !disposables.isDisposed) {
			renderDetails(agents);
		}
	}, () => undefined);

	// -- Closing and the keyboard -------------------------------------------------------------------

	disposables.add(addDisposableListener(backdrop, EventType.MOUSE_DOWN, e => {
		if (e.target === backdrop) {
			close();
		}
	}));
	disposables.add(addDisposableListener(card, EventType.KEY_DOWN, e => {
		const event = new StandardKeyboardEvent(e);
		if (event.equals(KeyCode.Escape)) {
			event.preventDefault();
			event.stopPropagation();
			if (hero.classList.contains('playing')) {
				endGame();
			} else {
				close();
			}
		} else if (event.equals(KeyCode.Tab) || event.equals(KeyMod.Shift | KeyCode.Tab)) {
			// The focus stays in the window while it is open.
			const focusable = [...card.querySelectorAll<HTMLElement>('button')].filter(node => node.offsetParent);
			const edge = event.shiftKey ? focusable[0] : focusable[focusable.length - 1];
			if (edge && (card.ownerDocument.activeElement === edge || card.ownerDocument.activeElement === card)) {
				event.preventDefault();
				(event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus();
			}
		}
	}));
	card.focus();
}

// Replaces what the core's Help > About runs (latest registration wins), so the menu entry and the
// palette command keep their place and their translations.
CommandsRegistry.registerCommand('workbench.action.showAboutDialog', accessor => showAboutWindow(accessor));
