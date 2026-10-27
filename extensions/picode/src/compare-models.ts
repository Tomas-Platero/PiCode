/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Comparing models: the same question put to several models, the answers side by side.
 *
 * Each model answers in its own throwaway pi session — read-only tools, nothing written to the
 * conversation list, nothing changed on disk — so a comparison can never leave a mess behind.
 * This file is the part that decides how the runs are started and how the result reads; the
 * sessions themselves are built where the chat's pi lives (`agent.ts`).
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

/** The fewest and most models one comparison takes: one is not a comparison, many are noise. */
export const MIN_COMPARED_MODELS = 2;
export const MAX_COMPARED_MODELS = 4;

/** What one model produced for the question. */
export interface ComparedAnswer {
	/** The model, as `provider/model`. */
	readonly model: string;
	/** What it answered; empty when it failed. */
	readonly text: string;
	/** How long it took, in milliseconds. */
	readonly durationMs: number;
	/** Why it has no answer, in words for the owner. */
	readonly problem?: string;
}

/** Runs one model on the question. Resolves with its text; rejects with the reason it failed. */
export type RunOneModel = (model: string, signal: AbortSignal) => Promise<string>;

/**
 * Asks every model at once and waits for all of them. A model that fails does not take the
 * others down: its row carries the problem and the rest still answer.
 */
export async function compareModels(
	models: readonly string[],
	runOne: RunOneModel,
	signal: AbortSignal,
	now: () => number = Date.now,
): Promise<readonly ComparedAnswer[]> {
	return Promise.all(models.map(async (model): Promise<ComparedAnswer> => {
		const started = now();
		try {
			const text = (await runOne(model, signal)).trim();
			const durationMs = now() - started;
			return text.length > 0
				? { model, text, durationMs }
				: { model, text: '', durationMs, problem: 'It did not answer.' };
		} catch (error) {
			return {
				model,
				text: '',
				durationMs: now() - started,
				problem: signal.aborted ? 'Stopped before it answered.' : error instanceof Error ? error.message : String(error),
			};
		}
	}));
}

/** "4.2s" or "1m 05s": the shortest words that are still true. */
export function durationLabel(durationMs: number): string {
	const seconds = Math.max(0, durationMs) / 1000;
	if (seconds < 60) {
		return `${seconds.toFixed(1)}s`;
	}
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${String(Math.round(seconds - minutes * 60)).padStart(2, '0')}s`;
}

/** The comparison as one document: the question, then one section per model, fastest first. */
export function renderComparison(question: string, answers: readonly ComparedAnswer[]): string {
	const answered = answers.filter(answer => answer.problem === undefined).toSorted((a, b) => a.durationMs - b.durationMs);
	const failed = answers.filter(answer => answer.problem !== undefined);
	const lines = [
		'# Model comparison',
		'',
		`> ${question.trim().split('\n').join('\n> ')}`,
		'',
	];
	if (answered.length > 0) {
		lines.push('| Model | Time | Length |', '| --- | --- | --- |');
		for (const answer of answered) {
			lines.push(`| ${answer.model} | ${durationLabel(answer.durationMs)} | ${answer.text.length} characters |`);
		}
		lines.push('');
	}
	for (const answer of answered) {
		lines.push(`## ${answer.model}`, '', answer.text, '');
	}
	for (const answer of failed) {
		lines.push(`## ${answer.model}`, '', `⚠️ ${answer.problem}`, '');
	}
	return lines.join('\n');
}
