/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';

export const PROFILE_ICONS = [Codicon.robot, Codicon.organization, Codicon.sparkle, Codicon.rocket, Codicon.code, Codicon.search, Codicon.shield, Codicon.tools, Codicon.beaker, Codicon.star, Codicon.heart, Codicon.globe] as const;
export const PROFILE_ICONS_KEY = 'picode.agentProfileIcons';

export function readProfileIcons(storage: IStorageService): Record<string, string> {
	try {
		const value: unknown = JSON.parse(storage.get(PROFILE_ICONS_KEY, StorageScope.PROFILE, '{}'));
		return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, string> : {};
	} catch {
		return {};
	}
}

export function profileIcon(storage: IStorageService, name: string | undefined, mode?: string): ThemeIcon {
	const id = name === undefined ? undefined : readProfileIcons(storage)[name];
	return PROFILE_ICONS.find(icon => icon.id === id) ?? (mode === 'full-delegation' ? Codicon.organization : Codicon.robot);
}
