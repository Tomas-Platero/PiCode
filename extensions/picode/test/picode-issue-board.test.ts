/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The issues viewer's data: projects, statuses, board columns and filters. */

import assert from 'assert';
import { test } from 'node:test';
import { register } from 'node:module';

// The editor's modules import each other with a `.js` ending; under plain node those are the `.ts` files.
register('data:text/javascript,' + encodeURIComponent(
	"export async function resolve(s, c, next) { try { return await next(s, c); } catch (e) { if (s.startsWith('.') && s.endsWith('.js')) { return next(s.slice(0, -3) + '.ts', c); } throw e; } }"
));

const {
	buildColumns, filterIssues, initialsOf, mapGithubBoardIssues, mapJiraBoardIssues, mapJiraProject, mapJiraStatuses,
	buildJiraUpdate, mapEditMetaTypes, mapJiraBoardColumns, mapNamedList, mapProjectIssueTypes, nextJiraPageToken, normalizeLabels, parseGithubRepoRef, peopleOf, pickJiraBoardId, pickTransition, projectRefOf,
} = await import('../../../src/vs/workbench/contrib/picode/browser/account/issues/picodeIssueBoard.ts');
type IPicodeBoardIssue = import('../../../src/vs/workbench/contrib/picode/browser/account/issues/picodeIssueBoard.ts').IPicodeBoardIssue;

const SITE = 'https://acme.atlassian.net';

const jiraIssue = (key: string, status: string, category: string, extra: Record<string, unknown> = {}) => ({
	key,
	fields: {
		summary: `Title of ${key}`, description: null, project: { key: key.split('-')[0] }, reporter: { displayName: 'Ana', accountType: 'atlassian' },
		updated: '2026-11-01T10:00:00.000+0000', created: '2026-10-01T10:00:00.000+0000', labels: ['supabase'],
		status: { name: status, statusCategory: { key: category } }, issuetype: { name: 'Bug' }, priority: { name: 'High' }, assignee: { displayName: 'Tomás Platero' },
		...extra,
	},
});

test('the project of an issue comes from its key, and only from a well-formed one', () => {
	assert.strictEqual(projectRefOf({ source: 'jira', key: 'ATW-12' }), 'ATW');
	assert.strictEqual(projectRefOf({ source: 'jira', key: 'atw-12' }), undefined);
	assert.strictEqual(projectRefOf({ source: 'github', key: 'Tomas-Platero/PiCode#4' }), 'Tomas-Platero/PiCode');
	assert.strictEqual(projectRefOf({ source: 'github', key: 'no-number' }), undefined);
	assert.deepStrictEqual(parseGithubRepoRef('o/r.js'), { owner: 'o', repo: 'r.js' });
	assert.strictEqual(parseGithubRepoRef('o/r/x'), undefined);
});

test('a software space opens as a board and any other as a list', () => {
	assert.deepStrictEqual(mapJiraProject({ name: 'Artic Tempest', projectTypeKey: 'software' }), { name: 'Artic Tempest', layout: 'kanban' });
	assert.deepStrictEqual(mapJiraProject({ name: 'Ops', projectTypeKey: 'business' }), { name: 'Ops', layout: 'list' });
	assert.strictEqual(mapJiraProject({ projectTypeKey: 'software' }), undefined);
});

test('statuses come once each, to-do first and done last, keeping the workflow order inside a group', () => {
	const statuses = mapJiraStatuses([
		{ statuses: [{ name: 'Done', statusCategory: { key: 'done' } }, { name: 'To Do', statusCategory: { key: 'new' } }, { name: 'In Progress', statusCategory: { key: 'indeterminate' } }] },
		{ statuses: [{ name: 'In Review', statusCategory: { key: 'indeterminate' } }, { name: 'Blocked', statusCategory: { key: 'indeterminate' } }, { name: 'Done', statusCategory: { key: 'done' } }] },
	]);
	assert.deepStrictEqual(statuses.map(status => status.name), ['To Do', 'In Progress', 'In Review', 'Blocked', 'Done']);
	assert.deepStrictEqual(mapJiraStatuses('nope'), []);
});

test('a Jira issue carries its status, type, priority and assignee', () => {
	const [issue] = mapJiraBoardIssues({ issues: [jiraIssue('ATW-45', 'To Do', 'new')] }, SITE);
	assert.strictEqual(issue.key, 'ATW-45');
	assert.strictEqual(issue.status, 'To Do');
	assert.strictEqual(issue.category, 'todo');
	assert.strictEqual(issue.type, 'Bug');
	assert.strictEqual(issue.priority, 'High');
	assert.strictEqual(issue.assignee, 'Tomás Platero');
	assert.strictEqual(issue.createdAt, '2026-10-01T10:00:00.000+0000');
	assert.strictEqual(issue.url, `${SITE}/browse/ATW-45`);
});

test('an issue without a valid key is skipped and the rest are kept', () => {
	const issues = mapJiraBoardIssues({ issues: [{ key: 'bad key', fields: {} }, jiraIssue('ATW-1', 'Done', 'done')] }, SITE);
	assert.deepStrictEqual(issues.map(issue => issue.key), ['ATW-1']);
	assert.deepStrictEqual(mapJiraBoardIssues(null, SITE), []);
});

test('the next page token is read only when it is a non-empty string', () => {
	assert.strictEqual(nextJiraPageToken({ nextPageToken: 'abc' }), 'abc');
	assert.strictEqual(nextJiraPageToken({ nextPageToken: '' }), undefined);
	assert.strictEqual(nextJiraPageToken({}), undefined);
});

test('a GitHub issue list keeps open and closed issues and drops pull requests', () => {
	const issues = mapGithubBoardIssues([
		{ number: 1, title: 'A', body: null, html_url: 'https://github.com/o/r/issues/1', state: 'open', user: { login: 'ana' }, author_association: 'OWNER', labels: [{ name: 'bug' }], assignee: { login: 'tom' }, comments: 3, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' },
		{ number: 2, title: 'B', body: '', html_url: 'https://github.com/o/r/issues/2', state: 'closed', user: { login: 'bob' }, author_association: 'NONE', labels: [], updated_at: '2026-11-02T00:00:00Z' },
		{ number: 3, title: 'PR', html_url: 'https://github.com/o/r/pull/3', pull_request: {}, state: 'open' },
	], { owner: 'o', repo: 'r' });
	assert.deepStrictEqual(issues.map(issue => [issue.key, issue.status, issue.category, issue.comments, issue.assignee]), [
		['o/r#1', 'open', 'todo', 3, 'tom'],
		['o/r#2', 'closed', 'done', 0, ''],
	]);
	assert.strictEqual(issues[1].external, true);
});

const issue = (key: string, status: string, category: IPicodeBoardIssue['category'], extra: Partial<IPicodeBoardIssue> = {}): IPicodeBoardIssue => ({
	source: 'jira', key, title: `T ${key}`, body: '', url: `https://x/${key}`, project: 'ATW', author: '', external: false, updatedAt: '', labels: [],
	status, statusId: '', category, type: '', typeId: '', priority: '', priorityId: '', assignee: '', assigneeId: '', reporterId: '', createdAt: '', comments: 0, ...extra,
});

test('the board keeps empty columns and adds a status the project no longer lists', () => {
	const columns = buildColumns(
		[{ name: 'To Do', category: 'todo' }, { name: 'Blocked', category: 'progress' }, { name: 'Done', category: 'done' }],
		[issue('A-1', 'To Do', 'todo'), issue('A-2', 'Old state', 'progress'), issue('A-3', 'Done', 'done')],
	);
	assert.deepStrictEqual(columns.map(column => [column.status.name, column.issues.length]), [['To Do', 1], ['Blocked', 0], ['Done', 1], ['Old state', 1]]);
});

test('a search matches every word in the key, title, status, assignee, type or labels', () => {
	const issues = [issue('A-1', 'To Do', 'todo', { assignee: 'Tomás Platero', labels: ['supabase'] }), issue('A-2', 'Done', 'done')];
	assert.deepStrictEqual(filterIssues(issues, 'supabase tom').map(found => found.key), ['A-1']);
	assert.deepStrictEqual(filterIssues(issues, 'DONE').map(found => found.key), ['A-2']);
	assert.deepStrictEqual(filterIssues(issues, '  ').length, 2);
	assert.deepStrictEqual(filterIssues(issues, 'zzz'), []);
});

test('initials are the first letters of the first two words', () => {
	assert.strictEqual(initialsOf('Tomás Platero Ortega'), 'TP');
	assert.strictEqual(initialsOf('ana'), 'A');
	assert.strictEqual(initialsOf('  '), '');
});

test('the transition to a status is found by where it ends, not by its own name', () => {
	const transitions = { transitions: [
		{ id: '11', name: 'Start', to: { id: '10001', name: 'In Progress' } },
		{ id: '31', name: 'Finish it', to: { id: '10003', name: 'Done' } },
		{ id: 'x', name: 'Odd', to: { name: 'Blocked' } },
	] };
	assert.strictEqual(pickTransition(transitions, { name: 'Done' }), '31');
	assert.strictEqual(pickTransition(transitions, { name: 'In Progress' }), '11');
	assert.strictEqual(pickTransition(transitions, { name: 'Blocked' }), undefined);
	assert.strictEqual(pickTransition(transitions, { name: 'In Review' }), undefined);
	assert.strictEqual(pickTransition(null, { name: 'Done' }), undefined);
});

test('a transition is also found by the ids of the target column, whatever the statuses are called', () => {
	const transitions = { transitions: [{ id: '31', name: 'Go', to: { id: '10003', name: 'Finalizada' } }] };
	assert.strictEqual(pickTransition(transitions, { name: 'Done', ids: ['10003'] }), '31');
	assert.strictEqual(pickTransition(transitions, { name: 'Done', ids: ['10009'] }), undefined);
});

test("a board's columns keep Jira's order and the first is to-do, the last done", () => {
	const columns = mapJiraBoardColumns({ columnConfig: { columns: [
		{ name: 'Backlog', statuses: [] },
		{ name: 'To Do', statuses: [{ id: '10000' }] },
		{ name: 'In Progress', statuses: [{ id: '10001' }] },
		{ name: 'In Review', statuses: [{ id: '10002' }] },
		{ name: 'Blocked', statuses: [{ id: '10004' }] },
		{ name: 'Done', statuses: [{ id: '10003' }, { id: '10005' }] },
	] } });
	assert.deepStrictEqual(columns.map(column => [column.name, column.category, column.ids]), [
		['To Do', 'todo', ['10000']], ['In Progress', 'progress', ['10001']], ['In Review', 'progress', ['10002']],
		['Blocked', 'progress', ['10004']], ['Done', 'done', ['10003', '10005']],
	]);
	assert.deepStrictEqual(mapJiraBoardColumns({}), []);
	assert.strictEqual(pickJiraBoardId({ values: [{ id: 7 }, { id: 8 }] }), 7);
	assert.strictEqual(pickJiraBoardId({ values: [] }), undefined);
});

test('an issue goes to the column that holds its status id, even when the names differ', () => {
	const columns = buildColumns(
		[{ name: 'To Do', category: 'todo', ids: ['10000'] }, { name: 'Done', category: 'done', ids: ['10003'] }],
		[issue('A-1', 'Tareas por hacer', 'todo', { statusId: '10000' }), issue('A-2', 'Finalizada', 'progress', { statusId: '10003' }), issue('A-3', 'Rara', 'progress', { statusId: '99' })],
	);
	assert.deepStrictEqual(columns.map(column => [column.status.name, column.issues.map(found => found.key)]), [['To Do', ['A-1']], ['Done', ['A-2']], ['Rara', ['A-3']]]);
});

test('without a board the statuses are ordered by group, then by when they were created', () => {
	const statuses = mapJiraStatuses([{ statuses: [
		{ id: '10002', name: 'Review', statusCategory: { key: 'indeterminate' } },
		{ id: '10001', name: 'Doing', statusCategory: { key: 'indeterminate' } },
		{ id: '10003', name: 'Done', statusCategory: { key: 'done' } },
		{ id: '10000', name: 'Todo', statusCategory: { key: 'new' } },
	] }]);
	assert.deepStrictEqual(statuses.map(status => status.name), ['Todo', 'Doing', 'Review', 'Done']);
});

test('a Jira issue also carries the ids an edit sends back', () => {
	const [found] = mapJiraBoardIssues({ issues: [jiraIssue('ATW-9', 'Done', 'done', {
		issuetype: { id: '10005', name: 'Error' }, priority: { id: '4', name: 'Low' },
		assignee: { displayName: 'Tomás', accountId: 'acc-1' }, reporter: { displayName: 'Ana', accountId: 'acc-2', accountType: 'atlassian' },
	})] }, SITE);
	assert.deepStrictEqual([found.typeId, found.priorityId, found.assigneeId, found.reporterId], ['10005', '4', 'acc-1', 'acc-2']);
});

test('the lists an edit offers are read from what Jira answers', () => {
	assert.deepStrictEqual(mapNamedList([{ id: '1', name: 'Highest' }, { id: '', name: 'x' }, { name: 'y' }]), [{ id: '1', name: 'Highest' }]);
	assert.deepStrictEqual(mapEditMetaTypes({ fields: { issuetype: { allowedValues: [{ id: '10001', name: 'Epic' }] } } }), [{ id: '10001', name: 'Epic' }]);
	assert.deepStrictEqual(mapEditMetaTypes({ fields: {} }), []);
	assert.deepStrictEqual(mapProjectIssueTypes({ issueTypes: [{ id: '1', name: 'Task', subtask: false }, { id: '2', name: 'Sub-task', subtask: true }] }), [{ id: '1', name: 'Task' }]);
});

test('the people to choose from are whoever is assignee or reporter of an issue, once each', () => {
	const people = peopleOf([
		issue('A-1', 'To Do', 'todo', { assigneeId: 'b', assignee: 'Bea', reporterId: 'a', author: 'Ana' }),
		issue('A-2', 'To Do', 'todo', { assigneeId: 'a', assignee: 'Ana' }),
		issue('A-3', 'To Do', 'todo'),
	]);
	assert.deepStrictEqual(people, [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Bea' }]);
});

test('labels lose their spaces and repeats', () => {
	assert.deepStrictEqual(normalizeLabels([' status page ', 'bug', 'bug', '', '  ']), ['status-page', 'bug']);
});

test('an edit sends only well-formed values, and can unassign or clear the labels', () => {
	assert.deepStrictEqual(buildJiraUpdate({ summary: '  New title  ', typeId: '10005', priorityId: '3', assigneeId: 'acc-1', reporterId: 'acc-2', labels: ['a b'] }), {
		fields: { summary: 'New title', issuetype: { id: '10005' }, priority: { id: '3' }, assignee: { accountId: 'acc-1' }, reporter: { accountId: 'acc-2' }, labels: ['a-b'] },
	});
	assert.deepStrictEqual(buildJiraUpdate({ assigneeId: null }), { fields: { assignee: { accountId: null } } });
	assert.deepStrictEqual(buildJiraUpdate({ labels: [] }), { fields: { labels: [] } });
	assert.strictEqual(buildJiraUpdate({ summary: '   ', typeId: 'abc', priorityId: '1;2', assigneeId: 'bad id!', reporterId: '' }), undefined);
	assert.strictEqual(buildJiraUpdate({ summary: 'x'.repeat(256) }), undefined);
});
