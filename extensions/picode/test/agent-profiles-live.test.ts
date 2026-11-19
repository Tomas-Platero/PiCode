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
import { agentProfilesExtension, applyAgentProfile, applyConfirmed, deferDefault, hasLiveSession, resetLiveProfiles, type ProfilesPi } from '../src/agent-profiles-live.ts';

afterEach(() => resetLiveProfiles());

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
