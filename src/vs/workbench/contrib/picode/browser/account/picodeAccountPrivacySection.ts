/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { OperatingSystem, OS } from '../../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { SHARE_USAGE_SETTING } from '../picodeUsageSharingData.js';
import { registerAccountSection } from './picodeAccountSections.js';

const $ = DOM.$;

const UPDATE_MODE_SETTING = 'update.mode';
const EXTENSION_CHECKS_SETTING = 'extensions.autoCheckUpdates';
const WATCHED = [SHARE_USAGE_SETTING, UPDATE_MODE_SETTING, EXTENSION_CHECKS_SETTING];

type UpdateMode = 'default' | 'start' | 'manual' | 'none';

/**
 * Everything that leaves this computer, and the switches for it (ADR-045): the anonymous usage
 * counts, the two kinds of update checks, and what PiCode keeps switched off for good.
 */
class PicodeAccountPrivacySection extends Disposable {

	private readonly renderStore = this._register(new DisposableStore());

	constructor(
		private readonly container: HTMLElement,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IProductService private readonly productService: IProductService,
	) {
		super();
		this.render();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (WATCHED.some(key => e.affectsConfiguration(key))) {
				this.render();
			}
		}));
	}

	private render(): void {
		const scroller = this.container.closest('.picode-account-content');
		const scrollTop = scroller?.scrollTop ?? 0;
		this.renderStore.clear();
		DOM.clearNode(this.container);
		const page = DOM.append(this.container, $('.picode-account-page.picode-sync-page.picode-privacy-page'));
		const head = DOM.append(page, $('.picode-sync-title'));
		DOM.append(head, $('h2')).textContent = localize('picodePrivacyTitle', "Privacy");
		DOM.append(head, $('p.picode-account-lead')).textContent = localize('picodePrivacyLead', "What PiCode sends on its own, with the switch for each. Your chats go only to the AI provider you choose.");

		this.renderHero(page);
		this.renderUsage(page);
		this.renderConnections(page);
		this.renderFooter(page);
		if (scroller) {
			scroller.scrollTop = scrollTop;
		}
	}

	private renderHero(page: HTMLElement): void {
		const sharing = this.sharing();
		const hero = DOM.append(page, $('.picode-privacy-hero'));
		const shield = DOM.append(hero, $('.picode-privacy-shield'));
		shield.appendChild(renderIcon(Codicon.shield));
		const text = DOM.append(hero, $('.picode-sync-hero-text'));
		DOM.append(text, $('strong')).textContent = localize('picodePrivacyHeroTitle', "PiCode does not collect your code or your chats");
		DOM.append(text, $('span')).textContent = sharing
			? localize('picodePrivacyHeroSharing', "The only thing PiCode sends on its own is an anonymous count with each update check. Thank you for helping.")
			: localize('picodePrivacyHeroNothing', "Usage sharing is off: update checks carry nothing that can be counted.");
	}

	private renderUsage(page: HTMLElement): void {
		this.groupHead(page, localize('picodePrivacyUsageGroup', "Help improve PiCode"));
		const card = DOM.append(page, $('.picode-sync-card'));
		const sharing = this.sharing();
		this.toggleRow(card, {
			icon: Codicon.graph, color: 'blue',
			title: localize('picodeAccountShareUsage', "Help improve PiCode"),
			description: localize('picodePrivacyUsageWhy', "Anonymous counts that tell us how many people use PiCode, on which systems and versions."),
			on: sharing,
			set: value => this.update(SHARE_USAGE_SETTING, value),
		});

		const details = DOM.append(card, $('.picode-privacy-details'));
		this.chips(details, localize('picodePrivacySent', "Sent"), 'sent', sharing ? [
			localize('picodePrivacySentVersion', "PiCode {0}", this.productService.picodeVersion ?? this.productService.version),
			this.systemName(),
			localize('picodePrivacySentActive', "Used today, this week or this month"),
			localize('picodePrivacySentPi', "The agent's install and update notices"),
		] : [localize('picodePrivacySentNothing', "Nothing")], !sharing);
		this.chips(details, localize('picodePrivacyNever', "Never included"), 'never', [
			localize('picodePrivacyNeverCode', "Your code"),
			localize('picodePrivacyNeverChats', "Chats"),
			localize('picodePrivacyNeverFiles', "File names"),
			localize('picodePrivacyNeverAccount', "Your account"),
			localize('picodePrivacyNeverIp', "Your IP address"),
			localize('picodePrivacyNeverId', "Any identifier"),
		]);
	}

	private renderConnections(page: HTMLElement): void {
		this.groupHead(page, localize('picodePrivacyConnectionsGroup', "Connections"));
		const card = DOM.append(page, $('.picode-sync-card'));

		const mode = this.configurationService.getValue<UpdateMode>(UPDATE_MODE_SETTING) ?? 'default';
		const row = DOM.append(card, $(`.picode-sync-item.picode-account-privacy.picode-privacy-choice-row${mode === 'none' ? '' : '.on'}`));
		const label = DOM.append(row, $('.picode-sync-item-label'));
		this.icon(label, Codicon.cloudDownload, 'green');
		const text = DOM.append(label, $('.picode-sync-item-text'));
		DOM.append(text, $('strong')).textContent = localize('picodePrivacyUpdates', "PiCode updates");
		DOM.append(text, $('span')).textContent = localize('picodePrivacyUpdatesWhy', "How often PiCode looks for a new version.");
		const modes: { value: UpdateMode; label: string }[] = [
			{ value: 'default', label: localize('picodePrivacyUpdatesAuto', "Automatic") },
			{ value: 'start', label: localize('picodePrivacyUpdatesStart', "At startup") },
			{ value: 'manual', label: localize('picodePrivacyUpdatesManual', "When I ask") },
			{ value: 'none', label: localize('picodePrivacyUpdatesOff', "Off") },
		];
		const segmented = DOM.append(row, $('.picode-privacy-segmented'));
		segmented.setAttribute('role', 'radiogroup');
		segmented.setAttribute('aria-label', localize('picodePrivacyUpdates', "PiCode updates"));
		for (const option of modes) {
			const chosen = option.value === mode;
			const button = DOM.append(segmented, $(`button.picode-privacy-segment${chosen ? '.chosen' : ''}`)) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = option.label;
			button.setAttribute('role', 'radio');
			button.setAttribute('aria-checked', String(chosen));
			this.renderStore.add(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => this.update(UPDATE_MODE_SETTING, option.value)));
		}

		this.toggleRow(card, {
			icon: Codicon.extensions, color: 'purple',
			title: localize('picodePrivacyExtensions', "Extension updates"),
			description: localize('picodePrivacyExtensionsWhy', "Look for new versions of your extensions on Open VSX."),
			on: this.configurationService.getValue<boolean>(EXTENSION_CHECKS_SETTING) !== false,
			set: value => this.update(EXTENSION_CHECKS_SETTING, value),
		});
	}

	private renderFooter(page: HTMLElement): void {
		const actions = DOM.append(page, $('.picode-account-actions'));
		const origin = this.productService.picode?.webOrigin;
		if (origin) {
			const policy = this.renderStore.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			policy.label = localize('picodeAccountPrivacyPolicy', "Privacy policy");
			this.renderStore.add(policy.onDidClick(() => { void this.openerService.open(URI.parse(`${origin}/legal/privacy`)); }));
		}
		const settings = this.renderStore.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		settings.label = localize('picodePrivacyOpenSettings', "Open in Settings");
		this.renderStore.add(settings.onDidClick(() => { void this.commandService.executeCommand('workbench.action.openSettings', SHARE_USAGE_SETTING); }));
	}

	private toggleRow(card: HTMLElement, item: { icon: ThemeIcon; color: string; title: string; description: string; on: boolean; set: (value: boolean) => void }): void {
		const row = DOM.append(card, $(`.picode-sync-item.picode-account-privacy${item.on ? '.on' : ''}`));
		const label = DOM.append(row, $('label.picode-sync-item-label'));
		this.icon(label, item.icon, item.color);
		const text = DOM.append(label, $('.picode-sync-item-text'));
		DOM.append(text, $('strong')).textContent = item.title;
		DOM.append(text, $('span')).textContent = item.description;
		const box = DOM.append(row, $('input.picode-sync-switch')) as HTMLInputElement;
		box.type = 'checkbox';
		box.setAttribute('role', 'switch');
		box.checked = item.on;
		box.setAttribute('aria-label', item.title);
		this.renderStore.add(DOM.addDisposableListener(box, DOM.EventType.CHANGE, () => item.set(box.checked)));
		this.renderStore.add(DOM.addDisposableListener(label, DOM.EventType.CLICK, e => {
			e.preventDefault();
			item.set(!item.on);
		}));
	}

	private chips(parent: HTMLElement, title: string, kind: 'sent' | 'never', values: string[], empty = false): void {
		const line = DOM.append(parent, $(`.picode-privacy-chips.${kind}${empty ? '.empty' : ''}`));
		const head = DOM.append(line, $('span.picode-privacy-chips-title'));
		head.appendChild(renderIcon(kind === 'sent' ? Codicon.arrowUp : Codicon.circleSlash));
		DOM.append(head, $('span')).textContent = title;
		const list = DOM.append(line, $('.picode-privacy-chip-list'));
		for (const value of values) {
			DOM.append(list, $('span.picode-privacy-chip')).textContent = value;
		}
	}

	private groupHead(page: HTMLElement, label: string): void {
		DOM.append(DOM.append(page, $('.picode-sync-head')), $('h3')).textContent = label;
	}

	private icon(parent: HTMLElement, icon: ThemeIcon, color: string): void {
		const box = DOM.append(parent, $('.picode-sync-item-icon'));
		box.style.setProperty('--picode-sync-item-color', `var(--vscode-charts-${color})`);
		box.appendChild(renderIcon(icon));
	}

	private systemName(): string {
		switch (OS) {
			case OperatingSystem.Windows: return 'Windows';
			case OperatingSystem.Macintosh: return 'macOS';
			default: return 'Linux';
		}
	}

	private sharing(): boolean {
		return this.configurationService.getValue<boolean>(SHARE_USAGE_SETTING) !== false;
	}

	private update(key: string, value: unknown): void {
		void this.configurationService.updateValue(key, value, ConfigurationTarget.USER);
	}
}

registerAccountSection({
	id: 'privacy',
	label: localize('picodeAccountPrivacy', "Privacy"),
	icon: Codicon.shield,
	order: 18,
	create: (instantiationService: IInstantiationService, container: HTMLElement) => instantiationService.createInstance(PicodeAccountPrivacySection, container),
});
