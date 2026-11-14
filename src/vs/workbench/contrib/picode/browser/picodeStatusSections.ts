/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, EventType, getWindow } from '../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { Separator, toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/**
 * Which sections of the Status column show and which are folded, the same for the column and its
 * tab (they are one component) and kept with the profile. Hidden sections come back from the
 * right-click menu of any section title, the Status tab's menu or the Command Palette.
 */
export type PicodeStatusSectionId = 'environment' | 'context' | 'connectors' | 'changes' | 'tasks' | 'github' | 'jira' | 'memory';

const SECTIONS_KEY = 'picode.status.sections';

/** Folded until opened: the MCP list only shows the ones that need the user. */
const FOLDED_BY_DEFAULT: ReadonlySet<PicodeStatusSectionId> = new Set(['connectors']);

/** The one section with no arrow: where the agent works is always one or two lines. */
const NOT_FOLDABLE: ReadonlySet<PicodeStatusSectionId> = new Set(['environment']);

function sectionLabels(): readonly (readonly [PicodeStatusSectionId, string])[] {
	return [
		['environment', localize('picode.overview.environment', "Environment")],
		['context', localize('picode.overview.context', "Context")],
		['connectors', localize('picode.overview.connectors', "MCPs")],
		['changes', localize('picode.overview.changes', "Changes")],
		['tasks', localize('picode.overview.tasks', "Tasks")],
		['github', localize('picodeIssuesGithubTitle', "GitHub issues")],
		['jira', localize('picodeIssuesJiraTitle', "Jira issues")],
		['memory', localize('picode.overview.memory', "Memory")],
	];
}

interface IStored {
	readonly hidden?: readonly string[];
	/** Every section whose fold differs from its default. */
	readonly flipped?: readonly string[];
}

const onDidChangeEmitter = new Emitter<void>();

/** Fires when a section is hidden, shown, folded or unfolded, here or in another window. */
export const onDidChangePicodeStatusSections: Event<void> = onDidChangeEmitter.event;

let watching = false;

function read(storage: IStorageService): { hidden: Set<string>; flipped: Set<string> } {
	if (!watching) {
		watching = true;
		// Another window of the same profile changed them.
		storage.onDidChangeValue(StorageScope.PROFILE, SECTIONS_KEY, new DisposableStore())(() => onDidChangeEmitter.fire());
	}
	try {
		const stored = JSON.parse(storage.get(SECTIONS_KEY, StorageScope.PROFILE) ?? '{}') as IStored;
		return { hidden: new Set(stored.hidden ?? []), flipped: new Set(stored.flipped ?? []) };
	} catch {
		return { hidden: new Set(), flipped: new Set() };
	}
}

function write(storage: IStorageService, state: { hidden: Set<string>; flipped: Set<string> }): void {
	const stored: IStored = { hidden: [...state.hidden], flipped: [...state.flipped] };
	storage.store(SECTIONS_KEY, JSON.stringify(stored), StorageScope.PROFILE, StorageTarget.USER);
	onDidChangeEmitter.fire();
}

export function isStatusSectionHidden(storage: IStorageService, id: PicodeStatusSectionId): boolean {
	return read(storage).hidden.has(id);
}

export function isStatusSectionFolded(storage: IStorageService, id: PicodeStatusSectionId): boolean {
	if (NOT_FOLDABLE.has(id)) {
		return false;
	}
	return FOLDED_BY_DEFAULT.has(id) !== read(storage).flipped.has(id);
}

/** Whether every section is hidden: the column then says so, with a way back. */
export function areAllStatusSectionsHidden(storage: IStorageService): boolean {
	const hidden = read(storage).hidden;
	return sectionLabels().every(([id]) => hidden.has(id));
}

function setHidden(storage: IStorageService, ids: readonly PicodeStatusSectionId[], hidden: boolean): void {
	const state = read(storage);
	for (const id of ids) {
		if (hidden) {
			state.hidden.add(id);
		} else {
			state.hidden.delete(id);
		}
	}
	write(storage, state);
}

function toggleFolded(storage: IStorageService, id: PicodeStatusSectionId): void {
	const state = read(storage);
	if (!state.flipped.delete(id)) {
		state.flipped.add(id);
	}
	write(storage, state);
}

export function showAllStatusSections(storage: IStorageService): void {
	setHidden(storage, sectionLabels().map(([id]) => id), false);
}

/** The menu of every section, each with its tick: unticking one hides it. */
export function showStatusSectionsMenu(contextMenuService: IContextMenuService, storage: IStorageService, anchor: HTMLElement | StandardMouseEvent): void {
	const hidden = read(storage).hidden;
	contextMenuService.showContextMenu({
		getAnchor: () => anchor,
		getActions: () => [
			...sectionLabels().map(([id, label]) => toAction({
				id: `picode.status.section.${id}`,
				label,
				checked: !hidden.has(id),
				run: () => setHidden(storage, [id], !hidden.has(id)),
			})),
			new Separator(),
			toAction({
				id: 'picode.status.section.all',
				label: localize('picode.status.showAllSections', "Show all sections"),
				enabled: hidden.size > 0,
				run: () => showAllStatusSections(storage),
			}),
		],
	});
}

/** The same choice as a list with checkboxes, for the Command Palette and the Status tab's menu. */
export async function pickStatusSections(quickInputService: IQuickInputService, storage: IStorageService): Promise<void> {
	const hidden = read(storage).hidden;
	const items: (IQuickPickItem & { readonly section: PicodeStatusSectionId })[] = sectionLabels().map(([id, label]) => ({ label, section: id, picked: !hidden.has(id) }));
	const picked = await quickInputService.pick(items, {
		canPickMany: true,
		placeHolder: localize('picode.status.pickSections', "Choose the sections Status shows"),
	});
	if (!picked) {
		return;
	}
	const shown = new Set(picked.map(item => item.section));
	const state = read(storage);
	state.hidden = new Set(sectionLabels().map(([id]) => id).filter(id => !shown.has(id)));
	write(storage, state);
}

/**
 * Gives a section title its arrow (all but Environment) and its right-click menu. Clicking the
 * title folds or unfolds the section; buttons inside the title keep their own clicks.
 */
export function decorateStatusSectionTitle(title: HTMLElement, id: PicodeStatusSectionId, store: DisposableStore, contextMenuService: IContextMenuService, storage: IStorageService, withMenu = true): void {
	if (withMenu) {
		store.add(addDisposableListener(title, EventType.CONTEXT_MENU, e => {
			e.preventDefault();
			e.stopPropagation();
			showStatusSectionsMenu(contextMenuService, storage, new StandardMouseEvent(getWindow(title), e));
		}));
	}
	if (NOT_FOLDABLE.has(id)) {
		return;
	}
	const folded = isStatusSectionFolded(storage, id);
	title.prepend($(`span.picode-overview-twistie${ThemeIcon.asCSSSelector(folded ? Codicon.chevronRight : Codicon.chevronDown)}`));
	title.classList.add('picode-overview-foldable');
	title.setAttribute('aria-expanded', String(!folded));
	store.add(addDisposableListener(title, EventType.CLICK, e => {
		if (!(e.target instanceof HTMLElement && e.target.closest('button'))) {
			toggleFolded(storage, id);
		}
	}));
}
