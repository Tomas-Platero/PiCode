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
						description: localize('picode.providers.key', "The credential, or a `$NAME` that names the environment variable holding it. Leave it empty when the endpoint needs none."),
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
			markdownDescription: localize('picode.pi.runtime', "Which pi runs as the editor's agent. Your machine's pi keeps its own settings, so subscriptions you connect stay with the pi inside PiCode. The choice applies to new conversations, and it is also the first step of [Set up PiCode](command:picode.setup)."),
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
		// to a server, not two. So this row does not configure servers: it decides whether pi gets
		// them, and it says where they are added, because that is the question anyone reading it
		// has.
		[PICODE_MCP_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize(
				'picode.mcp.enabled',
				"Give pi the tools of your MCP servers. The servers themselves are the editor's — [add one](command:workbench.mcp.addConfiguration), [see them](command:workbench.mcp.listServer) or [edit the configuration](command:workbench.mcp.openUserMcpJson) — and pi calls them through the editor, so its confirmations and permissions apply."
			),
		},
		// MCP **for pi**: the servers are declared here and written into PiCode's own profile
		// (`data/pi-agent/mcp.json`), which the connector hands to the editor as MCP definitions — the
		// editor runs them and pi uses their tools through it, one path and one set of credentials. The
		// editor's own MCP screen is a different thing, for a different agent.
		[PICODE_MCP_SERVERS_SETTING]: {
			type: 'array',
			items: {
				type: 'object',
				required: ['name', 'target'],
				properties: {
					name: { type: 'string', description: localize('picode.mcp.servers.name', "The name the server is called by (for example vercel).") },
					transport: { type: 'string', enum: ['http', 'stdio'], enumDescriptions: [localize('picode.mcp.servers.http', "Remote: the server runs elsewhere and PiCode talks to its address."), localize('picode.mcp.servers.stdio', "Local: PiCode starts the command.")], description: localize('picode.mcp.servers.transport', "Where the server runs.") },
					target: { type: 'string', description: localize('picode.mcp.servers.target', "The address of a remote server, or the command of a local one.") },
					args: { type: 'string', description: localize('picode.mcp.servers.args', "Arguments for a local server's command, separated by spaces.") },
					key: { type: 'string', description: localize('picode.mcp.servers.key', "The server's token, when it needs one. It is written to pi's profile, and sent as `Authorization: Bearer …`.") },
				},
			},
			default: [],
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize(
				'picode.mcp.servers',
				"The MCP servers **pi** uses. Each row is one server: its name, where it runs, its address or command, and a token when it needs one. The editor runs them and pi calls their tools through it, so the editor's own confirmations apply. For example Vercel: name `vercel`, remote, `https://mcp.vercel.com`."
			),
		},
		[PICODE_CONTEXT_ATTACH_SETTING]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('picode.context.attach', "Send the folder, the file you have open and what is selected in it with every message, so \"fix this\" needs no explaining. The selection is capped: pi can read the rest of the file itself when it needs it."),
		},
	},
});
