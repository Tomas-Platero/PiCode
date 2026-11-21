/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IContextKeyService, RawContextKey } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../common/contributions.js';
import { IPicodeProEntitlement } from '../picodeProEntitlement.js';

/** Whether the signed-in account is Pro: what the views that only Pro accounts get ask. */
export const PICODE_IS_PRO_CONTEXT = new RawContextKey<boolean>('picode.account.isPro', false);

/** Keeps the context key true while the signed-in account is Pro. */
class PicodeProContext extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.picodeProContext';

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IPicodeProEntitlement entitlement: IPicodeProEntitlement,
	) {
		super();
		const key = PICODE_IS_PRO_CONTEXT.bindTo(contextKeyService);
		const update = (): void => key.set(entitlement.isPro);
		update();
		this._register(entitlement.onDidChange(update));
	}
}

registerWorkbenchContribution2(PicodeProContext.ID, PicodeProContext, WorkbenchPhase.BlockRestore);
