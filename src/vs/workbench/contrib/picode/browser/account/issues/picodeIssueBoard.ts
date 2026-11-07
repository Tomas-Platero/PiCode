/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the issues viewer shows: a whole Jira project (as a Kanban board or a list) or a whole
 * GitHub repository (as a list). Pure: no editor imports, so `node --test` runs it directly
 * (`extensions/picode/test/picode-issue-board.test.ts`).
 */

import { type IPicodeIssue, type IPicodeRepo, mapGithubIssues, mapJiraIssues, type PicodeIssueSource } from './picodeIssueSources.js';

/** The three groups every tracker's states fall into; Jira calls them To Do, In Progress and Done. */
export type PicodeStatusCategory = 'todo' | 'progress' | 'done';

export interface IPicodeBoardStatus {
	readonly name: string;
	readonly category: PicodeStatusCategory;
}

/** An issue with what a board or a list needs on top of what the Status column shows. */
export interface IPicodeBoardIssue extends IPicodeIssue {
	/** Jira: the workflow status. GitHub: `open` or `closed`. */
	readonly status: string;
	readonly category: PicodeStatusCategory;
	/** Jira's issue type (Bug, Task…); empty on GitHub. */
	readonly type: string;
	readonly priority: string;
	readonly assignee: string;
	readonly createdAt: string;
	readonly comments: number;
}

export type PicodeBoardLayout = 'kanban' | 'list';

export interface IPicodeProjectView {
	readonly source: PicodeIssueSource;
	/** `ATW` (Jira project key) or `owner/repo`. */
	readonly ref: string;
	readonly name: string;
	/** How a space of this type opens: software spaces as a board, the rest as a list. */
	readonly layout: PicodeBoardLayout;
	/** In workflow order, to-do first and done last. */
	readonly statuses: readonly IPicodeBoardStatus[];
	readonly issues: readonly IPicodeBoardIssue[];
	/** True when the tracker has more issues than were read. */
	readonly truncated: boolean;
}

export interface IPicodeBoardColumn {
	readonly status: IPicodeBoardStatus;
	readonly issues: readonly IPicodeBoardIssue[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;
const GITHUB_REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

export function isJiraProjectKey(ref: string): boolean {
	return JIRA_PROJECT_KEY.test(ref);
}

export function parseGithubRepoRef(ref: string): IPicodeRepo | undefined {
	const match = GITHUB_REPO.exec(ref);
	return match ? { owner: match[1], repo: match[2] } : undefined;
}

/** The project (Jira) or repository (GitHub) an issue belongs to, from its key: `ATW-12` → `ATW`, `o/r#3` → `o/r`. */
export function projectRefOf(issue: { readonly source: PicodeIssueSource; readonly key: string }): string | undefined {
	if (issue.source === 'jira') {
		const project = issue.key.split('-')[0];
		return isJiraProjectKey(project) ? project : undefined;
	}
	const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#\d+$/.exec(issue.key);
	return match ? match[1] : undefined;
}

const CATEGORY_RANK: Record<PicodeStatusCategory, number> = { todo: 0, progress: 1, done: 2 };

function categoryOf(key: unknown): PicodeStatusCategory {
	switch (key) {
		case 'new': return 'todo';
		case 'done': return 'done';
		default: return 'progress';
	}
}

/** Stable: statuses of one group keep the order the workflow gave them. */
function sortedByCategory(statuses: IPicodeBoardStatus[]): IPicodeBoardStatus[] {
	return statuses
		.map((status, index) => ({ status, index }))
		.sort((a, b) => CATEGORY_RANK[a.status.category] - CATEGORY_RANK[b.status.category] || a.index - b.index)
		.map(entry => entry.status);
}

/** `GET /project/{key}`: the project's name and how its space opens. */
export function mapJiraProject(json: unknown): { readonly name: string; readonly layout: PicodeBoardLayout } | undefined {
	const project = asRecord(json);
	const name = asString(project?.name);
	if (!project || !name) {
		return undefined;
	}
	return { name, layout: project.projectTypeKey === 'software' ? 'kanban' : 'list' };
}

/** `GET /project/{key}/statuses` (one entry per issue type) → every status once, to-do first and done last. */
export function mapJiraStatuses(json: unknown): IPicodeBoardStatus[] {
	if (!Array.isArray(json)) {
		return [];
	}
	const seen = new Set<string>();
	const statuses: IPicodeBoardStatus[] = [];
	for (const type of json) {
		const list = asRecord(type)?.statuses;
		for (const item of Array.isArray(list) ? list : []) {
			const status = asRecord(item);
			const name = asString(status?.name);
			if (name && !seen.has(name)) {
				seen.add(name);
				statuses.push({ name, category: categoryOf(asRecord(status?.statusCategory)?.key) });
			}
		}
	}
	return sortedByCategory(statuses);
}

/** `GET /search/jql` answer → issues with status, type, priority and assignee. */
export function mapJiraBoardIssues(json: unknown, siteUrl: string): IPicodeBoardIssue[] {
	const list = asRecord(json)?.issues;
	if (!Array.isArray(list)) {
		return [];
	}
	const issues: IPicodeBoardIssue[] = [];
	for (const item of list) {
		const base = mapJiraIssues({ issues: [item] }, siteUrl)[0];
		if (!base) {
			continue;
		}
		const fields = asRecord(asRecord(item)?.fields);
		const status = asRecord(fields?.status);
		issues.push({
			...base,
			status: asString(status?.name),
			category: categoryOf(asRecord(status?.statusCategory)?.key),
			type: asString(asRecord(fields?.issuetype)?.name),
			priority: asString(asRecord(fields?.priority)?.name),
			assignee: asString(asRecord(fields?.assignee)?.displayName),
			createdAt: asString(fields?.created),
			comments: 0,
		});
	}
	return issues;
}

/** The token for the next page of a Jira search, when there is one. */
export function nextJiraPageToken(json: unknown): string | undefined {
	const token = asRecord(json)?.nextPageToken;
	return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/** A GitHub issue list (open and closed together) → issues. Pull requests are dropped. */
export function mapGithubBoardIssues(json: unknown, repo: IPicodeRepo): IPicodeBoardIssue[] {
	if (!Array.isArray(json)) {
		return [];
	}
	const issues: IPicodeBoardIssue[] = [];
	for (const item of json) {
		const base = mapGithubIssues([item], repo)[0];
		if (!base) {
			continue;
		}
		const raw = asRecord(item);
		const closed = raw?.state === 'closed';
		issues.push({
			...base,
			status: closed ? 'closed' : 'open',
			category: closed ? 'done' : 'todo',
			type: '',
			priority: '',
			assignee: asString(asRecord(raw?.assignee)?.login),
			createdAt: asString(raw?.created_at),
			comments: typeof raw?.comments === 'number' ? raw.comments : 0,
		});
	}
	return issues;
}

/** The two states a GitHub issue has, in the order a board would show them. */
export const GITHUB_STATUSES: readonly IPicodeBoardStatus[] = [
	{ name: 'open', category: 'todo' },
	{ name: 'closed', category: 'done' },
];

/**
 * The board's columns: the project's statuses in workflow order (empty ones too, as in Jira),
 * plus any status an issue has that the project no longer lists.
 */
export function buildColumns(statuses: readonly IPicodeBoardStatus[], issues: readonly IPicodeBoardIssue[]): IPicodeBoardColumn[] {
	const known = new Map<string, IPicodeBoardStatus>(statuses.map(status => [status.name, status]));
	const extra: IPicodeBoardStatus[] = [];
	for (const issue of issues) {
		if (!known.has(issue.status)) {
			const status = { name: issue.status, category: issue.category };
			known.set(issue.status, status);
			extra.push(status);
		}
	}
	return sortedByCategory([...statuses, ...extra]).map(status => ({ status, issues: issues.filter(issue => issue.status === status.name) }));
}

/** The issues that mention `query` (key, title, status, assignee, type or a label), any case. */
export function filterIssues(issues: readonly IPicodeBoardIssue[], query: string): IPicodeBoardIssue[] {
	const words = query.toLowerCase().split(/\s+/).filter(word => word.length > 0);
	if (words.length === 0) {
		return [...issues];
	}
	return issues.filter(issue => {
		const haystack = [issue.key, issue.title, issue.status, issue.assignee, issue.type, ...issue.labels].join(' ').toLowerCase();
		return words.every(word => haystack.includes(word));
	});
}

/** The initials on an assignee's avatar: `Tomás Platero Ortega` → `TP`. */
export function initialsOf(name: string): string {
	const parts = name.trim().split(/\s+/).filter(part => part.length > 0);
	if (parts.length === 0) {
		return '';
	}
	return (parts[0][0] + (parts.length > 1 ? parts[1][0] : '')).toUpperCase();
}

/**
 * `GET /issue/{key}/transitions` → the id of the transition that ends in `targetStatus`, or
 * `undefined` when the project's workflow does not allow going there from where the issue is.
 */
export function pickTransition(json: unknown, targetStatus: string): string | undefined {
	const list = asRecord(json)?.transitions;
	if (!Array.isArray(list)) {
		return undefined;
	}
	for (const item of list) {
		const transition = asRecord(item);
		const id = asString(transition?.id);
		if (/^\d+$/.test(id) && asString(asRecord(transition?.to)?.name) === targetStatus) {
			return id;
		}
	}
	return undefined;
}
