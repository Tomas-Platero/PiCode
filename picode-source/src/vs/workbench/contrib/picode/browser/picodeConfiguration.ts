/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

// The account contribution has no entry of its own in a workbench .main.ts: it is loaded
// from here, because this module is the one picode file the core already imports at
// startup (from the chat and preferences contributions). Keeping the registration inside
// the contrib folder is deliberate — the provider is core code, not an extension.
import './picodeAccount.js';
import './picodeMcpSection.js';

/**
 * PiCode's settings, declared by the core and not by PiCode's own extension.
 *
 * That is not a stylistic choice. The Settings tree is built by matching `tocData`
 * (`settingsLayout.ts`) against **core** configuration groups only
 * (`settingsEditor2.ts`), while an extension's settings are always filed under
 * `Extensions > <extension name>` by `createTocTreeForExtensionSettings` and never see
 * `tocData` at all. So a setting that has to appear inside a core node — like the Chat node
 * `patches/picode/04-pi-settings-under-chat.patch` extends — has to be declared here.
 *
 * The keys are what decide where each row appears, because the tree matches nodes by key
 * pattern: `picode.providers` is its own node under Chat (`Settings > Chat > Providers`, the
 * owner's request) and `picode.pi.*` is the `pi` node beside it, with `picode.context.*` landing
 * there too through its own glob later if it needs one.
 */
export const PICODE_PROVIDERS_SETTING = 'picode.providers';

/** How hard pi thinks, as the setting offers it. `default` leaves pi's own setting alone. */
export const PICODE_THINKING_LEVEL_SETTING = 'picode.pi.thinkingLevel';

/** Whether the model's thinking is written into the chat. */
export const PICODE_REASONING_SETTING = 'picode.pi.reasoning';

/** Whether pi gets the tools of the editor's MCP servers. */
export const PICODE_MCP_ENABLED_SETTING = 'picode.mcp.enabled';

/** The MCP servers pi runs, written into its own profile for the adapter to read. */
export const PICODE_MCP_SERVERS_SETTING = 'picode.mcp.servers';

/** Whether the editor's context travels with every prompt. */
export const PICODE_CONTEXT_ATTACH_SETTING = 'picode.context.attach';

/** Which pi runs as the editor's agent: PiCode's own, or the machine's. */
export const PICODE_PI_RUNTIME_SETTING = 'picode.pi.runtime';

/** Whether pi works on the whole workspace area or on the first folder alone. */
export const PICODE_PROJECT_MODE_SETTING = 'picode.pi.projectMode';

/** Where the durable agent lives: the folder that holds its `cli.js`. */
export const PICODE_DURABLE_FOLDER_SETTING = 'picode.durable.folder';

/** Whether PiCode starts the durable agent by itself when a window opens. */
export const PICODE_DURABLE_AUTOSTART_SETTING = 'picode.durable.autoStart';

/** Whether the durable agent's MCP bridge connects the pi profile's servers. */
export const PICODE_DURABLE_MCP_SETTING = 'picode.durable.mcp';

/** Whether the durable agent's deterministic destructive-command guard is on. */
export const PICODE_DURABLE_GUARD_SETTING = 'picode.durable.guard';

/** Which model the durable agent runs on, as `provider/model`. */
export const PICODE_DURABLE_MODEL_SETTING = 'picode.durable.model';

/** Which profile agent's instructions the durable agent runs with. */
export const PICODE_DURABLE_AGENT_SETTING = 'picode.durable.agent';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'picode',
	title: 'PiCode',
	properties: {
		[PICODE_PROVIDERS_SETTING]: {
			type: 'array',
			items: {
				type: 'object',
				required: ['id', 'endpoint'],
				properties: {
					id: {
						type: 'string',
						description: localize('picode.providers.id', "A short name for this provider, with no spaces (for example omni). The model list shows it in front of every model of this provider."),
					},
					endpoint: {
						type: 'string',
						description: localize('picode.providers.endpoint', "The provider's address, ending in /v1 when it asks for one."),
					},
					api: {
						type: 'string',
						enum: ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'],
						enumDescriptions: [
							localize('picode.providers.api.openai', "OpenAI (compatible): the usual one."),
							localize('picode.providers.api.responses', "OpenAI (responses)."),
							localize('picode.providers.api.anthropic', "Anthropic (messages)."),
							localize('picode.providers.api.google', "Google (generative AI)."),
						],
						description: localize('picode.providers.api.description', "The dialect that endpoint speaks."),
					},
					key: {
						type: 'string',
						description: localize('picode.providers.key', "The provider's key. Leave it empty when the endpoint needs none. To keep the key out of your settings, write `$NAME` instead — pi then reads it from an environment variable called NAME when it runs."),
					},
				},
			},
			default: [],
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize(
				'picode.providers',
				"Model providers for PiCode. Each row is one provider: its name, its address, the dialect it speaks and its key. [Connect a subscription](command:picode.connectProvider) opens the providers pi can log in with your own account (ChatGPT, Claude, Copilot…)."
			),
		},

		// pi itself: which one runs, how hard it thinks, whether its thinking is shown, and whether
		// the editor's context travels with what he writes. The runtime choice was re-introduced on
		// the owner's request ("si interno o externo") together with the first-run setup; the other
		// questions the retired extension had — transport, voice, its own panel — still do not exist
		// here, and a setting that changes nothing would be a surface that lies.
		[PICODE_PI_RUNTIME_SETTING]: {
			type: 'string',
			enum: ['internal', 'external'],
			enumDescriptions: [
				localize('picode.pi.runtime.internal', "PiCode's own pi, kept inside the editor. PiCode keeps its settings up to date."),
				localize('picode.pi.runtime.external', "Your own pi, installed on your computer. PiCode uses it and never changes it."),
			],
			default: 'internal',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('picode.pi.runtime', "Which pi answers in the chat. Your machine's pi keeps its own settings, so subscriptions you connect stay with the pi inside PiCode. The choice applies to new conversations, and it is the first step of [Set up PiCode](command:picode.setup)."),
		},
		[PICODE_THINKING_LEVEL_SETTING]: {
			type: 'string',
			enum: ['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
			enumDescriptions: [
				localize('picode.pi.thinkingLevel.default', "Whatever pi itself is set to."),
				localize('picode.pi.thinkingLevel.off', "No thinking at all."),
				localize('picode.pi.thinkingLevel.minimal', "Barely any thinking: the fastest."),
				localize('picode.pi.thinkingLevel.low', "A little thinking."),
				localize('picode.pi.thinkingLevel.medium', "pi's own default."),
				localize('picode.pi.thinkingLevel.high', "More thinking, for harder work."),
				localize('picode.pi.thinkingLevel.xhigh', "A lot of thinking. Slow and thorough."),
				localize('picode.pi.thinkingLevel.max', "As much as the model allows. The slowest."),
			],
			default: 'default',
			markdownDescription: localize('picode.pi.thinkingLevel', "How hard pi thinks before answering. Its own setting is used when this is left alone."),
		},
		[PICODE_REASONING_SETTING]: {
			type: 'string',
			enum: ['hide', 'show'],
			enumDescriptions: [
				localize('picode.pi.reasoning.hide', "Only the answer."),
				localize('picode.pi.reasoning.show', "The thinking first, quoted above the answer."),
			],
			default: 'hide',
			markdownDescription: localize('picode.pi.reasoning', "Whether the model's thinking is written into the chat. It is long, and the answer is usually what is wanted."),
		},
		// The MCP servers are the **editor's** (its screen, its `mcp.json`, its trust and its
		// credentials) and the connector gives their tools to pi, through `lm.invokeTool` — one path
		// to a server, not two.
		//
		// Neither `picode.mcp.enabled` nor `picode.mcp.servers` is declared here any more: they
		// are configured on the Agent Customizations page's MCP Servers section now, whose form
		// is the connector's commands. The keys stay the stores the connector reads and writes
		// (`PICODE_MCP_ENABLED_SETTING`, `PICODE_MCP_SERVERS_SETTING`), and every reader of them
		// carries its own default (`enabled` → true, `servers` → an empty list), because the
		// declaration that used to supply one is gone.
		[PICODE_PROJECT_MODE_SETTING]: {
			type: 'string',
			enum: ['auto', 'workspace', 'folder'],
			enumDescriptions: [
				localize('picode.pi.projectMode.auto', "One folder open: pi works in that folder. Several folders open: pi works across the whole workspace area."),
				localize('picode.pi.projectMode.workspace', "The whole workspace area: pi sees and works across every open folder."),
				localize('picode.pi.projectMode.folder', "The first open folder only, whatever else is open beside it."),
			],
			default: 'auto',
			// A window is what a workspace area belongs to, and a folder cannot be chosen per editor tab.
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize('picode.pi.projectMode', "How much of your workspace pi works on: only the first folder, or every folder of the workspace area together. A change here applies to new conversations."),
		},
		[PICODE_CONTEXT_ATTACH_SETTING]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('picode.context.attach', "Send the folder, the file you have open and what is selected in it with every message, so \"fix this\" needs no explaining. The selection is capped: pi can read the rest of the file itself when it needs it."),
		},

		// The experimental durable agent lives in the repository's `experimental/durable` folder
		// (the folder setting below says where), and the editor can now run it: the status panel's
		// Durable section and the "PiCode: Durable" commands start and stop its daemon, list its
		// conversations and send prompts through it. These settings are that agent's own options,
		// kept here (and not only as CLI flags) because this is where options belong; the agent
		// reads this settings file read-only when it starts. Each description says what the
		// setting actually does to that agent, and no more.
		[PICODE_DURABLE_FOLDER_SETTING]: {
			type: 'string',
			default: 'experimental/durable',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('picode.durable.folder', "Where the durable agent lives: the folder that holds its cli.js. A relative path is resolved against your open workspace folders, and then beside the application itself — which is what finds the agent of a build packed inside the PiCode repository while you work in another project. The status panel's Durable section and the PiCode: Durable commands use it to find the agent."),
		},
		[PICODE_DURABLE_AUTOSTART_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('picode.durable.autoStart', "Whether PiCode starts the durable agent by itself when a window opens, so the status panel's Durable section is already running instead of asking. 'PiCode: Stop Durable Agent' means stopped: the editor does not start it again until you ask it to, or the window is reloaded. This is the editor's own behaviour — the agent has no say in it."),
		},
		[PICODE_DURABLE_MCP_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('picode.durable.mcp', "Whether the durable agent (start it with 'PiCode: Start Durable Agent' or from the status panel's Durable section) connects the MCP servers of the host's profile when it starts, offering their tools through a search tool instead of declaring them all. Turning it off is the agent's --no-mcp flag."),
		},
		[PICODE_DURABLE_GUARD_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('picode.durable.guard', "Whether the durable agent blocks destructive commands in code before they run: recursive deletes, forced pushes and history rewrites, disk operations, and any write outside the working directory. Turning it off is the agent's --no-guard flag — with the guard off, nothing stops those commands but you."),
		},
		[PICODE_DURABLE_MODEL_SETTING]: {
			type: 'string',
			default: 'omni/auto',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('picode.durable.model', "Which model the durable agent runs on, written as provider/model (for example omni/auto). The provider has to be one the host's profile knows. The agent's --model flag wins over this setting."),
		},
		[PICODE_DURABLE_AGENT_SETTING]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('picode.durable.agent', "Which profile agent the durable agent runs as: the name of an agents/<name>.md file in the host's profile, whose instructions the conversation then follows. Leave it empty for no agent. The agent's --agent flag wins over this setting."),
		},
	},
});
