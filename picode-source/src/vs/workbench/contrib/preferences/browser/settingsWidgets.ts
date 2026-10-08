/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserFeatures } from '../../../../base/browser/canIUse.js';
import * as DOM from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { applyDragImage } from '../../../../base/browser/ui/dnd/dnd.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { Toggle, unthemedToggleStyles } from '../../../../base/browser/ui/toggle/toggle.js';
import { IAction } from '../../../../base/common/actions.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { isIOS } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { isDefined, isUndefinedOrNull } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { defaultButtonStyles, getInputBoxStyle, getSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { hasNativeContextMenu } from '../../../../platform/window/common/window.js';
import { SettingValueType } from '../../../services/preferences/common/preferences.js';
import { validatePropertyName } from '../../../services/preferences/common/preferencesValidation.js';
import { IJSONSchema } from '../../../../base/common/jsonSchema.js';
import { settingsSelectBackground, settingsSelectBorder, settingsSelectForeground, settingsSelectListBorder, settingsTextInputBackground, settingsTextInputBorder, settingsTextInputForeground } from '../common/settingsEditorColorRegistry.js';
import './media/settingsWidgets.css';
import { settingsDiscardIcon, settingsEditIcon, settingsRemoveIcon } from './preferencesIcons.js';

const $ = DOM.$;

type EditKey = 'none' | 'create' | number;

type RowElementGroup = {
	rowElement: HTMLElement;
	keyElement: HTMLElement;
	valueElement?: HTMLElement;
};

type IListViewItem<TDataItem extends object> = TDataItem & {
	editing?: boolean;
	selected?: boolean;
};

export class ListSettingListModel<TDataItem extends object> {
	protected _dataItems: TDataItem[] = [];
	private _editKey: EditKey | null = null;
	private _selectedIdx: number | null = null;
	private _newDataItem: TDataItem;

	get items(): IListViewItem<TDataItem>[] {
		const items = this._dataItems.map((item, i) => {
			const editing = typeof this._editKey === 'number' && this._editKey === i;
			return {
				...item,
				editing,
				selected: i === this._selectedIdx || editing
			};
		});

		if (this._editKey === 'create') {
			items.push({
				editing: true,
				selected: true,
				...this._newDataItem,
			});
		}

		return items;
	}

	constructor(newItem: TDataItem) {
		this._newDataItem = newItem;
	}

	setEditKey(key: EditKey): void {
		this._editKey = key;
	}

	setValue(listData: TDataItem[]): void {
		this._dataItems = listData;
	}

	select(idx: number | null): void {
		this._selectedIdx = idx;
	}

	getSelected(): number | null {
		return this._selectedIdx;
	}

	selectNext(): void {
		if (typeof this._selectedIdx === 'number') {
			this._selectedIdx = Math.min(this._selectedIdx + 1, this._dataItems.length - 1);
		} else {
			this._selectedIdx = 0;
		}
	}

	selectPrevious(): void {
		if (typeof this._selectedIdx === 'number') {
			this._selectedIdx = Math.max(this._selectedIdx - 1, 0);
		} else {
			this._selectedIdx = 0;
		}
	}
}

export interface ISettingListChangeEvent<TDataItem extends object> {
	type: 'change';
	originalItem: TDataItem;
	newItem: TDataItem;
	targetIndex: number;
}

export interface ISettingListAddEvent<TDataItem extends object> {
	type: 'add';
	newItem: TDataItem;
	targetIndex: number;
}

export interface ISettingListMoveEvent<TDataItem extends object> {
	type: 'move';
	originalItem: TDataItem;
	newItem: TDataItem;
	targetIndex: number;
	sourceIndex: number;
}

export interface ISettingListRemoveEvent<TDataItem extends object> {
	type: 'remove';
	originalItem: TDataItem;
	targetIndex: number;
}

export interface ISettingListResetEvent<TDataItem extends object> {
	type: 'reset';
	originalItem: TDataItem;
	targetIndex: number;
}

export type SettingListEvent<TDataItem extends object> = ISettingListChangeEvent<TDataItem> | ISettingListAddEvent<TDataItem> | ISettingListMoveEvent<TDataItem> | ISettingListRemoveEvent<TDataItem> | ISettingListResetEvent<TDataItem>;

export abstract class AbstractListSettingWidget<TDataItem extends object> extends Disposable {
	/** Read by subclasses that append their own rows after the list renders (PiCode's providers). */
	protected listElement: HTMLElement;
	private rowElements: HTMLElement[] = [];

	protected readonly _onDidChangeList = this._register(new Emitter<SettingListEvent<TDataItem>>());
	protected readonly model = new ListSettingListModel<TDataItem>(this.getEmptyItem());
	protected readonly listDisposables = this._register(new DisposableStore());

	readonly onDidChangeList: Event<SettingListEvent<TDataItem>> = this._onDidChangeList.event;

	get domNode(): HTMLElement {
		return this.listElement;
	}

	get items(): TDataItem[] {
		return this.model.items;
	}

	protected get isReadOnly(): boolean {
		return false;
	}

	constructor(
		private container: HTMLElement,
		@IThemeService protected readonly themeService: IThemeService,
		@IContextViewService protected readonly contextViewService: IContextViewService,
		@IConfigurationService protected readonly configurationService: IConfigurationService,
	) {
		super();

		this.listElement = DOM.append(container, $('div'));
		this.listElement.setAttribute('role', 'list');
		this.getContainerClasses().forEach(c => this.listElement.classList.add(c));
		DOM.append(container, this.renderAddButton());
		this.renderList();

		this._register(DOM.addDisposableListener(this.listElement, DOM.EventType.POINTER_DOWN, e => this.onListClick(e)));
		this._register(DOM.addDisposableListener(this.listElement, DOM.EventType.DBLCLICK, e => this.onListDoubleClick(e)));

		this._register(DOM.addStandardDisposableListener(this.listElement, 'keydown', (e: StandardKeyboardEvent) => {
			if (e.equals(KeyCode.UpArrow)) {
				this.selectPreviousRow();
			} else if (e.equals(KeyCode.DownArrow)) {
				this.selectNextRow();
			} else {
				return;
			}

			e.preventDefault();
			e.stopPropagation();
		}));
	}

	setValue(listData: TDataItem[]): void {
		this.model.setValue(listData);
		this.renderList();
	}

	abstract isItemNew(item: TDataItem): boolean;
	protected abstract getEmptyItem(): TDataItem;
	protected abstract getContainerClasses(): string[];
	protected abstract getActionsForItem(item: TDataItem, idx: number): IAction[];
	protected abstract renderItem(item: TDataItem, idx: number): RowElementGroup;
	protected abstract renderEdit(item: TDataItem, idx: number): HTMLElement;
	protected abstract addTooltipsToRow(rowElement: RowElementGroup, item: TDataItem): void;
	protected abstract getLocalizedStrings(): {
		deleteActionTooltip: string;
		editActionTooltip: string;
		addButtonLabel: string;
	};

	protected renderHeader(): HTMLElement | undefined {
		return;
	}

	protected isAddButtonVisible(): boolean {
		return true;
	}

	protected renderList(): void {
		const focused = DOM.isAncestorOfActiveElement(this.listElement);

		DOM.clearNode(this.listElement);
		this.listDisposables.clear();

		const newMode = this.model.items.some(item => !!(item.editing && this.isItemNew(item)));
		this.container.classList.toggle('setting-list-hide-add-button', !this.isAddButtonVisible() || newMode);

		if (this.model.items.length) {
			this.listElement.tabIndex = 0;
		} else {
			this.listElement.removeAttribute('tabIndex');
		}

		const header = this.renderHeader();

		if (header) {
			this.listElement.appendChild(header);
		}

		this.rowElements = this.model.items.map((item, i) => this.renderDataOrEditItem(item, i, focused));
		this.rowElements.forEach(rowElement => this.listElement.appendChild(rowElement));

	}

	protected createBasicSelectBox(value: IObjectEnumData): SelectBox {
		const selectBoxOptions = value.options.map(({ value, description }) => ({ text: value, description }));
		const selected = value.options.findIndex(option => value.data === option.value);

		const styles = getSelectBoxStyles({
			selectBackground: settingsSelectBackground,
			selectForeground: settingsSelectForeground,
			selectBorder: settingsSelectBorder,
			selectListBorder: settingsSelectListBorder
		});


		const selectBox = new SelectBox(selectBoxOptions, selected, this.contextViewService, styles, {
			useCustomDrawn: !hasNativeContextMenu(this.configurationService) || !(isIOS && BrowserFeatures.pointerEvents)
		});
		return selectBox;
	}

	protected editSetting(idx: number): void {
		this.model.setEditKey(idx);
		this.renderList();
	}

	public cancelEdit(): void {
		this.model.setEditKey('none');
		this.renderList();
	}

	protected handleItemChange(originalItem: TDataItem, changedItem: TDataItem, idx: number) {
		this.model.setEditKey('none');

		if (this.isItemNew(originalItem)) {
			this._onDidChangeList.fire({
				type: 'add',
				newItem: changedItem,
				targetIndex: idx,
			});
		} else {
			this._onDidChangeList.fire({
				type: 'change',
				originalItem,
				newItem: changedItem,
				targetIndex: idx,
			});
		}

		this.renderList();
	}

	protected renderDataOrEditItem(item: IListViewItem<TDataItem>, idx: number, listFocused: boolean): HTMLElement {
		const rowElement = item.editing ?
			this.renderEdit(item, idx) :
			this.renderDataItem(item, idx, listFocused);

		rowElement.setAttribute('role', 'listitem');

		return rowElement;
	}

	private renderDataItem(item: IListViewItem<TDataItem>, idx: number, listFocused: boolean): HTMLElement {
		const rowElementGroup = this.renderItem(item, idx);
		const rowElement = rowElementGroup.rowElement;

		rowElement.setAttribute('data-index', idx + '');
		rowElement.setAttribute('tabindex', item.selected ? '0' : '-1');
		rowElement.classList.toggle('selected', item.selected);

		const actionBar = new ActionBar(rowElement);
		this.listDisposables.add(actionBar);

		actionBar.push(this.getActionsForItem(item, idx), { icon: true, label: true });
		this.addTooltipsToRow(rowElementGroup, item);

		if (item.selected && listFocused) {
			disposableTimeout(() => rowElement.focus(), undefined, this.listDisposables);
		}

		this.listDisposables.add(DOM.addDisposableListener(rowElement, 'click', (e) => {
			// There is a parent list widget, which is the one that holds the list of settings.
			// Prevent the parent widget from trying to interpret this click event.
			e.stopPropagation();
		}));

		return rowElement;
	}

	private renderAddButton(): HTMLElement {
		const rowElement = $('.setting-list-new-row');

		const startAddButton = this._register(new Button(rowElement, defaultButtonStyles));
		startAddButton.label = this.getLocalizedStrings().addButtonLabel;
		startAddButton.element.classList.add('setting-list-addButton');

		this._register(startAddButton.onDidClick(() => {
			this.model.setEditKey('create');
			this.renderList();
		}));

		return rowElement;
	}

	private onListClick(e: PointerEvent): void {
		const targetIdx = this.getClickedItemIndex(e);
		if (targetIdx < 0) {
			return;
		}

		e.preventDefault();
		e.stopImmediatePropagation();
		if (this.model.getSelected() === targetIdx) {
			return;
		}

		this.selectRow(targetIdx);
	}

	private onListDoubleClick(e: MouseEvent): void {
		const targetIdx = this.getClickedItemIndex(e);
		if (targetIdx < 0) {
			return;
		}

		if (this.isReadOnly) {
			return;
		}

		const item = this.model.items[targetIdx];
		if (item) {
			this.editSetting(targetIdx);
			e.preventDefault();
			e.stopPropagation();
		}
	}

	private getClickedItemIndex(e: MouseEvent): number {
		if (!e.target) {
			return -1;
		}

		const actionbar = DOM.findParentWithClass(e.target as HTMLElement, 'monaco-action-bar');
		if (actionbar) {
			// Don't handle doubleclicks inside the action bar
			return -1;
		}

		const element = DOM.findParentWithClass(e.target as HTMLElement, 'setting-list-row');
		if (!element) {
			return -1;
		}

		const targetIdxStr = element.getAttribute('data-index');
		if (!targetIdxStr) {
			return -1;
		}

		const targetIdx = parseInt(targetIdxStr);
		return targetIdx;
	}

	private selectRow(idx: number): void {
		this.model.select(idx);
		this.rowElements.forEach(row => row.classList.remove('selected'));

		const selectedRow = this.rowElements[this.model.getSelected()!];

		selectedRow.classList.add('selected');
		selectedRow.focus();
	}

	private selectNextRow(): void {
		this.model.selectNext();
		this.selectRow(this.model.getSelected()!);
	}

	private selectPreviousRow(): void {
		this.model.selectPrevious();
		this.selectRow(this.model.getSelected()!);
	}
}

interface IListSetValueOptions {
	showAddButton?: boolean;
	keySuggester?: IObjectKeySuggester;
	isReadOnly?: boolean;
}

export interface IListDataItem {
	value: ObjectKey;
	sibling?: string;
}

interface ListSettingWidgetDragDetails<TListDataItem extends IListDataItem> {
	element: HTMLElement;
	item: TListDataItem;
	itemIndex: number;
}

export class ListSettingWidget<TListDataItem extends IListDataItem> extends AbstractListSettingWidget<TListDataItem> {
	private keyValueSuggester: IObjectKeySuggester | undefined;
	private showAddButton: boolean = true;
	private isEditable: boolean = true;

	override setValue(listData: TListDataItem[], options?: IListSetValueOptions) {
		this.keyValueSuggester = options?.keySuggester;
		this.isEditable = options?.isReadOnly === undefined ? true : !options.isReadOnly;
		this.showAddButton = this.isEditable ? (options?.showAddButton ?? true) : false;
		super.setValue(listData);
	}

	constructor(
		container: HTMLElement,
		@IThemeService themeService: IThemeService,
		@IContextViewService contextViewService: IContextViewService,
		@IHoverService protected readonly hoverService: IHoverService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super(container, themeService, contextViewService, configurationService);
	}

	protected getEmptyItem(): TListDataItem {
		// eslint-disable-next-line local/code-no-dangerous-type-assertions
		return {
			value: {
				type: 'string',
				data: ''
			}
		} as TListDataItem;
	}

	protected override isAddButtonVisible(): boolean {
		return this.showAddButton;
	}

	protected getContainerClasses(): string[] {
		return ['setting-list-widget'];
	}

	protected getActionsForItem(item: TListDataItem, idx: number): IAction[] {
		if (this.isReadOnly) {
			return [];
		}
		return [
			{
				class: ThemeIcon.asClassName(settingsEditIcon),
				enabled: true,
				id: 'workbench.action.editListItem',
				tooltip: this.getLocalizedStrings().editActionTooltip,
				run: () => this.editSetting(idx)
			},
			{
				class: ThemeIcon.asClassName(settingsRemoveIcon),
				enabled: true,
				id: 'workbench.action.removeListItem',
				tooltip: this.getLocalizedStrings().deleteActionTooltip,
				run: () => this._onDidChangeList.fire({ type: 'remove', originalItem: item, targetIndex: idx })
			}
		] as IAction[];
	}

	private dragDetails: ListSettingWidgetDragDetails<TListDataItem> | undefined;

	protected renderItem(item: TListDataItem, idx: number): RowElementGroup {
		const rowElement = $('.setting-list-row');
		const valueElement = DOM.append(rowElement, $('.setting-list-value'));
		const siblingElement = DOM.append(rowElement, $('.setting-list-sibling'));

		valueElement.textContent = item.value.data.toString();
		if (item.sibling) {
			siblingElement.textContent = `when: ${item.sibling}`;
		} else {
			siblingElement.textContent = null;
			valueElement.classList.add('no-sibling');
		}

		this.addDragAndDrop(rowElement, item, idx);
		return { rowElement, keyElement: valueElement, valueElement: siblingElement };
	}

	protected addDragAndDrop(rowElement: HTMLElement, item: TListDataItem, idx: number) {
		if (this.model.items.every(item => !item.editing)) {
			rowElement.draggable = true;
			rowElement.classList.add('draggable');
		} else {
			rowElement.draggable = false;
			rowElement.classList.remove('draggable');
		}

		this.listDisposables.add(DOM.addDisposableListener(rowElement, DOM.EventType.DRAG_START, (ev) => {
			this.dragDetails = {
				element: rowElement,
				item,
				itemIndex: idx
			};

			applyDragImage(ev, rowElement, item.value.data);
		}));
		this.listDisposables.add(DOM.addDisposableListener(rowElement, DOM.EventType.DRAG_OVER, (ev) => {
			if (!this.dragDetails) {
				return false;
			}
			ev.preventDefault();
			if (ev.dataTransfer) {
				ev.dataTransfer.dropEffect = 'move';
			}
			return true;
		}));
		let counter = 0;
		this.listDisposables.add(DOM.addDisposableListener(rowElement, DOM.EventType.DRAG_ENTER, (ev) => {
			counter++;
			rowElement.classList.add('drag-hover');
		}));
		this.listDisposables.add(DOM.addDisposableListener(rowElement, DOM.EventType.DRAG_LEAVE, (ev) => {
			counter--;
			if (!counter) {
				rowElement.classList.remove('drag-hover');
			}
		}));
		this.listDisposables.add(DOM.addDisposableListener(rowElement, DOM.EventType.DROP, (ev) => {
			// cancel the op if we dragged to a completely different setting
			if (!this.dragDetails) {
				return false;
			}
			ev.preventDefault();
			counter = 0;
			if (this.dragDetails.element !== rowElement) {
				this._onDidChangeList.fire({
					type: 'move',
					originalItem: this.dragDetails.item,
					sourceIndex: this.dragDetails.itemIndex,
					newItem: item,
					targetIndex: idx
				});
			}
			return true;
		}));
		this.listDisposables.add(DOM.addDisposableListener(rowElement, DOM.EventType.DRAG_END, (ev) => {
			counter = 0;
			rowElement.classList.remove('drag-hover');
			ev.dataTransfer?.clearData();
			if (this.dragDetails) {
				this.dragDetails = undefined;
			}
		}));
	}

	protected renderEdit(item: TListDataItem, idx: number): HTMLElement {
		const rowElement = $('.setting-list-edit-row');
		let valueInput: InputBox | SelectBox;
		let currentDisplayValue: string;
		let currentEnumOptions: IObjectEnumOption[] | undefined;

		if (this.keyValueSuggester) {
			const enumData = this.keyValueSuggester(this.model.items.map(({ value: { data } }) => data), idx);
			item = {
				...item,
				value: {
					type: 'enum',
					data: item.value.data,
					options: enumData ? enumData.options : []
				}
			};
		}

		switch (item.value.type) {
			case 'string':
				valueInput = this.renderInputBox(item.value, rowElement);
				break;
			case 'enum':
				valueInput = this.renderDropdown(item.value, rowElement);
				currentEnumOptions = item.value.options;
				if (item.value.options.length) {
					currentDisplayValue = this.isItemNew(item) ?
						currentEnumOptions[0].value : item.value.data;
				}
				break;
		}

		const updatedInputBoxItem = (): TListDataItem => {
			const inputBox = valueInput as InputBox;
			// eslint-disable-next-line local/code-no-dangerous-type-assertions
			return {
				value: {
					type: 'string',
					data: inputBox.value
				},
				sibling: siblingInput?.value
			} as TListDataItem;
		};
		const updatedSelectBoxItem = (selectedValue: string): TListDataItem => {
			// eslint-disable-next-line local/code-no-dangerous-type-assertions
			return {
				value: {
					type: 'enum',
					data: selectedValue,
					options: currentEnumOptions ?? []
				}
			} as TListDataItem;
		};
		const onKeyDown = (e: StandardKeyboardEvent) => {
			if (e.equals(KeyCode.Enter)) {
				this.handleItemChange(item, updatedInputBoxItem(), idx);
			} else if (e.equals(KeyCode.Escape)) {
				this.cancelEdit();
				e.preventDefault();
				e.stopPropagation();
			}
			rowElement?.focus();
		};

		if (item.value.type !== 'string') {
			const selectBox = valueInput as SelectBox;
			this.listDisposables.add(
				selectBox.onDidSelect(({ selected }) => {
					currentDisplayValue = selected;
				})
			);
		} else {
			const inputBox = valueInput as InputBox;
			this.listDisposables.add(
				DOM.addStandardDisposableListener(inputBox.inputElement, DOM.EventType.KEY_DOWN, onKeyDown)
			);
		}

		let siblingInput: InputBox | undefined;
		if (!isUndefinedOrNull(item.sibling)) {
			siblingInput = new InputBox(rowElement, this.contextViewService, {
				placeholder: this.getLocalizedStrings().siblingInputPlaceholder,
				inputBoxStyles: getInputBoxStyle({
					inputBackground: settingsTextInputBackground,
					inputForeground: settingsTextInputForeground,
					inputBorder: settingsTextInputBorder
				})
			});
			siblingInput.element.classList.add('setting-list-siblingInput');
			this.listDisposables.add(siblingInput);
			siblingInput.value = item.sibling;

			this.listDisposables.add(
				DOM.addStandardDisposableListener(siblingInput.inputElement, DOM.EventType.KEY_DOWN, onKeyDown)
			);
		} else if (valueInput instanceof InputBox) {
			valueInput.element.classList.add('no-sibling');
		}

		const okButton = this.listDisposables.add(new Button(rowElement, defaultButtonStyles));
		okButton.label = localize('okButton', "OK");
		okButton.element.classList.add('setting-list-ok-button');

		this.listDisposables.add(okButton.onDidClick(() => {
			if (item.value.type === 'string') {
				this.handleItemChange(item, updatedInputBoxItem(), idx);
			} else {
				this.handleItemChange(item, updatedSelectBoxItem(currentDisplayValue), idx);
			}
		}));

		const cancelButton = this.listDisposables.add(new Button(rowElement, { secondary: true, ...defaultButtonStyles }));
		cancelButton.label = localize('cancelButton', "Cancel");
		cancelButton.element.classList.add('setting-list-cancel-button');

		this.listDisposables.add(cancelButton.onDidClick(() => this.cancelEdit()));

		this.listDisposables.add(
			disposableTimeout(() => {
				valueInput.focus();
				if (valueInput instanceof InputBox) {
					valueInput.select();
				}
			})
		);

		return rowElement;
	}

	override isItemNew(item: TListDataItem): boolean {
		return item.value.data === '';
	}

	protected addTooltipsToRow(rowElementGroup: RowElementGroup, { value, sibling }: TListDataItem) {
		const title = isUndefinedOrNull(sibling)
			? localize('listValueHintLabel', "List item `{0}`", value.data)
			: localize('listSiblingHintLabel', "List item `{0}` with sibling `${1}`", value.data, sibling);

		const { rowElement } = rowElementGroup;
		this.listDisposables.add(this.hoverService.setupDelayedHover(rowElement, { content: title }));
		rowElement.setAttribute('aria-label', title);
	}

	protected getLocalizedStrings() {
		return {
			deleteActionTooltip: localize('removeItem', "Remove Item"),
			editActionTooltip: localize('editItem', "Edit Item"),
			addButtonLabel: localize('addItem', "Add Item"),
			inputPlaceholder: localize('itemInputPlaceholder', "Item..."),
			siblingInputPlaceholder: localize('listSiblingInputPlaceholder', "Sibling..."),
		};
	}

	private renderInputBox(value: ObjectValue, rowElement: HTMLElement): InputBox {
		const valueInput = new InputBox(rowElement, this.contextViewService, {
			placeholder: this.getLocalizedStrings().inputPlaceholder,
			inputBoxStyles: getInputBoxStyle({
				inputBackground: settingsTextInputBackground,
				inputForeground: settingsTextInputForeground,
				inputBorder: settingsTextInputBorder
			})
		});

		valueInput.element.classList.add('setting-list-valueInput');
		this.listDisposables.add(valueInput);
		valueInput.value = value.data.toString();

		return valueInput;
	}

	private renderDropdown(value: ObjectKey, rowElement: HTMLElement): SelectBox {
		if (value.type !== 'enum') {
			throw new Error('Valuetype must be enum.');
		}
		const selectBox = this.createBasicSelectBox(value);

		const wrapper = $('.setting-list-object-list-row');
		selectBox.render(wrapper);
		rowElement.appendChild(wrapper);

		return selectBox;
	}
}

export class ExcludeSettingWidget extends ListSettingWidget<IIncludeExcludeDataItem> {
	protected override getContainerClasses() {
		return ['setting-list-include-exclude-widget'];
	}

	protected override addDragAndDrop(rowElement: HTMLElement, item: IIncludeExcludeDataItem, idx: number) {
		return;
	}

	protected override addTooltipsToRow(rowElementGroup: RowElementGroup, item: IIncludeExcludeDataItem): void {
		let title = isUndefinedOrNull(item.sibling)
			? localize('excludePatternHintLabel', "Exclude files matching `{0}`", item.value.data)
			: localize('excludeSiblingHintLabel', "Exclude files matching `{0}`, only when a file matching `{1}` is present", item.value.data, item.sibling);

		if (item.source) {
			title += localize('excludeIncludeSource', ". Default value provided by `{0}`", item.source);
		}

		const markdownTitle = new MarkdownString().appendMarkdown(title);

		const { rowElement } = rowElementGroup;
		this.listDisposables.add(this.hoverService.setupDelayedHover(rowElement, { content: markdownTitle }));
		rowElement.setAttribute('aria-label', title);
	}

	protected override getLocalizedStrings() {
		return {
			deleteActionTooltip: localize('removeExcludeItem', "Remove Exclude Item"),
			editActionTooltip: localize('editExcludeItem', "Edit Exclude Item"),
			addButtonLabel: localize('addPattern', "Add Pattern"),
			inputPlaceholder: localize('excludePatternInputPlaceholder', "Exclude Pattern..."),
			siblingInputPlaceholder: localize('excludeSiblingInputPlaceholder', "When Pattern Is Present..."),
		};
	}
}

export class IncludeSettingWidget extends ListSettingWidget<IIncludeExcludeDataItem> {
	protected override getContainerClasses() {
		return ['setting-list-include-exclude-widget'];
	}

	protected override addDragAndDrop(rowElement: HTMLElement, item: IIncludeExcludeDataItem, idx: number) {
		return;
	}

	protected override addTooltipsToRow(rowElementGroup: RowElementGroup, item: IIncludeExcludeDataItem): void {
		let title = isUndefinedOrNull(item.sibling)
			? localize('includePatternHintLabel', "Include files matching `{0}`", item.value.data)
			: localize('includeSiblingHintLabel', "Include files matching `{0}`, only when a file matching `{1}` is present", item.value.data, item.sibling);

		if (item.source) {
			title += localize('excludeIncludeSource', ". Default value provided by `{0}`", item.source);
		}

		const markdownTitle = new MarkdownString().appendMarkdown(title);

		const { rowElement } = rowElementGroup;
		this.listDisposables.add(this.hoverService.setupDelayedHover(rowElement, { content: markdownTitle }));
		rowElement.setAttribute('aria-label', title);
	}

	protected override getLocalizedStrings() {
		return {
			deleteActionTooltip: localize('removeIncludeItem', "Remove Include Item"),
			editActionTooltip: localize('editIncludeItem', "Edit Include Item"),
			addButtonLabel: localize('addPattern', "Add Pattern"),
			inputPlaceholder: localize('includePatternInputPlaceholder', "Include Pattern..."),
			siblingInputPlaceholder: localize('includeSiblingInputPlaceholder', "When Pattern Is Present..."),
		};
	}
}

interface IObjectStringData {
	type: 'string';
	data: string;
}

export interface IObjectEnumOption {
	value: string;
	description?: string;
}

interface IObjectEnumData {
	type: 'enum';
	data: string;
	options: IObjectEnumOption[];
}

interface IObjectBoolData {
	type: 'boolean';
	data: boolean;
}

type ObjectKey = IObjectStringData | IObjectEnumData;
export type ObjectValue = IObjectStringData | IObjectEnumData | IObjectBoolData;
type ObjectWidget = InputBox | SelectBox;

export interface IObjectDataItem {
	key: ObjectKey;
	value: ObjectValue;
	keyDescription?: string;
	source?: string;
	removable: boolean;
	resetable: boolean;
}

export interface IIncludeExcludeDataItem {
	value: ObjectKey;
	elementType: SettingValueType;
	sibling?: string;
	source?: string;
}

export interface IObjectValueSuggester {
	(key: string): ObjectValue | undefined;
}

export interface IObjectKeySuggester {
	(existingKeys: string[], idx?: number): IObjectEnumData | undefined;
}

interface IObjectSetValueOptions {
	settingKey: string;
	showAddButton: boolean;
	isReadOnly?: boolean;
	keySuggester?: IObjectKeySuggester;
	valueSuggester?: IObjectValueSuggester;
	propertyNames?: IJSONSchema;
}

interface IObjectRenderEditWidgetOptions {
	isKey: boolean;
	idx: number;
	readonly originalItem: IObjectDataItem;
	readonly changedItem: IObjectDataItem;
	update(keyOrValue: ObjectKey | ObjectValue): void;
}

export class ObjectSettingDropdownWidget extends AbstractListSettingWidget<IObjectDataItem> {
	private editable: boolean = true;
	private currentSettingKey: string = '';
	private showAddButton: boolean = true;
	private keySuggester: IObjectKeySuggester = () => undefined;
	private valueSuggester: IObjectValueSuggester = () => undefined;
	private propertyNames: IJSONSchema | undefined;

	constructor(
		container: HTMLElement,
		@IThemeService themeService: IThemeService,
		@IContextViewService contextViewService: IContextViewService,
		@IHoverService private readonly hoverService: IHoverService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super(container, themeService, contextViewService, configurationService);
	}

	override setValue(listData: IObjectDataItem[], options?: IObjectSetValueOptions): void {
		this.editable = !options?.isReadOnly;
		this.showAddButton = options?.showAddButton ?? this.showAddButton;
		this.keySuggester = options?.keySuggester ?? this.keySuggester;
		this.valueSuggester = options?.valueSuggester ?? this.valueSuggester;
		this.propertyNames = options?.propertyNames;

		if (isDefined(options) && options.settingKey !== this.currentSettingKey) {
			this.model.setEditKey('none');
			this.model.select(null);
			this.currentSettingKey = options.settingKey;
		}

		super.setValue(listData);
	}

	override isItemNew(item: IObjectDataItem): boolean {
		return item.key.data === '' && item.value.data === '';
	}

	protected override isAddButtonVisible(): boolean {
		return this.showAddButton;
	}

	protected override get isReadOnly(): boolean {
		return !this.editable;
	}

	protected getEmptyItem(): IObjectDataItem {
		return {
			key: { type: 'string', data: '' },
			value: { type: 'string', data: '' },
			removable: true,
			resetable: false
		};
	}

	protected getContainerClasses() {
		return ['setting-list-object-widget'];
	}

	protected getActionsForItem(item: IObjectDataItem, idx: number): IAction[] {
		if (this.isReadOnly) {
			return [];
		}

		const actions: IAction[] = [
			{
				class: ThemeIcon.asClassName(settingsEditIcon),
				enabled: true,
				id: 'workbench.action.editListItem',
				label: '',
				tooltip: this.getLocalizedStrings().editActionTooltip,
				run: () => this.editSetting(idx)
			},
		];

		if (item.resetable) {
			actions.push({
				class: ThemeIcon.asClassName(settingsDiscardIcon),
				enabled: true,
				id: 'workbench.action.resetListItem',
				label: '',
				tooltip: this.getLocalizedStrings().resetActionTooltip,
				run: () => this._onDidChangeList.fire({ type: 'reset', originalItem: item, targetIndex: idx })
			});
		}

		if (item.removable) {
			actions.push({
				class: ThemeIcon.asClassName(settingsRemoveIcon),
				enabled: true,
				id: 'workbench.action.removeListItem',
				label: '',
				tooltip: this.getLocalizedStrings().deleteActionTooltip,
				run: () => this._onDidChangeList.fire({ type: 'remove', originalItem: item, targetIndex: idx })
			});
		}

		return actions;
	}

	protected override renderHeader() {
		const header = $('.setting-list-row-header');
		const keyHeader = DOM.append(header, $('.setting-list-object-key'));
		const valueHeader = DOM.append(header, $('.setting-list-object-value'));
		const { keyHeaderText, valueHeaderText } = this.getLocalizedStrings();

		keyHeader.textContent = keyHeaderText;
		valueHeader.textContent = valueHeaderText;

		return header;
	}

	protected renderItem(item: IObjectDataItem, idx: number): RowElementGroup {
		const rowElement = $('.setting-list-row');
		rowElement.classList.add('setting-list-object-row');

		// Mark row as invalid if the key doesn't match propertyNames.pattern
		if (this.propertyNames && item.key.data && !validatePropertyName(this.propertyNames, item.key.data)) {
			rowElement.classList.add('invalid-key');
		}

		const keyElement = DOM.append(rowElement, $('.setting-list-object-key'));
		const valueElement = DOM.append(rowElement, $('.setting-list-object-value'));

		keyElement.textContent = item.key.data;
		valueElement.textContent = item.value.data.toString();

		return { rowElement, keyElement, valueElement };
	}

	protected renderEdit(item: IObjectDataItem, idx: number): HTMLElement {
		const rowElement = $('.setting-list-edit-row.setting-list-object-row');

		const changedItem = { ...item };
		const onKeyChange = (key: ObjectKey) => {
			changedItem.key = key;
			okButton.enabled = key.data !== '';

			const suggestedValue = this.valueSuggester(key.data) ?? item.value;

			if (this.shouldUseSuggestion(item.value, changedItem.value, suggestedValue)) {
				onValueChange(suggestedValue);
				renderLatestValue();
			}
		};
		const onValueChange = (value: ObjectValue) => {
			changedItem.value = value;
		};

		let keyWidget: ObjectWidget | undefined;
		let keyElement: HTMLElement;

		if (this.showAddButton) {
			if (this.isItemNew(item)) {
				const suggestedKey = this.keySuggester(this.model.items.map(({ key: { data } }) => data));

				if (isDefined(suggestedKey)) {
					changedItem.key = suggestedKey;
					const suggestedValue = this.valueSuggester(changedItem.key.data);
					onValueChange(suggestedValue ?? changedItem.value);
				}
			}

			const { widget, element } = this.renderEditWidget(changedItem.key, {
				idx,
				isKey: true,
				originalItem: item,
				changedItem,
				update: onKeyChange,
			});
			keyWidget = widget;
			keyElement = element;
		} else {
			keyElement = $('.setting-list-object-key');
			keyElement.textContent = item.key.data;
		}

		let valueWidget: ObjectWidget;
		const valueContainer = $('.setting-list-object-value-container');

		const renderLatestValue = () => {
			const { widget, element } = this.renderEditWidget(changedItem.value, {
				idx,
				isKey: false,
				originalItem: item,
				changedItem,
				update: onValueChange,
			});

			valueWidget = widget;

			DOM.clearNode(valueContainer);
			valueContainer.append(element);
		};

		renderLatestValue();

		rowElement.append(keyElement, valueContainer);

		const okButton = this.listDisposables.add(new Button(rowElement, defaultButtonStyles));
		okButton.enabled = changedItem.key.data !== '';
		okButton.label = localize('okButton', "OK");
		okButton.element.classList.add('setting-list-ok-button');

		this.listDisposables.add(okButton.onDidClick(() => this.handleItemChange(item, changedItem, idx)));

		const cancelButton = this.listDisposables.add(new Button(rowElement, { secondary: true, ...defaultButtonStyles }));
		cancelButton.label = localize('cancelButton', "Cancel");
		cancelButton.element.classList.add('setting-list-cancel-button');

		this.listDisposables.add(cancelButton.onDidClick(() => this.cancelEdit()));

		this.listDisposables.add(
			disposableTimeout(() => {
				const widget = keyWidget ?? valueWidget;

				widget.focus();

				if (widget instanceof InputBox) {
					widget.select();
				}
			})
		);

		return rowElement;
	}

	private renderEditWidget(
		keyOrValue: ObjectKey | ObjectValue,
		options: IObjectRenderEditWidgetOptions,
	) {
		switch (keyOrValue.type) {
			case 'string':
				return this.renderStringEditWidget(keyOrValue, options);
			case 'enum':
				return this.renderEnumEditWidget(keyOrValue, options);
			case 'boolean':
				return this.renderEnumEditWidget(
					{
						type: 'enum',
						data: keyOrValue.data.toString(),
						options: [{ value: 'true' }, { value: 'false' }],
					},
					options,
				);
		}
	}

	private renderStringEditWidget(
		keyOrValue: IObjectStringData,
		{ idx, isKey, originalItem, changedItem, update }: IObjectRenderEditWidgetOptions,
	) {
		const wrapper = $(isKey ? '.setting-list-object-input-key' : '.setting-list-object-input-value');
		const inputBox = new InputBox(wrapper, this.contextViewService, {
			placeholder: isKey
				? localize('objectKeyInputPlaceholder', "Key")
				: localize('objectValueInputPlaceholder', "Value"),
			inputBoxStyles: getInputBoxStyle({
				inputBackground: settingsTextInputBackground,
				inputForeground: settingsTextInputForeground,
				inputBorder: settingsTextInputBorder
			})
		});

		inputBox.element.classList.add('setting-list-object-input');

		this.listDisposables.add(inputBox);
		inputBox.value = keyOrValue.data;

		this.listDisposables.add(inputBox.onDidChange(value => update({ ...keyOrValue, data: value })));

		const onKeyDown = (e: StandardKeyboardEvent) => {
			if (e.equals(KeyCode.Enter)) {
				this.handleItemChange(originalItem, changedItem, idx);
			} else if (e.equals(KeyCode.Escape)) {
				this.cancelEdit();
				e.preventDefault();
				e.stopPropagation();
			}
		};

		this.listDisposables.add(
			DOM.addStandardDisposableListener(inputBox.inputElement, DOM.EventType.KEY_DOWN, onKeyDown)
		);

		return { widget: inputBox, element: wrapper };
	}

	private renderEnumEditWidget(
		keyOrValue: IObjectEnumData,
		{ isKey, changedItem, update }: IObjectRenderEditWidgetOptions,
	) {
		const selectBox = this.createBasicSelectBox(keyOrValue);

		const changedKeyOrValue = isKey ? changedItem.key : changedItem.value;
		this.listDisposables.add(
			selectBox.onDidSelect(({ selected }) =>
				update(
					changedKeyOrValue.type === 'boolean'
						? { ...changedKeyOrValue, data: selected === 'true' ? true : false }
						: { ...changedKeyOrValue, data: selected },
				)
			)
		);

		const wrapper = $('.setting-list-object-input');
		wrapper.classList.add(
			isKey ? 'setting-list-object-input-key' : 'setting-list-object-input-value',
		);

		selectBox.render(wrapper);

		// Switch to the first item if the user set something invalid in the json
		const selected = keyOrValue.options.findIndex(option => keyOrValue.data === option.value);
		if (selected === -1 && keyOrValue.options.length) {
			update(
				changedKeyOrValue.type === 'boolean'
					? { ...changedKeyOrValue, data: true }
					: { ...changedKeyOrValue, data: keyOrValue.options[0].value }
			);
		} else if (changedKeyOrValue.type === 'boolean') {
			// https://github.com/microsoft/vscode/issues/129581
			update({ ...changedKeyOrValue, data: keyOrValue.data === 'true' });
		}

		return { widget: selectBox, element: wrapper };
	}

	private shouldUseSuggestion(originalValue: ObjectValue, previousValue: ObjectValue, newValue: ObjectValue): boolean {
		// suggestion is exactly the same
		if (newValue.type !== 'enum' && newValue.type === previousValue.type && newValue.data === previousValue.data) {
			return false;
		}

		// item is new, use suggestion
		if (originalValue.data === '') {
			return true;
		}

		if (previousValue.type === newValue.type && newValue.type !== 'enum') {
			return false;
		}

		// check if all enum options are the same
		if (previousValue.type === 'enum' && newValue.type === 'enum') {
			const previousEnums = new Set(previousValue.options.map(({ value }) => value));
			newValue.options.forEach(({ value }) => previousEnums.delete(value));

			// all options are the same
			if (previousEnums.size === 0) {
				return false;
			}
		}

		return true;
	}

	protected addTooltipsToRow(rowElementGroup: RowElementGroup, item: IObjectDataItem): void {
		const { keyElement, valueElement, rowElement } = rowElementGroup;

		let accessibleDescription;
		if (item.source) {
			accessibleDescription = localize('objectPairHintLabelWithSource', "The property `{0}` is set to `{1}` by `{2}`.", item.key.data, item.value.data, item.source);
		} else {
			accessibleDescription = localize('objectPairHintLabel', "The property `{0}` is set to `{1}`.", item.key.data, item.value.data);
		}

		const markdownString = new MarkdownString().appendMarkdown(accessibleDescription);

		const keyDescription: string | MarkdownString = this.getEnumDescription(item.key) ?? item.keyDescription ?? markdownString;
		this.listDisposables.add(this.hoverService.setupDelayedHover(keyElement, { content: keyDescription }));

		const valueDescription: string | MarkdownString = this.getEnumDescription(item.value) ?? markdownString;
		this.listDisposables.add(this.hoverService.setupDelayedHover(valueElement!, { content: valueDescription }));

		rowElement.setAttribute('aria-label', accessibleDescription);
	}

	private getEnumDescription(keyOrValue: ObjectKey | ObjectValue): string | undefined {
		const enumDescription = keyOrValue.type === 'enum'
			? keyOrValue.options.find(({ value }) => keyOrValue.data === value)?.description
			: undefined;
		return enumDescription;
	}

	protected getLocalizedStrings() {
		return {
			deleteActionTooltip: localize('removeItem', "Remove Item"),
			resetActionTooltip: localize('resetItem', "Reset Item"),
			editActionTooltip: localize('editItem', "Edit Item"),
			addButtonLabel: localize('addItem', "Add Item"),
			keyHeaderText: localize('objectKeyHeader', "Item"),
			valueHeaderText: localize('objectValueHeader', "Value"),
		};
	}
}

interface IBoolObjectSetValueOptions {
	settingKey: string;
}

export interface IBoolObjectDataItem {
	key: IObjectStringData;
	value: IObjectBoolData;
	keyDescription?: string;
	source?: string;
	removable: false;
	resetable: boolean;
}

export class ObjectSettingCheckboxWidget extends AbstractListSettingWidget<IBoolObjectDataItem> {
	private currentSettingKey: string = '';

	constructor(
		container: HTMLElement,
		@IThemeService themeService: IThemeService,
		@IContextViewService contextViewService: IContextViewService,
		@IHoverService private readonly hoverService: IHoverService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super(container, themeService, contextViewService, configurationService);
	}

	override setValue(listData: IBoolObjectDataItem[], options?: IBoolObjectSetValueOptions): void {
		if (isDefined(options) && options.settingKey !== this.currentSettingKey) {
			this.model.setEditKey('none');
			this.model.select(null);
			this.currentSettingKey = options.settingKey;
		}

		super.setValue(listData);
	}

	override isItemNew(item: IBoolObjectDataItem): boolean {
		return !item.key.data && !item.value.data;
	}

	protected getEmptyItem(): IBoolObjectDataItem {
		return {
			key: { type: 'string', data: '' },
			value: { type: 'boolean', data: false },
			removable: false,
			resetable: true
		};
	}

	protected getContainerClasses() {
		return ['setting-list-object-widget'];
	}

	protected getActionsForItem(item: IBoolObjectDataItem, idx: number): IAction[] {
		return [];
	}

	protected override isAddButtonVisible(): boolean {
		return false;
	}

	protected override renderHeader() {
		return undefined;
	}

	protected override renderDataOrEditItem(item: IListViewItem<IBoolObjectDataItem>, idx: number, listFocused: boolean): HTMLElement {
		const rowElement = this.renderEdit(item, idx);
		rowElement.setAttribute('role', 'listitem');
		return rowElement;
	}

	protected renderItem(item: IBoolObjectDataItem, idx: number): RowElementGroup {
		// Return just the containers, since we always render in edit mode anyway
		const rowElement = $('.blank-row');
		const keyElement = $('.blank-row-key');
		return { rowElement, keyElement };
	}

	protected renderEdit(item: IBoolObjectDataItem, idx: number): HTMLElement {
		const rowElement = $('.setting-list-edit-row.setting-list-object-row.setting-item-bool');

		const changedItem = { ...item };
		const onValueChange = (newValue: boolean) => {
			changedItem.value.data = newValue;
			this.handleItemChange(item, changedItem, idx);
		};
		const checkboxDescription = item.keyDescription ? `${item.keyDescription} (${item.key.data})` : item.key.data;
		const { element, widget: checkbox } = this.renderEditWidget((changedItem.value as IObjectBoolData).data, checkboxDescription, onValueChange);
		rowElement.appendChild(element);

		const valueElement = DOM.append(rowElement, $('.setting-list-object-value'));
		valueElement.textContent = checkboxDescription;

		// We add the tooltips here, because the method is not called by default
		// for widgets in edit mode
		const rowElementGroup = { rowElement, keyElement: valueElement, valueElement: checkbox.domNode };
		this.addTooltipsToRow(rowElementGroup, item);

		this.listDisposables.add(DOM.addDisposableListener(valueElement, DOM.EventType.MOUSE_DOWN, e => {
			const targetElement = <HTMLElement>e.target;
			if (targetElement.tagName.toLowerCase() !== 'a') {
				checkbox.checked = !checkbox.checked;
				onValueChange(checkbox.checked);
			}
			DOM.EventHelper.stop(e);
		}));

		return rowElement;
	}

	private renderEditWidget(
		value: boolean,
		checkboxDescription: string,
		onValueChange: (newValue: boolean) => void
	) {
		const checkbox = new Toggle({
			icon: Codicon.check,
			actionClassName: 'setting-value-checkbox',
			isChecked: value,
			title: checkboxDescription,
			...unthemedToggleStyles
		});

		this.listDisposables.add(checkbox);

		const wrapper = $('.setting-list-object-input');
		wrapper.classList.add('setting-list-object-input-key-checkbox');
		checkbox.domNode.classList.add('setting-value-checkbox');
		wrapper.appendChild(checkbox.domNode);

		this.listDisposables.add(DOM.addDisposableListener(wrapper, DOM.EventType.MOUSE_DOWN, e => {
			checkbox.checked = !checkbox.checked;
			onValueChange(checkbox.checked);

			// Without this line, the settings editor assumes
			// we lost focus on this setting completely.
			e.stopImmediatePropagation();
		}));

		return { widget: checkbox, element: wrapper };
	}

	protected addTooltipsToRow(rowElementGroup: RowElementGroup, item: IBoolObjectDataItem): void {
		const accessibleDescription = localize('objectPairHintLabel', "The property `{0}` is set to `{1}`.", item.key.data, item.value.data);
		const title = item.keyDescription ?? accessibleDescription;
		const { rowElement, keyElement, valueElement } = rowElementGroup;

		this.listDisposables.add(this.hoverService.setupDelayedHover(keyElement, { content: title }));
		valueElement!.setAttribute('aria-label', accessibleDescription);
		rowElement.setAttribute('aria-label', accessibleDescription);
	}

	protected getLocalizedStrings() {
		return {
			deleteActionTooltip: localize('removeItem', "Remove Item"),
			resetActionTooltip: localize('resetItem', "Reset Item"),
			editActionTooltip: localize('editItem', "Edit Item"),
			addButtonLabel: localize('addItem', "Add Item"),
			keyHeaderText: localize('objectKeyHeader', "Item"),
			valueHeaderText: localize('objectValueHeader', "Value"),
		};
	}
}

/* ------------------------------------------------------------------ *
 * PiCode's provider list
 * ------------------------------------------------------------------ */

/**
 * One provider as it is **stored**: the four fields, and nothing of how the row is edited.
 *
 * The split matters: the widget's items carry editing state (`editing`, `selected`) that must
 * never reach the settings file, so a row is edited as an item and saved as a value.
 */
export interface IProviderValue {
	readonly id: string;
	readonly endpoint: string;
	readonly api: string;
	readonly key: string;
}

/**
 * One model provider, as the settings row edits it.
 *
 * The row is PiCode's, and it is a **form** rather than the one-line-per-item the editor gives
 * an array of strings: a provider is four fields (name, address, dialect, key), and asking for
 * them one window at a time was the thing the owner refused ("no quiero la ventanita de
 * arriba"). The list widget paints rows; each row is edited in place with its four fields.
 */
export interface IProviderDataItem {
	editing?: boolean;
	selected?: boolean;

	/** The short name the model ids are built from (`omni/claude-sonnet-4`). */
	id: string;

	/** The endpoint's address. */
	endpoint: string;

	/** The dialect that endpoint speaks; one of `PROVIDER_DIALECTS`. */
	api: string;

	/**
	 * The credential: a literal, `$NAME` for an environment variable, or `!command`. Empty when the
	 * endpoint needs none.
	 */
	key: string;
}

/** The dialect a provider speaks when its row does not say. */
export const PROVIDER_LIST_DEFAULT_DIALECT = 'openai-completions';

/**
 * The dialects an endpoint can speak, in the order the form offers them.
 *
 * The values are the ones the connector and pi both use; the labels are what a person reads.
 * The same list the extension declares for the editor's own provider form, so the two ways of
 * declaring a provider cannot drift apart.
 */
const PROVIDER_DIALECTS: readonly { readonly value: string; readonly description: string }[] = [
	{ value: PROVIDER_LIST_DEFAULT_DIALECT, description: localize('picode.dialect.openai', "OpenAI (compatible)") },
	{ value: 'openai-responses', description: localize('picode.dialect.responses', "OpenAI (responses)") },
	{ value: 'anthropic-messages', description: localize('picode.dialect.anthropic', "Anthropic (messages)") },
	{ value: 'google-generative-ai', description: localize('picode.dialect.google', "Google (generative AI)") },
];

/** The name a provider's model ids are built from: no slashes, no spaces. */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** An address the connector will ask anything of: http(s), and nothing after the path. */
const PROVIDER_ADDRESS_PATTERN = /^https?:\/\/\S+$/;

/**
 * The one message an invalid row shows, or `undefined` when the row can be saved.
 *
 * Said as what is wrong rather than as which field failed a pattern, because the owner reads it
 * while typing and needs to know what to change.
 */
function providerFieldError(item: { id: string; endpoint: string }): string | undefined {
	if (item.id.length === 0) {
		return localize('picode.nameRequired', "Give the provider a name, for example omni.");
	}
	if (!PROVIDER_ID_PATTERN.test(item.id)) {
		return localize('picode.nameInvalid', "The name can have letters, numbers, dots, dashes and underscores.");
	}
	if (item.endpoint.length === 0) {
		return localize('picode.addressRequired', "Give the endpoint's address, for example https://endpoint.example/v1.");
	}
	if (!PROVIDER_ADDRESS_PATTERN.test(item.endpoint)) {
		return localize('picode.addressInvalid', "The address has to start with http:// or https://.");
	}
	return undefined;
}

/**
 * The settings row that edits PiCode's model providers: a list of providers, each one a form.
 *
 * The editor's own list widget does the parts that are the editor's (rows, the add button, the
 * edit and remove actions, the keyboard handling, the value plumbing); what is PiCode's is the
 * row's content and what a row means.
 */
export class ProviderListSettingWidget extends AbstractListSettingWidget<IProviderDataItem> {

	/** Guards a slow status answer against a newer render of the profile rows. */
	private profileRowsSequence = 0;

	constructor(
		container: HTMLElement,
		@IThemeService themeService: IThemeService,
		@IContextViewService contextViewService: IContextViewService,
		@IHoverService private readonly hoverService: IHoverService,
		@IConfigurationService configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(container, themeService, contextViewService, configurationService);
	}

	protected getEmptyItem(): IProviderDataItem {
		return { id: '', endpoint: '', api: PROVIDER_LIST_DEFAULT_DIALECT, key: '' };
	}

	isItemNew(item: IProviderDataItem): boolean {
		return item.id === '' && item.endpoint === '';
	}

	protected getContainerClasses(): string[] {
		return ['setting-list-object-widget', 'picode-providers'];
	}

	protected getActionsForItem(item: IProviderDataItem, idx: number): IAction[] {
		return [
			{
				class: ThemeIcon.asClassName(settingsEditIcon),
				enabled: true,
				id: 'workbench.action.editListItem',
				label: '',
				tooltip: this.getLocalizedStrings().editActionTooltip,
				run: () => this.editSetting(idx),
			},
			{
				class: ThemeIcon.asClassName(settingsRemoveIcon),
				enabled: true,
				id: 'workbench.action.removeListItem',
				label: '',
				tooltip: this.getLocalizedStrings().deleteActionTooltip,
				run: () => this._onDidChangeList.fire({ type: 'remove', originalItem: item, targetIndex: idx }),
			},
		];
	}

	protected renderItem(item: IProviderDataItem, _idx: number): RowElementGroup {
		const rowElement = $('.setting-list-row.picode-provider-row');
		const nameElement = DOM.append(rowElement, $('.setting-list-object-key'));
		const detailElement = DOM.append(rowElement, $('.setting-list-object-value'));

		nameElement.textContent = item.id;
		// The address, plus what is not an address: the dialect only when it is not the usual
		// one, and the fact that a credential is there — never the credential itself.
		const dialect = item.api === PROVIDER_LIST_DEFAULT_DIALECT ? '' : ` · ${item.api}`;
		const credential = item.key.length === 0 ? '' : localize('picode.hasKey', " · key");
		detailElement.textContent = `${item.endpoint}${dialect}${credential}`;

		return { rowElement, keyElement: nameElement, valueElement: detailElement };
	}

	protected renderEdit(item: IProviderDataItem, idx: number): HTMLElement {
		const rowElement = $('.setting-list-edit-row.picode-provider-edit');
		const changedItem: IProviderDataItem = { ...item };

		const messageElement = DOM.append(rowElement, $('.picode-provider-message'));

		const textField = (label: string, value: string, placeholder: string, onInput: (value: string) => void): void => {
			const field = DOM.append(rowElement, $('.picode-provider-field'));
			DOM.append(field, $('span.picode-provider-label')).textContent = label;

			const inputBox = new InputBox(field, this.contextViewService, {
				placeholder,
				ariaLabel: label,
				inputBoxStyles: getInputBoxStyle({
					inputBackground: settingsTextInputBackground,
					inputForeground: settingsTextInputForeground,
					inputBorder: settingsTextInputBorder,
				}),
			});
			inputBox.element.classList.add('picode-provider-input');
			this.listDisposables.add(inputBox);
			inputBox.value = value;
			this.listDisposables.add(inputBox.onDidChange(next => {
				onInput(next);
				refreshValidity();
			}));

			const onKeyDown = (e: StandardKeyboardEvent) => {
				if (e.equals(KeyCode.Enter)) {
					this.handleItemChange(item, changedItem, idx);
				} else if (e.equals(KeyCode.Escape)) {
					this.cancelEdit();
					e.preventDefault();
					e.stopPropagation();
				}
			};
			this.listDisposables.add(DOM.addStandardDisposableListener(inputBox.inputElement, DOM.EventType.KEY_DOWN, onKeyDown));
		};

		const okButton = this.listDisposables.add(new Button(rowElement, defaultButtonStyles));
		okButton.label = localize('okButton', "OK");
		okButton.element.classList.add('setting-list-ok-button');

		const refreshValidity = () => {
			const error = providerFieldError(changedItem);
			rowElement.classList.toggle('invalid-input', error !== undefined);
			messageElement.textContent = error ?? '';
			okButton.enabled = error === undefined;
		};

		textField(
			localize('picode.field.name', "Name"),
			item.id,
			localize('picode.field.name.placeholder', "omni"),
			value => (changedItem.id = value.trim()),
		);
		textField(
			localize('picode.field.address', "Address"),
			item.endpoint,
			localize('picode.field.address.placeholder', "https://endpoint.example/v1"),
			value => (changedItem.endpoint = value.trim()),
		);

		// The dialect is a list, not free text: a typo here is a request that fails with a 404 or a
		// 400 while everything looks configured.
		const dialectField = DOM.append(rowElement, $('.picode-provider-field'));
		DOM.append(dialectField, $('span.picode-provider-label')).textContent = localize('picode.field.dialect', "Dialect");
		const dialectBox = this.createBasicSelectBox({
			type: 'enum',
			data: item.api,
			options: PROVIDER_DIALECTS.map(dialect => ({ value: dialect.value, description: dialect.description })),
		});
		dialectBox.render(dialectField);
		this.listDisposables.add(dialectBox);
		this.listDisposables.add(dialectBox.onDidSelect(option => (changedItem.api = option.selected)));

		textField(
			localize('picode.field.key', "Key"),
			item.key,
			localize('picode.field.key.placeholder', "$MY_PROVIDER_KEY"),
			value => (changedItem.key = value.trim()),
		);

		refreshValidity();
		this.listDisposables.add(okButton.onDidClick(() => this.handleItemChange(item, changedItem, idx)));

		return rowElement;
	}

	protected addTooltipsToRow(rowElementGroup: RowElementGroup, item: IProviderDataItem): void {
		const { rowElement, keyElement, valueElement } = rowElementGroup;
		const description = localize('picode.providerHint', "Provider `{0}` at `{1}`, speaking `{2}`.", item.id, item.endpoint, item.api);
		this.listDisposables.add(this.hoverService.setupDelayedHover(keyElement, { content: description }));
		valueElement!.setAttribute('aria-label', description);
		rowElement.setAttribute('aria-label', description);
	}

	protected override renderList(): void {
		super.renderList();
		void this.renderProfileRows();
	}

	/**
	 * The providers the **profile** knows that the form does not declare — nan behind an
	 * installed package, a subscription whose sign-in lives in `auth.json` — as read-only
	 * rows after the editable ones. The form edits declarations; a provider pi knows by
	 * itself has no row here to edit, and the owner said the missing one read as broken:
	 * «Los proveedores no me sale nan».
	 */
	private async renderProfileRows(): Promise<void> {
		const sequence = ++this.profileRowsSequence;
		const rows = await profileProviders(this.commandService);
		if (sequence !== this.profileRowsSequence || rows.length === 0 || !this.listElement.isConnected) {
			return;
		}

		const separator = DOM.append(this.listElement, $('.setting-list-row.picode-provider-profile-separator'));
		separator.textContent = this.getLocalizedStrings().profileSeparatorLabel;

		for (const row of rows) {
			const rowElement = DOM.append(this.listElement, $('.setting-list-row.picode-provider-row.picode-provider-profile'));
			const nameElement = DOM.append(rowElement, $('.setting-list-object-key'));
			nameElement.textContent = row.id;
			const detailElement = DOM.append(rowElement, $('.setting-list-object-value'));
			const facts: string[] = [];
			if (row.models) {
				facts.push(this.getLocalizedStrings().profileModels);
			}
			if (row.credential) {
				facts.push(this.getLocalizedStrings().profileCredential);
			}
			detailElement.textContent = facts.join(' · ');
			rowElement.title = this.getLocalizedStrings().profileRowTooltip;
		}
	}

	protected getLocalizedStrings() {
		return {
			deleteActionTooltip: localize('picode.removeProvider', "Remove provider"),
			editActionTooltip: localize('picode.editProvider', "Edit provider"),
			addButtonLabel: localize('picode.addProvider', "Add provider"),
			profileSeparatorLabel: localize('picode.profileProviders', "From your pi profile"),
			profileModels: localize('picode.profileProviderModels', "models"),
			profileCredential: localize('picode.profileProviderCredential', "sign-in"),
			profileRowTooltip: localize('picode.profileProviderTooltip', "pi knows this provider from its own profile — a package, a subscription. It has no row in this form to edit; the status view shows it in full."),
		};
	}
}

/** One provider the profile knows that no declaration explains, as the status answer carries it. */
interface IProfileProviderRow {
	readonly id: string;
	readonly models: boolean;
	readonly credential: boolean;
}

/** How long the profile's provider answer is reused: the status command reads git. */
const PROFILE_PROVIDERS_TTL_MS = 60_000;

/** The cached answer, shared by every settings page this session renders. */
let profileProvidersCache: { rows: readonly IProfileProviderRow[]; at: number } | undefined;

/**
 * The providers the profile knows and the form does not declare, from the connector's own
 * status answer — the same three-source union the status view shows, minus the declared
 * rows this form already lists. A status the connector cannot give (it is not running) is
 * "no extra rows", never an invented provider.
 */
async function profileProviders(commandService: ICommandService): Promise<readonly IProfileProviderRow[]> {
	if (profileProvidersCache !== undefined && Date.now() - profileProvidersCache.at < PROFILE_PROVIDERS_TTL_MS) {
		return profileProvidersCache.rows;
	}
	let rows: readonly IProfileProviderRow[] = [];
	try {
		const data = await commandService.executeCommand<{ providers?: readonly { id: string; declared: boolean; models: boolean; credential: boolean }[] }>('picode.setup.status');
		rows = (data?.providers ?? [])
			.filter(provider => !provider.declared && provider.id.length > 0)
			.map(provider => ({ id: provider.id, models: provider.models, credential: provider.credential }));
	} catch {
		// The connector is not answering; the form shows only what it declares.
	}
	profileProvidersCache = { rows, at: Date.now() };
	return rows;
}

/* ------------------------------------------------------------------ *
 * PiCode's MCP servers
 * ------------------------------------------------------------------ */

/** One MCP server as it is stored: four fields, and nothing of how the row is edited. */
export interface IMcpServerValue {
	readonly name: string;
	readonly transport: string;
	readonly target: string;
	readonly args: string;
	readonly key: string;
}

/**
 * One MCP server, as the settings row edits it.
 *
 * The fields are **mutable** here, unlike the stored value: the form changes them while the owner
 * types, and only the stored shape is read-only.
 */
export interface IMcpServerDataItem {
	editing?: boolean;
	selected?: boolean;
	name: string;
	transport: string;
	target: string;
	args: string;
	key: string;
}

/** The transports an MCP server can use, in the order the form offers them. */
const MCP_TRANSPORTS: readonly { readonly value: string; readonly description: string }[] = [
	{ value: 'http', description: localize('picode.mcp.http', "Remote (an address)") },
	{ value: 'stdio', description: localize('picode.mcp.stdio', "Local (a command)") },
];

/** The name a server is called by, and the shape of a remote address. */
const MCP_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const MCP_URL_PATTERN = /^https?:\/\/\S+$/;

/**
 * What is wrong with a row, or `undefined` when it can be saved.
 *
 * A remote server needs an address and a local one needs a command: the message says which, in the
 * owner's words, because he reads it while typing.
 */
function mcpFieldError(item: { name: string; transport: string; target: string }): string | undefined {
	if (item.name.length === 0) {
		return localize('picode.mcp.nameRequired', "Give the server a name, for example vercel.");
	}
	if (!MCP_NAME_PATTERN.test(item.name)) {
		return localize('picode.mcp.nameInvalid', "The name can have letters, numbers, dots, dashes and underscores.");
	}
	if (item.target.length === 0) {
		return item.transport === 'http'
			? localize('picode.mcp.urlRequired', "Give the server's address, for example https://mcp.vercel.com.")
			: localize('picode.mcp.commandRequired', "Give the command that starts the server, for example npx.");
	}
	if (item.transport === 'http' && !MCP_URL_PATTERN.test(item.target)) {
		return localize('picode.mcp.urlInvalid', "A remote server's address has to start with http:// or https://.");
	}
	return undefined;
}

/**
 * The settings row that edits PiCode's MCP servers: one server per row, each one a small form.
 *
 * The servers live in PiCode's own pi profile, so nothing is read or written outside the product.
 * What the owner fills in here becomes the `mcpServers` of that profile's `mcp.json`, which is the
 * file pi's own MCP reads.
 */
export class McpServerListSettingWidget extends AbstractListSettingWidget<IMcpServerDataItem> {

	constructor(
		container: HTMLElement,
		@IThemeService themeService: IThemeService,
		@IContextViewService contextViewService: IContextViewService,
		@IHoverService private readonly hoverService: IHoverService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super(container, themeService, contextViewService, configurationService);
	}

	protected getEmptyItem(): IMcpServerDataItem {
		return { name: '', transport: 'http', target: '', args: '', key: '' };
	}

	isItemNew(item: IMcpServerDataItem): boolean {
		return item.name === '' && item.target === '';
	}

	protected getContainerClasses(): string[] {
		return ['setting-list-object-widget', 'picode-mcp-servers'];
	}

	protected getActionsForItem(item: IMcpServerDataItem, idx: number): IAction[] {
		return [
			{
				class: ThemeIcon.asClassName(settingsEditIcon),
				enabled: true,
				id: 'workbench.action.editListItem',
				label: '',
				tooltip: this.getLocalizedStrings().editActionTooltip,
				run: () => this.editSetting(idx),
			},
			{
				class: ThemeIcon.asClassName(settingsRemoveIcon),
				enabled: true,
				id: 'workbench.action.removeListItem',
				label: '',
				tooltip: this.getLocalizedStrings().deleteActionTooltip,
				run: () => this._onDidChangeList.fire({ type: 'remove', originalItem: item, targetIndex: idx }),
			},
		];
	}

	protected renderItem(item: IMcpServerDataItem, _idx: number): RowElementGroup {
		const rowElement = $('.setting-list-row.picode-mcp-row');
		const nameElement = DOM.append(rowElement, $('.setting-list-object-key'));
		const detailElement = DOM.append(rowElement, $('.setting-list-object-value'));

		nameElement.textContent = item.name;
		// What the row does, and never the credential itself.
		const credential = item.key.length === 0 ? '' : localize('picode.mcp.hasKey', " · key");
		const args = item.args.length === 0 ? '' : ` ${item.args}`;
		detailElement.textContent = `${item.transport} · ${item.target}${args}${credential}`;

		return { rowElement, keyElement: nameElement, valueElement: detailElement };
	}

	protected renderEdit(item: IMcpServerDataItem, idx: number): HTMLElement {
		const rowElement = $('.setting-list-edit-row.picode-mcp-edit');
		const changedItem: IMcpServerDataItem = { ...item };

		const messageElement = DOM.append(rowElement, $('.picode-provider-message'));

		const textField = (label: string, value: string, placeholder: string, onInput: (value: string) => void): void => {
			const field = DOM.append(rowElement, $('.picode-provider-field'));
			DOM.append(field, $('span.picode-provider-label')).textContent = label;

			const inputBox = new InputBox(field, this.contextViewService, {
				placeholder,
				ariaLabel: label,
				inputBoxStyles: getInputBoxStyle({
					inputBackground: settingsTextInputBackground,
					inputForeground: settingsTextInputForeground,
					inputBorder: settingsTextInputBorder,
				}),
			});
			inputBox.element.classList.add('picode-provider-input');
			this.listDisposables.add(inputBox);
			inputBox.value = value;
			this.listDisposables.add(inputBox.onDidChange(next => {
				onInput(next);
				refreshValidity();
			}));

			const onKeyDown = (e: StandardKeyboardEvent) => {
				if (e.equals(KeyCode.Enter)) {
					this.handleItemChange(item, changedItem, idx);
				} else if (e.equals(KeyCode.Escape)) {
					this.cancelEdit();
					e.preventDefault();
					e.stopPropagation();
				}
			};
			this.listDisposables.add(DOM.addStandardDisposableListener(inputBox.inputElement, DOM.EventType.KEY_DOWN, onKeyDown));
		};

		const okButton = this.listDisposables.add(new Button(rowElement, defaultButtonStyles));
		okButton.label = localize('okButton', "OK");
		okButton.element.classList.add('setting-list-ok-button');

		const refreshValidity = () => {
			const error = mcpFieldError(changedItem);
			rowElement.classList.toggle('invalid-input', error !== undefined);
			messageElement.textContent = error ?? '';
			okButton.enabled = error === undefined;
		};

		textField(
			localize('picode.mcp.field.name', "Name"),
			item.name,
			localize('picode.mcp.field.name.placeholder', "vercel"),
			value => (changedItem.name = value.trim()),
		);

		const transportField = DOM.append(rowElement, $('.picode-provider-field'));
		DOM.append(transportField, $('span.picode-provider-label')).textContent = localize('picode.mcp.field.transport', "Where it runs");
		const transportBox = this.createBasicSelectBox({
			type: 'enum',
			data: item.transport,
			options: MCP_TRANSPORTS.map(transport => ({ value: transport.value, description: transport.description })),
		});
		transportBox.render(transportField);
		this.listDisposables.add(transportBox);
		this.listDisposables.add(transportBox.onDidSelect(option => {
			changedItem.transport = option.selected;
			refreshValidity();
		}));

		textField(
			localize('picode.mcp.field.target', "Address or command"),
			item.target,
			localize('picode.mcp.field.target.placeholder', "https://mcp.vercel.com"),
			value => (changedItem.target = value.trim()),
		);
		textField(
			localize('picode.mcp.field.args', "Arguments"),
			item.args,
			localize('picode.mcp.field.args.placeholder', "-y chrome-devtools-mcp"),
			value => (changedItem.args = value.trim()),
		);
		textField(
			localize('picode.mcp.field.key', "Token"),
			item.key,
			localize('picode.mcp.field.key.placeholder', "only if the server needs one"),
			value => (changedItem.key = value.trim()),
		);

		refreshValidity();
		this.listDisposables.add(okButton.onDidClick(() => this.handleItemChange(item, changedItem, idx)));

		return rowElement;
	}

	protected addTooltipsToRow(rowElementGroup: RowElementGroup, item: IMcpServerDataItem): void {
		const { rowElement, keyElement, valueElement } = rowElementGroup;
		const description = localize('picode.mcp.hint', "MCP server `{0}`: {1} at `{2}`.", item.name, item.transport, item.target);
		this.listDisposables.add(this.hoverService.setupDelayedHover(keyElement, { content: description }));
		valueElement!.setAttribute('aria-label', description);
		rowElement.setAttribute('aria-label', description);
	}

	protected getLocalizedStrings() {
		return {
			deleteActionTooltip: localize('picode.mcp.removeServer', "Remove server"),
			editActionTooltip: localize('picode.mcp.editServer', "Edit server"),
			addButtonLabel: localize('picode.mcp.addServer', "Add server"),
		};
	}
}
