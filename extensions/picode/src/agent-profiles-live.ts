/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Applies a Gentle AI agent profile through Gentle itself.
 *
 * Applying is not a file write: Gentle rewrites its routing, the agents' own files, subagents.json
 * and pi's default model, moves the running main agent to the new model, and rolls back when a step
 * fails. Gentle offers that to embedding hosts as a versioned service on pi's event bus
 * (`gentle:desktop:profiles-service`, answered by `extensions/gentle-ai.ts`), which only needs a live
 * session's context. Every chat session carries the small extension below, which keeps that context,
 * so the editor reaches the service without Gentle's desktop control channel (left out on purpose,
 * see `product-packages.ts`).
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

const SERVICE_CHANNEL = 'gentle:desktop:profiles-service';
const SERVICE_SCHEMA = 'gentle-pi.desktop-profiles-service/v1';
/** Gentle's own discovery waits this long for the owner to answer. */
const DISCOVERY_MS = 250;

/** `default`: new chats start with it, and the chat in front moves to it. `session`: only the chat in front. */
export type ApplyMode = 'default' | 'session';

export type ApplyResult =
	| { readonly status: 'confirmation_required'; readonly title: string; readonly message: string; readonly confirmation: string }
	| { readonly status: 'applied' | 'not_applied'; readonly notes: ReadonlyArray<{ readonly level: string; readonly text: string }> }
	| { readonly status: 'unknown_profile' | 'busy' | 'unavailable' };

interface ProfilesService {
	readonly schema: string;
	apply(request: { profile: string; mode: ApplyMode; confirmation?: string }): Promise<unknown>;
	dispose(): void;
}

/** The part of pi's extension API this needs. */
export interface ProfilesPi {
	on(event: 'session_start', handler: (event: unknown, ctx: object) => void): unknown;
	on(event: 'session_shutdown', handler: () => void): unknown;
	on(event: 'before_agent_start', handler: () => void): unknown;
	readonly events?: { emit(channel: string, payload: unknown): void };
}

interface LiveSession {
	readonly pi: ProfilesPi;
	readonly context: object;
	used: number;
}

/** Every chat's live session, by the chat's key. */
const live = new Map<string, LiveSession>();
/** A default the owner chose while no chat was running: applied when the next one starts. */
let pendingDefault: string | undefined;
let order = 0;

/** pi's inline extension shape, as the chat passes it to a session. */
export interface ProfilesInlineExtension {
	readonly name: string;
	readonly hidden: true;
	readonly factory: (pi: ProfilesPi) => void;
}

export function agentProfilesExtension(chatKey: string): ProfilesInlineExtension {
	return {
		name: 'picode-agent-profiles',
		hidden: true,
		factory: pi => {
			pi.on('session_start', (_event, context) => {
				live.set(chatKey, { pi, context, used: ++order });
				const pending = pendingDefault;
				if (pending !== undefined) {
					pendingDefault = undefined;
					// Gentle's own startup has frozen this session's profile already; applying the default
					// now moves it as well, as it would have moved had the chat been running.
					void applyConfirmed(pending, 'default');
				}
			});
			pi.on('before_agent_start', () => {
				const session = live.get(chatKey);
				if (session !== undefined) {
					session.used = ++order;
				}
			});
			pi.on('session_shutdown', () => {
				if (live.get(chatKey)?.pi === pi) {
					live.delete(chatKey);
				}
			});
		},
	};
}

/** Whether a chat is running, so a profile can be applied right now. */
export function hasLiveSession(): boolean {
	return live.size > 0;
}

/** The chat the owner used last: "this chat". */
function frontSession(): LiveSession | undefined {
	let front: LiveSession | undefined;
	for (const session of live.values()) {
		if (front === undefined || session.used > front.used) {
			front = session;
		}
	}
	return front;
}

function discover(session: LiveSession): Promise<ProfilesService | undefined> {
	return new Promise(resolve => {
		let settled = false;
		const timer = setTimeout(() => { settled = true; resolve(undefined); }, DISCOVERY_MS);
		const respond = (value: unknown): void => {
			const service = value as Partial<ProfilesService> | undefined;
			if (service?.schema !== SERVICE_SCHEMA || typeof service.apply !== 'function' || typeof service.dispose !== 'function') {
				return;
			}
			if (settled) {
				service.dispose();
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(service as ProfilesService);
		};
		try {
			session.pi.events?.emit(SERVICE_CHANNEL, { context: session.context, respond });
		} catch {
			settled = true;
			clearTimeout(timer);
			resolve(undefined);
		}
		if (session.pi.events === undefined && !settled) {
			settled = true;
			clearTimeout(timer);
			resolve(undefined);
		}
	});
}

function resultOf(value: unknown): ApplyResult {
	const result = value as { status?: unknown; title?: unknown; message?: unknown; confirmation?: unknown; notes?: unknown } | undefined;
	switch (result?.status) {
		case 'confirmation_required':
			return typeof result.title === 'string' && typeof result.message === 'string' && typeof result.confirmation === 'string'
				? { status: 'confirmation_required', title: result.title, message: result.message, confirmation: result.confirmation }
				: { status: 'unavailable' };
		case 'applied':
		case 'not_applied':
			return { status: result.status, notes: Array.isArray(result.notes) ? result.notes.filter(note => typeof note?.text === 'string').map(note => ({ level: String(note.level ?? 'info'), text: note.text as string })) : [] };
		case 'unknown_profile':
		case 'busy':
			return { status: result.status };
		default:
			return { status: 'unavailable' };
	}
}

/**
 * Asks Gentle to apply a profile in the chat the owner used last. Gentle may answer
 * `confirmation_required` with the dialog its own screen would show; showing it and calling again with
 * its `confirmation` is the caller's part.
 */
export async function applyAgentProfile(profile: string, mode: ApplyMode, confirmation?: string): Promise<ApplyResult> {
	const session = frontSession();
	if (session === undefined) {
		return { status: 'unavailable' };
	}
	const service = await discover(session);
	if (service === undefined) {
		return { status: 'unavailable' };
	}
	try {
		return resultOf(await service.apply({ profile, mode, ...(confirmation === undefined ? {} : { confirmation }) }));
	} catch {
		return { status: 'unavailable' };
	} finally {
		try {
			service.dispose();
		} catch {
			// Best effort, as Gentle's own bridge does.
		}
	}
}

/** Applies without asking: the owner already chose this (an editor profile, or a choice made while no chat ran). */
export async function applyConfirmed(profile: string, mode: ApplyMode): Promise<ApplyResult> {
	const first = await applyAgentProfile(profile, mode);
	return first.status === 'confirmation_required' ? applyAgentProfile(profile, mode, first.confirmation) : first;
}

/** Remembers a default chosen while no chat runs; the next chat applies it as it starts. */
export function deferDefault(profile: string): void {
	pendingDefault = profile;
}

/** For tests: forgets every session and anything pending. */
export function resetLiveProfiles(): void {
	live.clear();
	pendingDefault = undefined;
	order = 0;
}
