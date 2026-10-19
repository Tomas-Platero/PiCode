/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IStringDictionary } from '../../../../../base/common/collections.js';
import type { IJSONSchema } from '../../../../../base/common/jsonSchema.js';
import { localize } from '../../../../../nls.js';
import { type IConfigurationPropertySchema } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { gitAutoApproveRules } from '../../../../../platform/terminal/common/autoApprove/gitAutoApproveRules.js';
import { powershellAutoApproveRules } from '../../../../../platform/terminal/common/autoApprove/powershellAutoApproveRules.js';
import { sortAutoApproveRules } from '../../../../../platform/terminal/common/autoApprove/sortAutoApproveRules.js';
import { TerminalSettingId } from '../../../../../platform/terminal/common/terminal.js';
import { terminalProfileBaseProperties } from '../../../../../platform/terminal/common/terminalPlatformConfiguration.js';
import { PolicyCategory } from '../../../../../base/common/policy.js';

/**
 * Default idle silence timeout in milliseconds. Used as both the configuration
 * default and the runtime fallback when the setting is unavailable.
 */
export const DEFAULT_IDLE_SILENCE_TIMEOUT_MS = 300_000; // 5 minutes

export const enum TerminalChatAgentToolsSettingId {
	EnableAutoApprove = 'chat.tools.terminal.enableAutoApprove',
	AutoApprove = 'chat.tools.terminal.autoApprove',
	AutoApproveWorkspaceNpmScripts = 'chat.tools.terminal.autoApproveWorkspaceNpmScripts',
	IgnoreDefaultAutoApproveRules = 'chat.tools.terminal.ignoreDefaultAutoApproveRules',
	BlockDetectedFileWrites = 'chat.tools.terminal.blockDetectedFileWrites',
	ShellIntegrationTimeout = 'chat.tools.terminal.shellIntegrationTimeout',
	OutputLocation = 'chat.tools.terminal.outputLocation',
	AgentSandboxLinuxFileSystem = 'chat.agent.sandbox.fileSystem.linux',
	AgentSandboxMacFileSystem = 'chat.agent.sandbox.fileSystem.mac',
	AgentSandboxWindowsFileSystem = 'chat.agent.sandbox.fileSystem.windows',
	AgentSandboxAdvancedRuntime = 'chat.agent.sandbox.advanced.runtime',
	PreventShellHistory = 'chat.tools.terminal.preventShellHistory',
	EnforceTimeoutFromModel = 'chat.tools.terminal.enforceTimeoutFromModel',
	IdleSilenceTimeoutMs = 'chat.tools.terminal.idleSilenceTimeoutMs',
	DetachBackgroundProcesses = 'chat.tools.terminal.detachBackgroundProcesses',
	BackgroundNotifications = 'chat.tools.terminal.backgroundNotifications',
	OutputDeltas = 'chat.tools.terminal.outputDeltas',
	OutputCompaction = 'chat.tools.terminal.outputCompaction',
	IdlePollInterval = 'chat.tools.terminal.idlePollInterval',

	TerminalProfileLinux = 'chat.tools.terminal.terminalProfile.linux',
	TerminalProfileMacOs = 'chat.tools.terminal.terminalProfile.osx',
	TerminalProfileWindows = 'chat.tools.terminal.terminalProfile.windows',

	DeprecatedAutoApproveCompatible = 'chat.agent.terminal.autoApprove',
	DeprecatedAutoApprove1 = 'chat.agent.terminal.allowList',
	DeprecatedAutoApprove2 = 'chat.agent.terminal.denyList',
	DeprecatedAutoApprove3 = 'github.copilot.chat.agent.terminal.allowList',
	DeprecatedAutoApprove4 = 'github.copilot.chat.agent.terminal.denyList',
}

export interface ITerminalChatAgentToolsConfiguration {
	autoApprove: { [key: string]: boolean };
	commandReportingAllowList: { [key: string]: boolean };
	shellIntegrationTimeout: number;
}

const autoApproveBoolean: IJSONSchema = {
	type: 'boolean',
	enum: [
		true,
		false,
	],
	enumDescriptions: [
		localize('autoApprove.true', "Automatically approve the pattern."),
		localize('autoApprove.false', "Require explicit approval for the pattern."),
	],
	description: localize('autoApprove.key', "The start of a command to match against. A regular expression can be provided by wrapping the string in `/` characters."),
};

const terminalChatAgentProfileSchema: IJSONSchema = {
	type: 'object',
	required: ['path'],
	properties: {
		path: {
			description: localize('terminalChatAgentProfile.path', "A path to a shell executable."),
			type: 'string',
		},
		...terminalProfileBaseProperties,
	}
};

export const terminalChatAgentToolsConfiguration: IStringDictionary<IConfigurationPropertySchema> = {
	[TerminalChatAgentToolsSettingId.EnableAutoApprove]: {
		restricted: true,
		description: localize('autoApproveMode.description', "Controls whether to allow auto approval in the run in terminal tool."),
		type: 'boolean',
		default: true,
		policy: {
			name: 'ChatToolsTerminalEnableAutoApprove',
			category: PolicyCategory.IntegratedTerminal,
			minimumVersion: '1.104',
			localization: {
				description: {
					key: 'autoApproveMode.description',
					value: localize('autoApproveMode.description', "Controls whether to allow auto approval in the run in terminal tool."),
				}
			}
		},
		agentsWindow: { default: true },
	},
	[TerminalChatAgentToolsSettingId.AutoApprove]: {
		restricted: true,
		markdownDescription: [
			localize('autoApprove.description.intro', "A list of commands or regular expressions that control whether the run in terminal tool commands require explicit approval. These will be matched against the start of a command. A regular expression can be provided by wrapping the string in {0} characters followed by optional flags such as {1} for case-insensitivity.", '`/`', '`i`'),
			localize('autoApprove.description.values', "Set to {0} to automatically approve commands, {1} to always require explicit approval or {2} to unset the value.", '`true`', '`false`', '`null`'),
			localize('autoApprove.description.subCommands', "Note that these commands and regular expressions are evaluated for every _sub-command_ within the full _command line_, so {0} for example will need both {1} and {2} to match a {3} entry and must not match a {4} entry in order to auto approve. Inline commands such as {5} (process substitution) should also be detected.", '`foo && bar`', '`foo`', '`bar`', '`true`', '`false`', '`<(foo)`'),
			localize('autoApprove.description.commandLine', "An object can be used to match against the full command line instead of matching sub-commands and inline commands, for example {0}. In order to be auto approved _both_ the sub-command and command line must not be explicitly denied, then _either_ all sub-commands or command line needs to be approved.", '`{ approve: false, matchCommandLine: true }`'),
			localize('autoApprove.defaults', "Note that there's a default set of rules to allow and also deny commands. Consider setting {0} to {1} to ignore all default rules to ensure there are no conflicts with your own rules. Do this at your own risk, the default denial rules are designed to protect you against running dangerous commands.", `\`#${TerminalChatAgentToolsSettingId.IgnoreDefaultAutoApproveRules}#\``, '`true`'),
			[
				localize('autoApprove.description.examples.title', 'Examples:'),
				`|${localize('autoApprove.description.examples.value', "Value")}|${localize('autoApprove.description.examples.description', "Description")}|`,
				'|---|---|',
				'| `\"mkdir\": true` | ' + localize('autoApprove.description.examples.mkdir', "Allow all commands starting with {0}", '`mkdir`'),
				'| `\"npm run build\": true` | ' + localize('autoApprove.description.examples.npmRunBuild', "Allow all commands starting with {0}", '`npm run build`'),
				'| `\"bin/test.sh\": true` | ' + localize('autoApprove.description.examples.binTest', "Allow all commands that match the path {0} ({1}, {2}, etc.)", '`bin/test.sh`', '`bin\\test.sh`', '`./bin/test.sh`'),
				'| `\"/^git (status\\|show\\\\b.*)$/\": true` | ' + localize('autoApprove.description.examples.regexGit', "Allow {0} and all commands starting with {1}", '`git status`', '`git show`'),
				'| `\"/^Get-ChildItem\\\\b/i\": true` | ' + localize('autoApprove.description.examples.regexCase', "will allow {0} commands regardless of casing", '`Get-ChildItem`'),
				'| `\"/.*/\": true` | ' + localize('autoApprove.description.examples.regexAll', "Allow all commands (denied commands still require approval)"),
				'| `\"rm\": false` | ' + localize('autoApprove.description.examples.rm', "Require explicit approval for all commands starting with {0}", '`rm`'),
				'| `\"/\\\\.ps1/i\": { approve: false, matchCommandLine: true }` | ' + localize('autoApprove.description.examples.ps1', "Require explicit approval for any _command line_ that contains {0} regardless of casing", '`".ps1"`'),
				'| `\"rm\": null` | ' + localize('autoApprove.description.examples.rmUnset', "Unset the default {0} value for {1}", '`false`', '`rm`'),
			].join('\n'),
		].join('\n\n'),
		type: 'object',
		additionalProperties: {
			anyOf: [
				autoApproveBoolean,
				{
					type: 'object',
					properties: {
						approve: autoApproveBoolean,
						matchCommandLine: {
							type: 'boolean',
							enum: [
								true,
								false,
							],
							enumDescriptions: [
								localize('autoApprove.matchCommandLine.true', "Match against the full command line, eg. `foo && bar`."),
								localize('autoApprove.matchCommandLine.false', "Match against sub-commands and inline commands, eg. `foo && bar` will need both `foo` and `bar` to match."),
							],
							description: localize('autoApprove.matchCommandLine', "Whether to match against the full command line, as opposed to splitting by sub-commands and inline commands."),
						}
					},
					required: ['approve']
				},
				{
					type: 'null',
					description: localize('autoApprove.null', "Ignore the pattern, this is useful for unsetting the same pattern set at a higher scope."),
				},
			]
		},
		default: {
			// This is the default set of terminal auto approve commands. Note that these are best
			// effort and do not aim to provide exhaustive coverage to prevent dangerous commands
			// from executing as that is simply not feasible. Workspace trust and warnings of
			// possible prompt injection are _the_ thing protecting the user in agent mode, once
			// that trust boundary has been breached all bets are off as trusting a workspace that
			// contains anything malicious has already compromised the machine.
			//
			// Instead, the focus here is to unblock the user from approving clearly safe commands
			// frequently and cover common edge cases that could arise from the user auto-approving
			// commands.
			//
			// Take for example `find` which looks innocuous and most users are likely to auto
			// approve future calls when offered. However, the `-exec` argument can run anything. So
			// instead of leaving this decision up to the user we provide relatively safe defaults
			// and block common edge cases. So offering these default rules, despite their flaws, is
			// likely to protect the user more in general than leaving everything up to them (plus
			// make agent mode more convenient).

			// #region Safe commands
			//
			// Generally safe and common readonly commands

			cd: true,
			echo: true,
			ls: true,
			dir: true,
			pwd: true,
			cat: true,
			head: true,
			tail: true,
			findstr: true,
			wc: true,
			tr: true,
			cut: true,
			cmp: true,
			which: true,
			basename: true,
			dirname: true,
			realpath: true,
			readlink: true,
			stat: true,
			file: true,
			od: true,
			du: true,
			df: true,
			sleep: true,
			nl: true,

			// grep
			// - Variable
			// - `-f`: Read patterns from file, this is an acceptable risk since you can do similar
			//   with cat
			// - `-P`: PCRE risks include denial of service (memory exhaustion, catastrophic
			//   backtracking) which could lock up the terminal. Older PCRE versions allow code
			//   execution via this flag but this has been patched with CVEs.
			// - Variable injection is possible, but requires setting a variable which would need
			//   manual approval.
			grep: true,

			// #endregion

			// #region Safe sub-commands
			//
			// Safe and common sub-commands

			...gitAutoApproveRules,

			// docker - readonly sub-commands
			[`/^docker\\s+(ps|images|info|version|inspect|logs|top|stats|port|diff|search|events)\\b/`]: true,
			[`/^docker\\s+(container|image|network|volume|context|system)\\s+(ls|ps|inspect|history|show|df|info)\\b/`]: true,
			[`/^docker\\s+compose\\s+(ps|ls|top|logs|images|config|version|port|events)\\b/`]: true,

			// #endregion

			// #region PowerShell

			...powershellAutoApproveRules,

			// #endregion

			// #region Package managers (npm, yarn, pnpm)
			//
			// Read-only commands that don't modify files or execute arbitrary code.

			// npm read-only commands
			[`/^npm\\s+(ls|list|outdated|view|info|show|explain|why|root|prefix|bin|search|doctor|fund|repo|bugs|docs|home|help(-search)?)\\b/`]: true,
			[`/^npm\\s+config\\s+(list|get)\\b/`]: true,
			[`/^npm\\s+pkg\\s+get\\b/`]: true,
			[`/^npm\\s+audit$/`]: true,
			[`/^npm\\s+cache\\s+verify\\b/`]: true,

			// yarn read-only commands
			[`/^yarn\\s+(list|outdated|info|why|bin|help|versions)\\b/`]: true,
			[`/^yarn\\s+licenses\\b/`]: true,
			[`/^yarn\\s+audit\\b(?!.*\\bfix\\b)/`]: true,
			[`/^yarn\\s+config\\s+(list|get)\\b/`]: true,
			[`/^yarn\\s+cache\\s+dir\\b/`]: true,

			// pnpm read-only commands
			[`/^pnpm\\s+(ls|list|outdated|why|root|bin|doctor)\\b/`]: true,
			[`/^pnpm\\s+licenses\\b/`]: true,
			[`/^pnpm\\s+audit\\b(?!.*\\bfix\\b)/`]: true,
			[`/^pnpm\\s+config\\s+(list|get)\\b/`]: true,

			// Safe lockfile-only installs since we trust the workspace and lock file is trusted.
			'npm ci': true,
			[`/^yarn\\s+install\\s+--frozen-lockfile\\b/`]: true,
			[`/^pnpm\\s+install\\s+--frozen-lockfile\\b/`]: true,

			// #endregion

			// #region Safe + disabled args
			//
			// Commands that are generally allowed with special cases we block. Note that shell
			// expansion is handled by the inline command detection when parsing sub-commands.

			// column
			// - `-c`: We block excessive columns that could lead to memory exhaustion.
			column: true,
			[`/^column\\b.*\\s-c\\s+[0-9]{4,}/`]: false,

			// date
			// -s|--set: Sets the system clock
			date: true,
			[`/^date\\b.*\\s(-s|--set)\\b/`]: false,

			// find
			// - `-delete`: Deletes files or directories.
			// - `-exec`/`-execdir`: Execute on results.
			// - `-fprint`/`fprintf`/`fls`: Writes files.
			// - `-ok`/`-okdir`: Like exec but with a confirmation.
			find: true,
			[`/^find\\b.*\\s-(delete|exec|execdir|fprint|fprintf|fls|ok|okdir)\\b/`]: false,

			// rg (ripgrep)
			// - `--pre`: Executes arbitrary command as preprocessor for every file searched.
			// - `--hostname-bin`: Executes arbitrary command to get hostname.
			rg: true,
			[`/^rg\\b.*\\s(--pre|--hostname-bin)\\b/`]: false,

			// sed
			// - `-e`/`--expression`: Add the commands in script to the set of commands to be run
			//   while processing the input.
			// - `-f`/`--file`: Add the commands contained in the file script-file to the set of
			//   commands to be run while processing the input.
			// - standalone `e`: Execute a shell command from the sed script
			// - standalone `r`/`R`: Read arbitrary files into the stream
			// - standalone `w`/`W`: Write pattern space to arbitrary files
			// - `s///e` flag: Executes substitution result as shell command
			// - `s///w` flag: Write substitution result to file
			// - Note that `--sandbox` exists which blocks unsafe commands that could potentially be
			//   leveraged to auto approve
			// - In-place editing (`-i`, `-I`, `--in-place`) is detected and blocked via file write
			//   detection if necessary
			// - These patterns are conservative: a literal `;e ` or `{e ` inside a replacement
			//   string also matches, which asks for confirmation rather than auto-approving.
			// TODO: replace sed deny regexes with a shared script analyzer — https://github.com/microsoft/vscode/issues/329218
			sed: true,
			[`/^sed\\b.*\\s(-[a-zA-Z]*(e|f)[a-zA-Z]*|--expression|--file)\\b/`]: false,
			[`/^sed\\b.*s\\/.*\\/.*\\/[ew]/`]: false,
			// Quoted positional script whose first command is e/r/R/w/W. The opening quote is
			// captured so the closing quote must match it, and whitespace and `!` are allowed
			// around the optional address since sed ignores them. The option prefix also skips
			// the separate operand consumed by -l/--line-length.
			[`/^sed\\b(?:\\s+(?:(?:-l|--line-length)\\s+\\S+|--line-length=\\S+|-\\S+))*\\s+([\'"])\\s*(?:(?:\\d+|\\$|\\/(?:\\\\.|[^\\/])*\\/)(?:\\s*,\\s*(?:\\d+|\\$|\\/(?:\\\\.|[^\\/])*\\/))?)?\\s*!?\\s*[erRwW](?:\\s|\\1)/`]: false,
			// Same dangerous commands after a `;` or `{` separator inside a quoted script.
			// Escaped characters are consumed before testing for the matching closing quote.
			[`/^sed\\b(?:\\s+(?:(?:-l|--line-length)\\s+\\S+|--line-length=\\S+|-\\S+))*\\s+([\'"])(?:\\\\.|(?!\\1).)*[;{]\\s*(?:(?:\\d+|\\$|\\/(?:\\\\.|[^\\/])*\\/)(?:\\s*,\\s*(?:\\d+|\\$|\\/(?:\\\\.|[^\\/])*\\/))?)?\\s*!?\\s*[erRwW](?:\\s|\\1|[;}])/`]: false,
			// Unquoted positional script form (e.g. `sed 1e id`, `sed w file`, `sed /pat/e file`)
			[`/^sed\\b(?:\\s+(?:(?:-l|--line-length)\\s+\\S+|--line-length=\\S+|-\\S+))*\\s+(?:(?:\\d+|\\$|\\/(?:\\\\.|[^\\/])*\\/)(?:\\s*,\\s*(?:\\d+|\\$|\\/(?:\\\\.|[^\\/])*\\/))?)?\\s*!?\\s*[erRwW](?:\\s|$)/`]: false,

			...sortAutoApproveRules,

			// tree
			// - `-o`: Output redirection can write files (`tree -o /etc/something file`) which are
			//   blocked currently
			tree: true,
			[`/^tree\\b.*\\s-o\\b/`]: false,

			// xxd
			// - Only allow flags and a single input file as it's difficult to parse the outfile
			//   positional argument safely.
			[`/^xxd$/`]: true,
			[`/^xxd\\b(\\s+-\\S+)*\\s+[^-\\s]\\S*$/`]: true,

			// #endregion

			// #region Dangerous commands
			//
			// There are countless dangerous commands available on the command line, the defaults
			// here include common ones that the user is likely to want to explicitly approve first.
			// This is not intended to be a catch all as the user needs to opt-in to auto-approve
			// commands, it provides some additional safety when the commands get approved by overly
			// broad user/workspace rules.

			// Deleting files
			rm: false,
			rmdir: false,
			del: false,
			'Remove-Item': false,
			ri: false,
			rd: false,
			erase: false,
			dd: false,

			// Managing/killing processes, dangerous thing to do generally
			kill: false,
			ps: false,
			top: false,
			'Stop-Process': false,
			spps: false,
			taskkill: false,
			'taskkill.exe': false,

			// Web requests, prompt injection concerns
			curl: false,
			wget: false,
			'Invoke-RestMethod': false,
			'Invoke-WebRequest': false,
			'irm': false,
			'iwr': false,

			// File permissions and ownership, messing with these can cause hard to diagnose issues
			chmod: false,
			chown: false,
			'Set-ItemProperty': false,
			'sp': false,
			'Set-Acl': false,

			// General eval/command execution, can lead to anything else running
			jq: false,
			xargs: false,
			eval: false,
			'Invoke-Expression': false,
			iex: false,

			// #endregion
		} satisfies Record<string, boolean | { approve: boolean; matchCommandLine?: boolean }>,
	},
	[TerminalChatAgentToolsSettingId.IgnoreDefaultAutoApproveRules]: {
		restricted: true,
		type: 'boolean',
		default: false,
		tags: ['experimental'],
		markdownDescription: localize('ignoreDefaultAutoApproveRules.description', "Whether to ignore the built-in default auto-approve rules used by the run in terminal tool as defined in {0}. When this setting is enabled, the run in terminal tool will ignore any rule that comes from the default set but still follow rules defined in the user, remote and workspace settings. Use this setting at your own risk; the default auto-approve rules are designed to protect you against running dangerous commands.", `\`#${TerminalChatAgentToolsSettingId.AutoApprove}#\``),
	},
	[TerminalChatAgentToolsSettingId.AutoApproveWorkspaceNpmScripts]: {
		restricted: true,
		type: 'boolean',
		// In order to use agent mode the workspace must be trusted, this plus the fact that
		// modifying package.json is protected means this is safe to enable by default.
		default: true,
		tags: ['experimental'],
		markdownDescription: localize('autoApproveWorkspaceNpmScripts.description', "Whether to automatically approve npm, yarn, and pnpm run commands when the script is defined in a workspace package.json file. Since the workspace is trusted, scripts defined in package.json are considered safe to run without explicit approval."),
	},
	[TerminalChatAgentToolsSettingId.BlockDetectedFileWrites]: {
		restricted: true,
		type: 'string',
		enum: ['never', 'outsideWorkspace', 'all'],
		enumDescriptions: [
			localize('blockFileWrites.never', "Allow all detected file writes."),
			localize('blockFileWrites.outsideWorkspace', "Block file writes detected outside the workspace. This depends on the shell integration feature working correctly to determine the current working directory of the terminal."),
			localize('blockFileWrites.all', "Block all detected file writes."),
		],
		default: 'outsideWorkspace',
		tags: ['experimental'],
		markdownDescription: localize('blockFileWrites.description', "Controls whether detected file write operations are blocked in the run in terminal tool. When detected, this will require explicit approval regardless of whether the command would normally be auto approved. Note that this cannot detect all possible methods of writing files, this is what is currently detected:\n\n- File redirection (detected via the bash or PowerShell tree sitter grammar)\n- `sed` in-place editing (`-i`, `-I`, `--in-place`)"),
	},
	[TerminalChatAgentToolsSettingId.ShellIntegrationTimeout]: {
		markdownDescription: localize('shellIntegrationTimeout.description', "Configures the duration in milliseconds to wait for shell integration to be detected when the run in terminal tool launches a new terminal. Set to `0` to skip the wait entirely, the default value `-1` uses a variable wait time based on the value of {0} and whether it's a remote window. A large value can be useful if your shell starts very slowly.", `\`#${TerminalSettingId.ShellIntegrationEnabled}#\``),
		type: 'integer',
		minimum: -1,
		maximum: 60000,
		default: -1,
		markdownDeprecationMessage: localize('shellIntegrationTimeout.deprecated', 'Use {0} instead', `\`#${TerminalSettingId.ShellIntegrationTimeout}#\``)
	},
	[TerminalChatAgentToolsSettingId.IdlePollInterval]: {
		markdownDescription: localize('idlePollInterval.description', "Configures the idle poll interval in milliseconds used by the run in terminal tool to detect when commands have finished executing. Lower values make command detection faster but may cause false positives on slow systems. This primarily affects terminals without shell integration where idle detection is used instead of shell integration events."),
		type: 'integer',
		minimum: 50,
		maximum: 10000,
		default: 1000,
	},
	[TerminalChatAgentToolsSettingId.TerminalProfileLinux]: {
		restricted: true,
		markdownDescription: localize('terminalChatAgentProfile.linux', "The terminal profile to use on Linux for chat agent's run in terminal tool."),
		type: ['object', 'null'],
		default: null,
		'anyOf': [
			{ type: 'null' },
			terminalChatAgentProfileSchema
		],
		defaultSnippets: [
			{
				body: {
					path: '${1}'
				}
			}
		]
	},
	[TerminalChatAgentToolsSettingId.TerminalProfileMacOs]: {
		restricted: true,
		markdownDescription: localize('terminalChatAgentProfile.osx', "The terminal profile to use on macOS for chat agent's run in terminal tool."),
		type: ['object', 'null'],
		default: null,
		'anyOf': [
			{ type: 'null' },
			terminalChatAgentProfileSchema
		],
		defaultSnippets: [
			{
				body: {
					path: '${1}'
				}
			}
		]
	},
	[TerminalChatAgentToolsSettingId.TerminalProfileWindows]: {
		restricted: true,
		markdownDescription: localize('terminalChatAgentProfile.windows', "The terminal profile to use on Windows for chat agent's run in terminal tool."),
		type: ['object', 'null'],
		default: null,
		'anyOf': [
			{ type: 'null' },
			terminalChatAgentProfileSchema
		],
		defaultSnippets: [
			{
				body: {
					path: '${1}'
				}
			}
		]
	},
	[TerminalChatAgentToolsSettingId.OutputLocation]: {
		markdownDescription: localize('outputLocation.description', "Where to show the output from the run in terminal tool."),
		type: 'string',
		enum: ['terminal', 'chat'],
		enumDescriptions: [
			localize('outputLocation.terminal', "Reveal the terminal in the panel or editor in addition to chat."),
			localize('outputLocation.chat', "Reveal the terminal output within chat only."),
		],
		default: 'chat',
		tags: ['experimental'],
		experiment: {
			mode: 'auto'
		}
	},
	[TerminalChatAgentToolsSettingId.PreventShellHistory]: {
		type: 'boolean',
		default: true,
		markdownDescription: [
			localize('preventShellHistory.description', "Whether to exclude commands run by the terminal tool from the shell history. See below for the supported shells and the method used for each:"),
			`- \`bash\`: ${localize('preventShellHistory.description.bash', "Sets `HISTCONTROL=ignorespace` and prepends the command with space")}`,
			`- \`zsh\`: ${localize('preventShellHistory.description.zsh', "Sets `HIST_IGNORE_SPACE` option and prepends the command with space")}`,
			`- \`fish\`: ${localize('preventShellHistory.description.fish', "Sets `fish_private_mode` to prevent any command from entering history")}`,
			`- \`pwsh\`: ${localize('preventShellHistory.description.pwsh', "Sets a custom history handler via PSReadLine's `AddToHistoryHandler` to prevent any command from entering history")}`,
		].join('\n'),
	},
	[TerminalChatAgentToolsSettingId.EnforceTimeoutFromModel]: {
		restricted: true,
		type: 'boolean',
		default: true,
		tags: ['experimental'],
		experiment: {
			mode: 'auto'
		},
		markdownDescription: localize('enforceTimeoutFromModel.description', "Whether to enforce the timeout value provided by the model in the run in terminal tool. When enabled, if the model provides a timeout parameter, the tool will stop tracking the command after that duration and return the output collected so far."),
	},
	[TerminalChatAgentToolsSettingId.IdleSilenceTimeoutMs]: {
		restricted: true,
		type: 'number',
		default: DEFAULT_IDLE_SILENCE_TIMEOUT_MS,
		minimum: 0,
		tags: ['experimental'],
		experiment: {
			mode: 'auto'
		},
		markdownDescription: localize('idleSilenceTimeoutMs.description', "Number of milliseconds the run in terminal tool will wait for new output from a synchronous command before moving it to a background terminal and returning what was collected so far. The process is not killed — the tool returns the terminal ID so the model can poll, send input, or kill it. Set to {0} to disable.", '`0`'),
	},
	[TerminalChatAgentToolsSettingId.DetachBackgroundProcesses]: {
		included: false,
		restricted: true,
		type: 'boolean',
		default: false,
		tags: ['experimental'],
		markdownDescription: localize('detachBackgroundProcesses.description', "Whether to detach persistent terminal processes so they survive when VS Code exits. When enabled, commands started with `mode: \"async\"` (legacy: `isBackground: true`) are wrapped with `nohup` (POSIX) or `Start-Process` (Windows) so the process continues running after the terminal is disposed."),
	},
	[TerminalChatAgentToolsSettingId.BackgroundNotifications]: {
		restricted: true,
		type: 'boolean',
		default: true,
		tags: ['experimental'],
		deprecated: true,
		markdownDeprecationMessage: localize('backgroundNotifications.deprecated', "This setting is deprecated. Terminal completion and input-needed notifications are now always enabled."),
		markdownDescription: localize('backgroundNotifications.description', "This setting is deprecated and no longer has any effect. Terminal completion and input-needed notifications are now always enabled for any command that continues running after the tool returns."),
	},
	[TerminalChatAgentToolsSettingId.OutputDeltas]: {
		restricted: true,
		type: 'boolean',
		default: false,
		tags: ['experimental'],
		experiment: {
			mode: 'auto'
		},
		markdownDescription: localize('outputDeltas.description', "When enabled, repeated get terminal output tool calls return only output added since the previous poll for the same terminal execution, or a short unchanged-output message when there is no new output."),
	},
	[TerminalChatAgentToolsSettingId.OutputCompaction]: {
		restricted: true,
		type: 'boolean',
		default: false,
		tags: ['experimental'],
		experiment: {
			mode: 'auto'
		},
		markdownDescription: localize('outputCompaction.description', "When enabled, the output of commands run by the run in terminal tool is compacted before being returned to the model, reducing the number of tokens spent on noisy output (for example progress bars or repeated log lines) while preserving the important information."),
	}
};

for (const id of [
	TerminalChatAgentToolsSettingId.DeprecatedAutoApprove1,
	TerminalChatAgentToolsSettingId.DeprecatedAutoApprove2,
	TerminalChatAgentToolsSettingId.DeprecatedAutoApprove3,
	TerminalChatAgentToolsSettingId.DeprecatedAutoApprove4,
	TerminalChatAgentToolsSettingId.DeprecatedAutoApproveCompatible,
]) {
	terminalChatAgentToolsConfiguration[id] = {
		...(id === TerminalChatAgentToolsSettingId.DeprecatedAutoApproveCompatible ? { restricted: true } : {}),
		deprecated: true,
		markdownDeprecationMessage: localize('autoApprove.deprecated', 'Use {0} instead', `\`#${TerminalChatAgentToolsSettingId.AutoApprove}#\``)
	};
}
