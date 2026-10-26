/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { PICODE_AUTH_PROVIDER_ID } from './picodeAccountProvider.js';

/**
 * "PiCode: Setup", from inside the editor.
 *
 * The setup is a window of its own — the same one a first start shows — because it exists before
 * the workbench and must keep existing after it: one page, one set of answers, no second variant
 * to keep in step. This command only asks the application to show it again; the window reads the
 * state that is already configured and preselects it, so nothing here is asked twice and nothing
 * is overwritten without a click.
 */
export const PICODE_OPEN_SETUP_COMMAND_ID = 'picode.setup.reopen';

CommandsRegistry.registerCommand({
	id: PICODE_OPEN_SETUP_COMMAND_ID,
	handler: async (accessor: ServicesAccessor): Promise<void> => {
		const nativeHostService = accessor.get(INativeHostService);
		const notificationService = accessor.get(INotificationService);
		const opened = await nativeHostService.openPiCodeSetup();
		if (!opened) {
			notificationService.info(localize('picode.setup.reopen.unavailable', "The setup window is not available in this build."));
		}
	}
});

/**
 * "PiCode: Sign in to PiCode" — the sign-in on demand.
 *
 * The setup leaves its request for the editor to honour at start; if that moment is missed (a
 * browser that never appeared, a window that was closed), this is the same flow, one palette
 * entry away, and it says out loud what happened.
 */
export const PICODE_SIGN_IN_COMMAND_ID = 'picode.account.signIn';

CommandsRegistry.registerCommand({
	id: PICODE_SIGN_IN_COMMAND_ID,
	handler: async (accessor: ServicesAccessor): Promise<void> => {
		const authenticationService = accessor.get(IAuthenticationService);
		const notificationService = accessor.get(INotificationService);
		notificationService.info(localize('picode.account.starting', "Signing you in to PiCode — your browser should open in a moment."));
		try {
			const session = await authenticationService.createSession(PICODE_AUTH_PROVIDER_ID, [], { activateImmediate: true });
			notificationService.info(localize('picode.account.signedIn', "Signed in to PiCode as {0}.", session.account.label));
		} catch (error) {
			notificationService.warn(localize('picode.account.notSignedIn', "PiCode could not finish the sign-in: {0}", error instanceof Error ? error.message : String(error)));
		}
	}
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: {
		id: PICODE_SIGN_IN_COMMAND_ID,
		title: localize('picode.account.signIn.title', "Sign in to PiCode"),
		category: localize('picode.category', "PiCode"),
	},
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: {
		id: PICODE_OPEN_SETUP_COMMAND_ID,
		title: localize('picode.setup.reopen', "Setup"),
		category: localize('picode.category', "PiCode"),
	},
});
