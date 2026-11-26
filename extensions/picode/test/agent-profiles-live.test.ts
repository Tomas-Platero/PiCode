/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Applying a profile goes through Gentle's own service on pi's event bus, in the chat used last,
 * with Gentle's confirmation round trip.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { agentProfilesExtension, applyAgentProfile, applyConfirmed, deferDefault, frontChatModel, hasLiveSession, readKnownSessionProfile, refreshLiveCredentials, resetLiveProfiles, type ProfilesPi } from '../src/agent-profiles-live.ts';

afterEach(() => resetLiveProfiles());

test('reads the actual model of the requested live chat', () => {
	const handlers = new Map<string, (...args: unknown[]) => void>();
	const pi = { on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler) } as unknown as ProfilesPi;
	agentProfilesExtension('chat-a').factory(pi);
	const context = { model: { provider: 'provider', id: 'model' } };
	handlers.get('session_start')?.({}, context);
	assert.deepEqual(frontChatModel('chat-a'), { provider: 'provider', id: 'model' });
	assert.equal(frontChatModel('chat-b'), undefined);
	context.model = { provider: 'provider', id: 'new-model' };
	assert.deepEqual(frontChatModel('chat-a'), { provider: 'provider', id: 'new-model' });
});

test('an expired session context does not fail a profile operation', () => {
	const handlers = new Map<string, (...args: unknown[]) => void>();
	const pi = { on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler) } as unknown as ProfilesPi;
	agentProfilesExtension('chat-a').factory(pi);
	handlers.get('session_start')?.({}, { get model() { throw new Error('session closed'); } });
	assert.equal(frontChatModel('chat-a'), undefined);
});

test('reads session profiles without changing Gentle state and distinguishes no profile from unknown', () => {
	const bindings = new Map([['bound', { name: 'chosen', origin: 'user' }]]);
	const frozen = new Map([['bound', { profile: { name: 'old' } }], ['empty', { profile: { name: 'old' } }], ['inherited', { profile: { name: 'team' } }], ['none', { profile: undefined }]]);
	const startupNone = new Set(['bound', 'empty']);
	const state = { bindings, frozen, startupNone };
	assert.equal(readKnownSessionProfile('bound', state), 'chosen');
	assert.equal(readKnownSessionProfile('empty', state), null);
	assert.equal(readKnownSessionProfile('inherited', state), 'team');
	assert.equal(readKnownSessionProfile('none', state), null);
	assert.equal(readKnownSessionProfile('missing', state), undefined);
	assert.equal(readKnownSessionProfile('empty', state, false), undefined);
	assert.equal(readKnownSessionProfile('bound', state, false), 'chosen');
	assert.equal(bindings.size, 1);
	assert.equal(frozen.size, 4);
	assert.equal(startupNone.size, 2);
});

test('the live chat follows Gentle state when a binding is cleared', async () => {
	const globals = globalThis as Record<symbol, unknown>;
	const bindingKey = Symbol.for('gentle-pi:session-profile-bindings');
	const noneKey = Symbol.for('gentle-pi:session-profile-startup-none');
	const freezeKey = Symbol.for('gentle-pi:session-profile-freeze');
	const original = [globals[bindingKey], globals[noneKey], globals[freezeKey]];
	const bindings = new Map([['session', { name: 'work', origin: 'user' }]]);
	const startupNone = new Set<string>();
	try {
		globals[bindingKey] = bindings;
		globals[noneKey] = startupNone;
		globals[freezeKey] = { frozen: new Map([['session', { profile: { name: 'old' } }]]) };
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const pi = { on: (event: string, handler: (...args: unknown[]) => void) => { handlers.set(event, handler); } } as ProfilesPi;
		agentProfilesExtension('chat').factory(pi);
		handlers.get('session_start')?.({}, { sessionManager: { getSessionId: () => 'session' } });
		const { frontChatProfile } = await import('../src/agent-profiles-live.ts');
		assert.equal(frontChatProfile(), 'work');
		bindings.delete('session');
		startupNone.add('session');
		assert.equal(frontChatProfile(), null);
	} finally {
		for (const [index, key] of [bindingKey, noneKey, freezeKey].entries()) {
			if (original[index] === undefined) { delete globals[key]; } else { globals[key] = original[index]; }
		}
	}
});

test('credential changes refresh only internal live sessions without network and deduplicate registries', async () => {
	const calls: unknown[] = [];
	const registry = { refresh: async (options: unknown) => { calls.push(options); return { aborted: false, errors: new Map() }; } };
	const external = { refresh: async () => { throw new Error('external profile was accessed'); } };
	for (const [key, profile] of [['one', 'internal'], ['two', 'internal'], ['other', 'external']]) {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const pi = { on: (event: string, handler: (...args: unknown[]) => void) => { handlers.set(event, handler); } } as ProfilesPi;
		agentProfilesExtension(key, profile).factory(pi);
		handlers.get('session_start')?.({}, { modelRegistry: profile === 'internal' ? registry : external });
	}
	assert.equal(await refreshLiveCredentials('internal'), true);
	assert.deepEqual(calls, [{ allowNetwork: false }]);
});

test('a failed credential refresh is reported without exposing the error', async () => {
	const handlers = new Map<string, (...args: unknown[]) => void>();
	const pi = { on: (event: string, handler: (...args: unknown[]) => void) => { handlers.set(event, handler); } } as ProfilesPi;
	agentProfilesExtension('one', 'internal').factory(pi);
	handlers.get('session_start')?.({}, { modelRegistry: { refresh: () => { throw new Error('private credential'); } } });
	assert.equal(await refreshLiveCredentials('internal'), false);
});

interface FakeSession {
	readonly pi: ProfilesPi;
	readonly applied: Array<{ profile: string; mode: string; confirmation?: string; context: object }>;
	start(): void;
	turn(): void;
	stop(): void;
}

/** A session whose Gentle answers like `gentle-ai.ts`: asks once, then applies with the right token. */
function fakeSession(chatKey: string, options: { gentle?: boolean; asks?: boolean } = {}): FakeSession {
	const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
	const applied: FakeSession['applied'] = [];
	const context = { chat: chatKey };
	const listeners = new Map<string, (payload: unknown) => void>();
	if (options.gentle !== false) {
		listeners.set('gentle:desktop:profiles-service', payload => {
			const request = payload as { context: object; respond(service: unknown): void };
			request.respond({
				schema: 'gentle-pi.desktop-profiles-service/v1',
				apply: async (call: { profile: string; mode: string; confirmation?: string }) => {
					if (call.profile === 'missing') {
						return { status: 'unknown_profile' };
					}
					if (options.asks !== false && call.confirmation !== `token-${call.profile}`) {
						return { status: 'confirmation_required', title: 'Make default?', message: '2 agents change model', confirmation: `token-${call.profile}` };
					}
					applied.push({ ...call, context: request.context });
					return { status: 'applied', notes: [{ level: 'info', text: `Using ${call.profile}` }] };
				},
				dispose: () => undefined,
			});
		});
	}
	const pi: ProfilesPi = {
		on: (event: string, handler: (...args: unknown[]) => void) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		events: { emit: (channel, payload) => listeners.get(channel)?.(payload) },
	} as ProfilesPi;
	agentProfilesExtension(chatKey).factory(pi);
	const fire = (event: string, ...args: unknown[]) => { for (const handler of handlers.get(event) ?? []) { handler(...args); } };
	return { pi, applied, start: () => fire('session_start', {}, context), turn: () => fire('before_agent_start'), stop: () => fire('session_shutdown') };
}

test('without a running chat nothing can be applied right now', async () => {
	assert.equal(hasLiveSession(), false);
	assert.deepEqual(await applyAgentProfile('work', 'default'), { status: 'unavailable' });
});

test('Gentle\'s confirmation comes back to the caller, and the token applies it', async () => {
	const session = fakeSession('a');
	session.start();
	const first = await applyAgentProfile('work', 'default');
	assert.equal(first.status, 'confirmation_required');
	assert.equal(session.applied.length, 0, 'nothing applied before the owner confirms');
	const second = await applyAgentProfile('work', 'default', first.status === 'confirmation_required' ? first.confirmation : undefined);
	assert.deepEqual(second, { status: 'applied', notes: [{ level: 'info', text: 'Using work' }] });
	assert.deepEqual(session.applied.map(call => [call.profile, call.mode]), [['work', 'default']]);
});

test('an already-made choice applies without asking', async () => {
	const session = fakeSession('a');
	session.start();
	assert.equal((await applyConfirmed('cheap', 'session')).status, 'applied');
	assert.deepEqual(session.applied.map(call => [call.profile, call.mode]), [['cheap', 'session']]);
});

test('it applies in the chat used last', async () => {
	const first = fakeSession('a', { asks: false });
	const second = fakeSession('b', { asks: false });
	first.start();
	second.start();
	first.turn();
	await applyAgentProfile('work', 'session');
	assert.deepEqual(first.applied.map(call => call.context), [{ chat: 'a' }]);
	assert.equal(second.applied.length, 0);
});

test('a specified chat stays the target even when another chat was used more recently', async () => {
	const first = fakeSession('a', { asks: false });
	const second = fakeSession('b', { asks: false });
	first.start();
	second.start();
	assert.equal((await applyAgentProfile('work', 'session', undefined, 'a')).status, 'applied');
	assert.equal(first.applied.length, 1);
	assert.equal(second.applied.length, 0);
	assert.equal((await applyAgentProfile('work', 'session', undefined, 'missing')).status, 'unavailable');
	assert.equal(second.applied.length, 0);
});

test('a chat that ended is not used', async () => {
	const session = fakeSession('a', { asks: false });
	session.start();
	session.stop();
	assert.equal(hasLiveSession(), false);
	assert.deepEqual(await applyAgentProfile('work', 'default'), { status: 'unavailable' });
});

test('a session without Gentle answers unavailable instead of waiting forever', async () => {
	const session = fakeSession('a', { gentle: false });
	session.start();
	assert.deepEqual(await applyAgentProfile('work', 'default'), { status: 'unavailable' });
});

test('Gentle\'s refusals are passed on as they are', async () => {
	const session = fakeSession('a', { asks: false });
	session.start();
	assert.deepEqual(await applyAgentProfile('missing', 'default'), { status: 'unknown_profile' });
});

test('a default chosen while no chat runs is applied when the next chat starts', async () => {
	deferDefault('team');
	const session = fakeSession('a');
	session.start();
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.deepEqual(session.applied.map(call => [call.profile, call.mode]), [['team', 'default']]);
	const again = fakeSession('b');
	again.start();
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(again.applied.length, 0, 'only once');
});

test('the chat in front remembers the profile it was moved to', async () => {
	const { frontChatProfile } = await import('../src/agent-profiles-live.ts');
	const session = fakeSession('a', { asks: false });
	session.start();
	assert.equal(frontChatProfile(), undefined);
	await applyAgentProfile('cheap', 'session');
	assert.equal(frontChatProfile(), 'cheap');
	await applyAgentProfile('missing', 'session');
	assert.equal(frontChatProfile(), 'cheap', 'a refused profile changes nothing');
});
