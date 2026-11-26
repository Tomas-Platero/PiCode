/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, timingSafeEqual } from 'crypto';
import { resolve, sep } from 'path';

/**
 * The wire format of PiCode's local agent bridge: one JSON object per line, both ways.
 *
 * A request carries the bridge token, a caller-chosen id echoed back in the reply, a method and
 * its params. Only `session.start` exists for now. Replies never carry file paths: a caller gets
 * the pi session id and its own task id, nothing about where PiCode keeps things.
 */

/** Longest line the bridge reads; anything longer is dropped with `invalid_request`. */
// Room for the longest prompt even when every character is escaped in JSON (6 bytes each).
export const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TASK_ID_LENGTH = 200;
const MAX_PROMPT_LENGTH = 100_000;

export type BridgeErrorCode =
	| 'invalid_request'
	| 'unauthorized'
	| 'unknown_method'
	| 'folder_not_found'
	| 'folder_not_trusted'
	| 'task_conflict'
	| 'outcome_uncertain'
	| 'not_sent'
	| 'internal_error';

export interface BridgeRequestId {
	readonly id: string | number | null;
}

export interface SessionStartParams {
	/** The folder exactly as the caller wrote it, resolved to an absolute path. */
	readonly folder: string;
	/** The folder's identity: resolved, no trailing separator, case-folded on Windows. */
	readonly folderKey: string;
	readonly taskId: string;
	readonly prompt: string;
	/** SHA-256 of the prompt: the same task id must always carry the same assignment. */
	readonly promptHash: string;
	/** The caller's explicit choice to send again when PiCode cannot tell whether pi got it. */
	readonly resendUncertain: boolean;
}

export type ParsedRequest =
	| { readonly kind: 'session.start'; readonly id: string | number; readonly params: SessionStartParams }
	| { readonly kind: 'error'; readonly id: string | number | null; readonly code: BridgeErrorCode; readonly message: string };

export interface BridgeReply {
	readonly id: string | number | null;
	readonly result?: { readonly sessionId: string; readonly taskId: string; readonly reused: boolean };
	readonly error?: { readonly code: BridgeErrorCode; readonly message: string };
}

export function hashPrompt(prompt: string): string {
	return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

/** The identity two spellings of one folder share. */
export function folderKeyOf(folder: string, platform: NodeJS.Platform = process.platform): string {
	let resolved = resolve(folder);
	while (resolved.length > 1 && (resolved.endsWith(sep) || resolved.endsWith('/')) && !/^[a-zA-Z]:[\\/]$/.test(resolved)) {
		resolved = resolved.slice(0, -1);
	}
	return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Compares the presented token with the bridge's without leaking how much of it matched. */
export function tokenMatches(presented: unknown, expected: string): boolean {
	if (typeof presented !== 'string') {
		return false;
	}
	const a = Buffer.from(presented, 'utf8');
	const b = Buffer.from(expected, 'utf8');
	return a.length === b.length && timingSafeEqual(a, b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads one request line. The token is checked here, before anything else in the request is
 * looked at, so a caller without it learns nothing beyond `unauthorized`.
 */
export function parseRequest(line: string, token: string): ParsedRequest {
	if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
		return { kind: 'error', id: null, code: 'invalid_request', message: 'The request is too long.' };
	}
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return { kind: 'error', id: null, code: 'invalid_request', message: 'The request is not valid JSON.' };
	}
	if (!isRecord(value)) {
		return { kind: 'error', id: null, code: 'invalid_request', message: 'The request must be a JSON object.' };
	}
	const rawId = value['id'];
	const id = typeof rawId === 'string' || (typeof rawId === 'number' && Number.isFinite(rawId)) ? rawId : null;
	if (!tokenMatches(value['token'], token)) {
		return { kind: 'error', id, code: 'unauthorized', message: 'The token is missing or wrong.' };
	}
	if (id === null) {
		return { kind: 'error', id, code: 'invalid_request', message: 'The request needs an "id" (string or number).' };
	}
	if (value['method'] !== 'session.start') {
		return { kind: 'error', id, code: 'unknown_method', message: 'Unknown method.' };
	}
	const params = value['params'];
	if (!isRecord(params)) {
		return { kind: 'error', id, code: 'invalid_request', message: 'The request needs "params".' };
	}
	const { folder, taskId, prompt, resendUncertain } = params;
	if (typeof folder !== 'string' || folder.trim() === '' || !isAbsolutePath(folder)) {
		return { kind: 'error', id, code: 'invalid_request', message: '"folder" must be an absolute path on this computer.' };
	}
	if (typeof taskId !== 'string' || taskId.trim() === '' || taskId.length > MAX_TASK_ID_LENGTH || /[\u0000-\u001f]/.test(taskId)) {
		return { kind: 'error', id, code: 'invalid_request', message: `"taskId" must be a non-empty string of up to ${MAX_TASK_ID_LENGTH} characters.` };
	}
	if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > MAX_PROMPT_LENGTH) {
		return { kind: 'error', id, code: 'invalid_request', message: `"prompt" must be a non-empty string of up to ${MAX_PROMPT_LENGTH} characters.` };
	}
	// The chat reads a leading `/` as a command and `@` as another participant: such a prompt would
	// not reach pi as the assignment, and the task could never be confirmed.
	if (/^\s*[/@]/.test(prompt)) {
		return { kind: 'error', id, code: 'invalid_request', message: '"prompt" cannot start with "/" or "@".' };
	}
	if (resendUncertain !== undefined && typeof resendUncertain !== 'boolean') {
		return { kind: 'error', id, code: 'invalid_request', message: '"resendUncertain" must be true or false.' };
	}
	const resolvedFolder = resolve(folder);
	return {
		kind: 'session.start',
		id,
		params: {
			folder: resolvedFolder,
			folderKey: folderKeyOf(resolvedFolder),
			taskId,
			prompt,
			promptHash: hashPrompt(prompt),
			resendUncertain: resendUncertain === true,
		},
	};
}

/** A local absolute path. Network shares are left out: a share that does not answer would stall PiCode. */
function isAbsolutePath(folder: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(folder) || (process.platform !== 'win32' && folder.startsWith('/'));
}

export function errorReply(id: string | number | null, code: BridgeErrorCode, message: string): BridgeReply {
	return { id, error: { code, message } };
}

export function serializeReply(reply: BridgeReply): string {
	return JSON.stringify(reply);
}
