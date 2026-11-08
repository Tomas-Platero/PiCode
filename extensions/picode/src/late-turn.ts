/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * A turn pi runs on its own, after the chat's own turn ended: a background job finished and pi
 * reacts to it. The chat's answer is already closed by then, so nothing it did would reach the
 * screen; this collects it into one entry the conversation can show.
 *
 * Nothing is invented: the entry says what set the turn off, the steps pi took, and what it wrote.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

import { gentleJobNoticeOf, type GentleJob } from './background-jobs.ts';
import { l10n } from './l10n.ts';
import { toolProgress } from './progress.ts';

/** The parts of pi's events this reads. */
export interface LateTurnEvent {
	readonly type: string;
	readonly message?: unknown;
	readonly assistantMessageEvent?: { readonly type?: unknown; readonly delta?: unknown };
	readonly toolName?: string;
	readonly args?: unknown;
}

/** One finished turn, ready for the conversation. */
export interface LateTurn {
	/** What set it off, in the words the person reads. */
	readonly request: string;
	/** The steps it took and what it wrote, as Markdown. */
	readonly answer: string;
}

/** The sentence that says what set the turn off. */
export function lateTurnRequest(job: GentleJob | undefined): string {
	if (job === undefined) {
		return l10n.t('The agent continued on its own');
	}
	const name = job.label ?? l10n.t('Background job');
	switch (job.outcome) {
		case 'finished': return l10n.t('Background job finished: {0}', name);
		case 'failed': return l10n.t('Background job failed: {0}', name);
		case 'stopped': return l10n.t('Background job stopped: {0}', name);
		case 'running': return l10n.t('Background job update: {0}', name);
	}
}

/** Follows one session's events and hands back each turn that ran with no chat turn around it. */
export class LateTurnCollector {
	private collecting = false;
	private job: GentleJob | undefined;
	/** The answer so far: steps and text, in the order they happened. */
	private parts: string[] = [];
	private text = '';

	/** What the agent is doing in a late turn right now. */
	activity: string | undefined;

	/** Whether a late turn is running. */
	get running(): boolean {
		return this.collecting;
	}

	/** `chatTurnOpen`: the chat has an answer open for this session, so that answer shows everything. */
	accept(event: LateTurnEvent, chatTurnOpen: boolean): LateTurn | undefined {
		switch (event.type) {
			case 'message_end': {
				// The notice comes before the turn it starts.
				const job = chatTurnOpen ? undefined : gentleJobNoticeOf(event.message);
				if (job !== undefined) {
					this.job = job;
				}
				this.endText();
				return undefined;
			}
			case 'agent_start':
				if (!chatTurnOpen && !this.collecting) {
					this.collecting = true;
				}
				return undefined;
			case 'message_update': {
				const delta = event.assistantMessageEvent;
				if (this.collecting && !chatTurnOpen && delta?.type === 'text_delta' && typeof delta.delta === 'string') {
					this.text += delta.delta;
				}
				return undefined;
			}
			case 'tool_execution_start':
				if (this.collecting && !chatTurnOpen && typeof event.toolName === 'string') {
					this.endText();
					this.activity = toolProgress(event.toolName, event.args);
					this.parts.push(`- ${this.activity}`);
				}
				return undefined;
			case 'agent_settled':
				return this.finish();
			default:
				return undefined;
		}
	}

	private endText(): void {
		const text = this.text.trim();
		this.text = '';
		if (text.length > 0) {
			this.parts.push(`\n${text}\n`);
		}
	}

	private finish(): LateTurn | undefined {
		this.endText();
		const turn = this.collecting && this.parts.length > 0
			? { request: lateTurnRequest(this.job), answer: this.parts.join('\n').trim() }
			: undefined;
		this.collecting = false;
		this.job = undefined;
		this.parts = [];
		this.activity = undefined;
		return turn;
	}
}
