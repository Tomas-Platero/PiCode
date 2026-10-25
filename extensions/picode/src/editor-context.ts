/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { applyContextMode, contextBlock, CONTEXT_MAX_DIAGNOSTICS, type ContextAttachment, type ContextDiagnostic, type ContextMode, type EditorContext } from './context';
import { missingDirectories, type SessionCwd } from './session-cwd';
import type { PiProjectScope } from './runtime';
import { areaContextBlock } from './workspace-area';

/**
 * The editor as the context block wants it: the folder, the file, the selection, the problems,
 * and whatever the owner attached to this message.
 *
 * Read here rather than passed around, because this is the only place that knows about the
 * editor's own objects; what is written from them is decided in `context.ts`, where it can be
 * exercised. Every prompt runs through it — the in-process chat and the durable turn alike —
 * so the agent answers about what the owner is looking at instead of about what it guesses.
 */
export function editorContext(folder: string | undefined, references?: readonly vscode.ChatPromptReference[], mode: ContextMode = 'project'): EditorContext {
	const attachments = attachmentsOf(references ?? []);
	const extras = attachments.length === 0 ? {} : { attachments };
	const editor = vscode.window.activeTextEditor;
	if (editor === undefined || editor.document.uri.scheme !== 'file') {
		return applyContextMode({ ...(folder === undefined ? {} : { folder }), ...extras }, mode);
	}
	const selection = editor.selection.isEmpty
		? undefined
		: {
			text: editor.document.getText(editor.selection),
			lines: editor.selection.end.line - editor.selection.start.line + 1,
		};
	const diagnostics = diagnosticsOf(editor.document.uri);
	return applyContextMode({
		...(folder === undefined ? {} : { folder }),
		file: editor.document.uri.fsPath,
		...(selection === undefined ? {} : { selection }),
		...(diagnostics.length === 0 ? {} : { diagnostics }),
		...extras,
	}, mode);
}

/**
 * The context block the project scope asks for.
 *
 * One folder is the block `context.ts` already writes, and folder mode is exactly that.
 * In workspace mode the session is a session of the **area**, so the folder line is
 * replaced by the area block (`workspace-area.ts`): every root named the way the owner
 * names it, with the rule for matching a named project to its root, addressing a file
 * under the right root, and the honest limit — one working directory per shell. The
 * file, selection, problems and attachments still travel through `context.ts`; only the
 * folder line yields, because the roots list says more and says it about every folder at
 * once. A folder that is not on disk is named as such — the session must know `guildboard`
 * is not there rather than discover it with a failed command.
 */
export function contextBlockFor(scope: PiProjectScope, picked: SessionCwd, references?: readonly vscode.ChatPromptReference[], contextMode: ContextMode = 'project'): string | undefined {
	if (scope.mode !== 'workspace' || scope.area === undefined) {
		return contextBlock(editorContext(picked.cwd, references, contextMode));
	}
	// Every root's on-disk state is checked on its own (see `missingDirectories`): a folder
	// the editor keeps after a move or delete sits wherever it sits in the order, and the
	// context must say it is gone rather than let a command discover it.
	const missing = missingDirectories(scope.folders);
	const roots = scope.roots.map(root => ({
		name: root.name,
		path: root.path,
		onDisk: !missing.includes(root.path),
	}));
	const base = contextBlock(editorContext(undefined, references, contextMode));
	const area = areaContextBlock(roots, picked.cwd);
	if (area === undefined) {
		return base;
	}
	return base === undefined ? area : `${base}\n${area}`;
}

/**
 * The open file's errors and warnings, capped.
 *
 * Only the two severities that mean "this is wrong" travel: an information or a hint is the
 * editor's opinion, not a reason the owner pointed at the file. The cap exists because the
 * Problems panel can hold thousands, and a prompt that carries them all is a bill.
 */
function diagnosticsOf(uri: vscode.Uri): ContextDiagnostic[] {
	const problems: ContextDiagnostic[] = [];
	for (const diagnostic of vscode.languages.getDiagnostics(uri)) {
		if (diagnostic.severity !== vscode.DiagnosticSeverity.Error && diagnostic.severity !== vscode.DiagnosticSeverity.Warning) {
			continue;
		}
		problems.push({
			severity: diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
			line: diagnostic.range.start.line + 1,
			message: diagnostic.message,
		});
	}
	return problems
		.toSorted((a, b) => a.line - b.line)
		.slice(0, CONTEXT_MAX_DIAGNOSTICS);
}

/**
 * The request's references, reduced to what travels.
 *
 * The editor resolves a `#file`, a `#selection` or a `#problems` into a `value` and, when it
 * has one, a `modelDescription` written for a model. The description is preferred because it
 * is the one the editor already shaped for this purpose; a `Uri` or a `Location` is named by
 * its path (the agent can open it and read the rest), and a plain string travels as it is. A
 * reference that resolves to none of those still travels by name: the agent then knows **what**
 * was attached even when the editor gave it no text to read.
 */
function attachmentsOf(references: readonly vscode.ChatPromptReference[]): ContextAttachment[] {
	const attachments: ContextAttachment[] = [];
	for (const reference of references) {
		const label = reference.id;
		const description = typeof reference.modelDescription === 'string' && reference.modelDescription.trim().length > 0
			? reference.modelDescription
			: undefined;
		if (description !== undefined) {
			attachments.push({ label, text: description });
			continue;
		}
		const value = reference.value;
		if (value instanceof vscode.Uri) {
			attachments.push({ label, text: value.fsPath });
		} else if (isLocation(value)) {
			attachments.push({ label, text: `${value.uri.fsPath}:${value.range.start.line + 1}` });
		} else if (typeof value === 'string' && value.trim().length > 0) {
			attachments.push({ label, text: value });
		} else {
			attachments.push({ label });
		}
	}
	return attachments;
}

/** A `Location`, recognised by its shape so a plain value does not have to be one. */
function isLocation(value: unknown): value is vscode.Location {
	return typeof value === 'object' && value !== null
		&& (value as { uri?: unknown }).uri instanceof vscode.Uri
		&& typeof (value as { range?: unknown }).range === 'object';
}
