/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
import { readListenAnswer, readPollAnswer } from './picodeSpeechData.js';

const LISTEN_COMMAND = 'picode.voice.listen';
const POLL_COMMAND = 'picode.voice.poll';
const FINISH_COMMAND = 'picode.voice.finish';
const DOWNLOAD_COMMAND = 'picode.voice.download';

/** How often the chat asks what was heard. Short enough that words appear as they are said. */
const POLL_MS = 300;

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
		const end = async (stopListening: boolean) => {
			if (finished) {
				return;
			}
			finished = true;
			clearInterval(timer);
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
				for (const phrase of answer.phrases) {
					emitter.fire({ status: phrase.kind === 'final' ? SpeechToTextStatus.Recognized : SpeechToTextStatus.Recognizing, text: phrase.text });
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
