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
import './picodeProvidersModelsSection.js';
import './picodeStatusSection.js';
import './picodeUsageLimitsSection.js';
import './picodeAgentStatusPill.js';
import './picodeUsageStatus.js';
import './picodeSetupCommands.js';
import './picodeWhatsNew.js';
import './picodeSpeech.js';

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
export const PICODE_DISABLED_TOOLS_SETTING = 'picode.pi.disabledTools';

/** Whether pi gets the tools of the editor's MCP servers. */
export const PICODE_MCP_ENABLED_SETTING = 'picode.mcp.enabled';

/** The MCP servers pi runs, written into its own profile for the adapter to read. */
export const PICODE_MCP_SERVERS_SETTING = 'picode.mcp.servers';

/** Whether the editor's context travels with every prompt. */
export const PICODE_CONTEXT_ATTACH_SETTING = 'picode.context.attach';
export const PICODE_CONTEXT_MODE_SETTING = 'picode.context.mode';

/** Which pi runs as the editor's agent: PiCode's own, or the machine's. */
export const PICODE_PI_RUNTIME_SETTING = 'picode.pi.runtime';

/** Whether pi works on the whole workspace area or on the first folder alone. */
export const PICODE_PROJECT_MODE_SETTING = 'picode.pi.projectMode';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'picode',
	title: 'PiCode',
	properties: {
		// Declared here, not by the connector: settings an extension declares land under
		// `Extensions › PiCode` for ever (`settingsEditor2.ts` builds the tree from core groups only),
		// so a row the owner needs to find has to be born in the core.
		'picode.updates.check': {
			type: 'boolean',
			default: true,
			description: localize('picode.updates.check', "Check for updates in the background and offer to install them when there are any."),
		},
		'picode.memory.enabled': {
			type: 'boolean',
			default: true,
			description: localize('picode.memory.enabled', "Keep memory on: remember decisions, conventions and traps across conversations."),
		},

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
			// The providers are managed in Chat Settings › Providers & Models; this key is only where
			// they are stored, so it has no row of its own in the settings tree.
			included: false,
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
			order: 1,
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
			order: 3,
			markdownDescription: localize('picode.pi.thinkingLevel', "How hard pi thinks before answering. Its own setting is used when this is left alone."),
		},
		[PICODE_REASONING_SETTING]: {
			type: 'string',
			enum: ['hide', 'show'],
			enumDescriptions: [
				localize('picode.pi.reasoning.hide', "Only the answer."),
				localize('picode.pi.reasoning.show', "The thinking first, quoted above the answer."),
			],
			default: 'show',
			order: 4,
			markdownDescription: localize('picode.pi.reasoning', "Whether the model's thinking is written into the chat. It is long, and the answer is usually what is wanted."),
		},
		[PICODE_DISABLED_TOOLS_SETTING]: {
			type: 'array',
			items: { type: 'string' },
			default: [],
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('picode.pi.disabledTools', "Agent tools that stay off, by name: `bash`, `edit`, `write`, `read`, `grep`, `background`, and every MCP tool as `mcp_servername` or the tool's own name. The session rebuilds when the list changes. This is what the agent cannot reach, not a security boundary — its commands still ask before they run."),
		},
		// The MCP servers are the **editor's** (its screen, its `mcp.json`, its trust and its
		// credentials) and the connector gives their tools to pi, through `lm.invokeTool` — one path
		// to a server, not two.
		//
		// The MCP servers are the **editor's** (its page, pi's `mcp.json`, its trust and its
		// credentials) and the connector gives their tools to pi. Neither key below is a row in the
		// Settings tree: the live store is `<profile>/mcp.json`, written by the MCP Servers page.
		//
		// They are declared `included: false` on purpose. Undeclared, a leftover value in
		// `settings.json` shows up as an *Unknown Configuration Setting* warning — the editor
		// telling the owner off for a key it wrote itself. Declared and hidden, the value stays
		// readable by the readers that still honour it and nothing appears in any tree.
		'picode.mcp.enabled': {
			type: 'boolean',
			default: true,
			included: false,
		},
		// Written by the setup window when the owner switched dictation on; the connector reads it
		// once at start, begins the download and clears it. Hidden for the same reason as above.
		'picode.voice.downloadOnStart': {
			type: 'boolean',
			default: false,
			included: false,
		},
		'picode.mcp.servers': {
			type: 'array',
			default: [],
			included: false,
		},
		[PICODE_PROJECT_MODE_SETTING]: {
			type: 'string',
			enum: ['auto', 'workspace', 'folder'],
			enumDescriptions: [
				localize('picode.pi.projectMode.auto', "One folder open: pi works in that folder. Several folders open: pi works across the whole workspace area."),
				localize('picode.pi.projectMode.workspace', "The whole workspace area: pi sees and works across every open folder."),
				localize('picode.pi.projectMode.folder', "The first open folder only, whatever else is open beside it."),
			],
			default: 'auto',
			order: 2,
			// A window is what a workspace area belongs to, and a folder cannot be chosen per editor tab.
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize('picode.pi.projectMode', "How much of your workspace pi works on: only the first folder, or every folder of the workspace area together. A change here applies to new conversations."),
		},
		// Written by the setup window, read and cleared by the account contribution. Nobody sets it
		// by hand: it exists so the first sign-in can be asked for before the editor exists.
		// Written by the setup window when it finished the browser round-trip, read once by the
		// account provider (which trades it for its own session and clears it). Nobody types here.
		// The session the setup minted, waiting for the editor's first start (which moves it into
		// encrypted storage and clears these).
		// Published by the editor on every auth change so any other surface (PiCode's setup window)
		// can show the same truth. Empty means signed out.
		'picode.account.sessionEmail': {
			// Internal hand-over between the setup window and the editor: readable, never edited by hand.
			included: false,
			type: 'string',
			default: '',
			markdownDescription: localize('picode.account.sessionEmail', "Written by the editor: the account it is signed in with, or empty. Read by PiCode's setup window."),
		},
		'picode.account.pendingRefreshToken': {
			// Internal hand-over between the setup window and the editor: readable, never edited by hand.
			included: false,
			type: 'string',
			default: '',
			markdownDescription: localize('picode.account.pendingRefreshToken', "Session left by PiCode's setup. The editor adopts it on start and clears it."),
		},
		'picode.account.pendingUid': { type: 'string', default: '', included: false },
		'picode.account.pendingEmail': { type: 'string', default: '', included: false },
		'picode.account.pendingCode': {
			// Internal hand-over between the setup window and the editor: readable, never edited by hand.
			included: false,
			type: 'string',
			default: '',
			markdownDescription: localize('picode.account.pendingCode', "One-time code from a sign-in completed in PiCode's setup. The editor redeems it once and clears it."),
		},
		'picode.account.signOutOnStart': {
			// Internal hand-over between the setup window and the editor: readable, never edited by hand.
			included: false,
			type: 'boolean',
			default: false,
			markdownDescription: localize('picode.account.signOutOnStart', "Set by PiCode's setup when you signed out there. The editor drops its PiCode session on start and clears it."),
		},
		'picode.account.signInOnStart': {
			// Internal hand-over between the setup window and the editor: readable, never edited by hand.
			included: false,
			type: 'boolean',
			default: false,
			markdownDescription: localize('picode.account.signInOnStart', "Set by PiCode's setup when you asked to sign in there. The editor signs in on start and clears it."),
		},
		[PICODE_CONTEXT_ATTACH_SETTING]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('picode.context.attach', "Send the folder, the file you have open and what is selected in it with every message, so \"fix this\" needs no explaining. The selection is capped: pi can read the rest of the file itself when it needs it."),
		},
		[PICODE_CONTEXT_MODE_SETTING]: {
			type: 'string',
			enum: ['project', 'file', 'selection'],
			enumDescriptions: [
				localize('picode.context.mode.project', "The workspace folder, the open file and the selection. What \"fix this\" needs."),
				localize('picode.context.mode.file', "The open file and the selection, without naming the folder."),
				localize('picode.context.mode.selection', "Only the text you selected, plus what you attached by hand. No paths leave the editor."),
			],
			default: 'project',
			markdownDescription: localize('picode.context.mode', "How much of what you see travels with each message. The agent can still read any file it needs; this says what it is told without asking."),
		},
	},
});
