/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/picodeProvidersModels.css';
import { $, addDisposableListener, append, clearNode } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import {
	aiCustomizationManagementSectionRegistry,
	IAICustomizationManagementSectionContribution,
	IAICustomizationManagementSectionWidget,
} from '../../chat/browser/aiCustomization/aiCustomizationManagementSectionRegistry.js';
import { AICustomizationManagementSection } from '../../chat/common/aiCustomizationWorkspaceService.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { PICODE_PROVIDERS_SETTING } from './picodeConfiguration.js';
import { createServiceLogo, displayNameOf } from './picodeServiceLogo.js';

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

/** One provider pi can connect, as the connector's catalogue answers (`provider-auth.ts`). */
interface ICatalogEntry {
	readonly id: string;
	readonly name: string;
	readonly note?: string;
	readonly oauth: boolean;
	readonly apiKey: boolean;
	readonly connected?: 'subscription' | 'key';
}

type ICatalogAnswer = { readonly entries: readonly ICatalogEntry[] } | { readonly unavailable: string };

/** Where a sign-in stands, as the connector reports it. */
interface IAuthRunState {
	readonly run: number;
	readonly providerId: string;
	readonly method: 'oauth' | 'api_key';
	readonly phase: 'starting' | 'browser' | 'code' | 'question' | 'done' | 'cancelled' | 'failed';
	readonly userCode?: string;
	readonly canReopen: boolean;
	readonly canPaste: boolean;
	readonly question?: {
		readonly id: number;
		readonly kind: 'select' | 'secret' | 'text';
		readonly message: string;
		readonly placeholder?: string;
		readonly options?: readonly { readonly id: string; readonly label: string }[];
	};
	readonly error?: string;
}

/** `https://api.example.com/v1` → `api.example.com`; anything unparsable is returned as it came. */
function hostOf(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return endpoint;
	}
}

/** The two sub-tabs of this section. */
type PanelTab = 'providers' | 'models' | 'agents';

/** One route of an agent profile: the model an agent answers with, how hard it thinks, fast mode. */
interface IProfileRoute {
	readonly model?: string;
	readonly thinking?: string;
	readonly tier?: 'standard' | 'fast';
}

/** One of Gentle's agent profiles, as the connector reads it (`agent-profiles.ts`). */
interface IAgentProfile {
	readonly name: string;
	readonly routes: Readonly<Record<string, IProfileRoute>>;
	readonly mode: 'organic' | 'full-delegation';
	readonly fallbacks: number;
}

/** What the connector says about the agent profiles (`picode.agentProfiles.state`). */
interface IAgentProfilesView {
	readonly profiles: readonly IAgentProfile[];
	readonly active?: string;
	readonly unsaved: boolean;
	readonly invalid: boolean;
	readonly pins: { readonly local?: string; readonly repo?: string };
	readonly pinnable: boolean;
	readonly agents: readonly string[];
	readonly resolved: { readonly name?: string; readonly source: 'local' | 'repo' | 'default' };
	readonly editorProfile?: string;
	readonly live: boolean;
}

/** Gentle's reserved name for the main agent inside a profile. */
const ORCHESTRATOR = 'orchestrator';

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
	/** Gentle's agent profiles; `undefined` until the connector has answered. */
	private profilesView: IAgentProfilesView | undefined;
	/** The profile open on the right; the default one when nothing was picked. */
	private selectedProfile: string | undefined;
	private agentNote = '';
	private agentNoteIsError = false;
	private gentleState: IGentleSettings | undefined;
	/**
	 * The model the chat runs on, as this panel believes it.
	 *
	 * Kept here instead of read from the setting on every paint: `updateValue` is asynchronous, so
	 * painting right after the click read the **old** value and the badge appeared a beat later.
	 */
	private activeRef = '';

	/** Every provider pi can connect; `undefined` until the connector has answered. */
	private catalog: readonly ICatalogEntry[] | undefined;
	private catalogLoading = false;
	private catalogProblem: string | undefined;
	private providerQuery = '';
	/** The sign-in running in this panel, as last read from the connector. */
	private authState: IAuthRunState | undefined;
	/** The provider that just moved to Connected, highlighted once. */
	private justConnected: string | undefined;
	private readonly listStore = this._register(new DisposableStore());
	private readonly authPoll = this._register(new MutableDisposable());

	constructor(
		container: HTMLElement,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IDialogService private readonly dialogService: IDialogService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
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
				this.paintProviderList();
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
		// The toolbar is built once per visit and never repainted: typing in the search box repaints
		// only the list below it, so the box keeps its focus and its caret.
		const toolbar = append(this.body, $('.picode-pm-toolbar'));
		const search = this.store.add(new InputBox(toolbar, this.contextViewService, {
			inputBoxStyles: defaultInputBoxStyles,
			placeholder: localize('picodePv.search', "Search providers..."),
		}));
		search.element.classList.add('picode-pm-search');
		search.value = this.providerQuery;
		this.store.add(search.onDidChange(value => {
			this.providerQuery = value;
			this.paintProviderList();
		}));

		const custom = this.store.add(new Button(toolbar, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		custom.label = `$(${Codicon.server.id}) ${localize('picodePv.customServer', "Custom server")}`;
		custom.setTitle(localize('picodePv.customServerTooltip', "Connect your own server or any service that speaks the OpenAI dialect"));
		this.store.add(custom.onDidClick(() => this.openProviderForm()));

		append(this.body, $('.picode-pm-list.picode-pv-list'));
		this.paintProviderList();
		if (this.catalog === undefined && !this.catalogLoading) {
			void this.loadCatalog();
		}
	}

	/** Asks the connector for every provider pi can connect, and how each is connected now. */
	private async loadCatalog(): Promise<void> {
		this.catalogLoading = true;
		try {
			const answer = await this.commandService.executeCommand<ICatalogAnswer>('picode.providers.catalog');
			if (answer !== undefined && 'entries' in answer && Array.isArray(answer.entries)) {
				this.catalog = answer.entries;
				this.catalogProblem = undefined;
			} else {
				this.catalog = [];
				this.catalogProblem = answer !== undefined && 'unavailable' in answer ? answer.unavailable : 'failed';
			}
		} catch {
			this.catalog = [];
			this.catalogProblem = 'failed';
		} finally {
			this.catalogLoading = false;
			if (this.tab === 'providers') {
				this.paintProviderList();
			}
		}
	}

	/** Paints the connected providers and the gallery, filtered by the search box. */
	private paintProviderList(): void {
		const list = this.body.querySelector<HTMLElement>('.picode-pv-list');
		if (list === null) {
			return;
		}
		// An open form is the person's work in progress: a repaint that is not theirs leaves it alone.
		if (list.querySelector('.picode-pm-form') !== null) {
			return;
		}
		this.listStore.clear();
		clearNode(list);

		const query = this.providerQuery.trim().toLowerCase();
		const matches = (...texts: (string | undefined)[]) => query.length === 0 || texts.some(text => text !== undefined && text.toLowerCase().includes(query));
		const catalog = this.catalog ?? [];
		const declared = this.providers();

		// Connected: whatever the chat can already use — a sign-in, a key, a local server's models,
		// or a server declared here. One card each, whichever source knows about it.
		const connectedIds = new Set<string>([
			...catalog.filter(entry => entry.connected !== undefined).map(entry => entry.id),
			...this.profileProviders.filter(provider => provider.credential || provider.models).map(provider => provider.id),
			...declared.map(row => row.id ?? '').filter(id => id.length > 0),
		]);
		const active = this.authState;
		const activeId = active !== undefined && active.phase !== 'cancelled' ? active.providerId : undefined;

		const connected = [...connectedIds]
			.filter(id => id !== activeId)
			.map(id => ({ id, entry: catalog.find(candidate => candidate.id === id) }))
			.filter(({ id, entry }) => matches(id, entry?.name, entry?.note))
			.sort((left, right) => (left.entry?.name ?? left.id).localeCompare(right.entry?.name ?? right.id));

		if (!this.profileLoaded && this.catalog === undefined) {
			this.paintSkeleton(list);
			return;
		}

		if (connected.length > 0) {
			this.paintSectionTitle(list, localize('picodePv.connected', "Connected"), connected.length, Codicon.check);
			const grid = append(list, $('.picode-pv-grid.connected'));
			for (const { id, entry } of connected) {
				this.paintConnectedCard(grid, id, entry, declared.find(row => row.id === id));
			}
		}

		if (this.catalog === undefined) {
			this.paintSkeleton(list);
			return;
		}
		if (this.catalogProblem !== undefined) {
			this.paintCatalogProblem(list, this.catalogProblem);
			return;
		}

		const available = catalog.filter(entry => (!connectedIds.has(entry.id) || entry.id === activeId) && matches(entry.id, entry.name, entry.note));
		const accounts = available.filter(entry => entry.oauth);
		const keys = available.filter(entry => !entry.oauth && entry.apiKey);

		if (accounts.length > 0) {
			this.paintSectionTitle(list, localize('picodePv.withAccount', "Sign in with your account"), accounts.length, Codicon.account);
			const grid = append(list, $('.picode-pv-grid'));
			for (const entry of accounts) {
				this.paintTile(grid, entry, 'oauth');
			}
		}
		if (keys.length > 0) {
			this.paintSectionTitle(list, localize('picodePv.withKey', "Use an API key"), keys.length, Codicon.key);
			const grid = append(list, $('.picode-pv-grid'));
			for (const entry of keys) {
				this.paintTile(grid, entry, 'api_key');
			}
		}
		if (connected.length === 0 && accounts.length === 0 && keys.length === 0) {
			append(list, $('p.picode-pm-empty')).textContent = localize('picodePv.noMatch', "No provider matches \"{0}\".", this.providerQuery.trim());
		}

		// The key field is the one thing on screen waiting for the person: it gets the caret.
		list.querySelector<HTMLInputElement>('.picode-pv-flow input')?.focus();
	}

	private paintSectionTitle(list: HTMLElement, title: string, count: number, icon: ThemeIcon): void {
		const heading = append(list, $('.picode-pv-section'));
		append(heading, $(`span${ThemeIcon.asCSSSelector(icon)}`));
		append(heading, $('span.picode-pv-section-title')).textContent = title;
		append(heading, $('span.picode-pv-count')).textContent = String(count);
	}

	/** Placeholder tiles while pi is asked for its catalogue, so the page does not jump. */
	private paintSkeleton(list: HTMLElement): void {
		const grid = append(list, $('.picode-pv-grid'));
		for (let index = 0; index < 6; index += 1) {
			append(grid, $('.picode-pv-tile.skeleton'));
		}
	}

	private paintCatalogProblem(list: HTMLElement, problem: string): void {
		const box = append(list, $('.picode-pv-problem'));
		append(box, $(`span${ThemeIcon.asCSSSelector(Codicon.info)}`));
		const text = append(box, $('span'));
		if (problem === 'external') {
			text.textContent = localize('picodePv.external', "The external pi keeps its own sign-ins, and PiCode never writes to it. Switch to PiCode's own pi to connect providers here.");
			const setup = this.listStore.add(new Button(box, { ...defaultButtonStyles, secondary: true }));
			setup.label = localize('picodePv.setUp', "Set up PiCode");
			this.listStore.add(setup.onDidClick(() => void this.commandService.executeCommand('picode.setup')));
			return;
		}
		text.textContent = localize('picodePv.catalogFailed', "PiCode could not ask its pi which providers it can connect.");
		const retry = this.listStore.add(new Button(box, { ...defaultButtonStyles, secondary: true }));
		retry.label = localize('picodePv.retry', "Try again");
		this.listStore.add(retry.onDidClick(() => {
			this.catalog = undefined;
			this.paintProviderList();
			void this.loadCatalog();
		}));
	}

	/** One provider the chat can already use. */
	private paintConnectedCard(grid: HTMLElement, id: string, entry: ICatalogEntry | undefined, row: IProviderRow | undefined): void {
		const profile = this.profileProviders.find(candidate => candidate.id === id);
		const card = append(grid, $('.picode-pv-card.connected'));
		if (this.justConnected === id) {
			card.classList.add('fresh');
		}
		// Two rows: who it is on top, its state and what can be done with it below, so the name
		// never has to share its line with the buttons.
		const head = append(card, $('.picode-pv-card-head'));
		const mark = append(head, $('.picode-pv-mark'));
		mark.appendChild(createServiceLogo(id, row?.endpoint));

		const text = append(head, $('.picode-pv-text'));
		append(text, $('span.picode-pv-name')).textContent = entry?.name ?? displayNameOf(id);

		const subscription = entry?.connected === 'subscription' || profile?.subscription === true;
		const keyStored = !subscription && (profile?.credential === true || (row?.key !== undefined && row.key.length > 0) || entry?.connected === 'key');
		const how = subscription
			? (entry?.note ?? localize('picodePv.yourAccount', "Your account"))
			: row?.endpoint !== undefined
				? hostOf(row.endpoint)
				: keyStored
					? localize('picodePv.apiKey', "API key")
					: localize('picodePv.noKeyNeeded', "No key needed");
		append(text, $('span.picode-pv-sub')).textContent = how;

		const foot = append(card, $('.picode-pv-card-foot'));
		const status = append(foot, $('span.picode-pv-status'));
		status.classList.add(subscription ? 'account' : keyStored ? 'key' : 'local');
		append(status, $(`span${ThemeIcon.asCSSSelector(subscription ? Codicon.account : keyStored ? Codicon.key : Codicon.server)}`));
		append(status, $('span')).textContent = subscription
			? localize('picodePv.signedIn', "Signed in")
			: keyStored
				? localize('picodePv.keySaved', "Key saved")
				: localize('picodePv.ready', "Ready");

		const actions = append(foot, $('.picode-pv-actions'));
		const action = (icon: ThemeIcon, title: string, run: () => void, danger = false): void => {
			const button = append(actions, $('button.picode-pv-card-action')) as HTMLButtonElement;
			button.type = 'button';
			button.title = title;
			button.classList.toggle('danger', danger);
			append(button, $(`span${ThemeIcon.asCSSSelector(icon)}`));
			append(button, $('span.picode-pv-card-action-label')).textContent = title;
			this.listStore.add(addDisposableListener(button, 'click', run));
		};
		if (row !== undefined) {
			action(Codicon.edit, localize('picodePv.edit', "Edit"), () => this.openProviderForm(row));
			action(Codicon.trash, localize('picodePv.remove', "Remove"), () => this.setProviders(this.providers().filter(candidate => candidate.id !== id)), true);
			return;
		}
		if (entry !== undefined && subscription && entry.oauth) {
			action(Codicon.refresh, localize('picodePv.reconnect', "Sign in again"), () => void this.startAuth(id, 'oauth'));
		} else if (entry !== undefined && keyStored && entry.apiKey) {
			action(Codicon.key, localize('picodePv.changeKey', "Change key"), () => void this.startAuth(id, 'api_key'));
		}
		if (entry !== undefined && profile?.credential === true) {
			action(Codicon.signOut, subscription ? localize('picodePv.signOut', "Sign out") : localize('picodePv.removeKey', "Remove key"), () => void this.logout(id), true);
		}
	}

	/** One provider that can be connected, or the one being connected right now. */
	private paintTile(grid: HTMLElement, entry: ICatalogEntry, method: 'oauth' | 'api_key'): void {
		const state = this.authState;
		if (state !== undefined && state.providerId === entry.id && state.phase !== 'cancelled') {
			this.paintFlow(grid, entry, state);
			return;
		}
		const tile = append(grid, $('button.picode-pv-tile')) as HTMLButtonElement;
		tile.type = 'button';
		const mark = append(tile, $('.picode-pv-mark'));
		mark.appendChild(createServiceLogo(entry.id));
		const text = append(tile, $('.picode-pv-text'));
		append(text, $('span.picode-pv-name')).textContent = entry.name;
		append(text, $('span.picode-pv-sub')).textContent = method === 'oauth'
			? (entry.note ?? localize('picodePv.yourAccount', "Your account"))
			: localize('picodePv.apiKey', "API key");
		const go = append(tile, $('span.picode-pv-go'));
		go.textContent = method === 'oauth' ? localize('picodePv.signIn', "Sign in") : localize('picodePv.addKey', "Add key");
		tile.title = method === 'oauth'
			? localize('picodePv.signInTooltip', "Sign in to {0} in your browser", entry.name)
			: localize('picodePv.addKeyTooltip', "Paste your {0} API key", entry.name);
		this.listStore.add(addDisposableListener(tile, 'click', () => void this.startAuth(entry.id, method)));

		// A provider that takes both an account and a key offers the key too, without a second tile.
		if (method === 'oauth' && entry.apiKey) {
			const alt = append(tile, $('span.picode-pv-alt'));
			alt.textContent = localize('picodePv.orKey', "or use a key");
			alt.setAttribute('role', 'button');
			alt.tabIndex = 0;
			this.listStore.add(addDisposableListener(alt, 'click', event => {
				event.stopPropagation();
				void this.startAuth(entry.id, 'api_key');
			}));
		}
	}

	/** The open tile: where the sign-in stands, and the one thing the person can do next. */
	private paintFlow(grid: HTMLElement, entry: ICatalogEntry, state: IAuthRunState): void {
		const tile = append(grid, $('.picode-pv-tile.picode-pv-flow'));
		tile.classList.add(`phase-${state.phase}`);
		const head = append(tile, $('.picode-pv-flow-head'));
		const mark = append(head, $('.picode-pv-mark'));
		mark.appendChild(createServiceLogo(entry.id));
		const text = append(head, $('.picode-pv-text'));
		append(text, $('span.picode-pv-name')).textContent = entry.name;
		const line = append(text, $('span.picode-pv-sub'));

		const body = append(tile, $('.picode-pv-flow-body'));
		const buttons = append(tile, $('.picode-pv-flow-actions'));
		const button = (label: string, run: () => void, primary = false): Button => {
			const created = this.listStore.add(new Button(buttons, { ...defaultButtonStyles, secondary: !primary }));
			created.label = label;
			this.listStore.add(created.onDidClick(run));
			return created;
		};
		const cancel = () => button(localize('picodePv.cancel', "Cancel"), () => void this.cancelAuth());

		switch (state.phase) {
			case 'starting':
				append(head, $('span.picode-pv-spinner'));
				line.textContent = localize('picodePv.starting', "Getting ready...");
				cancel();
				return;
			case 'browser': {
				append(head, $('span.picode-pv-pulse'));
				line.textContent = localize('picodePv.waitingBrowser', "Waiting for your browser...");
				append(body, $('p.picode-pv-hint')).textContent = localize('picodePv.browserHint', "Sign in on the page that just opened. This finishes by itself when you are done.");
				if (state.canPaste) {
					this.paintPaste(body);
				}
				button(localize('picodePv.openAgain', "Open the page again"), () => void this.commandService.executeCommand('picode.providers.auth.reopen'));
				cancel();
				return;
			}
			case 'code': {
				append(head, $('span.picode-pv-pulse'));
				line.textContent = localize('picodePv.enterCode', "Enter this code on the page that opened");
				const code = append(body, $('button.picode-pv-code')) as HTMLButtonElement;
				code.type = 'button';
				code.title = localize('picodePv.copyCode', "Copy the code");
				append(code, $('span.picode-pv-code-text')).textContent = state.userCode ?? '';
				append(code, $(`span${ThemeIcon.asCSSSelector(Codicon.copy)}`));
				this.listStore.add(addDisposableListener(code, 'click', () => {
					void navigator.clipboard.writeText(state.userCode ?? '');
					code.classList.add('copied');
				}));
				append(body, $('p.picode-pv-hint')).textContent = localize('picodePv.codeCopied', "It is already copied: paste it there and confirm.");
				button(localize('picodePv.openAgain', "Open the page again"), () => void this.commandService.executeCommand('picode.providers.auth.reopen'));
				cancel();
				return;
			}
			case 'question': {
				const question = state.question;
				if (question === undefined) {
					cancel();
					return;
				}
				if (question.kind === 'select') {
					line.textContent = question.message;
					const options = append(body, $('.picode-pv-options'));
					for (const option of question.options ?? []) {
						const choice = append(options, $('button.picode-pv-option')) as HTMLButtonElement;
						choice.type = 'button';
						choice.textContent = option.label;
						this.listStore.add(addDisposableListener(choice, 'click', () => void this.answer(question.id, option.id)));
					}
					cancel();
					return;
				}
				const secret = question.kind === 'secret';
				line.textContent = secret
					? localize('picodePv.pasteKey', "Paste your API key")
					: question.message;
				const input = append(body, $('input.picode-pv-input')) as HTMLInputElement;
				input.type = secret ? 'password' : 'text';
				input.placeholder = question.placeholder ?? (secret ? localize('picodePv.keyPlaceholder', "Your key") : '');
				input.spellcheck = false;
				input.autocomplete = 'off';
				if (secret) {
					append(body, $('p.picode-pv-hint')).textContent = localize('picodePv.keyHint', "It is stored in PiCode's own profile and never shown again.");
				}
				const submit = () => {
					if (secret && input.value.trim().length === 0) {
						input.classList.add('invalid');
						return;
					}
					void this.answer(question.id, secret ? input.value.trim() : input.value);
				};
				this.listStore.add(addDisposableListener(input, 'keydown', event => {
					if (event.key === 'Enter') {
						submit();
					} else if (event.key === 'Escape') {
						void this.cancelAuth();
					}
				}));
				button(secret ? localize('picodePv.saveKey', "Save key") : localize('picodePv.continue', "Continue"), submit, true);
				cancel();
				return;
			}
			case 'done':
				append(head, $(`span.picode-pv-done${ThemeIcon.asCSSSelector(Codicon.passFilled)}`));
				line.textContent = localize('picodePv.connectedNow', "Connected. Its models are ready to use.");
				return;
			case 'failed':
				append(head, $(`span.picode-pv-failed${ThemeIcon.asCSSSelector(Codicon.error)}`));
				line.textContent = localize('picodePv.failed', "It could not be connected.");
				if (state.error !== undefined && state.error.length > 0) {
					append(body, $('p.picode-pv-error')).textContent = state.error;
				}
				button(localize('picodePv.retry', "Try again"), () => void this.startAuth(state.providerId, state.method), true);
				button(localize('picodePv.close', "Close"), () => {
					this.authState = undefined;
					this.paintProviderList();
				});
				return;
		}
	}

	/** The way out when the browser does not come back by itself. */
	private paintPaste(body: HTMLElement): void {
		const box = append(body, $('.picode-pv-paste'));
		append(box, $('span.picode-pv-hint')).textContent = localize('picodePv.pasteHint', "The browser did not come back? Paste the address it ended on:");
		const row = append(box, $('.picode-pv-paste-row'));
		const input = append(row, $('input.picode-pv-input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = 'http://localhost/...';
		input.spellcheck = false;
		const send = this.listStore.add(new Button(row, { ...defaultButtonStyles }));
		send.label = localize('picodePv.connect', "Connect");
		const submit = () => {
			if (input.value.trim().length > 0) {
				void this.answer('paste', input.value.trim());
			}
		};
		this.listStore.add(send.onDidClick(submit));
		this.listStore.add(addDisposableListener(input, 'keydown', event => {
			if (event.key === 'Enter') {
				submit();
			}
		}));
	}

	/** Starts a sign-in (or a key) for one provider, and follows it until it ends. */
	private async startAuth(providerId: string, method: 'oauth' | 'api_key'): Promise<void> {
		try {
			this.authState = await this.commandService.executeCommand<IAuthRunState>('picode.providers.auth.start', providerId, method)
				?? { run: -1, providerId, method, phase: 'failed', canPaste: false, canReopen: false };
		} catch (error) {
			this.authState = { run: -1, providerId, method, phase: 'failed', canPaste: false, canReopen: false, error: error instanceof Error ? error.message : String(error) };
		}
		this.justConnected = undefined;
		this.paintProviderList();
		this.followAuth();
	}

	/** Polls the connector while a sign-in runs; repaints only when something changed. */
	private followAuth(): void {
		this.authPoll.clear();
		const timer = setInterval(async () => {
			let next: IAuthRunState | undefined;
			try {
				next = await this.commandService.executeCommand<IAuthRunState>('picode.providers.auth.state');
			} catch {
				next = undefined;
			}
			const current = this.authState;
			if (current === undefined || next === undefined || next.run !== current.run) {
				this.authPoll.clear();
				return;
			}
			if (JSON.stringify(next) === JSON.stringify(current)) {
				return;
			}
			this.authState = next;
			if (next.phase === 'done' || next.phase === 'failed' || next.phase === 'cancelled') {
				this.authPoll.clear();
			}
			if (next.phase === 'cancelled') {
				this.authState = undefined;
			}
			this.paintProviderList();
			if (next.phase === 'done') {
				void this.afterConnected(next.providerId);
			}
		}, 400);
		this.authPoll.value = toDisposable(() => clearInterval(timer));
	}

	/** The tile shows its tick for a moment, then the provider moves up to Connected. */
	private async afterConnected(providerId: string): Promise<void> {
		await Promise.all([this.loadCatalog(), this.loadProfileProviders()]);
		setTimeout(() => {
			if (this.authState?.providerId === providerId && this.authState.phase === 'done') {
				this.authState = undefined;
				this.justConnected = providerId;
				this.paintProviderList();
			}
		}, 1400);
	}

	private async answer(questionId: number | 'paste', value: string): Promise<void> {
		await this.commandService.executeCommand('picode.providers.auth.answer', questionId, value);
	}

	private async cancelAuth(): Promise<void> {
		this.authPoll.clear();
		this.authState = undefined;
		this.paintProviderList();
		await this.commandService.executeCommand('picode.providers.auth.cancel');
	}

	private async logout(providerId: string): Promise<void> {
		try {
			await this.commandService.executeCommand('picode.providers.logout', providerId);
		} catch (error) {
			this.showPanelNote(localize('picodePv.logoutFailed', "It could not be disconnected: {0}", error instanceof Error ? error.message : String(error)));
		}
		await Promise.all([this.loadCatalog(), this.loadProfileProviders()]);
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

	/** Asks the connector for the agent profiles and Gentle's own preferences. */
	private async loadAgents(): Promise<void> {
		try {
			this.profilesView = await this.commandService.executeCommand<IAgentProfilesView>('picode.agentProfiles.state');
		} catch {
			this.profilesView = undefined;
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

	/** One edit to the profiles; the connector answers with the state after it, or why it refused. */
	private async editProfiles(edit: Record<string, unknown>, saved?: string): Promise<boolean> {
		let answer: IAgentProfilesView | { readonly error: string } | undefined;
		try {
			answer = await this.commandService.executeCommand<IAgentProfilesView | { readonly error: string }>('picode.agentProfiles.edit', edit);
		} catch (error) {
			answer = { error: error instanceof Error ? error.message : String(error) };
		}
		const ok = answer !== undefined && !('error' in answer);
		if (answer !== undefined && 'error' in answer) {
			this.agentNote = answer.error;
			this.agentNoteIsError = true;
		} else if (answer !== undefined) {
			this.profilesView = answer;
			this.agentNote = saved ?? '';
			this.agentNoteIsError = false;
		}
		if (this.tab === 'agents') {
			this.render();
		}
		return ok;
	}

	/** Uses a profile: by default (and in the chat in front), or only in the chat in front. */
	private async useProfile(name: string, mode: 'default' | 'session'): Promise<void> {
		try {
			this.profilesView = await this.commandService.executeCommand<IAgentProfilesView>('picode.agentProfiles.use', { name, mode });
			this.agentNote = mode === 'session' ? localize('picodePm.profileUsedHere', "This chat now uses {0}.", name) : '';
			this.agentNoteIsError = false;
		} catch {
			// The connector said why in a notification.
		}
		if (this.tab === 'agents') {
			this.render();
		}
	}

	/** Asks for a profile name, with Gentle's rule checked while it is typed. */
	private async askProfileName(title: string, value: string): Promise<string | undefined> {
		const taken = new Set(this.profilesView?.profiles.map(profile => profile.name));
		const name = await this.quickInputService.input({
			title,
			value,
			placeHolder: localize('picodePm.profileNamePlaceholder', "work"),
			validateInput: async text => {
				if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(text) || ['__proto__', 'constructor', 'prototype'].includes(text)) {
					return localize('picodePm.profileNameRule', "Use letters, numbers, dots, dashes or underscores, up to 64, starting with a letter or number.");
				}
				return taken.has(text) && text !== value ? localize('picodePm.profileNameTaken', "A profile called {0} already exists.", text) : undefined;
			},
		});
		return name === undefined || name === value ? undefined : name;
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

	/**
	 * The agent profiles: the list on the left, the open profile on the right (its way of working and
	 * one row per agent), Gentle's own preferences under them. Gentle's terminal `/gentle:profiles`
	 * screen, drawn the editor's way.
	 */
	private renderAgents(): void {
		const view = this.profilesView;
		if (view === undefined) {
			append(this.body, $('p.picode-pm-empty')).textContent = localize('picodePm.agentsReading', "Reading Gentle's agents...");
			return;
		}
		if (view.invalid) {
			append(this.body, $('p.picode-pm-empty')).textContent = localize('picodePm.profilesInvalid', "Your agent profiles could not be read. Fix or delete the file, then come back.");
			this.renderGentleBehaviour();
			return;
		}
		if (view.agents.length <= 1) {
			append(this.body, $('p.picode-pm-empty')).textContent = localize('picodePm.agentsNone', "The agents are not ready yet. Send a message in the chat once, then come back.");
			return;
		}
		const selected = view.profiles.find(profile => profile.name === this.selectedProfile)
			?? view.profiles.find(profile => profile.name === view.active)
			?? view.profiles[0];
		this.selectedProfile = selected?.name;

		const layout = append(this.body, $('.picode-ap'));
		this.renderProfileList(append(layout, $('.picode-ap-list')), view, selected);
		const detail = append(layout, $('.picode-ap-detail'));
		if (selected !== undefined) {
			this.renderProfile(detail, view, selected);
		}
		this.renderGentleBehaviour();
	}

	/** The profiles, each with the marks that say where it is in use. */
	private renderProfileList(list: HTMLElement, view: IAgentProfilesView, selected: IAgentProfile | undefined): void {
		const head = append(list, $('.picode-ap-list-head'));
		append(head, $('span.picode-ap-list-title')).textContent = localize('picodePm.profilesTitle', "Agent profiles");
		const add = append(head, $('button.picode-ap-icon-button' + ThemeIcon.asCSSSelector(Codicon.add)));
		add.setAttribute('type', 'button');
		add.title = localize('picodePm.newProfileFrom', "New profile, starting from {0}", selected?.name ?? '');
		add.setAttribute('aria-label', add.title);
		this.store.add(addDisposableListener(add, 'click', async () => {
			const name = await this.askProfileName(localize('picodePm.newProfile', "New agent profile"), '');
			if (name !== undefined && await this.editProfiles({ type: 'create', name, ...(selected === undefined ? {} : { from: selected.name }) })) {
				this.selectedProfile = name;
				this.render();
			}
		}));

		for (const profile of view.profiles) {
			const item = append(list, $('button.picode-ap-item'));
			item.setAttribute('type', 'button');
			item.classList.toggle('selected', profile.name === selected?.name);
			item.setAttribute('aria-pressed', profile.name === selected?.name ? 'true' : 'false');
			const title = append(item, $('.picode-ap-item-title'));
			append(title, $('span' + ThemeIcon.asCSSSelector(profile.mode === 'full-delegation' ? Codicon.organization : Codicon.robot)));
			append(title, $('span.picode-ap-item-name')).textContent = profile.name;
			const marks = append(item, $('.picode-ap-marks'));
			const mark = (text: string, kind: string, tooltip?: string) => {
				const element = append(marks, $(`span.picode-ap-mark.${kind}`));
				element.textContent = text;
				if (tooltip !== undefined) {
					element.title = tooltip;
				}
			};
			if (profile.name === view.active) {
				mark(localize('picodePm.markDefault', "Default"), 'default', localize('picodePm.markDefaultTip', "New chats start with this profile."));
			}
			if (view.resolved.source !== 'default' && view.resolved.name === profile.name) {
				mark(localize('picodePm.markProject', "This project"), 'project', localize('picodePm.markProjectTip', "Subagents in this project use this profile. The main agent follows the default."));
			}
			if (view.editorProfile === profile.name) {
				mark(localize('picodePm.markEditorProfile', "Editor profile"), 'editor', localize('picodePm.markEditorProfileTip', "Your current editor profile uses this profile."));
			}
			this.store.add(addDisposableListener(item, 'click', () => {
				this.selectedProfile = profile.name;
				this.agentNote = '';
				this.render();
			}));
		}
	}

	/** One profile: what it is used for, its actions, its way of working and a row per agent. */
	private renderProfile(detail: HTMLElement, view: IAgentProfilesView, profile: IAgentProfile): void {
		const head = append(detail, $('.picode-ap-head'));
		const name = append(head, $('h3.picode-ap-name'));
		append(name, $('span' + ThemeIcon.asCSSSelector(Codicon.robot)));
		append(name, $('span')).textContent = profile.name;
		const actions = append(head, $('.picode-ap-actions'));
		if (profile.name !== view.active) {
			const makeDefault = this.store.add(new Button(actions, { ...defaultButtonStyles }));
			makeDefault.label = localize('picodePm.makeDefault', "Make default");
			makeDefault.setTitle(localize('picodePm.makeDefaultTip', "New chats start with this profile, and this chat moves to it."));
			this.store.add(makeDefault.onDidClick(() => void this.useProfile(profile.name, 'default')));
		}
		if (view.live && !view.unsaved) {
			const here = this.store.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			here.label = localize('picodePm.useHere', "Use in this chat");
			here.setTitle(localize('picodePm.useHereTip', "Only the chat you used last changes. New chats keep the default."));
			this.store.add(here.onDidClick(() => void this.useProfile(profile.name, 'session')));
		}
		const more = append(actions, $('button.picode-ap-icon-button' + ThemeIcon.asCSSSelector(Codicon.ellipsis)));
		more.setAttribute('type', 'button');
		more.setAttribute('aria-label', localize('picodePm.profileMore', "More actions"));
		more.title = more.getAttribute('aria-label')!;
		this.store.add(addDisposableListener(more, 'click', () => this.showProfileMenu(more, view, profile)));

		if (view.unsaved) {
			append(detail, $('p.picode-pm-hint')).textContent = localize('picodePm.profilesUnsaved', "These are the models your agents use now. Change one, or add a profile, and they are saved as your first profile.");
		} else if (view.resolved.name !== undefined) {
			const where = view.resolved.source === 'local'
				? localize('picodePm.resolvedLocal', "New chats in this project use {0}, pinned on this computer.", view.resolved.name)
				: view.resolved.source === 'repo'
					? localize('picodePm.resolvedRepo', "New chats in this project use {0}, shared with the repository.", view.resolved.name)
					: localize('picodePm.resolvedDefault', "New chats use {0}, your default.", view.resolved.name);
			append(detail, $('p.picode-pm-hint')).textContent = where;
		}

		// The way of working: Gentle's two orchestrator modes.
		const modes = append(detail, $('.picode-ap-modes'));
		for (const [mode, label, tip] of [
			['organic', localize('picodePm.modeOrganic', "Organic"), localize('picodePm.modeOrganicTip', "The main agent can do small work itself and hands the rest to subagents.")],
			['full-delegation', localize('picodePm.modeDelegation', "Full delegation"), localize('picodePm.modeDelegationTip', "The main agent hands every piece of work to a subagent.")],
		] as const) {
			const chip = append(modes, $('button.picode-pm-chip'));
			chip.setAttribute('type', 'button');
			chip.textContent = label;
			chip.title = tip;
			chip.setAttribute('aria-pressed', profile.mode === mode ? 'true' : 'false');
			this.store.add(addDisposableListener(chip, 'click', () => {
				if (profile.mode !== mode) {
					void this.editProfiles({ type: 'mode', name: profile.name, mode }, this.savedNote(view, profile));
				}
			}));
		}

		if (this.agentNote.length > 0) {
			append(detail, $(this.agentNoteIsError ? 'p.picode-pm-error' : 'p.picode-pm-note')).textContent = this.agentNote;
		}

		// Every model the editor can reach, by provider; a model the profile names that is not in the list is kept.
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
			for (const [ref, { name: modelName, provider }] of catalogue) {
				byProvider.set(provider, [...(byProvider.get(provider) ?? []), [ref, modelName]]);
			}
			for (const provider of [...byProvider.keys()].sort((left, right) => left.localeCompare(right))) {
				const group = document.createElement('optgroup');
				group.label = provider;
				for (const [ref, modelName] of byProvider.get(provider)!.sort((left, right) => left[1].localeCompare(right[1]))) {
					group.append(new Option(modelName, ref));
				}
				select.append(group);
			}
			select.value = current;
			return select;
		};
		const thinkingSelect = (current: string): HTMLSelectElement => {
			const select = document.createElement('select');
			select.className = 'picode-pm-select picode-ap-thinking';
			select.setAttribute('aria-label', localize('picodePm.agentThinking', "How much it thinks"));
			select.append(new Option(localize('picodePm.agentThinkingDefault', "Default effort"), ''));
			for (const level of THINKING_LEVELS) {
				select.append(new Option(level, level));
			}
			select.value = current;
			return select;
		};

		const list = append(detail, $('.picode-pm-models'));
		for (const agent of view.agents) {
			const route = profile.routes[agent] ?? {};
			const line = append(list, $('.picode-pm-agent'));
			const label = append(line, $('.picode-pm-agent-name'));
			const main = agent === ORCHESTRATOR;
			append(label, $('span' + ThemeIcon.asCSSSelector(main ? Codicon.star : Codicon.hubot)));
			append(label, $('span')).textContent = main ? localize('picodePm.mainAgent', "Main agent") : agent;
			const model = modelSelect(route.model ?? '', main ? localize('picodePm.mainAgentModel', "The chat's model") : localize('picodePm.agentSame', "Same model as the rest"));
			model.setAttribute('aria-label', localize('picodePm.agentModelLabel', "Model for {0}", main ? localize('picodePm.mainAgent', "Main agent") : agent));
			const thinking = thinkingSelect(route.thinking ?? '');
			const fastLabel = $('label.picode-ap-fast');
			const fast = append(fastLabel, $<HTMLInputElement>('input'));
			fast.type = 'checkbox';
			fast.checked = route.tier === 'fast';
			append(fastLabel, $('span')).textContent = localize('picodePm.fast', "Fast");
			fastLabel.title = localize('picodePm.fastTip', "Fast mode, where the model offers it. It uses more of your plan.");
			line.append(model, thinking, fastLabel);
			const save = () => {
				void this.editProfiles({ type: 'route', name: profile.name, agent, model: model.value, thinking: thinking.value, ...(fast.checked ? { tier: 'fast' } : {}) }, this.savedNote(view, profile));
			};
			this.store.add(addDisposableListener(model, 'change', save));
			this.store.add(addDisposableListener(thinking, 'change', save));
			this.store.add(addDisposableListener(fast, 'change', save));
		}
		if (profile.fallbacks > 0) {
			append(detail, $('p.picode-pm-hint')).textContent = localize('picodePm.fallbacks', "Backup models in this profile: {0}. When a model runs out or fails, the agent moves to the next one.", profile.fallbacks);
		}
	}

	/** What a saved change says: the default reaches the chat at once, any other profile when it is used. */
	private savedNote(view: IAgentProfilesView, profile: IAgentProfile): string {
		return profile.name === view.active || view.unsaved
			? localize('picodePm.agentSaved', "Saved. The agents use it from your next message.")
			: localize('picodePm.profileSaved', "Saved in {0}.", profile.name);
	}

	/** Rename, duplicate, pin to the project, share with the repository, delete. */
	private showProfileMenu(anchor: HTMLElement, view: IAgentProfilesView, profile: IAgentProfile): void {
		const actions: IAction[] = [];
		const run = (id: string, label: string, enabled: boolean, handler: () => Promise<unknown>) => {
			actions.push(new Action(id, label, undefined, enabled, async () => { await handler(); }));
		};
		run('picode.profile.rename', localize('picodePm.rename', "Rename..."), !view.unsaved, async () => {
			const to = await this.askProfileName(localize('picodePm.renameTitle', "Rename {0}", profile.name), profile.name);
			if (to !== undefined && await this.editProfiles({ type: 'rename', name: profile.name, to })) {
				this.selectedProfile = to;
				this.render();
			}
		});
		run('picode.profile.duplicate', localize('picodePm.duplicate', "Duplicate..."), true, async () => {
			const name = await this.askProfileName(localize('picodePm.duplicateTitle', "Copy of {0}", profile.name), '');
			if (name !== undefined && await this.editProfiles({ type: 'create', name, from: profile.name })) {
				this.selectedProfile = name;
				this.render();
			}
		});
		if (view.pinnable && !view.unsaved) {
			actions.push(new Separator());
			const pinnedHere = view.pins.local === profile.name;
			run('picode.profile.pinLocal', pinnedHere ? localize('picodePm.unpinLocal', "Unpin from this project") : localize('picodePm.pinLocal', "Pin to this project"), true,
				() => this.editProfiles({ type: 'pin', source: 'local', ...(pinnedHere ? {} : { name: profile.name }) }, pinnedHere ? undefined : localize('picodePm.pinnedLocal', "Subagents in this project now use {0}, on this computer only.", profile.name)));
			const shared = view.pins.repo === profile.name;
			run('picode.profile.pinRepo', shared ? localize('picodePm.unpinRepo', "Stop sharing with the repository") : localize('picodePm.pinRepo', "Share with the repository"), true,
				() => this.editProfiles({ type: 'pin', source: 'repo', ...(shared ? {} : { name: profile.name }) }, shared ? undefined : localize('picodePm.pinnedRepo', "Saved in the repository: commit it so everyone's subagents use {0}.", profile.name)));
		}
		actions.push(new Separator());
		const pinned = view.pins.local === profile.name || view.pins.repo === profile.name;
		run('picode.profile.delete', profile.name === view.active
			? localize('picodePm.deleteDefault', "Delete (make another profile the default first)")
			: pinned ? localize('picodePm.deletePinned', "Delete (unpin it from this project first)") : localize('picodePm.delete', "Delete"),
			profile.name !== view.active && !pinned && !view.unsaved,
			async () => {
				const { confirmed } = await this.dialogService.confirm({
					message: localize('picodePm.deleteConfirm', "Delete the {0} profile?", profile.name),
					detail: localize('picodePm.deleteDetail', "The profile and its models are removed. Chats that use it keep it until they end."),
					primaryButton: localize('picodePm.deleteButton', "Delete"),
				});
				if (confirmed && await this.editProfiles({ type: 'delete', name: profile.name })) {
					this.selectedProfile = undefined;
					this.render();
				}
			});
		this.contextMenuService.showContextMenu({ getAnchor: () => anchor, getActions: () => actions });
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
