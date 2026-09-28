/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { CopilotChatSessionsProvider } from '../../copilotChatSessions/browser/copilotChatSessionsProvider.js';
import '../../copilotChatSessions/browser/copilotChatSessionsActions.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';

/**
 * Registers the {@link CopilotChatSessionsProvider} as a sessions provider.
 *
 * Coexists with the local agent host provider when that runtime is available. The two providers list disjoint sets of sessions:
 * - The local agent host filters via the per-session Agent Host SQLite DB
 *   (database-existence ownership gate in `CopilotAgent.listSessions`).
 * - This provider's underlying extension service filters via the per-session
 *   metadata file's `origin` field, which the local agent host never writes.
 */
class DefaultSessionsProviderContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.defaultSessionsProvider';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ISessionsProvidersService sessionsProvidersService: ISessionsProvidersService,
	) {
		super();

		const provider = this._register(instantiationService.createInstance(CopilotChatSessionsProvider));
		this._register(sessionsProvidersService.registerProvider(provider));
	}
}

registerWorkbenchContribution2(DefaultSessionsProviderContribution.ID, DefaultSessionsProviderContribution, WorkbenchPhase.AfterRestored);
