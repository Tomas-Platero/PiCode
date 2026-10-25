/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { pathToFileURL } from 'node:url';

/**
 * One pi session, opened inside the agent host process.
 *
 * pi runs in this process and not in a child one: the agent host is already a Node utility
 * process, so the SDK can be used directly, and a chat is then a session object rather than
 * a protocol conversation over stdio. That is the whole reason pi can be an agent provider
 * here without any extension.
 *
 * ## Why this module types the SDK structurally instead of importing it
 *
 * pi is **not** a build dependency of the workbench, and deliberately so. The extension
 * already loads it at runtime from the installation the owner selected, and the host does
 * the same: the path arrives as a parameter. Typing the few members actually called — the
 * same discipline `pi-login-command.ts` uses for `LoginSdk` — keeps the build free of a
 * dependency it would otherwise have to lock, while still calling a real, documented API.
 *
 * Anything this module cannot express from the SDK is *reported*, never guessed: a member
 * that returns `undefined` here means pi did not provide it, and the caller is expected to
 * treat that as a fact about the session rather than as an empty value.
 */

/** The slice of pi's `AgentSession` this module calls. */
export interface IPiAgentSession {
	readonly sessionId: string;
	/** Absolute path of the session file, or `undefined` before the first write. */
	readonly sessionFile: string | undefined;
	readonly sessionName: string | undefined;
	readonly isStreaming: boolean;
	readonly isIdle: boolean;
	prompt(text: string, options?: { readonly streamingBehavior?: 'steer' | 'followUp' }): Promise<void>;
	abort(): Promise<void>;
	subscribe(listener: (event: unknown) => void): () => void;
	dispose(): void;
}

/** What pi's `createAgentSession` answers. */
export interface IPiCreateSessionResult {
	readonly session: IPiAgentSession;
}

/** The one SDK entry point this module needs. */
export interface IPiSdk {
	createAgentSession(options: {
		readonly cwd: string;
		readonly agentDir?: string;
	}): Promise<IPiCreateSessionResult>;
}

/** Where pi's SDK lives for the instance in force, and where its profile does. */
export interface IPiRuntimeLocation {
	/** Absolute path of pi's `dist/index.js`, as the caller resolved it. */
	readonly sdkEntry: string;
	/** The profile directory to open the session against, or `undefined` for pi's own. */
	readonly agentDir: string | undefined;
}

export type PiSdkLoad =
	| { readonly kind: 'ready'; readonly sdk: IPiSdk }
	| { readonly kind: 'unreadable' }
	| { readonly kind: 'no-sdk' };

/**
 * Loads pi's SDK from the path it was given.
 *
 * `unreadable` and `no-sdk` are kept apart because they are two different sentences for
 * whoever reads the log: the first is "pi is not where it was said to be", the second is
 * "that pi is older than the entry point this needs". Collapsing them would report a
 * version problem as a missing installation.
 */
export async function loadPiSdk(sdkEntry: string): Promise<PiSdkLoad> {
	let sdk: Partial<IPiSdk>;
	try {
		sdk = (await import(pathToFileURL(sdkEntry).href)) as Partial<IPiSdk>;
	} catch {
		return { kind: 'unreadable' };
	}
	if (typeof sdk.createAgentSession !== 'function') {
		return { kind: 'no-sdk' };
	}
	return { kind: 'ready', sdk: sdk as IPiSdk };
}

/** A session that could not be opened, with the reason kept for the log. */
export class PiSessionError extends Error {
	constructor(message: string, readonly reason: 'unreadable' | 'no-sdk' | 'failed') {
		super(message);
		this.name = 'PiSessionError';
	}
}

/**
 * Opens a session for `cwd`.
 *
 * The session is created first and the caller subscribes afterwards, which is what the
 * SDK's own shape allows; nothing is prompted until `prompt()` is called, so no event can
 * be missed in between.
 */
export async function openPiSession(location: IPiRuntimeLocation, cwd: string): Promise<IPiAgentSession> {
	const load = await loadPiSdk(location.sdkEntry);
	if (load.kind !== 'ready') {
		throw new PiSessionError(
			load.kind === 'unreadable'
				? `pi is not readable at ${location.sdkEntry}`
				: 'the pi at this location does not expose createAgentSession',
			load.kind,
		);
	}

	let created: IPiCreateSessionResult;
	try {
		created = await load.sdk.createAgentSession(
			location.agentDir === undefined ? { cwd } : { cwd, agentDir: location.agentDir },
		);
	} catch (error) {
		throw new PiSessionError(
			`pi could not open a session for ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
			'failed',
		);
	}
	return created.session;
}
