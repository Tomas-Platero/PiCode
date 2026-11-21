/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What pi found wrong while it built a session, ready to be said in the chat.
 *
 * Since pi 1.6 a host that embeds pi gets these back instead of seeing them printed: the service
 * diagnostics (a provider that did not register, an `enabledModels` pattern matching nothing), the
 * extensions that failed to load, and the model a resumed conversation could not get back. They
 * used to reach only the log, so a broken extension simply was not there and nobody knew why.
 */

import { l10n } from './l10n.ts';

export interface SessionProblem {
	readonly kind: 'warning' | 'error' | 'extension' | 'model';
	readonly text: string;
}

export interface SessionProblemSources {
	readonly diagnostics: readonly { readonly type: 'info' | 'warning' | 'error'; readonly message: string }[] | undefined;
	readonly extensionErrors: readonly { readonly path: string; readonly error: string }[] | undefined;
	readonly modelFallbackMessage?: string;
}

/** The extension's name from where it was loaded: its folder, or the file name for a loose file. */
function extensionName(file: string): string {
	const parts = file.split(/[\\/]+/).filter(Boolean);
	const last = parts[parts.length - 1] ?? file;
	const isEntry = /^index\.[cm]?[jt]sx?$/i.test(last) || /^(dist|src|out|lib)$/i.test(parts[parts.length - 2] ?? '');
	if (!isEntry) {
		return last.replace(/\.[cm]?[jt]sx?$/i, '');
	}
	// `<name>/index.ts`, `<name>/dist/index.js`: the first folder that is not a build folder.
	for (let i = parts.length - 2; i >= 0; i--) {
		if (!/^(dist|src|out|lib)$/i.test(parts[i])) {
			return parts[i];
		}
	}
	return last;
}

/** Everything worth saying, in pi's order: its diagnostics, then extensions, then the model. */
export function sessionProblems(sources: SessionProblemSources): SessionProblem[] {
	const problems: SessionProblem[] = [];
	for (const diagnostic of sources.diagnostics ?? []) {
		if ((diagnostic.type === 'warning' || diagnostic.type === 'error') && diagnostic.message.trim() !== '') {
			problems.push({ kind: diagnostic.type, text: diagnostic.message.trim() });
		}
	}
	for (const failure of sources.extensionErrors ?? []) {
		problems.push({ kind: 'extension', text: l10n.t('The extension “{0}” could not load, so it is off in this chat.', extensionName(failure.path)) });
	}
	const fallback = sources.modelFallbackMessage?.trim();
	if (fallback) {
		problems.push({ kind: 'model', text: fallback });
	}
	return problems;
}

/** The problems not said yet in this window; they are marked as said. */
export function unseenProblems(problems: readonly SessionProblem[], seen: Set<string>): SessionProblem[] {
	const fresh: SessionProblem[] = [];
	for (const problem of problems) {
		const key = `${problem.kind}\u0000${problem.text}`;
		if (!seen.has(key)) {
			seen.add(key);
			fresh.push(problem);
		}
	}
	return fresh;
}
