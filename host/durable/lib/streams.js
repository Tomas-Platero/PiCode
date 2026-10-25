// lib/streams.js — the reference counting behind one cached event stream per conversation.
//
// It lives here, apart from `daemon.js`, because the ordering that matters cannot be tested
// through the pipe: a `subscribe` must claim its reference BEFORE it awaits the snapshot it is
// about to answer with, or a client that unsubscribes meanwhile can drop the last reference,
// stop the stream, and leave the newcomer attached to a stream that is already closed. Driving
// that interleaving from a client is a race of a few hundred microseconds (measured: the window
// shifts with the transcript size, because `requireConversation` runs first); asserting it from
// the wire is a lottery. Asserting it here is a fact: `claim()` counts synchronously when the
// stream is already cached, so there is no await between "found the stream" and "words of it".
//
// `daemon.js` keeps the parts it owns — which conversation, which storage, how the stream is
// started and fanned out — and asks this class only who is holding it.

/** One cached stream: the stream itself, and how many callers are holding it. */
function holderOf(stream) {
	return { stream, refs: 0 };
}

export class CachedStreams {
	#streams = new Map();
	#stop;
	#onStopError;

	/**
	 * @param stop called with the stream when its last reference goes away; its failure is
	 * reported, never thrown, because the caller is already on its way out.
	 * @param onStopError `(conversationId, error)` — one line for the daemon's log.
	 */
	constructor({ stop, onStopError }) {
		this.#stop = stop;
		this.#onStopError = typeof onStopError === 'function' ? onStopError : () => undefined;
	}

	/** How many conversations have a stream right now. `ping` reports this as `streams`. */
	get size() {
		return this.#streams.size;
	}

	/** The cached holder of one conversation, for a caller that needs to read the stream itself. */
	get(conversationId) {
		return this.#streams.get(conversationId);
	}

	/**
	 * Claim one reference, creating the stream with `create()` when nothing is cached.
	 *
	 * The claim is counted **synchronously** on the cached path: whoever awaits this promise
	 * afterwards already holds its reference, so any `giveBack` that lands during that await takes
	 * the count from two to one and leaves the stream up. On the create path there is no stream to
	 * lose yet; the creation is the only await, and the new holder is born with its one reference.
	 */
	claim(conversationId, create) {
		const cached = this.#streams.get(conversationId);
		if (cached !== undefined) {
			cached.refs++;
			return Promise.resolve({ holder: cached, reused: true });
		}
		return this.#create(conversationId, create);
	}

	async #create(conversationId, create) {
		const stream = await create();
		// Two first claims can race here. The one that arrives second must not overwrite (and
		// orphan) the stream the first one just published: it joins it, and the stream it built
		// itself is stopped, since nobody is ever going to receive from it.
		const published = this.#streams.get(conversationId);
		if (published !== undefined) {
			published.refs++;
			await this.#stopSafely(conversationId, stream);
			return { holder: published, reused: true };
		}
		const holder = holderOf(stream);
		holder.refs = 1;
		this.#streams.set(conversationId, holder);
		return { holder, reused: false };
	}

	/**
	 * Give one reference back; at zero the stream is stopped and dropped. Safe for a conversation
	 * with no stream (an `unsubscribe` that arrives before the claim was ever made), and never
	 * takes the count below zero.
	 */
	async giveBack(conversationId) {
		const holder = this.#streams.get(conversationId);
		if (holder === undefined) {
			return;
		}
		holder.refs--;
		if (holder.refs > 0) {
			return;
		}
		this.#streams.delete(conversationId);
		await this.#stopSafely(conversationId, holder.stream);
	}

	/** Stop every cached stream (the daemon is going down). */
	async stopAll() {
		for (const [conversationId, holder] of [...this.#streams]) {
			this.#streams.delete(conversationId);
			await this.#stopSafely(conversationId, holder.stream);
		}
	}

	async #stopSafely(conversationId, stream) {
		try {
			await this.#stop(stream);
		} catch (error) {
			this.#onStopError(conversationId, error);
		}
	}
}
