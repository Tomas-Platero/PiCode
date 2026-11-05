/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/picodeAccount.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { getAccountSections, IPicodeAccountSection } from './picodeAccountSections.js';
import { PICODE_ACCOUNT_EDITOR_ID } from './picodeAccountEditorInput.js';

const $ = DOM.$;

/**
 * The Account window: a side list of pages (account, cloud sync, Pro features…) and the page
 * that is selected. It is a separate window from Chat Settings on purpose: everything that
 * belongs to the account, and everything Pro, lives here.
 */
export class PicodeAccountEditor extends EditorPane {
	static readonly ID = PICODE_ACCOUNT_EDITOR_ID;

	private nav!: HTMLElement;
	private content!: HTMLElement;
	private readonly navItems = new Map<string, HTMLElement>();
	private selectedId: string | undefined;
	private readonly pageDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(PicodeAccountEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		const root = DOM.append(parent, $('.picode-account'));
		this.nav = DOM.append(root, $('nav.picode-account-nav'));
		this.nav.setAttribute('aria-label', localize('picodeAccountNavLabel', "Account sections"));
		this.content = DOM.append(root, $('.picode-account-content'));

		DOM.append(this.nav, $('.picode-account-nav-title')).textContent = localize('picodeAccountTitle', "Account");
		const sections = getAccountSections();
		for (const section of sections) {
			this.renderNavItem(section);
		}
		if (sections.length > 0) {
			this.select(sections[0]);
		}
	}

	private renderNavItem(section: IPicodeAccountSection): void {
		const item = DOM.append(this.nav, $('button.picode-account-nav-item'));
		item.setAttribute('type', 'button');
		item.appendChild(renderIcon(section.icon));
		DOM.append(item, $('span')).textContent = section.label;
		this._register(DOM.addDisposableListener(item, DOM.EventType.CLICK, () => this.select(section)));
		this.navItems.set(section.id, item);
	}

	private select(section: IPicodeAccountSection): void {
		if (this.selectedId === section.id) {
			return;
		}
		this.selectedId = section.id;
		for (const [id, item] of this.navItems) {
			item.classList.toggle('selected', id === section.id);
			item.setAttribute('aria-current', id === section.id ? 'page' : 'false');
		}
		this.pageDisposables.clear();
		DOM.clearNode(this.content);
		this.pageDisposables.add(section.create(this.instantiationService, this.content));
	}

	override focus(): void {
		super.focus();
		this.nav?.querySelector<HTMLElement>('.selected')?.focus();
	}

	layout(_dimension: DOM.Dimension): void {
		// The layout is plain flex: nothing to measure.
	}
}
