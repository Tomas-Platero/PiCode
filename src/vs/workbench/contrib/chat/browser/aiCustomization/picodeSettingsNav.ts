/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/picodeSettings.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { settingsMatches } from '../../../picode/browser/settings/picodeSettingsData.js';
import { AICustomizationManagementSection, PicodeSettingsGroup, picodeSettingsGroupOf } from '../../common/aiCustomizationWorkspaceService.js';

const $ = DOM.$;

export interface IPicodeSettingsNavItem {
	readonly id: AICustomizationManagementSection;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly description: string;
	readonly count: number;
}

export interface IPicodeSettingsNavSelection {
	readonly id: AICustomizationManagementSection;
	/** Set when the page was reached from the search box: the page highlights the matching row. */
	readonly query?: string;
}

export interface IPicodeSettingsNavOptions {
	/** Extra words a page answers to in the search box (its row names). */
	getKeywords(id: AICustomizationManagementSection): readonly string[];
	/** Opens the full list of editor settings. */
	openAllSettings(query: string | undefined): void;
}

function groupLabel(group: PicodeSettingsGroup): string {
	switch (group) {
		case 'preferences': return localize('picodeSettingsGroupPreferences', "Preferences");
		case 'account': return localize('picodeSettingsGroupAccount', "Account");
		case 'agent': return localize('picodeSettingsGroupAgent', "Agent");
	}
}

/**
 * The side list of the Settings window: a search box, the pages grouped under
 * Preferences, Account and Agent, and a marker that slides to the page in view.
 * Plain buttons rather than a virtual list: there are twenty rows at most, and
 * the group headings and the sliding marker need real DOM around each row.
 */
export class PicodeSettingsNav extends Disposable {

	private readonly _onDidSelect = this._register(new Emitter<IPicodeSettingsNavSelection>());
	readonly onDidSelect: Event<IPicodeSettingsNavSelection> = this._onDidSelect.event;

	private readonly element: HTMLElement;
	private readonly searchInput: HTMLInputElement;
	private readonly list: HTMLElement;
	private readonly marker: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly rowStore = this._register(new DisposableStore());
	private readonly buttons = new Map<AICustomizationManagementSection, HTMLButtonElement>();
	private items: readonly IPicodeSettingsNavItem[] = [];
	private selected: AICustomizationManagementSection | undefined;

	constructor(container: HTMLElement, private readonly options: IPicodeSettingsNavOptions) {
		super();
		this.element = DOM.append(container, $('nav.picode-settings-nav'));
		this.element.setAttribute('aria-label', localize('picodeSettingsNavLabel', "Settings categories"));

		const search = DOM.append(this.element, $('.picode-settings-search'));
		search.appendChild(renderIcon(Codicon.search));
		this.searchInput = DOM.append(search, $('input')) as HTMLInputElement;
		this.searchInput.type = 'search';
		this.searchInput.placeholder = localize('picodeSettingsSearchPlaceholder', "Search");
		this.searchInput.setAttribute('aria-label', localize('picodeSettingsSearchLabel', "Search settings"));
		this._register(DOM.addDisposableListener(this.searchInput, DOM.EventType.INPUT, () => this.render()));
		this._register(DOM.addDisposableListener(this.searchInput, DOM.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.keyCode === KeyCode.Enter) {
				const first = this.visibleItems()[0];
				if (first) {
					this._onDidSelect.fire({ id: first.id, query: this.searchInput.value });
				} else if (this.searchInput.value.trim()) {
					this.options.openAllSettings(this.searchInput.value.trim());
				}
				event.preventDefault();
			} else if (event.keyCode === KeyCode.DownArrow) {
				this.buttons.get(this.visibleItems()[0]?.id)?.focus();
				event.preventDefault();
			} else if (event.keyCode === KeyCode.Escape && this.searchInput.value) {
				this.searchInput.value = '';
				this.render();
				event.preventDefault();
				event.stopPropagation();
			}
		}));

		const scroll = DOM.append(this.element, $('.picode-settings-nav-scroll'));
		this.list = DOM.append(scroll, $('.picode-settings-nav-list'));
		this.list.setAttribute('role', 'tablist');
		this.list.setAttribute('aria-orientation', 'vertical');
		this.marker = DOM.append(this.list, $('.picode-settings-nav-marker'));
		this.empty = DOM.append(scroll, $('.picode-settings-nav-empty'));

		const footer = DOM.append(this.element, $('.picode-settings-nav-footer'));
		const all = DOM.append(footer, $('button.picode-settings-nav-item')) as HTMLButtonElement;
		all.type = 'button';
		all.appendChild(renderIcon(Codicon.listFlat));
		DOM.append(all, $('span.picode-settings-nav-label')).textContent = localize('picodeSettingsAllSettings', "All settings");
		this._register(DOM.addDisposableListener(all, DOM.EventType.CLICK, () => this.options.openAllSettings(this.searchInput.value.trim() || undefined)));

		this._register(DOM.addDisposableListener(this.list, DOM.EventType.KEY_DOWN, e => this.onListKey(new StandardKeyboardEvent(e))));
	}

	setItems(items: readonly IPicodeSettingsNavItem[]): void {
		this.items = items;
		this.render();
	}

	setSelected(id: AICustomizationManagementSection | undefined): void {
		this.selected = id;
		for (const [itemId, button] of this.buttons) {
			const on = itemId === id;
			button.classList.toggle('selected', on);
			button.setAttribute('aria-selected', String(on));
			button.tabIndex = on ? 0 : -1;
		}
		this.moveMarker();
	}

	focusSearch(): void {
		this.searchInput.focus();
	}

	focusSelected(): void {
		(this.selected && this.buttons.get(this.selected) || this.searchInput).focus();
	}

	private visibleItems(): IPicodeSettingsNavItem[] {
		const query = this.searchInput.value;
		return this.items.filter(item => settingsMatches(query, item.label, this.options.getKeywords(item.id)));
	}

	private render(): void {
		this.rowStore.clear();
		this.buttons.clear();
		for (const child of [...this.list.children]) {
			if (child !== this.marker) {
				child.remove();
			}
		}

		const visible = this.visibleItems();
		let group: PicodeSettingsGroup | undefined;
		for (const item of visible) {
			const itemGroup = picodeSettingsGroupOf(item.id);
			if (itemGroup !== group) {
				group = itemGroup;
				DOM.append(this.list, $('.picode-settings-nav-group')).textContent = groupLabel(itemGroup);
			}
			this.renderItem(item);
		}

		const query = this.searchInput.value.trim();
		this.empty.textContent = '';
		if (visible.length === 0 && query) {
			DOM.append(this.empty, $('span')).textContent = localize('picodeSettingsNoMatch', "Nothing here matches.");
			const link = DOM.append(this.empty, $('button.picode-settings-link')) as HTMLButtonElement;
			link.type = 'button';
			link.textContent = localize('picodeSettingsSearchAll', "Search in all settings");
			this.rowStore.add(DOM.addDisposableListener(link, DOM.EventType.CLICK, () => this.options.openAllSettings(query)));
		}
		this.setSelected(this.selected);
	}

	private renderItem(item: IPicodeSettingsNavItem): void {
		const button = DOM.append(this.list, $('button.picode-settings-nav-item')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('role', 'tab');
		button.title = item.description;
		button.appendChild(renderIcon(item.icon));
		DOM.append(button, $('span.picode-settings-nav-label')).textContent = item.label;
		if (item.count > 0) {
			DOM.append(button, $('span.picode-settings-nav-count')).textContent = String(item.count);
		}
		this.rowStore.add(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => {
			const query = this.searchInput.value.trim();
			this._onDidSelect.fire({ id: item.id, query: query || undefined });
		}));
		this.buttons.set(item.id, button);
	}

	private onListKey(event: StandardKeyboardEvent): void {
		if (event.keyCode !== KeyCode.UpArrow && event.keyCode !== KeyCode.DownArrow && event.keyCode !== KeyCode.Home && event.keyCode !== KeyCode.End) {
			return;
		}
		const buttons = [...this.buttons.values()];
		const index = buttons.indexOf(DOM.getActiveElement() as HTMLButtonElement);
		let next = index;
		switch (event.keyCode) {
			case KeyCode.UpArrow: next = index <= 0 ? -1 : index - 1; break;
			case KeyCode.DownArrow: next = Math.min(buttons.length - 1, index + 1); break;
			case KeyCode.Home: next = 0; break;
			case KeyCode.End: next = buttons.length - 1; break;
		}
		if (next < 0) {
			this.searchInput.focus();
		} else {
			buttons[next]?.focus();
		}
		event.preventDefault();
	}

	/** Slides the highlight to the selected row; it fades out when the selected page is filtered away. */
	private moveMarker(): void {
		const button = this.selected ? this.buttons.get(this.selected) : undefined;
		if (!button) {
			this.marker.classList.remove('visible');
			return;
		}
		this.marker.style.transform = `translateY(${button.offsetTop}px)`;
		this.marker.style.height = `${button.offsetHeight}px`;
		this.marker.classList.add('visible');
	}

	/** Re-measures after the window changes size or becomes visible. */
	layout(): void {
		this.moveMarker();
	}
}
