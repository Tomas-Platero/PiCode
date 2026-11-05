/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';

/** One page of the Account window. Add a Pro feature's page by registering it here. */
export interface IPicodeAccountSection {
	readonly id: string;
	readonly label: string;
	readonly icon: ThemeIcon;
	/** Lower comes first in the side list. */
	readonly order: number;
	create(instantiationService: IInstantiationService, container: HTMLElement): IDisposable;
}

const sections: IPicodeAccountSection[] = [];

export function registerAccountSection(section: IPicodeAccountSection): void {
	sections.push(section);
	sections.sort((a, b) => a.order - b.order);
}

export function getAccountSections(): readonly IPicodeAccountSection[] {
	return sections;
}
