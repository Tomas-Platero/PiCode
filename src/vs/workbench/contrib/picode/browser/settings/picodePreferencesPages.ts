/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { language } from '../../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { ColorScheme } from '../../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { aiCustomizationManagementSectionRegistry } from '../../../chat/browser/aiCustomization/aiCustomizationManagementSectionRegistry.js';
import { AICustomizationManagementSection } from '../../../chat/common/aiCustomizationWorkspaceService.js';
import { IWorkbenchThemeService } from '../../../../services/themes/common/workbenchThemeService.js';
import { PicodeSettingsPage } from './picodeSettingsRows.js';

/** What the connector's status reading says about versions and dictation; the rest is unused here. */
interface IAgentStatus {
	readonly runtime?: string;
	readonly piVersion?: string;
	readonly updates?: {
		readonly checkedAt?: number;
		readonly targets?: readonly { readonly kind?: 'runtime' | 'package' | 'engine'; readonly name: string; readonly installed: string; readonly latest: string }[];
	};
	readonly voice?: { readonly state: 'unsupported' | 'not-installed' | 'downloading' | 'ready'; readonly sizeMb?: number; readonly percent?: number };
}

const STATUS_DATA_COMMAND = 'picode.setup.status';

interface IPageSpec {
	readonly id: AICustomizationManagementSection;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly description: string;
	/** The names of the page's rows, so the search box finds the page by them. */
	readonly keywords: readonly string[];
	build(page: PicodeSettingsPage, accessor: IPageServices): void;
}

interface IPageServices {
	readonly commandService: ICommandService;
	readonly configurationService: IConfigurationService;
	readonly themeService: IThemeService;
	readonly workbenchThemeService: IWorkbenchThemeService;
	readonly productService: IProductService;
	readonly instantiationService: IInstantiationService;
}

function registerPage(spec: IPageSpec): void {
	aiCustomizationManagementSectionRegistry.register({
		id: spec.id,
		label: spec.label,
		icon: spec.icon,
		description: spec.description,
		keywords: spec.keywords,
		supportsHarness: () => true,
		create: (instantiationService, container) => instantiationService.invokeFunction(accessor => {
			const services: IPageServices = {
				commandService: accessor.get(ICommandService),
				configurationService: accessor.get(IConfigurationService),
				themeService: accessor.get(IThemeService),
				workbenchThemeService: accessor.get(IWorkbenchThemeService),
				productService: accessor.get(IProductService),
				instantiationService,
			};
			const page = instantiationService.createInstance(PicodeSettingsPage, container, spec.label, spec.description);
			spec.build(page, services);
			return page satisfies IDisposable;
		}),
	});
}

/** The name of a display language in that language: "Español", "Deutsch". */
function languageName(locale: string): string {
	try {
		const name = new Intl.DisplayNames([locale], { type: 'language' }).of(locale);
		return name ? name.charAt(0).toLocaleUpperCase(locale) + name.slice(1) : locale;
	} catch {
		return locale;
	}
}

// ---- General ----------------------------------------------------------------------------

registerPage({
	id: AICustomizationManagementSection.General,
	label: localize('picodePrefGeneral', "General"),
	icon: Codicon.settings,
	description: localize('picodeSetGeneralDesc', "Appearance, language and startup."),
	keywords: ['theme', 'dark', 'light', 'layout', 'agent', 'editor', 'language', 'zoom', 'startup', 'windows'],
	build: (page, { configurationService, themeService, commandService, workbenchThemeService }) => {
		page.group(localize('picodePrefAppearance', "Appearance"));

		type ThemeMode = 'system' | 'light' | 'dark';
		const isLight = (type: ColorScheme) => type === ColorScheme.LIGHT || type === ColorScheme.HIGH_CONTRAST_LIGHT;
		// What is on screen, not what was asked for: the choice follows the theme in force.
		const themeMode = (): ThemeMode => {
			if (configurationService.getValue<boolean>('window.autoDetectColorScheme')) {
				return 'system';
			}
			return isLight(workbenchThemeService.getColorTheme().type) ? 'light' : 'dark';
		};
		const repaintThemeMode = page.customSegmentedRow<ThemeMode>(
			{ name: localize('picodePrefTheme', "Theme"), description: localize('picodeSetThemeDesc', "Match your system, or always use light or dark."), keywords: 'dark light system' },
			[
				{ value: 'system', label: localize('picodePrefThemeSystem', "System"), icon: Codicon.deviceDesktop },
				{ value: 'light', label: localize('picodePrefThemeLight', "Light"), icon: Codicon.lightbulb },
				{ value: 'dark', label: localize('picodePrefThemeDark', "Dark"), icon: Codicon.colorMode },
			],
			themeMode,
			async (mode, saved) => {
				if (mode === 'system') {
					await configurationService.updateValue('window.autoDetectColorScheme', true, ConfigurationTarget.USER);
				} else {
					await configurationService.updateValue('window.autoDetectColorScheme', false, ConfigurationTarget.USER);
					// The preferred light or dark theme when it is installed; otherwise the first one of
					// that kind, so the click always changes the look.
					const wantLight = mode === 'light';
					const preferred = configurationService.getValue<string>(wantLight ? 'workbench.preferredLightColorTheme' : 'workbench.preferredDarkColorTheme');
					const themes = await workbenchThemeService.getColorThemes();
					const target = themes.find(t => t.settingsId === preferred && isLight(t.type) === wantLight)
						?? themes.find(t => isLight(t.type) === wantLight && t.type !== ColorScheme.HIGH_CONTRAST_LIGHT && t.type !== ColorScheme.HIGH_CONTRAST_DARK);
					if (target && isLight(workbenchThemeService.getColorTheme().type) !== wantLight) {
						await workbenchThemeService.setColorTheme(target, ConfigurationTarget.USER);
					}
				}
				repaintThemeMode();
				page.markSaved(saved);
			},
			['window.autoDetectColorScheme', 'workbench.colorTheme'],
		);
		page.register(workbenchThemeService.onDidColorThemeChange(() => repaintThemeMode()));

		const themeName = () => themeService.getColorTheme().label;
		const themeRow = page.row({ name: localize('picodePrefColorTheme', "Color theme"), description: themeName(), keywords: 'colors' });
		page.button(themeRow, localize('picodePrefBrowseThemes', "Browse themes"), () => commandService.executeCommand('aiCustomization.openManagementEditor', AICustomizationManagementSection.Themes), { icon: Codicon.symbolColor });
		page.onSettingChange('workbench.colorTheme', () => {
			const desc = themeRow.parentElement?.querySelector('.picode-set-row-desc');
			if (desc) {
				desc.textContent = themeName();
			}
		});

		page.segmentedRow({
			key: 'picode.appearance.layout',
			name: localize('picodePrefLayout', "Layout"),
			description: localize('picodePrefLayoutDesc', "Agent puts the chat in the middle. Editor is the classic layout."),
			choices: [
				{ value: 'agent', label: localize('picodePrefLayoutAgent', "Agent"), icon: Codicon.robot },
				{ value: 'editor', label: localize('picodePrefLayoutEditor', "Editor"), icon: Codicon.code },
			],
		});

		page.buttonRow(
			{ name: localize('picodePrefLanguage', "Language"), description: languageName(language), keywords: 'idioma display locale' },
			localize('picodePrefChange', "Change"),
			() => commandService.executeCommand('workbench.action.configureLocale'),
			{ icon: Codicon.globe },
		);

		page.selectRow<number>({
			key: 'window.zoomLevel',
			name: localize('picodePrefZoom', "Zoom"),
			description: localize('picodeSetZoomDesc', "Size of text and controls."),
			choices: [-2, -1, 0, 1, 2, 3].map(level => ({ value: level, label: `${Math.round(Math.pow(1.2, level) * 100)}%` })),
			read: stored => typeof stored === 'number' ? Math.round(stored) : 0,
		});

		page.group(localize('picodePrefStartup', "Startup"));
		page.selectRow<string>({
			key: 'window.restoreWindows',
			name: localize('picodeSetRestore', "Restore windows"),
			description: localize('picodeSetRestoreDesc', "What reopens when PiCode starts."),
			choices: [
				{ value: 'all', label: localize('picodeSetRestoreAll', "All windows") },
				{ value: 'preserve', label: localize('picodeSetRestorePreserve', "Always all windows") },
				{ value: 'folders', label: localize('picodeSetRestoreFolders', "Folders only") },
				{ value: 'one', label: localize('picodeSetRestoreOne', "Last window") },
				{ value: 'none', label: localize('picodeSetRestoreNone', "None") },
			],
		});
		page.selectRow<string>({
			key: 'workbench.startupEditor',
			name: localize('picodeSetStartupEditor', "Startup page"),
			description: localize('picodeSetStartupEditorDesc', "Shown when no file is open."),
			choices: [
				{ value: 'welcomePage', label: localize('picodePrefStartupWelcome', "Welcome page") },
				{ value: 'welcomePageInEmptyWorkbench', label: localize('picodeSetStartupWelcomeEmpty', "Welcome page (empty window only)") },
				{ value: 'newUntitledFile', label: localize('picodeSetStartupNewFile', "New file") },
				{ value: 'none', label: localize('picodeSetStartupNone', "None") },
			],
		});
	},
});

// ---- Editor -----------------------------------------------------------------------------

registerPage({
	id: AICustomizationManagementSection.EditorPreferences,
	label: localize('picodePrefEditor', "Editor"),
	icon: Codicon.code,
	description: localize('picodeSetEditorDesc', "Text, formatting and saving."),
	keywords: ['font', 'size', 'tab', 'wrap', 'minimap', 'format', 'save', 'line numbers'],
	build: page => {
		page.group(localize('picodePrefText', "Text"));
		page.textRow({ key: 'editor.fontFamily', name: localize('picodeSetFont', "Font family"), description: localize('picodeSetFontDesc', "Comma-separated; the first installed font is used."), keywords: 'font family' });
		page.numberRow({ key: 'editor.fontSize', name: localize('picodePrefFontSize', "Font size"), min: 8, max: 40, keywords: 'font size' });
		page.numberRow({ key: 'editor.tabSize', name: localize('picodeSetTabSize', "Tab size"), description: localize('picodeSetTabSizeDesc', "Number of spaces per tab."), min: 1, max: 16, keywords: 'indent' });
		page.selectRow<string>({
			key: 'editor.wordWrap',
			name: localize('picodeSetWrap', "Word wrap"),
			choices: [
				{ value: 'off', label: localize('picodeSetWrapOff', "Off") },
				{ value: 'on', label: localize('picodeSetWrapOn', "On") },
				{ value: 'bounded', label: localize('picodeSetWrapBounded', "At column limit") },
			],
		});
		page.selectRow<string>({
			key: 'editor.lineNumbers',
			name: localize('picodePrefLineNumbers', "Line numbers"),
			choices: [
				{ value: 'on', label: localize('picodeSetLineNumbersOn', "On") },
				{ value: 'relative', label: localize('picodeSetLineNumbersRelative', "Relative") },
				{ value: 'off', label: localize('picodeSetLineNumbersOff', "Off") },
			],
		});
		page.switchRow({ key: 'editor.minimap.enabled', name: localize('picodePrefMinimap', "Minimap"), description: localize('picodeSetMinimapDesc', "Code overview along the right edge.") });

		page.group(localize('picodePrefSaving', "Saving"));
		page.selectRow<string>({
			key: 'files.autoSave',
			name: localize('picodeSetAutoSave', "Auto save"),
			choices: [
				{ value: 'off', label: localize('picodeSetAutoSaveOff', "Off") },
				{ value: 'afterDelay', label: localize('picodeSetAutoSaveDelay', "After delay") },
				{ value: 'onFocusChange', label: localize('picodeSetAutoSaveFocus', "On focus change") },
				{ value: 'onWindowChange', label: localize('picodeSetAutoSaveWindow', "On window change") },
			],
		});
		page.switchRow({ key: 'editor.formatOnSave', name: localize('picodePrefFormatOnSave', "Format on save"), description: localize('picodeSetFormatOnSaveDesc', "Format the file each time it's saved.") });
	},
});

// ---- Chat and agent ---------------------------------------------------------------------

registerPage({
	id: AICustomizationManagementSection.ChatAgent,
	label: localize('picodePrefChat', "Chat and agent"),
	icon: Codicon.robot,
	description: localize('picodeSetChatDesc', "Model behavior and the context pi receives."),
	keywords: ['pi', 'thinking', 'reasoning', 'context', 'project', 'tools', 'voice', 'dictation', 'ai'],
	build: (page, { commandService }) => {
		page.segmentedRow({
			key: 'picode.pi.runtime',
			name: localize('picodeSetRuntime', "pi runtime"),
			description: localize('picodeSetRuntimeDesc', "Use the version bundled with PiCode or the one installed on your system. Applies to new chats."),
			choices: [
				{ value: 'internal', label: localize('picodeSetRuntimeInternal', "Bundled") },
				{ value: 'external', label: localize('picodeSetRuntimeExternal', "System") },
			],
		});
		page.selectRow<string>({
			key: 'picode.pi.thinkingLevel',
			name: localize('picodeSetThinking', "Reasoning effort"),
			description: localize('picodeSetThinkingDesc', "How much the model thinks before answering."),
			keywords: 'reasoning effort',
			choices: [
				{ value: 'default', label: localize('picodeSetThinkingDefault', "Default") },
				{ value: 'off', label: localize('picodePrefThinkingOff', "Off") },
				{ value: 'minimal', label: localize('picodePrefThinkingMinimal', "Minimal") },
				{ value: 'low', label: localize('picodePrefThinkingLow', "Low") },
				{ value: 'medium', label: localize('picodePrefThinkingMedium', "Medium") },
				{ value: 'high', label: localize('picodePrefThinkingHigh', "High") },
				{ value: 'xhigh', label: localize('picodeSetThinkingXhigh', "Extra high") },
				{ value: 'max', label: localize('picodeSetThinkingMax', "Max") },
			],
		});
		page.switchRow({
			key: 'picode.pi.reasoning',
			name: localize('picodeSetReasoning', "Show thinking"),
			description: localize('picodeSetReasoningDesc', "Show the model's reasoning above its answer."),
			read: stored => stored !== 'hide',
			write: on => on ? 'show' : 'hide',
		});

		page.group(localize('picodeSetContext', "Context"));
		page.switchRow({
			key: 'picode.context.attach',
			name: localize('picodeSetAttach', "Include editor context"),
			description: localize('picodeSetAttachDesc', "Send the open folder, file and selection with each message."),
		});
		page.selectRow<string>({
			key: 'picode.context.mode',
			name: localize('picodeSetContextMode', "Context scope"),
			choices: [
				{ value: 'project', label: localize('picodeSetContextProject', "Workspace") },
				{ value: 'file', label: localize('picodeSetContextFile', "Current file") },
				{ value: 'selection', label: localize('picodeSetContextSelection', "Selection only") },
			],
		});
		page.selectRow<string>({
			key: 'picode.pi.projectMode',
			name: localize('picodeSetProjectMode', "Working directory"),
			description: localize('picodeSetProjectModeDesc', "Used when several folders are open."),
			choices: [
				{ value: 'auto', label: localize('picodeSetProjectAuto', "Automatic") },
				{ value: 'workspace', label: localize('picodeSetProjectWorkspace', "All folders") },
				{ value: 'folder', label: localize('picodeSetProjectFolder', "First folder") },
			],
		});

		page.group(localize('picodePrefAgentGroup', "Agents"));
		page.buttonRow(
			{ name: localize('picodePrefProfiles', "Agent profiles"), description: localize('picodePrefProfilesDesc', "Which model each agent uses."), keywords: 'gentle profile models' },
			localize('picodePrefManage', "Manage"),
			() => commandService.executeCommand('aiCustomization.openManagementEditor', AICustomizationManagementSection.ProvidersModels),
		);
		page.buttonRow(
			{ name: localize('picodePrefTools', "Tools"), description: localize('picodeSetToolsDesc', "Choose which tools pi can use."), keywords: 'bash edit write' },
			localize('picodePrefManage', "Manage"),
			() => commandService.executeCommand('aiCustomization.openManagementEditor', AICustomizationManagementSection.Tools),
		);

		page.group(localize('picodePrefVoice', "Voice"));
		const voiceRow = page.row({ name: localize('picodePrefDictation', "Dictation"), description: localize('picodePrefDictationChecking', "Checking…"), keywords: 'microphone speech' });
		const desc = voiceRow.parentElement?.querySelector<HTMLElement>('.picode-set-row-desc');
		void commandService.executeCommand<IAgentStatus>(STATUS_DATA_COMMAND).then(status => {
			const voice = status?.voice;
			if (!desc) {
				return;
			}
			if (!voice || voice.state === 'unsupported') {
				desc.textContent = localize('picodePrefDictationUnsupported', "Not available on this computer.");
			} else if (voice.state === 'ready') {
				desc.textContent = localize('picodeSetDictationReady', "Ready. Use the microphone button in the chat.");
				page.button(voiceRow, localize('picodePrefRemove', "Remove"), () => commandService.executeCommand('picode.voice.remove'));
			} else if (voice.state === 'downloading') {
				desc.textContent = localize('picodePrefDictationDownloading', "Downloading, {0}%.", Math.round(voice.percent ?? 0));
				page.button(voiceRow, localize('picodePrefCancel', "Cancel"), () => commandService.executeCommand('picode.voice.cancel'));
			} else {
				desc.textContent = localize('picodeSetDictationMissing', "Speak instead of typing. Runs on this computer (about {0} MB).", voice.sizeMb ?? 700);
				page.button(voiceRow, localize('picodePrefDownload', "Download"), () => commandService.executeCommand('picode.voice.download'), { icon: Codicon.cloudDownload });
			}
		}, () => { /* the agent is not running yet: the line keeps saying it is checking */ });

		page.group(localize('picodeSetAdvanced', "Advanced"));
		page.switchRow({
			key: 'chat.disableAIFeatures',
			name: localize('picodeSetAiOn', "AI features"),
			description: localize('picodeSetAiOnDesc', "Turn off to hide the chat and agent everywhere."),
			keywords: 'disable ai',
			danger: true,
			read: stored => stored !== true,
			write: on => !on,
		});
	},
});

// ---- Terminal ---------------------------------------------------------------------------

registerPage({
	id: AICustomizationManagementSection.Terminal,
	label: localize('picodePrefTerminal', "Terminal"),
	icon: Codicon.terminal,
	description: localize('picodeSetTerminalDesc', "Shell, font and cursor."),
	keywords: ['shell', 'powershell', 'bash', 'cursor', 'font'],
	build: (page, { commandService }) => {
		page.buttonRow(
			{ name: localize('picodeSetShell', "Default profile"), description: localize('picodeSetShellDesc', "Shell used for new terminals."), keywords: 'shell profile' },
			localize('picodePrefChoose', "Choose"),
			() => commandService.executeCommand('workbench.action.terminal.selectDefaultShell'),
		);
		page.numberRow({ key: 'terminal.integrated.fontSize', name: localize('picodePrefTerminalFont', "Font size"), min: 6, max: 40 });
		page.segmentedRow({
			key: 'terminal.integrated.cursorStyle',
			name: localize('picodeSetCursor', "Cursor style"),
			choices: [
				{ value: 'block', label: localize('picodePrefCursorBlock', "Block") },
				{ value: 'line', label: localize('picodePrefCursorLine', "Line") },
				{ value: 'underline', label: localize('picodePrefCursorUnderline', "Underline") },
			],
		});
		page.switchRow({ key: 'terminal.integrated.cursorBlinking', name: localize('picodeSetCursorBlink', "Cursor blinking") });
	},
});

// ---- Memory -----------------------------------------------------------------------------

registerPage({
	id: AICustomizationManagementSection.Memory,
	label: localize('picodePrefMemory', "Memory"),
	icon: Codicon.database,
	description: localize('picodeSetMemoryDesc', "What pi remembers across chats."),
	keywords: ['engram', 'remember'],
	build: (page, { commandService }) => {
		page.switchRow({
			key: 'picode.memory.enabled',
			name: localize('picodeSetMemoryOn', "Enable memory"),
			description: localize('picodeSetMemoryOnDesc', "Let pi save decisions and learnings and recall them in later chats."),
		});
		page.buttonRow(
			{ name: localize('picodePrefMemoryCheck', "Check memory"), description: localize('picodeSetMemoryCheckDesc', "Find and fix problems in stored memories.") },
			localize('picodePrefCheck', "Check"),
			() => commandService.executeCommand('picode.memory.check'),
		);
	},
});

// ---- Updates ----------------------------------------------------------------------------

registerPage({
	id: AICustomizationManagementSection.Updates,
	label: localize('picodePrefUpdates', "Updates"),
	icon: Codicon.cloudDownload,
	description: localize('picodeSetUpdatesDesc', "Versions of PiCode and the agent."),
	keywords: ['version', 'update', 'pi', 'packages', 'gentle', 'engram', 'extensions', "what's new"],
	build: (page, { commandService, productService }) => {
		page.buttonRow(
			{ name: `PiCode ${productService.picodeVersion ?? productService.version}`, description: localize('picodeSetUpdatesChannel', "Check for a newer version of PiCode."), icon: Codicon.versions },
			localize('picodePrefCheckNow', "Check now"),
			() => commandService.executeCommand('update.checkForUpdate'),
		);

		const agentRow = page.row({ name: localize('picodeSetAgentParts', "Agent components"), description: localize('picodePrefDictationChecking', "Checking…"), keywords: 'pi packages gentle engram memory engine', icon: Codicon.package });
		const agentDesc = agentRow.parentElement?.querySelector<HTMLElement>('.picode-set-row-desc');
		const paintAgent = (status: IAgentStatus | undefined) => {
			DOM.clearNode(agentRow);
			const targets = status?.updates?.targets ?? [];
			if (agentDesc) {
				agentDesc.textContent = targets.length === 0
					? localize('picodeSetAgentCurrent', "pi {0}, packages and memory are up to date.", status?.piVersion ?? '')
					: targets.map(t => `${t.name} ${t.installed} → ${t.latest}`).join(' · ');
			}
			if (targets.length > 0) {
				page.button(agentRow, localize('picodePrefUpdateAll', "Update all ({0})", targets.length), () => commandService.executeCommand('picode.updates.apply'), { primary: true });
			}
			page.button(agentRow, localize('picodePrefCheckNow', "Check now"), async () => {
				await commandService.executeCommand('picode.updates.check');
				paintAgent(await commandService.executeCommand<IAgentStatus>(STATUS_DATA_COMMAND));
			});
		};
		void commandService.executeCommand<IAgentStatus>(STATUS_DATA_COMMAND).then(paintAgent, () => paintAgent(undefined));

		page.group(localize('picodeSetUpdatesWhen', "Automatic updates"));
		page.segmentedRow({
			key: 'update.mode',
			name: localize('picodeSetUpdateMode', "Update mode"),
			choices: [
				{ value: 'default', label: localize('picodePrefUpdateAuto', "Automatic") },
				{ value: 'start', label: localize('picodeSetUpdateStart', "On startup") },
				{ value: 'manual', label: localize('picodeSetUpdateManual', "Manual") },
				{ value: 'none', label: localize('picodePrefUpdateNone', "Off") },
			],
		});
		page.switchRow({ key: 'picode.updates.check', name: localize('picodeSetAgentUpdates', "Check for agent updates"), description: localize('picodeSetAgentUpdatesDesc', "pi, its packages and memory, in the background.") });
		page.switchRow({ key: 'extensions.autoCheckUpdates', name: localize('picodeSetExtensionUpdates', "Check for extension updates") });
		page.buttonRow(
			{ name: localize('picodePrefWhatsNew', "What's new"), description: localize('picodeSetWhatsNewDesc', "See what's new in this version.") },
			localize('picodePrefOpen', "Open"),
			() => commandService.executeCommand('picode.showWhatsNew'),
		);
	},
});

// ---- Accessibility ----------------------------------------------------------------------

registerPage({
	id: AICustomizationManagementSection.Accessibility,
	label: localize('picodePrefAccessibility', "Accessibility"),
	icon: Codicon.eye,
	description: localize('picodePrefAccessibilityDesc', "Motion, contrast and screen readers."),
	keywords: ['motion', 'animation', 'contrast', 'screen reader'],
	build: page => {
		page.segmentedRow({
			key: 'workbench.reduceMotion',
			name: localize('picodeSetMotion', "Reduce motion"),
			description: localize('picodeSetMotionDesc', "Turn off animations, or follow your system."),
			keywords: 'animation',
			choices: [
				{ value: 'auto', label: localize('picodePrefSystem', "System") },
				{ value: 'off', label: localize('picodeSetMotionOff', "Off") },
				{ value: 'on', label: localize('picodeSetMotionOn', "On") },
			],
		});
		page.switchRow({ key: 'window.autoDetectHighContrast', name: localize('picodeSetContrast', "Auto-detect high contrast"), description: localize('picodeSetContrastDesc', "Use a high-contrast theme when your system does.") });
		page.segmentedRow({
			key: 'editor.accessibilitySupport',
			name: localize('picodePrefScreenReader', "Screen reader support"),
			choices: [
				{ value: 'auto', label: localize('picodePrefSystem', "System") },
				{ value: 'on', label: localize('picodePrefOn', "On") },
				{ value: 'off', label: localize('picodePrefOff', "Off") },
			],
		});
	},
});

// ---- Keyboard ---------------------------------------------------------------------------

registerPage({
	id: AICustomizationManagementSection.Keyboard,
	label: localize('picodePrefKeyboard', "Keyboard"),
	icon: Codicon.keyboard,
	description: localize('picodePrefKeyboardDesc', "Shortcuts for every command."),
	keywords: ['shortcut', 'keybinding', 'keys'],
	build: (page, { commandService }) => {
		page.buttonRow(
			{ name: localize('picodePrefShortcuts', "Keyboard shortcuts"), description: localize('picodeSetShortcutsDesc', "View and change keybindings.") },
			localize('picodePrefOpen', "Open"),
			() => commandService.executeCommand('workbench.action.openGlobalKeybindings'),
		);
	},
});
