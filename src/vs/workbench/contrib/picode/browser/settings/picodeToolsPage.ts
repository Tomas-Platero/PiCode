/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { aiCustomizationManagementSectionRegistry } from '../../../chat/browser/aiCustomization/aiCustomizationManagementSectionRegistry.js';
import { AICustomizationManagementSection } from '../../../chat/common/aiCustomizationWorkspaceService.js';
import { toolEnabled, toolsAfterToggle } from './picodeSettingsData.js';
import { PicodeSettingsPage } from './picodeSettingsRows.js';

/** The setting that keeps tools off (declared in `picodeConfiguration.ts`, which loads this page). */
const PICODE_DISABLED_TOOLS_SETTING = 'picode.pi.disabledTools';

/** pi's own tools, by the names `picode.pi.disabledTools` takes. */
const PI_TOOLS = [
	{ name: 'read', icon: Codicon.eye, label: () => localize('picodeToolRead', "Read files"), description: () => localize('picodeToolReadDesc', "Open and read any file in the project.") },
	{ name: 'grep', icon: Codicon.search, label: () => localize('picodeToolGrep', "Search"), description: () => localize('picodeToolGrepDesc', "Look for text across the project.") },
	{ name: 'edit', icon: Codicon.edit, label: () => localize('picodeToolEdit', "Edit files"), description: () => localize('picodeToolEditDesc', "Change parts of a file.") },
	{ name: 'write', icon: Codicon.newFile, label: () => localize('picodeToolWrite', "Write files"), description: () => localize('picodeToolWriteDesc', "Create files or replace them whole.") },
	{ name: 'bash', icon: Codicon.terminal, label: () => localize('picodeToolBash', "Run commands"), description: () => localize('picodeToolBashDesc', "Run commands in a terminal: builds, tests, git.") },
	{ name: 'background', icon: Codicon.tasklist, label: () => localize('picodeToolBackground', "Background jobs"), description: () => localize('picodeToolBackgroundDesc', "Start long commands and keep working while they run.") },
] as const;

aiCustomizationManagementSectionRegistry.register({
	id: AICustomizationManagementSection.Tools,
	label: localize('picodeToolsLabel', "Tools"),
	icon: Codicon.tools,
	description: localize('picodeToolsDescription', "What pi can do on its own. A change applies to the next message."),
	keywords: PI_TOOLS.map(tool => tool.name),
	supportsHarness: () => true,
	create: (instantiationService, container) => instantiationService.invokeFunction(accessor => {
		const configurationService = accessor.get(IConfigurationService);
		const page = instantiationService.createInstance(PicodeSettingsPage, container, localize('picodeToolsLabel', "Tools"), localize('picodeToolsDescription', "What pi can do on its own. A change applies to the next message."));
		const disabled = () => configurationService.getValue<string[]>(PICODE_DISABLED_TOOLS_SETTING);
		for (const tool of PI_TOOLS) {
			page.customSwitchRow(
				{ name: tool.label(), description: tool.description(), icon: tool.icon, keywords: tool.name },
				() => toolEnabled(disabled(), tool.name),
				async (on, saved) => {
					await configurationService.updateValue(PICODE_DISABLED_TOOLS_SETTING, toolsAfterToggle(disabled(), tool.name, on), ConfigurationTarget.USER);
					page.markSaved(saved);
				},
				[PICODE_DISABLED_TOOLS_SETTING],
			);
		}
		return page;
	}),
});
