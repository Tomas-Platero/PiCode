/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createCSSRule } from '../../../../base/browser/domStylesheets.js';
import { asCSSUrl } from '../../../../base/browser/cssValue.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { FileAccess } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';

/**
 * The Activity Bar's outline icons.
 *
 * They are URIs instead of theme icons because the bar paints URI icons as CSS
 * masks: the drawing comes from the SVG and the colour from the theme, so hover,
 * selection and high contrast keep working without a second asset per state.
 *
 * Tabler set (MIT) — source, geometry and licence live in `media/tabler/README.md`.
 */
const tablerIcon = (file: string): URI => FileAccess.asBrowserUri(`vs/workbench/contrib/picode/browser/media/tabler/${file}.svg`);

export const PicodeActivityBarIcons = {
	explorer: tablerIcon('folders'),
	search: tablerIcon('search'),
	sourceControl: tablerIcon('git-branch'),
	debug: tablerIcon('bug'),
	extensions: tablerIcon('puzzle'),
	settings: tablerIcon('settings')
};

const maskRules = new Set<string>();

/**
 * Registers (once) the mask rule that paints `icon` at the Activity Bar icon
 * size and returns the class name to put on the action label. View containers
 * get this for free from the composite bar; this is for actions built by hand,
 * like Manage at the bottom of the bar.
 *
 * Pair the returned class with `uri-icon` so the existing hover and selection
 * colours apply.
 */
export function activityBarMaskIconClass(id: string, icon: URI): string {
	const cssUrl = asCSSUrl(icon);
	const hash = new StringSHA1();
	hash.update(cssUrl);

	const className = `activity-${id}-${hash.digest()}`;
	if (!maskRules.has(className)) {
		maskRules.add(className);
		createCSSRule(`.monaco-workbench .activitybar .monaco-action-bar .action-label.${className}`, `
			mask: ${cssUrl} no-repeat 50% 50%;
			-webkit-mask: ${cssUrl} no-repeat 50% 50%;
			mask-size: var(--activity-bar-icon-size, 24px);
			-webkit-mask-size: var(--activity-bar-icon-size, 24px);
			mask-origin: padding;
			-webkit-mask-origin: padding;
		`);
	}

	return className;
}
