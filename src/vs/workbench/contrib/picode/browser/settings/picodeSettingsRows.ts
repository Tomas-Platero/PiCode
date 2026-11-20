/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../chat/browser/aiCustomization/media/picodeSettings.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';

const $ = DOM.$;

export interface IPicodeSettingRow {
	readonly name: string;
	readonly description?: string;
	readonly icon?: ThemeIcon;
	/** Extra words the search box finds this row by. */
	readonly keywords?: string;
	/** Painted in the error color: a row that turns something big off. */
	readonly danger?: boolean;
}

export interface IPicodeSettingChoice<T> {
	readonly value: T;
	readonly label: string;
	readonly icon?: ThemeIcon;
}

interface IBoundRow<T> extends IPicodeSettingRow {
	/** The setting this row reads and writes, in the user's settings. */
	readonly key: string;
	/** A change that only applies after a restart shows the restart bar. */
	readonly needsRestart?: boolean;
	/** Maps the stored value to what the control shows (and back), when they differ. */
	readonly read?: (stored: unknown) => T;
	readonly write?: (shown: T) => unknown;
}

export interface IPicodeSwitchRow extends IBoundRow<boolean> { }
export interface IPicodeChoiceRow<T extends string | number> extends IBoundRow<T> {
	readonly choices: readonly IPicodeSettingChoice<T>[];
}
export interface IPicodeNumberRow extends IBoundRow<number> {
	readonly min?: number;
	readonly max?: number;
	readonly step?: number;
}
export interface IPicodeTextRow extends IBoundRow<string> {
	readonly placeholder?: string;
}

/** Every row of a page: what its name says and what it searches by. */
export function picodeSettingRowSearchText(row: IPicodeSettingRow): string {
	return [row.name, row.description ?? '', row.keywords ?? ''].join(' ');
}

/**
 * Builds a Settings page out of rows: the name and a line of help on the left, the control on
 * the right. Rows bound to a setting read it, write it to the user's settings and repaint when
 * it changes anywhere else (the JSON file, another window, a command).
 */
export class PicodeSettingsPage extends Disposable {

	readonly element: HTMLElement;
	private readonly inner: HTMLElement;
	private body: HTMLElement;
	private readonly refreshers = new Map<string, Array<() => void>>();
	private restartBar: HTMLElement | undefined;

	constructor(
		container: HTMLElement,
		title: string,
		lead: string | undefined,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.element = DOM.append(container, $('.picode-set-page'));
		this.inner = DOM.append(this.element, $('.picode-set-page-inner'));
		DOM.append(this.inner, $('h2.picode-set-title')).textContent = title;
		if (lead) {
			DOM.append(this.inner, $('p.picode-set-lead')).textContent = lead;
		}
		this.body = DOM.append(this.inner, $('.picode-set-group'));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			for (const [key, refresh] of this.refreshers) {
				if (e.affectsConfiguration(key)) {
					refresh.forEach(fn => fn());
				}
			}
		}));
		this._register({ dispose: () => this.element.remove() });
	}

	/** Starts a new block of rows under a heading. */
	group(title: string): void {
		DOM.append(this.inner, $('h3.picode-set-group-title')).textContent = title;
		this.body = DOM.append(this.inner, $('.picode-set-group'));
	}

	/** A row with a control the caller builds; returns the control cell. */
	row(row: IPicodeSettingRow): HTMLElement {
		const el = DOM.append(this.body, $('.picode-set-row'));
		el.dataset.picodeSettingRow = row.keywords ?? '';
		el.classList.toggle('danger', !!row.danger);
		const text = DOM.append(el, $('.picode-set-row-text'));
		const name = DOM.append(text, $('.picode-set-row-name'));
		if (row.icon) {
			name.appendChild(renderIcon(row.icon));
		}
		DOM.append(name, $('span')).textContent = row.name;
		if (row.description) {
			DOM.append(text, $('.picode-set-row-desc')).textContent = row.description;
		}
		return DOM.append(el, $('.picode-set-row-control'));
	}

	/** A row that only reports something: a short tag on the right. */
	infoRow(row: IPicodeSettingRow, tag: string, tone?: 'ok' | 'warn'): HTMLElement {
		const control = this.row(row);
		const el = DOM.append(control, $('span.picode-set-tag'));
		el.textContent = tag;
		if (tone) {
			el.classList.add(tone);
		}
		return el;
	}

	buttonRow(row: IPicodeSettingRow, label: string, run: () => unknown, options?: { primary?: boolean; icon?: ThemeIcon }): HTMLButtonElement {
		const control = this.row(row);
		return this.button(control, label, run, options);
	}

	button(parent: HTMLElement, label: string, run: () => unknown, options?: { primary?: boolean; icon?: ThemeIcon }): HTMLButtonElement {
		const button = DOM.append(parent, $('button.picode-set-button')) as HTMLButtonElement;
		button.type = 'button';
		button.classList.toggle('primary', !!options?.primary);
		if (options?.icon) {
			button.appendChild(renderIcon(options.icon));
		}
		DOM.append(button, $('span')).textContent = label;
		this._register(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => run()));
		return button;
	}

	switchRow(row: IPicodeSwitchRow): void {
		this.customSwitchRow(row, () => this.read(row) === true, (on, saved) => this.save(row, on, saved), [row.key]);
	}

	/** A switch whose value is not one setting on its own: `get` reads it, `set` applies it. */
	customSwitchRow(row: IPicodeSettingRow, get: () => boolean, set: (on: boolean, saved: HTMLElement) => void, watchKeys: readonly string[]): void {
		const control = this.row(row);
		const saved = this.savedMark(control);
		const input = DOM.append(control, $('input.picode-set-switch')) as HTMLInputElement;
		input.type = 'checkbox';
		input.setAttribute('role', 'switch');
		input.setAttribute('aria-label', row.name);
		const paint = () => { input.checked = get(); };
		paint();
		for (const key of watchKeys) {
			this.watch(key, paint);
		}
		this._register(DOM.addDisposableListener(input, DOM.EventType.CHANGE, () => set(input.checked, saved)));
	}

	segmentedRow<T extends string | number>(row: IPicodeChoiceRow<T>): void {
		this.customSegmentedRow(row, row.choices, () => this.read(row), (value, saved) => this.save(row, value, saved), [row.key]);
	}

	/**
	 * A segmented choice whose value is not one setting: `get` reads what to show, `set`
	 * applies a choice, and `watchKeys` say which settings repaint it.
	 */
	customSegmentedRow<T extends string | number>(row: IPicodeSettingRow, choices: readonly IPicodeSettingChoice<T>[], get: () => T, set: (value: T, saved: HTMLElement) => void, watchKeys: readonly string[]): () => void {
		const control = this.row(row);
		const saved = this.savedMark(control);
		const group = DOM.append(control, $('.picode-set-segmented'));
		group.setAttribute('role', 'radiogroup');
		group.setAttribute('aria-label', row.name);
		const pill = DOM.append(group, $('.picode-set-segmented-pill'));
		const iconOnly = choices.every(c => !!c.icon) && choices.length > 2;
		const buttons = choices.map(choice => {
			const button = DOM.append(group, $('button.picode-set-segment')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'radio');
			if (choice.icon) {
				button.appendChild(renderIcon(choice.icon));
			}
			if (iconOnly) {
				button.setAttribute('aria-label', choice.label);
			} else {
				DOM.append(button, $('span')).textContent = choice.label;
			}
			button.title = choice.label;
			this._register(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => {
				set(choice.value, saved);
				paint(choice.value);
			}));
			return button;
		});
		const paint = (value: T = get()) => {
			const index = Math.max(0, choices.findIndex(c => c.value === value));
			buttons.forEach((b, i) => {
				b.setAttribute('aria-checked', String(i === index));
				b.tabIndex = i === index ? 0 : -1;
			});
			const chosen = buttons[index];
			// Measured after layout: the pill takes the chosen option's place and size.
			DOM.getWindow(group).requestAnimationFrame(() => {
				pill.style.width = `${chosen.offsetWidth}px`;
				pill.style.transform = `translateX(${chosen.offsetLeft - 2}px)`;
			});
		};
		paint();
		for (const key of watchKeys) {
			this.watch(key, () => paint());
		}
		return () => paint();
	}

	/** Shows the short check that says a value was saved, for rows that save on their own. */
	markSaved(saved: HTMLElement): void {
		this.flashSaved(saved);
	}

	selectRow<T extends string | number>(row: IPicodeChoiceRow<T>): void {
		const control = this.row(row);
		const saved = this.savedMark(control);
		const wrap = DOM.append(control, $('.picode-set-select-wrap'));
		const select = DOM.append(wrap, $('select.picode-set-select')) as HTMLSelectElement;
		select.setAttribute('aria-label', row.name);
		wrap.appendChild(renderIcon(Codicon.chevronDown));
		row.choices.forEach((choice, index) => {
			const option = DOM.append(select, $('option')) as HTMLOptionElement;
			option.value = String(index);
			option.textContent = choice.label;
		});
		const paint = () => {
			const value = this.read(row);
			const index = row.choices.findIndex(c => c.value === value);
			select.value = String(Math.max(0, index));
		};
		paint();
		this.watch(row.key, paint);
		this._register(DOM.addDisposableListener(select, DOM.EventType.CHANGE, () => {
			const choice = row.choices[Number(select.value)];
			if (choice) {
				this.save(row, choice.value, saved);
			}
		}));
	}

	numberRow(row: IPicodeNumberRow): void {
		const control = this.row(row);
		const saved = this.savedMark(control);
		const input = DOM.append(control, $('input.picode-set-input')) as HTMLInputElement;
		input.type = 'number';
		input.setAttribute('aria-label', row.name);
		if (row.min !== undefined) { input.min = String(row.min); }
		if (row.max !== undefined) { input.max = String(row.max); }
		input.step = String(row.step ?? 1);
		const paint = () => {
			if (DOM.getActiveElement() !== input) {
				input.value = String(this.read(row) ?? '');
			}
		};
		paint();
		this.watch(row.key, paint);
		this._register(DOM.addDisposableListener(input, DOM.EventType.CHANGE, () => {
			const value = Number(input.value);
			if (!Number.isFinite(value)) {
				paint();
				return;
			}
			const clamped = Math.min(row.max ?? value, Math.max(row.min ?? value, value));
			input.value = String(clamped);
			this.save(row, clamped, saved);
		}));
	}

	textRow(row: IPicodeTextRow): void {
		const control = this.row(row);
		const saved = this.savedMark(control);
		const input = DOM.append(control, $('input.picode-set-input')) as HTMLInputElement;
		input.type = 'text';
		input.setAttribute('aria-label', row.name);
		input.placeholder = row.placeholder ?? '';
		const paint = () => {
			if (DOM.getActiveElement() !== input) {
				input.value = String(this.read(row) ?? '');
			}
		};
		paint();
		this.watch(row.key, paint);
		this._register(DOM.addDisposableListener(input, DOM.EventType.CHANGE, () => this.save(row, input.value.trim(), saved)));
	}

	/** Repaints something of the caller's own when one of these settings changes. */
	onSettingChange(key: string, fn: () => void): void {
		this.watch(key, fn);
	}

	private read<T>(row: IBoundRow<T>): T {
		const stored = this.configurationService.getValue(row.key);
		return row.read ? row.read(stored) : stored as T;
	}

	private save<T>(row: IBoundRow<T>, shown: T, saved: HTMLElement): void {
		const value = row.write ? row.write(shown) : shown;
		void this.configurationService.updateValue(row.key, value, ConfigurationTarget.USER).then(() => {
			this.flashSaved(saved);
			if (row.needsRestart) {
				this.showRestartBar();
			}
		});
	}

	private watch(key: string, fn: () => void): void {
		const list = this.refreshers.get(key) ?? [];
		list.push(fn);
		this.refreshers.set(key, list);
	}

	private savedMark(control: HTMLElement): HTMLElement {
		const mark = DOM.append(control, $('span.picode-set-saved'));
		mark.appendChild(renderIcon(Codicon.check));
		mark.setAttribute('aria-hidden', 'true');
		return mark;
	}

	private flashSaved(mark: HTMLElement): void {
		mark.classList.add('show');
		const window = DOM.getWindow(mark);
		window.setTimeout(() => mark.classList.remove('show'), 900);
	}

	private showRestartBar(): void {
		if (this.restartBar) {
			return;
		}
		const bar = this.restartBar = DOM.append(this.inner, $('.picode-set-restart'));
		bar.setAttribute('role', 'status');
		DOM.append(bar, $('span')).textContent = localize('picodeSettingsRestartNeeded', "Restart PiCode to apply this change.");
		this.button(bar, localize('picodeSettingsRestart', "Restart"), () => this.commandService.executeCommand('workbench.action.reloadWindow'), { primary: true });
	}
}
