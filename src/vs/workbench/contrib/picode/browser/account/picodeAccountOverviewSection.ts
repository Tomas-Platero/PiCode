/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IAuthenticationService } from '../../../../services/authentication/common/authentication.js';
import { PICODE_AUTH_PROVIDER_ID, PICODE_PICTURE_STORAGE_KEY } from '../picodeAccountProvider.js';
import { registerAccountSection } from './picodeAccountSections.js';
import { IPicodeProEntitlement } from './picodeProEntitlement.js';

const $ = DOM.$;

class PicodeAccountOverviewSection extends Disposable {

	private readonly renderStore = this._register(new DisposableStore());

	constructor(
		private readonly container: HTMLElement,
		@IPicodeProEntitlement private readonly entitlement: IPicodeProEntitlement,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IProductService private readonly productService: IProductService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.render();
		this._register(this.entitlement.onDidChange(() => this.render()));
	}

	private render(): void {
		this.renderStore.clear();
		DOM.clearNode(this.container);
		const page = DOM.append(this.container, $('.picode-account-page'));
		DOM.append(page, $('h2')).textContent = localize('picodeAccountOverviewTitle', "Your account");

		if (!this.entitlement.signedIn) {
			DOM.append(page, $('p.picode-account-lead')).textContent = localize('picodeAccountSignedOut', "Sign in to keep your setup in the cloud and unlock Pro features.");
			const signIn = this.button(page, localize('picodeAccountSignIn', "Sign in or sign up"), false);
			this.renderStore.add(signIn.onDidClick(() => { void this.authenticationService.createSession(PICODE_AUTH_PROVIDER_ID, [], { activateImmediate: true }); }));
			return;
		}

		const email = this.entitlement.email ?? '';
		const card = DOM.append(page, $('.picode-account-card'));
		const avatar = DOM.append(card, $('span.picode-account-avatar'));
		avatar.textContent = email.charAt(0).toUpperCase();
		const picture = this.storageService.get(PICODE_PICTURE_STORAGE_KEY, StorageScope.APPLICATION);
		if (picture) {
			// The photo replaces the initial; if it cannot be loaded the initial stays.
			const image = $<HTMLImageElement>('img.picode-account-avatar-image');
			image.alt = '';
			image.referrerPolicy = 'no-referrer';
			this.renderStore.add(DOM.addDisposableListener(image, DOM.EventType.LOAD, () => { avatar.textContent = ''; avatar.appendChild(image); }));
			image.src = picture;
		}
		const text = DOM.append(card, $('.picode-account-card-text'));
		const name = DOM.append(text, $('span.picode-account-email'));
		DOM.append(name, $('span')).textContent = email;
		const plan = this.entitlement.plan;
		if (plan !== 'unknown') {
			const badge = DOM.append(name, $(`span.picode-account-badge.${plan}`));
			badge.textContent = plan === 'pro' ? localize('picodeAccountPlanPro', "Pro") : localize('picodeAccountPlanFree', "Free");
		}
		DOM.append(text, $('span.picode-account-muted')).textContent = plan === 'free'
			? localize('picodeAccountFreeLine', "Upgrade to keep your setup in the cloud.")
			: localize('picodeAccountProLine', "Cloud sync and connections are included.");

		const actions = DOM.append(page, $('.picode-account-actions'));
		const origin = this.productService.picode?.webOrigin;
		if (origin) {
			const isPro = this.entitlement.plan !== 'free';
			const plans = this.button(actions, isPro ? localize('picodeAccountManagePlan', "Manage plan") : localize('picodeAccountUpgrade', "Upgrade to Pro"), isPro);
			// A Pro account manages its subscription on its account page; the plans would only offer what it already has.
			this.renderStore.add(plans.onDidClick(() => { void this.openerService.open(URI.parse(`${origin}${isPro ? '/account#plan' : '/pricing'}`)); }));
		}
		const signOut = this.button(actions, localize('picodeAccountSignOut', "Sign out"), true);
		this.renderStore.add(signOut.onDidClick(async () => {
			const sessions = await this.authenticationService.getSessions(PICODE_AUTH_PROVIDER_ID, [], { activateImmediate: true });
			await Promise.all(sessions.map(session => this.authenticationService.removeSession(PICODE_AUTH_PROVIDER_ID, session.id)));
		}));
	}

	private button(parent: HTMLElement, label: string, secondary: boolean): Button {
		const button = this.renderStore.add(new Button(parent, { ...defaultButtonStyles, secondary }));
		button.label = label;
		return button;
	}
}

registerAccountSection({
	id: 'overview',
	label: localize('picodeAccountOverviewLabel', "Overview"),
	icon: Codicon.account,
	order: 0,
	create: (instantiationService: IInstantiationService, container: HTMLElement) => instantiationService.createInstance(PicodeAccountOverviewSection, container),
});
