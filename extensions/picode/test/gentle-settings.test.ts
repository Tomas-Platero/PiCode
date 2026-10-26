/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Gentle's persona and default permissions, run on their own against a throwaway profile folder.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { gentleSettings, setGentleSetting } from '../src/gentle-settings.ts';

function profile(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'picode-gentle-'));
}

const home = (dir: string, file: string): string => path.join(dir, 'gentle-ai', file);

test('a profile with nothing saved starts on the default persona and normal permissions', () => {
	assert.deepEqual(gentleSettings(profile()), { persona: 'gentleman', permissions: 'normal', permissionsBroken: false });
});

test('the persona is written the way gentle writes it, and read back', () => {
	const dir = profile();
	assert.equal(setGentleSetting(dir, { key: 'persona', value: 'neutral' }).persona, 'neutral');
	assert.deepEqual(JSON.parse(fs.readFileSync(home(dir, 'persona.json'), 'utf8')), { mode: 'neutral' });
	assert.equal(setGentleSetting(dir, { key: 'persona', value: 'gentleman' }).persona, 'gentleman');
});

test('anything that is not neutral reads as the default persona, as gentle reads it', () => {
	const dir = profile();
	fs.mkdirSync(path.dirname(home(dir, 'persona.json')), { recursive: true });
	for (const text of ['{ nope', '[]', '{"mode":"loud"}']) {
		fs.writeFileSync(home(dir, 'persona.json'), text);
		assert.equal(gentleSettings(dir).persona, 'gentleman');
	}
});

test('the permissions are written with the schema line gentle insists on, and nothing else', () => {
	const dir = profile();
	assert.equal(setGentleSetting(dir, { key: 'permissions', value: 'auto' }).permissions, 'auto');
	assert.deepEqual(JSON.parse(fs.readFileSync(home(dir, 'permission-mode.json'), 'utf8')), { schema: 'gentle-pi.permission-mode/v1', mode: 'auto' });
	assert.deepEqual(fs.readdirSync(path.dirname(home(dir, 'x'))).sort(), ['permission-mode.json']);
});

test('a permissions file gentle could not read is reported and never replaced', () => {
	const dir = profile();
	fs.mkdirSync(path.dirname(home(dir, 'x')), { recursive: true });
	for (const text of ['{ nope', '{"mode":"yolo"}', '{"schema":"gentle-pi.permission-mode/v1","mode":"yolo","extra":1}']) {
		fs.writeFileSync(home(dir, 'permission-mode.json'), text);
		assert.equal(gentleSettings(dir).permissionsBroken, true);
		assert.throws(() => setGentleSetting(dir, { key: 'permissions', value: 'normal' }));
		assert.equal(fs.readFileSync(home(dir, 'permission-mode.json'), 'utf8'), text);
	}
});

test('a request for anything else is refused and writes nothing', () => {
	const dir = profile();
	for (const bad of [undefined, 'persona', { key: 'persona', value: 'loud' }, { key: 'permissions', value: 'god' }, { key: 'review', value: 'on' }, { value: 'neutral' }]) {
		assert.throws(() => setGentleSetting(dir, bad), () => true, JSON.stringify(bad));
	}
	assert.equal(fs.existsSync(path.join(dir, 'gentle-ai')), false);
});
