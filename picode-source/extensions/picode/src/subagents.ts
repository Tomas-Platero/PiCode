/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Gentle subagents, read from the outside.
 *
 * Gentle AI launches subagents as pi tools (`agent_<name>`, `subagent_<name>`) and writes
 * what they are doing to files under the agent home: live activity per parent session
 * (`gentle-agents/presence/`) and a finished record per task (`gentle-agents/tasks/`).
 * The chat can only show what it can read, and this module is the reading half — the shapes
 * are gentle-pi's own (`lib/orchestrator-presence.ts`, the task store), mirrored here as
 * tolerant parsers: a file that is missing, mid-write or from a different schema is "no
 * reading", never an error. The transcript renderer turns a subagent's pi session file into
 * markdown the chat's untitled documents can show.
 *
 * No `vscode` import, and every filesystem touch is injectable — the same rule
 * `usage-data.ts` keeps, so `node --test` can run this file directly.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

/* ------------------------------------------------------------------ *
 * Where gentle writes
 * ------------------------------------------------------------------ */

/**
 * The agent home base: pi's global directory, wherever the env puts it.
 *
 * Mirrors gentle-pi's own resolver (`lib/agent-home.ts`): an env override wins, and an
 * **empty** override falls through, because pi resolves its global directory the same way
 * and two spellings of "empty" must not split the home in two.
 */
function agentHomeBase(env: NodeJS.ProcessEnv = process.env): string {
	return env['GENTLE_PI_AGENT_HOME'] || env['PI_CODING_AGENT_DIR'] || path.join(homedir(), '.pi', 'agent');
}

/** The gentle-agents directory of the agent home in force. */
export function gentleAgentsHome(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(agentHomeBase(env), 'gentle-agents');
}

/** The live-activity directory: one pair of files per (session, incarnation). */
function presenceRoot(home?: string): string {
	return path.join(home ?? agentHomeBase(), 'gentle-agents', 'presence');
}

/** The finished-task directory: one json record per task id. */
function tasksRoot(home?: string): string {
	return path.join(home ?? agentHomeBase(), 'gentle-agents', 'tasks');
}

/** The presence file names are keyed by sha256(sessionId), hex — never the raw session id. */
export function sessionHash(sessionId: string): string {
	return createHash('sha256').update(sessionId).digest('hex');
}

/** The activity file of one session incarnation. */
export function presenceActivityPath(sessionId: string, home: string, incarnation: string): string {
	return path.join(presenceRoot(home), `${sessionHash(sessionId)}.${incarnation}.activity.json`);
}

/* ------------------------------------------------------------------ *
 * The shapes gentle writes, read tolerantly
 * ------------------------------------------------------------------ */

/** A presence task's summary, as far as this reader trusts it. */
export interface PresenceTaskSummary {
	readonly id?: unknown;
	readonly agent?: unknown;
	readonly label?: unknown;
	readonly status?: unknown;
}

/** One thread item: a tool with its output, or a text/thinking/note line. */
export interface PresenceThreadItem {
	readonly kind?: unknown;
	readonly name?: unknown;
	readonly output?: unknown;
	readonly running?: unknown;
	readonly isError?: unknown;
	readonly text?: unknown;
}

/** One task in a presence activity: summary plus the last thread items. */
export interface PresenceTask {
	readonly summary?: PresenceTaskSummary;
	readonly thread?: { readonly items?: unknown };
}

/** The `activity` object of an activity file. */
export interface PresenceActivity {
	readonly tasks?: unknown;
}

/** One reading, with the incarnation it came from so a poller can pin the next read. */
export interface PresenceReading {
	readonly activity: PresenceActivity;
	readonly incarnation: string;
}

/** One directory entry as the scanners see it. */
export interface DirEntry {
	readonly name: string;
	readonly mtimeMs: number;
}

/** A file's parsed JSON, or a throw — the injectable seam for tests. */
export type ReadJson = (file: string) => unknown;

/** A directory's entries, or a throw — the injectable seam for tests. */
export type ListDir = (dir: string) => readonly DirEntry[];

/**
 * The default reader, which throws by contract: every caller wraps the read and turns any
 * throw into "no reading". The explicit rethrow keeps that contract in one visible place.
 */
const defaultReadJson: ReadJson = file => {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (error) {
		throw error instanceof Error ? error : new Error(String(error));
	}
};

const defaultListDir: ListDir = dir => fs.readdirSync(dir, { withFileTypes: true })
	.filter(entry => entry.isFile())
	.map(entry => ({ name: entry.name, mtimeMs: fs.statSync(path.join(dir, entry.name)).mtimeMs }));


/** An object from an unknown value, or `undefined` when it is not one. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

/** A non-empty string from an unknown value, or `undefined`. */
function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The incarnations of one session's presence, oldest first.
 *
 * The incarnation is part of the file name, not of the directory: a parent session that
 * rebuilt itself writes under a new one, and the reader picks the newest it can find.
 */
export function presenceIncarnations(sessionId: string, home?: string, listDir: ListDir = defaultListDir): string[] {
	const hash = sessionHash(sessionId);
	const prefix = `${hash}.`;
	let entries: readonly DirEntry[];
	try {
		entries = listDir(presenceRoot(home));
	} catch {
		// No presence directory is "gentle is not there", not an error.
		return [];
	}
	const found: { incarnation: string; mtimeMs: number }[] = [];
	for (const entry of entries) {
		if (!entry.name.startsWith(prefix) || !entry.name.endsWith('.activity.json')) {
			continue;
		}
		const incarnation = entry.name.slice(prefix.length, -'.activity.json'.length);
		if (incarnation.length > 0) {
			found.push({ incarnation, mtimeMs: entry.mtimeMs });
		}
	}
	found.sort((a, b) => a.mtimeMs - b.mtimeMs);
	return found.map(entry => entry.incarnation);
}

/**
 * One live-activity reading, or `undefined`.
 *
 * With an `incarnation` this is a single file read — what the poller pays per tick. Without
 * one it scans the directory once and takes the newest file; a read that fails or parses
 * wrong is "no reading", so a half-written file is simply skipped until the next tick.
 */
export function readPresenceActivity(
	sessionId: string,
	home?: string,
	readJson: ReadJson = defaultReadJson,
	incarnation?: string,
	listDir: ListDir = defaultListDir,
): PresenceReading | undefined {
	const root = presenceRoot(home);
	let chosen = incarnation;
	if (chosen === undefined) {
		const found = presenceIncarnations(sessionId, home, listDir);
		if (found.length === 0) {
			return undefined;
		}
		chosen = found[found.length - 1]!;
	}
	let parsed: unknown;
	try {
		parsed = readJson(path.join(root, `${sessionHash(sessionId)}.${chosen}.activity.json`));
	} catch {
		return undefined;
	}
	const activity = recordOf(recordOf(parsed)?.['activity']);
	return activity === undefined ? undefined : { activity, incarnation: chosen };
}

/* ------------------------------------------------------------------ *
 * Live lines
 * ------------------------------------------------------------------ */

/** The longest a detail segment gets; these lines sit under a spinner, they are not a log. */
const DETAIL_CHARS = 60;

/** The statuses that mean "nothing more will happen" (gentle's own set, minus none). */
const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out']);

/** The first line of a text, control characters stripped. */
function firstLine(value: string): string {
	const line = value.split('\n', 1)[0]?.replace(/[\p{Cc}]/gu, '').trim() ?? '';
	return line.length > DETAIL_CHARS ? `${line.slice(0, DETAIL_CHARS - 1)}…` : line;
}

/** The one thing a thread item contributes to a line, or `undefined` when it says nothing. */
function itemDetail(item: PresenceThreadItem | undefined): string | undefined {
	if (item === undefined) {
		return undefined;
	}
	if (item.kind === 'tool') {
		const name = text(item.name);
		const output = text(item.output);
		if (name === undefined && output === undefined) {
			return undefined;
		}
		return [name, output === undefined ? undefined : firstLine(output)].filter(Boolean).join(' ');
	}
	const body = text(item.text);
	return body === undefined ? undefined : firstLine(body);
}

/**
 * Short per-subagent lines for the chat's progress line: `agent · latest · status`.
 *
 * The middle segment is the newest thread item (a running tool's name and first output
 * line, or the last text); the last segment appears when the task is finished or its last
 * item errored — a running task needs no "running" label, the spinner already says it. Capped
 * at `maxLines`; presence lists tasks oldest first, so the cap keeps the most recent.
 */
export function activityLines(activity: PresenceActivity, maxLines = 8): string[] {
	const tasks = Array.isArray(activity.tasks) ? activity.tasks : [];
	const lines: string[] = [];
	for (const value of tasks) {
		if (lines.length >= maxLines) {
			break;
		}
		const task = recordOf(value);
		const summary = recordOf(task?.['summary']);
		const agent = text(summary?.['agent']) ?? text(summary?.['id']) ?? 'subagent';
		const thread = recordOf(task?.['thread']);
		const items = Array.isArray(thread?.['items']) ? thread?.['items'] as unknown[] : [];
		const last = recordOf(items[items.length - 1]);
		const detail = itemDetail(last === undefined ? undefined : {
			kind: last['kind'],
			name: last['name'],
			output: last['output'],
			running: last['running'],
			isError: last['isError'],
			text: last['text'],
		});
		const errored = last?.['kind'] === 'tool' && last?.['isError'] === true;
		const status = text(summary?.['status']);
		const tail = errored ? 'error'
			: status !== undefined && status !== 'running' ? status
			: detail === undefined ? 'running'
			: undefined;
		const line = [agent, detail, tail].filter(Boolean).join(' · ');
		lines.push(line);
	}
	return lines;
}

/** Whether a presence status means the task will not change again. */
export function isFinishedStatus(status: unknown): boolean {
	return typeof status === 'string' && FINISHED_STATUSES.has(status);
}

/* ------------------------------------------------------------------ *
 * Finished tasks
 * ------------------------------------------------------------------ */

/** What a quick pick needs from a finished task's record. */
export interface TaskRecordSummary {
	readonly agent?: string;
	readonly label?: string;
	readonly status?: string;
	readonly endedAt?: number;
}

/**
 * A task id is used as a file name below; only the shape gentle generates is accepted.
 *
 * `../presence/x` would read somewhere else entirely, and that is never what "open the
 * transcript of this task" means.
 */
function isSafeTaskId(taskId: string): boolean {
	return taskId.length > 0 && !/[/\\]/.test(taskId) && taskId !== '.' && taskId !== '..';
}

function readTaskFile(file: string, readJson: ReadJson): { task?: Record<string, unknown> } | undefined {
	try {
		const parsed = recordOf(readJson(file));
		return parsed === undefined ? undefined : { task: recordOf(parsed['task']) };
	} catch {
		return undefined;
	}
}

/**
 * The pi session file a finished task recorded, or `undefined`.
 *
 * This is the transcript's source: gentle writes `task.sessionPath` when the task ends, and
 * everything the chat shows is rendered from that file — the task record itself is never
 * trusted for content.
 */
export function readTaskTranscriptPath(taskId: string, home?: string, readJson: ReadJson = defaultReadJson): string | undefined {
	if (!isSafeTaskId(taskId)) {
		return undefined;
	}
	const task = readTaskFile(path.join(tasksRoot(home), `${taskId}.json`), readJson)?.task;
	const sessionPath = text(task?.['sessionPath']);
	return sessionPath;
}

/** The quick-pick fields of a finished task, or `undefined` when the record cannot be read. */
export function readTaskRecord(file: string, readJson: ReadJson = defaultReadJson): TaskRecordSummary | undefined {
	const task = readTaskFile(file, readJson)?.task;
	if (task === undefined) {
		return undefined;
	}
	const endedAt = typeof task['endedAt'] === 'number' && Number.isFinite(task['endedAt']) ? task['endedAt'] : undefined;
	return {
		agent: text(task['agent']),
		label: text(task['label']),
		status: text(task['status']),
		...(endedAt === undefined ? {} : { endedAt }),
	};
}

/** The finished-task files of the home, newest first. */
export function listTaskFiles(home: string, listDir: ListDir = defaultListDir): { readonly file: string; readonly mtimeMs: number }[] {
	let entries: readonly DirEntry[];
	try {
		entries = listDir(tasksRoot(home));
	} catch {
		return [];
	}
	return entries
		.filter(entry => entry.name.endsWith('.json'))
		.map(entry => ({ file: path.join(tasksRoot(home), entry.name), mtimeMs: entry.mtimeMs }))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/* ------------------------------------------------------------------ *
 * Relative time
 * ------------------------------------------------------------------ */

/**
 * A short English delta for the quick pick: `just now`, `5m ago`, `3h ago`, `2d ago`, and a
 * date once the days stop meaning anything.
 */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
	if (seconds < 60) {
		return 'just now';
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	const days = Math.round(hours / 24);
	if (days < 60) {
		return `${days}d ago`;
	}
	const date = new Date(timestamp);
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/* ------------------------------------------------------------------ *
 * The transcript, as markdown
 * ------------------------------------------------------------------ */

/** The longest a tool call's arguments get in the transcript; it is a pointer, not a copy. */
const TOOL_ARGUMENT_CHARS = 120;

/** One content part of a pi message, read tolerantly. */
interface SessionContent {
	readonly type?: unknown;
	readonly text?: unknown;
	readonly thinking?: unknown;
	readonly name?: unknown;
	readonly arguments?: unknown;
}

/** How tool results render: one line each, or in full when the reader asked. */
export interface SessionMarkdownOptions {
	readonly title?: string;
	readonly expandTools?: boolean;
}

/** The text parts of a message's content, as one string. */
function contentText(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	return content
		.map(part => {
			const record = recordOf(part);
			return record === undefined ? '' : text(record['text']) ?? '';
		})
		.filter(part => part.length > 0)
		.join('\n');
}

/** One markdown line for a tool call, arguments kept to a pointer. */
function toolCallLine(call: SessionContent): string | undefined {
	const name = text(call.name);
	if (name === undefined) {
		return undefined;
	}
	let argumentsText = '';
	if (call.arguments !== undefined && call.arguments !== null) {
		try {
			argumentsText = JSON.stringify(call.arguments);
		} catch {
			argumentsText = String(call.arguments);
		}
	}
	const shown = argumentsText.length > TOOL_ARGUMENT_CHARS
		? `${argumentsText.slice(0, TOOL_ARGUMENT_CHARS - 1)}…`
		: argumentsText;
	return `- Tool call: \`${name}\`${shown.length > 0 ? ` ${shown}` : ''}`;
}

/**
 * A subagent's pi session file as compact markdown.
 *
 * The chat opens this in an untitled document, so the shape is a document, not a chat
 * transcript: `## role` headers, tool calls as a list line, and tool results collapsed to
 * their first line unless `expandTools` asks for the whole output. Everything the parser
 * does not recognise — metadata entries, custom messages, a torn last line — is skipped:
 * a transcript that fails to render half its entries is worse than one that renders the
 * half it understood.
 */
export function sessionToMarkdown(jsonlText: string, options: SessionMarkdownOptions = {}): string {
	const out: string[] = [`# ${options.title ?? 'Subagent transcript'}`];
	for (const line of jsonlText.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		const entry = recordOf(parsed);
		if (entry?.['type'] !== 'message') {
			continue;
		}
		const message = recordOf(entry['message']);
		const role = text(message?.['role']);
		if (role === undefined || role === 'system') {
			continue;
		}
		if (role === 'toolResult') {
			const body = contentText(message?.['content']);
			if (body.length === 0) {
				continue;
			}
			const tool = text(message?.['toolName']) ?? 'tool';
			const errored = message?.['isError'] === true;
			out.push('', `### Tool result — ${tool}${errored ? ' (error)' : ''}`, options.expandTools ? body : firstLine(body) || body);
			continue;
		}
		const parts = Array.isArray(message?.['content']) ? message?.['content'] as unknown[] : [];
		const body: string[] = [];
		for (const value of parts) {
			const part: SessionContent = recordOf(value) ?? {};
			if (part.type === 'text') {
				const paragraph = text(part.text);
				if (paragraph !== undefined) {
					body.push(paragraph);
				}
				continue;
			}
			if (part.type === 'toolCall') {
				const line = toolCallLine(part);
				if (line !== undefined) {
					body.push(line);
				}
			}
			// `thinking` is deliberately left out: the transcript is for reading what was done.
		}
		if (body.length === 0) {
			continue;
		}
		out.push('', `## ${role === 'user' ? 'User' : role === 'assistant' ? 'Assistant' : role}`, body.join('\n'));
	}
	return `${out.join('\n')}\n`;
}
