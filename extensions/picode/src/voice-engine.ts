/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * From the microphone to the words, with no native code in sight.
 *
 * The real microphone (node-cpal) and the real recogniser (sherpa-onnx) are handed in, so what
 * lives here — collecting the audio, mixing it to one channel, stopping at the time limit, ignoring
 * a recording too short to hold a word — can be pinned by tests that need neither. The worker
 * process (`voice-worker.ts`) is the only place that plugs the real ones in.
 */

/** The longest a single dictation runs, as Gentle's own dictation does. */
export const MAX_SECONDS = 120;
/** Anything shorter is a stray click, not speech; it is not sent to the recogniser. */
export const MIN_SECONDS = 0.3;

/** Averages interleaved channels into one. Always a new array: the microphone reuses its buffer. */
export function mixToMono(data: Float32Array, channels: number): Float32Array {
	if (channels <= 1) {
		return data.slice();
	}
	const mono = new Float32Array(Math.floor(data.length / channels));
	for (let i = 0; i < mono.length; i++) {
		let sum = 0;
		for (let c = 0; c < channels; c++) {
			sum += data[i * channels + c];
		}
		mono[i] = sum / channels;
	}
	return mono;
}

export interface VoiceInput {
	readonly sampleRate: number;
	start(onSamples: (mono: Float32Array) => void, onError: (error: Error) => void): void;
	stop(): void;
}

export interface VoiceRecognizer {
	transcribe(samples: Float32Array, sampleRate: number): string;
}

export interface DictationResult {
	readonly text: string;
	readonly seconds: number;
	/** The recording ended because it reached the time limit, not because the owner stopped it. */
	readonly cutOff: boolean;
}

export class Dictation {
	private chunks: Float32Array[] = [];
	private count = 0;
	private input: VoiceInput | undefined;
	private cutOff = false;
	private failure: Error | undefined;
	private readonly openInput: () => VoiceInput;
	private readonly recognizer: VoiceRecognizer;
	private readonly onLimit: () => void;
	private readonly maxSeconds: number;

	/** `onLimit` fires once when the time limit is reached; the caller then calls `stop()` for the text. */
	constructor(openInput: () => VoiceInput, recognizer: VoiceRecognizer, onLimit: () => void, maxSeconds: number = MAX_SECONDS) {
		this.openInput = openInput;
		this.recognizer = recognizer;
		this.onLimit = onLimit;
		this.maxSeconds = maxSeconds;
	}

	get listening(): boolean {
		return this.input !== undefined;
	}

	start(): void {
		if (this.input !== undefined) {
			throw new Error('Already listening.');
		}
		this.chunks = [];
		this.count = 0;
		this.cutOff = false;
		this.failure = undefined;
		const input = this.openInput();
		const limit = Math.floor(this.maxSeconds * input.sampleRate);
		this.input = input;
		input.start(samples => {
			if (this.input !== input || this.cutOff) {
				return;
			}
			const take = Math.min(samples.length, limit - this.count);
			if (take > 0) {
				this.chunks.push(take === samples.length ? samples : samples.subarray(0, take));
				this.count += take;
			}
			if (this.count >= limit) {
				this.cutOff = true;
				this.onLimit();
			}
		}, error => { this.failure = error; });
	}

	/** Stops listening and returns what was said. Calling it when nothing is recording returns nothing. */
	stop(): DictationResult {
		const input = this.input;
		if (input === undefined) {
			return { text: '', seconds: 0, cutOff: false };
		}
		this.input = undefined;
		input.stop();
		if (this.failure !== undefined) {
			throw this.failure;
		}
		const seconds = this.count / input.sampleRate;
		if (seconds < MIN_SECONDS) {
			return { text: '', seconds, cutOff: this.cutOff };
		}
		const all = new Float32Array(this.count);
		let offset = 0;
		for (const chunk of this.chunks) {
			all.set(chunk, offset);
			offset += chunk.length;
		}
		this.chunks = [];
		return { text: this.recognizer.transcribe(all, input.sampleRate).trim(), seconds, cutOff: this.cutOff };
	}
}
