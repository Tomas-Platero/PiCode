/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The session's task list, as the Status view shows it.
 *
 * The source of truth is gentle-pi's `todo` tool: every result it produces carries the **full**
 * snapshot of the list in `details.gentleTodo` (verified against gentle-pi's own code —
 * `lib/shell-todo.ts` `TODO_DETAILS_KEY`/`TODO_TOOL_NAME`), so the Status view needs no replay
 * math: the last `todo` result in entry order is the current list. An entry that is not that,
 * or a snapshot that says nothing, is no list at all.
 */

/** One task as the view draws it. */
export interface TaskRow {
	readonly title: string;
	readonly status: 'pending' | 'in_progress' | 'done';
	readonly note?: string;
}

const TODO_TOOL_NAME = 'todo';
const TODO_DETAILS_KEY = 'gentleTodo';
const STATUSES = ['pending', 'in_progress', 'done'] as const;

/** A JSON object from an unknown value, or `undefined` when it is not one. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

/** One task of a snapshot, kept only when it says something readable. */
function taskRow(value: unknown): TaskRow | undefined {
	const record = recordOf(value);
	const title = record?.['title'];
	if (typeof title !== 'string' || title.trim().length === 0) {
		return undefined;
	}
	const status = STATUSES.includes(record?.['status'] as (typeof STATUSES)[number])
		? record?.['status'] as TaskRow['status']
		: 'pending';
	const note = record?.['note'];
	return {
		title,
		status,
		...(typeof note === 'string' && note.length > 0 ? { note } : {}),
	};
}

/**
 * The session's task list: the last `todo` tool result's snapshot, in file order.
 *
 * `undefined` when the session has none — the view omits the block instead of inventing one.
 * In-progress tasks lead (the work happening now), preserving snapshot order otherwise.
 */
export function extractTasks(entries: readonly unknown[]): TaskRow[] | undefined {
	let last: unknown = undefined;
	for (const entry of entries) {
		const record = recordOf(entry);
		if (record?.['type'] !== 'message') {
			continue;
		}
		const message = recordOf(record['message']);
		if (message?.['role'] !== 'toolResult' || message['toolName'] !== TODO_TOOL_NAME) {
			continue;
		}
		const details = recordOf(message['details']);
		const state = recordOf(details?.[TODO_DETAILS_KEY]);
		if (state !== undefined) {
			last = state['tasks'];
		}
	}
	if (!Array.isArray(last)) {
		return undefined;
	}
	const rows = last.map(taskRow).filter((row): row is TaskRow => row !== undefined);
	if (rows.length === 0) {
		return undefined;
	}
	return [
		...rows.filter(row => row.status === 'in_progress'),
		...rows.filter(row => row.status !== 'in_progress'),
	];
}
