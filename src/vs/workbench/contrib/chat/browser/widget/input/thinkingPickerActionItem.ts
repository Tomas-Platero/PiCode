/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { renderLabelWithIcons } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Event } from '../../../../../../base/common/event.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../../../nls.js';
import { Action2, MenuId, MenuItemAction } from '../../../../../../platform/actions/common/actions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction, IActionWidgetDropdownActionProvider } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import { CHAT_CATEGORY } from '../../actions/chatActions.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { ChatAgentLocation } from '../../../common/constants.js';
import { PICODE_THINKING_LEVEL_SETTING } from '../../../../picode/browser/picodeConfiguration.js';
import { ChatInputPickerActionViewItem, IChatInputPickerOptions } from './chatInputPickerActionItem.js';

/**
 * Mirror of `THINKING_LEVELS` in the PiCode extension
 * (`extensions/picode/src/piConfig.ts`): the levels pi accepts, in the
 * order it accepts them. `undefined` (or the setting's own `'default'`)
 * means pi's own default and is displayed as "Default".
 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export const OpenThinkingPickerActionId = 'workbench.action.chat.openThinkingPicker';

/**
 * Opens the thinking-level picker for pi. Writes the user-level
 * `picode.pi.thinkingLevel` setting; the connector applies it on the next
 * turn. Selecting "Default" clears the setting so pi's own default applies.
 */
export class OpenThinkingPickerAction extends Action2 {
	static readonly ID = OpenThinkingPickerActionId;

	constructor() {
		super({
			id: OpenThinkingPickerAction.ID,
			title: localize2('interactive.openThinkingPicker.label', "Open Thinking Level Picker"),
			tooltip: localize('setThinkingLevel', "Set Thinking Level"),
			category: CHAT_CATEGORY,
			f1: false,
			icon: Codicon.sparkle,
			precondition: ChatContextKeys.enabled,
			menu: {
				id: MenuId.ChatInput,
				order: 3.5,
				group: 'navigation',
				when: ContextKeyExpr.and(
					ChatContextKeys.enabled,
					ChatContextKeys.location.isEqualTo(ChatAgentLocation.Chat),
					ChatContextKeys.inQuickChat.negate(),
					ChatContextKeys.inAgentSessionsWelcome.negate()),
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const quickInputService = accessor.get(IQuickInputService);

		const current = configurationService.getValue<string | undefined>(PICODE_THINKING_LEVEL_SETTING);
		const currentLevel = toThinkingLevel(current);

		interface IThinkingLevelPickItem extends IQuickPickItem {
			/** The setting value to write, or `undefined` for pi's own default. */
			readonly level: string | undefined;
		}

		const defaultItem: IThinkingLevelPickItem = {
			label: localize('thinkingLevel.default', "Default"),
			description: localize('thinkingLevel.defaultDescription', "pi's own level"),
			level: undefined,
		};
		const levelItems: IThinkingLevelPickItem[] = THINKING_LEVELS.map(level => ({
			label: capitalize(level),
			level,
		}));
		const items = [defaultItem, ...levelItems];

		const quickPick = quickInputService.createQuickPick<IThinkingLevelPickItem>();
		quickPick.placeholder = localize('thinkingLevel.placeHolder', "How hard pi thinks before answering");
		quickPick.items = items;
		quickPick.activeItems = items.filter(item => item.level === currentLevel);
		quickPick.show();
		const pick = await new Promise<IThinkingLevelPickItem | undefined>(resolve => {
			Event.once(quickPick.onDidAccept)(() => resolve(quickPick.selectedItems[0]));
			Event.once(quickPick.onDidHide)(() => resolve(undefined));
		});
		quickPick.dispose();
		if (!pick) {
			return;
		}
		// Writing `undefined` clears the user setting so pi's own default applies.
		await configurationService.updateValue(PICODE_THINKING_LEVEL_SETTING, pick.level, ConfigurationTarget.USER);
	}
}

/** Normalizes the setting's value to a known level, or `undefined` for pi's own default. */
function toThinkingLevel(value: string | undefined): string | undefined {
	if (typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)) {
		return value;
	}
	return undefined;
}

function capitalize(level: string): string {
	return level.charAt(0).toUpperCase() + level.slice(1);
}

/**
 * Chat input toolbar chip showing pi's current thinking level next to the model picker. The label
 * is the level name (or "Default"); clicking opens a dropdown under the chip, the same kind of list
 * the model picker uses, with the levels and a check on the one in force.
 */
export class ThinkingPickerActionItem extends ChatInputPickerActionViewItem {

	constructor(
		action: MenuItemAction,
		pickerOptions: IChatInputPickerOptions,
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		const actionProvider: IActionWidgetDropdownActionProvider = {
			getActions: () => {
				const current = toThinkingLevel(_configurationService.getValue<string | undefined>(PICODE_THINKING_LEVEL_SETTING));
				const choose = (level: string | undefined) => async () => {
					// Writing `undefined` clears the user setting so pi's own default applies.
					await _configurationService.updateValue(PICODE_THINKING_LEVEL_SETTING, level, ConfigurationTarget.USER);
				};
				const entries: { level: string | undefined; label: string; detail?: string }[] = [
					{ level: undefined, label: localize('thinkingLevel.default', "Default"), detail: localize('thinkingLevel.defaultDescription', "pi's own level") },
					...THINKING_LEVELS.map(level => ({ level, label: capitalize(level) })),
				];
				return entries.map(entry => ({
					...action,
					id: `chat.thinking.${entry.level ?? 'default'}`,
					label: entry.label,
					...(entry.detail === undefined ? {} : { description: entry.detail }),
					checked: entry.level === current,
					enabled: true,
					tooltip: '',
					run: choose(entry.level),
				} satisfies IActionWidgetDropdownAction));
			}
		};

		super(action, {
			actionProvider,
			reporter: { id: 'ChatThinkingPicker', name: 'ChatThinkingPicker', includeOptions: true },
			listOptions: { minWidth: 240, ...pickerOptions.listOptions },
		}, pickerOptions, actionWidgetService, keybindingService, contextKeyService, telemetryService);

		// Repaint when the setting changes (including from the Settings editor).
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PICODE_THINKING_LEVEL_SETTING) && this.element) {
				this.renderLabel(this.element);
			}
		}));
		// Repaint when the toolbar enters or leaves its compact layout.
		this._register(autorun(reader => {
			pickerOptions.compact.read(reader);
			if (this.element) {
				this.renderLabel(this.element);
			}
		}));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('chat-input-picker-item', 'chat-thinking-picker-item');
	}

	protected override renderLabel(element: HTMLElement): IDisposable | null {
		this.setAriaLabelAttributes(element);
		const level = toThinkingLevel(this._configurationService.getValue<string | undefined>(PICODE_THINKING_LEVEL_SETTING));
		const display = level ? capitalize(level) : localize('thinkingLevel.default', "Default");

		const parts: (HTMLElement | string)[] = [...renderLabelWithIcons(`$(${Codicon.sparkle.id})`)];
		// In the compact layout only the icon is shown, like the other input chips.
		if (!this.pickerOptions.compact.get()) {
			parts.push(dom.$('span.chat-input-picker-label', undefined, display));
		}
		dom.reset(element, ...parts);
		element.setAttribute('aria-label', localize('thinkingPickerAriaLabel', "Thinking Level: {0}", display));
		return null;
	}
}
