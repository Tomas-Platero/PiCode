/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/picodeProvidersModels.css';
import { $, addDisposableListener, append, clearNode } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import {
	aiCustomizationManagementSectionRegistry,
	IAICustomizationManagementSectionContribution,
	IAICustomizationManagementSectionWidget,
} from '../../chat/browser/aiCustomization/aiCustomizationManagementSectionRegistry.js';
import { AICustomizationManagementSection } from '../../chat/common/aiCustomizationWorkspaceService.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { PICODE_PROVIDERS_SETTING } from './picodeConfiguration.js';
import { createServiceLogo } from './picodeServiceLogo.js';

/**
 * Providers & Models, as PiCode's own panel inside Chat Settings.
 *
 * The editor ships a full-screen Language Models page; embedding that here would bring a page into
 * a panel. This is the panel's own view of the same two questions, in the order they are asked:
 *
 * - **Providers** — what connects PiCode to a model: its address, its dialect, whether a key is
 *   stored. Cards, and one `+ Add Provider` that opens a form in place.
 * - **Models** — what those providers actually offer, with the search and the tool filter that
 *   matter when a catalogue has hundreds of entries.
 *
 * The layout rule the two tabs share is the one that keeps buttons reachable in a narrow panel: the
 * toolbar does not scroll (`flex-shrink: 0`) and the list has its own scroll (`flex: 1`).
 */

/** One provider as `picode.providers` stores it. */
interface IProviderRow {
	readonly id?: string;
	readonly endpoint?: string;
	readonly api?: string;
	readonly key?: string;
}

/** One provider the profile carries, as the connector's status command answers. */
interface IProfileProvider {
	readonly id: string;
	/** PiCode's settings declare it (the row the settings page can edit). */
	readonly declared: boolean;
	/** The profile carries models for it. */
	readonly models: boolean;
	/** The profile carries a credential for it. */
	readonly credential: boolean;
	/** The credential is a subscription sign-in (an account), not a key. */
	readonly subscription?: boolean;
}

/** The two sub-tabs of this section. */
type PanelTab = 'providers' | 'models' | 'agents';

/** What the connector says about Gentle's agents: who they are and what each is set to. */
interface IAgentModelsState {
	readonly agents: readonly string[];
	readonly models: Readonly<Record<string, { readonly model?: string; readonly thinking?: string }>>;
	readonly invalid: boolean;
}

/** Gentle's own preferences: how it talks and what new sessions start with. */
interface IGentleSettings {
	readonly persona: string;
	readonly permissions: string;
	readonly permissionsBroken: boolean;
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The tab a caller asked this panel to open on.
 *
 * Chat Settings keeps one panel alive once it was shown, so asking for a tab has two halves: a
 * panel that already exists switches through the event, and one created afterwards starts on it.
 */
const tabRequests = new Emitter<PanelTab>();
let pendingTab: PanelTab | undefined;

/** Opens Chat Settings on Providers & Models, on the tab asked for (Providers by default). */
export const OPEN_PROVIDERS_MODELS_COMMAND = 'picode.providersModels.open';

CommandsRegistry.registerCommand(OPEN_PROVIDERS_MODELS_COMMAND, async (accessor, tab?: PanelTab) => {
	const target: PanelTab = tab === 'models' || tab === 'agents' ? tab : 'providers';
	pendingTab = target;
	tabRequests.fire(target);
	await accessor.get(ICommandService).executeCommand('aiCustomization.openManagementEditor', AICustomizationManagementSection.ProvidersModels);
});

export class PiCodeProvidersModelsSection extends Disposable implements IAICustomizationManagementSectionWidget {

	private readonly root: HTMLElement;
	private readonly body: HTMLElement;
	private readonly tabsBar: HTMLElement;
	private readonly store = this._register(new DisposableStore());

	private tab: PanelTab = 'providers';
	/** The providers the **profile** has, as the connector reports them (`picode.setup.status`). */
	private profileProviders: readonly IProfileProvider[] = [];
	private profileLoaded = false;
	/** Gentle's agents and their models; `undefined` until the connector has answered. */
	private agentState: IAgentModelsState | undefined;
	private agentNote = '';
	private gentleState: IGentleSettings | undefined;
	/**
	 * The model the chat runs on, as this panel believes it.
	 *
	 * Kept here instead of read from the setting on every paint: `updateValue` is asynchronous, so
	 * painting right after the click read the **old** value and the badge appeared a beat later.
	 */
	private activeRef = '';

	constructor(
		container: HTMLElement,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this.root = append(container, $('.picode-pm'));
		const header = append(this.root, $('.picode-pm-header'));
		const headerText = append(header, $('.picode-pm-header-text'));
		append(headerText, $('h2.picode-pm-title')).textContent = localize('picodePm.title', "Providers & Models");
		append(headerText, $('p.picode-pm-subtitle')).textContent = localize(
			'picodePm.subtitle',
			"The services PiCode can talk to, and the models they offer. Everything here is stored in this installation's own profile.",
		);

		this.tabsBar = append(this.root, $('.picode-pm-tabs'));
		this.body = append(this.root, $('.picode-pm-body'));

		this.activeRef = this.configurationService.getValue<string>('chat.defaultModel') ?? '';
		if (pendingTab !== undefined) {
			this.tab = pendingTab;
			pendingTab = undefined;
		}
		if (this.tab === 'agents') {
			void this.loadAgents();
		}
		this.render();
		void this.loadProfileProviders();
		this.store.add(tabRequests.event(tab => {
			pendingTab = undefined;
			this.selectTab(tab);
		}));

		this.store.add(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('chat.defaultModel')) {
				// Somebody else moved the model (the picker, the setup): follow, not lead.
				this.activeRef = this.configurationService.getValue<string>('chat.defaultModel') ?? '';
				if (this.tab === 'models') {
					this.render();
				}
			}
			if (event.affectsConfiguration(PICODE_PROVIDERS_SETTING)) {
				this.render();
			}
		}));
		this.store.add(this.languageModelsService.onDidChangeLanguageModels(() => {
			if (this.tab === 'models') {
				this.render();
			}
		}));
	}

	layout(): void {
		// The panel is pure flexbox: nothing to measure, and re-rendering on every resize step would
		// rebuild the table for no gain.
	}

	/** Focus lands on the tab strip: the tabs are the first thing this panel is about. */
	focus(): void {
		this.tabsBar.querySelector<HTMLElement>('button')?.focus();
	}

	/**
	 * Asks the connector which providers the profile has.
	 *
	 * The settings store is not the answer: a provider can live entirely in the profile's
	 * `models.json` — `omni` does — and a credential can exist for a name with no declaration
	 * (`nan`). Reading only the settings showed an empty list on a machine with 165 models.
	 */
	private async loadProfileProviders(): Promise<void> {
		try {
			const data = await this.commandService.executeCommand<{ providers?: readonly IProfileProvider[] }>('picode.setup.status');
			this.profileProviders = Array.isArray(data?.providers) ? data.providers : [];
		} catch {
			// The connector is not answering: the panel still shows what the settings declare.
			this.profileProviders = [];
		} finally {
			this.profileLoaded = true;
			if (this.tab === 'providers') {
				this.render();
			}
		}
	}

	private providers(): readonly IProviderRow[] {
		const stored = this.configurationService.getValue<readonly IProviderRow[]>(PICODE_PROVIDERS_SETTING);
		return Array.isArray(stored) ? stored.filter(row => typeof row === 'object' && row !== null) : [];
	}

	private setProviders(rows: readonly IProviderRow[]): void {
		void this.configurationService.updateValue(PICODE_PROVIDERS_SETTING, rows);
	}

	private selectTab(key: PanelTab): void {
		if (this.tab !== key) {
			this.tab = key;
			if (key === 'agents') {
				void this.loadAgents();
			}
			this.render();
		}
	}

	private render(): void {
		clearNode(this.tabsBar);
		clearNode(this.body);

		for (const [key, label] of [['providers', localize('picodePm.tabProviders', "Providers")], ['models', localize('picodePm.tabModels', "Models")], ['agents', localize('picodePm.tabAgents', "Gentle AI")]] as const) {
			const button = append(this.tabsBar, $('button.picode-pm-tab'));
			button.setAttribute('type', 'button');
			button.textContent = label;
			button.classList.toggle('active', this.tab === key);
			button.setAttribute('aria-selected', this.tab === key ? 'true' : 'false');
			button.setAttribute('role', 'tab');
			this.store.add(addDisposableListener(button, 'click', () => this.selectTab(key)));
		}

		if (this.tab === 'providers') {
			this.renderProviders();
		} else if (this.tab === 'models') {
			this.renderModels();
		} else {
			this.renderAgents();
		}
	}

	/* ------------------------------------------------------------------ providers */

	private renderProviders(): void {
		const declared = this.providers();
		// One list, two sources: the providers the profile carries (the truth the chat uses) and the
		// ones the settings declare (the editable rows). A provider in both is one card.
		const ids = new Set<string>([
			...this.profileProviders.map(provider => provider.id),
			...declared.map(row => row.id ?? ''),
		]);
		const cards = [...ids].filter(id => id.length > 0).sort((left, right) => left.localeCompare(right));

		const toolbar = append(this.body, $('.picode-pm-toolbar'));
		const addButton = this.store.add(new Button(toolbar, { ...defaultButtonStyles, supportIcons: true }));
		addButton.label = `$(${Codicon.add.id}) ${localize('picodePm.addProvider', "Add Provider")}`;
		addButton.setTitle(localize('picodePm.addProviderTooltip', "Connect a provider: an address, a dialect and, when it needs one, a key"));
		this.store.add(addButton.onDidClick(() => this.openProviderForm()));

		// SSO: the providers that sign you in with your own account (ChatGPT, Claude, Copilot…) are
		// added by the connector's own login flow — a browser round-trip and pi's credential store,
		// which no form in this panel can stand in for.
		const ssoButton = this.store.add(new Button(toolbar, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		ssoButton.label = `$(${Codicon.account.id}) ${localize('picodePm.signInSubscription', "Sign in with a subscription")}`;
		ssoButton.setTitle(localize('picodePm.signInSubscriptionTooltip', "Sign in with an account you already pay for — ChatGPT, Claude, Copilot — and its provider is added here"));
		this.store.add(ssoButton.onDidClick(() => this.signInSubscription()));

		const list = append(this.body, $('.picode-pm-list'));
		if (!this.profileLoaded) {
			append(list, $('p.picode-pm-empty')).textContent = localize('picodePm.reading', "Reading the providers this profile carries...");
			return;
		}
		if (cards.length === 0) {
			append(list, $('p.picode-pm-empty')).textContent = localize(
				'picodePm.noProviders',
				"No providers yet. Add one with an address that speaks the OpenAI dialect — OpenRouter, DeepSeek, Groq or your own server.",
			);
			return;
		}

		for (const id of cards) {
			const row = declared.find(candidate => candidate.id === id);
			const profile = this.profileProviders.find(candidate => candidate.id === id);

			const card = append(list, $('.picode-pm-card'));
			const main = append(card, $('.picode-pm-card-main'));
			// The real mark when it can be fetched, initials otherwise — never a broken image.
			const logo = append(main, $('.picode-pm-card-mark'));
			logo.appendChild(createServiceLogo(id, row?.endpoint));
			const text = append(main, $('.picode-pm-card-text'));
			append(text, $('span.picode-pm-card-name')).textContent = id;

			// The subtitle says where it comes from, because that is what decides what can be edited:
			// an address lives here, a provider that only exists in the profile is read-only here.
			const detail = row?.endpoint !== undefined
				? [row.endpoint, row.api].filter(part => typeof part === 'string' && part.length > 0).join(' · ')
				: localize('picodePm.fromProfile', "In the pi profile");
			const counts: string[] = [];
			if (profile?.models === true) {
				counts.push(localize('picodePm.hasModels', "models"));
			}
			if (profile?.credential === true) {
				counts.push(profile.subscription === true
					? localize('picodePm.hasSubscription', "subscription")
					: localize('picodePm.hasCredential', "sign-in stored"));
			}
			append(text, $('span.picode-pm-card-sub')).textContent = counts.length > 0 ? `${detail} · ${counts.join(' · ')}` : detail;

			// The badge says what is **stored**, not what is required — pi decides that, not us.
			// A provider with models and no credential is the normal case for a local server: its
			// address answers without a key, so saying "No key" as if it were a fault was wrong.
			const badge = append(card, $('span.picode-pm-badge'));
			const hasKey = (row?.key !== undefined && row.key.length > 0) || profile?.credential === true;
			const servesModels = profile?.models === true;
			badge.classList.add(hasKey ? 'ok' : servesModels ? 'info' : 'muted');
			badge.textContent = profile?.subscription === true
				? localize('picodePm.signedIn', "Signed in")
				: hasKey
				? localize('picodePm.keyStored', "Key saved")
				: servesModels
					? localize('picodePm.noKeyNeeded', "No key needed")
					: localize('picodePm.noKey', "No key");
			badge.title = hasKey
				? localize('picodePm.keyStoredTooltip', "A credential is stored in the pi profile. It is never shown here.")
				: servesModels
					? localize('picodePm.noKeyNeededTooltip', "No credential is stored, and its models are listed anyway: its address answers without a key — a server on your own machine usually does — or pi reads the key from an environment variable.")
					: localize('picodePm.noKeyTooltip', "No credential is stored and it has no models yet. Add one here, or give it a key.");

			const actions = append(card, $('.picode-pm-card-actions'));
			// Only a declared row is editable: what lives only in the profile is pi's file, not ours.
			if (row !== undefined) {
				const edit = this.store.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
				edit.label = localize('picodePm.edit', "Edit");
				this.store.add(edit.onDidClick(() => this.openProviderForm(row)));

				const remove = this.store.add(new Button(actions, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
				remove.label = `$(${Codicon.trash.id})`;
				remove.setTitle(localize('picodePm.removeTooltip', "Remove this provider from PiCode's settings"));
				this.store.add(remove.onDidClick(() => {
					this.setProviders(this.providers().filter(candidate => candidate.id !== id));
				}));
			}
		}
	}

	/**
	 * Adds a provider by **signing in**, not by typing a key.
	 *
	 * The connector owns this flow: it asks pi which providers take an account, opens the browser,
	 * and stores the credential in the profile. All this panel does is start it and wait, then read
	 * the profile again so the new provider appears without a reload.
	 */
	private async signInSubscription(): Promise<void> {
		try {
			await this.commandService.executeCommand('picode.connectProvider');
		} catch (error) {
			this.showPanelNote(localize('picodePm.signInFailed', "The sign-in could not be started: {0}", error instanceof Error ? error.message : String(error)));
			return;
		}
		await this.loadProfileProviders();
	}

	/** One line of feedback at the top of the list, replaced each time. */
	private showPanelNote(text: string): void {
		const existing = this.body.querySelector<HTMLElement>('.picode-pm-note');
		if (existing !== null) {
			existing.textContent = text;
			return;
		}
		const note = append(this.body, $('p.picode-pm-note'));
		note.textContent = text;
	}

	/** The add/edit form, in place — and only one at a time. */
	private openProviderForm(existing?: IProviderRow): void {
		const list = this.body.querySelector<HTMLElement>('.picode-pm-list');
		if (list === null) {
			return;
		}
		const open = list.querySelector<HTMLElement>('.picode-pm-form');
		if (open !== null) {
			// Asked twice, answered once: the form already on screen is brought back into view with
			// its first field focused, instead of stacking a second copy under it.
			open.scrollIntoView({ block: 'nearest' });
			open.querySelector<HTMLInputElement>('input')?.focus();
			return;
		}
		const form = append(list, $('.picode-pm-form'));
		const field = (label: string, value: string, type = 'text'): InputBox => {
			const wrapper = append(form, $('label.picode-pm-field'));
			append(wrapper, $('span.picode-pm-field-label')).textContent = label;
			const input = this.store.add(new InputBox(wrapper, this.contextViewService, {
				inputBoxStyles: defaultInputBoxStyles,
				placeholder: '',
			}));
			input.value = value;
			if (type === 'password') {
				input.inputElement.type = 'password';
			}
			return input;
		};

		const idInput = field(localize('picodePm.fieldName', "Name"), existing?.id ?? '');
		const endpointInput = field(localize('picodePm.fieldEndpoint', "Address"), existing?.endpoint ?? 'https://');
		const keyInput = field(localize('picodePm.fieldKey', "Key (optional)"), existing?.key ?? '', 'password');

		const actions = append(form, $('.picode-pm-form-actions'));
		const save = this.store.add(new Button(actions, defaultButtonStyles));
		save.label = localize('picodePm.save', "Save");
		this.store.add(save.onDidClick(() => {
			const id = idInput.value.trim();
			const endpoint = endpointInput.value.trim();
			if (id.length === 0 || /\s/.test(id) || !/^https?:\/\//.test(endpoint)) {
				// A wrong row is worse than no row: it would show a provider that cannot answer.
				form.classList.add('invalid');
				if (form.querySelector('.picode-pm-error') === null) {
					append(form, $('p.picode-pm-error')).textContent = localize(
						'picodePm.invalid',
						"A provider needs a short name with no spaces and an address starting with http:// or https://.",
					);
				}
				return;
			}
			const row: IProviderRow = {
				id,
				endpoint,
				api: existing?.api ?? 'openai-completions',
				...(keyInput.value.trim().length > 0 ? { key: keyInput.value.trim() } : {}),
			};
			const others = this.providers().filter(candidate => candidate.id !== (existing?.id ?? id));
			this.setProviders([...others, row]);
		}));

		const cancel = this.store.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		cancel.label = localize('picodePm.cancel', "Cancel");
		this.store.add(cancel.onDidClick(() => this.render()));
		idInput.focus();
	}

	/* --------------------------------------------------------------------- agents */

	/** Asks the connector for Gentle's agents and what each is set to. */
	private async loadAgents(): Promise<void> {
		try {
			this.agentState = await this.commandService.executeCommand<IAgentModelsState>('picode.agents.models');
		} catch {
			this.agentState = { agents: [], models: {}, invalid: false };
		}
		try {
			this.gentleState = await this.commandService.executeCommand<IGentleSettings>('picode.gentle.settings');
		} catch {
			this.gentleState = undefined;
		}
		if (this.tab === 'agents') {
			this.render();
		}
	}

	/** One of Gentle's own preferences (`persona` or `permissions`). */
	private async saveGentle(key: string, value: string): Promise<void> {
		try {
			this.gentleState = await this.commandService.executeCommand<IGentleSettings>('picode.gentle.setSetting', { key, value });
			this.agentNote = localize('picodePm.agentSaved', "Saved. The agents use it from your next message.");
		} catch (error) {
			this.agentNote = localize('picodePm.agentFailed', "It could not be saved: {0}", error instanceof Error ? error.message : String(error));
		}
		if (this.tab === 'agents') {
			this.render();
		}
	}

	/** One change: an agent (or all of them), its model and its effort, as the rows now say. */
	private async saveAgent(agent: string, model: string, thinking: string): Promise<void> {
		try {
			this.agentState = await this.commandService.executeCommand<IAgentModelsState>('picode.agents.setModel', { agent, model, thinking });
			this.agentNote = localize('picodePm.agentSaved', "Saved. The agents use it from your next message.");
		} catch (error) {
			this.agentNote = localize('picodePm.agentFailed', "It could not be saved: {0}", error instanceof Error ? error.message : String(error));
		}
		if (this.tab === 'agents') {
			this.render();
		}
	}

	/** Gentle's own preferences: how it talks and what new conversations start with. */
	private renderGentleBehaviour(): void {
		const gentle = this.gentleState;
		if (gentle !== undefined) {
			const choice = (icon: ThemeIcon, label: string, description: string, warning: boolean, current: string, options: ReadonlyArray<[string, string]>, key: string, disabled: boolean): void => {
				const card = append(this.body, $('.picode-pm-setting'));
				append(card, $('span.picode-pm-setting-icon' + ThemeIcon.asCSSSelector(icon)));
				const text = append(card, $('.picode-pm-setting-text'));
				append(text, $('.picode-pm-setting-label')).textContent = label;
				append(text, $('.picode-pm-setting-hint' + (warning ? '.warning' : ''))).textContent = description;
				const select = document.createElement('select');
				select.className = 'picode-pm-select picode-pm-setting-select';
				select.setAttribute('aria-label', label);
				select.disabled = disabled;
				for (const [value, name] of options) {
					select.append(new Option(name, value));
				}
				select.value = current;
				card.append(select);
				this.store.add(addDisposableListener(select, 'change', () => { void this.saveGentle(key, select.value); }));
			};
			choice(
				Codicon.comment,
				localize('picodePm.gentlePersona', "How it talks"),
				localize('picodePm.gentlePersonaNote', "Gentleman is direct and teaches the why behind each step. Neutral is plain and professional."),
				false,
				gentle.persona,
				[['gentleman', localize('picodePm.personaGentleman', "Gentleman")], ['neutral', localize('picodePm.personaNeutral', "Neutral")]],
				'persona',
				false,
			);
			choice(
				Codicon.shield,
				localize('picodePm.gentlePermissions', "Permissions for new conversations"),
				gentle.permissionsBroken
					? localize('picodePm.gentlePermissionsBroken', "The saved permissions could not be read. Delete the file and try again.")
					: localize('picodePm.gentlePermissionsNote', "Normal asks before it acts. Auto lets a second model call decide, which costs extra. YOLO does ordinary development steps without asking; anything destructive still asks."),
				gentle.permissionsBroken,
				gentle.permissions,
				[['normal', localize('picodePm.permNormal', "Normal")], ['auto', localize('picodePm.permAuto', "Auto")], ['yolo', localize('picodePm.permYolo', "YOLO")]],
				'permissions',
				gentle.permissionsBroken,
			);
		}
	}

	private renderAgents(): void {
		const state = this.agentState;
		if (state === undefined) {
			append(this.body, $('p.picode-pm-empty')).textContent = localize('picodePm.agentsReading', "Reading Gentle's agents...");
			return;
		}
		this.renderGentleBehaviour();
		if (state.invalid) {
			append(this.body, $('p.picode-pm-empty')).textContent = localize('picodePm.agentsInvalid', "The agents' model list could not be read. Delete it and try again.");
			return;
		}
		if (state.agents.length === 0) {
			append(this.body, $('p.picode-pm-empty')).textContent = localize('picodePm.agentsNone', "The agents are not ready yet. Send a message in the chat once, then come back.");
			return;
		}

		// Every model the editor can reach, by provider; a model the file names that is not in the list is kept.
		const catalogue = new Map<string, { name: string; provider: string }>();
		for (const modelId of this.languageModelsService.getLanguageModelIds()) {
			const metadata = this.languageModelsService.lookupLanguageModel(modelId);
			if (metadata !== undefined) {
				catalogue.set(metadata.id, { name: metadata.name, provider: metadata.family || metadata.vendor });
			}
		}
		const modelSelect = (current: string, placeholder: string): HTMLSelectElement => {
			const select = document.createElement('select');
			select.className = 'picode-pm-select picode-pm-agent-select';
			select.append(new Option(placeholder, ''));
			if (current.length > 0 && !catalogue.has(current)) {
				select.append(new Option(current, current));
			}
			const byProvider = new Map<string, Array<[string, string]>>();
			for (const [ref, { name, provider }] of catalogue) {
				byProvider.set(provider, [...(byProvider.get(provider) ?? []), [ref, name]]);
			}
			for (const provider of [...byProvider.keys()].sort((left, right) => left.localeCompare(right))) {
				const group = document.createElement('optgroup');
				group.label = provider;
				for (const [ref, name] of byProvider.get(provider)!.sort((left, right) => left[1].localeCompare(right[1]))) {
					group.append(new Option(name, ref));
				}
				select.append(group);
			}
			select.value = current;
			return select;
		};
		const thinkingSelect = (current: string): HTMLSelectElement => {
			const select = document.createElement('select');
			select.className = 'picode-pm-select picode-pm-agent-select';
			select.setAttribute('aria-label', localize('picodePm.agentThinking', "How much it thinks"));
			select.append(new Option(localize('picodePm.agentThinkingDefault', "Default effort"), ''));
			for (const level of THINKING_LEVELS) {
				select.append(new Option(level, level));
			}
			select.value = current;
			return select;
		};

		append(this.body, $('p.picode-pm-hint')).textContent = localize(
			'picodePm.agentsNote',
			"The model each of Gentle's agents answers with. An agent on the same model as the rest uses the model new conversations open with.",
		);
		const toolbar = append(this.body, $('.picode-pm-toolbar'));
		append(toolbar, $('span.picode-pm-agent-all')).textContent = localize('picodePm.agentAll', "Every agent");
		const all = modelSelect('', localize('picodePm.agentAllPlaceholder', "Set them all to..."));
		all.setAttribute('aria-label', localize('picodePm.agentAllLabel', "Set every agent to one model"));
		toolbar.appendChild(all);
		this.store.add(addDisposableListener(all, 'change', () => {
			if (all.value.length > 0) {
				void this.saveAgent('all', all.value, '');
			}
		}));
		if (this.agentNote.length > 0) {
			append(this.body, $('p.picode-pm-note')).textContent = this.agentNote;
		}

		const list = append(this.body, $('.picode-pm-models'));
		for (const agent of state.agents) {
			const saved = state.models[agent] ?? {};
			const line = append(list, $('.picode-pm-agent'));
			const name = append(line, $('.picode-pm-agent-name'));
			append(name, $('span' + ThemeIcon.asCSSSelector(Codicon.hubot)));
			append(name, $('span')).textContent = agent;
			const model = modelSelect(saved.model ?? '', localize('picodePm.agentSame', "Same model as the rest"));
			model.setAttribute('aria-label', localize('picodePm.agentModelLabel', "Model for {0}", agent));
			const thinking = thinkingSelect(saved.thinking ?? '');
			line.append(model, thinking);
			const save = () => { void this.saveAgent(agent, model.value, thinking.value); };
			this.store.add(addDisposableListener(model, 'change', save));
			this.store.add(addDisposableListener(thinking, 'change', save));
		}
	}

	/* --------------------------------------------------------------------- models */

	private renderModels(): void {
		// The toolbar nobody can scroll away: search, provider and the two capability chips that
		// exist in a model's metadata (tools and vision). "Reasoning" and "Code" are not declared
		// fields, so a chip for them would filter nothing — a button that does nothing is worse
		// than no button.
		const toolbar = append(this.body, $('.picode-pm-toolbar'));
		const search = this.store.add(new InputBox(toolbar, this.contextViewService, {
			inputBoxStyles: defaultInputBoxStyles,
			placeholder: localize('picodePm.searchModels', "Search models by name or id..."),
		}));
		search.element.classList.add('picode-pm-search');

		const providerSelect = document.createElement('select');
		providerSelect.className = 'picode-pm-select';
		providerSelect.setAttribute('aria-label', localize('picodePm.filterProvider', "Filter by provider"));
		toolbar.appendChild(providerSelect);

		const chip = (label: string): HTMLButtonElement => {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'picode-pm-chip';
			button.textContent = label;
			button.setAttribute('aria-pressed', 'false');
			toolbar.appendChild(button);
			return button;
		};
		const toolsChip = chip(localize('picodePm.chipTools', "Tools"));
		const visionChip = chip(localize('picodePm.chipVision', "Vision"));

		const list = append(this.body, $('.picode-pm-models'));
		const activeRef = this.activeRef;

		const paint = (): void => {
			clearNode(list);

			const query = search.value.trim().toLowerCase();
			const wantedProvider = providerSelect.value;
			const onlyTools = toolsChip.getAttribute('aria-pressed') === 'true';
			const onlyVision = visionChip.getAttribute('aria-pressed') === 'true';

			type Row = { ref: string; name: string; provider: string; context: string; output: string; price: string | undefined; priceTitle: string | undefined; tools: boolean; vision: boolean };
			const rows: Row[] = [];
			for (const modelId of this.languageModelsService.getLanguageModelIds()) {
				const metadata = this.languageModelsService.lookupLanguageModel(modelId);
				if (metadata === undefined) {
					continue;
				}
				// `family` carries the provider (the connector sets it); `vendor` is PiCode itself.
				const provider = metadata.family || metadata.vendor;
				rows.push({
					// `chat.defaultModel` is resolved against the model's **own id** (`metadata.id`,
					// which the connector sets to `<provider>/<model>`), not against the editor's
					// qualified `picode/<provider>/<model>` identifier. Writing the qualified one
					// matched nothing, which is why "Use" did nothing at all.
					ref: metadata.id,
					name: metadata.name,
					provider,
					context: formatTokenCount(metadata.maxInputTokens),
					output: formatTokenCount(metadata.maxOutputTokens),
					price: priceChip(metadata.inputCost, metadata.outputCost),
					priceTitle: metadata.pricing,
					tools: metadata.capabilities?.toolCalling === true,
					vision: metadata.capabilities?.vision === true,
				});
			}
			rows.sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name));

			// The provider options follow the catalogue, with their counts.
			const providers = [...new Set(rows.map(row => row.provider))].sort((left, right) => left.localeCompare(right));
			const previous = providerSelect.value;
			providerSelect.replaceChildren(
				new Option(localize('picodePm.allProviders', "All providers"), ''),
				...providers.map(provider => new Option(`${provider} (${rows.filter(row => row.provider === provider).length})`, provider)),
			);
			providerSelect.value = providers.includes(previous) ? previous : '';

			let shown = 0;
			for (const row of rows) {
				if (onlyTools && !row.tools) {
					continue;
				}
				if (onlyVision && !row.vision) {
					continue;
				}
				if (wantedProvider.length > 0 && row.provider !== wantedProvider) {
					continue;
				}
				if (query.length > 0 && !`${row.name} ${row.ref} ${row.provider}`.toLowerCase().includes(query)) {
					continue;
				}
				shown += 1;
				list.appendChild(this.renderModelCard(row, activeRef));
			}
			if (shown === 0) {
				append(list, $('.picode-pm-empty')).textContent = query.length === 0 && !onlyTools && !onlyVision && wantedProvider.length === 0
					? localize('picodePm.noModels', "No models yet. Connect a provider and PiCode will list what it offers.")
					: localize('picodePm.noMatches', "Nothing matches that.");
			}
		};

		paint();
		this.store.add(addDisposableListener(providerSelect, 'change', paint));
		this.store.add(addDisposableListener(search.element, 'input', paint));
		for (const button of [toolsChip, visionChip]) {
			this.store.add(addDisposableListener(button, 'click', () => {
				button.setAttribute('aria-pressed', button.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
				paint();
			}));
		}
	}

	/**
	 * One model, as a **compact row**.
	 *
	 * Name and provider on the left, the facts in the middle, the two actions on the right — and
	 * those actions stay quiet until the row is hovered or focused, so a catalogue of 165 reads as
	 * a list instead of a wall of buttons. A card per model looked tidy with six of them and became
	 * unusable with a hundred.
	 */
	private renderModelCard(row: { ref: string; name: string; provider: string; context: string; output: string; price: string | undefined; priceTitle: string | undefined; tools: boolean; vision: boolean }, activeRef: string): HTMLElement {
		const line = $('.picode-pm-model');

		const left = append(line, $('.picode-pm-model-left'));
		const name = append(left, $('span.picode-pm-model-name'));
		name.textContent = row.name;
		name.title = row.ref;
		append(left, $('span.picode-pm-model-provider')).textContent = row.provider;
		if (row.ref === activeRef) {
			const active = append(left, $('span.picode-pm-badge.ok'));
			active.textContent = localize('picodePm.activeInChat', "● Active");
			active.title = localize('picodePm.activeInChatTooltip', "This is the model a new conversation opens with, and the one the open chat was switched to.");
		}

		const facts = append(line, $('.picode-pm-model-facts'));
		// What goes in, what comes out, and what it costs: the three numbers that decide which model
		// to pick. A fact the provider did not report is not drawn.
		const contextFact = append(facts, $('span.picode-pm-fact'));
		contextFact.textContent = localize('picodePm.factContext', "{0} in", row.context);
		contextFact.title = localize('picodePm.factContextTooltip', "The most the model can read at once: your conversation, files and instructions together.");
		const outputFact = append(facts, $('span.picode-pm-fact'));
		outputFact.textContent = localize('picodePm.factOutput', "{0} out", row.output);
		outputFact.title = localize('picodePm.factOutputTooltip', "The most the model can write in one answer.");
		if (row.price !== undefined) {
			const priceFact = append(facts, $('span.picode-pm-fact.picode-pm-fact-price'));
			priceFact.textContent = row.price;
			priceFact.title = row.priceTitle ?? localize('picodePm.factPriceTooltip', "Price per million tokens, in and out.");
		}
		if (row.tools) {
			append(facts, $('span.picode-pm-fact')).textContent = localize('picodePm.factTools', "Tools");
		}
		if (row.vision) {
			append(facts, $('span.picode-pm-fact')).textContent = localize('picodePm.factVision', "Vision");
		}

		const actions = append(line, $('.picode-pm-model-actions'));

		const use = this.store.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		use.label = localize('picodePm.useInChat', "Use");
		use.setTitle(localize('picodePm.useInChatTooltip', "Use this model in the chat: the open conversation switches to it right away, and a new one opens with it."));
		this.store.add(use.onDidClick(() => {
			// The badge moves **now**, not when the write comes back: the click is the decision, and
			// waiting for a promise to paint made it look like nothing had happened.
			this.activeRef = row.ref;
			this.render();
			// One write, two effects: the chat applies a **changed** `chat.defaultModel` to the open
			// conversation too (see `chatInputPart`), so this is the honest way to switch it from here.
			void this.configurationService.updateValue('chat.defaultModel', row.ref);
		}));

		const makeDefault = this.store.add(new Button(actions, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		makeDefault.label = `$(${Codicon.star.id})`;
		makeDefault.setTitle(localize('picodePm.makeDefaultTooltip', "Make this the default in the pi profile, so every new session starts on it"));
		this.store.add(makeDefault.onDidClick(async () => {
			try {
				await this.commandService.executeCommand('picode.setup.modelDefault', row.ref.replace(/^picode\//, ''));
			} catch (error) {
				this.showPanelNote(localize('picodePm.defaultFailed', "The default could not be saved: {0}", error instanceof Error ? error.message : String(error)));
			}
			this.render();
		}));

		return line;
	}

	override dispose(): void {
		this.store.dispose();
		super.dispose();
	}
}

/** The registry entry: the section PiCode owns inside Chat Settings. */
const contribution: IAICustomizationManagementSectionContribution = {
	id: AICustomizationManagementSection.ProvidersModels,
	label: localize('picodePm.sectionLabel', "Providers & Models"),
	icon: Codicon.vm,
	description: localize('picodePm.sectionDescription', "The services PiCode can talk to, and the models they offer."),
	supportsHarness: () => true,
	create: (instantiationService, container) => instantiationService.createInstance(PiCodeProvidersModelsSection, container),
};

aiCustomizationManagementSectionRegistry.register(contribution);

/** Token counts the way people say them: 200k, 1M. */
function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${Number((tokens / 1_000_000).toFixed(1))}M`;
	}
	if (tokens >= 1000) {
		return `${Math.round(tokens / 1000)}k`;
	}
	return String(tokens);
}

/** A price in dollars with only the digits that matter: $3, $0.25, $0.075. */
function formatDollars(dollars: number): string {
	return `$${Number(dollars.toFixed(dollars >= 1 ? 2 : 3))}`;
}

/**
 * The price chip of a model: what a million tokens in and out cost. Nothing at all when the
 * provider reported no price — an absent price is not a free model.
 */
function priceChip(input: number | undefined, output: number | undefined): string | undefined {
	if (input === undefined && output === undefined) {
		return undefined;
	}
	if (input !== undefined && output !== undefined) {
		return localize('picodePm.factPrice', "{0} in · {1} out", formatDollars(input), formatDollars(output));
	}
	return input !== undefined
		? localize('picodePm.factPriceIn', "{0} in", formatDollars(input))
		: localize('picodePm.factPriceOut', "{0} out", formatDollars(output as number));
}
