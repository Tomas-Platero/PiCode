/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Two pi tools that let the chat look back at the owner's earlier conversations.
 *
 * pi-intercom only reaches conversations that are running right now, and the memory only holds
 * what was saved on purpose: a conversation from yesterday, or one from before the editor was
 * closed, was out of reach ("what did I tell you my name was?"). These tools read the same list
 * the Sessions panel shows — the window's conversations — and the transcripts behind it, read
 * only: nothing here writes a transcript.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

import type { PiToolDefinition, PiToolResult } from './mcp';
import type { PiSessionFile, PiSessionTurn } from './sessions-provider';

/** Where the conversations come from, injectable so a test needs no disk. */
export interface ConversationSource {
	/** The conversations the Sessions panel lists for this window, newest first. */
	list(): readonly PiSessionFile[];
	/** The transcript of the conversation asking, so it is not mistaken for an earlier one. */
	current(): string | undefined;
	/** The turns of one transcript, the owner's words without the editor's frame; empty when unreadable. */
	turns(file: string): readonly PiSessionTurn[];
}

export const LIST_TOOL = 'past_conversations';
export const READ_TOOL = 'read_past_conversation';

/** How much of one conversation a single read returns; the rest is one more call away. */
export const READ_PAGE_CHARS = 24_000;
const DEFAULT_LIMIT = 20;
const SNIPPET_RADIUS = 80;

function day(mtime: number): string {
	return new Date(mtime).toISOString().slice(0, 16).replace('T', ' ');
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function rowOf(file: PiSessionFile, current: string | undefined): string {
	const mark = file.file === current ? ' (this conversation)' : '';
	return `- ${file.id} · ${day(file.mtime)} · ${oneLine(file.label).slice(0, 80)}${mark}`;
}

/** One conversation as text the model reads. */
export function conversationText(turns: readonly PiSessionTurn[]): string {
	return turns.map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`).join('\n\n');
}

/** The list, or with a query the conversations whose text holds it, with a snippet of each hit. */
export function listConversations(source: ConversationSource, query: string | undefined, limit = DEFAULT_LIMIT): string {
	const files = source.list();
	const current = source.current();
	const cap = Math.max(1, Math.min(Math.floor(limit), 100));
	const needle = query?.trim().toLowerCase();
	if (needle === undefined || needle.length === 0) {
		if (files.length === 0) {
			return 'There are no earlier conversations in this window.';
		}
		const rows = files.slice(0, cap).map(file => rowOf(file, current));
		const more = files.length > cap ? `\n(${files.length - cap} older not shown; pass a larger limit or a query)` : '';
		return `Conversations, newest first (id · last activity UTC · first message):\n${rows.join('\n')}${more}`;
	}
	const hits: string[] = [];
	for (const file of files) {
		if (hits.length >= cap) {
			break;
		}
		const text = conversationText(source.turns(file.file));
		const lower = text.toLowerCase();
		const snippets: string[] = [];
		let at = lower.indexOf(needle);
		while (at !== -1 && snippets.length < 2) {
			const start = Math.max(0, at - SNIPPET_RADIUS);
			snippets.push(`  …${oneLine(text.slice(start, at + needle.length + SNIPPET_RADIUS))}…`);
			at = lower.indexOf(needle, at + needle.length + SNIPPET_RADIUS);
		}
		if (snippets.length > 0) {
			hits.push(`${rowOf(file, current)}\n${snippets.join('\n')}`);
		}
	}
	return hits.length === 0
		? `No earlier conversation mentions "${query?.trim()}".`
		: `Conversations that mention "${query?.trim()}":\n${hits.join('\n')}`;
}

/** One conversation's text, a page at a time. `id` may be the short id the list shows. */
export function readConversation(source: ConversationSource, id: string, offset = 0): string {
	const wanted = id.trim().toLowerCase();
	const listed = source.list();
	const exact = listed.filter(file => file.id.toLowerCase() === wanted);
	const matches = wanted.length === 0 ? [] : exact.length > 0 ? exact : listed.filter(file => file.id.toLowerCase().startsWith(wanted));
	if (matches.length === 0) {
		throw new Error(`No conversation with id "${id}". Call ${LIST_TOOL} to see the ids.`);
	}
	if (matches.length > 1) {
		throw new Error(`"${id}" matches more than one conversation; give more of the id.`);
	}
	const file = matches[0];
	const text = conversationText(source.turns(file.file));
	const start = Math.max(0, Math.floor(offset));
	const page = text.slice(start, start + READ_PAGE_CHARS);
	const end = start + page.length;
	const header = `Conversation ${file.id} · ${day(file.mtime)} UTC${file.file === source.current() ? ' (this conversation)' : ''}`;
	const more = end < text.length ? `\n\n(${text.length - end} more characters; call again with offset ${end})` : '';
	return `${header}\n\n${page.length === 0 ? '(nothing to read here)' : page}${more}`;
}

function result(text: string): PiToolResult {
	return { content: [{ type: 'text', text }], details: undefined };
}

/** The two tools, as pi's `customTools` read them. */
export function pastConversationTools(source: ConversationSource): PiToolDefinition[] {
	const listDescription = 'List the user\'s earlier conversations in this workspace (also ones from before the editor was closed), or search their text. Use it when the user refers to something said in another or an earlier conversation.';
	const readDescription = `Read the messages of one earlier conversation, by the id ${LIST_TOOL} shows.`;
	return [
		{
			name: LIST_TOOL,
			label: 'Past conversations',
			description: listDescription,
			promptSnippet: `${LIST_TOOL}: ${listDescription}`,
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Words to search for in the conversations. Leave out to list the newest.' },
					limit: { type: 'number', description: `How many conversations to return (default ${DEFAULT_LIMIT}).` },
				},
			},
			execute: async (_id, params) => {
				const input = (params ?? {}) as { query?: unknown; limit?: unknown };
				return result(listConversations(
					source,
					typeof input.query === 'string' ? input.query : undefined,
					typeof input.limit === 'number' ? input.limit : DEFAULT_LIMIT,
				));
			},
		},
		{
			name: READ_TOOL,
			label: 'Read past conversation',
			description: readDescription,
			promptSnippet: `${READ_TOOL}: ${readDescription}`,
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: `The conversation id from ${LIST_TOOL}.` },
					offset: { type: 'number', description: 'Where to continue reading a long conversation.' },
				},
				required: ['id'],
			},
			execute: async (_id, params) => {
				const input = (params ?? {}) as { id?: unknown; offset?: unknown };
				return result(readConversation(
					source,
					typeof input.id === 'string' ? input.id : '',
					typeof input.offset === 'number' ? input.offset : 0,
				));
			},
		},
	];
}
