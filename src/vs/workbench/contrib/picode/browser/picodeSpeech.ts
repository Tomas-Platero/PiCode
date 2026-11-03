/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IKeywordRecognitionSession, ISpeechProvider, ISpeechService, ISpeechToTextEvent, ISpeechToTextSession, ITextToSpeechSession, SpeechToTextStatus } from '../../speech/common/speechService.js';
import { readListenAnswer, readPollAnswer, revealStep } from './picodeSpeechData.js';

const LISTEN_COMMAND = 'picode.voice.listen';
const POLL_COMMAND = 'picode.voice.poll';
const FINISH_COMMAND = 'picode.voice.finish';
const DOWNLOAD_COMMAND = 'picode.voice.download';
const SUBMIT_COMMAND = 'workbench.action.chat.stopListeningAndSubmit';

/** How often the chat asks what was heard. Short enough that words appear as they are said and the microphone follows the voice. */
const POLL_MS = 120;

/** Pace of the typing effect: one step of words every this many milliseconds. */
const REVEAL_MS = 60;

/** How long the microphone may deliver nothing at all before the owner is told. */
const SILENCE_HINT_MS = 4000;

/** Stops by itself after this long without a voice once something was said, or without anything said at all. */
const STOP_AFTER_SPEECH_MS = 4000;
const STOP_WITHOUT_SPEECH_MS = 12000;

/** Meter readings above this count as a voice rather than room noise. */
const VOICE_LEVEL = 0.25;

/** Set on the page while listening: the stylesheet draws the microphone's glow from the level. */
const LISTENING_CLASS = 'picode-voice-listening';
const LEVEL_PROPERTY = '--picode-voice-level';

/**
 * PiCode's own dictation for the chat's microphone.
 *
 * The editor already has the microphone button and the speech service; what it lacks is a provider,
 * because the ones it expects are Microsoft extensions PiCode does not install. This is that
 * provider, and it listens through the connector (the speech engine runs there, in its own
 * process), so nothing leaves the computer.
 *
 * The chat drops everything that arrives after the owner presses stop, so text is handed over
 * phrase by phrase while they talk: the phrase so far as `Recognizing`, a closed one as `Recognized`.
 * Sending the message is never done here — the chat sends only on a pause if the owner turned the
 * speech timeout on, and it is off by default.
 */
class PicodeSpeechProvider implements ISpeechProvider {

	readonly metadata = {
		extension: new ExtensionIdentifier('picode.dictation'),
		displayName: 'PiCode'
	};

	constructor(
		private readonly commandService: ICommandService,
		private readonly notificationService: INotificationService,
	) { }

	createSpeechToTextSession(token: CancellationToken): ISpeechToTextSession {
		const emitter = new Emitter<ISpeechToTextEvent>();
		void this.run(token, emitter);
		return { onDidChange: emitter.event };
	}

	private async run(token: CancellationToken, emitter: Emitter<ISpeechToTextEvent>): Promise<void> {
		let finished = false;
		let startedAt: number | undefined;
		let heardSomething = false;
		let spoke = false;
		let gotText = false;
		let lastVoiceAt = 0;
		let shown = 0;
		let hinted = false;
		// The phrase being heard, and how much of it is on screen so far.
		let target: string[] = [];
		let revealed: string[] = [];
		const body = mainWindow.document.body;
		const showLevel = (level: number | undefined) => {
			if (level === undefined) {
				body.classList.remove(LISTENING_CLASS);
				body.style.removeProperty(LEVEL_PROPERTY);
			} else {
				body.classList.add(LISTENING_CLASS);
				body.style.setProperty(LEVEL_PROPERTY, level.toFixed(2));
			}
		};
		const end = async (stopListening: boolean) => {
			if (finished) {
				return;
			}
			finished = true;
			clearInterval(timer);
			clearInterval(reveal);
			showLevel(undefined);
			if (stopListening) {
				try {
					await this.commandService.executeCommand(FINISH_COMMAND);
				} catch {
					// The engine may already be gone; there is nothing left to stop.
				}
			}
			emitter.fire({ status: SpeechToTextStatus.Stopped });
			emitter.dispose();
		};

		const reveal = setInterval(() => {
			if (finished || target.length === 0) {
				return;
			}
			const next = revealStep(revealed, target);
			if (next.length !== revealed.length || next.some((word, i) => word !== revealed[i])) {
				revealed = [...next];
				emitter.fire({ status: SpeechToTextStatus.Recognizing, text: revealed.join(' ') });
			}
		}, REVEAL_MS);

		let polling = false;
		const timer = setInterval(async () => {
			if (polling || finished) {
				return;
			}
			polling = true;
			try {
				const answer = readPollAnswer(await this.commandService.executeCommand(POLL_COMMAND));
				if (finished) {
					return;
				}
				if (startedAt !== undefined) {
					// Rises fast and falls slowly, so the ring follows the voice without flickering.
					shown = answer.level > shown ? shown + (answer.level - shown) * 0.6 : shown * 0.8;
					showLevel(shown);
					heardSomething ||= answer.level > 0;
					const now = Date.now();
					if (answer.level > VOICE_LEVEL || answer.phrases.length > 0) {
						spoke = true;
						lastVoiceAt = now;
					}
					if (now - (spoke ? lastVoiceAt : startedAt) > (spoke ? STOP_AFTER_SPEECH_MS : STOP_WITHOUT_SPEECH_MS)) {
						// A pause after words sends the message, like pressing send; a pause after only noise just stops.
						if (gotText) {
							await this.commandService.executeCommand(SUBMIT_COMMAND);
						}
						await end(true);
						return;
					}
					if (!heardSomething && !hinted && Date.now() - startedAt > SILENCE_HINT_MS) {
						hinted = true;
						this.notificationService.warn(localize('picodeSpeechSilent', "PiCode can't hear anything from your microphone. Check that it is on and not muted."));
					}
				}
				gotText ||= answer.phrases.length > 0;
				for (const phrase of answer.phrases) {
					if (phrase.kind === 'final') {
						// A closed phrase lands whole; what was being typed is replaced by it.
						target = [];
						revealed = [];
						emitter.fire({ status: SpeechToTextStatus.Recognized, text: phrase.text });
					} else {
						target = phrase.text.split(/s+/);
					}
				}
				if (!answer.active) {
					await end(false);
				}
			} catch {
				await end(false);
			} finally {
				polling = false;
			}
		}, POLL_MS);

		token.onCancellationRequested(() => void end(true));

		let started;
		try {
			started = readListenAnswer(await this.commandService.executeCommand(LISTEN_COMMAND));
		} catch {
			started = readListenAnswer(undefined);
		}
		if (finished) {
			// Cancelled while the engine was loading: let go of the microphone it just took.
			if (started.ok) {
				void this.commandService.executeCommand(FINISH_COMMAND);
			}
			return;
		}
		if (!started.ok) {
			this.explain(started.message, started.needsDownload === true);
			emitter.fire({ status: SpeechToTextStatus.Error, text: started.message });
			await end(false);
			return;
		}
		startedAt = Date.now();
		showLevel(0);
		emitter.fire({ status: SpeechToTextStatus.Started });
	}

	private explain(message: string | undefined, needsDownload: boolean): void {
		if (needsDownload) {
			this.notificationService.prompt(
				Severity.Info,
				localize('picodeSpeechNeedsDownload', "Dictation needs a one-time download (about 700 MB). It runs on your computer."),
				[{ label: localize('picodeSpeechDownload', "Download"), run: () => this.commandService.executeCommand(DOWNLOAD_COMMAND) }],
			);
		} else {
			this.notificationService.error(message ?? localize('picodeSpeechFailed', "Dictation could not start."));
		}
	}

	createTextToSpeechSession(): ITextToSpeechSession {
		// Reading aloud is not offered; the session does nothing.
		return { onDidChange: Event.None, synthesize: async () => undefined };
	}

	createKeywordRecognitionSession(): IKeywordRecognitionSession {
		return { onDidChange: Event.None };
	}
}

class PicodeSpeechContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.picodeSpeech';

	constructor(
		@ISpeechService speechService: ISpeechService,
		@ICommandService commandService: ICommandService,
		@INotificationService notificationService: INotificationService,
	) {
		super();
		// Only where the speech engine has been tried; elsewhere the microphone button stays hidden
		// instead of appearing and then failing.
		if (isWindows) {
			this._register(speechService.registerSpeechProvider('picode', new PicodeSpeechProvider(commandService, notificationService)));
		}
	}
}

registerWorkbenchContribution2(PicodeSpeechContribution.ID, PicodeSpeechContribution, WorkbenchPhase.BlockRestore);
