/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TRANSCRIPT_STYLE, escapeHtml, isRunning, transcriptHtml, type Transcript } from './agent-transcript';

/**
 * One agent's transcript as a panel of its own, kept up to date while the agent works.
 *
 * The panel asks `source` for the agent's record every time `onChange` fires (gentle publishes a
 * push whenever a task moves) and swaps the page's body in place, so what the owner is reading and
 * where they scrolled to stay put. When the page was at the bottom it follows the newest step.
 * A second request for the same agent shows the panel that is already open.
 */

export interface TranscriptPanelOptions {
	/** The agent's task id. */
	readonly id: string;
	/** What the agent has said and done so far, or `undefined` when nothing is known about it. */
	readonly source: () => Transcript | undefined;
	/** Calls `listener` when any task moves; returns how to stop. */
	readonly onChange: (listener: () => void) => () => void;
}

const open = new Map<string, vscode.WebviewPanel>();

/** How long a burst of changes waits before the page is drawn once. */
const REDRAW_MS = 250;

export function showAgentTranscript(options: TranscriptPanelOptions): void {
	const existing = open.get(options.id);
	if (existing !== undefined) {
		existing.reveal(undefined, true);
		return;
	}
	const first = options.source();
	const panel = vscode.window.createWebviewPanel(
		'picode.agentTranscript',
		`${first?.agent ?? 'Agent'}${first !== undefined && first.label.length > 0 ? ` · ${first.label}` : ''}`,
		{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	open.set(options.id, panel);
	const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
	panel.webview.html = shell(nonce, panel.webview.cspSource);

	let timer: ReturnType<typeof setTimeout> | undefined;
	let drawing = false;
	let again = false;
	const draw = async (): Promise<void> => {
		if (drawing) {
			again = true;
			return;
		}
		drawing = true;
		try {
			const transcript = options.source();
			const body = transcript === undefined
				? '<p class="muted">Nothing was recorded for this agent.</p>'
				: await transcriptHtml(transcript, async markdown => String(await vscode.commands.executeCommand('markdown.api.render', markdown)), Date.now());
			await panel.webview.postMessage({ body, running: transcript !== undefined && isRunning(transcript.status) });
		} finally {
			drawing = false;
			if (again) {
				again = false;
				void draw();
			}
		}
	};
	const schedule = (): void => {
		if (timer === undefined) {
			timer = setTimeout(() => { timer = undefined; void draw(); }, REDRAW_MS);
		}
	};
	const stop = options.onChange(schedule);
	// The page asks for its first drawing once its script is ready.
	const messages = panel.webview.onDidReceiveMessage((message: unknown) => {
		if ((message as { ready?: unknown } | null)?.ready === true) {
			void draw();
		}
	});
	panel.onDidDispose(() => {
		stop();
		messages.dispose();
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		open.delete(options.id);
	});
}

function shell(nonce: string, cspSource: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' ${escapeHtml(cspSource)}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">${TRANSCRIPT_STYLE}</style></head>
<body><div class="page" id="root"><p class="muted">Reading…</p></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; };
window.addEventListener('message', (event) => {
	const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
	const open = [...root.querySelectorAll('details')].map(d => d.open);
	root.innerHTML = event.data.body;
	root.querySelectorAll('details').forEach((d, i) => { if (open[i]) { d.open = true; } });
	if (atBottom && event.data.running) { window.scrollTo(0, document.body.scrollHeight); }
});
setInterval(() => {
	document.querySelectorAll('[data-clock][data-start]').forEach(el => { el.textContent = clock(Date.now() - Number(el.dataset.start)); });
}, 1000);
vscode.postMessage({ ready: true });
</script></body></html>`;
}
