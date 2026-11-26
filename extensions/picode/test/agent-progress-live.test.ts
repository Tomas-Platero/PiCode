import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentProgressExtension } from '../src/agent-progress-live.ts';

test('observes only the current session and stops after shutdown', () => {
	const handlers = new Map<string, (...args: any[]) => void>();
	let observer: ((id: string) => void) | undefined;
	let disposed = 0;
	let reads = 0;
	const changes: unknown[] = [];
	const began: object[] = [];
	const ended: object[] = [];
	const service = { schema: 'gentle-pi.desktop-agents-service/v1', read: () => { reads++; return { sessionId: 'one', agents: [{ id: 'a', model: 'm', usage: { total: 10 } }] }; }, observe: (fn: (id: string) => void) => { observer = fn; return () => { observer = undefined; }; }, dispose: () => { disposed++; } };
	const pi = { on: (name: string, fn: (...args: any[]) => void) => { handlers.set(name, fn); }, events: { emit: (_: string, request: any) => request.respond(service) } };
	agentProgressExtension(rows => changes.push(rows), source => began.push(source), source => ended.push(source)).factory(pi);
	handlers.get('session_start')!({}, {});
	assert.equal(began.length, 1);
	assert.equal(changes.length, 1);
	observer!('other'); assert.equal(reads, 1);
	observer!('one'); assert.equal(reads, 2);
	const stale = observer!;
	handlers.get('session_shutdown')!();
	stale('one'); assert.equal(reads, 2);
	assert.equal(disposed, 1);
	assert.deepEqual(ended, began);
});

test('missing and malformed services do not interrupt the session', () => {
	const handlers = new Map<string, (...args: any[]) => void>();
	const pi = { on: (name: string, fn: (...args: any[]) => void) => { handlers.set(name, fn); }, events: { emit: (_: string, request: any) => request.respond({ schema: 'bad' }) } };
	agentProgressExtension(() => assert.fail('no update')).factory(pi);
	assert.doesNotThrow(() => handlers.get('session_start')!({}, {}));
	assert.doesNotThrow(() => handlers.get('session_shutdown')!());
});
