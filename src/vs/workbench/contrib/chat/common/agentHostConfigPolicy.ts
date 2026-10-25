/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SessionConfigKey } from '../../../../platform/agentHost/common/sessionConfigKeys.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ChatConfiguration, ChatPermissionLevel } from './constants.js';

export function isAutoApprovePolicyRestricted(configurationService: IConfigurationService): boolean {
	return configurationService.inspect<boolean>(ChatConfiguration.GlobalAutoApprove).policyValue === false;
}

export function isPermissionLevelVisible(value: unknown): boolean {
	return value !== ChatPermissionLevel.Assisted;
}

export function isAutoApproveValuePolicyRestricted(value: unknown, policyRestricted: boolean): boolean {
	return policyRestricted && value !== ChatPermissionLevel.Default;
}

export function normalizeSessionConfigValue<T>(property: string, value: T, policyRestricted: boolean): T {
	if (property === SessionConfigKey.AutoApprove && isAutoApproveValuePolicyRestricted(value, policyRestricted)) {
		return ChatPermissionLevel.Default as T;
	}
	return value;
}
