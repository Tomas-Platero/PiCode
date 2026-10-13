/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The most of the editor's own text that travels with the prompt, in characters. */
export const CONTEXT_MAX_CHARS = 8000;

/** The most of a selection that travels with it, in lines. */
export const CONTEXT_MAX_LINES = 120;

/** The most problems from the open file that travel with the prompt. */
export const CONTEXT_MAX_DIAGNOSTICS = 10;

/** The most of one problem's message that travels. */
export const CONTEXT_MAX_DIAGNOSTIC_CHARS = 200;

/**
 * What the owner is looking at, written for pi.
 *
 * The point is that *"arregla esto"* needs no explaining: the folder, the file and the selection
 * are the ones he sees. The selection is capped — in lines and in characters — because a whole
 * file pasted into every prompt is a bill rather than context, and pi can read the file itself
 * when it needs the rest.
 *
 * This module takes a plain description of the editor instead of a `vscode.TextEditor`, so what
 * is written — which is the part with a decision in it — can be exercised by running it. It
 * imports nothing relative for that same reason: `node --test` runs it directly.
 */

/** One problem the editor knows about the open file, reduced to what travels. */
export interface ContextDiagnostic {
	readonly severity: 'error' | 'warning';
	/** 1-based, the way the editor's Problems panel counts. */
	readonly line: number;
	readonly message: string;
}

/** Something the owner attached to the message, already reduced to text. */
export interface ContextAttachment {
	/** What the reference is (`#file`, `#selection`, …), as the request names it. */
	readonly label: string;
	/** The text that travels, when there is one; a label alone still says what was attached. */
	readonly text?: string;
}

/** The editor, reduced to the facts that travel with a prompt. */
export interface EditorContext {
	/** The workspace folder, when one is open. */
	readonly folder?: string;
	/** The file the owner has open, when it is a real file on disk. */
	readonly file?: string;
	/** What is selected in it, when something is. */
	readonly selection?: { readonly text: string; readonly lines: number };
	/** The errors and warnings in it, already capped by the reader. */
	readonly diagnostics?: readonly ContextDiagnostic[];
	/** What the owner attached to this message. */
	readonly attachments?: readonly ContextAttachment[];
}

/** A block of text, capped in lines and then in characters, so one paste cannot become the prompt. */
function capped(text: string): string {
	return text.split('\n').slice(0, CONTEXT_MAX_LINES).join('\n').slice(0, CONTEXT_MAX_CHARS);
}

/**
 * The context block, or `undefined` when there is nothing to say.
 *
 * `undefined` rather than an empty block: a prompt with a header and nothing under it is noise
 * that pi has to read on every single message.
 */
export function contextBlock(context: EditorContext): string | undefined {
	const parts: string[] = [];
	if (context.folder !== undefined && context.folder.length > 0) {
		parts.push(`- Workspace: ${context.folder}`);
	}
	if (context.file !== undefined && context.file.length > 0) {
		parts.push(`- File the owner has open: ${context.file}`);
	}
	if (context.selection !== undefined && context.selection.text.trim().length > 0) {
		parts.push(`- Selected in it (${context.selection.lines} line(s), capped):`);
		parts.push('```\n' + capped(context.selection.text) + '\n```');
	}
	if (context.diagnostics !== undefined && context.diagnostics.length > 0) {
		parts.push(`- Problems in it (${context.diagnostics.length}, capped):`);
		for (const problem of context.diagnostics.slice(0, CONTEXT_MAX_DIAGNOSTICS)) {
			const message = problem.message.slice(0, CONTEXT_MAX_DIAGNOSTIC_CHARS);
			parts.push(`  - ${problem.severity} at line ${problem.line}: ${message}`);
		}
	}
	if (context.attachments !== undefined && context.attachments.length > 0) {
		for (const attachment of context.attachments) {
			parts.push(`- Attached by the owner: ${attachment.label}`);
			if (attachment.text !== undefined && attachment.text.trim().length > 0) {
				parts.push('```\n' + capped(attachment.text) + '\n```');
			}
		}
	}
	if (parts.length === 0) {
		return undefined;
	}
	return `Context from the editor, as it is right now:\n\n${parts.join('\n')}\n`;
}

/**
 * Who the agent is, said on every message.
 *
 * Because it is not obvious from inside a session. pi is a general agent, and it is also the
 * tool the owner develops PiCode **with**: with this very repository open, its own `AGENTS.md`
 * is discovered as project context and says exactly that ("yo tengo otro pi aquí para desarrollar
 * esta app"). The model read it and answered as the *development* agent — which is a different
 * pi, on a different machine, in a terminal. One sentence that it is the editor's agent is what
 * keeps the two apart, and it costs a line.
 *
 * The sentence follows the runtime mode (`picode.pi.runtime`): the internal pi is PiCode's own
 * and lives in the editor; the external one is the machine's, running on the editor's behalf.
 * A frame that always said "inside the PiCode editor" made the external pi claim to be the
 * internal one — the very confusion the frame exists to prevent.
 */
export function agentFrame(runtime: 'internal' | 'external'): string {
	return runtime === 'external'
		? 'You are pi, the machine\'s own coding agent, answering through the PiCode editor. You answer about the project the person you are talking to has open in it.'
		: 'You are pi, the coding agent that runs inside the PiCode editor. You answer about the project the person you are talking to has open in it.';
}

/** The prompt pi is asked with: who it is, the editor's context when there is one, then the request. */
export function withContext(prompt: string, context: string | undefined, runtime: 'internal' | 'external'): string {
	const head = context === undefined ? agentFrame(runtime) : `${agentFrame(runtime)}\n\n${context}`;
	return `${head}\n\n---\n\n${prompt}`;
}
