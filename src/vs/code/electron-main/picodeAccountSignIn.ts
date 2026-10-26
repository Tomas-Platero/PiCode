/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/** What the window is told when a sign-in finishes (or does not). */
export interface AccountSignInResult {
	readonly ok: boolean;
	readonly email?: string;
	readonly plan?: string;
	/** What the editor needs to consider itself signed in, minted the same way it mints it. */
	readonly picture?: string;
	readonly session?: {
		readonly refreshToken: string;
		readonly uid: string;
		readonly email: string;
	};
	/** The one-time code, handed to the editor so it can mint its own session without a browser. */
	readonly code?: string;
	readonly error?: string;
}

/** How long to wait for the browser before giving up. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** The email in a Firebase custom token, read without verifying it: this is display only. */
function emailFromCustomToken(token: string | undefined): string | undefined {
	if (typeof token !== 'string') {
		return undefined;
	}
	const payload = token.split('.')[1];
	if (payload === undefined) {
		return undefined;
	}
	try {
		const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>;
		const claims = typeof json['claims'] === 'object' && json['claims'] !== null ? json['claims'] as Record<string, unknown> : {};
		const email = claims['email'] ?? json['email'];
		return typeof email === 'string' ? email : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Runs one sign-in: starts the server, opens the browser, waits for the code, exchanges it.
 *
 * Every failure is a sentence for the window: the server could not start, the browser could not be
 * opened, nobody came back within five minutes, the address answered with a refusal.
 */
export async function signInFromSetup(options: {
	readonly webOrigin: string;
	readonly firebaseApiKey?: string;
	readonly openExternal: (url: string) => Promise<void>;
	/** Claims `picode://` for this executable; `false` when another copy owns it. */
	readonly registerProtocol: () => boolean;
	/** Hands back the way to stop waiting, and the address that was opened. */
	readonly onStart?: (cancel: () => void, url: string) => void;
	readonly log: (line: string) => void;
}): Promise<AccountSignInResult> {
	let removeWaiter = (): void => { /* replaced below */ };
	let timer: ReturnType<typeof setTimeout> | undefined;

	const code = await new Promise<string | undefined>(resolve => {
		let settled = false;
		const settle = (value: string | undefined): void => {
			if (!settled) {
				settled = true;
				if (timer !== undefined) {
					clearTimeout(timer);
				}
				resolve(value);
			}
		};
		// The callback arrives through the launch path, not through a channel of ours.
		removeWaiter = installCallbackWaiter(url => {
			const received = codeFromCallbackUrl(url);
			if (received === undefined) {
				return false;
			}
			options.log('[picode-onboarding] sign-in: the browser called back');
			settle(received);
			return true;
		});

		// Claim the scheme for this executable before sending anybody to the browser: a stale entry
		// pointing at an old copy is exactly how a callback vanishes without a trace.
		const registered = options.registerProtocol();
		options.log(`[picode-onboarding] sign-in: picode:// ${registered ? 'claimed for this executable' : 'could NOT be claimed'}`);

		// An answer that arrived before this attempt was made is used instead of sending the browser
		// round again: the code is one-time and it belongs to this sign-in.
		const early = takeBufferedCode();
		if (early !== undefined) {
			options.log('[picode-onboarding] sign-in: using the callback that arrived before the click');
			settle(early);
			return;
		}
		const authUrl = `${options.webOrigin}/auth/editor?callback=${encodeURIComponent('picode://auth/callback?flow=editor')}`;
		options.log(`[picode-onboarding] sign-in: opening the browser`);
		options.onStart?.(() => settle(undefined), authUrl);
		void options.openExternal(authUrl).catch(error => {
			options.log(`[picode-onboarding] sign-in: the browser could not be opened: ${String(error)}`);
			settle(undefined);
		});
		timer = setTimeout(() => {
			options.log('[picode-onboarding] sign-in: no callback within five minutes');
			settle(undefined);
		}, SIGN_IN_TIMEOUT_MS);
	});
	removeWaiter();

	if (code === undefined) {
		return { ok: false, error: 'the browser did not finish the sign-in' };
	}

	try {
		const response = await fetch(`${options.webOrigin}/api/auth/editor-exchange`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code }),
		});
		const body = (await response.json().catch(() => ({}))) as { customToken?: string; plan?: string; error?: string };
		if (!response.ok || typeof body.customToken !== 'string') {
			options.log(`[picode-onboarding] sign-in: the exchange answered ${response.status}`);
			return { ok: false, error: body.error ?? `the account service answered ${response.status}` };
		}
		// Minting the editor's own session: the same two calls the editor makes, with the same
		// Firebase key, so what lands in the stores is byte-for-byte what it would have written.
		const session = await mintSession(body.customToken, options.firebaseApiKey);
		if (session === undefined) {
			return { ok: true, email: emailFromCustomToken(body.customToken), plan: body.plan, code };
		}
		return { ok: true, email: session.email, picture: session.picture, plan: body.plan, code, session };
	} catch (error) {
		options.log(`[picode-onboarding] sign-in: the exchange failed: ${String(error)}`);
		return { ok: false, error: 'the account service could not be reached' };
	}
}

/**
 * The sign-in waiting for a browser callback, if there is one.
 *
 * Kept at module level because the callback does not arrive through a channel this module owns: it
 * arrives as a launch from the operating system (a second instance handing its arguments over), and
 * `launchMainService` is what sees it first.
 */
let waitingForCallback: ((url: string) => boolean) | undefined;

/** True while a sign-in is waiting for its callback. */
export function isWaitingForAccountCallback(): boolean {
	return waitingForCallback !== undefined;
}

/**
 * Hands a `picode://` URL to the waiting sign-in.
 *
 * `true` means "this URL was mine": the caller must not open a window for it. That is the whole
 * point — otherwise the callback the setup started would open an editor behind the setup.
 */
export function tryConsumeAccountCallback(url: string): boolean {
	const payload = codeFromCallbackUrl(url);
	// Logged, not silent: when a callback arrives that nobody can use, the log must say *why* —
	// otherwise "the browser came back and nothing happened" has no trace to follow.
	if (payload === undefined) {
		lastRejectedUrl = url;
		return false;
	}
	if (waitingForCallback === undefined) {
		// A callback with nobody waiting is kept, not thrown away: the sign-in may have been
		// restarted, and a one-time code that arrives early is still that sign-in's answer.
		bufferedCode = payload;
		return true;
	}
	return waitingForCallback(url) === true;
}

/** The last code that arrived with nobody waiting, for the next sign-in to use. */
let bufferedCode: string | undefined;
/** The last callback address that carried no code, kept for the log. */
let lastRejectedUrl: string | undefined;

/** Whether a callback arrived that carried no code (used by the debug line in the caller). */
export function lastRejectedCallback(): string | undefined {
	return lastRejectedUrl;
}

/** Takes the buffered code, if any: a sign-in that starts after its answer arrived. */
export function takeBufferedCode(): string | undefined {
	const code = bufferedCode;
	bufferedCode = undefined;
	return code;
}

/** The predicate above, installed for the duration of one sign-in. */
function installCallbackWaiter(onUrl: (url: string) => boolean): () => void {
	waitingForCallback = onUrl;
	return () => {
		waitingForCallback = undefined;
	};
}

/** Reads the one-time code out of a `picode://auth/callback?code=…` address. */
export function codeFromCallbackUrl(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'picode:') {
			return undefined;
		}
		const code = parsed.searchParams.get('code') ?? parsed.searchParams.get('error');
		return typeof code === 'string' && code.length > 0 ? code : undefined;
	} catch {
		return undefined;
	}
}

/** Firebase's answer to a custom-token sign-in: the tokens, not the profile. */
interface MintedSession {
	readonly refreshToken: string;
	readonly idToken: string;
}

/**
 * Trades the custom token for a refresh token — the editor's own session.
 *
 * This is the step that makes "signed in in the editor without opening it" true: the refresh token
 * goes into the same encrypted store the editor reads, so at start it finds a session instead of
 * asking a browser for one.
 */
async function mintSession(customToken: string, firebaseApiKey: string | undefined): Promise<{ refreshToken: string; uid: string; email: string; picture?: string } | undefined> {
	if (typeof firebaseApiKey !== 'string' || firebaseApiKey.length === 0) {
		return undefined;
	}
	const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${firebaseApiKey}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ token: customToken, returnSecureToken: true }),
	});
	const body = (await response.json().catch(() => ({}))) as Partial<MintedSession> & { error?: { message?: string } };
	if (!response.ok || typeof body.refreshToken !== 'string' || typeof body.idToken !== 'string') {
		return undefined;
	}
	const identity = claimsOf(body.idToken);
	const uid = typeof identity['user_id'] === 'string' ? identity['user_id'] : (typeof identity['sub'] === 'string' ? identity['sub'] : '');
	const email = typeof identity['email'] === 'string' ? identity['email'] : '';
	if (uid.length === 0) {
		return undefined;
	}
	const picture = typeof identity['picture'] === 'string' ? identity['picture'] : undefined;
	return { refreshToken: body.refreshToken, uid, email, ...(picture === undefined ? {} : { picture }) };
}

/** The claims of an ID token, read without verifying: this is for display and identity only. */
function claimsOf(token: string): Record<string, unknown> {
	const payload = token.split('.')[1];
	if (payload === undefined) {
		return {};
	}
	try {
		return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * True while the setup window is on screen.
 *
 * Set by the module that owns the window; the launch path asks it before opening anything for a
 * `picode://` URL, because an editor appearing behind the setup is exactly the glitch this whole
 * flow exists to avoid.
 */
let setupWindowOpen = (): boolean => false;

/** Registers the window's state, once, from the module that owns it. */
export function registerSetupWindowState(read: () => boolean): void {
	setupWindowOpen = read;
}

/** Whether a setup window is waiting on screen. */
export function isSetupWindowOpen(): boolean {
	return setupWindowOpen();
}
