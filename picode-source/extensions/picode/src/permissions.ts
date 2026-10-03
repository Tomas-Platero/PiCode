/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The chat's "Default permissions" control, as it reaches pi's native tools.
 *
 * The picker offers two positions — Ask (Default) and Allow all — but the host has shipped
 * four level names over time (`default`, `assisted`, `autoApprove`, `autopilot`) and a stale
 * `chat.permissions.default` can still name one the picker no longer shows. So the mapping
 * stays four-way: ask for the mutating tools at the asking levels, run free at the
 * approving ones, and degrade to asking only where a level is explicitly known to ask.
 *
 * Mutating means pi's own `bash`/`powershell`/`edit`/`write` **and every tool of an MCP server pi
 * runs** (`mcp__…`): those are third-party tools this bridge cannot classify, and the safe reading
 * of "I do not know what this does" is to ask. The editor's own MCP tools are not asked here — the
 * editor asks for them itself before it runs one.
 *
 * This file is pure: no `vscode`, no pi — `node --test` runs it directly, and `agent.ts`
 * calls into it at tool-call time.
 */

/** The level names the host has ever put on `request.permissionLevel` or the setting. */
export type PermissionLevel = 'default' | 'assisted' | 'autoApprove' | 'autopilot';

/** pi's native tools that change the machine when they run; everything else only looks. */
export const MUTATING_TOOLS = ['bash', 'powershell', 'edit', 'write'] as const;

/**
 * pi's own MCP tools, named `mcp__<server>__<tool>` (`dist/extensions/mcp/index.js`).
 *
 * Every one of them is treated as mutating, because this bridge cannot know which of them only
 * reads: they are servers somebody else wrote, and a call can delete a row or send a message. The
 * editor's own MCP tools are a different shape — the editor's prefix is one underscore
 * (`mcp_<server>_<tool>`, `mcpTypes.ts`) — and are deliberately left out: the editor already asks
 * before it runs one, and a second question here would be the same question twice.
 */
const MCP_TOOL_PREFIX = 'mcp__';

/** Whether `toolName` can change something outside this conversation. */
function changesSomething(toolName: string): boolean {
	return (MUTATING_TOOLS as readonly string[]).includes(toolName) || toolName.startsWith(MCP_TOOL_PREFIX);
}

/** The question carousel's single question id; the answer record is keyed by it. */
export const PERMISSION_QUESTION_ID = 'picode-tool-permission';

/** The value the Allow option returns. */
export const PERMISSION_ALLOW = 'allow';

/** The value the Deny option returns. */
export const PERMISSION_DENY = 'deny';

const ASKING_LEVELS: ReadonlySet<string> = new Set(['default', 'assisted']);
const KNOWN_LEVELS: ReadonlySet<string> = new Set([...ASKING_LEVELS, 'autoApprove', 'autopilot']);

/**
 * Whether pi must ask in the chat before `toolName` runs at this level.
 *
 * `undefined` means no level reached us — the host always sends one for a real request, so
 * the honest reading is the picker's default: ask. A level the code does not know means a
 * host writing newer names than this bridge reads: do not gate on what we cannot name.
 */
export function shouldAsk(level: string | undefined, toolName: string): boolean {
	if (!changesSomething(toolName)) {
		return false;
	}
	return level === undefined || ASKING_LEVELS.has(level);
}

/* ------------------------------------------------------------------ *
 * Read-only shell commands run without a question
 * ------------------------------------------------------------------ */

/** The shell tools whose command line this rule can read. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'powershell']);

/**
 * First tokens that only look at the machine: files, text, processes, environment. A command
 * whose first token is not here is a question, always — the safe direction for an allowlist.
 *
 * Deliberately absent, though they are common: `node`, `npm`, `npx`, `python`, `sed`, `awk`,
 * `xargs`, `tee`, `curl`, `wget`. Each of them can execute arbitrary code or write a file, so
 * auto-approving the token would auto-approve everything behind it. `sed` is handled below
 * without its in-place flag.
 */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
	// POSIX file and text inspection
	'cat', 'type', 'head', 'tail', 'less', 'more', 'ls', 'dir', 'pwd', 'echo', 'printf',
	'grep', 'rg', 'find', 'fd', 'wc', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'file',
	'stat', 'readlink', 'realpath', 'basename', 'dirname', 'tree', 'du', 'df', 'nl', 'rev',
	'which', 'where', 'whoami', 'hostname', 'uname', 'env', 'printenv', 'date', 'id', 'groups',
	'jq', 'yq', 'true', 'test', '[',
	// PowerShell read-only cmdlets
	'get-content', 'gc', 'get-childitem', 'gci', 'select-string', 'sls', 'get-item', 'gi',
	'test-path', 'get-location', 'get-command', 'gcm', 'get-member', 'gm', 'measure-object',
	'select-object', 'sort-object', 'where-object', 'format-table', 'format-list', 'out-string',
]);

/** `git` subcommands that only read, with the shapes that stay read-only. */
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
	'status', 'log', 'diff', 'show', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'describe',
	'blame', 'shortlog', 'cat-file', 'merge-base', 'whatchanged', 'reflog', 'name-rev',
	'for-each-ref', 'cherry', 'count-objects', 'var', 'symbolic-ref',
]);

/**
 * Whether a `git` segment only reads.
 *
 * The plain subcommands are read-only by definition. The ambiguous ones — `branch`, `tag`,
 * `remote`, `stash`, `config`, `worktree`, `submodule` — read only in a narrow shape, so their
 * shape is checked rather than the name: listing forms pass, anything else asks.
 */
function isReadOnlyGit(segment: string, tokens: readonly string[]): boolean {
	let index = 1;
	while (index < tokens.length) {
		const token = tokens[index];
		if (token === '-C' || token === '--git-dir' || token === '--work-tree') {
			index += 2;
			continue;
		}
		if (token.startsWith('-')) {
			index += 1;
			continue;
		}
		break;
	}
	const sub = tokens[index]?.toLowerCase();
	if (sub === undefined) {
		return false;
	}
	if (READ_ONLY_GIT_SUBCOMMANDS.has(sub)) {
		return true;
	}
	switch (sub) {
		case 'branch':
		case 'tag':
			// `branch`/`tag` list with no name or with a listing flag; a bare name creates one.
			return /(^|\s)(-l\b|--list|-a\b|--all|-r\b|--remotes|-v\b|-vv|--contains|--merged|--no-merged|--points-at|--format|--sort)(\s|$)/.test(segment)
				&& !/(^|\s)(-d\b|-D\b|-m\b|-M\b|--delete|--move)(\s|$)/.test(segment);
		case 'remote':
			return /\bremote\s+(-v|--verbose|show|get-url|show-url)\b/.test(segment) || /\bremote\s*$/.test(segment);
		case 'stash':
			return /\bstash\s+(list|show)\b/.test(segment);
		case 'config':
			return /\bconfig\s+.*(--get\b|--get-all\b|--list\b|-l\b|--get-regexp\b)/.test(segment);
		case 'worktree':
			return /\bworktree\s+list\b/.test(segment);
		case 'submodule':
			return /\bsubmodule\s+(status|summary)\b/.test(segment);
		default:
			return false;
	}
}

/** Splits a shell line on the operators that chain commands, so each one is checked. */
function shellSegments(command: string): string[] | undefined {
	// Command substitution and redirection run or write something the whitelist cannot see.
	if (/[$`]|<<|\(|\)/.test(command) || />/.test(command)) {
		return undefined;
	}
	return command
		.split(/&&|\|\||;|\|/)
		.map(segment => segment.trim())
		.filter(segment => segment.length > 0);
}

/** The argv word an assignment prefix (`FOO=bar cmd`) wraps, or `undefined` when there is none. */
function commandToken(segment: string): string | undefined {
	const tokens = segment.split(/\s+/).filter(token => token.length > 0);
	let index = 0;
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
		index += 1;
	}
	return tokens[index];
}

/** Whether one shell segment only reads. */
function isReadOnlySegment(segment: string): boolean {
	const tokens = segment.split(/\s+/).filter(token => token.length > 0);
	const first = (commandToken(segment) ?? '').toLowerCase();
	if (first === '') {
		return false;
	}
	if (first === 'cd') {
		return true;
	}
	if (first === 'git') {
		return isReadOnlyGit(segment, tokens);
	}
	if (first === 'sed') {
		// Only `sed -i` writes, and that is the shape that matters here.
		return !/(^|\s)-i\b|--in-place/.test(segment);
	}
	return READ_ONLY_COMMANDS.has(first);
}

/**
 * Whether a shell tool call is read-only end to end and can run without asking.
 *
 * Every segment of a chain has to pass, so `ls && rm -rf x` asks; so does any redirection, any
 * command substitution, and any binary not on the allowlist. `undefined` input (a call this
 * bridge cannot read) is not read-only.
 */
export function isReadOnlyShellCommand(toolName: string, input: unknown): boolean {
	if (!SHELL_TOOLS.has(toolName)) {
		return false;
	}
	const command = input !== null && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string'
		? (input as { command: string }).command
		: undefined;
	if (command === undefined || command.trim() === '') {
		return false;
	}
	const segments = shellSegments(command);
	if (segments === undefined || segments.length === 0) {
		return false;
	}
	return segments.every(isReadOnlySegment);
}

export interface ToolCallDecision {
	readonly block: boolean;
	readonly reason: string;
}

/**
 * Reads one answer from the question carousel into a pi `tool_call` result.
 *
 * `undefined` is Escape, a cancelled request or a torn-down turn — the owner closed the
 * question without answering, which is not consent. A record without our key, or with an
 * unknown value, is a question answered with something this bridge does not understand:
 * decline rather than guess yes. Only the exact Allow value runs the tool.
 */
export function decisionFromAnswer(answer: Record<string, unknown> | undefined, toolName: string): ToolCallDecision {
	if (answer === undefined) {
		return { block: true, reason: 'Tool call cancelled before approval' };
	}
	if (answer[PERMISSION_QUESTION_ID] === PERMISSION_ALLOW) {
		return { block: false, reason: '' };
	}
	return { block: true, reason: `The user declined this ${toolName} call` };
}

/**
 * Resolves the effective level: the request's own value wins, the `chat.permissions.default`
 * setting covers a request that arrives without one, and anything unrecognizable from
 * either source is the picker's default position — ask.
 */
export function permissionLevelOf(requestLevel: unknown, settingValue: unknown): PermissionLevel {
	if (typeof requestLevel === 'string' && KNOWN_LEVELS.has(requestLevel)) {
		return requestLevel as PermissionLevel;
	}
	if (typeof settingValue === 'string' && KNOWN_LEVELS.has(settingValue)) {
		return settingValue as PermissionLevel;
	}
	return 'default';
}
