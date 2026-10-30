/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/picodeMcpSection.css';
import { $ } from '../../../../base/browser/dom.js';
import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { createServiceLogo, displayNameOf } from './picodeServiceLogo.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Action } from '../../../../base/common/actions.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { aiCustomizationManagementSectionRegistry, IAICustomizationManagementSectionContribution, IAICustomizationManagementSectionWidget } from '../../chat/browser/aiCustomization/aiCustomizationManagementSectionRegistry.js';
import { AICustomizationManagementSection } from '../../chat/common/aiCustomizationWorkspaceService.js';
import { PICODE_MCP_SERVERS_SETTING } from './picodeConfiguration.js';

/**
 * The MCP Servers section of the Agent Customizations page, as PiCode owns it.
 *
 * This is the one place pi's MCP servers are configured. The list reads the servers the
 * `picode.mcp.servers` store holds — name, where the server runs, its address or command —
 * and each row's state, which is not part of that store: pi holds it in its own profile. The
 * state comes from the same command the Status section reads (`picode.setup.status`), never
 * from the profile's files themselves — those belong to the connector, not to the core. It
 * tells three facts apart (`mcp-provider.ts`): `On` — pi will start it and can use it;
 * `Needs sign-in` — pi will start it but has no credential for it; `Off` — pi will not
 * start it. A state the connector could not read is shown as unknown, never as `On`.
 *
 * Every action hands over to the connector's existing commands, which are the form:
 * `picode.mcp.addServer`, `editServer`, `removeServer`, `toggleServer` and `signInServer`. No
 * form is written here, and a server's token is never shown.
 */

/** One server as the `picode.mcp.servers` store holds it. The token (`key`) is never shown. */
interface IMcpServerSettingRow {
	readonly name: string;
	readonly transport?: string;
	readonly target?: string;
	readonly args?: string;
}

/** One server's state, as the status command reports it. */
interface IMcpServerState {
	readonly on: boolean;
	/** Whether pi can use the server (`mcp-provider.ts`); left out when the row is off. */
	readonly signIn?: 'ok' | 'needed' | 'unknown';
	/** Where the server comes from (`status-view.ts`): left out for the profile's own rows. */
	readonly origin?: 'profile' | 'project' | 'discovered';
	/**
	 * `true` when the entry is this product's own — the memory engine — rather than a server the
	 * owner added. The section leaves those out: they are machinery, not choices.
	 */
	readonly internal?: boolean;
}

/** The slice of the status command's answer this widget reads. */
interface IStatusDataSlice {
	readonly mcpServers?: readonly (IMcpServerState & { readonly name: string })[];
}

const STATUS_DATA_COMMAND = 'picode.setup.status';

/** The management commands the connector registers; they are the form this page uses. */
const ADD_SERVER_COMMAND = 'picode.mcp.addServer';
const EDIT_SERVER_COMMAND = 'picode.mcp.editServer';
const REMOVE_SERVER_COMMAND = 'picode.mcp.removeServer';
const TOGGLE_SERVER_COMMAND = 'picode.mcp.toggleServer';
const SIGN_IN_SERVER_COMMAND = 'picode.mcp.signInServer';

/** One row of the table: the store's facts plus the state pi reports. */
interface IServerRow {
	readonly name: string;
	readonly transport?: string;
	readonly target?: string;
	readonly args?: string;
	/** `undefined` when pi's state could not be read; the row then shows no switch. */
	readonly on?: boolean;
	/** Whether pi can use the server; `needed` is the row that says "Needs sign-in". */
	readonly signIn?: 'ok' | 'needed' | 'unknown';
	/** A server pi runs that the store does not spell out (added through the connector). */
	readonly undeclared?: boolean;
	/** Where the server comes from; the actions write the profile, so only its rows get them. */
	readonly origin?: 'profile' | 'project' | 'discovered';
}

export class PicodeMcpServersWidget extends Disposable implements IAICustomizationManagementSectionWidget {

	private readonly root: HTMLElement;
	private readonly rowsContainer: HTMLElement;
	private readonly emptyContainer: HTMLElement;
	/** The buttons of the rows on screen; cleared and refilled on every render. */
	private readonly rowDisposables = this._register(new DisposableStore());
	/** Guards a slow status answer against a newer render. */
	private renderSequence = 0;
	/** Coalesces the refreshes `layout` asks for: a resize calls it many times in a row. */
	private layoutTimer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * What the last reading left on screen: the store's rows and pi's on/off state.
	 *
	 * Kept so a switch can repaint its row with what it just wrote instead of asking for the
	 * whole status again — that command reads git for the Project row, which is nothing this
	 * page draws and seconds this page waits.
	 */
	private declared: readonly IMcpServerSettingRow[] = [];
	private states = new Map<string, IMcpServerState>();

	get element(): HTMLElement {
		return this.root;
	}

	constructor(
		container: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super();

		this.root = DOM.append(container, $('.picode-mcp-section'));

		// A header, not a banner: the title says what the page is, the subtitle what a server is
		// allowed to do, and the one thing to do first sits on the right.
		const header = DOM.append(this.root, $('.picode-mcp-header'));
		const headerText = DOM.append(header, $('.picode-mcp-header-text'));
		const title = DOM.append(headerText, $('h2.picode-mcp-title'));
		title.textContent = localize('picodeMcpSectionTitle', "MCP Servers");
		const description = DOM.append(headerText, $('p.picode-mcp-subtitle'));
		description.textContent = localize('picodeMcpSectionDescription', "External tools and APIs that Pi can query. You will be prompted before any tool executes.");

		const addButton = this._register(new Button(header, { ...defaultButtonStyles, supportIcons: true }));
		addButton.label = `$(${Codicon.add.id}) ${localize('picodeMcpSectionAdd', "Add MCP Server")}`;
		addButton.setTitle(localize('picodeMcpSectionAddTooltip', "Connect an MCP server to pi"));
		this._register(addButton.onDidClick(() => { void this.runCommand(ADD_SERVER_COMMAND); }));

		this.emptyContainer = DOM.append(this.root, $('.picode-mcp-empty'));
		this.emptyContainer.textContent = localize('picodeMcpSectionEmpty', "No MCP servers configured. Click \"+ Add MCP Server\" to connect external capabilities.");

		this.rowsContainer = DOM.append(this.root, $('.picode-mcp-rows'));

		void this.refresh();
	}

	layout(_dimension: DOM.Dimension): void {
		// The layout call is the moment to catch up on servers the connector added or switched
		// since last time — but it also fires on every step of a resize, and each refresh asks
		// the status command, which reads git. Only the last answer matters, so they are one.
		if (this.layoutTimer !== undefined) {
			clearTimeout(this.layoutTimer);
		}
		this.layoutTimer = setTimeout(() => {
			this.layoutTimer = undefined;
			void this.refresh();
		}, 250);
	}

	override dispose(): void {
		if (this.layoutTimer !== undefined) {
			clearTimeout(this.layoutTimer);
			this.layoutTimer = undefined;
		}
		super.dispose();
	}

	private async refresh(): Promise<void> {
		const sequence = ++this.renderSequence;

		const stored = this.configurationService.getValue<readonly IMcpServerSettingRow[]>(PICODE_MCP_SERVERS_SETTING);
		const declared = Array.isArray(stored) ? stored : [];

		// The on/off state is pi's, not the store's: the same command the Status section
		// reads answers it. Without it the rows still list, but show no switch.
		const states = new Map<string, IMcpServerState>();
		try {
			const data = await this.commandService.executeCommand<IStatusDataSlice>(STATUS_DATA_COMMAND);
			for (const server of data?.mcpServers ?? []) {
				states.set(server.name, { on: server.on, signIn: server.signIn, origin: server.origin, ...(server.internal === true ? { internal: true } : {}) });
			}
		} catch {
			// The connector is not answering; the rows stay honest about not knowing.
		}

		if (sequence !== this.renderSequence) {
			return;
		}
		this.declared = declared;
		this.states = states;
		this.render(this.declared, this.states);
	}

	private render(declared: readonly IMcpServerSettingRow[], states: ReadonlyMap<string, IMcpServerState>): void {
		this.rowDisposables.clear();
		DOM.clearNode(this.rowsContainer);

		const rows: IServerRow[] = declared
			.filter(row => states.get(row.name)?.internal !== true)
			.map(row => ({
				name: row.name,
				transport: row.transport,
				target: row.target,
				args: row.args,
				on: states.get(row.name)?.on,
				signIn: states.get(row.name)?.signIn,
				origin: 'profile',
			}));
		for (const [name, state] of states) {
			if (!declared.some(row => row.name === name)) {
				// A server this product declares for itself is not the owner's to see or manage here.
				if (state.internal === true) {
					continue;
				}
				rows.push({ name, on: state.on, signIn: state.signIn, undeclared: true, origin: state.origin });
			}
		}

		this.emptyContainer.style.display = rows.length === 0 ? '' : 'none';
		for (const row of rows) {
			this.rowsContainer.appendChild(this.renderRow(row));
		}
	}

	/**
	 * One server, as a card.
	 *
	 * Left: what it is (a mark, its name in bold, and where it runs). Middle: its state as a
	 * badge. Right: **one** action — the sign-in when it needs one, otherwise the switch — and the
	 * rest behind a three-dot menu. The five buttons that sat here made every row a control panel,
	 * and the one thing the owner came to do was the hardest to find.
	 */
	private renderRow(row: IServerRow): HTMLElement {
		const card = $('.picode-mcp-card');
		card.classList.toggle('off', row.on === false);

		const main = DOM.append(card, $('.picode-mcp-card-main'));
		const mark = DOM.append(main, $('.picode-mcp-card-mark'));
		mark.appendChild(createServiceLogo(row.name));

		const text = DOM.append(main, $('.picode-mcp-card-text'));
		const name = DOM.append(text, $('.picode-mcp-card-name'));
		name.textContent = displayNameOf(row.name);

		const subtitleParts: string[] = [];
		if (row.origin === 'project') {
			subtitleParts.push(localize('picodeMcpSectionProject', "Project"));
		} else if (row.origin === 'discovered') {
			subtitleParts.push(localize('picodeMcpSectionDiscovered', "Discovered"));
		} else if (!row.undeclared && row.transport !== undefined) {
			subtitleParts.push(row.transport === 'http'
				? localize('picodeMcpSectionRemote', "Remote")
				: localize('picodeMcpSectionLocal', "Local"));
		}
		if (row.target !== undefined) {
			subtitleParts.push(row.args ? `${row.target} ${row.args}` : row.target);
		}
		const subtitle = DOM.append(text, $('.picode-mcp-card-sub'));
		subtitle.textContent = subtitleParts.join(' · ');
		subtitle.title = row.origin === 'project'
			? localize('picodeMcpSectionProjectTooltip', "Declared in this project's .pi/mcp.json. pi loads it for trusted projects; edit it in the project, not here.")
			: row.origin === 'discovered'
				? localize('picodeMcpSectionDiscoveredTooltip', "Connected into the live session by a pi extension or plugin. It has no entry here to edit or remove.")
				: subtitle.textContent;

		// The badge says one of three things, and nothing else.
		const badges = DOM.append(card, $('.picode-mcp-card-badges'));
		const badge = DOM.append(badges, $('.picode-mcp-badge'));
		if (row.on === undefined) {
			badge.classList.add('muted');
			badge.textContent = localize('picodeMcpSectionUnknown', "Unknown");
			badge.title = localize('picodeMcpSectionUnknownTooltip', "pi's state for this server could not be read.");
		} else if (!row.on) {
			badge.classList.add('muted');
			badge.textContent = localize('picodeMcpSectionBadgeDisabled', "Disabled");
		} else if (row.signIn === 'needed') {
			badge.classList.add('warn');
			badge.textContent = localize('picodeMcpSectionBadgeSignIn', "Needs Sign-In");
			badge.title = localize('picodeMcpSectionNeedsSignInTooltip', "pi has no sign-in stored for this server, so pi cannot use it. Use Sign in: a browser window opens, and the credential is stored in PiCode's own profile.");
		} else if (row.signIn === 'unknown') {
			badge.classList.add('muted');
			badge.textContent = localize('picodeMcpSectionBadgeUnknownSignIn', "Active · sign-in unknown");
			badge.title = localize('picodeMcpSectionSignInUnknownTooltip', "Whether pi can sign in to this server could not be read, so the row does not claim either way.");
		} else {
			badge.classList.add('ok');
			badge.textContent = localize('picodeMcpSectionBadgeActive', "Active");
		}

		// A row the profile does not own has nothing here to act on: the project's file is edited
		// in the project, and a discovered server has no entry anywhere.
		if (row.origin === 'project' || row.origin === 'discovered') {
			return card;
		}

		const actions = DOM.append(card, $('.picode-mcp-card-actions'));
		const disposables = this.rowDisposables;

		// One primary action per card: fix the sign-in if that is what is missing, otherwise the
		// switch. Everything else is behind the menu.
		if (row.on !== false && row.signIn === 'needed') {
			const signInButton = disposables.add(new Button(actions, defaultButtonStyles));
			signInButton.label = localize('picodeMcpSectionSignIn', "Sign in");
			signInButton.setTitle(localize('picodeMcpSectionSignInTooltip', "Start pi's sign-in for this server: a browser window opens, and the credential is stored in PiCode's own profile."));
			disposables.add(signInButton.onDidClick(() => { void this.runCommand(SIGN_IN_SERVER_COMMAND, row.name); }));
		} else if (row.on !== undefined) {
			const toggle = DOM.append(actions, $('label.picode-mcp-switch'));
			toggle.title = row.on
				? localize('picodeMcpSectionDisableTooltip', "pi stops starting this server. It stays in the list.")
				: localize('picodeMcpSectionEnableTooltip', "pi starts this server again.");
			const input = DOM.append(toggle, $('input')) as HTMLInputElement;
			input.type = 'checkbox';
			input.checked = row.on;
			disposables.add(DOM.addDisposableListener(input, 'change', () => { void this.runCommand(TOGGLE_SERVER_COMMAND, row.name); }));
			DOM.append(toggle, $('span.picode-mcp-switch-track'));
		}

		const menu = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		menu.label = `$(${Codicon.kebabVertical.id})`;
		menu.setTitle(localize('picodeMcpSectionMore', "More actions"));
		disposables.add(menu.onDidClick(() => {
			const rect = menu.element.getBoundingClientRect();
			this.contextMenuService.showContextMenu({
				getAnchor: () => ({ x: rect.left, y: rect.bottom }),
				getActions: () => {
					const entries: Action[] = [
						new Action('picode.mcp.edit', localize('picodeMcpSectionEdit', "Edit configuration"), undefined, true, () => this.runCommand(EDIT_SERVER_COMMAND, row.name)),
					];
					if (row.on !== undefined) {
						entries.push(new Action(
							'picode.mcp.toggle',
							row.on ? localize('picodeMcpSectionDisable', "Disable server") : localize('picodeMcpSectionEnable', "Enable server"),
							undefined, true,
							() => this.runCommand(TOGGLE_SERVER_COMMAND, row.name),
						));
					}
					entries.push(new Action('picode.mcp.remove', localize('picodeMcpSectionRemove', "Remove server"), undefined, true, () => this.runCommand(REMOVE_SERVER_COMMAND, row.name)));
					return entries;
				},
			});
		}));

		return card;
	}

	/** Runs one of the connector's commands — the form — and repaints what it changed. */
	private async runCommand(command: string, name?: string): Promise<void> {
		let switched: { name: string; on: boolean } | undefined;
		try {
			const answer: unknown = await this.commandService.executeCommand(command, name);
			if (command === TOGGLE_SERVER_COMMAND && isServerSwitch(answer)) {
				switched = answer;
			}
		} catch {
			// The connector already reports its own failures; here they would only be the
			// command being absent, which has nothing this page can say better.
		}
		// The switch answers with the state it just wrote, so the row moves now. Going through
		// `refresh` instead would ask for the whole status — git for the Project row — before
		// anything on this page changed.
		if (switched !== undefined) {
			// A flip changes only the switch; the sign-in fact stays what the last reading said.
			this.states.set(switched.name, { on: switched.on, signIn: this.states.get(switched.name)?.signIn });
			this.render(this.declared, this.states);
			return;
		}
		await this.refresh();
	}
}

function isServerSwitch(value: unknown): value is { name: string; on: boolean } {
	return typeof value === 'object' && value !== null
		&& typeof (value as { name?: unknown }).name === 'string'
		&& typeof (value as { on?: unknown }).on === 'boolean';
}

const contribution: IAICustomizationManagementSectionContribution = {
	id: AICustomizationManagementSection.McpServers,
	label: localize('picodeMcpSectionLabel', "MCP Servers"),
	icon: Codicon.server,
	description: localize('picodeMcpSectionNavigationDescription', "The MCP servers pi uses. You are asked before one of their tools runs."),
	supportsHarness: () => true,
	create: (instantiationService, container) => instantiationService.createInstance(PicodeMcpServersWidget, container),
};
aiCustomizationManagementSectionRegistry.register(contribution);
