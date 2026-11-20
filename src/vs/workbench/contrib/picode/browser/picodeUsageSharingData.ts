/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** "Help Improve PiCode": read by the update check, declared in `update.config.contribution.ts` (ADR-045). */
export const SHARE_USAGE_SETTING = 'picode.privacy.shareUsage';

/**
 * Whether to tell this person, once, that anonymous usage counts are on and how to turn them off.
 * Only when nobody chose yet: the setup records the choice, and so does the setting itself.
 */
export function shouldShowUsageNotice(userValue: unknown, alreadyShown: boolean): boolean {
	return !alreadyShown && typeof userValue !== 'boolean';
}
