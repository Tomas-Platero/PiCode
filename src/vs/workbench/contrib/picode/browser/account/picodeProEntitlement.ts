/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { PICODE_EMAIL_STORAGE_KEY, PICODE_PLAN_STORAGE_KEY } from '../picodeAccountProvider.js';

export type PicodeAccountPlan = 'free' | 'pro';

/**
 * What the signed-in account is entitled to, as the editor last saw it.
 *
 * This is a mirror for the screen, not a lock: the plan is a snapshot taken at sign-in, and the
 * cloud service stays the authority (it answers `402` to any plan that is not Pro). Every Pro
 * feature asks this one service, so "is this account Pro?" has a single answer.
 */
export const IPicodeProEntitlement = createDecorator<IPicodeProEntitlement>('picodeProEntitlement');

export interface IPicodeProEntitlement {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	readonly signedIn: boolean;
	readonly email: string | undefined;
	readonly plan: PicodeAccountPlan;
	readonly isPro: boolean;
}

class PicodeProEntitlement extends Disposable implements IPicodeProEntitlement {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(@IStorageService private readonly storageService: IStorageService) {
		super();
		for (const key of [PICODE_EMAIL_STORAGE_KEY, PICODE_PLAN_STORAGE_KEY]) {
			this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, key, this._store)(() => this._onDidChange.fire()));
		}
	}

	get email(): string | undefined {
		return this.storageService.get(PICODE_EMAIL_STORAGE_KEY, StorageScope.APPLICATION) || undefined;
	}

	get signedIn(): boolean {
		return this.email !== undefined;
	}

	get plan(): PicodeAccountPlan {
		return this.storageService.get(PICODE_PLAN_STORAGE_KEY, StorageScope.APPLICATION) === 'pro' ? 'pro' : 'free';
	}

	get isPro(): boolean {
		return this.signedIn && this.plan === 'pro';
	}
}

registerSingleton(IPicodeProEntitlement, PicodeProEntitlement, InstantiationType.Delayed);

/** A feature that only Pro accounts get. Declared once; the Account window lists it. */
export interface IPicodeProFeature {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly icon: ThemeIcon;
	/** False while the feature is announced but not built yet. */
	readonly available: boolean;
}

const proFeatures: IPicodeProFeature[] = [];

export function registerProFeature(feature: IPicodeProFeature): void {
	const existing = proFeatures.findIndex(f => f.id === feature.id);
	if (existing >= 0) {
		proFeatures[existing] = feature;
	} else {
		proFeatures.push(feature);
	}
}

export function getProFeatures(): readonly IPicodeProFeature[] {
	return proFeatures;
}

registerProFeature({
	id: 'sync',
	label: localize('picodeProFeatureSync', "Cloud sync"),
	description: localize('picodeProFeatureSyncDescription', "Your settings, agents and skills follow you across computers."),
	icon: Codicon.cloud,
	available: true,
});
registerProFeature({
	id: 'connections',
	label: localize('picodeProFeatureConnections', "Connections"),
	description: localize('picodeProFeatureConnectionsDescription', "Bring the issues of GitHub and Jira into the chat."),
	icon: Codicon.plug,
	available: false,
});
