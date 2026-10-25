// MANUAL, and pure: no daemon, no database, no model — `node --test` runs it directly.
//
//   node --test host/durable/test/streams.test.mjs
//
// REGRESSION (the ordering that made `subscribe` lie and leak): a claim must be counted
// SYNCHRONOUSLY when the conversation's stream is already cached, so that a client leaving while
// another subscribe is still taking its snapshot cannot drop the last reference, stop the stream,
// and leave the newcomer attached to a closed one.
//
// This is asserted here, not through the pipe, because the interleaving is a few hundred
// microseconds wide and shifts with the transcript size (`requireConversation` runs before the
// stream is looked up): a wire test would be a lottery. Here the ordering is the test — nothing is
// awaited between the newcomer's `claim()` and the other client's `giveBack()`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CachedStreams } from '../lib/streams.js';

/** A registry that records what it stopped, so "the stream is really gone" is observable. */
function registry() {
	const stopped = [];
	const reported = [];
	const streams = new CachedStreams({
		stop: async (stream) => { stopped.push(stream.name); },
		onStopError: (conversationId, error) => { reported.push([conversationId, error]); },
	});
	return { streams, stopped, reported };
}

function namedStream(name) {
	return { name };
}

test('a claim taken while another client leaves keeps the stream up', async () => {
	const { streams, stopped } = registry();
	// The tab: the only subscriber, so the conversation's stream is cached with one reference.
	await streams.claim('c1', async () => namedStream('the-tab'));
	assert.equal(streams.size, 1);

	// The panel subscribes: `claim` counts before anything is awaited.
	const newcomer = streams.claim('c1', async () => namedStream('never-created'));

	// The tab leaves in the same turn, before the newcomer's promise is even awaited.
	await streams.giveBack('c1');

	const { holder, reused } = await newcomer;
	assert.equal(reused, true, 'the newcomer must reuse the cached stream');
	assert.equal(holder.stream.name, 'the-tab');
	assert.equal(streams.size, 1, 'the stream must still be cached for the newcomer');
	assert.deepEqual(stopped, [], 'a stream with a live reference must never be stopped');
});

test('a claim whose request dies gives its reference back', async () => {
	const { streams, stopped } = registry();
	await streams.claim('c2', async () => namedStream('only'));

	// What `subscribe` does when it fails after claiming: hand the claim back, then rethrow.
	await streams.claim('c2', async () => namedStream('never-created'));
	await streams.giveBack('c2');
	assert.equal(streams.size, 1, 'one reference is still held');
	assert.deepEqual(stopped, []);

	await streams.giveBack('c2');
	assert.equal(streams.size, 0, 'the last reference must drop the stream');
	assert.deepEqual(stopped, ['only']);
});

test('one claim given back twice never takes the count below zero', async () => {
	const { streams, stopped } = registry();
	await streams.claim('c3', async () => namedStream('first'));
	await streams.giveBack('c3');
	await streams.giveBack('c3'); // an unsubscribe that arrives twice, or for a stream already gone
	await streams.giveBack('c3');
	assert.equal(streams.size, 0);
	assert.deepEqual(stopped, ['first'], 'the stream must be stopped exactly once');
});

test('an unsubscribe with no stream at all is a no-op', async () => {
	const { streams, stopped } = registry();
	await streams.giveBack('never-subscribed');
	assert.equal(streams.size, 0);
	assert.deepEqual(stopped, []);
});

test('a first claim that finds the stream created meanwhile joins it instead of orphaning it', async () => {
	const { streams, stopped } = registry();
	// Two first claims race: the second one finishes creating after the first published its stream.
	let finishSecond;
	const second = streams.claim('c4', () => new Promise((resolve) => {
		finishSecond = () => resolve(namedStream('second-stream'));
	}));
	await streams.claim('c4', async () => namedStream('first-stream'));

	finishSecond();
	const { holder, reused } = await second;
	assert.equal(reused, true);
	assert.equal(holder.stream.name, 'first-stream', 'the published stream must not be overwritten');
	assert.deepEqual(stopped, ['second-stream'], 'the duplicate stream must be stopped, not leaked');
	assert.equal(streams.size, 1);
});

test('a stop that throws is reported, and the stream is still dropped', async () => {
	const streams = new CachedStreams({
		stop: async () => { throw new Error('stop failed'); },
		onStopError: (conversationId, error) => reported.push([conversationId, error.message]),
	});
	const reported = [];
	await streams.claim('c5', async () => namedStream('x'));
	await streams.giveBack('c5');
	assert.equal(streams.size, 0, 'a failing stop must not keep the conversation cached');
	assert.deepEqual(reported, [['c5', 'stop failed']]);
});

test('stopAll drops every cached stream', async () => {
	const { streams, stopped } = registry();
	await streams.claim('a', async () => namedStream('a'));
	await streams.claim('b', async () => namedStream('b'));
	assert.equal(streams.size, 2);
	await streams.stopAll();
	assert.equal(streams.size, 0);
	assert.deepEqual(stopped.sort(), ['a', 'b']);
});
