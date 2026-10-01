/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { PiCodeAccountProvider, PICODE_ACCOUNT_LABEL, PICODE_AUTH_PROVIDER_ID } from './picodeAccountProvider.js';

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
	}
}

registerWorkbenchContribution2('workbench.contrib.picodeAccount', PiCodeAccountContribution, WorkbenchPhase.AfterRestored);
