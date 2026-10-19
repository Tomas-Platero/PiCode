/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IRequestContext } from '../../../../base/parts/request/common/request.js';
import { URI } from '../../../../base/common/uri.js';
import { AUTH_CALLBACK_PATH, oneTimeCodeFromCallback } from './picodeAuthCallback.js';
import { decodeBase64 } from '../../../../base/common/buffer.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IURLService } from '../../../../platform/url/common/url.js';
import { AuthenticationSession, AuthenticationSessionAccount, AuthenticationSessionsChangeEvent, IAuthenticationProvider, IAuthenticationProviderSessionOptions } from '../../../services/authentication/common/authentication.js';

/**
 * PiCode's first-party authentication provider, used by the Settings Sync engine and by
 * anything else that wants to talk to getpicode.app on the user's behalf.
 *
 * Sign-in uses the one-time code flow (the same shape as Microsoft/GitHub): the editor
 * hands the web app a `picode://` callback address, the user signs in there, and the web
 * app sends back a **one-time code** instead of any token. The editor exchanges that code
 * for a Firebase custom token, mints its own session from it, and keeps only its own
 * refresh token in secret storage — no sensitive token ever travels through the browser's
 * history or logs. Later sessions are refreshed silently through Firebase's public token
 * endpoint; a refresh that comes back with a client error means the account was revoked
 * and the stored account data is dropped.
 */

/** The authentication provider id. Also the key used in `product.json` under `configurationSync.store.authenticationProviders`. */
export const PICODE_AUTH_PROVIDER_ID = 'picode';

/** The provider's label, declared once here and reused by the contribution that registers it. */
export const PICODE_ACCOUNT_LABEL = localize('picode.account.label', "PiCode Account");

/** Secret storage key for the refresh token of the editor's own Firebase session. */
const PICODE_REFRESH_TOKEN_SECRET_KEY = 'picode.account.refreshToken';

/** Application-scope storage keys caching who is signed in, so sessions can be rebuilt without a network round-trip. */
const PICODE_UID_STORAGE_KEY = 'picode.account.uid';
const PICODE_EMAIL_STORAGE_KEY = 'picode.account.email';
const PICODE_SCOPES_STORAGE_KEY = 'picode.account.scopes';

/** Firebase ID tokens live for one hour; treat them as stale a little earlier so a refresh happens before they expire. */
const ID_TOKEN_STALENESS_MS = 50 * 60 * 1000;

/** How long the editor waits for the web app to come back with the one-time code. */
const SIGN_IN_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

const FIREBASE_TOKEN_ENDPOINT = 'https://securetoken.googleapis.com/v1/token';
const FIREBASE_CUSTOM_TOKEN_ENDPOINT = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken';

/** Response of Firebase's accounts:signInWithCustomToken (camelCase keys on purpose). */
interface CustomTokenExchangeResponse {
	idToken?: string;
	refreshToken?: string;
	expiresIn?: string;
	isNewUser?: boolean;
}

interface FirebaseIdentity {
	uid?: string;
	email?: string;
	picture?: string;
}

/** Response of Firebase's securetoken endpoint (snake_case keys on purpose). */
interface FirebaseTokenResponse {
	id_token?: string;
	refresh_token?: string;
	user_id?: string;
	email?: string;
}

export class PiCodeAccountProvider extends Disposable implements IAuthenticationProvider {

	readonly id = PICODE_AUTH_PROVIDER_ID;
	readonly label = PICODE_ACCOUNT_LABEL;
	readonly supportsMultipleAccounts = false;

	private readonly _onDidChangeSessions = this._register(new Emitter<AuthenticationSessionsChangeEvent>());
	readonly onDidChangeSessions: Event<AuthenticationSessionsChangeEvent> = this._onDidChangeSessions.event;

	private _cachedIdToken: { readonly token: string; readonly expiresAt: number } | undefined;
	private _lastPicture: string | undefined;
	private _refreshing: Promise<string | undefined> | undefined;

	constructor(
		private readonly _config: { readonly webOrigin: string; readonly firebaseApiKey: string },
		@IURLService private readonly _urlService: IURLService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IProductService private readonly _productService: IProductService,
		@ILogService private readonly _logService: ILogService,
		@ISecretStorageService private readonly _secretStorageService: ISecretStorageService,
		@IStorageService private readonly _storageService: IStorageService,
		@IRequestService private readonly _requestService: IRequestService,
	) {
		super();
	}

	override dispose(): void {
		this._cachedIdToken = undefined;
		this._refreshing = undefined;
		super.dispose();
	}

	async createSession(scopes: string[], _options: IAuthenticationProviderSessionOptions): Promise<AuthenticationSession> {
		// 1. Send the user to the web app and wait for it to come back with the one-time code.
		const code = await this._requestOneTimeCode();

		// 2. Exchange the code for a Firebase custom token (server-side, on the web app's API).
		const { customToken } = await this._exchangeOneTimeCode(code);

		// 3. Anyone with a PiCode Account signs in and stays linked — the account itself is free.
		//    What a free account cannot do is SYNC: the sync service is the authority for that and
		//    answers 402 to any plan that is not Pro, which the sync UI turns into one clear notice
		//    (see the PaymentRequired handling in the userDataSync contribution). Gating the
		//    sign-in here instead would lock a free owner out of the whole account surface — and
		//    would keep a user who subscribed after signing in locked out until a new sign-in.

		// 4. Mint the editor's own session: a custom token is exchanged at the identitytoolkit
		//    endpoint (`accounts:signInWithCustomToken`) — the securetoken endpoint only accepts
		//    refresh tokens. The refresh token that comes back belongs to the editor,
		//    independent of the browser session. The identitytoolkit answer carries no user
		//    fields, so uid/email are read from the ID token payload itself.
		const minted = await this._mintFromCustomToken(customToken);
		if (minted.statusCode !== 200 || !minted.json?.idToken || !minted.json.refreshToken) {
			throw new Error(localize('picode.account.signInFailed', "Sign-in could not be completed. Please try again."));
		}

		// 5. Persist the account and return the session. The Firebase ID token goes into both
		//    `accessToken` and `idToken`: the Settings Sync engine uses `idToken || accessToken`.
		const idToken = minted.json.idToken;
		const identity = this._decodeIdTokenPayload(idToken);
		const uid = identity.uid || identity.email || '';
		if (!uid) {
			throw new Error(localize('picode.account.signInFailed', "Sign-in could not be completed. Please try again."));
		}
		const email = identity.email ?? '';
		await this._secretStorageService.set(PICODE_REFRESH_TOKEN_SECRET_KEY, minted.json.refreshToken);
		this._storageService.store(PICODE_UID_STORAGE_KEY, uid, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._storageService.store(PICODE_EMAIL_STORAGE_KEY, email, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._storageService.store(PICODE_SCOPES_STORAGE_KEY, JSON.stringify(scopes), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._cachedIdToken = { token: idToken, expiresAt: Date.now() + ID_TOKEN_STALENESS_MS };
		this._lastPicture = identity.picture;
		const session = this._createSession(uid, email, scopes, idToken);
		// The Accounts icon repaints from these events — AuthenticationService.createSession
		// does not fire one itself, so without this the avatar would only appear after a restart.
		this._onDidChangeSessions.fire({ added: [session], changed: [], removed: [] });
		return session;
	}

	async getSessions(scopes: string[] | undefined, _options: IAuthenticationProviderSessionOptions): Promise<readonly AuthenticationSession[]> {
		const refreshToken = await this._secretStorageService.get(PICODE_REFRESH_TOKEN_SECRET_KEY);
		if (!refreshToken) {
			return [];
		}
		const storedScopes = this._storedScopes();
		if (scopes && !scopes.every(scope => storedScopes.includes(scope))) {
			return [];
		}

		// Ensure a fresh ID token; refresh transparently when the cached one went stale.
		const idToken = await this._ensureIdToken(refreshToken);
		if (!idToken) {
			// The refresh was rejected: the session was revoked and already removed.
			return [];
		}

		const userId = this._storageService.get(PICODE_UID_STORAGE_KEY, StorageScope.APPLICATION) ?? '';
		const email = this._storageService.get(PICODE_EMAIL_STORAGE_KEY, StorageScope.APPLICATION) ?? '';
		return [this._createSession(userId, email, storedScopes, idToken)];
	}

	async removeSession(_sessionId: string): Promise<void> {
		const removed = await this._buildCurrentSession();
		await this._forgetAccount();
		this._onDidChangeSessions.fire({ added: [], changed: [], removed: removed ? [removed] : [] });
	}

	private _createSession(userId: string, email: string, scopes: ReadonlyArray<string>, idToken: string): AuthenticationSession {
		// The avatar comes from the ID token's `picture` claim (present for Google/GitHub
		// sign-ins, absent for email+password). Both the fresh sign-in and the silent
		// refresh paths build the session here, so both pick the avatar up.
		const picture = this._decodeIdTokenPayload(idToken).picture;
		const account: AuthenticationSessionAccount = picture
			? { id: userId, label: email, icon: URI.parse(picture) }
			: { id: userId, label: email };
		return {
			id: userId,
			account,
			scopes: [...scopes],
			accessToken: idToken,
			idToken,
		};
	}

	private _storedScopes(): string[] {
		const stored = this._storageService.get(PICODE_SCOPES_STORAGE_KEY, StorageScope.APPLICATION);
		if (!stored) {
			return [];
		}
		try {
			const parsed: unknown = JSON.parse(stored);
			return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
		} catch {
			return [];
		}
	}

	private async _buildCurrentSession(idToken?: string): Promise<AuthenticationSession | undefined> {
		const userId = this._storageService.get(PICODE_UID_STORAGE_KEY, StorageScope.APPLICATION);
		if (!userId) {
			return undefined;
		}
		const email = this._storageService.get(PICODE_EMAIL_STORAGE_KEY, StorageScope.APPLICATION) ?? userId;
		return this._createSession(userId, email, this._storedScopes(), idToken ?? '');
	}

	private async _forgetAccount(): Promise<void> {
		await this._secretStorageService.delete(PICODE_REFRESH_TOKEN_SECRET_KEY);
		this._storageService.remove(PICODE_UID_STORAGE_KEY, StorageScope.APPLICATION);
		this._storageService.remove(PICODE_EMAIL_STORAGE_KEY, StorageScope.APPLICATION);
		this._storageService.remove(PICODE_SCOPES_STORAGE_KEY, StorageScope.APPLICATION);
		this._cachedIdToken = undefined;
	}

	/**
	 * Returns a valid ID token for the stored refresh token, or `undefined` when the session
	 * was revoked (in which case the account data was cleared and removal was announced).
	 * Other failures are thrown and left for the caller to report.
	 */
	private async _ensureIdToken(refreshToken: string): Promise<string | undefined> {
		if (this._cachedIdToken && this._cachedIdToken.expiresAt > Date.now()) {
			return this._cachedIdToken.token;
		}
		// Coalesce concurrent refreshes so parallel session requests share one round-trip.
		if (!this._refreshing) {
			this._refreshing = this._refresh(refreshToken).finally(() => { this._refreshing = undefined; });
		}
		return this._refreshing;
	}

	private async _refresh(refreshToken: string): Promise<string | undefined> {
		const response = await this._postFirebaseToken(refreshToken);
		if (response.statusCode !== 200 || !response.json?.id_token || !response.json.refresh_token || !response.json.user_id) {
			// A 4xx means the refresh token is no longer valid: the account was signed out,
			// the token was revoked or the account was deleted. Forget it and move on.
			if (response.statusCode !== undefined && response.statusCode >= 400 && response.statusCode < 500) {
				const removed = await this._buildCurrentSession();
				await this._forgetAccount();
				this._onDidChangeSessions.fire({ added: [], changed: [], removed: removed ? [removed] : [] });
				return undefined;
			}
			throw new Error(localize('picode.account.tokenRefreshFailed', "Your PiCode session could not be refreshed. Please try again later."));
		}
		const { id_token, refresh_token, email } = response.json;
		this._cachedIdToken = { token: id_token, expiresAt: Date.now() + ID_TOKEN_STALENESS_MS };
		// Firebase rotates refresh tokens; keep the newest one.
		if (refresh_token !== refreshToken) {
			await this._secretStorageService.set(PICODE_REFRESH_TOKEN_SECRET_KEY, refresh_token);
		}
		// The account may have gained a resolved email since the sign-in.
		if (email) {
			this._storageService.store(PICODE_EMAIL_STORAGE_KEY, email, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		// The avatar can change while the session lives (the user updated their photo
		// on the web) — announce it so the Accounts icon repaints without a restart.
		const identity = this._decodeIdTokenPayload(id_token);
		if ((identity.picture ?? undefined) !== this._lastPicture) {
			const session = await this._buildCurrentSession(id_token);
			if (session) {
				this._onDidChangeSessions.fire({ added: [], changed: [session], removed: [] });
			}
		}
		this._lastPicture = identity.picture;
		return id_token;
	}

	/** Waits for the web app to redirect back to `picode://` with the one-time code. */
	private _requestOneTimeCode(): Promise<string> {
		// Built by hand instead of via `urlService.create()`: the workbench URL service
		// decorates every created URL with `windowId=N` and URI serialization double-encodes
		// the query, which fragmented the callback once `&code=` was appended by the web
		// app. A plain URI keeps the callback deterministic: the provider handler matches
		// on scheme+path (not query), and the router hands it to the active window.
		const callbackUri = URI.from({
			scheme: this._productService.urlProtocol,
			path: AUTH_CALLBACK_PATH,
			query: 'flow=editor',
		});
		const authUrl = `${this._config.webOrigin}/auth/editor?callback=${encodeURIComponent(callbackUri.toString())}`;
		const disposables = new DisposableStore();
		return new Promise<string>((resolve, reject) => {
			let settled = false;
			const settle = (fn: () => void): void => {
				if (!settled) {
					settled = true;
					fn();
				}
			};

			// The handler must listen before the browser is opened, so the first callback
			// cannot be missed. It claims only URIs it recognizes and lets the rest through.
			// A dead or foreign handler for the scheme is invisible to this window: the
			// browser hands `picode:/…` to the OS, and if the registered command no longer
			// exists the redirect goes nowhere — no event, no error, silence. That is why
			// what we wait for, the timeout and the recovery are all logged below.
			disposables.add(this._urlService.registerHandler({
				handleURL: async uri => {
					const code = oneTimeCodeFromCallback(uri, callbackUri.scheme);
					if (!code) {
						return false;
					}
					this._logService.info('[picode.account] sign-in callback received from the browser.');
					settle(() => resolve(code));
					return true;
				},
			}));

			const timeoutHandle = setTimeout(() => {
				this._logService.warn(
					`[picode.account] no sign-in callback arrived within 5 minutes (waiting for ${callbackUri.toString(true)}). ` +
					'If the browser page finished but nothing happened here, the protocol handler probably points to an old installation: ' +
					'start this PiCode once so it claims the protocol again, then sign in again.');
				settle(() => reject(new Error(localize('picode.account.signInTimeout', "Sign-in did not finish within 5 minutes. Please try signing in again."))));
			}, SIGN_IN_CALLBACK_TIMEOUT_MS);
			disposables.add(toDisposable(() => clearTimeout(timeoutHandle)));

			// The handler is in place: now send the user to the web app.
			this._logService.info(`[picode.account] sign-in started; waiting for the browser to call back ${callbackUri.toString(true)} (5 minute timeout).`);
			this._openerService.open(authUrl, { openExternal: true }).then(undefined, err => {
				this._logService.error('[picode.account] the browser could not be opened for sign-in.', err);
				settle(() => reject(new Error(localize('picode.account.browserOpenFailed', "Could not open your browser to sign in. Please try again."), { cause: err })));
			});
		}).finally(() => disposables.dispose());
	}

	private async _exchangeOneTimeCode(code: string): Promise<{ customToken: string }> {
		// The answer also carries the account's `plan`. The editor deliberately does NOT gate on
		// it: the plan is a snapshot from this moment, and the sync service keeps being the
		// authority for every request afterwards (see `createSession`).
		const response = await this._postJson<{ customToken?: string; plan?: string }>(`${this._config.webOrigin}/api/auth/editor-exchange`, { code }, 'finishing the sign-in');
		if (response.statusCode !== 200 || !response.json?.customToken) {
			// The most common failure is a code that expired or was already used.
			throw new Error(localize('picode.account.codeExchangeFailed', "Sign-in could not be completed. The sign-in request may have expired or was already used — please try signing in again."));
		}
		return { customToken: response.json.customToken };
	}

	private async _postFirebaseToken(refreshToken: string): Promise<{ statusCode: number | undefined; json: FirebaseTokenResponse | undefined }> {
		// Firebase's securetoken endpoint expects a form-encoded body with snake_case keys
		// (this is what the official Firebase SDK sends; JSON with camelCase is rejected).
		return this._postForm<FirebaseTokenResponse>(`${FIREBASE_TOKEN_ENDPOINT}?key=${this._config.firebaseApiKey}`, {
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
		}, 'refreshing your session');
	}

	/**
	 * Mints the editor's own session from a Firebase custom token. Custom tokens are
	 * exchanged at the identitytoolkit endpoint — the securetoken endpoint used for
	 * refresh-token rotation rejects them. The answer carries no user fields, so the
	 * identity is read from the returned ID token payload.
	 */
	private async _mintFromCustomToken(customToken: string): Promise<{ statusCode: number | undefined; json: CustomTokenExchangeResponse | undefined }> {
		return this._postJson<CustomTokenExchangeResponse>(
			`${FIREBASE_CUSTOM_TOKEN_ENDPOINT}?key=${this._config.firebaseApiKey}`,
			{ token: customToken, returnSecureToken: true },
			'setting up your account',
		);
	}

	/** Reads uid/email out of a Firebase ID token payload (no network, no verification — the token just came from Firebase). */
	private _decodeIdTokenPayload(idToken: string): FirebaseIdentity {
		try {
			const payload = JSON.parse(decodeBase64(idToken.split('.')[1] ?? '').toString());
			return {
				uid: typeof payload.user_id === 'string' ? payload.user_id : typeof payload.sub === 'string' ? payload.sub : undefined,
				email: typeof payload.email === 'string' ? payload.email : undefined,
				picture: typeof payload.picture === 'string' ? payload.picture : undefined,
			};
		} catch {
			return {};
		}
	}

	/** POSTs form-urlencoded data and parses the JSON answer; network failures become a single localized error. */

	/**
	 * Network failures are surfaced to the user with the failing step so support
	 * (and the sync log) can tell exactly which call broke; the underlying cause
	 * is logged for diagnosis.
	 */
	private _networkError(step: string, err: unknown): Error {
		this._logService.error(`[picode.account] network request failed during: ${step}`, err);
		return new Error(
			localize('picode.account.networkError', "Could not reach the PiCode service while {0}. Please check your internet connection and try again.", step),
			{ cause: err },
		);
	}
	private async _postForm<T>(url: string, form: Record<string, string>, step: string): Promise<{ statusCode: number | undefined; json: T | undefined }> {
		let context: IRequestContext;
		try {
			context = await this._requestService.request({
				type: 'POST',
				url,
				data: Object.entries(form).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&'),
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				callSite: 'picodeAccountProvider',
			}, CancellationToken.None);
		} catch (err) {
			throw this._networkError(step, err);
		}
		let json: T | undefined;
		if (context.res.statusCode === 200) {
			try {
				json = await asJson<T>(context) ?? undefined;
			} catch {
				json = undefined;
			}
		}
		return { statusCode: context.res.statusCode, json };
	}

	/** GETs an authenticated web-app endpoint and parses the JSON answer; network failures become a single localized error. */
	/** POSTs JSON and parses the answer; network failures become a single localized error. */
	private async _postJson<T>(url: string, body: unknown, step: string): Promise<{ statusCode: number | undefined; json: T | undefined }> {
		let context: IRequestContext;
		try {
			context = await this._requestService.request({
				type: 'POST',
				url,
				data: JSON.stringify(body),
				headers: { 'Content-Type': 'application/json' },
				callSite: 'picodeAccountProvider',
			}, CancellationToken.None);
		} catch (err) {
			throw this._networkError(step, err);
		}
		let json: T | undefined;
		if (context.res.statusCode === 200) {
			try {
				json = await asJson<T>(context) ?? undefined;
			} catch {
				json = undefined;
			}
		}
		return { statusCode: context.res.statusCode, json };
	}
}
