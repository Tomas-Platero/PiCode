/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * pi's "MCP servers need attention" notice, redrawn for the chat.
 *
 * pi writes it for a terminal: a header, one `server: raw status` line each (`failed: MCP request
 * timed out after 60000ms`) and "Run /mcp to fix." — an instruction to type something. The chat
 * shows each server with an icon and a status in plain words, and the fix becomes buttons: sign in
 * where a server is waiting for it, and the MCP servers page for the rest.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

/** One server line of the notice. */
export interface McpNoticeRow {
	readonly server: string;
	readonly icon: string;
	readonly status: string;
	readonly needsSignIn: boolean;
}

/** The notice as the chat draws it. */
export interface McpNotice {
	readonly markdown: string;
	readonly rows: readonly McpNoticeRow[];
}

/** The status of one server line, in the words the chat uses. */
export function mcpNoticeRow(server: string, raw: string): McpNoticeRow {
	if (/sign[\s-]?in|log[\s-]?in|auth|unauthori[sz]ed|\b401\b/i.test(raw)) {
		return { server, icon: '🔑', status: 'Sign-in needed', needsSignIn: true };
	}
	if (/timed?\s*out|timeout/i.test(raw)) {
		return { server, icon: '⏱️', status: 'Not responding', needsSignIn: false };
	}
	if (/fail|error|enoent|spawn|exit/i.test(raw)) {
		return { server, icon: '❌', status: 'Could not start', needsSignIn: false };
	}
	const text = raw.trim();
	return { server, icon: '⚠️', status: text.charAt(0).toUpperCase() + text.slice(1), needsSignIn: false };
}

/**
 * The redrawn notice, or `undefined` when the message is not pi's MCP notice (any other notice
 * keeps the generic styling).
 */
export function mcpNotice(message: string): McpNotice | undefined {
	const lines = message.split('\n').map(line => line.trim()).filter(line => line !== '');
	const [header, ...rest] = lines;
	if (header === undefined || !/\bmcp\b/i.test(header) || rest.length === 0) {
		return undefined;
	}
	const rows: McpNoticeRow[] = [];
	for (const line of rest) {
		const match = /^[-*•]?\s*([^:]+):\s+(.+)$/.exec(line);
		if (match !== null) {
			rows.push(mcpNoticeRow(match[1].trim(), match[2]));
		}
		// Anything else is the terminal's "Run /mcp to fix." — the buttons replace it.
	}
	if (rows.length === 0) {
		return undefined;
	}
	const title = rows.length === 1 ? 'An MCP server needs attention' : `${rows.length} MCP servers need attention`;
	// Hard line breaks keep the rows tight; a list would add a bullet beside every icon.
	const body = rows.map(row => `${row.icon} **${row.server}** · ${row.status}`).join('  \n');
	return { markdown: `**${title}**\n\n${body}`, rows };
}
