/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { language } from '../../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
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

/** The memory check as the connector sums it up (`memory-client.ts`, `memoryDoctorSummary`). */
interface IMemoryCheckSummary {
	readonly healthy: boolean;
	readonly headline: string;
	readonly passed: number;
	readonly issues: readonly { readonly severity: string; readonly title: string; readonly detail: string }[];
}

function paintMemoryCheck(target: HTMLElement, summary: IMemoryCheckSummary | undefined): void {
	DOM.clearNode(target);
	if (!summary) {
		target.className = 'picode-set-memory-result warn';
		DOM.append(target, DOM.$('.picode-set-memory-head')).append(
			renderIcon(Codicon.warning),
			DOM.$('span', undefined, localize('picodeSetMemoryNoAnswer', "The memory isn't answering right now. Try again in a moment.")),
		);
		return;
	}
	target.className = `picode-set-memory-result ${summary.healthy ? 'ok' : 'warn'}`;
	const head = DOM.append(target, DOM.$('.picode-set-memory-head'));
	head.appendChild(renderIcon(summary.healthy ? Codicon.passFilled : Codicon.warning));
	const text = DOM.append(head, DOM.$('.picode-set-memory-text'));
	DOM.append(text, DOM.$('strong')).textContent = summary.headline;
	DOM.append(text, DOM.$('span')).textContent = summary.passed === 1
		? localize('picodeSetMemoryPassedOne', "1 check passed.")
		: localize('picodeSetMemoryPassed', "{0} checks passed.", summary.passed);
	for (const issue of summary.issues) {
		const item = DOM.append(target, DOM.$('.picode-set-memory-issue'));
		item.appendChild(renderIcon(issue.severity === 'error' ? Codicon.error : Codicon.warning));
		const body = DOM.append(item, DOM.$('.picode-set-memory-text'));
		DOM.append(body, DOM.$('strong')).textContent = issue.title;
		if (issue.detail) {
			DOM.append(body, DOM.$('span')).textContent = issue.detail;
		}
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
		const runtime = page.segmentedRow({
			key: 'picode.pi.runtime',
			name: localize('picodeSetRuntime', "pi runtime"),
			description: localize('picodeSetRuntimeDesc', "Use the version bundled with PiCode or the one installed on your system. Applies to new chats."),
			choices: [
				{ value: 'internal', label: localize('picodeSetRuntimeInternal', "Bundled") },
				{ value: 'external', label: localize('picodeSetRuntimeExternal', "System") },
			],
		});
		// System only makes sense when this computer has its own pi: without one the option is locked.
		void commandService.executeCommand<{ readonly found: boolean }>('picode.setup.probeExternal').then(probe => {
			if (probe && !probe.found) {
				page.lockChoice(runtime, 'external', localize('picodeSetRuntimeNoSystem', "There's no pi installed on this computer yet. Install it to use your own."));
			}
		}, () => { /* the connector is not running (AI off): nothing to say */ });
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
		// The check runs here and its answer appears right below, instead of in a document of its own.
		let result: HTMLElement | undefined;
		const checkButton = page.buttonRow(
			{ name: localize('picodePrefMemoryCheck', "Check memory"), description: localize('picodeSetMemoryCheckDesc', "Find and fix problems in stored memories.") },
			localize('picodePrefCheck', "Check"),
			async () => {
				const row = checkButton.closest('.picode-set-row');
				if (!row) {
					return;
				}
				result ??= DOM.$('.picode-set-memory-result');
				row.insertAdjacentElement('afterend', result);
				DOM.clearNode(result);
				result.className = 'picode-set-memory-result checking';
				DOM.append(result, DOM.$('span')).appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
				DOM.append(result, DOM.$('span')).textContent = localize('picodeSetMemoryChecking', "Taking a look at your memories…");
				checkButton.disabled = true;
				let summary: IMemoryCheckSummary | undefined;
				try {
					summary = await commandService.executeCommand<IMemoryCheckSummary>('picode.memory.checkSummary');
				} catch {
					summary = undefined;
				}
				checkButton.disabled = false;
				paintMemoryCheck(result, summary);
			},
			{ icon: Codicon.pulse },
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
	build: (page, { commandService, productService, configurationService }) => {
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
			description: localize('picodeSetUpdateModeDesc', "Automatic keeps everything up to date for you: PiCode, pi, its packages and your extensions."),
			choices: [
				{ value: 'default', label: localize('picodePrefUpdateAuto', "Automatic") },
				{ value: 'start', label: localize('picodeSetUpdateStart', "On startup") },
				{ value: 'manual', label: localize('picodeSetUpdateManual', "Manual") },
				{ value: 'none', label: localize('picodePrefUpdateNone', "Off") },
			],
		});
		page.switchRow({ key: 'picode.updates.check', name: localize('picodeSetAgentUpdates', "Check for agent updates"), description: localize('picodeSetAgentUpdatesDesc', "pi, its packages and memory, in the background.") });
		page.switchRow({
			key: 'extensions.autoUpdate',
			name: localize('picodeSetExtensionAutoUpdate', "Update extensions automatically"),
			description: localize('picodeSetExtensionAutoUpdateDesc', "New versions install quietly in the background."),
			read: stored => stored !== false,
			write: on => on,
		});
		// Automatic means everything: choosing it turns extension updates on too, and the other modes off.
		page.onSettingChange('update.mode', () => {
			const automatic = configurationService.getValue<string>('update.mode') === 'default';
			if ((configurationService.getValue('extensions.autoUpdate') !== false) !== automatic) {
				void configurationService.updateValue('extensions.autoUpdate', automatic, ConfigurationTarget.USER);
			}
		});
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

		page.group(localize('picodeSetA11yReading', "Reading"));
		page.switchRow({ key: 'accessibility.underlineLinks', name: localize('picodeSetUnderlineLinks', "Underline links"), description: localize('picodeSetUnderlineLinksDesc', "Makes links easy to spot without relying on colour.") });
		page.switchRow({
			key: 'editor.renderLineHighlight',
			name: localize('picodeSetLineHighlight', "Highlight the current line"),
			description: localize('picodeSetLineHighlightDesc', "Helps you keep track of where you are in the file."),
			read: stored => stored !== 'none',
			write: on => on ? 'all' : 'none',
		});
		// 0 is the editor's own width (2 px): show it as Normal rather than as a bare zero.
		page.selectRow<number>({
			key: 'editor.cursorWidth',
			name: localize('picodeSetCursorWidth', "Cursor width"),
			description: localize('picodeSetCursorWidthDesc', "A wider cursor is easier to see."),
			choices: [
				{ value: 0, label: localize('picodeSetCursorNormal', "Normal") },
				{ value: 3, label: localize('picodeSetCursorThick', "Thick") },
				{ value: 5, label: localize('picodeSetCursorThickest', "Extra thick") },
			],
		});
		page.switchRow({ key: 'accessibility.dimUnfocused.enabled', name: localize('picodeSetDimUnfocused', "Dim the panels you're not using"), description: localize('picodeSetDimUnfocusedDesc', "Keeps your attention on the one you're working in.") });

		page.group(localize('picodeSetA11yPointer', "Mouse and movement"));
		page.switchRow({ key: 'editor.mouseWheelZoom', name: localize('picodeSetWheelZoom', "Zoom with Ctrl and the mouse wheel"), description: localize('picodeSetWheelZoomDesc', "Make the text bigger or smaller as you scroll.") });
		page.switchRow({ key: 'editor.smoothScrolling', name: localize('picodeSetSmoothScroll', "Smooth scrolling"), description: localize('picodeSetSmoothScrollDesc', "Glide instead of jumping when you scroll the editor.") });
		page.selectRow<number>({
			key: 'workbench.hover.delay',
			name: localize('picodeSetHoverDelay', "Show tips after"),
			description: localize('picodeSetHoverDelayDesc', "How long to wait before a tip appears under the pointer."),
			choices: [300, 500, 1000, 1500, 2000].map(ms => ({ value: ms, label: localize('picodeSetMilliseconds', "{0} s", (ms / 1000).toLocaleString()) })),
		});
		page.numberRow({ key: 'workbench.tree.indent', name: localize('picodeSetTreeIndent', "List indentation"), description: localize('picodeSetTreeIndentDesc', "More space makes nested files easier to follow."), min: 4, max: 40 });
	},
});

/** Arrow keys read better as arrows. */
const KEY_SYMBOLS: Record<string, string> = { UpArrow: '↑', DownArrow: '↓', LeftArrow: '←', RightArrow: '→' };

interface IShortcut {
	readonly title: string;
	readonly category: string | undefined;
	readonly keys: string;
}

/** Every command with a name and a shortcut, once each, sorted by name. Internal commands have no name and stay out. */
function listShortcuts(keybindingService: IKeybindingService): IShortcut[] {
	const seen = new Set<string>();
	const result: IShortcut[] = [];
	for (const item of keybindingService.getKeybindings()) {
		const command = item.command;
		const keys = item.resolvedKeybinding?.getLabel();
		if (!command || command.startsWith('-') || !keys || seen.has(command)) {
			continue;
		}
		const action = MenuRegistry.getCommand(command);
		const title = action ? (typeof action.title === 'string' ? action.title : action.title.value) : undefined;
		if (!title) {
			continue;
		}
		seen.add(command);
		const category = action?.category ? (typeof action.category === 'string' ? action.category : action.category.value) : undefined;
		result.push({ title, category, keys });
	}
	// Sorted by what the row shows first: the category, then the name.
	return result.sort((a, b) => `${a.category ?? ''} ${a.title}`.localeCompare(`${b.category ?? ''} ${b.title}`));
}

// ---- Gentle AI --------------------------------------------------------------------------

/** Gentle's own preferences as the connector reads them from the profile (`gentle-settings.ts`). */
interface IGentleSettings {
	readonly persona: 'gentleman' | 'neutral';
	readonly permissions: 'normal' | 'auto' | 'yolo';
	readonly permissionsBroken: boolean;
	readonly background: boolean;
}

registerPage({
	id: AICustomizationManagementSection.Gentle,
	label: localize('picodeGentlePage', "Gentle AI"),
	icon: Codicon.sparkle,
	description: localize('picodeGentlePageDesc', "How your agents talk to you, what they may do on their own, and the work they can leave running."),
	keywords: ['gentle', 'persona', 'gentleman', 'neutral', 'permissions', 'yolo', 'background', 'jobs', 'subagents'],
	build: (page, { commandService }) => {
		let state: IGentleSettings = { persona: 'gentleman', permissions: 'normal', permissionsBroken: false, background: false };
		const repaint: Array<() => void> = [];
		// Each change is written by the connector into PiCode's own profile, where Gentle reads it.
		const save = async (key: 'persona' | 'permissions' | 'background', value: string, saved: HTMLElement) => {
			try {
				state = await commandService.executeCommand<IGentleSettings>('picode.gentle.setSetting', { key, value }) ?? state;
				page.markSaved(saved);
			} catch {
				// Not saved: the control goes back to what is really stored.
			}
			repaint.forEach(paint => paint());
		};
		repaint.push(page.customSegmentedRow<IGentleSettings['persona']>(
			{ name: localize('picodeGentlePersona', "How it talks"), description: localize('picodeGentlePersonaDesc', "Gentleman is direct and explains the why behind each step. Neutral keeps it plain and professional."), keywords: 'persona gentleman neutral voice tone' },
			[
				{ value: 'gentleman', label: localize('picodeGentlePersonaGentleman', "Gentleman") },
				{ value: 'neutral', label: localize('picodeGentlePersonaNeutral', "Neutral") },
			],
			() => state.persona,
			(value, saved) => void save('persona', value, saved),
			[],
		));
		repaint.push(page.customSegmentedRow<IGentleSettings['permissions']>(
			{ name: localize('picodeGentlePermissions', "Permissions for new chats"), description: localize('picodeGentlePermissionsDesc', "Normal asks before acting. Auto lets a second model decide, which costs a little extra. YOLO handles everyday steps on its own and still asks before anything destructive."), keywords: 'permissions mode normal auto yolo ask' },
			[
				{ value: 'normal', label: localize('picodeGentlePermNormal', "Normal") },
				{ value: 'auto', label: localize('picodeGentlePermAuto', "Auto") },
				{ value: 'yolo', label: localize('picodeGentlePermYolo', "YOLO") },
			],
			() => state.permissions,
			(value, saved) => void save('permissions', value, saved),
			[],
		));
		// The control just built, so a broken permissions file can lock its options.
		const permissionsRow = [...page.element.querySelectorAll<HTMLElement>('.picode-set-segmented')].pop() ?? page.element;
		repaint.push(page.customSwitchRow(
			{ name: localize('picodeGentleBackground', "Background work"), description: localize('picodeGentleBackgroundDesc', "Let your agents keep long jobs running while you keep chatting. You'll find them in Tasks."), keywords: 'background jobs subagents tasks' },
			() => state.background,
			(on, saved) => void save('background', on ? 'on' : 'off', saved),
			[],
		));
		void commandService.executeCommand<IGentleSettings>('picode.gentle.settings').then(read => {
			if (read) {
				state = read;
				repaint.forEach(paint => paint());
				if (read.permissionsBroken) {
					// The saved permissions could not be read: replacing them is a person's call, not ours.
					for (const value of ['normal', 'auto', 'yolo']) {
						page.lockChoice(permissionsRow, value, localize('picodeGentlePermissionsBroken', "Your saved permissions couldn't be read. Delete the file and try again."));
					}
				}
			}
		}, () => { /* the connector is not running (AI off): the defaults stay on show */ });
	},
});

// ---- Keyboard ---------------------------------------------------------------------------

registerPage({
	id: AICustomizationManagementSection.Keyboard,
	label: localize('picodePrefKeyboard', "Keyboard"),
	icon: Codicon.keyboard,
	description: localize('picodePrefKeyboardDesc', "Shortcuts for every command."),
	keywords: ['shortcut', 'keybinding', 'keys'],
	build: (page, { commandService, instantiationService }) => {
		page.buttonRow(
			{ name: localize('picodeSetShortcutsChange', "Change a shortcut"), description: localize('picodeSetShortcutsChangeDesc', "Pick any command and give it the keys you like.") },
			localize('picodeSetShortcutsEdit', "Edit shortcuts"),
			() => commandService.executeCommand('workbench.action.openGlobalKeybindings'),
		);

		page.group(localize('picodeSetShortcutsList', "Your shortcuts"));
		const shortcuts = instantiationService.invokeFunction(accessor => listShortcuts(accessor.get(IKeybindingService)));
		const box = page.block('picode-set-keys');
		const search = DOM.append(box, DOM.$<HTMLInputElement>('input.picode-set-input.picode-set-keys-search'));
		search.type = 'search';
		search.placeholder = localize('picodeSetShortcutsSearch', "Search by command or keys");
		search.setAttribute('aria-label', search.placeholder);
		const list = DOM.append(box, DOM.$('.picode-set-keys-list'));
		const paint = () => {
			DOM.clearNode(list);
			const query = search.value.trim().toLowerCase();
			const shown = query ? shortcuts.filter(s => s.title.toLowerCase().includes(query) || s.keys.toLowerCase().includes(query)) : shortcuts;
			if (!shown.length) {
				DOM.append(list, DOM.$('.picode-set-keys-empty')).textContent = localize('picodeSetShortcutsNone', "No shortcut matches that. Try another word.");
				return;
			}
			for (const shortcut of shown) {
				const item = DOM.append(list, DOM.$('.picode-set-keys-item'));
				const name = DOM.append(item, DOM.$('.picode-set-keys-name'));
				if (shortcut.category) {
					DOM.append(name, DOM.$('span.picode-set-keys-category')).textContent = shortcut.category;
				}
				DOM.append(name, DOM.$('span')).textContent = shortcut.title;
				const keys = DOM.append(item, DOM.$('.picode-set-keys-chord'));
				shortcut.keys.split(' ').forEach((chord, i) => {
					if (i > 0) {
						DOM.append(keys, DOM.$('span.picode-set-keys-then')).textContent = localize('picodeSetShortcutsThen', "then");
					}
					for (const key of chord.split('+').filter(Boolean)) {
						DOM.append(keys, DOM.$('kbd')).textContent = KEY_SYMBOLS[key] ?? key;
					}
				});
			}
		};
		search.addEventListener('input', paint);
		paint();
	},
});
