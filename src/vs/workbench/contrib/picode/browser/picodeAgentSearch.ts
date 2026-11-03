/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { ACTION_ID_NEW_CHAT } from '../../chat/browser/actions/chatActions.js';
import { IAgentSession } from '../../chat/browser/agentSessions/agentSessionsModel.js';
import { openSession } from '../../chat/browser/agentSessions/agentSessionsOpener.js';
import { IAgentSessionsService } from '../../chat/browser/agentSessions/agentSessionsService.js';
import { ChatSessionStatus } from '../../chat/common/chatSessionsService.js';

/**
 * The Agent layout's search: a window in the middle of the screen, over a dimmed workbench, for
 * every conversation — the ones waiting for you first, then the recent ones, then what you can
 * start. Typing filters them all; arrows move, Enter opens, Escape closes.
 *
 * It is its own small window rather than the quick input, which drops from the top of the window
 * and reads as the command palette.
 */
export const PICODE_AGENT_SEARCH_COMMAND_ID = 'picode.agent.search';

/** The editor's page for agents, skills, MCP servers and models (the chat's own gear opened it). */
export const PICODE_CUSTOMIZATION_COMMAND_ID = 'aiCustomization.openManagementEditor';

export const PICODE_AGENT_SEARCH_ICON: ThemeIcon = Codicon.search;
export const PICODE_CUSTOMIZATION_ICON: ThemeIcon = Codicon.settingsGear;

interface ISearchEntry {
	readonly section: string;
	readonly icon: ThemeIcon;
	readonly label: string;
	readonly detail?: string;
	run(): void;
}

/** When the session last moved: its last answer, else its last question, else its start. */
function lastActivity(session: IAgentSession): number {
	return session.timing.lastRequestEnded ?? session.timing.lastRequestStarted ?? session.timing.created;
}

/** Waiting on the person: a question pending, still running, or an answer not yet read. */
function needsAttention(session: IAgentSession): boolean {
	return session.status === ChatSessionStatus.NeedsInput || session.status === ChatSessionStatus.InProgress || !session.isRead();
}

function showSearchWindow(accessor: ServicesAccessor): void {
	const layoutService = accessor.get(IWorkbenchLayoutService);
	const agentSessionsService = accessor.get(IAgentSessionsService);
	const commandService = accessor.get(ICommandService);
	const instantiationService = accessor.get(IInstantiationService);

	const attention = localize('picode.agent.search.attention', "Needs attention");
	const recent = localize('picode.agent.search.recent', "Recent");
	const actions = localize('picode.agent.search.actions', "Actions");

	const disposables = new DisposableStore();
	const close = () => disposables.dispose();

	const sessions = agentSessionsService.model.sessions
		.filter(session => !session.isArchived())
		.sort((a, b) => lastActivity(b) - lastActivity(a));
	const entries: ISearchEntry[] = [
		...sessions.map(session => ({
			section: needsAttention(session) ? attention : recent,
			icon: session.status === ChatSessionStatus.InProgress ? Codicon.loading : Codicon.commentDiscussion,
			label: session.label,
			detail: fromNow(lastActivity(session), true),
			run: () => void instantiationService.invokeFunction(openSession, session),
		})),
		{ section: actions, icon: Codicon.add, label: localize('picode.agent.search.new', "New session"), run: () => void commandService.executeCommand(ACTION_ID_NEW_CHAT) },
		{ section: actions, icon: PICODE_CUSTOMIZATION_ICON, label: localize('picode.agent.search.customization', "Customization"), run: () => void commandService.executeCommand(PICODE_CUSTOMIZATION_COMMAND_ID) },
	];
	const order = [attention, recent, actions];

	// The window: a dimmed backdrop that closes it, and the card in the middle.
	const backdrop = append(layoutService.activeContainer, $('.picode-search-backdrop'));
	disposables.add({ dispose: () => backdrop.remove() });
	const card = append(backdrop, $('.picode-search', { role: 'dialog', 'aria-label': localize('picode.agent.search.title', "Search") }));
	const header = append(card, $('.picode-search-header'));
	append(header, $(`span.picode-search-header-icon${ThemeIcon.asCSSSelector(Codicon.search)}`));
	const input = append(header, $('input.picode-search-input', { type: 'text', spellcheck: 'false', placeholder: localize('picode.agent.search.placeholder', "Search your sessions") })) as HTMLInputElement;
	const closeButton = append(header, $(`button.picode-search-close${ThemeIcon.asCSSSelector(Codicon.close)}`, { type: 'button', title: localize('picode.agent.search.close', "Close") }));
	const results = append(card, $('.picode-search-results', { role: 'listbox' }));
	const footer = append(card, $('.picode-search-footer'));
	for (const [label, key] of [[localize('picode.agent.search.closeHint', "Close"), 'Esc'], [localize('picode.agent.search.moveHint', "Move"), '↑ ↓'], [localize('picode.agent.search.openHint', "Open"), '↵']]) {
		const hint = append(footer, $('span.picode-search-hint'));
		hint.textContent = `${label} `;
		append(hint, $('kbd')).textContent = key;
	}

	let shown: ISearchEntry[] = [];
	let active = 0;

	const render = () => {
		const query = input.value.trim().toLowerCase();
		shown = entries.filter(entry => query === '' || entry.label.toLowerCase().includes(query));
		shown.sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section));
		active = Math.min(active, Math.max(0, shown.length - 1));
		clearNode(results);
		if (shown.length === 0) {
			append(results, $('.picode-search-empty')).textContent = localize('picode.agent.search.none', "No sessions match");
			return;
		}
		let section: string | undefined;
		shown.forEach((entry, index) => {
			if (entry.section !== section) {
				section = entry.section;
				append(results, $('.picode-search-section')).textContent = section;
			}
			const row = append(results, $('.picode-search-row', { role: 'option' }));
			row.classList.toggle('active', index === active);
			append(row, $(`span.picode-search-row-icon${ThemeIcon.asCSSSelector(entry.icon)}`));
			append(row, $('span.picode-search-row-label')).textContent = entry.label;
			if (entry.detail) {
				append(row, $('span.picode-search-row-detail')).textContent = entry.detail;
			}
			disposables.add(addDisposableListener(row, EventType.MOUSE_MOVE, () => {
				if (active !== index) {
					active = index;
					render();
				}
			}));
			disposables.add(addDisposableListener(row, EventType.CLICK, () => {
				close();
				entry.run();
			}));
			if (index === active) {
				row.scrollIntoView({ block: 'nearest' });
			}
		});
	};

	disposables.add(addDisposableListener(input, EventType.INPUT, () => {
		active = 0;
		render();
	}));
	disposables.add(addDisposableListener(card, EventType.KEY_DOWN, e => {
		const event = new StandardKeyboardEvent(e);
		if (event.equals(KeyCode.Escape)) {
			event.preventDefault();
			close();
		} else if (event.equals(KeyCode.DownArrow) && shown.length > 0) {
			event.preventDefault();
			active = (active + 1) % shown.length;
			render();
		} else if (event.equals(KeyCode.UpArrow) && shown.length > 0) {
			event.preventDefault();
			active = (active - 1 + shown.length) % shown.length;
			render();
		} else if (event.equals(KeyCode.Enter) && shown[active]) {
			event.preventDefault();
			const entry = shown[active];
			close();
			entry.run();
		}
	}));
	disposables.add(addDisposableListener(backdrop, EventType.MOUSE_DOWN, e => {
		if (e.target === backdrop) {
			close();
		}
	}));
	disposables.add(addDisposableListener(closeButton, EventType.CLICK, close));

	render();
	input.focus();
}

registerAction2(class PicodeAgentSearchAction extends Action2 {
	constructor() {
		super({
			id: PICODE_AGENT_SEARCH_COMMAND_ID,
			title: localize2('picode.agent.search', "Search Sessions"),
			category: localize2('picode.category', "PiCode"),
			icon: Codicon.search,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		showSearchWindow(accessor);
	}
});
