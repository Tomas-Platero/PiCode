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
	description: localize('picodePrefGeneralDesc', "How PiCode looks and how it starts."),
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
			{ name: localize('picodePrefTheme', "Theme"), description: localize('picodePrefThemeDesc', "Follow your system, or keep one look."), keywords: 'dark light system' },
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
		page.button(themeRow, localize('picodePrefBrowseThemes', "Browse themes"), () => commandService.executeCommand('workbench.action.selectTheme'), { icon: Codicon.symbolColor });
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
			description: localize('picodePrefZoomDesc', "How big everything is drawn."),
			choices: [-2, -1, 0, 1, 2, 3].map(level => ({ value: level, label: `${Math.round(Math.pow(1.2, level) * 100)}%` })),
			read: stored => typeof stored === 'number' ? Math.round(stored) : 0,
		});

		page.group(localize('picodePrefStartup', "Startup"));
		page.selectRow<string>({
			key: 'window.restoreWindows',
			name: localize('picodePrefRestore', "Reopen windows"),
			description: localize('picodePrefRestoreDesc', "What PiCode opens when it starts again."),
			choices: [
				{ value: 'all', label: localize('picodePrefRestoreAll', "Everything I had open") },
				{ value: 'preserve', label: localize('picodePrefRestorePreserve', "Everything, even if I open a folder") },
				{ value: 'folders', label: localize('picodePrefRestoreFolders', "Only folders") },
				{ value: 'one', label: localize('picodePrefRestoreOne', "The last window") },
				{ value: 'none', label: localize('picodePrefRestoreNone', "Nothing") },
			],
		});
		page.selectRow<string>({
			key: 'workbench.startupEditor',
			name: localize('picodePrefStartupEditor', "On an empty window"),
			description: localize('picodePrefStartupEditorDesc', "What shows when no file is open."),
			choices: [
				{ value: 'welcomePage', label: localize('picodePrefStartupWelcome', "Welcome page") },
				{ value: 'welcomePageInEmptyWorkbench', label: localize('picodePrefStartupWelcomeEmpty', "Welcome page, only without a folder") },
				{ value: 'newUntitledFile', label: localize('picodePrefStartupNewFile', "A new file") },
				{ value: 'none', label: localize('picodePrefStartupNone', "Nothing") },
			],
		});
	},
});

// ---- Editor -----------------------------------------------------------------------------

registerPage({
	id: AICustomizationManagementSection.EditorPreferences,
	label: localize('picodePrefEditor', "Editor"),
	icon: Codicon.code,
	description: localize('picodePrefEditorDesc', "How code looks and saves."),
	keywords: ['font', 'size', 'tab', 'wrap', 'minimap', 'format', 'save', 'line numbers'],
	build: page => {
		page.group(localize('picodePrefText', "Text"));
		page.textRow({ key: 'editor.fontFamily', name: localize('picodePrefFont', "Font"), description: localize('picodePrefFontDesc', "Names separated by commas; the first one installed wins."), keywords: 'font family' });
		page.numberRow({ key: 'editor.fontSize', name: localize('picodePrefFontSize', "Font size"), min: 8, max: 40, keywords: 'font size' });
		page.numberRow({ key: 'editor.tabSize', name: localize('picodePrefTabSize', "Tab width"), description: localize('picodePrefTabSizeDesc', "Spaces a tab takes."), min: 1, max: 16, keywords: 'indent' });
		page.selectRow<string>({
			key: 'editor.wordWrap',
			name: localize('picodePrefWrap', "Wrap long lines"),
			choices: [
				{ value: 'off', label: localize('picodePrefWrapOff', "Never") },
				{ value: 'on', label: localize('picodePrefWrapOn', "At the window edge") },
				{ value: 'bounded', label: localize('picodePrefWrapBounded', "At the edge or the column limit") },
			],
		});
		page.selectRow<string>({
			key: 'editor.lineNumbers',
			name: localize('picodePrefLineNumbers', "Line numbers"),
			choices: [
				{ value: 'on', label: localize('picodePrefLineNumbersOn', "Shown") },
				{ value: 'relative', label: localize('picodePrefLineNumbersRelative', "Relative to the cursor") },
				{ value: 'off', label: localize('picodePrefLineNumbersOff', "Hidden") },
			],
		});
		page.switchRow({ key: 'editor.minimap.enabled', name: localize('picodePrefMinimap', "Minimap"), description: localize('picodePrefMinimapDesc', "A small overview of the file on the right.") });

		page.group(localize('picodePrefSaving', "Saving"));
		page.selectRow<string>({
			key: 'files.autoSave',
			name: localize('picodePrefAutoSave', "Save automatically"),
			choices: [
				{ value: 'off', label: localize('picodePrefAutoSaveOff', "Never") },
				{ value: 'afterDelay', label: localize('picodePrefAutoSaveDelay', "After a short pause") },
				{ value: 'onFocusChange', label: localize('picodePrefAutoSaveFocus', "When I leave the file") },
				{ value: 'onWindowChange', label: localize('picodePrefAutoSaveWindow', "When I leave PiCode") },
			],
		});
		page.switchRow({ key: 'editor.formatOnSave', name: localize('picodePrefFormatOnSave', "Format on save"), description: localize('picodePrefFormatOnSaveDesc', "Tidy the file every time it is saved.") });
	},
});

// ---- Chat and agent ---------------------------------------------------------------------

registerPage({
	id: AICustomizationManagementSection.ChatAgent,
	label: localize('picodePrefChat', "Chat and agent"),
	icon: Codicon.robot,
	description: localize('picodePrefChatDesc', "How pi answers in the chat."),
	keywords: ['pi', 'thinking', 'reasoning', 'context', 'project', 'tools', 'voice', 'dictation', 'ai'],
	build: (page, { commandService }) => {
		page.segmentedRow({
			key: 'picode.pi.runtime',
			name: localize('picodePrefRuntime', "Which pi answers"),
			description: localize('picodePrefRuntimeDesc', "The one inside PiCode, or the one installed on your computer. Applies to new chats."),
			choices: [
				{ value: 'internal', label: localize('picodePrefRuntimeInternal', "Built in") },
				{ value: 'external', label: localize('picodePrefRuntimeExternal', "On this computer") },
			],
		});
		page.selectRow<string>({
			key: 'picode.pi.thinkingLevel',
			name: localize('picodePrefThinking', "Thinking effort"),
			description: localize('picodePrefThinkingDesc', "How hard pi thinks before answering."),
			keywords: 'reasoning effort',
			choices: [
				{ value: 'default', label: localize('picodePrefThinkingDefault', "pi's own choice") },
				{ value: 'off', label: localize('picodePrefThinkingOff', "Off") },
				{ value: 'minimal', label: localize('picodePrefThinkingMinimal', "Minimal") },
				{ value: 'low', label: localize('picodePrefThinkingLow', "Low") },
				{ value: 'medium', label: localize('picodePrefThinkingMedium', "Medium") },
				{ value: 'high', label: localize('picodePrefThinkingHigh', "High") },
				{ value: 'xhigh', label: localize('picodePrefThinkingXhigh', "Very high") },
				{ value: 'max', label: localize('picodePrefThinkingMax', "Maximum") },
			],
		});
		page.switchRow({
			key: 'picode.pi.reasoning',
			name: localize('picodePrefReasoning', "Show reasoning"),
			description: localize('picodePrefReasoningDesc', "Write the model's thinking into the chat above the answer."),
			read: stored => stored !== 'hide',
			write: on => on ? 'show' : 'hide',
		});

		page.group(localize('picodePrefContext', "What pi is told"));
		page.switchRow({
			key: 'picode.context.attach',
			name: localize('picodePrefAttach', "Send what I'm looking at"),
			description: localize('picodePrefAttachDesc', "The folder, the open file and the selection go with every message."),
		});
		page.selectRow<string>({
			key: 'picode.context.mode',
			name: localize('picodePrefContextMode', "How much"),
			choices: [
				{ value: 'project', label: localize('picodePrefContextProject', "Folder, file and selection") },
				{ value: 'file', label: localize('picodePrefContextFile', "File and selection") },
				{ value: 'selection', label: localize('picodePrefContextSelection', "Only the selection") },
			],
		});
		page.selectRow<string>({
			key: 'picode.pi.projectMode',
			name: localize('picodePrefProjectMode', "Where pi works"),
			description: localize('picodePrefProjectModeDesc', "With several folders open."),
			choices: [
				{ value: 'auto', label: localize('picodePrefProjectAuto', "Decide for me") },
				{ value: 'workspace', label: localize('picodePrefProjectWorkspace', "Across every folder") },
				{ value: 'folder', label: localize('picodePrefProjectFolder', "Only the first folder") },
			],
		});

		page.group(localize('picodePrefAgentGroup', "Agents"));
		page.buttonRow(
			{ name: localize('picodePrefProfiles', "Agent profiles"), description: localize('picodePrefProfilesDesc', "Which model each agent uses."), keywords: 'gentle profile models' },
			localize('picodePrefManage', "Manage"),
			() => commandService.executeCommand('aiCustomization.openManagementEditor', AICustomizationManagementSection.ProvidersModels),
		);
		page.buttonRow(
			{ name: localize('picodePrefTools', "Tools"), description: localize('picodePrefToolsDesc', "Turn off tools pi should not use."), keywords: 'bash edit write' },
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
				desc.textContent = localize('picodePrefDictationReady', "Ready. Speak into the chat with the microphone button.");
				page.button(voiceRow, localize('picodePrefRemove', "Remove"), () => commandService.executeCommand('picode.voice.remove'));
			} else if (voice.state === 'downloading') {
				desc.textContent = localize('picodePrefDictationDownloading', "Downloading, {0}%.", Math.round(voice.percent ?? 0));
				page.button(voiceRow, localize('picodePrefCancel', "Cancel"), () => commandService.executeCommand('picode.voice.cancel'));
			} else {
				desc.textContent = localize('picodePrefDictationMissing', "Talk instead of typing. Works on this computer, about {0} MB.", voice.sizeMb ?? 700);
				page.button(voiceRow, localize('picodePrefDownload', "Download"), () => commandService.executeCommand('picode.voice.download'), { icon: Codicon.cloudDownload });
			}
		}, () => { /* the agent is not running yet: the line keeps saying it is checking */ });

		page.group(localize('picodePrefDanger', "Turn off"));
		page.switchRow({
			key: 'chat.disableAIFeatures',
			name: localize('picodePrefAiOn', "AI in PiCode"),
			description: localize('picodePrefAiOnDesc', "Turning it off hides the chat and the agent everywhere."),
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
	description: localize('picodePrefTerminalDesc', "The terminal inside PiCode."),
	keywords: ['shell', 'powershell', 'bash', 'cursor', 'font'],
	build: (page, { commandService }) => {
		page.buttonRow(
			{ name: localize('picodePrefShell', "Default terminal"), description: localize('picodePrefShellDesc', "Which shell a new terminal opens."), keywords: 'shell profile' },
			localize('picodePrefChoose', "Choose"),
			() => commandService.executeCommand('workbench.action.terminal.selectDefaultShell'),
		);
		page.numberRow({ key: 'terminal.integrated.fontSize', name: localize('picodePrefTerminalFont', "Font size"), min: 6, max: 40 });
		page.segmentedRow({
			key: 'terminal.integrated.cursorStyle',
			name: localize('picodePrefCursor', "Cursor"),
			choices: [
				{ value: 'block', label: localize('picodePrefCursorBlock', "Block") },
				{ value: 'line', label: localize('picodePrefCursorLine', "Line") },
				{ value: 'underline', label: localize('picodePrefCursorUnderline', "Underline") },
			],
		});
		page.switchRow({ key: 'terminal.integrated.cursorBlinking', name: localize('picodePrefCursorBlink', "Blinking cursor") });
	},
});

// ---- Memory -----------------------------------------------------------------------------

registerPage({
	id: AICustomizationManagementSection.Memory,
	label: localize('picodePrefMemory', "Memory"),
	icon: Codicon.database,
	description: localize('picodePrefMemoryDesc', "What pi remembers between chats."),
	keywords: ['engram', 'remember'],
	build: (page, { commandService }) => {
		page.switchRow({
			key: 'picode.memory.enabled',
			name: localize('picodePrefMemoryOn', "Memory"),
			description: localize('picodePrefMemoryOnDesc', "pi keeps decisions and what it learned, and finds them in later chats."),
		});
		page.buttonRow(
			{ name: localize('picodePrefMemoryCheck', "Check memory"), description: localize('picodePrefMemoryCheckDesc', "Look for problems in what is stored and fix them.") },
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
	description: localize('picodePrefUpdatesDesc', "New versions of PiCode and of the agent."),
	keywords: ['version', 'update', 'pi', 'packages', 'gentle', 'engram', 'extensions', "what's new"],
	build: (page, { commandService, productService }) => {
		page.buttonRow(
			{ name: `PiCode ${productService.picodeVersion ?? productService.version}`, description: localize('picodePrefUpdatesChannel', "Checks for a newer PiCode."), icon: Codicon.versions },
			localize('picodePrefCheckNow', "Check now"),
			() => commandService.executeCommand('update.checkForUpdate'),
		);

		const agentRow = page.row({ name: localize('picodePrefAgentParts', "Agent"), description: localize('picodePrefDictationChecking', "Checking…"), keywords: 'pi packages gentle engram memory engine', icon: Codicon.package });
		const agentDesc = agentRow.parentElement?.querySelector<HTMLElement>('.picode-set-row-desc');
		const paintAgent = (status: IAgentStatus | undefined) => {
			DOM.clearNode(agentRow);
			const targets = status?.updates?.targets ?? [];
			if (agentDesc) {
				agentDesc.textContent = targets.length === 0
					? localize('picodePrefAgentCurrent', "pi {0}, its packages and memory are up to date.", status?.piVersion ?? '')
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

		page.group(localize('picodePrefUpdatesWhen', "When"));
		page.segmentedRow({
			key: 'update.mode',
			name: localize('picodePrefUpdateMode', "PiCode updates"),
			choices: [
				{ value: 'default', label: localize('picodePrefUpdateAuto', "Automatic") },
				{ value: 'start', label: localize('picodePrefUpdateStart', "At startup") },
				{ value: 'manual', label: localize('picodePrefUpdateManual', "When I ask") },
				{ value: 'none', label: localize('picodePrefUpdateNone', "Off") },
			],
		});
		page.switchRow({ key: 'picode.updates.check', name: localize('picodePrefAgentUpdates', "Look for agent updates"), description: localize('picodePrefAgentUpdatesDesc', "pi, its packages and memory, in the background.") });
		page.switchRow({ key: 'extensions.autoCheckUpdates', name: localize('picodePrefExtensionUpdates', "Look for extension updates") });
		page.buttonRow(
			{ name: localize('picodePrefWhatsNew', "What's new"), description: localize('picodePrefWhatsNewDesc', "What this version brings.") },
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
			name: localize('picodePrefMotion', "Motion"),
			description: localize('picodePrefMotionDesc', "Turn animations off, or follow your system."),
			keywords: 'animation',
			choices: [
				{ value: 'auto', label: localize('picodePrefSystem', "System") },
				{ value: 'off', label: localize('picodePrefMotionOn', "On") },
				{ value: 'on', label: localize('picodePrefMotionReduced', "Reduced") },
			],
		});
		page.switchRow({ key: 'window.autoDetectHighContrast', name: localize('picodePrefContrast', "High contrast with the system"), description: localize('picodePrefContrastDesc', "Switch to a high-contrast theme when your system does.") });
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
			{ name: localize('picodePrefShortcuts', "Keyboard shortcuts"), description: localize('picodePrefShortcutsDesc', "See and change the keys for any command.") },
			localize('picodePrefOpen', "Open"),
			() => commandService.executeCommand('workbench.action.openGlobalKeybindings'),
		);
	},
});
