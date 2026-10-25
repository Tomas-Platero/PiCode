/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The transcript tab: one durable conversation, read like a conversation.
 *
 * A tab of its own because a transcript is something you read — it needs markdown, collapsible
 * tool output and live updates, and an output channel has none of those. It sits next to the
 * editor's Welcome tab (`ViewColumn.Active`), one per conversation, and a second "Open the
 * transcript" on the same conversation reveals it instead of opening another.
 *
 * ## Who does what
 *
 *  * **The daemon** owns the truth: `subscribe` answers with the snapshot and then pushes events.
 *  * **`durable-transcript-model.ts`** turns entries into rows (and applies events to them).
 *  * **`durable-transcript-markdown.ts`** turns the agent's rows into HTML, escaping first.
 *  * **This file** connects the two ends: one `DaemonClient` per panel, and a webview that only
 *    draws what it is given.
 *
 * ## What the webview is allowed to do
 *
 * Nothing but draw. Its CSP is `default-src 'none'` with a single nonce for the inline script and
 * style, so there is no network, no external font, no image and no second script. It never
 * receives a URL to fetch. Tool output arrives as text and is put in the DOM with `textContent`;
 * the only HTML it inserts is the string this host built from `renderMarkdown`.
 */

import * as vscode from 'vscode';
import { DaemonClient, DaemonUnavailableError } from './durable-client';
import { renderMarkdown } from './durable-transcript-markdown';
import { applyTranscriptEvent, transcriptOf, type TranscriptView } from './durable-transcript-model';
import { wireView, type WireView } from './durable-transcript-wire';
import { notifyDurableChange } from './durable-signal';

/** The webview type, stable across reloads so the tab can be restored by id. */
export const TRANSCRIPT_VIEW_TYPE = 'picode.durable.transcript';

/** How often the pushed events are folded into one repaint. */
const FLUSH_MS = 60;

/** Reconnect backoff, in milliseconds: 1 s, 2 s, 4 s, then a steady 10 s. */
const BACKOFF_MS = [1000, 2000, 4000, 10000];

/** The panes currently open, one per conversation: a second open reveals the first. */
const openPanels = new Map<number, vscode.WebviewPanel>();

/**
 * One panel's worth of live conversation: the client, the frame and the reconnect.
 *
 * A `DaemonClient` per panel — not `withDaemon`, which opens and closes per call — because live
 * updates are a subscription. It is closed in `dispose`, which is what the panel's own
 * `onDidDispose` calls, so no socket outlives its tab.
 */
class TranscriptSession implements vscode.Disposable {
	private client: DaemonClient | undefined;
	private view: TranscriptView;
	private connection: WireView['connection'] = 'offline';
	private readonly disposables: vscode.Disposable[] = [];
	private flushTimer: NodeJS.Timeout | undefined;
	private reconnectTimer: NodeJS.Timeout | undefined;
	private attempts = 0;
	private disposed = false;
	private dirty = false;

	constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly conversationId: number,
		private readonly endpoint: string,
	) {
		this.view = transcriptOf(conversationId, undefined, Date.now());
		this.disposables.push(
			panel.webview.onDidReceiveMessage(message => this.onMessage(message)),
			panel.onDidChangeViewState(() => {
				// A hidden webview may have lost its context; the frame is cheap and always current.
				if (panel.visible) {
					this.post();
				}
			}),
		);
		void this.connect();
	}

	private onMessage(message: unknown): void {
		const record = typeof message === 'object' && message !== null ? message as { type?: unknown; url?: unknown } : {};
		if (record.type === 'ready') {
			this.post();
			return;
		}
		if (record.type === 'reconnect') {
			void this.connect();
			return;
		}
		if (record.type === 'open' && typeof record.url === 'string') {
			// Only the two schemes the renderer ever emits: a click can never ask for anything else.
			if (/^https?:\/\//i.test(record.url)) {
				void vscode.env.openExternal(vscode.Uri.parse(record.url));
			}
		}
	}

	private async connect(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.clearReconnect();
		this.closeClient();
		this.setConnection('reconnecting');
		try {
			const client = await DaemonClient.connect(this.endpoint, 3000);
			this.client = client;
			client.onEvent(message => this.onDaemonEvent(message));
			const answer = await client.request('subscribe', { conversationId: this.conversationId }) as { snapshot?: unknown };
			if (this.disposed || this.client !== client) {
				return;
			}
			this.view = transcriptOf(this.conversationId, answer?.snapshot, Date.now());
			this.attempts = 0;
			this.setConnection('live');
			this.post();
		} catch (error) {
			if (this.disposed) {
				return;
			}
			// The daemon being down is not a crash: the tab says so and keeps trying.
			this.setConnection(error instanceof DaemonUnavailableError ? 'offline' : 'reconnecting');
			this.scheduleReconnect();
		}
	}

	private onDaemonEvent(message: unknown): void {
		if (this.disposed) {
			return;
		}
		const record = typeof message === 'object' && message !== null
			? message as { event?: unknown; conversationId?: unknown; events?: unknown }
			: {};
		if (record.event === 'closed') {
			this.setConnection('reconnecting');
			this.scheduleReconnect();
			return;
		}
		if (record.event !== 'events' || record.conversationId !== this.conversationId || !Array.isArray(record.events)) {
			return;
		}
		let next = this.view;
		let started = false;
		let ended = false;
		for (const event of record.events) {
			const type = typeof event === 'object' && event !== null ? (event as { type?: unknown }).type : undefined;
			next = applyTranscriptEvent(next, event, Date.now());
			if (type === 'run_start') { started = true; }
			if (type === 'run_end') { ended = true; }
		}
		// The block polls every 5 s; a run that starts or ends is worth telling it now, so the row
		// and this tab never disagree about whether work is in flight.
		if (started) { notifyDurableChange('run-start'); }
		if (ended) { notifyDurableChange('run-end'); }
		if (next === this.view) {
			return; // deltas and tool progress change nothing a reader sees
		}
		this.view = next;
		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== undefined) {
			this.dirty = true;
			return;
		}
		this.dirty = false;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.post();
			if (this.dirty) {
				this.scheduleFlush();
			}
		}, FLUSH_MS);
	}

	private scheduleReconnect(): void {
		if (this.disposed || this.reconnectTimer !== undefined) {
			return;
		}
		const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)];
		this.attempts++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connect();
		}, delay);
	}

	private clearReconnect(): void {
		if (this.reconnectTimer !== undefined) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
	}

	private setConnection(connection: WireView['connection']): void {
		if (this.connection === connection) {
			return;
		}
		this.connection = connection;
		this.post();
	}

	private post(): void {
		if (this.disposed) {
			return;
		}
		// The markdown is rendered here, on the host side, on its way into the frame.
		void this.panel.webview.postMessage({ type: 'view', view: wireView(this.view, this.connection, renderMarkdown) });
	}

	private closeClient(): void {
		if (this.client === undefined) {
			return;
		}
		const client = this.client;
		this.client = undefined;
		// Best effort: unsubscribing stops the daemon's stream; closing then drops the socket.
		void client.request('unsubscribe', { conversationId: this.conversationId }).catch(() => undefined).finally(() => client.close());
	}

	dispose(): void {
		this.disposed = true;
		this.clearReconnect();
		if (this.flushTimer !== undefined) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
		this.closeClient();
	}
}

/**
 * Opens (or reveals) the transcript tab for one conversation.
 *
 * `endpoint` is passed in rather than looked up here, so this module never needs to know where
 * the durable agent lives: `durable.ts` owns that decision and hands it over.
 */
export function openTranscriptPanel(options: { conversationId: number; endpoint: string; title?: string }): void {
	const existing = openPanels.get(options.conversationId);
	if (existing !== undefined) {
		existing.reveal(undefined, false);
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		TRANSCRIPT_VIEW_TYPE,
		options.title ?? `Durable · ${options.conversationId}`,
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [] },
	);
	const nonce = randomNonce();
	panel.webview.html = transcriptHtml(nonce, options.conversationId);
	openPanels.set(options.conversationId, panel);

	const session = new TranscriptSession(panel, options.conversationId, options.endpoint);
	panel.onDidDispose(() => {
		openPanels.delete(options.conversationId);
		session.dispose();
	});
}

/** A nonce for this panel's single script and single style block. */
function randomNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let index = 0; index < 32; index++) {
		nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return nonce;
}

/** The page. Everything it needs is here: no local file, no font, no image, no network. */
function transcriptHtml(nonce: string, conversationId: number): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Durable · ${conversationId}</title>
<style nonce="${nonce}">
	:root { color-scheme: light dark; }
	html, body { height: 100%; }
	body {
		margin: 0;
		display: flex;
		flex-direction: column;
		background: var(--vscode-editor-background);
		color: var(--vscode-editor-foreground, var(--vscode-foreground));
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size, 13px);
	}

	header {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 14px;
		background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
		border-bottom: 1px solid var(--vscode-panel-border, transparent);
		font-size: 0.92em;
	}
	header .pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 2px 9px;
		border-radius: 999px;
		background: var(--vscode-badge-background);
		color: var(--vscode-badge-foreground);
		font-weight: 600;
	}
	header .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
	header.running .pill { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	header.stale .pill { background: var(--vscode-inputValidation-warningBackground, var(--vscode-badge-background)); color: var(--vscode-editor-foreground); }
	header .meta { color: var(--vscode-descriptionForeground); }
	header .spacer { flex: 1; }
	header button {
		background: transparent;
		color: var(--vscode-textLink-foreground);
		border: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, transparent));
		border-radius: 4px;
		padding: 2px 8px;
		cursor: pointer;
		font: inherit;
	}
	header button:hover { background: var(--vscode-toolbar-hoverBackground, transparent); }

	#scroller { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 14px 16px 28px; }
	#list { display: flex; flex-direction: column; gap: 12px; max-width: 900px; margin: 0 auto; }

	.row { display: flex; flex-direction: column; }
	.row.user { align-items: flex-end; }
	.row.assistant, .row.tool { align-items: flex-start; }

	.bubble {
		max-width: 82%;
		padding: 9px 13px;
		border-radius: 10px;
		background: var(--vscode-textBlockQuote-background, var(--vscode-editorWidget-background));
		border: 1px solid var(--vscode-panel-border, transparent);
		overflow-wrap: anywhere;
	}
	.row.user .bubble {
		background: var(--vscode-button-secondaryBackground, var(--vscode-textBlockQuote-background));
		color: var(--vscode-button-secondaryForeground, inherit);
		border-top-right-radius: 3px;
	}
	.row.assistant .bubble { border-top-left-radius: 3px; }

	.bubble p { margin: 0 0 8px; line-height: 1.55; }
	.bubble > :last-child { margin-bottom: 0; }
	.bubble h1, .bubble h2, .bubble h3, .bubble h4, .bubble h5, .bubble h6 { margin: 12px 0 6px; line-height: 1.3; }
	.bubble h1 { font-size: 1.3em; } .bubble h2 { font-size: 1.18em; } .bubble h3 { font-size: 1.08em; }
	.bubble ul, .bubble ol { margin: 6px 0; padding-left: 22px; }
	.bubble li { margin: 2px 0; line-height: 1.5; }
	.bubble blockquote {
		margin: 8px 0;
		padding: 2px 0 2px 10px;
		border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border, transparent));
		color: var(--vscode-descriptionForeground);
	}
	.bubble hr { border: none; border-top: 1px solid var(--vscode-panel-border, transparent); margin: 10px 0; }
	.bubble code {
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 0.94em;
		background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.16));
		padding: 1px 4px;
		border-radius: 3px;
	}
	.bubble pre.code {
		margin: 8px 0;
		padding: 9px 11px;
		overflow-x: auto;
		background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.16));
		border-radius: 6px;
	}
	.bubble pre.code code { background: none; padding: 0; white-space: pre; }
	.bubble table { border-collapse: collapse; margin: 8px 0; display: block; overflow-x: auto; max-width: 100%; }
	.bubble th, .bubble td {
		border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.35));
		padding: 4px 8px;
		text-align: left;
		vertical-align: top;
	}
	.bubble th { background: var(--vscode-keybindingTable-headerBackground, rgba(127,127,127,.12)); font-weight: 600; }
	.bubble th.t-center, .bubble td.t-center { text-align: center; }
	.bubble th.t-right, .bubble td.t-right { text-align: right; }
	.bubble a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
	.bubble a:hover { color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); text-decoration: underline; }

	details.tool {
		width: 100%;
		max-width: 82%;
		border: 1px solid var(--vscode-panel-border, transparent);
		border-radius: 8px;
		background: var(--vscode-editorWidget-background, transparent);
		overflow: hidden;
	}
	details.tool > summary {
		cursor: pointer;
		padding: 6px 11px;
		display: flex;
		gap: 8px;
		align-items: center;
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 0.88em;
		color: var(--vscode-descriptionForeground);
		list-style: none;
	}
	details.tool > summary::-webkit-details-marker { display: none; }
	details.tool > summary::before { content: '▸'; color: var(--vscode-descriptionForeground); }
	details.tool[open] > summary::before { content: '▾'; }
	details.tool > summary .name { color: var(--vscode-editor-foreground); font-weight: 600; }
	/* The command, on the folded line: the beginning of it, never a second row. */
	details.tool > summary .cmd {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--vscode-editor-foreground);
		opacity: .85;
	}
	details.tool > summary .stats { white-space: nowrap; margin-left: auto; }
	details.tool.running > summary::before { content: '◌'; color: var(--vscode-textLink-foreground); }
	details.tool.no-result > summary::before { content: '∅'; color: var(--vscode-errorForeground); }
	details.tool > pre.cmd-body { color: var(--vscode-descriptionForeground); white-space: pre-wrap; }

	/* A streak of calls: one folded line, and the same rows inside. */
	details.tool-group {
		width: 100%;
		max-width: 82%;
		border: 1px solid var(--vscode-panel-border, transparent);
		border-radius: 8px;
		overflow: hidden;
		background: var(--vscode-editorWidget-background, transparent);
	}
	details.tool-group > summary {
		cursor: pointer;
		padding: 6px 11px;
		display: flex;
		gap: 8px;
		align-items: center;
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 0.88em;
		color: var(--vscode-descriptionForeground);
		list-style: none;
	}
	details.tool-group > summary::-webkit-details-marker { display: none; }
	details.tool-group > summary::before { content: '▸'; }
	details.tool-group[open] > summary::before { content: '▾'; }
	details.tool-group > summary .name { color: var(--vscode-editor-foreground); font-weight: 600; }
	details.tool-group > summary .cmd { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	details.tool-group > summary .stats { white-space: nowrap; margin-left: auto; }
	details.tool-group > details.tool {
		max-width: 100%;
		border: none;
		border-top: 1px solid var(--vscode-panel-border, transparent);
		border-radius: 0;
		background: none;
	}
	details.tool-group > details.tool > summary { padding-left: 20px; }
	details.tool > summary .error-badge { color: var(--vscode-errorForeground); font-weight: 700; }
	details.tool > pre {
		margin: 0;
		padding: 10px 12px;
		max-height: 420px;
		overflow: auto;
		border-top: 1px solid var(--vscode-panel-border, transparent);
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 0.88em;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	details.tool.error { border-color: var(--vscode-errorForeground); }
	details.tool.error > summary { color: var(--vscode-errorForeground); }

	.thinking { margin-top: 8px; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
	.thinking > summary { cursor: pointer; }

	.notice {
		align-self: center;
		font-size: 0.85em;
		color: var(--vscode-descriptionForeground);
		border-top: 1px dashed var(--vscode-panel-border, transparent);
		border-bottom: 1px dashed var(--vscode-panel-border, transparent);
		padding: 3px 10px;
	}
	.omitted { align-self: center; font-size: 0.85em; color: var(--vscode-descriptionForeground); }

	#jump {
		position: fixed;
		right: 18px;
		bottom: 18px;
		padding: 5px 12px;
		border-radius: 999px;
		border: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border, transparent));
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		cursor: pointer;
		font: inherit;
		display: none;
		box-shadow: 0 2px 8px rgba(0,0,0,.28);
	}
	#jump.visible { display: block; }
</style>
</head>
<body>
<header id="header">
	<span class="pill"><span class="dot"></span><span id="state">…</span></span>
	<span class="meta" id="elapsed"></span>
	<span class="meta" id="count"></span>
	<span class="spacer"></span>
	<button type="button" id="reconnect" title="Reconnect to the durable agent" hidden>Reconnect</button>
</header>
<div id="scroller"><div id="list"></div></div>
<button type="button" id="jump">↓ latest</button>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const scroller = document.getElementById('scroller');
	const list = document.getElementById('list');
	const header = document.getElementById('header');
	const stateLabel = document.getElementById('state');
	const elapsedLabel = document.getElementById('elapsed');
	const countLabel = document.getElementById('count');
	const jump = document.getElementById('jump');
	const reconnectButton = document.getElementById('reconnect');

	let frame = undefined;       // the last WireView
	const drawn = new Map();     // row id → element, so a repaint keeps <details> open
	let drawnOrder = [];         // row ids, in order, to detect a rebuild
	let paused = false;          // the reader scrolled up: never yank them back down

	function atBottom() {
		return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
	}

	function formatElapsed(ms) {
		const total = Math.max(0, Math.round(ms / 1000));
		const hours = Math.floor(total / 3600);
		const minutes = Math.floor((total % 3600) / 60);
		const seconds = total % 60;
		if (hours > 0) { return hours + 'h ' + minutes + 'm'; }
		if (minutes > 0) { return minutes + 'm ' + seconds + 's'; }
		return seconds + 's';
	}

	function formatBytes(bytes) {
		if (bytes < 1024) { return bytes + ' B'; }
		if (bytes < 1024 * 1024) { return (bytes / 1024).toFixed(1) + ' KB'; }
		return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
	}

	function renderHeader() {
		const view = frame;
		const running = view.running;
		const stale = view.connection !== 'live';
		header.className = (running ? 'running ' : '') + (stale ? 'stale' : '');
		stateLabel.textContent = stale ? 'reconnecting' : (running ? 'running' : 'done');

		// A finished run closes its clock with the frame's own 'at'; a live one uses this page's
		// clock. Both numbers are checked before subtracting: a missing one is "no clock", never
		// the string "NaNs total" (which is what an unchecked subtraction produced).
		const until = running ? Date.now() : view.at;
		const started = view.startedAt;
		const elapsed = typeof started === 'number' && Number.isFinite(started) && typeof until === 'number' && Number.isFinite(until)
			? Math.max(0, until - started)
			: undefined;
		elapsedLabel.textContent = elapsed === undefined ? '' : formatElapsed(elapsed) + (running ? ' elapsed' : ' total');

		const omitted = view.omitted > 0 ? ' · ' + view.omitted + ' older hidden' : '';
		countLabel.textContent = view.entries + (view.entries === 1 ? ' entry' : ' entries') + omitted;

		// Reconnecting is the only case that needs a button, and a run in flight can always be
		// re-attached; a healthy, finished conversation offers nothing to press.
		reconnectButton.hidden = !stale && !running;
	}

	/**
	 * One tool call, folded: what ran and the beginning of the command on the line, the whole
	 * command and the whole output when it opens. Text only: textContent, never markup.
	 */
	function toolDetails(tool) {
		const details = document.createElement('details');
		details.className = 'tool' + (tool.isError ? ' error' : '') + (tool.status ? ' ' + tool.status : '');
		if (tool.isError) { details.open = true; }
		const summary = document.createElement('summary');
		const name = document.createElement('span');
		name.className = 'name';
		name.textContent = tool.name;
		summary.appendChild(name);
		if (tool.summary) {
			const command = document.createElement('span');
			command.className = 'cmd';
			command.textContent = tool.summary;
			command.title = tool.details || tool.summary;
			summary.appendChild(command);
		}
		const stats = document.createElement('span');
		stats.className = 'stats';
		if (tool.status) {
			stats.textContent = tool.status === 'running' ? 'running…' : 'no result';
		} else {
			const parts = [(tool.lines === 1 ? '1 line' : tool.lines + ' lines'), formatBytes(tool.bytes)];
			if (tool.durationMs !== undefined) { parts.push(formatElapsed(tool.durationMs)); }
			if (tool.truncated) { parts.push('truncated'); }
			stats.textContent = parts.join(' · ');
		}
		summary.appendChild(stats);
		if (tool.isError) {
			const badge = document.createElement('span');
			badge.className = 'error-badge';
			badge.textContent = 'error';
			summary.appendChild(badge);
		}
		details.appendChild(summary);
		if (tool.details) {
			const command = document.createElement('pre');
			command.className = 'cmd-body';
			command.textContent = tool.details;
			details.appendChild(command);
		}
		if (tool.text) {
			const pre = document.createElement('pre');
			// Tool output is text, always: it never becomes markup.
			pre.textContent = tool.text;
			details.appendChild(pre);
		}
		return details;
	}

	function buildRow(row) {
		if (row.kind === 'notice') {
			const notice = document.createElement('div');
			notice.className = 'notice';
			notice.textContent = row.text;
			return notice;
		}
		const wrap = document.createElement('div');
		wrap.className = 'row ' + row.kind;

		if (row.kind === 'tool') {
			wrap.appendChild(toolDetails(row.tool));
			return wrap;
		}

		if (row.kind === 'tool-group') {
			const group = document.createElement('details');
			group.className = 'tool-group';
			const summary = document.createElement('summary');
			const head = document.createElement('span');
			head.className = 'name';
			head.textContent = row.group.count === 1 ? '1 call' : row.group.count + ' calls';
			summary.appendChild(head);
			const names = document.createElement('span');
			names.className = 'cmd';
			names.textContent = row.group.names;
			summary.appendChild(names);
			const total = document.createElement('span');
			total.className = 'stats';
			total.textContent = formatBytes(row.group.totalBytes);
			summary.appendChild(total);
			group.appendChild(summary);
			for (const call of row.group.calls) {
				group.appendChild(toolDetails(call));
			}
			wrap.appendChild(group);
			return wrap;
		}

		const bubble = document.createElement('div');
		bubble.className = 'bubble';
		if (row.kind === 'assistant') {
			// Only HTML this editor built from escaped markdown ever reaches innerHTML.
			bubble.innerHTML = row.html;
			if (row.thinking) {
				const thinking = document.createElement('details');
				thinking.className = 'thinking';
				const summary = document.createElement('summary');
				summary.textContent = 'reasoning';
				thinking.appendChild(summary);
				const body = document.createElement('div');
				body.textContent = row.thinking;
				thinking.appendChild(body);
				bubble.appendChild(thinking);
			}
		} else {
			bubble.textContent = row.text;
		}
		wrap.appendChild(bubble);
		return wrap;
	}

	function rebuild(rows) {
		list.textContent = '';
		drawn.clear();
		drawnOrder = [];
		for (const row of rows) { append(row); }
	}

	function append(row) {
		if (drawn.has(row.id)) { return; }
		const element = buildRow(row);
		list.appendChild(element);
		drawn.set(row.id, element);
		drawnOrder.push(row.id);
	}

	function render(view) {
		const previous = frame;
		frame = view;
		renderHeader();

		const stick = !paused && atBottom();
		const rebuildNeeded = previous === undefined
			|| view.rows.length < drawnOrder.length
			|| (view.rows.length > 0 && drawnOrder.length > 0 && view.rows[0].id !== drawnOrder[0]);

		if (rebuildNeeded) {
			rebuild(view.rows);
		} else {
			for (const row of view.rows) { append(row); }
		}

		if (view.omitted > 0) {
			const note = document.getElementById('omitted-note') || document.createElement('div');
			note.id = 'omitted-note';
			note.className = 'omitted';
			note.textContent = view.omitted + ' older entries are not shown.';
			list.insertBefore(note, list.firstChild);
		}

		if (stick) {
			scroller.scrollTop = scroller.scrollHeight;
		}
		updateJump();
	}

	function updateJump() {
		jump.classList.toggle('visible', !atBottom());
	}

	scroller.addEventListener('scroll', () => {
		paused = !atBottom();
		updateJump();
	}, { passive: true });

	jump.addEventListener('click', () => {
		paused = false;
		scroller.scrollTop = scroller.scrollHeight;
		updateJump();
	});

	reconnectButton.addEventListener('click', () => {
		vscode.postMessage({ type: 'reconnect' });
	});

	document.addEventListener('click', (event) => {
		const anchor = event.target instanceof Element ? event.target.closest('a[data-href]') : null;
		if (anchor) {
			event.preventDefault();
			vscode.postMessage({ type: 'open', url: anchor.getAttribute('data-href') });
		}
	});

	// The clock ticks on this side: the header stays truthful without a message per second.
	setInterval(() => { if (frame) { renderHeader(); } }, 1000);

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (message && message.type === 'view') { render(message.view); }
	});

	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
