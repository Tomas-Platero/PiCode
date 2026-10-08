/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The agent's background jobs that are still running, as one list.
 *
 * The agent's `background` tool returns at once, and the job's ending arrives later as a
 * message into the conversation (`background-cards.ts` draws both ends as chat cards). This
 * is the third view of the same facts: the jobs **running right now**, for the pill above
 * the chat input — the answer to "how much work did I leave running?" without opening the
 * transcript.
 *
 * A job enters when its start names it ("Started background job 3 (web lint). It keeps
 * running…") and leaves when its completion message says it ended. The tie between the two
 * ends is the job's **number**, with the label as the fallback the completion repeats; a
 * completion that names neither an open job nor a known label is ignored, because removing
 * a job on an unrelated message would be the pill claiming work stopped that did not.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

/** One background job from its start until its completion. */
export interface BackgroundJob {
	/** The job's number, as the start's result named it ("Started background job 3"). */
	readonly jobNumber: string;
	/** The label the agent gave the job, when it gave one. */
	readonly label?: string;
	/** The command, capped to what a card shows; the pill shows this, not a transcript. */
	readonly command?: string;
	/** When the start was seen, in the same clock the caller passed in. */
	readonly startedAt: number;
}

/** What a job's start carries: the number and the call's own facts. */
export interface BackgroundJobStart {
	readonly jobNumber: string;
	readonly label?: string;
	readonly command?: string;
}

/** What a job's completion carries, reduced to what closes a job. */
export interface BackgroundJobCompletion {
	/** The job's id, as the completion message's details carry it. */
	readonly id?: string;
	/** The label, read from the completion message's first line. */
	readonly label?: string;
	/** The command the job ran, read from the message's `Command:` line. */
	readonly command?: string;
}

/** A JSON object from an unknown value, or `undefined` when it is not one. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

/** A non-empty string from an unknown value, or `undefined`. */
function textOf(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The jobs still running, kept by one window's agent.
 *
 * The tracker holds **facts seen**, not promises: it only knows a job started when the
 * transcript said so, which is exactly what the pill may claim. Jobs whose ends arrive are
 * removed; nothing expires on a timer, because a job the pill forgets would read as "the
 * work is done" when it never said so.
 */
export class BackgroundJobTracker {
	private readonly jobs = new Map<string, BackgroundJob>();

	/**
	 * Records a job's start. A start without a number cannot be closed by a completion
	 * (nothing ties the ends together), so it is not a trackable job and is dropped.
	 */
	start(start: BackgroundJobStart, startedAt: number): void {
		if (start.jobNumber.length === 0) {
			return;
		}
		this.jobs.set(start.jobNumber, {
			jobNumber: start.jobNumber,
			...(start.label === undefined ? {} : { label: start.label }),
			...(start.command === undefined ? {} : { command: start.command }),
			startedAt,
		});
	}

	/**
	 * Closes the job a completion describes, if one is open.
	 *
	 * The completion's `id` is matched against the starts' job numbers first; when there is
	 * no such job, the completion's label and command are matched against the open jobs'
	 * — the two facts a completion repeats from its start. The first matching job closes.
	 */
	complete(completion: BackgroundJobCompletion): void {
		if (completion.id !== undefined && this.jobs.has(completion.id)) {
			this.jobs.delete(completion.id);
			return;
		}
		for (const [jobNumber, job] of this.jobs) {
			const labelMatches = completion.label !== undefined && completion.label === job.label;
			const commandMatches = completion.command !== undefined && completion.command === job.command;
			if (labelMatches || commandMatches) {
				this.jobs.delete(jobNumber);
				return;
			}
		}
	}

	/** The jobs still running, oldest first — the order the pill shows. */
	list(): readonly BackgroundJob[] {
		return [...this.jobs.values()].toSorted((a, b) => a.startedAt - b.startedAt);
	}

	/** Whether nothing is running — the pill's reason to hide. */
	isEmpty(): boolean {
		return this.jobs.size === 0;
	}

	/** Forgets every job: the session they belonged to is gone. */
	clear(): void {
		this.jobs.clear();
	}
}

/**
 * The job's start from a `background` tool result, or `undefined` for any other result.
 *
 * The result's own sentence is the source: "Started background job 3 (web lint). It keeps
 * running…" — the same words the start card reads (`background-cards.ts`), so the pill and
 * the card can never disagree about which jobs exist.
 */
export function backgroundJobStartOf(resultText: string | undefined): BackgroundJobStart | undefined {
	const text = textOf(resultText);
	const match = text === undefined ? null : /^Started background job\s+(\S+?)\s*(?:\((.+)\))?\./.exec(text);
	if (match === null) {
		return undefined;
	}
	const label = textOf(match[2]);
	return {
		jobNumber: match[1],
		...(label === undefined ? {} : { label }),
	};
}

/** The row the pill is told about for one running job, without internal paths. */
export interface BackgroundJobRow {
	readonly jobNumber: string;
	readonly label?: string;
	readonly command?: string;
	/** When the start was seen, in the same clock the caller passed in; the pill reads elapsed from it. */
	readonly startedAt: number;
}

/** The answer for the pill: every open job, oldest first. */
export function backgroundJobRows(jobs: readonly BackgroundJob[], _now: number): readonly BackgroundJobRow[] {
	return jobs.map(job => ({
		jobNumber: job.jobNumber,
		...(job.label === undefined ? {} : { label: job.label }),
		...(job.command === undefined ? {} : { command: job.command }),
		startedAt: job.startedAt,
	}));
}

export { recordOf, textOf };
