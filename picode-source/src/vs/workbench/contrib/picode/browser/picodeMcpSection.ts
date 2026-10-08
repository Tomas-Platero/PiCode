/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/picodeMcpSection.css';
import { $ } from '../../../../base/browser/dom.js';
import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../base/common/codicons.js';
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
 * state comes from the same command the status panel reads (`picode.setup.status`), never
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

/** One server's state, as the status panel's data reports it. */
interface IMcpServerState {
	readonly on: boolean;
	/** Whether pi can use the server (`mcp-provider.ts`); left out when the row is off. */
	readonly signIn?: 'ok' | 'needed' | 'unknown';
	/** Where the server comes from (`status-view.ts`): left out for the profile's own rows. */
	readonly origin?: 'profile' | 'project' | 'discovered';
}

/** The slice of the status panel's answer this widget reads. */
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
	) {
		super();

		this.root = DOM.append(container, $('.picode-mcp-section'));

		const description = DOM.append(this.root, $('.picode-mcp-section-description'));
		description.textContent = localize('picodeMcpSectionDescription', "The MCP servers pi uses. You are asked before one of their tools runs.");

		const toolbar = DOM.append(this.root, $('.picode-mcp-section-toolbar'));
		const addButton = this._register(new Button(toolbar, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		addButton.label = `$(${Codicon.add.id}) ${localize('picodeMcpSectionAdd', "Add server")}`;
		addButton.setTitle(localize('picodeMcpSectionAddTooltip', "Add an MCP server for pi"));
		this._register(addButton.onDidClick(() => { void this.runCommand(ADD_SERVER_COMMAND); }));

		const tableHeader = DOM.append(this.root, $('.picode-mcp-table-header'));
		for (const label of [
			localize('picodeMcpSectionColumnName', "Name"),
			localize('picodeMcpSectionColumnRuns', "Runs"),
			localize('picodeMcpSectionColumnTarget', "Address or command"),
			localize('picodeMcpSectionColumnState', "State"),
			localize('picodeMcpSectionColumnActions', "Actions"),
		]) {
			DOM.append(tableHeader, $('.picode-mcp-table-column')).textContent = label;
		}

		this.rowsContainer = DOM.append(this.root, $('.picode-mcp-rows'));
		this.emptyContainer = DOM.append(this.root, $('.picode-mcp-empty-state'));
		this.emptyContainer.textContent = localize('picodeMcpSectionEmpty', "No MCP servers yet. Add one to give pi more tools.");

		// The store changed somewhere else (an import, the setup wizard): repaint.
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PICODE_MCP_SERVERS_SETTING)) {
				void this.refresh();
			}
		}));

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

		// The on/off state is pi's, not the store's: the same command the status panel
		// reads answers it. Without it the rows still list, but show no switch.
		const states = new Map<string, IMcpServerState>();
		try {
			const data = await this.commandService.executeCommand<IStatusDataSlice>(STATUS_DATA_COMMAND);
			for (const server of data?.mcpServers ?? []) {
				states.set(server.name, { on: server.on, signIn: server.signIn, origin: server.origin });
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

		const rows: IServerRow[] = declared.map(row => ({
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
				rows.push({ name, on: state.on, signIn: state.signIn, undeclared: true, origin: state.origin });
			}
		}

		this.emptyContainer.style.display = rows.length === 0 ? '' : 'none';
		for (const row of rows) {
			this.rowsContainer.appendChild(this.renderRow(row));
		}
	}

	private renderRow(row: IServerRow): HTMLElement {
		const rowElement = $('.picode-mcp-row');
		rowElement.classList.toggle('off', row.on === false);

		const name = DOM.append(rowElement, $('.picode-mcp-cell-name'));
		name.textContent = row.name;

		const runs = DOM.append(rowElement, $('.picode-mcp-cell-runs'));
		if (row.origin === 'project') {
			runs.textContent = localize('picodeMcpSectionProject', "Project");
			runs.title = localize('picodeMcpSectionProjectTooltip',
				"Declared in this project's .pi/mcp.json. pi loads it for trusted projects; edit it in the project, not here.");
		} else if (row.origin === 'discovered') {
			runs.textContent = localize('picodeMcpSectionDiscovered', "Discovered");
			runs.title = localize('picodeMcpSectionDiscoveredTooltip',
				"Connected into the live session by a pi extension or plugin. It has no entry here to edit or remove.");
		} else if (row.undeclared || row.transport === undefined) {
			runs.textContent = '';
		} else {
			runs.textContent = row.transport === 'http'
				? localize('picodeMcpSectionRemote', "Remote")
				: localize('picodeMcpSectionLocal', "Local");
		}

		const target = DOM.append(rowElement, $('.picode-mcp-cell-target'));
		target.textContent = row.target === undefined ? '' : row.args ? `${row.target} ${row.args}` : row.target;
		target.title = target.textContent ?? '';

		const state = DOM.append(rowElement, $('.picode-mcp-cell-state'));
		state.classList.toggle('disabled', row.on === false);
		if (row.on === undefined) {
			state.textContent = '';
		} else if (!row.on) {
			state.textContent = localize('picodeMcpSectionOff', "Off");
		} else if (row.signIn === 'needed') {
			// The truth the page used to hide behind an `On`: the entry is enabled, but pi has
			// no credential for it, so it cannot be used. The fix is this page's own Sign in
			// button, which starts pi's own sign-in pointed at PiCode's profile.
			state.textContent = localize('picodeMcpSectionNeedsSignIn', "Needs sign-in");
			state.title = localize('picodeMcpSectionNeedsSignInTooltip',
				"pi has no sign-in stored for this server, so pi cannot use it. Use Sign in below: a browser window opens, and the credential is stored in PiCode's own profile.");
		} else if (row.signIn === 'unknown') {
			state.textContent = localize('picodeMcpSectionSignInUnknown', "On · sign-in unknown");
			state.title = localize('picodeMcpSectionSignInUnknownTooltip',
				"Whether pi can sign in to this server could not be read, so the row does not claim either way.");
		} else {
			state.textContent = localize('picodeMcpSectionOn', "On");
		}

		const actions = DOM.append(rowElement, $('.picode-mcp-row-actions'));
		const disposables = this.rowDisposables;

		// A row the profile does not own has nothing here to act on: the project's file is
		// edited in the project, and a discovered server has no entry anywhere — offering Edit
		// or Remove would write a **new** profile entry instead of touching what the row shows.
		if (row.origin === 'project' || row.origin === 'discovered') {
			return rowElement;
		}

		// The sign-in is the first action of a row that needs one, because fixing the server is
		// what the owner came here to do. It runs pi's own sign-in pointed at PiCode's profile,
		// so the credential lands where pi reads it — and stays there across restarts.
		if (row.on !== false && row.signIn === 'needed') {
			const signInButton = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			signInButton.label = localize('picodeMcpSectionSignIn', "Sign in");
			signInButton.setTitle(localize('picodeMcpSectionSignInTooltip',
				"Start pi's sign-in for this server: a browser window opens, and the credential is stored in PiCode's own profile."));
			disposables.add(signInButton.onDidClick(() => { void this.runCommand(SIGN_IN_SERVER_COMMAND, row.name); }));
		}

		const editButton = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		editButton.label = localize('picodeMcpSectionEdit', "Edit");
		editButton.setTitle(localize('picodeMcpSectionEditTooltip', "Change what this server says"));
		disposables.add(editButton.onDidClick(() => { void this.runCommand(EDIT_SERVER_COMMAND, row.name); }));

		const toggleLabel = row.on === false
			? localize('picodeMcpSectionEnable', "Enable")
			: localize('picodeMcpSectionDisable', "Disable");
		if (row.on !== undefined) {
			const toggleButton = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			toggleButton.label = toggleLabel;
			toggleButton.setTitle(row.on
				? localize('picodeMcpSectionDisableTooltip', "pi stops starting this server. It stays in the list.")
				: localize('picodeMcpSectionEnableTooltip', "pi starts this server again."));
			disposables.add(toggleButton.onDidClick(() => { void this.runCommand(TOGGLE_SERVER_COMMAND, row.name); }));
		}

		const removeButton = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		removeButton.label = localize('picodeMcpSectionRemove', "Remove");
		removeButton.setTitle(localize('picodeMcpSectionRemoveTooltip', "Remove this server from pi"));
		disposables.add(removeButton.onDidClick(() => { void this.runCommand(REMOVE_SERVER_COMMAND, row.name); }));

		return rowElement;
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
