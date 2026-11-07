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

/** A status, or a column of a board that holds one or several statuses. */
export interface IPicodeBoardStatus {
	readonly name: string;
	readonly category: PicodeStatusCategory;
	/** Jira: the ids of the statuses this column holds. Empty for GitHub. */
	readonly ids?: readonly string[];
}

/** An issue with what a board or a list needs on top of what the Status column shows. */
export interface IPicodeBoardIssue extends IPicodeIssue {
	/** Jira: the workflow status. GitHub: `open` or `closed`. */
	readonly status: string;
	/** Jira: the status's id, which tells the board which column the issue is in. */
	readonly statusId: string;
	readonly category: PicodeStatusCategory;
	/** Jira's issue type (Bug, Task…); empty on GitHub. */
	readonly type: string;
	readonly priority: string;
	readonly assignee: string;
	/** Jira: the ids behind the names above, which is what an edit sends back. */
	readonly typeId: string;
	readonly priorityId: string;
	readonly assigneeId: string;
	readonly reporterId: string;
	/** The description as it is edited: Jira's when it is plain text (see `descriptionEditable`), GitHub's Markdown. */
	readonly description: string;
	/** False for a Jira description with formatting (lists, links, code…) that plain text would flatten. */
	readonly descriptionEditable: boolean;
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
	/** Where `statuses` come from: the project's board (the columns as Jira shows them), or its statuses because the board could not be read. */
	readonly columns: 'board' | 'needsPermission' | 'statuses';
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

/**
 * `GET /project/{key}/statuses` (one entry per issue type) → every status once. Used when the
 * project has no board to read the columns from: to-do first and done last, and inside a group
 * in the order the statuses were created (Jira lists them in no useful order).
 */
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
				const id = asString(status?.id);
				statuses.push({ name, category: categoryOf(asRecord(status?.statusCategory)?.key), ids: id ? [id] : [] });
			}
		}
	}
	const created = (status: IPicodeBoardStatus): number => Number(status.ids?.[0]) || 0;
	return sortedByCategory(statuses.sort((a, b) => created(a) - created(b)));
}

/** `GET /board?projectKeyOrId=…` → the id of the project's board, when it has one. */
export function pickJiraBoardId(json: unknown): number | undefined {
	const boards = asRecord(json)?.values;
	const id = Array.isArray(boards) ? asRecord(boards[0])?.id : undefined;
	return typeof id === 'number' ? id : undefined;
}

/**
 * `GET /board/{id}/configuration` → the board's columns, in the order Jira shows them. A column
 * that holds no status (a kanban backlog) is left out. The first column counts as to-do, the last
 * as done and the ones between as in progress: a project's own status categories are often not
 * set up that way.
 */
export function mapJiraBoardColumns(json: unknown): IPicodeBoardStatus[] {
	const columns = asRecord(asRecord(json)?.columnConfig)?.columns;
	if (!Array.isArray(columns)) {
		return [];
	}
	const found: { name: string; ids: string[] }[] = [];
	for (const item of columns) {
		const column = asRecord(item);
		const name = asString(column?.name);
		const statuses = Array.isArray(column?.statuses) ? column.statuses : [];
		const ids = statuses.map(status => asString(asRecord(status)?.id)).filter(id => id.length > 0);
		if (name && ids.length > 0) {
			found.push({ name, ids });
		}
	}
	return found.map((column, index) => ({
		...column,
		category: index === 0 ? 'todo' : index === found.length - 1 ? 'done' : 'progress',
	}));
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
			statusId: asString(status?.id),
			category: categoryOf(asRecord(status?.statusCategory)?.key),
			type: asString(asRecord(fields?.issuetype)?.name),
			typeId: asString(asRecord(fields?.issuetype)?.id),
			priority: asString(asRecord(fields?.priority)?.name),
			priorityId: asString(asRecord(fields?.priority)?.id),
			assignee: asString(asRecord(fields?.assignee)?.displayName),
			assigneeId: asString(asRecord(fields?.assignee)?.accountId),
			reporterId: asString(asRecord(fields?.reporter)?.accountId),
			description: isPlainAdf(fields?.description) ? adfToEditableText(fields?.description) : '',
			descriptionEditable: isPlainAdf(fields?.description),
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
			statusId: '',
			category: closed ? 'done' : 'todo',
			type: '',
			typeId: '',
			priority: '',
			priorityId: '',
			assignee: asString(asRecord(raw?.assignee)?.login),
			assigneeId: '',
			reporterId: '',
			description: base.body,
			descriptionEditable: true,
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
 * The board's columns, in the order they were given (a board's own order is kept, empty columns
 * too, as in Jira). An issue is in the column that holds its status; a status no column holds
 * gets a column of its own at the end.
 */
export function buildColumns(statuses: readonly IPicodeBoardStatus[], issues: readonly IPicodeBoardIssue[]): IPicodeBoardColumn[] {
	const holds = (status: IPicodeBoardStatus, issue: IPicodeBoardIssue): boolean =>
		(issue.statusId !== '' && (status.ids?.includes(issue.statusId) ?? false)) || (!status.ids?.length && issue.status === status.name);
	const columns = [...statuses];
	for (const issue of issues) {
		if (!columns.some(status => holds(status, issue))) {
			columns.push({ name: issue.status, category: issue.category, ids: issue.statusId ? [issue.statusId] : [] });
		}
	}
	return columns.map(status => ({ status, issues: issues.filter(issue => holds(status, issue)) }));
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
 * `GET /issue/{key}/transitions` → the id of the transition that ends in the target column (by the
 * ids of its statuses, or by the status name when the target has none), or `undefined` when the
 * project's workflow does not allow going there from where the issue is.
 */
export function pickTransition(json: unknown, target: { readonly name: string; readonly ids?: readonly string[] }): string | undefined {
	const list = asRecord(json)?.transitions;
	if (!Array.isArray(list)) {
		return undefined;
	}
	for (const item of list) {
		const transition = asRecord(item);
		const id = asString(transition?.id);
		const to = asRecord(transition?.to);
		const ends = target.ids?.length ? target.ids.includes(asString(to?.id)) : asString(to?.name) === target.name;
		if (/^\d+$/.test(id) && ends) {
			return id;
		}
	}
	return undefined;
}

/** Something with an id and a name: an issue type, a priority or a person. */
export interface IPicodeNamed {
	readonly id: string;
	readonly name: string;
}

/** `[{ id, name }]` (the priorities of `GET /priority`) → the entries that have both. */
export function mapNamedList(json: unknown): IPicodeNamed[] {
	if (!Array.isArray(json)) {
		return [];
	}
	const list: IPicodeNamed[] = [];
	for (const item of json) {
		const id = asString(asRecord(item)?.id);
		const name = asString(asRecord(item)?.name);
		if (id && name) {
			list.push({ id, name });
		}
	}
	return list;
}

/** `GET /issue/{key}/editmeta` → the issue types the issue may be changed to, when Jira says. */
export function mapEditMetaTypes(json: unknown): IPicodeNamed[] {
	return mapNamedList(asRecord(asRecord(asRecord(json)?.fields)?.issuetype)?.allowedValues);
}

/** `GET /project/{key}` → the project's issue types, without sub-tasks (an issue is not turned into one by an edit). */
export function mapProjectIssueTypes(json: unknown): IPicodeNamed[] {
	const types = asRecord(json)?.issueTypes;
	return mapNamedList(Array.isArray(types) ? types.filter(type => asRecord(type)?.subtask !== true) : []);
}

/**
 * The people an issue can be given to, as far as the issues already read show them: whoever is
 * the assignee or the reporter of one. Finding anyone else would need a permission to read users.
 */
export function peopleOf(issues: readonly IPicodeBoardIssue[]): IPicodeNamed[] {
	const people = new Map<string, string>();
	for (const issue of issues) {
		if (issue.assigneeId && issue.assignee) {
			people.set(issue.assigneeId, issue.assignee);
		}
		if (issue.reporterId && issue.author) {
			people.set(issue.reporterId, issue.author);
		}
	}
	return [...people].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** What an edit of a Jira issue changes (the description is plain text here and becomes Jira's own format when saved). `assigneeId: null` leaves the issue unassigned. */
export interface IPicodeJiraPatch {
	readonly summary?: string;
	readonly description?: string;
	readonly typeId?: string;
	readonly priorityId?: string;
	readonly assigneeId?: string | null;
	readonly reporterId?: string;
	readonly labels?: readonly string[];
}

/** Jira labels cannot hold spaces: they become dashes. Empty ones go, repeated ones are kept once. */
export function normalizeLabels(labels: readonly string[]): string[] {
	const seen = new Set<string>();
	for (const label of labels) {
		const clean = label.trim().replace(/\s+/g, '-');
		if (clean.length > 0 && clean.length <= 255) {
			seen.add(clean);
		}
	}
	return [...seen];
}

const NUMERIC_ID = /^\d+$/;
const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;

/** The body of `PUT /issue/{key}` for a patch; anything that is not a well-formed value is left out. */
export function buildJiraUpdate(patch: IPicodeJiraPatch): { readonly fields: Record<string, unknown> } | undefined {
	const fields: Record<string, unknown> = {};
	const summary = patch.summary?.trim();
	if (summary && summary.length <= 255) {
		fields.summary = summary;
	}
	if (patch.description !== undefined) {
		fields.description = patch.description.trim() ? textToAdf(patch.description) : null;
	}
	if (patch.typeId && NUMERIC_ID.test(patch.typeId)) {
		fields.issuetype = { id: patch.typeId };
	}
	if (patch.priorityId && NUMERIC_ID.test(patch.priorityId)) {
		fields.priority = { id: patch.priorityId };
	}
	if (patch.assigneeId === null) {
		fields.assignee = { accountId: null };
	} else if (patch.assigneeId && ACCOUNT_ID.test(patch.assigneeId)) {
		fields.assignee = { accountId: patch.assigneeId };
	}
	if (patch.reporterId && ACCOUNT_ID.test(patch.reporterId)) {
		fields.reporter = { accountId: patch.reporterId };
	}
	if (patch.labels) {
		fields.labels = normalizeLabels(patch.labels);
	}
	return Object.keys(fields).length > 0 ? { fields } : undefined;
}

/**
 * Whether a Jira description is only paragraphs of unformatted text (and line breaks). Anything
 * else (lists, links, code, images, mentions) would be flattened by saving it as plain text, so
 * such a description is not edited here.
 */
export function isPlainAdf(doc: unknown): boolean {
	if (doc === null || doc === undefined) {
		return true;
	}
	const root = asRecord(doc);
	if (root?.type !== 'doc' || !Array.isArray(root.content)) {
		return false;
	}
	return root.content.every(node => {
		const paragraph = asRecord(node);
		if (paragraph?.type !== 'paragraph') {
			return false;
		}
		const children: unknown = paragraph.content === undefined ? [] : paragraph.content;
		return Array.isArray(children) && children.every(child => {
			const item = asRecord(child);
			return item?.type === 'hardBreak' || (item?.type === 'text' && typeof item.text === 'string' && item.marks === undefined);
		});
	});
}

/** A plain description as text: paragraphs apart by a blank line, line breaks as new lines. */
export function adfToEditableText(doc: unknown): string {
	const content = asRecord(doc)?.content;
	if (!Array.isArray(content)) {
		return '';
	}
	return content.map(node => {
		const children = asRecord(node)?.content;
		return Array.isArray(children) ? children.map(child => asRecord(child)?.type === 'hardBreak' ? '\n' : asString(asRecord(child)?.text)).join('') : '';
	}).join('\n\n').trim();
}

/** The other way round: the text of `adfToEditableText` as Jira's document format. */
export function textToAdf(text: string): { readonly type: 'doc'; readonly version: 1; readonly content: readonly unknown[] } {
	const paragraphs = text.replace(/\r\n?/g, '\n').trim().split(/\n{2,}/).filter(paragraph => paragraph.length > 0);
	return {
		type: 'doc',
		version: 1,
		content: paragraphs.map(paragraph => ({
			type: 'paragraph',
			content: paragraph.split('\n').flatMap((line, index) => [
				...(index > 0 ? [{ type: 'hardBreak' }] : []),
				...(line.length > 0 ? [{ type: 'text', text: line }] : []),
			]),
		})),
	};
}

/** Jira's people (`GET /user/search`, `/user/assignable/search`): active people of the site, not apps or portal customers. */
export function mapJiraUsers(json: unknown): IPicodeNamed[] {
	if (!Array.isArray(json)) {
		return [];
	}
	const people: IPicodeNamed[] = [];
	for (const item of json) {
		const user = asRecord(item);
		const id = asString(user?.accountId);
		const name = asString(user?.displayName);
		const type = asString(user?.accountType);
		if (id && name && user?.active !== false && (type === '' || type === 'atlassian')) {
			people.push({ id, name });
		}
	}
	return people;
}

/** `GET /repos/{o}/{r}/labels` → the label names. */
export function mapGithubLabelNames(json: unknown): string[] {
	return Array.isArray(json) ? json.map(label => asString(asRecord(label)?.name)).filter(name => name.length > 0) : [];
}

/** `GET /repos/{o}/{r}/assignees` → the people an issue of the repository can be given to (their login is both id and name). */
export function mapGithubAssignees(json: unknown): IPicodeNamed[] {
	return Array.isArray(json) ? json.map(user => asString(asRecord(user)?.login)).filter(login => login.length > 0).map(login => ({ id: login, name: login })) : [];
}

/** What an edit of a GitHub issue changes. */
export interface IPicodeGithubPatch {
	readonly title?: string;
	readonly body?: string;
	readonly labels?: readonly string[];
	readonly assignees?: readonly string[];
}

/** The body of `PATCH /repos/{o}/{r}/issues/{n}`; anything that is not a well-formed value is left out. */
export function buildGithubUpdate(patch: IPicodeGithubPatch): Record<string, unknown> | undefined {
	const body: Record<string, unknown> = {};
	const title = patch.title?.trim();
	if (title && title.length <= 256) {
		body.title = title;
	}
	if (patch.body !== undefined && patch.body.length <= 65_536) {
		body.body = patch.body;
	}
	if (patch.labels) {
		body.labels = [...new Set(patch.labels.map(label => label.trim()).filter(label => label.length > 0 && label.length <= 50))];
	}
	if (patch.assignees) {
		body.assignees = patch.assignees.filter(login => /^[A-Za-z0-9-]{1,39}$/.test(login));
	}
	return Object.keys(body).length > 0 ? body : undefined;
}

/** `GET /project/search` → the Jira spaces, as `{ id: key, name }`. */
export function mapJiraProjectList(json: unknown): IPicodeNamed[] {
	const values = asRecord(json)?.values;
	if (!Array.isArray(values)) {
		return [];
	}
	const projects: IPicodeNamed[] = [];
	for (const item of values) {
		const key = asString(asRecord(item)?.key);
		const name = asString(asRecord(item)?.name);
		if (isJiraProjectKey(key) && name) {
			projects.push({ id: key, name });
		}
	}
	return projects;
}

/**
 * A Jira project key named by the branch the folder is on (`.git/HEAD` holding
 * `ref: refs/heads/feature/ATW-52-fix` gives `ATW`). Only a hint: whoever uses it checks the key
 * against the projects that really exist.
 */
export function jiraKeyFromBranch(head: string): string | undefined {
	const branch = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head)?.[1];
	return branch ? /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9_]*)-\d+/.exec(branch)?.[1] : undefined;
}
