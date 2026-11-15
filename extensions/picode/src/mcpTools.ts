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

/**
 * The integrated browser's tools, by the ids the editor registers them with
 * (`contrib/browserView/electron-browser/tools`). The editor only registers the ones that read or
 * drive a page while `workbench.browser.enableChatTools` is on, so that setting is the switch: no
 * second one here. `list_browser_pages` is left out because the editor marks it as not meant for
 * models.
 */
export const BROWSER_TOOL_IDS: ReadonlySet<string> = new Set([
	'open_browser_page',
	'read_page',
	'screenshot_page',
	'navigate_page',
	'click_element',
	'drag_element',
	'hover_element',
	'type_in_page',
	'run_playwright_code',
	'handle_dialog',
]);

/** Whether the editor's tool is one of the integrated browser's. */
export function isBrowserTool(tool: EditorToolInfo): boolean {
	return typeof tool.name === 'string' && BROWSER_TOOL_IDS.has(tool.name);
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
	return (tools ?? []).filter(isMcpTool).map(tool => asPiTool(tool, `Tool of an MCP server (${tool.name}).`));
}

/**
 * The editor's tools pi is given: the MCP ones when the owner keeps them on (`picode.mcp.enabled`),
 * and the integrated browser's whenever the editor has them registered. The rest of `lm.tools`
 * stays out: pi has its own tools for reading, editing and running things.
 */
export function editorTools(tools: readonly EditorToolInfo[], options: { readonly mcp: boolean }): McpTool[] {
	const browser = (tools ?? []).filter(isBrowserTool).map(tool => asPiTool(tool, `Integrated browser tool (${tool.name}).`));
	return [...(options.mcp ? mcpTools(tools) : []), ...browser];
}

function asPiTool(tool: EditorToolInfo, fallbackDescription: string): McpTool {
	return {
		name: tool.name,
		label: tool.name,
		description: typeof tool.description === 'string' && tool.description.trim().length > 0
			? tool.description.trim()
			: fallbackDescription,
		parameters: toolParameters(tool.inputSchema),
	};
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

/** One piece of a pi tool result: text, or an image the model can look at. */
export type PiResultPart = PiTextPart | PiImagePart;
export interface PiTextPart { readonly type: 'text'; readonly text: string }
export interface PiImagePart { readonly type: 'image'; readonly mimeType: string; readonly data: string }

/**
 * What the editor's tool returned, as pi's result parts.
 *
 * Text is joined into one text part, as `toolResultText` does. A data part with an image type
 * (the browser's screenshot) becomes an image part, base64 as pi expects; other data is decoded
 * as text, because a model that is told nothing came back learns less than one that reads it.
 */
export function toolResultParts(content: unknown): PiResultPart[] {
	const texts: string[] = [];
	const images: PiResultPart[] = [];
	for (const part of Array.isArray(content) ? content : [content]) {
		const data = dataOf(part);
		if (data === undefined) {
			const text = toolResultText([part]);
			if (text.length > 0) {
				texts.push(text);
			}
			continue;
		}
		if (data.mimeType.startsWith('image/')) {
			images.push({ type: 'image', mimeType: data.mimeType, data: Buffer.from(data.bytes).toString('base64') });
		} else {
			texts.push(new TextDecoder().decode(data.bytes));
		}
	}
	const text = texts.join('\n');
	// An image with no text needs no empty text beside it; a result with neither still answers.
	return images.length > 0 && text.length === 0 ? images : [{ type: 'text', text }, ...images];
}

/** The editor's `LanguageModelDataPart`: a mime type and its bytes. */
function dataOf(part: unknown): { mimeType: string; bytes: Uint8Array } | undefined {
	const record = part as { mimeType?: unknown; data?: unknown } | null;
	if (typeof record?.mimeType === 'string' && record.data instanceof Uint8Array) {
		return { mimeType: record.mimeType, bytes: record.data };
	}
	return undefined;
}

/** A signature of the tool set, to notice when the servers behind it changed. */
export function toolSetSignature(tools: readonly McpTool[]): string {
	return [...tools].map(tool => tool.name).sort().join('|');
}

/* ------------------------------------------------------------------ *
 * What needs the editor
 * ------------------------------------------------------------------ */
