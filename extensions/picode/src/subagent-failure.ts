/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Why a subagent's model did not answer, in words a person can act on.
 *
 * When the provider refuses a request, gentle-pi records the task as failed with one fixed line,
 * "assistant reported an error", and keeps the provider's own answer only in the subagent's
 * session file. This module reads that answer back and sorts it: out of allowance, key refused,
 * too many requests, model not offered. The same sorting decides whether a subagent may retry
 * on the chat's model (`subagent-model-fallback.ts`).
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

/** The fixed line gentle-pi records when the provider answered with an error. */
export const GENERIC_PROVIDER_ERROR = 'assistant reported an error';

export type FailureKind = 'allowance' | 'access' | 'rate' | 'model' | 'other';

/** One provider refusal, as the subagent's session recorded it. */
export interface ProviderFailure {
	readonly provider: string;
	readonly model: string;
	readonly message: string;
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
	nan: 'NaN',
	omni: 'Omni',
	openai: 'OpenAI',
	anthropic: 'Anthropic',
	deepseek: 'DeepSeek',
	openrouter: 'OpenRouter',
	google: 'Google',
	groq: 'Groq',
	mistral: 'Mistral',
	xai: 'xAI',
};

function providerName(provider: string): string {
	return PROVIDER_NAMES[provider.toLowerCase()] ?? provider;
}

/** The HTTP status a provider error starts with (`402: {...}`), if it starts with one. */
function statusOf(message: string): number | undefined {
	const match = /^\s*(\d{3})\b/.exec(message);
	return match === null ? undefined : Number(match[1]);
}

/** The provider's own sentence: the `message` of a JSON body when there is one, else the text. */
function innerMessage(message: string): string {
	const start = message.indexOf('{');
	if (start >= 0) {
		try {
			const body = JSON.parse(message.slice(start)) as { message?: unknown; error?: { message?: unknown } | unknown };
			const inner = typeof body.message === 'string' ? body.message
				: typeof (body.error as { message?: unknown } | undefined)?.message === 'string' ? (body.error as { message: string }).message
					: undefined;
			if (inner !== undefined && inner.trim().length > 0) {
				return inner.trim();
			}
		} catch {
			// Not JSON after all: the text is the message.
		}
	}
	return message.trim();
}

export function failureKind(message: string): FailureKind {
	const status = statusOf(message);
	if (status === 402 || /allowance|quota|insufficient[ _-]?(?:funds|credit|balance)|out of credits?|credit balance|billing|monthly[ _-]?cap|usage limit/i.test(message)) {
		return 'allowance';
	}
	if (status === 401 || status === 403 || /unauthori[sz]ed|invalid[ _-]?api[ _-]?key|incorrect api key|forbidden|authentication|no api key/i.test(message)) {
		return 'access';
	}
	if (status === 429 || /rate[ _-]?limit|too many requests/i.test(message)) {
		return 'rate';
	}
	if (/model[^.]{0,40}(?:not found|does not exist|not available|unsupported)|unknown model|no such model/i.test(message)) {
		return 'model';
	}
	return 'other';
}

/** Whether another model could answer where this one was refused: the refusal is about this provider, not the work. */
export function canTryAnotherModel(message: string): boolean {
	return failureKind(message) !== 'other';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "resets Nov 1" when the provider said when the allowance comes back. */
function resetNote(message: string): string {
	const match = /reset[^.]*?(\d{4})-(\d{2})-(\d{2})/i.exec(message);
	if (match === null) {
		return '';
	}
	const month = MONTHS[Number(match[2]) - 1];
	return month === undefined ? '' : ` · resets ${month} ${Number(match[3])}`;
}

const OTHER_LIMIT = 160;

/** One line for the Problem row. */
export function describeFailure(failure: ProviderFailure): string {
	const who = providerName(failure.provider);
	switch (failureKind(failure.message)) {
		case 'allowance': return `${who} allowance used up${resetNote(failure.message)}`;
		case 'access': return `${who} refused the key or sign-in`;
		case 'rate': return `${who} is limiting requests — try again later`;
		case 'model': return `${who} does not offer ${failure.model}`;
		default: {
			const text = innerMessage(failure.message).replace(/\s+/g, ' ');
			return `${who}: ${text.length > OTHER_LIMIT ? `${text.slice(0, OTHER_LIMIT - 1)}…` : text}`;
		}
	}
}

/** The last provider refusal in a session file's lines, or `undefined` when the last answer was not one. */
export function lastProviderFailure(sessionText: string): ProviderFailure | undefined {
	const lines = sessionText.split('\n');
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index]!.trim();
		if (!line.includes('"assistant"')) {
			continue;
		}
		let entry: { message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown; provider?: unknown; model?: unknown } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry.message;
		if (message?.role !== 'assistant') {
			continue;
		}
		if (message.stopReason !== 'error' || typeof message.errorMessage !== 'string' || message.errorMessage.length === 0) {
			return undefined;
		}
		return {
			provider: typeof message.provider === 'string' ? message.provider : '',
			model: typeof message.model === 'string' ? message.model : '',
			message: message.errorMessage,
		};
	}
	return undefined;
}

/**
 * The real reason a finished task failed, read from Gentle's task record and the session it points
 * at, or `undefined` when the task did not fail on a provider refusal or the files are gone.
 */
export function explainTaskFailure(profileDir: string, id: string, read: (file: string) => string = file => fs.readFileSync(file, 'utf8')): string | undefined {
	try {
		const record = JSON.parse(read(path.join(profileDir, 'gentle-agents', 'tasks', `${id}.json`))) as { task?: { sessionPath?: unknown } };
		const sessionPath = record.task?.sessionPath;
		if (typeof sessionPath !== 'string' || sessionPath.length === 0) {
			return undefined;
		}
		const failure = lastProviderFailure(read(sessionPath));
		return failure === undefined ? undefined : describeFailure(failure);
	} catch {
		return undefined;
	}
}
