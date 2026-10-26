/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { PiCodeAccountProvider, PICODE_ACCOUNT_LABEL, PICODE_AUTH_PROVIDER_ID, PICODE_EMAIL_STORAGE_KEY, PICODE_REFRESH_TOKEN_SECRET_KEY, PICODE_SCOPES_STORAGE_KEY, PICODE_UID_STORAGE_KEY } from './picodeAccountProvider.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

/** Set by the setup window; read and cleared here. Declared in `picodeConfiguration.ts`. */
export const PICODE_SIGN_IN_ON_START_SETTING = 'picode.account.signInOnStart';
/** Set by the setup window when it signed out; read and cleared here. */
export const PICODE_SIGN_OUT_ON_START_SETTING = 'picode.account.signOutOnStart';

/**
 * Who is signed in, mirrored in the shared settings file.
 *
 * The session itself lives in encrypted storage, which the setup window cannot read — so the editor
 * publishes the one fact the other side needs (whose session, if any) where both can see it. This
 * is what makes the two surfaces agree: the setup watches it and repaints its card, whichever side
 * signed in or out.
 */
export const PICODE_SESSION_EMAIL_SETTING = 'picode.account.sessionEmail';

/**
 * Registers PiCode's first-party account provider with the authentication service, so it
 * appears in the Accounts menu and can be picked by the Settings Sync engine through
 * `product.json`'s `configurationSync.store.authenticationProviders`.
 *
 * Dev builds without the cloud configuration get no provider: everything behind it needs
 * the web app and the Firebase project, so this fails soft instead of offering a
 * "PiCode Account" that cannot sign anybody in.
 */
export class PiCodeAccountContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@IProductService productService: IProductService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IAuthenticationService authenticationService: IAuthenticationService,
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@INotificationService notificationService: INotificationService,
		@ICommandService commandService: ICommandService,
		@ISecretStorageService secretStorageService: ISecretStorageService,
		@IStorageService storageService: IStorageService,
	) {
		super();

		const picode = productService.picode;
		if (!picode?.webOrigin || !picode.firebaseApiKey) {
			return;
		}

		authenticationService.registerDeclaredAuthenticationProvider({
			id: PICODE_AUTH_PROVIDER_ID,
			// The label lives with the provider, so both declarations read the same words.
			label: PICODE_ACCOUNT_LABEL,
		});
		const provider = this._register(instantiationService.createInstance(PiCodeAccountProvider, picode));
		authenticationService.registerAuthenticationProvider(PICODE_AUTH_PROVIDER_ID, provider);
		this._register(toDisposable(() => {
			authenticationService.unregisterAuthenticationProvider(PICODE_AUTH_PROVIDER_ID);
			authenticationService.unregisterDeclaredAuthenticationProvider(PICODE_AUTH_PROVIDER_ID);
		}));

		/**
		 * Takes the session the setup minted and makes it this window's own.
		 *
		 * Run at start (the usual case: the setup ran before this window existed) **and** whenever the
		 * settings file changes, because the setup can be reopened from the Welcome page over an
		 * editor that is already running — and then "signed in in the setup" must mean signed in
		 * here, now, not at the next start.
		 */
		let adopting = false;
		const adoptPendingSession = async (): Promise<void> => {
			if (adopting) {
				return;
			}
			const token = configurationService.getValue<string>('picode.account.pendingRefreshToken');
			if (typeof token !== 'string' || token.length === 0) {
				return;
			}
			adopting = true;
			try {
				const uid = configurationService.getValue<string>('picode.account.pendingUid') ?? '';
				const email = configurationService.getValue<string>('picode.account.pendingEmail') ?? '';
				await secretStorageService.set(PICODE_REFRESH_TOKEN_SECRET_KEY, token);
				storageService.store(PICODE_UID_STORAGE_KEY, uid, StorageScope.APPLICATION, StorageTarget.MACHINE);
				storageService.store(PICODE_EMAIL_STORAGE_KEY, email, StorageScope.APPLICATION, StorageTarget.MACHINE);
				storageService.store(PICODE_SCOPES_STORAGE_KEY, JSON.stringify([]), StorageScope.APPLICATION, StorageTarget.MACHINE);
				// Cleared after adopting: the order has been carried out, and a second adoption would
				// only rewrite the same token.
				await clearHandover();
				logService.info('[picode.account] adopted the session the setup signed in with.');
				await publishSession(email);
				notificationService.info(localize('picode.account.adopted', "Signed in to PiCode{0} — the sign-in you completed in the setup.", email.length > 0 ? ` as ${email}` : ''));
			} catch (error) {
				logService.warn('[picode.account] the setup session could not be adopted', error);
			} finally {
				adopting = false;
			}
		};

		/**
		 * Drops every session this provider holds, because the setup asked to sign out.
		 *
		 * Same reasoning as above: the request may arrive while this window is open, so the answer
		 * cannot wait for a restart.
		 */
		let signingOut = false;
		const honourSignOut = async (): Promise<void> => {
			if (signingOut) {
				return;
			}
			signingOut = true;
			try {
				await clearHandover();
				const sessions = await authenticationService.getSessions(PICODE_AUTH_PROVIDER_ID, [], { activateImmediate: true });
				await Promise.all(sessions.map(session => authenticationService.removeSession(PICODE_AUTH_PROVIDER_ID, session.id)));
				logService.info(`[picode.account] signed out, as the setup asked (${sessions.length} session(s)).`);
				if (sessions.length > 0) {
					notificationService.info(localize('picode.account.signedOut', "Signed out of PiCode."));
				}
			} catch (error) {
				logService.warn('[picode.account] the setup asked to sign out and it did not finish', error);
			} finally {
				signingOut = false;
			}
		};

		/**
		 * Publishes (or clears) the mirror, then lets the listeners repaint.
		 *
		 * Written by the **connector**, not here: these keys are declared `included: false` so they
		 * never appear as rows in Settings, and that same flag makes them unwritable through
		 * `configurationService.updateValue` — the editor answers "not a registered configuration".
		 * The connector writes the settings file directly, which is what it already does for the
		 * setup window.
		 */
		const publishSession = async (email: string): Promise<void> => {
			try {
				await commandService.executeCommand('picode.setup.publishSession', email);
			} catch (error) {
				logService.trace('[picode.account] the session mirror could not be written', error);
			}
		};

		/** Asks the connector to forget the hand-over this window just consumed. */
		const clearHandover = async (): Promise<void> => {
			try {
				await commandService.executeCommand('picode.setup.clearHandover');
			} catch (error) {
				logService.trace('[picode.account] the hand-over could not be cleared', error);
			}
		};

		/** Asks the connector to drop a sign-out request that a newer sign-in already overrode. */
		const clearSignOutRequest = async (): Promise<void> => {
			try {
				await commandService.executeCommand('picode.setup.clearSignOutRequest');
			} catch (error) {
				logService.trace('[picode.account] the sign-out request could not be cleared', error);
			}
		};

		void adoptPendingSession();

		this._register(authenticationService.onDidChangeSessions(async event => {
			if (event.providerId !== PICODE_AUTH_PROVIDER_ID) {
				return;
			}
			const sessions = await authenticationService.getSessions(PICODE_AUTH_PROVIDER_ID, [], { activateImmediate: true });
			await publishSession(sessions[0]?.account.label ?? '');
		}));

		// A sign-in and a sign-out can both be waiting here (a request left by an earlier run, then a
		// fresh sign-in). The sign-in is the later wish, so it wins: honouring the stale sign-out
		// after it is exactly how "I signed in and the editor signed me out" happens.
		const pendingCode = configurationService.getValue<string>('picode.account.pendingCode');
		const hasPendingSignIn = typeof pendingCode === 'string' && pendingCode.length > 0;
		if (hasPendingSignIn && configurationService.getValue<boolean>(PICODE_SIGN_OUT_ON_START_SETTING) === true) {
			logService.info('[picode.account] a stale sign-out request was dropped: a sign-in is waiting.');
			void clearSignOutRequest();
		}

		// Taking the session away: the window cannot touch secret storage, so it asks and this
		// drops every session this provider holds, then clears the request.
		if (!hasPendingSignIn && configurationService.getValue<boolean>(PICODE_SIGN_OUT_ON_START_SETTING) === true) {
			void honourSignOut();
		}

		// The setup can be reopened over a running editor, so its orders are listened to, not only
		// read once: a change to the file it writes is what makes "signed in in the setup" true here
		// immediately, and the same for signing out.
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('picode.account.pendingRefreshToken')) {
				void adoptPendingSession();
			}
			if (event.affectsConfiguration(PICODE_SIGN_OUT_ON_START_SETTING)
				&& configurationService.getValue<boolean>(PICODE_SIGN_OUT_ON_START_SETTING) === true) {
				void honourSignOut();
			}
		}));

		// What the setup left behind, read once at the top: a code waiting to be redeemed, or a
		// session it managed to write itself. The order matters — a session already there means the
		// code is redundant, and redeeming it twice would mint a second one.
		void authenticationService.getSessions(PICODE_AUTH_PROVIDER_ID, [], { activateImmediate: true }).then(
			sessions => {
				if (sessions.length > 0) {
					logService.info(`[picode.account] signed in as ${sessions[0].account.label}.`);
					return;
				}
				if (typeof pendingCode !== 'string' || pendingCode.length === 0) {
					return;
				}
				// The code already carries the approval given in the browser: redeeming it mints the
				// session silently, with no second browser and no second click.
				notificationService.info(localize('picode.account.finishing', "Finishing the sign-in you started in PiCode's setup…"));
				return authenticationService.createSession(PICODE_AUTH_PROVIDER_ID, [], { activateImmediate: true }).then(
					session => {
						logService.info(`[picode.account] signed in as ${session.account.label}, from the setup sign-in.`);
						notificationService.info(localize('picode.account.signedIn', "Signed in to PiCode as {0}.", session.account.label));
					},
					error => {
						logService.warn('[picode.account] the setup sign-in could not be completed', error);
						notificationService.warn(localize('picode.account.notSignedIn', "PiCode could not finish the sign-in: {0}", error instanceof Error ? error.message : String(error)));
					},
				);
			},
			error => logService.trace('[picode.account] no session to restore yet', error),
		);

		// The setup window runs before this one and has no way to sign anybody in — its callback
		// is a protocol the workbench answers, and the session lives in secret storage this
		// process owns. So it leaves a request behind (`picode.account.signInOnStart`) and the
		// editor honours it here, once: the browser opens now, and the token lands where the
		// editor will look for it tomorrow.
		if (configurationService.getValue<boolean>(PICODE_SIGN_IN_ON_START_SETTING) === true) {
			// The order is consumed — and erased by the connector, because the editor cannot write
			// these hidden keys itself (that was the "not a registered configuration" error).
			void clearHandover();
			// Said on screen, not only in a log: the setup promised a browser, and a promise nobody
			// can see the outcome of is the thing that made this look broken.
			notificationService.info(localize('picode.account.starting', "Signing you in to PiCode — your browser should open in a moment."));
			authenticationService.createSession(PICODE_AUTH_PROVIDER_ID, [], { activateImmediate: true }).then(
				session => {
					logService.info('[picode.account] signed in from the setup request.');
					notificationService.info(localize('picode.account.signedIn', "Signed in to PiCode as {0}.", session.account.label));
				},
				error => {
					logService.warn('[picode.account] the setup asked for a sign-in and it did not finish', error);
					notificationService.warn(localize('picode.account.notSignedIn', "PiCode could not finish the sign-in: {0}", error instanceof Error ? error.message : String(error)));
				},
			);
		}
	}
}

registerWorkbenchContribution2('workbench.contrib.picodeAccount', PiCodeAccountContribution, WorkbenchPhase.AfterRestored);
