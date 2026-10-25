/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The one thing the durable surfaces share: "something changed in a conversation just now".
 *
 * The transcript tab is event-driven (`subscribe`), and the Tasks block is polled (every 5 s while
 * it is visible). That difference is by design — the tab is what you are reading, the block is a
 * list you glance at — but it produced a visible lie: a run ended, the tab said `done` at once, and
 * the row kept saying `running` until the next poll. Five seconds of disagreement is a bug when
 * the answer was already known.
 *
 * So the tab announces what it sees and the block listens. No polling is added and no state is
 * kept here: the listener asks its own source again, which is the durable agent itself. A notifier
 * that carried the new state would be a second copy of the truth.
 *
 * Deliberately tiny and dependency-free (no `vscode`), so `node --test` runs it and so either side
 * can be replaced without touching this file.
 */

/** Why a surface is being told; a listener may ignore the reason and simply refresh. */
export type DurableChangeReason = 'run-start' | 'run-end';

type Listener = (reason: DurableChangeReason) => void;

const listeners = new Set<Listener>();

/**
 * Registers a listener and returns the unsubscribe function.
 *
 * Each listener is called inside its own `try`, so one surface's mistake cannot stop the others
 * from hearing the same change.
 */
export function onDurableChange(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Announces a change. Safe to call when nobody is listening, and safe to call twice. */
export function notifyDurableChange(reason: DurableChangeReason): void {
	for (const listener of [...listeners]) {
		try {
			listener(reason);
		} catch {
			// A listener that throws is that listener's problem: the announcement is not its to ruin.
		}
	}
}

/** Only for tests: forgets every listener, so one test's surface cannot leak into the next. */
export function resetDurableChangeListeners(): void {
	listeners.clear();
}
