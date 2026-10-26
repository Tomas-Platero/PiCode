/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentDeps } from './agent';
import { piResumeRequestHandler } from './sessions-resume';
import { areaConversationsReport, areaFamilySlugs, conversationsReport, listProjectSessionFiles, listingForPanel, reuseRows, sessionTurns } from './sessions-provider';
import { projectSlugsOfWindow, resolveProjectScope, windowSessionScope } from './runtime';
import { coarseMinute, transcriptDigest } from './sessions-digest';

/**
 * pi's own sessions, in the editor's Sessions panel: the one list.
 *
 * The transcripts pi writes under `<profile>/sessions` are the conversations. This provider
 * lists them as a `pi` group, replays one as history when it is opened, and hands the editor a
 * request handler that appends the next prompt to the same transcript, so the conversation
 * goes on (`sessions-resume.ts`). It fires its change event when the window's folders move and
 * when an import lands a tree of transcripts.
 */

/** The URI scheme pi's transcripts use; the editor derives the chat session type from it. */
export const PI_SESSION_SCHEME = 'pi';

/** The pieces the registration needs that the caller owns. */
export interface PiSessionsOptions {
	/** The chat participant the content provider registers under (the connector's own). */
	readonly participant: vscode.ChatParticipant;
	/** Where pi lives and where its logs go: a continuation runs pi in this window. */
	readonly deps: AgentDeps;
	/** The profile whose `sessions/` folder is listed, read at each listing. */
	readonly profileDir: () => string;
}

export function registerPiSessionsProvider(options: PiSessionsOptions): { fireChanged(): void } & vscode.Disposable {
	const changed = new vscode.EventEmitter<void>();
	// The last listing the panel accepted. A cancelled or unpublishable refresh returns it, not
	// `[]`: the extension-host bridge diffs by reference and removes every item absent from the
	// returned array, so an empty answer would clear the panel until the next good one.
	let lastItems: vscode.ChatSessionItem[] | undefined = undefined;
	let lastLoggedCount = -1;
	const sessionsDir = (): string => path.join(options.profileDir(), 'sessions');

	const provider: vscode.ChatSessionItemProvider & vscode.ChatSessionContentProvider = {
		onDidChangeChatSessionItems: changed.event,
		onDidCommitChatSessionItem: new vscode.EventEmitter<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }>().event,
		provideChatSessionItems(token: vscode.CancellationToken): vscode.ProviderResult<vscode.ChatSessionItem[]> {
			if (token.isCancellationRequested) {
				return lastItems ?? [];
			}
			// The window's own conversations, and only those. In a workspace the listing asks for
			// every identity the workspace ever filed under, because the area's identity moves
			// whenever its folder list does; in a folder window the project's own slug is the answer.
			const folders = vscode.workspace.workspaceFolders;
			const scope = windowSessionScope();
			const report = scope.mode === 'workspace' && scope.slugs[0] !== undefined
				? areaConversationsReport(sessionsDir(), scope.slugs[0])
				: conversationsReport(sessionsDir(), scope.slugs);
			const built = report.files.map(file => ({
				resource: vscode.Uri.from({ scheme: PI_SESSION_SCHEME, path: `/${file.id}` }),
				label: file.label,
				iconPath: vscode.ThemeIcon.File,
				// A transcript is only ever appended to, so its mtime is both the created and the
				// last-activity marker; without one the panel dates every row 1970. Rounded to the
				// minute, the grain the panel shows, so a row that only grew is the same row to it.
				timing: { created: coarseMinute(file.mtime), lastRequestEnded: coarseMinute(file.mtime) },
			}));
			// Rows nobody touched come back as the objects the panel already has, so the list does
			// not republish and blink on every refresh.
			const reusable = reuseRows(
				lastItems ?? [],
				built,
				row => row.resource.toString(),
				(before, after) => before.label === after.label
					&& before.timing?.created === after.timing?.created
					&& before.timing?.lastRequestEnded === after.timing?.lastRequestEnded,
			);
			// A listing that came back short because a directory refused to be read is no answer;
			// publishing it is what emptied the panel while the profile was being written.
			lastItems = listingForPanel(reusable, lastItems, folders !== undefined && report.complete);
			if (lastItems.length !== lastLoggedCount) {
				lastLoggedCount = lastItems.length;
				options.deps.log(`sessions: ${lastItems.length} conversation${lastItems.length === 1 ? '' : 's'} listed${report.complete ? '' : ' (the folder could not be read completely)'}`);
			}
			return lastItems;
		},
		async provideChatSessionContent(resource: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
			const empty: vscode.ChatSession = { history: [], requestHandler: undefined };
			if (token.isCancellationRequested) {
				return empty;
			}
			const id = resource.path.split('/').pop();
			// Every transcript of the open projects, the area's whole family included: a row the
			// panel lists has to resolve when it is clicked, whatever identity it was written under.
			const areaSlug = resolveProjectScope().area?.slug;
			const lookupSlugs = [
				...projectSlugsOfWindow(),
				...(areaSlug === undefined ? [] : areaFamilySlugs(sessionsDir(), areaSlug)),
			];
			const file = listProjectSessionFiles(sessionsDir(), lookupSlugs).find(entry => entry.id === id);
			if (file === undefined) {
				return empty;
			}
			let text = '';
			try {
				text = fs.readFileSync(file.file, 'utf8');
			} catch {
				return empty;
			}
			const history: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> = [];
			for (const turn of sessionTurns(text)) {
				if (turn.role === 'user') {
					history.push(new vscode.ChatRequestTurn2(turn.text, undefined, [], PI_SESSION_SCHEME, [], undefined, undefined, undefined, undefined));
				} else {
					history.push(new vscode.ChatResponseTurn2(
						[new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(turn.text))],
						{},
						PI_SESSION_SCHEME,
					));
				}
			}
			// The next prompt appends to this same transcript: the conversation goes on.
			return { history, requestHandler: piResumeRequestHandler(file.file, options.deps) };
		},
	};

	// A conversation that starts writes a new transcript into the folder: the panel is told when a
	// transcript is added or removed, a moment after the writes settle, so a new conversation is in
	// the list without anyone pressing refresh. A transcript that only grows does not tell it
	// anything (`sessions-digest.ts`): pi appends after every message, and a repaint per message
	// is what made the list blink while an answer streamed.
	let settle: ReturnType<typeof setTimeout> | undefined;
	let watcher: fs.FSWatcher | undefined;
	try {
		fs.mkdirSync(sessionsDir(), { recursive: true });
		let known = transcriptDigest(sessionsDir());
		watcher = fs.watch(sessionsDir(), { recursive: true }, () => {
			if (settle !== undefined) {
				clearTimeout(settle);
			}
			settle = setTimeout(() => {
				const now = transcriptDigest(sessionsDir());
				if (now !== known) {
					known = now;
					changed.fire();
				}
			}, 800);
		});
		watcher.on('error', () => { /* a folder that vanished is listed again when the window is */ });
	} catch (error) {
		options.deps.log(`sessions: the transcripts folder could not be watched (${error instanceof Error ? error.message : String(error)})`);
	}
	const registration = vscode.chat.registerChatSessionItemProvider(PI_SESSION_SCHEME, provider);
	// The listing is filtered by the folders this window has open, so a window whose folders
	// arrive after the first ask is asked again.
	const folders = vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire());
	const contentRegistration = vscode.chat.registerChatSessionContentProvider(PI_SESSION_SCHEME, provider, options.participant);
	return {
		fireChanged: () => changed.fire(),
		dispose: () => {
			if (settle !== undefined) {
				clearTimeout(settle);
			}
			watcher?.close();
			folders.dispose();
			contentRegistration.dispose();
			registration.dispose();
			changed.dispose();
		},
	};
}
