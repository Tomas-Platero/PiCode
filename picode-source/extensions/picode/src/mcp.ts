/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { mcpTools, toolResultText, type EditorToolInfo, type McpTool } from './mcpTools';
import type { OfficialSdk } from './piSdk';

/**
 * The MCP servers of the editor, given to pi as tools of its own.
 *
 * pi has MCP of its own since 0.99, but that is not this: pi's own MCP reads the servers declared
 * in its profile's `mcp.json` and reaches them itself. This module is the **other** path, and the
 * one the owner asked for — the editor's own servers and its own screen, handed to pi through the
 * editor. What pi does not have is a way to call them with the editor's permissions, and the editor
 * *does* have MCP — its own servers, its own screen to add them, its own permissions — and it
 * exposes every MCP tool as a language model tool.
 *
 * So this module is the bridge the owner asked for. The editor keeps
 * owning the servers (adding, enabling, authenticating, confirming), and pi gets their tools and
 * runs them through the editor with `lm.invokeTool` — which means the editor's confirmation and
 * permission rules apply, instead of a second set of ours.
 *
 * Only the tools the editor marks as MCP are taken (`mcp_` prefix, `mcpTypes.ts`): the rest of
 * `lm.tools` is the editor's own tooling, and pi already has its own tools for reading, editing
 * and running things.
 *
 * The parts that decide *what* a tool is and *what* comes back are pure, so they can be exercised
 * by running them; what needs the editor is the call itself.
 */

/**
 * The token that ties a tool invocation to the chat request in flight.
 *
 * `lm.invokeTool` needs it, and the *only* way to get one is from a chat request — so it cannot be
 * captured when the tools are built (they are built with the session, and the session outlives the
 * request). This holder is what the tools read at call time: `agent.ts` puts the current request's
 * token in it before every turn. Without it there would be no confirmation inline in the chat and
 * no progress shown for a server that takes a while.
 */
export interface ToolTokenHolder {
	current?: vscode.ChatParticipantToolToken;
}

/** pi's `customTools`, exactly as pi's own signature names them. */
type PiCustomTools = NonNullable<Parameters<OfficialSdk['createAgentSessionFromServices']>[0]['customTools']>;

/**
 * The MCP tools of the editor, as pi's `customTools`.
 *
 * The cast at the end is the one honest gap of the SDK boundary: pi's published `ToolDefinition`
 * requires a `details` field on every result, and these tools answer with the text only — which
 * is all pi reads at runtime. The SDK's own members are typed from pi's declarations; this is the
 * value side (the editor's own tools), where pi's runtime contract is looser than its types.
 */
export function piToolsFromEditor(token: ToolTokenHolder): PiCustomTools {
	// SAFETY: pi's runtime reads `content` from a tool result and nothing else; its published
	// `ToolDefinition` requires `details` on every result, which these editor tools do not set.
	// The mismatch is pi's types being stricter than the contract its own runner honours.
	return mcpTools(vscode.lm.tools as readonly EditorToolInfo[]).map(tool => editorTool(tool, token)) as unknown as PiCustomTools;
}

/** What a pi tool answers with: the text the model reads, and nothing else. The array is mutable because pi's own result type declares it mutable — the element shape is pi's `TextContent`. */
export interface PiToolResult {
	content: { readonly type: 'text'; readonly text: string }[];
	readonly details?: undefined;
}

/** One pi tool definition, as the `customTools` of a session reads it. */
export interface PiToolDefinition {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	/** The one line pi lists with the tool in its system prompt. */
	readonly promptSnippet: string;
	readonly parameters: Record<string, unknown>;
	readonly execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<PiToolResult>;
}

/**
 * One pi tool definition that runs the editor's tool.
 *
 * `lm.invokeTool` is the editor's own door: the server, its credentials, its confirmation and its
 * permissions all stay where the owner configured them, and this adds no second path to the same
 * server. A failure is thrown rather than encoded in the result, which is what pi's tool contract
 * asks for and what makes the reason visible in the chat.
 */
function editorTool(tool: McpTool, token: ToolTokenHolder): PiToolDefinition {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		// pi lists the tools it has in the system prompt with this line; without it a custom tool is
		// left out of that list and the model never learns it exists.
		promptSnippet: `${tool.name}: ${tool.description}`,
		parameters: tool.parameters,
		execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal): Promise<PiToolResult> => {
			const result = await vscode.lm.invokeTool(
				tool.name,
				{ input: (params ?? {}) as object, toolInvocationToken: token.current },
				abortSignalFor(signal),
			);
			return { content: [{ type: 'text', text: toolResultText(result.content) }], details: undefined };
		},
	};
}

/**
 * A cancellation token that follows pi's abort signal.
 *
 * `lm.invokeTool` takes a token, and pi hands the tool an `AbortSignal`. Without this, cancelling
 * a turn in the chat would leave the MCP call running — and the server busy — while the answer was
 * already abandoned.
 */
function abortSignalFor(signal: AbortSignal | undefined): vscode.CancellationToken | undefined {
	if (signal === undefined) {
		return undefined;
	}
	const source = new vscode.CancellationTokenSource();
	if (signal.aborted) {
		source.cancel();
	} else {
		signal.addEventListener('abort', () => source.cancel(), { once: true });
	}
	return source.token;
}
