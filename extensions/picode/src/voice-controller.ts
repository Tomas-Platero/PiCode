/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The one holder of "is dictation downloading right now", so every surface reads the same answer.
 *
 * `voice-install.ts` moves the bytes and knows what is on disk; this keeps the part that lives only
 * while PiCode runs — a download in flight, its progress, the last failure — and turns both into
 * the small shape the status card draws. Starting twice joins the running download instead of
 * opening a second one; cancelling keeps what was fetched.
 */

import type { VoiceInstallResult, VoiceManifest, VoiceProgress, VoiceState } from './voice-install';

export type VoiceStatus =
	| { readonly state: 'unsupported' }
	| { readonly state: 'not-installed'; readonly sizeMb: number; readonly error?: string }
	| { readonly state: 'downloading'; readonly sizeMb: number; readonly percent: number }
	| { readonly state: 'ready' };

/**
 * Whether the editor should start the download now because the setup window asked for it.
 * Only when it was asked for and there is something to fetch: a download already running, or
 * dictation already on the machine, is left alone.
 */
export function shouldDownloadOnStart(asked: boolean, status: VoiceStatus): boolean {
	return asked && status.state === 'not-installed';
}

/** What the controller does to the machine, handed in so it can be exercised without one. */
export interface VoiceOps {
	readonly install: (home: string, manifest: VoiceManifest, onProgress: (p: VoiceProgress) => void, signal: AbortSignal) => Promise<VoiceInstallResult>;
	readonly readState: (home: string, manifest: VoiceManifest | undefined) => VoiceState;
	readonly remove: (home: string) => void;
	readonly downloadSize: (manifest: VoiceManifest) => number;
}

export class VoiceController {
	private running: { readonly controller: AbortController; readonly done: Promise<VoiceInstallResult> } | undefined;
	private percent = 0;
	private lastError: string | undefined;
	private readonly home: string;
	private readonly manifest: VoiceManifest | undefined;
	private readonly ops: VoiceOps;

	constructor(home: string, manifest: VoiceManifest | undefined, ops: VoiceOps) {
		this.home = home;
		this.manifest = manifest;
		this.ops = ops;
	}

	status(): VoiceStatus {
		if (this.manifest === undefined) {
			return { state: 'unsupported' };
		}
		const sizeMb = Math.round(this.ops.downloadSize(this.manifest) / 1_000_000);
		if (this.running !== undefined) {
			return { state: 'downloading', sizeMb, percent: this.percent };
		}
		if (this.ops.readState(this.home, this.manifest).kind === 'ready') {
			return { state: 'ready' };
		}
		return { state: 'not-installed', sizeMb, ...(this.lastError === undefined ? {} : { error: this.lastError }) };
	}

	/** Starts the download, or joins the one already running. */
	start(): Promise<VoiceInstallResult> {
		if (this.manifest === undefined) {
			return Promise.resolve({ ok: false, cancelled: false, message: 'Dictation is not available on this system yet.' });
		}
		if (this.running !== undefined) {
			return this.running.done;
		}
		this.percent = 0;
		this.lastError = undefined;
		const controller = new AbortController();
		const done = this.ops.install(this.home, this.manifest, p => { this.percent = Math.min(100, Math.floor(p.done / p.total * 100)); }, controller.signal)
			.then(result => {
				this.running = undefined;
				this.lastError = result.ok || result.cancelled ? undefined : result.message;
				return result;
			});
		this.running = { controller, done };
		return done;
	}

	/** Stops the download; the partial files stay so the next try continues. */
	cancel(): void {
		this.running?.controller.abort();
	}

	/** Deletes everything dictation put on the machine. Refuses while a download is running. */
	async remove(): Promise<boolean> {
		if (this.running !== undefined) {
			return false;
		}
		this.ops.remove(this.home);
		this.lastError = undefined;
		return true;
	}
}
