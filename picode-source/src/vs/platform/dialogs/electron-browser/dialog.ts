/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fromNow } from '../../../base/common/date.js';
import { isLinuxSnap } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { IOSProperties } from '../../native/common/native.js';
import { IProductService } from '../../product/common/productService.js';
import { process } from '../../../base/parts/sandbox/electron-browser/globals.js';

export function createNativeAboutDialogDetails(
	productService: IProductService,
	osProps: IOSProperties,
	/** The pi in force and Gentle AI when installed; absent while the connector is not up. */
	agents?: { readonly piVersion?: string; readonly gentleVersion?: string },
): { title: string; details: string; detailsToCopy: string } {
	let version = productService.version;
	if (productService.target) {
		version = `${version} (${productService.target} setup)`;
	} else if (productService.darwinUniversalAssetId) {
		version = `${version} (Universal)`;
	}

	const getDetails = (useAgo: boolean): string => {
		const date = productService.date ? `${productService.date}${useAgo ? ' (' + fromNow(new Date(productService.date), true) + ')' : ''}` : 'Unknown';
		// One localized line per fact, joined, rather than a single template: the agents are
		// optional (Gentle AI shows only when it is installed) and a template would need
		// placeholders for lines that are not always there.
		const lines = [
			localize('aboutPiCode', "PiCode: {0}", productService.picodeVersion || 'Unknown'),
			localize('aboutVersion', "Version: {0}", version),
			localize('aboutCommit', "Commit: {0}", productService.commit || 'Unknown'),
			localize('aboutDate', "Date: {0}", date),
			localize('aboutElectron', "Electron: {0}", process.versions['electron']),
			localize('aboutElectronBuildId', "ElectronBuildId: {0}", process.versions['microsoft-build'] || 'Unknown'),
			localize('aboutChromium', "Chromium: {0}", process.versions['chrome']),
			localize('aboutNode', "Node.js: {0}", process.versions['node']),
			localize('aboutV8', "V8: {0}", process.versions['v8']),
			localize('aboutPi', "pi: {0}", agents?.piVersion || 'Unknown'),
		];
		if (agents?.gentleVersion !== undefined) {
			lines.push(localize('aboutGentle', "Gentle AI: {0}", agents.gentleVersion));
		}
		lines.push(localize('aboutOs', "OS: {0}", `${osProps.type} ${osProps.arch} ${osProps.release}${isLinuxSnap ? ' snap' : ''}`));
		return lines.join('\n');
	};

	const details = getDetails(true);
	const detailsToCopy = getDetails(false);

	return {
		title: productService.nameLong,
		details: details,
		detailsToCopy: detailsToCopy
	};
}
