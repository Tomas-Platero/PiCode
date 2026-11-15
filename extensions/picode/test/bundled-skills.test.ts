/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License. See License.txt
 *--------------------------------------------------------------------------------------------*/

/**
 * The skills PiCode ships to pi, run on their own.
 *
 * What matters: every skill folder with a `SKILL.md` is handed to pi, a folder without one and
 * the README beside them are not (pi would load the README as a skill), a missing folder means
 * no skills rather than an error, and the shipped `web-preview` skill is well formed.
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { bundledSkillPaths } from '../src/bundled-skills.ts';

const connectorRoot = path.join(import.meta.dirname, '..');

test('each skill folder with a SKILL.md is passed, and nothing else', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'picode-skills-'));
	try {
		fs.mkdirSync(path.join(root, 'skills', 'b-skill'), { recursive: true });
		fs.writeFileSync(path.join(root, 'skills', 'b-skill', 'SKILL.md'), '---\nname: b-skill\ndescription: x\n---\n');
		fs.mkdirSync(path.join(root, 'skills', 'a-skill'), { recursive: true });
		fs.writeFileSync(path.join(root, 'skills', 'a-skill', 'SKILL.md'), '---\nname: a-skill\ndescription: x\n---\n');
		fs.mkdirSync(path.join(root, 'skills', 'empty'), { recursive: true });
		fs.writeFileSync(path.join(root, 'skills', 'README.md'), '# skills\n');
		assert.deepStrictEqual(bundledSkillPaths(root), [
			path.join(root, 'skills', 'a-skill'),
			path.join(root, 'skills', 'b-skill'),
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('no skills folder means no skills', () => {
	assert.deepStrictEqual(bundledSkillPaths(path.join(os.tmpdir(), 'picode-no-such-root')), []);
});

test('the shipped web-preview skill is found and names itself like its folder', () => {
	const paths = bundledSkillPaths(connectorRoot);
	const webPreview = path.join(connectorRoot, 'skills', 'web-preview');
	assert.ok(paths.includes(webPreview));
	const text = fs.readFileSync(path.join(webPreview, 'SKILL.md'), 'utf8');
	assert.match(text, /^---\r?\nname: web-preview\r?\ndescription: .+\r?\n---/);
});
