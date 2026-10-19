/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What an MCP tool is, and what comes back from one — the parts of the bridge that decide
 * something.
 *
 * No `vscode` import, so the filtering, the schema and the result can be exercised by running
 * them; `mcp.ts` is the part that calls the editor.
 */

/** The prefix the editor gives the tools of an MCP server (`mcpTypes.ts`: `Prefix = 'mcp_'`). */
export const MCP_TOOL_PREFIX = 'mcp_';

/** A tool as the editor describes it, reduced to the fields this bridge reads. */
export interface EditorToolInfo {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: unknown;
}

/** One MCP tool, in the shape a pi tool definition wants. */
export interface McpTool {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
}

/** Whether the editor's tool is one of an MCP server's. */
export function isMcpTool(tool: EditorToolInfo): boolean {
	return typeof tool.name === 'string' && tool.name.startsWith(MCP_TOOL_PREFIX) && tool.name.length > MCP_TOOL_PREFIX.length;
}

/**
 * The parameter schema, as pi can validate it.
 *
 * An MCP server declares its input as JSON Schema, and pi validates with TypeBox — which *is*
 * JSON Schema at runtime, so an object schema is passed through as it came. Anything else (a
 * schema for a non-object, or one this bridge cannot read) becomes a permissive object: a tool
 * that accepts anything and complains when it is called is better than a tool that cannot be
 * registered at all.
 */
export function toolParameters(schema: unknown): Record<string, unknown> {
	if (typeof schema === 'object' && schema !== null) {
		const record = schema as Record<string, unknown>;
		if (record.type === 'object' || typeof record.properties === 'object') {
			return record;
		}
	}
	return { type: 'object', properties: {}, additionalProperties: true };
}

/**
 * The tool's name as the **model** should see it.
 *
 * The editor's name carries its own prefix (`mcp_github_search`); it is kept, because that is
 * also the name the call has to be made with, and two names for one thing is how a rename turns
 * into a bug. The label is the same name for the screen, which is what pi shows while it works.
 */
export function mcpTools(tools: readonly EditorToolInfo[]): McpTool[] {
	const found: McpTool[] = [];
	for (const tool of tools ?? []) {
		if (!isMcpTool(tool)) {
			continue;
		}
		found.push({
			name: tool.name,
			label: tool.name,
			description: typeof tool.description === 'string' && tool.description.trim().length > 0
				? tool.description.trim()
				: `Tool of an MCP server (${tool.name}).`,
			parameters: toolParameters(tool.inputSchema),
		});
	}
	return found;
}

/**
 * What the editor's tool returned, as pi wants it: text parts, and anything else written out.
 *
 * The editor's result is a list of parts (`LanguageModelTextPart`, prompt-TSX, data), and pi's
 * tool result is text and images. A part that is not text is not dropped — it is turned into its
 * JSON, because a model that receives `[object Object]` learns nothing, and a part that is
 * silently missing is worse: it looks like the tool returned nothing.
 */
export function toolResultText(content: unknown): string {
	if (!Array.isArray(content)) {
		return typeof content === 'string' ? content : '';
	}
	const pieces: string[] = [];
	for (const part of content) {
		if (typeof part === 'string') {
			pieces.push(part);
			continue;
		}
		const value = (part as { value?: unknown } | null)?.value;
		if (typeof value === 'string') {
			pieces.push(value);
			continue;
		}
		if (value !== undefined) {
			pieces.push(JSON.stringify(value));
		}
	}
	return pieces.join('\n');
}

/** A signature of the tool set, to notice when the servers behind it changed. */
export function toolSetSignature(tools: readonly McpTool[]): string {
	return [...tools].map(tool => tool.name).sort().join('|');
}

/* ------------------------------------------------------------------ *
 * What needs the editor
 * ------------------------------------------------------------------ */
