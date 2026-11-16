/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * "New Session on a Branch…" and "Remove a Branch Copy…": the owner picks or names a branch, PiCode
 * makes its worktree (`session-worktree.ts`) and opens a new chat that works there.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { bindChatToWorktree, worktreeOfChat } from './agent';
import { worktreeOfSession } from './session-git';
import { resolveProjectScope } from './runtime';
import { resolveSessionCwd } from './session-cwd';
import { isPicodeWorktree, listBranches, listWorktrees, openWorktree, removeWorktree, repoRootOf, type OpenWorktreeResult } from './session-worktree';

export const NEW_SESSION_ON_BRANCH_COMMAND = 'picode.session.newOnBranch';
export const REMOVE_BRANCH_COPY_COMMAND = 'picode.session.removeBranchCopy';
/** The editor's side: opens a new chat and binds it to the worktree (`picodeAgentSessionsView.ts`). */
const OPEN_CHAT_ON_WORKTREE_COMMAND = 'picode.agent.newChatOnWorktree';
/** Called back by the editor with the new chat's id. */
const BIND_WORKTREE_COMMAND = 'picode.session.bindWorktree';

async function windowRepoRoot(): Promise<string | undefined> {
	const scope = resolveProjectScope();
	const picked = resolveSessionCwd(scope.folders, os.homedir());
	const root = await repoRootOf(picked.cwd);
	if (root === undefined) {
		void vscode.window.showInformationMessage(vscode.l10n.t('This folder is not a git repository, so a session cannot have its own branch.'));
	}
	return root;
}

function failureMessage(result: Extract<OpenWorktreeResult, { ok: false }>): string {
	switch (result.reason) {
		case 'invalidName': return vscode.l10n.t('That is not a valid branch name.');
		case 'exists': return vscode.l10n.t('That branch already exists. Pick it from the list instead.');
		case 'missing': return vscode.l10n.t('That branch does not exist any more.');
		case 'notRepo': return vscode.l10n.t('This folder is not a git repository, so a session cannot have its own branch.');
		default: return vscode.l10n.t('The copy of the branch could not be made: {0}', result.detail ?? '');
	}
}

interface BranchPick extends vscode.QuickPickItem {
	readonly branch?: string;
}

async function newSessionOnBranch(): Promise<void> {
	const root = await windowRepoRoot();
	if (root === undefined) {
		return;
	}
	const [branches, worktrees] = await Promise.all([listBranches(root), listWorktrees(root)]);
	const where = new Map(worktrees.filter(entry => entry.branch !== undefined).map(entry => [entry.branch!, entry.path]));
	const items: BranchPick[] = [
		{ label: `$(add) ${vscode.l10n.t('New branch…')}`, alwaysShow: true },
		{ label: '', kind: vscode.QuickPickItemKind.Separator },
		...branches.map(branch => {
			const folder = where.get(branch);
			const description = folder === undefined ? undefined
				: path.resolve(folder) === path.resolve(root) ? vscode.l10n.t('the project folder')
					: isPicodeWorktree(folder) ? vscode.l10n.t('has its own copy') : vscode.l10n.t('checked out elsewhere');
			return { label: `$(git-branch) ${branch}`, branch, ...(description === undefined ? {} : { description }) };
		}),
	];
	const picked = await vscode.window.showQuickPick(items, {
		title: vscode.l10n.t('New Session on a Branch'),
		placeHolder: vscode.l10n.t('Pick the branch the new session works on'),
		matchOnDescription: true,
	});
	if (picked === undefined) {
		return;
	}
	let branch = picked.branch;
	const create = branch === undefined;
	if (create) {
		branch = await vscode.window.showInputBox({
			title: vscode.l10n.t('New Session on a Branch'),
			prompt: vscode.l10n.t('Name of the new branch. It starts from where the project is now.'),
			placeHolder: 'feat/my-change',
			validateInput: value => value.trim() === '' ? vscode.l10n.t('Write a name for the branch.') : undefined,
		});
		if (branch === undefined) {
			return;
		}
	}
	const result = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Preparing a copy of the project on {0}…', branch!) },
		() => openWorktree(root, branch!, { create }),
	);
	if (!result.ok) {
		void vscode.window.showWarningMessage(failureMessage(result));
		return;
	}
	// The project's own branch needs no copy: the new chat simply works in the project folder.
	if (path.resolve(result.path) === path.resolve(root)) {
		await vscode.commands.executeCommand('workbench.action.chat.newChat');
		return;
	}
	// The editor opens the new chat and hands its id back to `picode.session.bindWorktree`.
	await vscode.commands.executeCommand(OPEN_CHAT_ON_WORKTREE_COMMAND, result.path, branch!.trim());
}

interface CopyPick extends vscode.QuickPickItem {
	readonly folder: string;
	readonly branch: string;
}

async function removeBranchCopy(): Promise<void> {
	const root = await windowRepoRoot();
	if (root === undefined) {
		return;
	}
	const copies: CopyPick[] = (await listWorktrees(root))
		.filter(entry => isPicodeWorktree(entry.path))
		.map(entry => ({ label: `$(git-branch) ${entry.branch ?? path.basename(entry.path)}`, folder: entry.path, branch: entry.branch ?? path.basename(entry.path) }));
	if (copies.length === 0) {
		void vscode.window.showInformationMessage(vscode.l10n.t('No branch has its own copy of this project.'));
		return;
	}
	const picked = await vscode.window.showQuickPick(copies, {
		title: vscode.l10n.t('Remove a Branch Copy'),
		placeHolder: vscode.l10n.t('The branch itself stays; only its copy of the project is removed'),
	});
	if (picked === undefined) {
		return;
	}
	const remove = vscode.l10n.t('Remove');
	const answer = await vscode.window.showWarningMessage(
		vscode.l10n.t('Remove the copy of branch {0}?', picked.branch),
		{ modal: true, detail: vscode.l10n.t('The branch and its commits stay. Sessions that worked there go back to the project folder.') },
		remove,
	);
	if (answer !== remove) {
		return;
	}
	const outcome = await removeWorktree(picked.folder);
	if (outcome === 'removed') {
		void vscode.window.showInformationMessage(vscode.l10n.t('The copy of branch {0} was removed.', picked.branch));
	} else if (outcome === 'dirty') {
		void vscode.window.showWarningMessage(vscode.l10n.t('The copy of branch {0} has changes that are not committed. Commit or discard them first.', picked.branch));
	} else {
		void vscode.window.showWarningMessage(vscode.l10n.t('The copy of branch {0} could not be removed.', picked.branch));
	}
}

/**
 * The worktree of a chat, by the resource the editor knows it by: a live chat's own, or for a
 * conversation reopened from the list (`pi:/<id>`) the one it ran in. Undefined when it works in
 * the project folder, or its worktree is gone.
 */
export function worktreeOfChatKey(key: string): string | undefined {
	const live = worktreeOfChat(key);
	const folder = live ?? (key.startsWith('pi:') ? worktreeOfSession(key.split('/').pop() ?? '') : undefined);
	return folder !== undefined && isPicodeWorktree(folder) && fs.existsSync(folder) ? folder : undefined;
}

export function registerSessionBranchCommands(): vscode.Disposable {
	return vscode.Disposable.from(
		vscode.commands.registerCommand(NEW_SESSION_ON_BRANCH_COMMAND, newSessionOnBranch),
		vscode.commands.registerCommand(REMOVE_BRANCH_COPY_COMMAND, removeBranchCopy),
		vscode.commands.registerCommand(BIND_WORKTREE_COMMAND, (key: unknown, folder: unknown, branch: unknown, name: unknown) =>
			typeof key === 'string' && typeof folder === 'string' && typeof branch === 'string' && isPicodeWorktree(folder)
			&& bindChatToWorktree(key, folder, branch, typeof name === 'string' ? name : undefined)),
	);
}
