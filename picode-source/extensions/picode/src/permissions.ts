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
