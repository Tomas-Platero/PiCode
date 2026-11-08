/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IPicodeConnectorService } from './issues/picodeConnectorService.js';

/** Coming back to the window often is normal; the plan rarely changes. */
const AT_MOST_EVERY_MS = 60_000;

/**
 * Keeps the plan the editor shows up to date. People buy or cancel Pro in their browser, so the
 * moment that matters is when they come back to this window: without this, the editor would only
 * learn about it the next time they sign in. The service still decides every Pro request; this is
 * what the screens read to offer them.
 */
class PicodePlanRefresh extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.picodePlanRefresh';

	private last = 0;

	constructor(
		@IHostService hostService: IHostService,
		@IPicodeConnectorService private readonly connectors: IPicodeConnectorService,
	) {
		super();
		this.refresh();
		this._register(hostService.onDidChangeFocus(focused => {
			if (focused) {
				this.refresh();
			}
		}));
	}

	private refresh(): void {
		const now = Date.now();
		if (now - this.last >= AT_MOST_EVERY_MS) {
			this.last = now;
			void this.connectors.refreshPlan().catch(() => undefined);
		}
	}
}

registerWorkbenchContribution2(PicodePlanRefresh.ID, PicodePlanRefresh, WorkbenchPhase.Eventually);
