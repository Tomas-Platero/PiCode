/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { test } from 'node:test';
import { isFiltering, matchesFilter, NO_FILTER, openProjects, projectFromRemote, remainingMemories, searchFilterParams } from '../src/memory-paging.ts';

test('more is offered while rows wait in hand or the page came back full', () => {
	assert.strictEqual(remainingMemories(20, 50, 50, 120), 100);
	assert.strictEqual(remainingMemories(50, 50, 50, 120), 70);
});

test('a short page ends the list even when the count promises more', () => {
	assert.strictEqual(remainingMemories(30, 30, 50, 120), 0);
});

test('nothing remains once everything counted is shown', () => {
	assert.strictEqual(remainingMemories(50, 50, 50, 50), 0);
	assert.strictEqual(remainingMemories(0, 0, 50, 0), 0);
});

test('the project comes from the last segment of any remote spelling', () => {
	assert.strictEqual(projectFromRemote('https://github.com/Tomas-Platero/PiCode.git'), 'picode');
	assert.strictEqual(projectFromRemote('git@github.com:Tomas-Platero/PiCode.git\n'), 'picode');
	assert.strictEqual(projectFromRemote('https://example.com/group/Repo/'), 'repo');
	assert.strictEqual(projectFromRemote(''), undefined);
	assert.strictEqual(projectFromRemote(undefined), undefined);
});

test('a folder named unlike its repository still finds its memories', () => {
	const listed = [{ name: 'picode', memories: 171 }];
	assert.deepStrictEqual(openProjects([{ name: 'my-fork', remote: 'https://github.com/x/PiCode.git' }], listed), listed);
});

test('the repository wins over a same-named folder, and the folder is the fallback', () => {
	const listed = [{ name: 'fork', memories: 2 }, { name: 'repo', memories: 9 }];
	assert.deepStrictEqual(openProjects([{ name: 'Fork', remote: 'x/repo.git' }], listed), [{ name: 'repo', memories: 9 }]);
	assert.deepStrictEqual(openProjects([{ name: 'Fork' }], listed), [{ name: 'fork', memories: 2 }]);
});

test('a folder with nothing saved shows at zero under its own name', () => {
	assert.deepStrictEqual(openProjects([{ name: 'New', remote: 'x/new-repo.git' }], []), [{ name: 'New', memories: 0 }]);
});

test('two folders of one repository show once', () => {
	const listed = [{ name: 'repo', memories: 3 }];
	assert.deepStrictEqual(openProjects([{ name: 'a', remote: 'x/repo.git' }, { name: 'b', remote: 'y/REPO.git' }], listed), listed);
});

const row = (type: string, scope: string, updatedAt: string) => ({ type, scope, updatedAt, createdAt: updatedAt });
const NOW = Date.parse('2026-11-05T12:00:00Z');

test('no filter lets everything through', () => {
	assert.strictEqual(isFiltering(NO_FILTER), false);
	assert.strictEqual(matchesFilter(row('bugfix', 'project', ''), NO_FILTER, NOW), true);
});

test('types and scopes keep the rows named, whatever the case', () => {
	const filter = { types: ['decision', 'bugfix'], scopes: ['personal'] };
	assert.strictEqual(isFiltering(filter), true);
	assert.strictEqual(matchesFilter(row('Decision', 'PERSONAL', ''), filter, NOW), true);
	assert.strictEqual(matchesFilter(row('pattern', 'personal', ''), filter, NOW), false);
	assert.strictEqual(matchesFilter(row('bugfix', 'project', ''), filter, NOW), false);
});

test('a date keeps what changed within it, reading the engine\'s spelling as UTC', () => {
	const filter = { types: [], scopes: [], days: 7 };
	assert.strictEqual(matchesFilter(row('x', 'y', '2026-11-01 10:00:00'), filter, NOW), true);
	assert.strictEqual(matchesFilter(row('x', 'y', '2026-10-01 10:00:00'), filter, NOW), false);
	assert.strictEqual(matchesFilter(row('x', 'y', '2026-11-01T10:00:00Z'), filter, NOW), true);
});

test('a row with no readable date is left out of a dated filter', () => {
	assert.strictEqual(matchesFilter(row('x', 'y', ''), { types: [], scopes: [], days: 7 }, NOW), false);
});

test('the engine is asked to narrow only when it can: one type, one scope', () => {
	assert.strictEqual(searchFilterParams(NO_FILTER), '');
	assert.strictEqual(searchFilterParams({ types: ['session-summary'], scopes: ['project'] }), '&type=session-summary&scope=project');
	assert.strictEqual(searchFilterParams({ types: ['a', 'b'], scopes: [], days: 7 }), '');
});
