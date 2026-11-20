/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Gentle AI's agent profiles as the editor reads and edits them: Gentle's own files, Gentle's shapes,
 * and nothing else in them lost.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { agentProfilesState, editAgentProfiles, profilesFile, ProfileEditError, resolvedProfile } from '../src/agent-profiles.ts';

let scratch: string;
let profileDir: string;
let repo: string;

beforeEach(() => {
	scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'picode-agent-profiles-'));
	profileDir = path.join(scratch, 'pi-agent');
	repo = path.join(scratch, 'repo');
	fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
	fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
});

afterEach(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

function writeProfiles(value: unknown): void {
	fs.mkdirSync(path.dirname(profilesFile(profileDir)), { recursive: true });
	fs.writeFileSync(profilesFile(profileDir), JSON.stringify(value));
}

function readProfiles(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(profilesFile(profileDir), 'utf8'));
}

test('without a profiles file the routing in effect shows as one unsaved profile', () => {
	fs.mkdirSync(path.join(profileDir, 'gentle-ai'), { recursive: true });
	fs.writeFileSync(path.join(profileDir, 'gentle-ai', 'models.json'), JSON.stringify({ writer: { model: 'anthropic/sonnet', thinking: 'high' } }));
	const state = agentProfilesState(profileDir, repo);
	assert.equal(state.unsaved, true);
	assert.equal(state.active, 'current');
	assert.deepEqual(state.profiles[0].routes, { writer: { model: 'anthropic/sonnet', thinking: 'high' } });
	assert.equal(fs.existsSync(profilesFile(profileDir)), false, 'reading writes nothing');
});

test('the saved profiles are read in Gentle\'s shape: routes, fast tier, way of working and backups', () => {
	writeProfiles({
		kind: 'gentle-pi.agent_model_profiles', version: 1, active: 'work',
		profiles: { work: { orchestrator: { model: 'openai/gpt-5', thinking: 'high' }, writer: { model: 'openai/gpt-5', tier: 'fast' } }, cheap: {} },
		workflow: { cheap: { orchestratorMode: 'full-delegation' } },
	});
	fs.writeFileSync(path.join(profileDir, 'gentle-ai', 'profile-fallbacks.json'), JSON.stringify({ kind: 'gentle-pi.profile_model_fallbacks', version: 1, profiles: { work: { writer: [{ model: 'a/b' }, { model: 'c/d' }] } } }));
	const state = agentProfilesState(profileDir, repo);
	assert.equal(state.unsaved, false);
	assert.equal(state.active, 'work');
	assert.deepEqual(state.profiles.map(profile => [profile.name, profile.mode, profile.fallbacks]), [['cheap', 'full-delegation', {}], ['work', 'organic', { writer: [{ model: 'a/b' }, { model: 'c/d' }] }]]);
	assert.deepEqual(state.profiles[1].routes['writer'], { model: 'openai/gpt-5', tier: 'fast' });
});

test('a profiles file that is not JSON is reported and never edited', () => {
	writeProfiles('x');
	fs.writeFileSync(profilesFile(profileDir), '{ nope');
	assert.equal(agentProfilesState(profileDir, repo).invalid, true);
	assert.throws(() => editAgentProfiles(profileDir, repo, { type: 'create', name: 'new' }), ProfileEditError);
	assert.equal(fs.readFileSync(profilesFile(profileDir), 'utf8'), '{ nope');
});

test('the first edit saves the unsaved profile as current, the way Gentle seeds it', () => {
	const state = editAgentProfiles(profileDir, repo, { type: 'create', name: 'deep', from: 'current' });
	assert.deepEqual(state.profiles.map(profile => profile.name), ['current', 'deep']);
	assert.equal(readProfiles()['active'], 'current');
	assert.equal(readProfiles()['kind'], 'gentle-pi.agent_model_profiles');
});

test('an edit keeps what the editor does not know about', () => {
	writeProfiles({ kind: 'gentle-pi.agent_model_profiles', version: 1, active: 'work', future: { keep: true }, profiles: { work: { writer: { model: 'a/b', extra: 1 } } } });
	editAgentProfiles(profileDir, repo, { type: 'route', name: 'work', agent: 'explorer', model: 'c/d', thinking: 'low' });
	const saved = readProfiles();
	assert.deepEqual(saved['future'], { keep: true });
	assert.deepEqual((saved['profiles'] as Record<string, Record<string, unknown>>)['work'], { writer: { model: 'a/b', extra: 1 }, explorer: { model: 'c/d', thinking: 'low' } });
});

test('a route takes a model, an effort and the fast tier, and refuses anything else', () => {
	writeProfiles({ kind: 'gentle-pi.agent_model_profiles', version: 1, active: 'work', profiles: { work: {} } });
	const state = editAgentProfiles(profileDir, repo, { type: 'route', name: 'work', agent: 'orchestrator', model: 'openai/gpt-5', thinking: 'xhigh', tier: 'fast' });
	assert.deepEqual(state.profiles[0].routes['orchestrator'], { model: 'openai/gpt-5', thinking: 'xhigh', tier: 'fast' });
	assert.throws(() => editAgentProfiles(profileDir, repo, { type: 'route', name: 'work', agent: 'writer', model: 'no slash' }), ProfileEditError);
	assert.throws(() => editAgentProfiles(profileDir, repo, { type: 'route', name: 'work', agent: 'writer', thinking: 'loud' }), ProfileEditError);
	const cleared = editAgentProfiles(profileDir, repo, { type: 'route', name: 'work', agent: 'orchestrator', model: '', thinking: '' });
	assert.deepEqual(cleared.profiles[0].routes['orchestrator'], {});
});

test('names follow Gentle\'s rule and never collide', () => {
	writeProfiles({ kind: 'gentle-pi.agent_model_profiles', version: 1, active: 'work', profiles: { work: {} } });
	for (const name of ['', '-x', 'with space', '__proto__', 'a'.repeat(65)]) {
		assert.throws(() => editAgentProfiles(profileDir, repo, { type: 'create', name }), ProfileEditError, name);
	}
	assert.throws(() => editAgentProfiles(profileDir, repo, { type: 'create', name: 'work' }), /already exists/);
	assert.deepEqual(editAgentProfiles(profileDir, repo, { type: 'create', name: 'v2.fast_one-a' }).profiles.map(profile => profile.name), ['v2.fast_one-a', 'work']);
});

test('renaming carries the default, the way of working, the backups and the pins along', () => {
	writeProfiles({ kind: 'gentle-pi.agent_model_profiles', version: 1, active: 'work', profiles: { work: { writer: { model: 'a/b' } } }, workflow: { work: { orchestratorMode: 'full-delegation' } } });
	fs.writeFileSync(path.join(profileDir, 'gentle-ai', 'profile-fallbacks.json'), JSON.stringify({ kind: 'gentle-pi.profile_model_fallbacks', version: 1, profiles: { work: { writer: [{ model: 'c/d' }] } } }));
	editAgentProfiles(profileDir, repo, { type: 'pin', source: 'local', name: 'work' });
	const state = editAgentProfiles(profileDir, repo, { type: 'rename', name: 'work', to: 'job' });
	assert.equal(state.active, 'job');
	assert.deepEqual(state.profiles.map(profile => [profile.name, profile.mode, profile.fallbacks]), [['job', 'full-delegation', { writer: [{ model: 'c/d' }] }]]);
	assert.equal(state.pins.local, 'job');
});

test('the default profile and a pinned one cannot be deleted; any other can', () => {
	writeProfiles({ kind: 'gentle-pi.agent_model_profiles', version: 1, active: 'work', profiles: { work: {}, cheap: {}, old: {} }, workflow: { old: { orchestratorMode: 'full-delegation' } } });
	editAgentProfiles(profileDir, repo, { type: 'pin', source: 'repo', name: 'cheap' });
	assert.throws(() => editAgentProfiles(profileDir, repo, { type: 'delete', name: 'work' }), /default profile/);
	assert.throws(() => editAgentProfiles(profileDir, repo, { type: 'delete', name: 'cheap' }), /Unpin/);
	const state = editAgentProfiles(profileDir, repo, { type: 'delete', name: 'old' });
	assert.deepEqual(state.profiles.map(profile => profile.name), ['cheap', 'work']);
	assert.equal(readProfiles()['workflow'], undefined, 'an empty workflow map is not left behind');
});

test('the way of working is full delegation or Gentle\'s default, never written', () => {
	writeProfiles({ kind: 'gentle-pi.agent_model_profiles', version: 1, active: 'work', profiles: { work: {} } });
	assert.equal(editAgentProfiles(profileDir, repo, { type: 'mode', name: 'work', mode: 'full-delegation' }).profiles[0].mode, 'full-delegation');
	assert.equal(editAgentProfiles(profileDir, repo, { type: 'mode', name: 'work', mode: 'organic' }).profiles[0].mode, 'organic');
	assert.equal(readProfiles()['workflow'], undefined);
	assert.throws(() => editAgentProfiles(profileDir, repo, { type: 'mode', name: 'work', mode: 'chaos' }), ProfileEditError);
});

test('pins go where Gentle reads them, and the most specific one wins', () => {
	writeProfiles({ kind: 'gentle-pi.agent_model_profiles', version: 1, active: 'work', profiles: { work: {}, cheap: {}, team: {} } });
	assert.deepEqual(resolvedProfile(agentProfilesState(profileDir, path.join(repo, 'src'))), { name: 'work', source: 'default' });
	editAgentProfiles(profileDir, path.join(repo, 'src'), { type: 'pin', source: 'repo', name: 'team' });
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.pi', 'gentle-ai', 'profile.json'), 'utf8')), { kind: 'gentle-pi.agent_model_profile_pin', version: 1, profile: 'team' });
	assert.deepEqual(resolvedProfile(agentProfilesState(profileDir, repo)), { name: 'team', source: 'repo' });
	editAgentProfiles(profileDir, repo, { type: 'pin', source: 'local', name: 'cheap' });
	assert.ok(fs.existsSync(path.join(repo, '.git', 'gentle-ai', 'profile-pin.json')));
	assert.deepEqual(resolvedProfile(agentProfilesState(profileDir, repo)), { name: 'cheap', source: 'local' });
	editAgentProfiles(profileDir, repo, { type: 'pin', source: 'local' });
	assert.deepEqual(resolvedProfile(agentProfilesState(profileDir, repo)), { name: 'team', source: 'repo' });
});

test('a linked worktree pins in the clone\'s shared git folder', () => {
	const worktree = path.join(scratch, 'wt');
	const gitDir = path.join(repo, '.git', 'worktrees', 'wt');
	fs.mkdirSync(gitDir, { recursive: true });
	fs.writeFileSync(path.join(gitDir, 'commondir'), '../..');
	fs.mkdirSync(worktree);
	fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
	writeProfiles({ kind: 'gentle-pi.agent_model_profiles', version: 1, active: 'work', profiles: { work: {} } });
	editAgentProfiles(profileDir, worktree, { type: 'pin', source: 'local', name: 'work' });
	assert.ok(fs.existsSync(path.join(repo, '.git', 'gentle-ai', 'profile-pin.json')));
	assert.equal(agentProfilesState(profileDir, repo).pins.local, 'work', 'every worktree of the clone shares it');
});

test('outside a repository nothing can be pinned', () => {
	const plain = path.join(scratch, 'plain');
	fs.mkdirSync(plain);
	writeProfiles({ kind: 'gentle-pi.agent_model_profiles', version: 1, active: 'work', profiles: { work: {} } });
	assert.equal(agentProfilesState(profileDir, plain).pinnable, false);
	assert.throws(() => editAgentProfiles(profileDir, plain, { type: 'pin', source: 'local', name: 'work' }), /Git repository/);
});

function readFallbacksFile(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(profileDir, 'gentle-ai', 'profile-fallbacks.json'), 'utf8'));
}

test("backup models are saved in Gentle's own file and shape, in order, and an empty list removes them", () => {
	writeProfiles({ kind: 'gentle-pi.agent_model_profiles', version: 1, active: 'work', profiles: { work: {} } });
	const state = editAgentProfiles(profileDir, repo, { type: 'fallbacks', name: 'work', agent: 'writer', chain: [{ model: 'anthropic/opus', thinking: 'high' }, { model: 'zai/glm' }] });
	assert.deepEqual(state.profiles[0].fallbacks, { writer: [{ model: 'anthropic/opus', thinking: 'high' }, { model: 'zai/glm' }] });
	assert.deepEqual(readFallbacksFile(), { kind: 'gentle-pi.profile_model_fallbacks', version: 1, profiles: { work: { writer: [{ model: 'anthropic/opus', thinking: 'high' }, { model: 'zai/glm' }] } } });
	editAgentProfiles(profileDir, repo, { type: 'fallbacks', name: 'work', agent: '*', chain: [{ model: 'a/b' }] });
	assert.deepEqual(agentProfilesState(profileDir, repo).profiles[0].fallbacks['*'], [{ model: 'a/b' }]);
	editAgentProfiles(profileDir, repo, { type: 'fallbacks', name: 'work', agent: 'writer', chain: [] });
	editAgentProfiles(profileDir, repo, { type: 'fallbacks', name: 'work', agent: '*', chain: [] });
	assert.deepEqual(readFallbacksFile(), { kind: 'gentle-pi.profile_model_fallbacks', version: 1, profiles: {} });
});

test("a backup chain follows Gentle's rules: real models, no repeats, at most eight", () => {
	writeProfiles({ kind: 'gentle-pi.agent_model_profiles', version: 1, active: 'work', profiles: { work: {} } });
	assert.throws(() => editAgentProfiles(profileDir, repo, { type: 'fallbacks', name: 'work', agent: 'writer', chain: [{ model: 'no slash' }] }), ProfileEditError);
	assert.throws(() => editAgentProfiles(profileDir, repo, { type: 'fallbacks', name: 'work', agent: 'writer', chain: [{ model: 'a/b' }, { model: 'a/b' }] }), /already a backup/);
	assert.throws(() => editAgentProfiles(profileDir, repo, { type: 'fallbacks', name: 'work', agent: 'writer', chain: Array.from({ length: 9 }, (_, i) => ({ model: `p/m${i}` })) }), /up to 8/);
	assert.throws(() => editAgentProfiles(profileDir, repo, { type: 'fallbacks', name: 'nope', agent: 'writer', chain: [] }), ProfileEditError);
	assert.equal(fs.existsSync(path.join(profileDir, 'gentle-ai', 'profile-fallbacks.json')), false, 'a refused chain writes nothing');
});

test('a copy brings its backups, and deleting a profile takes its backups with it', () => {
	writeProfiles({ kind: 'gentle-pi.agent_model_profiles', version: 1, active: 'work', profiles: { work: {} } });
	editAgentProfiles(profileDir, repo, { type: 'fallbacks', name: 'work', agent: 'writer', chain: [{ model: 'a/b' }] });
	editAgentProfiles(profileDir, repo, { type: 'create', name: 'copy', from: 'work' });
	assert.deepEqual(agentProfilesState(profileDir, repo).profiles.find(profile => profile.name === 'copy')?.fallbacks, { writer: [{ model: 'a/b' }] });
	editAgentProfiles(profileDir, repo, { type: 'delete', name: 'copy' });
	assert.deepEqual(Object.keys((readFallbacksFile()['profiles'] as Record<string, unknown>)), ['work']);
});

test('a backups file the editor cannot read is never overwritten', () => {
	writeProfiles({ kind: 'gentle-pi.agent_model_profiles', version: 1, active: 'work', profiles: { work: {} } });
	fs.writeFileSync(path.join(profileDir, 'gentle-ai', 'profile-fallbacks.json'), '{ broken');
	assert.throws(() => editAgentProfiles(profileDir, repo, { type: 'fallbacks', name: 'work', agent: 'writer', chain: [{ model: 'a/b' }] }), ProfileEditError);
	assert.equal(fs.readFileSync(path.join(profileDir, 'gentle-ai', 'profile-fallbacks.json'), 'utf8'), '{ broken');
});
