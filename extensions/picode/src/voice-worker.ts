/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The process that listens and transcribes.
 *
 * Loading the speech model takes about two seconds and ~800 MB, and a native crash must not take
 * the editor with it, so all of it lives here, in a child of the extension host. The audio never
 * leaves this process: the parent says `start` and `stop` and gets the words back.
 *
 * Messages in:  { type: 'init', dir } · { type: 'start' } · { type: 'stop' }
 * Messages out: { type: 'ready' } · { type: 'listening' } · { type: 'partial', text }
 *               · { type: 'final', text } · { type: 'level', value } · { type: 'limit' } · { type: 'stopped' }
 *               · { type: 'error', message }
 *
 * `readWave` of sherpa-onnx is never used: Electron refuses the external buffers it returns. The
 * audio is handed over as ordinary JavaScript arrays, which is how the microphone delivers it.
 */

import * as path from 'path';
import { LiveDictation, mixToMono, type VoiceInput, type VoiceRecognizer } from './voice-engine';

type Incoming =
	| { readonly type: 'init'; readonly dir: string }
	| { readonly type: 'start' }
	| { readonly type: 'stop' };

interface Sherpa {
	OfflineRecognizer: new (config: unknown) => {
		createStream(): { acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void };
		decode(stream: unknown): void;
		getResult(stream: unknown): { text: string };
	};
}

interface Cpal {
	defaultHost(): { defaultInputDevice(): CpalDevice | null | undefined };
}
interface CpalDevice {
	defaultInputConfig(): { channels(): number; sampleRate(): number };
	buildInputStream(config: unknown, format: string, onData: (data: Float32Array) => void, onError: (e: Error) => void): { play(): void; pause(): void; close(): void };
}

function send(message: Record<string, unknown>): void {
	process.send?.(message);
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

let dictation: LiveDictation | undefined;

function init(dir: string): void {
	const modules = path.join(dir, 'node_modules');
	const model = path.join(dir, 'model');
	const sherpa = require(path.join(modules, 'sherpa-onnx-node')) as Sherpa;
	const cpal = require(path.join(modules, 'node-cpal')) as Cpal;

	const recognizer = new sherpa.OfflineRecognizer({
		featConfig: { sampleRate: 16000, featureDim: 80 },
		modelConfig: {
			transducer: {
				encoder: path.join(model, 'encoder.int8.onnx'),
				decoder: path.join(model, 'decoder.int8.onnx'),
				joiner: path.join(model, 'joiner.int8.onnx'),
			},
			tokens: path.join(model, 'tokens.txt'),
			numThreads: 4,
			provider: 'cpu',
			modelType: 'nemo_transducer',
		},
	});

	const voiceRecognizer: VoiceRecognizer = {
		transcribe(samples, sampleRate) {
			const stream = recognizer.createStream();
			stream.acceptWaveform({ sampleRate, samples });
			recognizer.decode(stream);
			return recognizer.getResult(stream).text;
		},
	};

	const openInput = (): VoiceInput => {
		const device = cpal.defaultHost().defaultInputDevice();
		if (!device) {
			throw new Error('No microphone was found.');
		}
		const config = device.defaultInputConfig();
		const channels = config.channels();
		let stream: ReturnType<CpalDevice['buildInputStream']> | undefined;
		return {
			sampleRate: config.sampleRate(),
			start(onSamples, onError) {
				stream = device.buildInputStream(config, 'f32', data => onSamples(mixToMono(data, channels)), onError);
				stream.play();
			},
			stop() {
				try {
					stream?.pause();
					stream?.close();
				} catch {
					// The device may already be gone; stopping a dead stream is not worth an error.
				}
				stream = undefined;
			},
		};
	};

	dictation = new LiveDictation(openInput, voiceRecognizer, {
		onPartial: text => send({ type: 'partial', text }),
		onFinal: text => send({ type: 'final', text }),
		onLimit: () => send({ type: 'limit' }),
		onLevel: value => send({ type: 'level', value }),
	});
	send({ type: 'ready' });
}

process.on('message', (message: Incoming) => {
	try {
		switch (message.type) {
			case 'init':
				init(message.dir);
				break;
			case 'start':
				if (!dictation) {
					throw new Error('The speech engine is not loaded.');
				}
				dictation.start();
				send({ type: 'listening' });
				break;
			case 'stop': {
				if (!dictation) {
					throw new Error('The speech engine is not loaded.');
				}
				dictation.stop();
				send({ type: 'stopped' });
				break;
			}
		}
	} catch (err) {
		send({ type: 'error', message: errorText(err) });
	}
});
