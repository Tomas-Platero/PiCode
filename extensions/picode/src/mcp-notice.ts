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
 * No `vscode` import, so `node --test` runs this file directly: the one local import carries its
 * extension (`./l10n.ts`), which is what Node resolves and what the emit turns back into
 * `./l10n.js`.
 */

import { l10n } from './l10n.ts';

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
	/** The same servers in the same state give the same key, so the chat can say it once. */
	readonly key: string;
}

/** The status of one server line, in the words the chat uses. */
export function mcpNoticeRow(server: string, raw: string): McpNoticeRow {
	if (/sign[\s-]?in|log[\s-]?in|auth|unauthori[sz]ed|\b401\b/i.test(raw)) {
		return { server, icon: '🔑', status: l10n.t('Sign-in needed'), needsSignIn: true };
	}
	if (/timed?\s*out|timeout/i.test(raw)) {
		return { server, icon: '⏱️', status: l10n.t('Not responding'), needsSignIn: false };
	}
	if (/fail|error|enoent|spawn|exit/i.test(raw)) {
		return { server, icon: '❌', status: l10n.t('Could not start'), needsSignIn: false };
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
	const title = rows.length === 1 ? l10n.t('An MCP server needs attention') : l10n.t('{0} MCP servers need attention', rows.length);
	// Hard line breaks keep the rows tight; a list would add a bullet beside every icon.
	const body = rows.map(row => `${row.icon} **${row.server}** · ${row.status}`).join('  \n');
	const key = rows.map(row => `${row.server}=${row.status}`).sort().join('|');
	return { markdown: `**${title}**\n\n${body}`, rows, key };
}

/** A `command:` link with its arguments, the way trusted chat markdown runs a command. */
function commandLink(label: string, command: string, args?: readonly unknown[]): string {
	const query = args === undefined ? '' : `?${encodeURIComponent(JSON.stringify(args))}`;
	return `[${label}](command:${command}${query})`;
}

/**
 * The notice as one quiet line of the chat: each server with its fix as a link beside it, and the
 * MCP page last — rather than a warning card above a stack of full-width buttons, which read as an
 * error in the middle of the answer for what is, most of the time, a sign-in waiting.
 */
export function mcpNoticeLine(notice: McpNotice, signInCommand: string, manageCommand: string): string {
	const parts = notice.rows.map(row => row.needsSignIn
		? `${row.icon} **${row.server}** ${commandLink(l10n.t('Sign in'), signInCommand, [row.server])}`
		: `${row.icon} **${row.server}** · ${row.status}`);
	parts.push(commandLink(l10n.t('Manage MCPs'), manageCommand));
	return parts.join(' · ');
}
