/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** What GitHub and Jira answer, mapped to one issue shape. */

import assert from 'assert';
import { test } from 'node:test';
import { adfToText, mapGithubIssues, mapGithubRepos, mapJiraIssues, originFromGitConfig, parseGithubRemote } from '../../../src/vs/workbench/contrib/picode/browser/account/issues/picodeIssueSources.ts';

test('every common remote spelling names the same repository', () => {
	for (const remote of ['https://github.com/o/r.git', 'https://tok@github.com/o/r', 'git@github.com:o/r.git', 'ssh://git@github.com/o/r', 'https://github.com/o/r/']) {
		assert.deepStrictEqual(parseGithubRemote(remote), { owner: 'o', repo: 'r' }, remote);
	}
	assert.strictEqual(parseGithubRemote('https://gitlab.com/o/r.git'), undefined);
	assert.strictEqual(parseGithubRemote('https://evil.com/github.com/o/r'), undefined);
});

test('the origin remote is read from a .git/config', () => {
	const config = '[core]\n\turl = nope\n[remote "upstream"]\n\turl = https://github.com/a/b\n[remote "origin"]\n\turl = git@github.com:o/r.git\n';
	assert.strictEqual(originFromGitConfig(config), 'git@github.com:o/r.git');
	assert.strictEqual(originFromGitConfig('[core]\n'), undefined);
});

test('pull requests are not issues', () => {
	const list = [
		{ number: 1, title: 'bug', html_url: 'https://github.com/o/r/issues/1', user: { login: 'u' }, author_association: 'NONE', labels: [{ name: 'bug' }], body: 'b', updated_at: 't' },
		{ number: 2, title: 'pr', html_url: 'https://github.com/o/r/pull/2', pull_request: { url: 'x' }, user: { login: 'u' } },
	];
	const issues = mapGithubIssues(list, { owner: 'o', repo: 'r' });
	assert.strictEqual(issues.length, 1);
	assert.strictEqual(issues[0].key, 'o/r#1');
	assert.deepStrictEqual(issues[0].labels, ['bug']);
});

test('team members are inside, everybody else is outside', () => {
	const make = (association: string) => mapGithubIssues([{ number: 1, html_url: 'https://github.com/o/r/issues/1', author_association: association }], { owner: 'o', repo: 'r' })[0].external;
	assert.strictEqual(make('OWNER'), false);
	assert.strictEqual(make('COLLABORATOR'), false);
	assert.strictEqual(make('CONTRIBUTOR'), true);
	assert.strictEqual(make('NONE'), true);
	assert.strictEqual(make(''), true);
});

test('an issue with a link that is not https is dropped', () => {
	assert.deepStrictEqual(mapGithubIssues([{ number: 1, html_url: 'javascript:alert(1)' }], { owner: 'o', repo: 'r' }), []);
});

test('anything that is not a list gives no issues', () => {
	assert.deepStrictEqual(mapGithubIssues({ message: 'Bad credentials' }, { owner: 'o', repo: 'r' }), []);
	assert.deepStrictEqual(mapGithubRepos(null), []);
});

test('repositories without issues are skipped', () => {
	const repos = mapGithubRepos({ repositories: [{ name: 'a', owner: { login: 'o' } }, { name: 'b', owner: { login: 'o' }, has_issues: false }] });
	assert.deepStrictEqual(repos, [{ owner: 'o', repo: 'a' }]);
});

test('a Jira description becomes plain text', () => {
	const adf = { type: 'doc', content: [
		{ type: 'paragraph', content: [{ type: 'text', text: 'Steps' }] },
		{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'open' }] }] }] },
	] };
	assert.strictEqual(adfToText(adf).trim(), 'Steps\n- open');
});

test('a Jira search becomes issues with a link to the site', () => {
	const json = { issues: [{ key: 'ABC-12', fields: { summary: 'Broken', description: null, project: { key: 'ABC' }, reporter: { displayName: 'Ann', accountType: 'customer' }, updated: 't', labels: ['x'] } }] };
	const [issue] = mapJiraIssues(json, 'https://acme.atlassian.net');
	assert.strictEqual(issue.url, 'https://acme.atlassian.net/browse/ABC-12');
	assert.strictEqual(issue.external, true);
	assert.strictEqual(issue.body, '');
});

test('a site that is not an https host gives nothing', () => {
	assert.deepStrictEqual(mapJiraIssues({ issues: [{ key: 'ABC-1', fields: {} }] }, 'javascript:x'), []);
});

test('a key that is not a Jira key is dropped', () => {
	assert.deepStrictEqual(mapJiraIssues({ issues: [{ key: '../../x', fields: {} }] }, 'https://a.atlassian.net'), []);
});
