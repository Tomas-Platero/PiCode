/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The editor's side of a dictation: start listening, stop, get the words.
 *
 * The listening itself happens in a child process (`voice-worker.ts`). This keeps that process
 * alive between dictations — loading the model takes seconds — and lets it go after a quiet
 * while, since it holds ~800 MB. A worker that dies is not an error to carry around: the next
 * dictation starts a fresh one.
 */

export interface WorkerChannel {
	send(message: Record<string, unknown>): void;
	onMessage(listener: (message: Record<string, unknown>) => void): void;
	onExit(listener: () => void): void;
	kill(): void;
}

export interface DictationOutcome {
	readonly text: string;
	readonly seconds: number;
	/** The recording ended at the time limit instead of when the owner stopped it. */
	readonly cutOff: boolean;
}

export type SessionState = 'idle' | 'loading' | 'listening' | 'transcribing';

interface Waiter {
	readonly accept: Set<string>;
	readonly resolve: (message: Record<string, unknown>) => void;
	readonly reject: (error: Error) => void;
}

export class VoiceSession {
	private worker: WorkerChannel | undefined;
	private loaded = false;
	private current: SessionState = 'idle';
	private waiter: Waiter | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly spawn: () => WorkerChannel;
	private readonly dir: string;
	private readonly onAutoStop: (outcome: DictationOutcome) => void;
	private readonly idleMs: number;

	/**
	 * `onAutoStop` receives the result when the time limit ended a recording — the one case where
	 * nobody called `stop()` to ask for it.
	 */
	constructor(spawn: () => WorkerChannel, dir: string, onAutoStop: (outcome: DictationOutcome) => void, idleMs: number = 5 * 60_000) {
		this.spawn = spawn;
		this.dir = dir;
		this.onAutoStop = onAutoStop;
		this.idleMs = idleMs;
	}

	get state(): SessionState {
		return this.current;
	}

	/** Starts listening. Rejects with words the owner can read, and leaves the session idle. */
	async start(): Promise<void> {
		if (this.current === 'listening' || this.current === 'loading' || this.current === 'transcribing') {
			throw new Error('Dictation is already running.');
		}
		this.clearIdle();
		this.current = 'loading';
		try {
			const worker = this.ensureWorker();
			if (!this.loaded) {
				const ready = this.wait(['ready']);
				worker.send({ type: 'init', dir: this.dir });
				await ready;
				this.loaded = true;
			}
			const listening = this.wait(['listening']);
			worker.send({ type: 'start' });
			await listening;
			this.current = 'listening';
		} catch (err) {
			this.current = 'idle';
			this.armIdle();
			throw err;
		}
	}

	/** Stops listening and returns what was said. */
	async stop(): Promise<DictationOutcome> {
		if (this.current !== 'listening' || this.worker === undefined) {
			return { text: '', seconds: 0, cutOff: false };
		}
		this.current = 'transcribing';
		try {
			const result = this.wait(['result']);
			this.worker.send({ type: 'stop' });
			return this.outcome(await result);
		} finally {
			this.current = 'idle';
			this.armIdle();
		}
	}

	/** Lets go of the worker and the memory it holds. */
	dispose(): void {
		this.clearIdle();
		this.drop(new Error('Dictation was closed.'));
	}

	private ensureWorker(): WorkerChannel {
		if (this.worker !== undefined) {
			return this.worker;
		}
		const worker = this.spawn();
		this.worker = worker;
		this.loaded = false;
		worker.onMessage(message => this.receive(worker, message));
		worker.onExit(() => {
			if (this.worker === worker) {
				this.drop(new Error('The speech engine stopped unexpectedly.'));
			}
		});
		return worker;
	}

	private receive(worker: WorkerChannel, message: Record<string, unknown>): void {
		if (this.worker !== worker) {
			return;
		}
		const type = String(message['type']);
		if (type === 'limit') {
			void this.finishAtLimit();
			return;
		}
		const waiter = this.waiter;
		if (waiter === undefined) {
			return;
		}
		if (type === 'error') {
			this.waiter = undefined;
			waiter.reject(new Error(String(message['message'] ?? 'Dictation failed.')));
		} else if (waiter.accept.has(type)) {
			this.waiter = undefined;
			waiter.resolve(message);
		}
	}

	private async finishAtLimit(): Promise<void> {
		if (this.current !== 'listening') {
			return;
		}
		try {
			this.onAutoStop(await this.stop());
		} catch {
			// The owner will find out on the next press; there is no one waiting to tell now.
		}
	}

	private wait(types: readonly string[]): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			this.waiter = { accept: new Set(types), resolve, reject };
		});
	}

	private outcome(message: Record<string, unknown>): DictationOutcome {
		return { text: String(message['text'] ?? ''), seconds: Number(message['seconds'] ?? 0), cutOff: message['cutOff'] === true };
	}

	private drop(reason: Error): void {
		const worker = this.worker;
		this.worker = undefined;
		this.loaded = false;
		this.current = 'idle';
		const waiter = this.waiter;
		this.waiter = undefined;
		waiter?.reject(reason);
		worker?.kill();
	}

	private armIdle(): void {
		this.clearIdle();
		this.idleTimer = setTimeout(() => { if (this.current === 'idle') { this.drop(new Error('Dictation went idle.')); } }, this.idleMs);
		this.idleTimer.unref?.();
	}

	private clearIdle(): void {
		if (this.idleTimer !== undefined) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
	}
}
