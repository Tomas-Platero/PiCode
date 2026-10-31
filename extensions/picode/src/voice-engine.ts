/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * From the microphone to the words, with no native code in sight.
 *
 * The real microphone (node-cpal) and the real recogniser (sherpa-onnx) are handed in, so what
 * lives here — mixing to one channel, telling speech from silence, cutting the audio into phrases,
 * stopping at the time limit — can be pinned by tests that need neither. The worker process
 * (`voice-worker.ts`) is the only place that plugs the real ones in.
 *
 * The recogniser works on a finished piece of audio, not a stream, so a dictation is cut into
 * phrases: while someone talks, the phrase so far is transcribed every second or so and offered as
 * a *partial*; once they pause, the phrase is transcribed one last time and offered as *final*.
 * That is also what the chat expects — it drops anything that arrives after the owner presses stop.
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

export interface LiveOptions {
	/** The whole dictation stops here, as Gentle's does. */
	readonly maxSeconds: number;
	/** This much silence after speech closes a phrase. */
	readonly endSilenceSeconds: number;
	/** While a phrase is open, its text so far is offered this often. */
	readonly partialEverySeconds: number;
	/** A phrase that runs this long is closed even without a pause. */
	readonly maxPhraseSeconds: number;
	/** Quieter than this is never speech, however still the room. */
	readonly minLevel: number;
}

export const LIVE_DEFAULTS: LiveOptions = { maxSeconds: MAX_SECONDS, endSilenceSeconds: 0.7, partialEverySeconds: 0.4, maxPhraseSeconds: 30, minLevel: 0.01 };

export interface LiveHandlers {
	/** The phrase being spoken, as heard so far. Replaces the previous partial. */
	onPartial(text: string): void;
	/** A phrase that has ended. It will not change. */
	onFinal(text: string): void;
	/** The time limit was reached; no more audio is taken. */
	onLimit(): void;
	/** How loud the last tenth of a second was, from 0 (digital silence) to 1. Drives the chat's meter. */
	onLevel?(level: number): void;
}

/** Loudness at which the meter is full; ordinary speech at the microphone lands well below it. */
const FULL_METER_RMS = 0.1;

const WINDOW_SECONDS = 0.1;
const PRE_ROLL_WINDOWS = 3;

function rms(samples: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < samples.length; i++) {
		sum += samples[i] * samples[i];
	}
	return Math.sqrt(sum / Math.max(1, samples.length));
}

function join(parts: readonly Float32Array[], total: number): Float32Array {
	const all = new Float32Array(total);
	let offset = 0;
	for (const part of parts) {
		all.set(part, offset);
		offset += part.length;
	}
	return all;
}

export class LiveDictation {
	private input: VoiceInput | undefined;
	private failure: Error | undefined;
	private pending: Float32Array[] = [];
	private pendingCount = 0;
	private windowSize = 0;
	private sampleRate = 0;
	private total = 0;
	private limitHit = false;
	private noise = 0;
	private preRoll: Float32Array[] = [];
	private phrase: Float32Array[] = [];
	private speaking = false;
	private silentWindows = 0;
	private loudWindows = 0;
	private sinceDecode = 0;
	private lastPartial = '';
	/** How long the last decode took: the next partial waits a few times that, so a slow computer is never starved. */
	private decodeSeconds = 0;
	private readonly openInput: () => VoiceInput;
	private readonly recognizer: VoiceRecognizer;
	private readonly handlers: LiveHandlers;
	private readonly options: LiveOptions;

	constructor(openInput: () => VoiceInput, recognizer: VoiceRecognizer, handlers: LiveHandlers, options: Partial<LiveOptions> = {}) {
		this.openInput = openInput;
		this.recognizer = recognizer;
		this.handlers = handlers;
		this.options = { ...LIVE_DEFAULTS, ...options };
	}

	get listening(): boolean {
		return this.input !== undefined;
	}

	start(): void {
		if (this.input !== undefined) {
			throw new Error('Already listening.');
		}
		this.pending = [];
		this.pendingCount = 0;
		this.total = 0;
		this.limitHit = false;
		this.failure = undefined;
		this.noise = 0;
		this.preRoll = [];
		this.resetPhrase();
		const input = this.openInput();
		this.sampleRate = input.sampleRate;
		this.windowSize = Math.max(1, Math.floor(input.sampleRate * WINDOW_SECONDS));
		this.input = input;
		input.start(samples => {
			if (this.input === input && !this.limitHit) {
				this.feed(samples);
			}
		}, error => { this.failure = error; });
	}

	/** Stops listening. A phrase still open is closed and offered as final first. */
	stop(): void {
		const input = this.input;
		if (input === undefined) {
			return;
		}
		if (!this.limitHit) {
			this.closePhrase();
		}
		this.input = undefined;
		input.stop();
		if (this.failure !== undefined) {
			throw this.failure;
		}
	}

	private feed(samples: Float32Array): void {
		this.pending.push(samples);
		this.pendingCount += samples.length;
		while (this.pendingCount >= this.windowSize && !this.limitHit) {
			const joined = join(this.pending, this.pendingCount);
			const window = joined.slice(0, this.windowSize);
			const rest = joined.subarray(this.windowSize);
			this.pending = rest.length > 0 ? [rest] : [];
			this.pendingCount = rest.length;
			this.window(window);
		}
	}

	private window(window: Float32Array): void {
		const seconds = WINDOW_SECONDS;
		this.total += window.length;
		const level = rms(window);
		// The square root makes a quiet voice move the meter as much as the ear says it should.
		this.handlers.onLevel?.(Math.min(1, Math.sqrt(level / FULL_METER_RMS)));
		// The room's own level is learned only from windows that were not speech, so starting to talk
		// at once is not mistaken for a loud room.
		const loud = level > Math.max(this.options.minLevel, this.noise * 3);
		if (!loud && !this.speaking) {
			this.noise = this.noise * 0.95 + level * 0.05;
		}

		if (!this.speaking) {
			if (loud) {
				this.speaking = true;
				this.phrase = [...this.preRoll, window];
				this.loudWindows = 1;
				this.silentWindows = 0;
				this.sinceDecode = 0;
				this.preRoll = [];
			} else {
				this.preRoll.push(window);
				if (this.preRoll.length > PRE_ROLL_WINDOWS) {
					this.preRoll.shift();
				}
			}
		} else {
			this.phrase.push(window);
			this.sinceDecode++;
			if (loud) {
				this.loudWindows++;
				this.silentWindows = 0;
			} else {
				this.silentWindows++;
			}
			if (this.silentWindows * seconds >= this.options.endSilenceSeconds || this.phrase.length * seconds >= this.options.maxPhraseSeconds) {
				this.closePhrase();
			} else if (this.sinceDecode * seconds >= Math.max(this.options.partialEverySeconds, this.decodeSeconds * 3)) {
				this.sinceDecode = 0;
				const text = this.decode();
				if (text !== '' && text !== this.lastPartial) {
					this.lastPartial = text;
					this.handlers.onPartial(text);
				}
			}
		}

		if (this.total >= Math.floor(this.options.maxSeconds * this.sampleRate) && !this.limitHit) {
			this.closePhrase();
			this.limitHit = true;
			this.handlers.onLimit();
		}
	}

	private decode(): string {
		const length = this.phrase.reduce((sum, w) => sum + w.length, 0);
		const began = Date.now();
		const text = this.recognizer.transcribe(join(this.phrase, length), this.sampleRate).trim();
		this.decodeSeconds = (Date.now() - began) / 1000;
		return text;
	}

	private closePhrase(): void {
		if (this.speaking && this.loudWindows * WINDOW_SECONDS >= MIN_SECONDS) {
			const text = this.decode();
			if (text !== '') {
				this.handlers.onFinal(text);
			}
		}
		this.resetPhrase();
	}

	private resetPhrase(): void {
		this.speaking = false;
		this.phrase = [];
		this.loudWindows = 0;
		this.silentWindows = 0;
		this.sinceDecode = 0;
		this.lastPartial = '';
	}
}
