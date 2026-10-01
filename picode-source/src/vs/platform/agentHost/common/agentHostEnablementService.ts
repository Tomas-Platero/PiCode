/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IObservable } from '../../../base/common/observable.js';
import * as nls from '../../../nls.js';
import { RawContextKey } from '../../contextkey/common/contextkey.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/** Context key set by {@link IAgentHostEnablementService}. Use in `when` clauses to gate Agent Host UI. */
export const AGENT_HOST_ENABLED_CONTEXT_KEY = new RawContextKey<boolean>('agentHostEnabled', false, { type: 'boolean', description: nls.localize('agentHostEnabled', "Whether Agent Host features are available and AI features are enabled in this window.") });

export const IAgentHostEnablementService = createDecorator<IAgentHostEnablementService>('agentHostEnablementService');

export interface IAgentHostEnablementService {
	readonly _serviceBrand: undefined;
	/**
	 * Whether Agent Host features are available and AI features are enabled in this window.
	 */
	readonly enabled: IObservable<boolean>;
	/**
	 * Whether an enterprise has mandated the Copilot SDK sandbox floor through managed settings
	 * (`sandbox.enabled`). The runtime owns composing and enforcing that floor; VS Code reads it
	 * only to retire the legacy local harness for governed users, since the sandbox is implemented
	 * by the Agent Host.
	 *
	 * A user- or workspace-level sandbox opt-in is not an enterprise decision and does not set
	 * this. Existing local chat sessions keep working; only the harness used for *new* chats is
	 * affected, and virtual workspaces are exempt.
	 */
	readonly managedSandboxEnforced: IObservable<boolean>;
}
