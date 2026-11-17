/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a session that works in its own copy of the project can do, from its row in the Sessions list:
 * start (a new session in a separate copy, its branch named by the first message), rename, review its
 * changes, push and open a pull request, merge into the base branch, open the copy in a window, and on
 * archive, remove the copy.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveProjectScope } from './runtime';
import { resolveSessionCwd } from './session-cwd';
import { githubRepoOf, titleOfSession, updateSessionGitStore, withTitle, worktreeOfSession } from './session-git';
import { changedFiles, defaultBaseOf, fileAtRef, mergeIntoBase, openWorktree, placeholderBranch, pushBranch, removeWorktree, repoRootOf } from './session-worktree';
import * as fs from 'node:fs';
import { worktreeOfChatKey } from './session-branch-commands';

export const NEW_ISOLATED_SESSION_COMMAND = 'picode.session.newIsolated';
const OPEN_CHAT_ON_WORKTREE_COMMAND = 'picode.agent.newChatOnWorktree';
/** The base side of a copy's diff: a file at a commit, served by `GitRefContentProvider`. */
const GIT_REF_SCHEME = 'picode-git';

/** A file of a copy as it was at `ref`, the left side of its diff. */
export function baseSideUri(folder: string, file: string, ref: string): vscode.Uri {
	return vscode.Uri.from({ scheme: GIT_REF_SCHEME, path: `/${file}`, query: JSON.stringify({ cwd: folder, ref }) });
}

/** The session id a row command receives (`pi:/<id>`), from the item or a resource string. */
function sessionIdOf(item: unknown): string | undefined {
	const resource = (item as { resource?: unknown } | undefined)?.resource ?? item;
	const text = resource instanceof vscode.Uri ? resource.toString() : typeof resource === 'string' ? resource : undefined;
	return text?.startsWith('pi:') ? text.split('/').pop() : undefined;
}

/** The copy a session works in, when it still exists; says so when it does not. */
function copyOf(item: unknown): { readonly folder: string } | undefined {
	const resource = (item as { resource?: unknown } | undefined)?.resource ?? item;
	const key = resource instanceof vscode.Uri ? resource.toString() : typeof resource === 'string' ? resource : undefined;
	const folder = key === undefined ? undefined : worktreeOfChatKey(key);
	if (folder === undefined) {
		void vscode.window.showInformationMessage(vscode.l10n.t('This session works in the project folder, not in a copy of its own.'));
		return undefined;
	}
	return { folder };
}

async function newIsolatedSession(): Promise<void> {
	const scope = resolveProjectScope();
	const root = await repoRootOf(resolveSessionCwd(scope.folders, os.homedir()).cwd);
	if (root === undefined) {
		void vscode.window.showInformationMessage(vscode.l10n.t('This folder is not a git repository, so the session works in the project folder.'));
		await vscode.commands.executeCommand('workbench.action.chat.newChat');
		return;
	}
	const branch = placeholderBranch();
	const opened = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Preparing a separate copy of the project…') },
		() => openWorktree(root, branch, { create: true }),
	);
	if (!opened.ok) {
		void vscode.window.showWarningMessage(vscode.l10n.t('The separate copy could not be made, so the session works in the project folder.'));
		await vscode.commands.executeCommand('workbench.action.chat.newChat');
		return;
	}
	await vscode.commands.executeCommand(OPEN_CHAT_ON_WORKTREE_COMMAND, opened.path, branch, vscode.l10n.t('New session'));
}

async function renameSession(item: unknown): Promise<void> {
	const id = sessionIdOf(item);
	if (id === undefined) {
		return;
	}
	const current = titleOfSession(id) ?? (item as { label?: unknown } | undefined)?.label;
	const title = await vscode.window.showInputBox({
		title: vscode.l10n.t('Rename Session'),
		value: typeof current === 'string' ? current : '',
		prompt: vscode.l10n.t('Leave it empty to name it after its first message again.'),
	});
	if (title !== undefined) {
		await updateSessionGitStore(store => withTitle(store, id, title));
	}
}

/** Serves a file at a commit of a copy: `picode-git:/<file>?{"cwd","ref"}`. */
class GitRefContentProvider implements vscode.TextDocumentContentProvider {
	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		try {
			const { cwd, ref } = JSON.parse(uri.query) as { cwd: string; ref: string };
			return await fileAtRef(cwd, ref, uri.path.replace(/^\//, '')) ?? '';
		} catch {
			return '';
		}
	}
}

async function reviewChanges(item: unknown): Promise<void> {
	const copy = copyOf(item);
	if (copy === undefined) {
		return;
	}
	const base = await defaultBaseOf(copy.folder);
	const files = base === undefined ? [] : await changedFiles(copy.folder, base);
	if (files.length === 0) {
		void vscode.window.showInformationMessage(vscode.l10n.t('This session has not changed anything yet.'));
		return;
	}
	const entries = files.map(file => {
		const modified = vscode.Uri.file(path.join(copy.folder, file.path));
		const original = baseSideUri(copy.folder, file.path, file.baseRef);
		return [modified, file.status === 'added' ? undefined : original, file.status === 'deleted' ? undefined : modified];
	});
	await vscode.commands.executeCommand('vscode.changes', vscode.l10n.t('Changes of this session'), entries);
}

async function createPullRequest(item: unknown): Promise<void> {
	const copy = copyOf(item);
	if (copy === undefined) {
		return;
	}
	const pushed = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Uploading the branch…') },
		() => pushBranch(copy.folder),
	);
	if (!pushed.ok || pushed.branch === undefined) {
		void vscode.window.showWarningMessage(vscode.l10n.t('The branch could not be uploaded: {0}', pushed.detail || vscode.l10n.t('no answer from the remote')));
		return;
	}
	const repo = await githubRepoOf(copy.folder);
	const base = await defaultBaseOf(copy.folder);
	if (repo === undefined || base === undefined) {
		void vscode.window.showInformationMessage(vscode.l10n.t('Branch {0} is uploaded. Open the pull request on your git host.', pushed.branch));
		return;
	}
	await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(pushed.branch)}?expand=1`));
}

async function mergeSession(item: unknown): Promise<void> {
	const copy = copyOf(item);
	if (copy === undefined) {
		return;
	}
	const base = await defaultBaseOf(copy.folder);
	if (base === undefined) {
		void vscode.window.showWarningMessage(vscode.l10n.t('PiCode could not tell which branch this copy came from.'));
		return;
	}
	const merge = vscode.l10n.t('Merge');
	const answer = await vscode.window.showWarningMessage(
		vscode.l10n.t('Merge this session into {0}?', base),
		{ modal: true, detail: vscode.l10n.t('Its commits are added to {0} in the project folder. If they clash with it, nothing changes.', base) },
		merge,
	);
	if (answer !== merge) {
		return;
	}
	switch (await mergeIntoBase(copy.folder, base)) {
		case 'merged':
			void vscode.window.showInformationMessage(vscode.l10n.t('The session is merged into {0}.', base));
			return;
		case 'copyDirty':
			void vscode.window.showWarningMessage(vscode.l10n.t('This session has changes that are not committed. Commit them first.'));
			return;
		case 'projectDirty':
			void vscode.window.showWarningMessage(vscode.l10n.t('The project folder has changes that are not committed. Commit or discard them first.'));
			return;
		case 'projectOnOtherBranch':
			void vscode.window.showWarningMessage(vscode.l10n.t('The project folder is not on {0}. Switch it to {0} first.', base));
			return;
		case 'conflict':
			void vscode.window.showWarningMessage(vscode.l10n.t('The session clashes with {0}, so nothing was merged. Ask the agent to bring the branch up to date first.', base));
			return;
		default:
			void vscode.window.showWarningMessage(vscode.l10n.t('The session could not be merged.'));
	}
}

async function openCopy(item: unknown): Promise<void> {
	const copy = copyOf(item);
	if (copy !== undefined) {
		await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(copy.folder), { forceNewWindow: true });
	}
}

/** After a session with a copy is archived: offer to remove the copy (never one with uncommitted work). */
async function offerRemoveCopy(resource: unknown): Promise<void> {
	const id = sessionIdOf(resource);
	const folder = id === undefined ? undefined : worktreeOfSession(id);
	if (folder === undefined || !fs.existsSync(folder)) {
		return;
	}
	const remove = vscode.l10n.t('Remove the copy');
	const answer = await vscode.window.showInformationMessage(
		vscode.l10n.t('The session is archived. Remove its copy of the project too? Its branch stays.'),
		remove,
		vscode.l10n.t('Keep it'),
	);
	if (answer !== remove) {
		return;
	}
	const outcome = await removeWorktree(folder);
	if (outcome === 'dirty') {
		void vscode.window.showWarningMessage(vscode.l10n.t('The copy has changes that are not committed, so it was kept.'));
	} else if (outcome !== 'removed') {
		void vscode.window.showWarningMessage(vscode.l10n.t('The copy could not be removed.'));
	}
}

export function registerSessionActions(): vscode.Disposable {
	return vscode.Disposable.from(
		vscode.workspace.registerTextDocumentContentProvider(GIT_REF_SCHEME, new GitRefContentProvider()),
		vscode.commands.registerCommand(NEW_ISOLATED_SESSION_COMMAND, newIsolatedSession),
		vscode.commands.registerCommand('picode.session.rename', renameSession),
		vscode.commands.registerCommand('picode.session.reviewChanges', reviewChanges),
		vscode.commands.registerCommand('picode.session.createPullRequest', createPullRequest),
		vscode.commands.registerCommand('picode.session.merge', mergeSession),
		vscode.commands.registerCommand('picode.session.openCopy', openCopy),
		vscode.commands.registerCommand('picode.session.offerRemoveCopy', offerRemoveCopy),
	);
}
