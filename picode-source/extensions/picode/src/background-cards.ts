/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The work the agent left running in the background, as a chat card.
 *
 * The agent's own `background` tool starts a long command and returns at once; its result says
 * which job it became, and when the command ends the result arrives as a **message** into the
 * conversation. So a job has two ends, both of them in the transcript, and a person watching the
 * chat should be able to see the first one **as work** — «¿hay alguna forma de que yo vea ese
 * background?» — instead of a collapsed tool row, and see the second one as the same work
 * finishing.
 *
 * The card is the shape the chat already draws for a delegation (`vscode.ChatSubagentToolInvocationData`,
 * the one `durable-cards.ts` uses), with the job's own identity on it: the label the agent gave it,
 * the command, the job number, and — at the end — the exit code and the tail of its output.
 *
 * Both ends are read from what is really there: the tool's arguments (`label`, `command`) and the
 * completion message the running environment injects (`customType`, `details`). Nothing is guessed —
 * a message that is not one of those produces no card at all.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

/** The tool whose calls and completions become a card. */
export const BACKGROUND_TOOL = 'background';

/** The completion message's own type, as the environment that runs the jobs marks it. */
export const BACKGROUND_COMPLETION_TYPE = 'specpi-background';

/** The longest a command or an output tail gets in a card: a pointer, not a transcript. */
export const CARD_COMMAND_CHARS = 300;
export const CARD_TAIL_CHARS = 1200;

/** A JSON object from an unknown value, or `undefined` when it is not one. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

/**
 * A JSON object from an unknown value that may have crossed a boundary.
 *
 * It arrives parsed when the caller is the one that made the call, but **serialised** when it has been
 * through one: the same call that reads `{command, label}` in the transcript read as
 * `'{"command":…,"label":…}'` by an editor-side observer — and the card drawn from that second shape
 * was an empty one. Both are accepted; a string that is not JSON is simply not arguments.
 */
function objectOf(value: unknown): Record<string, unknown> | undefined {
	const direct = recordOf(value);
	if (direct !== undefined) {
		return direct;
	}
	if (typeof value !== 'string') {
		return undefined;
	}
	try {
		return recordOf(JSON.parse(value));
	} catch {
		return undefined;
	}
}

/** A non-empty string from an unknown value, or `undefined`. */
function textOf(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** A string capped for a card, with an ellipsis where it was cut. */
function cardText(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Whether a tool call is the agent leaving something running in the background. */
export function isBackgroundTool(toolName: unknown): boolean {
	return toolName === BACKGROUND_TOOL;
}

/** What a `background` call carries: the command it starts and the label the agent gave it. */
export interface BackgroundCall {
	/** The label, which is what the job is called from then on (the completion repeats it). */
	readonly label?: string;
	/** The command, as the card shows it. */
	readonly command?: string;
}

/** The call's own arguments, read as the tool documents them. */
export function backgroundCallOf(args: unknown): BackgroundCall {
	const record = objectOf(args);
	const label = textOf(record?.['label']);
	const command = textOf(record?.['command']);
	return {
		...(label === undefined ? {} : { label }),
		...(command === undefined ? {} : { command: cardText(command, CARD_COMMAND_CHARS) }),
	};
}

/**
 * A start's result, read for the two things it knows: which job it became, and what it is called.
 *
 * `Started background job 3 (web lint + type-check). It keeps running…` — the number ties the two ends
 * together, and the label is the very one the call carried, repeated by the tool. That repetition is
 * what lets the card stand up when the call's own arguments are not reachable from where it is drawn.
 */
export function backgroundStartOf(resultText: unknown): { jobNumber?: string; label?: string } {
	const text = textOf(resultText);
	const match = text === undefined ? null : /^Started background job\s+(\S+?)\s*(?:\((.+)\))?\./.exec(text);
	if (match === null) {
		return {};
	}
	const label = textOf(match[2]);
	return {
		jobNumber: match[1],
		...(label === undefined ? {} : { label }),
	};
}

/** The job number a start's result names, when it names one. */
export function backgroundJobNumberOf(resultText: unknown): string | undefined {
	return backgroundStartOf(resultText).jobNumber;
}

/**
 * The text a tool result carries, whichever of the shapes the framework hands over.
 *
 * Same tolerance as the durable cards' own reader, and for the same reason: a result travels as a list
 * of typed parts, and a card without the job's number is a card that cannot be tied to its ending.
 */
export function backgroundResultOf(result: unknown): string | undefined {
	const record = objectOf(result);
	const content = record === undefined ? result : record['content'];
	if (typeof content === 'string') {
		return textOf(content);
	}
	if (!Array.isArray(content)) {
		return undefined;
	}
	const text = content
		.map(part => {
			const partRecord = recordOf(part);
			return partRecord?.['type'] === 'text' && typeof partRecord['text'] === 'string' ? partRecord['text'] : '';
		})
		.filter(part => part.length > 0)
		.join('\n');
	return text.length === 0 ? undefined : text;
}

/** One finished job, as the completion message describes it. */
export interface BackgroundCompletion {
	/** The job's id, as the message's structured details carry it (the same one the start named). */
	readonly id?: string;
	/** The label, read from the message's own first line — the one the start used. */
	readonly label?: string;
	/** The exit code, when the details carry one. */
	readonly exitCode?: number;
	/** Whether it exited on its own (`exited`) or was killed, as the details say. */
	readonly state?: string;
	/** The command the job ran, read from the message's own `Command:` line. */
	readonly command?: string;
	/** The first line, which is the whole sentence the card leads with. */
	readonly summary: string;
	/** The tail of the output, when the message carries one. */
	readonly tail?: string;
}

/**
 * A completion message, read as a job's ending — or `undefined` for any other message.
 *
 * The type is the marker: only the environment's own completion messages carry it, so a message the
 * owner typed (or an agent's answer that happens to mention a job) cannot become a card.
 */
export function backgroundCompletionOf(message: unknown): BackgroundCompletion | undefined {
	const record = objectOf(message);
	if (record?.['customType'] !== BACKGROUND_COMPLETION_TYPE) {
		return undefined;
	}
	const content = textOf(record['content']);
	if (content === undefined) {
		return undefined;
	}
	const details = recordOf(record['details']);
	const id = details === undefined ? undefined : textOf(details['id']);
	const state = details === undefined ? undefined : textOf(details['state']);
	const exitCode = details === undefined ? undefined : details['exitCode'];
	const firstLine = content.split('\n')[0];
	const labelMatch = /^Background job\s+\S+\s*\((.+)\)/.exec(firstLine);
	const tailMarker = content.indexOf('Last lines of output:');
	const commandLine = content.split('\n').find(line => line.startsWith('Command: '));
	return {
		...(id === undefined ? {} : { id }),
		...(labelMatch === null ? {} : { label: labelMatch[1] }),
		...(typeof exitCode === 'number' && Number.isFinite(exitCode) ? { exitCode } : {}),
		...(state === undefined ? {} : { state }),
		...(commandLine === undefined ? {} : { command: cardText(commandLine.slice('Command: '.length).trim(), CARD_COMMAND_CHARS) }),
		summary: firstLine,
		...(tailMarker === -1 ? {} : { tail: cardText(content.slice(tailMarker + 'Last lines of output:'.length).trim(), CARD_TAIL_CHARS) }),
	};
}

/** The sentence a card shows while a job is still running. */
export function runningResultLine(jobNumber: string | undefined): string {
	return jobNumber === undefined ? 'running' : `running · job ${jobNumber}`;
}

/** The sentence a card shows when the job is over. */
export function finishedResultLine(completion: BackgroundCompletion): string {
	const parts: string[] = [];
	if (completion.state !== undefined) {
		parts.push(completion.state);
	}
	if (completion.exitCode !== undefined) {
		parts.push(`exit ${completion.exitCode}`);
	}
	if (parts.length === 0) {
		parts.push('finished');
	}
	return parts.join(' · ');
}

/** Whether a finished job failed, as its exit code says. */
export function completionFailed(completion: BackgroundCompletion): boolean {
	return completion.exitCode !== undefined && completion.exitCode !== 0;
}
