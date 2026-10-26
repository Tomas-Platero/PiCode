/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What one of Gentle's agents did, as a page to read.
 *
 * Gentle keeps a record per agent task (`<profile>/gentle-agents/tasks/<id>.json`) and, while a task
 * runs, publishes the same shape with its latest steps. This reads either into one model — the task,
 * the steps in order, the answer — and draws it as HTML for a panel. Nothing here invents a step:
 * what the record does not hold is not shown.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

/** The longest a tool's output or arguments are shown, so a page stays readable. */
const OUTPUT_LIMIT = 4_000;
const ARGS_LIMIT = 240;

/** A task id is a file name: nothing that could point outside the tasks folder. */
export function isTaskId(id: unknown): id is string {
	return typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
}

export type Step =
	| { readonly kind: 'text' | 'thinking' | 'note'; readonly text: string }
	| { readonly kind: 'tool'; readonly name: string; readonly args: string; readonly output: string; readonly running: boolean; readonly isError: boolean };

export interface Transcript {
	readonly agent: string;
	readonly label: string;
	readonly status: string;
	readonly model: string;
	readonly thinking: string;
	readonly prompt: string;
	readonly startedAt: number | undefined;
	readonly endedAt: number | undefined;
	readonly steps: readonly Step[];
	/** How many of the first steps the record no longer holds. */
	readonly dropped: number;
	readonly result: string;
	readonly error: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function stamp(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function clip(value: string, limit: number): string {
	const flat = value.trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit).trimEnd()}…`;
}

/** The model of one record (gentle's file, or what it last published for a task still running); `undefined` when it is not one. */
export function transcriptOf(parsed: unknown): Transcript | undefined {
	const task = record(record(parsed)?.['task']);
	if (task === undefined) {
		return undefined;
	}
	const thread = record(record(parsed)?.['thread']);
	const steps: Step[] = [];
	for (const raw of Array.isArray(thread?.['items']) ? thread['items'] as unknown[] : []) {
		const item = record(raw);
		if (item === undefined) {
			continue;
		}
		const kind = item['kind'];
		if (kind === 'text' || kind === 'thinking' || kind === 'note') {
			const said = text(item['text']).trim();
			if (said.length > 0) {
				steps.push({ kind, text: said });
			}
		} else if (kind === 'tool') {
			const args = item['args'];
			steps.push({
				kind: 'tool',
				name: text(item['name']) || 'tool',
				args: args === undefined ? '' : clip(typeof args === 'string' ? args : JSON.stringify(args), ARGS_LIMIT),
				output: clip(text(item['output']), OUTPUT_LIMIT),
				running: item['running'] === true,
				isError: item['isError'] === true,
			});
		}
	}
	const dropped = thread?.['dropped'];
	return {
		agent: text(task['agent']) || 'Agent',
		label: text(task['label']),
		status: text(task['status']),
		model: text(task['model']),
		thinking: text(task['thinking']),
		prompt: text(task['prompt']).trim(),
		startedAt: stamp(task['startedAt']),
		endedAt: stamp(task['endedAt']),
		steps,
		dropped: typeof dropped === 'number' && dropped > 0 ? dropped : 0,
		result: text(task['result']).trim(),
		error: text(task['error']).trim(),
	};
}

/** A record read from text: gentle's task file. */
export function transcriptOfJson(json: string): Transcript | undefined {
	try {
		return transcriptOf(JSON.parse(json));
	} catch {
		return undefined;
	}
}

/** Whether the task is still going: its page keeps updating, and its clock keeps running. */
export function isRunning(status: string): boolean {
	return status === 'running' || status === 'queued' || status === 'waiting';
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
	running: 'Working',
	queued: 'Waiting to start',
	waiting: 'Waiting',
	completed: 'Done',
	failed: 'Failed',
	cancelled: 'Stopped',
	timed_out: 'Timed out',
};

export function statusWord(status: string): string {
	return STATUS_WORDS[status] ?? status;
}

/** `35s` / `2m 5s`. */
export function elapsed(startedAt: number | undefined, endedAt: number | undefined, now: number): string | undefined {
	if (startedAt === undefined) {
		return undefined;
	}
	const seconds = Math.max(0, Math.round(((endedAt ?? now) - startedAt) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Turns markdown into HTML (the editor's own renderer); the page escapes the text itself when it is none. */
export type RenderMarkdown = (markdown: string) => Promise<string>;

/**
 * The body of the page: header, task, steps as a timeline, answer, problem. Texts that are
 * markdown go through `render`; everything else is escaped here.
 */
export async function transcriptHtml(transcript: Transcript, render: RenderMarkdown, now: number): Promise<string> {
	const markdown = async (value: string): Promise<string> => {
		try {
			return await render(value);
		} catch {
			return `<pre>${escapeHtml(value)}</pre>`;
		}
	};
	const running = isRunning(transcript.status);
	const took = elapsed(transcript.startedAt, transcript.endedAt, now);
	const pills = [
		`<span class="pill status ${escapeHtml(transcript.status)}"><span class="dot"></span>${escapeHtml(statusWord(transcript.status))}</span>`,
		transcript.model.length > 0 ? `<span class="pill">${escapeHtml(transcript.model)}${transcript.thinking.length > 0 ? ` · ${escapeHtml(transcript.thinking)}` : ''}</span>` : '',
		took === undefined ? '' : `<span class="pill" data-clock${running && transcript.startedAt !== undefined ? ` data-start="${transcript.startedAt}"` : ''}>${escapeHtml(took)}</span>`,
	].join('');
	const parts: string[] = [
		`<header><div class="who">${escapeHtml(transcript.agent)}</div>${transcript.label.length > 0 ? `<div class="what">${escapeHtml(transcript.label)}</div>` : ''}<div class="pills">${pills}</div></header>`,
	];
	if (transcript.prompt.length > 0) {
		parts.push(`<details class="task"><summary>Task</summary><div class="body">${await markdown(transcript.prompt)}</div></details>`);
	}
	const steps: string[] = [];
	if (transcript.dropped > 0) {
		steps.push(`<li class="note">The first ${transcript.dropped} steps are not shown.</li>`);
	}
	for (const step of transcript.steps) {
		switch (step.kind) {
			case 'text':
				steps.push(`<li class="says"><div class="body">${await markdown(step.text)}</div></li>`);
				break;
			case 'thinking':
				steps.push(`<li class="thinks"><details><summary>Thinking</summary><div class="body">${await markdown(step.text)}</div></details></li>`);
				break;
			case 'note':
				steps.push(`<li class="note">${escapeHtml(step.text)}</li>`);
				break;
			case 'tool': {
				const state = step.isError ? 'error' : step.running ? 'running' : 'done';
				steps.push(`<li class="tool ${state}"><div class="call"><span class="name">${escapeHtml(step.name)}</span>${step.args.length > 0 ? `<code class="args">${escapeHtml(step.args)}</code>` : ''}</div>${step.output.length > 0 ? `<details><summary>Output</summary><pre>${escapeHtml(step.output)}</pre></details>` : ''}</li>`);
				break;
			}
		}
	}
	if (steps.length > 0) {
		parts.push(`<section><h2>What it did</h2><ol class="timeline">${steps.join('')}</ol></section>`);
	} else if (running) {
		parts.push('<p class="muted">Getting started…</p>');
	}
	if (transcript.result.length > 0) {
		parts.push(`<section class="answer"><h2>Answer</h2><div class="body">${await markdown(transcript.result)}</div></section>`);
	}
	if (transcript.error.length > 0) {
		parts.push(`<section class="problem"><h2>Problem</h2><p>${escapeHtml(transcript.error)}</p></section>`);
	}
	if (steps.length === 0 && transcript.result.length === 0 && transcript.error.length === 0 && !running) {
		parts.push('<p class="muted">Nothing was recorded for this agent.</p>');
	}
	if (running) {
		parts.push('<p class="live muted">Updating as it works…</p>');
	}
	return parts.join('');
}

/** The page's look, in the editor's own colours so it follows the theme. */
export const TRANSCRIPT_STYLE = `
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 24px 28px 48px; line-height: 1.55; }
.page { max-width: 880px; margin: 0 auto; }
header { margin-bottom: 20px; }
.who { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--vscode-descriptionForeground); }
.what { font-size: 22px; font-weight: 600; margin: 2px 0 10px; }
.pills { display: flex; flex-wrap: wrap; gap: 8px; }
.pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; font-size: 12px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.pill .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.pill.status.running .dot { animation: pulse 1.2s ease-in-out infinite; }
.pill.status.completed { background: var(--vscode-testing-iconPassed, #3fb950); color: #fff; }
.pill.status.failed, .pill.status.timed_out { background: var(--vscode-testing-iconFailed, #f85149); color: #fff; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); margin: 28px 0 12px; font-weight: 600; }
details > summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 12px; user-select: none; }
.task { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 8px; padding: 10px 14px; background: var(--vscode-textBlockQuote-background); }
.task summary { font-weight: 600; font-size: 13px; color: var(--vscode-foreground); }
.timeline { list-style: none; margin: 0; padding: 0 0 0 18px; border-left: 2px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
.timeline > li { position: relative; margin: 0 0 12px; padding-left: 14px; }
.timeline > li::before { content: ''; position: absolute; left: -24px; top: calc(0.775em - 5px); width: 10px; height: 10px; box-sizing: border-box; border-radius: 50%; background: var(--vscode-editor-background); border: 2px solid var(--vscode-descriptionForeground); }
.timeline > li.tool.done::before { border-color: var(--vscode-testing-iconPassed, #3fb950); }
.timeline > li.tool.error::before { border-color: var(--vscode-testing-iconFailed, #f85149); }
.timeline > li.tool.running::before { border-color: var(--vscode-progressBar-background, #0e70c0); border-top-color: transparent; animation: turn .8s linear infinite; }
.timeline > li.tool.done::before { background: var(--vscode-testing-iconPassed, #3fb950); }
.timeline > li.tool.error::before { background: var(--vscode-testing-iconFailed, #f85149); }
.timeline > li.note::before, .timeline > li.thinks::before { opacity: .5; }
.says .body > :first-child, .answer .body > :first-child, .task .body > :first-child { margin-top: 0; }
.says .body > :last-child, .answer .body > :last-child, .task .body > :last-child { margin-bottom: 0; }
.thinks { color: var(--vscode-descriptionForeground); }
.thinks .body { font-style: italic; padding: 6px 0 0; }
.note { color: var(--vscode-descriptionForeground); font-size: 12px; font-style: italic; }
.tool .call { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.tool.error .name { color: var(--vscode-testing-iconFailed, #f85149); }
.tool .name { font-weight: 600; font-family: var(--vscode-editor-font-family); }
.tool .args { font-family: var(--vscode-editor-font-family); font-size: 12px; color: var(--vscode-descriptionForeground); word-break: break-all; background: none; padding: 0; }
.tool details { margin: 4px 0 0; }
pre { background: var(--vscode-textCodeBlock-background); border-radius: 6px; padding: 10px 12px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; max-height: 320px; margin: 6px 0 0; }
.answer { border: 1px solid var(--vscode-focusBorder, var(--vscode-widget-border)); border-radius: 10px; padding: 4px 18px 14px; background: var(--vscode-textBlockQuote-background); }
.answer h2 { color: var(--vscode-foreground); }
.answer table { border-collapse: collapse; margin: 8px 0; }
.answer th, .answer td { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); padding: 4px 10px; text-align: left; }
.problem { border: 1px solid var(--vscode-testing-iconFailed, #f85149); border-radius: 10px; padding: 4px 18px 10px; }
.problem h2 { color: var(--vscode-testing-iconFailed, #f85149); }
.muted { color: var(--vscode-descriptionForeground); }
@keyframes turn { to { transform: rotate(360deg); } }
@keyframes pulse { 50% { opacity: .25; } }
`;
