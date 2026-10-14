/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { DurableStatus } from './durable';
import type { PiProviderRow } from './providers-list';
import { THINKING_TOGGLE_COMMAND } from './piConfig';
import type { UpdatesSnapshot } from './updates-check';

/**
 * Where one provider came from, in the owner's words — and it is the whole answer to "why is this one
 * not editable where the other is": the settings page edits declarations, and a provider that pi
 * itself carries (models, a sign-in) has no declaration to edit.
 */
function providerOrigin(row: PiProviderRow): string {
	const parts: string[] = [];
	if (row.declared) {
		parts.push('declared');
	}
	if (row.models) {
		parts.push('models in pi');
	}
	if (row.credential) {
		parts.push('signed in');
	}
	return parts.length === 0 ? 'in pi' : parts.join(' · ');
}

/**
 * The PiCode status view: a native tree in the activity bar's PiCode container — the pi
 * in force, the provider and default model, the session's usage and cost, the durable
 * agent's state, and the project's branch and pending changes.
 *
 * A tree, deliberately, and not a webview: the data is a handful of rows, the theme is
 * the editor's own, and a native view cannot fail to render. The rows refresh on a slow
 * timer; errors surface as rows instead of empty panels.
 *
 * The Durable section is read from the agent's daemon over its local pipe, with a bounded
 * connect: it says "not running" rather than waiting, because a panel that hangs when a
 * process is absent is worse than one that says so.
 */

export const STATUS_DATA_COMMAND = 'picode.setup.status';

/** How often the rows are re-read while the panel is on screen. */
const STATUS_REFRESH_MS = 5000;

/**
 * The panel's own traffic light, in the editor's theme colours — every one of them present in the
 * theme registry, so none renders as nothing:
 *
 *  - `charts.green`       something the owner holds (a server pi can use, the daemon answering)
 *  - `charts.yellow`      something that wants the owner (a sign-in pi has no credential for)
 *  - `charts.red`         something that is down (the daemon not answering)
 *  - `charts.blue`        something that is simply news (an update waiting)
 *  - `disabledForeground` something switched off on purpose, which is not a problem
 *
 * The panel used to be one grey throughout: a row that worked read exactly like a row whose sign-in
 * was missing, so the three rows that wanted attention were the three the eye skipped.
 */
const STATE_OK = 'charts.green';
const STATE_ATTENTION = 'charts.yellow';
const STATE_DOWN = 'charts.red';
const STATE_INFO = 'charts.blue';
const STATE_MUTED = 'disabledForeground';

/** A codicon and the colour its state deserves; leave the colour out for a row that is merely a fact. */
function stateIcon(id: string, color?: string): vscode.ThemeIcon {
	return new vscode.ThemeIcon(id, color === undefined ? undefined : new vscode.ThemeColor(color));
}

/**
 * One allowance window of the model's subscription, as the provider reported it.
 */
export interface SubscriptionWindowRow {
	/** The window in words: `4-hour window`, `weekly window`, or `billing period`. */
	readonly label: string;
	readonly usedPercent: number;
	/** When the window resets, in epoch ms; `null` when the provider did not say. */
	readonly resetAt: number | null;
}

/**
 * The subscription meter of the model in force.
 *
 * Only what the provider itself answered: a window the payload did not carry is not here, and
 * neither is a model the meter does not name.
 */
export interface SubscriptionStatus {
	/** The meter's own id, which names the model it meters. */
	readonly meter: string;
	/** The windows, tightest first — the one that runs out first leads. */
	readonly windows: readonly SubscriptionWindowRow[];
	readonly limitReached: boolean;
	/** `false` when the snapshot outlived its endpoint: the newest one held, not a live read. */
	readonly fresh: boolean;
}

/**
 * One background job the chat itself launched (`background-jobs.ts`, the same rows the pill above
 * the chat input reads), from its start until its completion message closes it.
 */
export interface BackgroundJobStatus {
	readonly jobNumber: string;
	readonly label?: string;
	readonly command?: string;
	readonly startedAt: number;
}

/**
 * One of pi's MCP servers, as the panel lists it: the name, whether pi will start it, and
 * whether pi can actually use it (`mcp-provider.ts` computes the sign-in fact).
 */
export interface McpServerSwitch {
	readonly name: string;
	readonly on: boolean;
	/**
	 * `ok` — pi can use it; `needed` — enabled but pi has no sign-in for it; `unknown` — the
	 * answer cannot be had (the profile's sign-ins are off-limits). Left out when `off`.
	 */
	readonly signIn?: 'ok' | 'needed' | 'unknown';
	/**
	 * Where this row comes from: `profile` — the profile's own `mcp.json` (the list the
	 * settings form edits); `project` — the workspace's `.pi/mcp.json`, which pi loads for
	 * trusted projects; `discovered` — a server a pi extension or plugin connected into the
	 * live session, which has no entry anywhere the form can edit. Left out for the profile
	 * rows the reading has always answered.
	 */
	readonly origin?: 'profile' | 'project' | 'discovered';
}

/**
 * Fired the instant the MCP switch is flipped, so the row repaints there and then.
 *
 * The panel's rows are rebuilt from the whole status reading, and that reading pays for a `git` call
 * per folder. Waiting for it — or for the five-second tick that would start it — is what left the
 * icon on the old state after a click. The switch already knows what it just wrote, so it says it
 * here; the next full reading still wins, this only moves the row now instead of in seconds.
 */
export const onDidToggleMcpServer = new vscode.EventEmitter<McpServerSwitch>();

/**
 * The count the MCP row shows: how many servers there are, and what is wrong with the ones
 * pi cannot use right now.
 *
 * The switch is pi's own `enabled`, read from the profile's file — no connection and no side effect,
 * which is why the panel can say it on every refresh and the MCP page cannot. The sign-in fact comes
 * with it (`mcp-provider.ts`), so a server that is enabled but unusable is counted here instead of
 * hiding behind an `On`.
 */
function mcpCountDescription(servers: readonly McpServerSwitch[]): string {
	const off = servers.filter(server => !server.on).length;
	const needsSignIn = servers.filter(server => server.on && server.signIn === 'needed').length;
	const parts: string[] = [];
	if (off > 0) {
		parts.push(`${off} off`);
	}
	if (needsSignIn > 0) {
		parts.push(`${needsSignIn} need${needsSignIn === 1 ? 's' : ''} sign-in`);
	}
	return parts.length === 0 ? String(servers.length) : `${servers.length} · ${parts.join(' · ')}`;
}

/**
 * The line one server's row shows, the codicon beside it, and the colour that icon takes.
 *
 * A server pi can use gets no description at all: the filled dot already says "on", and saying it
 * twice made the row that was wrong ("needs sign-in") no more visible than the rows that were not.
 */
function mcpRowDescription(server: McpServerSwitch): { description?: string; icon: string; color?: string } {
	if (!server.on) {
		return { description: 'off', icon: 'circle-slash', color: STATE_MUTED };
	}
	if (server.signIn === 'needed') {
		return { description: 'needs sign-in', icon: 'warning', color: STATE_ATTENTION };
	}
	if (server.signIn === 'unknown') {
		return { description: 'sign-in unknown', icon: 'circle-outline', color: STATE_ATTENTION };
	}
	return { icon: 'circle-filled', color: STATE_OK };
}

/**
 * The children of the MCP row: one per server, and the row itself is the action.
 *
 * A server pi can use is its switch: the click runs `picode.mcp.toggleServer`, which flips pi's
 * `enabled` key in the file that holds the entry. A server that **needs sign-in** is not: its
 * click runs `picode.mcp.signInServer` instead, which starts pi's own `mcp login` pointed at
 * PiCode's profile — the click that fixes the server must not be the click that switches it
 * off. Switching it off stays reachable through the MCP page's Disable button (`extension.ts`
 * keeps `picode.mcp.toggleServer` for it). There are no children at all when there is nothing
 * to list, so the row does not offer an arrow that opens onto nothing.
 */
function mcpServerRows(servers: readonly McpServerSwitch[]): { children?: StatusItem[] } {
	if (servers.length === 0) {
		return {};
	}
	return {
		children: servers.map(server => {
			const row = mcpRowDescription(server);
			const needsSignIn = server.on && server.signIn === 'needed';
			return new StatusItem(server.name, {
				description: row.description,
				icon: stateIcon(row.icon, row.color),
				// The one thing a sign-in row must say first: that the click is the fix, and where
				// the credential it produces lands.
				tooltip: needsSignIn
					? 'pi has no sign-in stored for this server, so pi cannot use it. Click to sign in: a browser window opens, and the credential is stored in PiCode\'s own profile.'
					: undefined,
				command: {
					command: needsSignIn ? 'picode.mcp.signInServer' : 'picode.mcp.toggleServer',
					title: needsSignIn ? 'Sign in' : server.on ? 'Turn off' : 'Turn on',
					arguments: [server.name],
				},
			});
		}),
	};
}

/**
 * One folder of the workspace area, as the Project row lists it in workspace mode.
 *
 * The name is the folder's own name, never its full path: the panel says what the
 * folder is, not where it lives.
 */
export interface ProjectGitInfo {
	readonly name: string;
	branch?: string;
	changes?: number;
	insertions?: number;
	deletions?: number;
}

export interface StatusData {
	runtime?: string;
	piVersion?: string;
	/**
	 * Every provider the host has, each with where the editor learned of it. A list and not a count:
	 * the count disagreed with the settings page (which edits only the **declarations**) and the owner
	 * read that as a missing provider.
	 */
	providers?: readonly PiProviderRow[];
	defaultModel?: string;
	model?: string;
	thinkingLevel?: string;
	/** Whether the agent's thinking is written into the chat (`picode.pi.reasoning`). */
	reasoning?: 'shown' | 'hidden';
	/** pi's MCP servers, with the switch pi reads: the panel shows them and can flip them. */
	mcpServers?: readonly McpServerSwitch[];
	gitBranch?: string;
	gitChanges?: number;
	gitInsertions?: number;
	gitDeletions?: number;
	/**
	 * The workspace area, one entry per folder — present only when the project mode in
	 * force is `workspace`, and the Project row then lists one line per folder. Absent
	 * in folder mode, where the single fields above are the whole answer.
	 */
	projects?: readonly ProjectGitInfo[];
	ctxTokens?: number;
	ctxWindow?: number;
	cost?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	/**
	 * The provider's own subscription quota for the model in use (`usage-data.ts`), not the
	 * session's totals above: the TUI's `usage` bar is live provider data. Absent when the
	 * connector cannot obtain an honest one.
	 */
	usage?: string;
	/** The durable daemon as it answered right now (`durable.ts`): up or down, and what it holds. */
	durable?: DurableStatus;
	/**
	 * The agents launched from the open projects (`agents.ts`, read off the transcripts): how
	 * many, and how many still owe an answer. `undefined` when the listing could not be read —
	 * the row is then absent, because a `0` would read as "nothing was ever launched".
	 */
	agents?: { readonly total: number; readonly working: number };
	/**
	 * The subscription meter of the model in force, as the provider reported it
	 * (`usage-data.ts` reads it; NaN's quota is the route that exists). `undefined` when the
	 * model has no meter the editor can read — the section then hides itself
	 * ({@link STATUS_SUBSCRIPTION_CONTEXT}) rather than standing empty or inventing a window.
	 */
	subscription?: SubscriptionStatus;
	/**
	 * The chat's background jobs still running (`background-jobs.ts`), the same answer the pill
	 * above the chat input reads. Each leaves when its completion message closes it, so a job
	 * that failed or finished is not listed: the Tasks block is work still out, and a finished
	 * job's report is already in the chat.
	 */
	jobs?: readonly BackgroundJobStatus[];
	/**
	 * The last update check's stored answer (`updates-check.ts`), and nothing at all when it has never
	 * run. Never a fresh lookup: this reading happens every five seconds, and asking npm about a dozen
	 * packages that often would be its own kind of wrong — the block offers a check to run instead.
	 */
	updates?: UpdatesSnapshot;
	error?: string;
}

/**
 * One folder's git facts, as its Project row describes them: the branch it is on, and
 * the pending changes with their line totals. The wording matches the single-folder
 * row's, so both modes read the same.
 */
function projectDescription(project: ProjectGitInfo): string {
	const branch = project.branch || '—';
	const changes = project.changes === undefined
		? '—'
		: project.insertions !== undefined && project.deletions !== undefined
			? `${project.changes} files · +${project.insertions.toLocaleString()} −${project.deletions.toLocaleString()}`
			: String(project.changes);
	return `${branch} · ${changes}`;
}

/**
 * One block of the panel.
 *
 * Each block is a **view of its own** in the PiCode container, which is what gives the panel the
 * shape the owner pointed at — the editor's own Extensions page, where INSTALLED and RECOMMENDED are
 * separate blocks: a native header per block, its fold arrow, and a counter on the right. It is also
 * why a block's header carries no emoji — the editor draws that header, it is not ours to paint.
 */
export type StatusSection = 'host' | 'subscription' | 'updates' | 'providers' | 'mcp' | 'session' | 'project' | 'tasks';

/** The views, in the order they stack. The ids are the manifest's, and the two must not drift. */
export const STATUS_SECTIONS: readonly { readonly id: string; readonly section: StatusSection }[] = [
	{ id: 'picode.status.host', section: 'host' },
	// The Model Subscription block reads the meter of the model in force and hides itself when the
	// model has none — a declared endpoint or a pay-per-call key has no window to show.
	{ id: 'picode.status.subscription', section: 'subscription' },
	{ id: 'picode.status.updates', section: 'updates' },
	{ id: 'picode.status.providers', section: 'providers' },
	{ id: 'picode.status.mcp', section: 'mcp' },
	{ id: 'picode.status.session', section: 'session' },
	{ id: 'picode.status.project', section: 'project' },
	// The Tasks block reads no data of its own — its rows are the durable daemon's task-owned
	// conversations — and it is the last view of the stack, declared with a `when` in the manifest so
	// it exists only while there is something to list (see {@link STATUS_TASKS_CONTEXT}).
	{ id: 'picode.status.tasks', section: 'tasks' },
];

/** The action a block's header offers: the way into the providers' settings page. */
export const STATUS_PROVIDER_SETTINGS_COMMAND = 'picode.status.openProviderSettings';

/**
 * The two things the Updates block can do: run the update, or ask the registry again.
 *
 * Both are registered by `extension.ts` and both are the code the notification already runs — the
 * panel opens no second path to the same work, it only adds a place to reach the first one from.
 */
export const UPDATES_APPLY_COMMAND = 'picode.updates.apply';
export const UPDATES_CHECK_COMMAND = 'picode.updates.check';

/**
 * The context key the Tasks block hangs its visibility on.
 *
 * The block is declared with a `when` of this key in the manifest, and the store writes it after
 * every reading: the block exists only while the durable daemon reports at least one conversation
 * owned by a task — the shape a chat's "several things to do" takes. A section that stood empty
 * for most of a session would be one more folded thing to skip past; appearing is part of what it
 * has to say.
 */
export const STATUS_TASKS_CONTEXT = 'picode.status.tasksVisible';

/**
 * The context key the Model Subscription block hangs its visibility on, with the same rule the
 * Tasks block runs: it exists only while the model in force has a meter the editor can read.
 * A model without one (a declared endpoint, a pay-per-call key) would make the block either
 * empty or invented, and both are worse than absent.
 */
export const STATUS_SUBSCRIPTION_CONTEXT = 'picode.status.subscriptionVisible';

/**
 * Registers the six blocks, all reading through one store.
 *
 * The reading behind the panel costs a `git` call per folder plus the profile, and the rhythm used
 * to be five seconds of that **for ever**: with the panel closed, nobody was reading the answers.
 * Each view says when it appears and when it goes away, and the timer lives while at least one of
 * them is on screen — the rule the single view had, now spread over six.
 */
export function registerStatusTreeViews(): vscode.Disposable {
	const store = new StatusStore();
	const disposables: vscode.Disposable[] = [
		store,
		// The providers' settings page used to be one click on the `Providers` row. That row is a view
		// header now, so the way in is the header's own action.
		vscode.commands.registerCommand(STATUS_PROVIDER_SETTINGS_COMMAND, () =>
			vscode.commands.executeCommand('workbench.action.openSettings', 'picode.providers')),
	];

	for (const { id, section } of STATUS_SECTIONS) {
		const provider = new StatusSectionProvider(store, section);
		const view = vscode.window.createTreeView(id, { treeDataProvider: provider });

		// The counter on the right of the header: the one thing a folded block still says about what is
		// inside it. It is written again on every reading, because it is a fact of that reading.
		const updateBadge = (): void => {
			// The badge the ACTIVITY BAR icon wears is the owner's to define, and he did: the
			// number of updates waiting (pi itself and the packages) — nothing when there are
			// none. The other blocks' counters live in their rows, not on the icon.
			view.badge = section === 'updates' ? sectionBadge(section, store.current) : undefined;
		};
		updateBadge();

		disposables.push(
			provider,
			view,
			store.onDidChange(updateBadge),
			view.onDidChangeVisibility(event => store.setVisible(id, event.visible)),
		);
		store.setVisible(id, view.visible);
	}

	// The visibility of the two conditional blocks is a fact of the reading: written here, once per
	// refresh, so each appears the moment its data lands and goes away when it is gone.
	const updateVisibilityContexts = (): void => {
		const current = store.current;
		const durable = current?.durable;
		const hasTasks = (durable?.up === true && (durable.work ?? []).some(row => row.taskId !== undefined))
			|| (current?.jobs?.length ?? 0) > 0;
		void vscode.commands.executeCommand('setContext', STATUS_TASKS_CONTEXT, hasTasks);
		const hasSubscription = (current?.subscription?.windows.length ?? 0) > 0;
		void vscode.commands.executeCommand('setContext', STATUS_SUBSCRIPTION_CONTEXT, hasSubscription);
	};
	updateVisibilityContexts();
	disposables.push(store.onDidChange(updateVisibilityContexts));

	return vscode.Disposable.from(...disposables);
}

/** What a row's icon can be: a codicon, a mark, or a mark with one file per theme. */
type StatusIcon = NonNullable<vscode.TreeItem['iconPath']>;

class StatusItem extends vscode.TreeItem {

	constructor(
		label: string,
		options: { description?: string; tooltip?: string; children?: StatusItem[]; icon?: StatusIcon; command?: vscode.Command } = {},
	) {
		super(label, options.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		if (options.description !== undefined) {
			this.description = options.description;
		}
		if (options.tooltip !== undefined) {
			this.tooltip = options.tooltip;
		}
		if (options.icon !== undefined) {
			this.iconPath = options.icon;
		}
		if (options.command !== undefined) {
			this.command = options.command;
		}
		if (options.children) {
			this.children = options.children;
		}
	}

	children: StatusItem[] | undefined;
}

/**
 * The one reading behind every block.
 *
 * Six views, one reading: handing the same snapshot to all of them is what keeps the panel from
 * paying six `git` calls every five seconds. A second ask joins the one already in flight, so the
 * six blocks rendering for the first time read once and not six times.
 */
class StatusStore implements vscode.Disposable {

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

	private data: StatusData | undefined;
	private inFlight: Promise<void> | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly visible = new Set<string>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		this.disposables.push(onDidToggleMcpServer.event(server => this.applyMcpSwitch(server)));
	}

	get current(): StatusData | undefined {
		return this.data;
	}

	/**
	 * A view came on screen, or went away.
	 *
	 * `visible` comes from the tree itself, one id per view, so nothing here guesses whether the owner
	 * is looking. Coming back on screen refreshes at once, because what was left there is as old as
	 * the time away.
	 */
	setVisible(id: string, visible: boolean): void {
		if (visible) {
			const first = this.visible.size === 0;
			this.visible.add(id);
			void this.refresh();
			if (first) {
				this.timer = setInterval(() => { void this.refresh(); }, STATUS_REFRESH_MS);
			}
			return;
		}
		this.visible.delete(id);
		if (this.visible.size === 0 && this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	refresh(): Promise<void> {
		if (this.inFlight === undefined) {
			this.inFlight = this.read().finally(() => this.inFlight = undefined);
		}
		return this.inFlight;
	}

	private async read(): Promise<void> {
		try {
			const data = await vscode.commands.executeCommand<StatusData>(STATUS_DATA_COMMAND);
			if (data !== undefined) {
				this.data = data;
			}
		} catch (error) {
			// The connector may not be activated yet, and a command can fail once and answer the next
			// time. The rows already on screen are worth more than an empty panel, so the failure is
			// **added** to the last reading — and a good reading, which carries no error, replaces it.
			this.data = { ...(this.data ?? {}), error: error instanceof Error ? error.message : String(error) };
		}
		this._onDidChange.fire();
	}

	/**
	 * Repaints the MCP rows with the state the switch just wrote, without re-reading anything.
	 *
	 * The two things a flip changes — the icon and the `on`/`off` description — both come from
	 * `data.mcpServers`, so the rows can be moved without asking for the whole reading again.
	 */
	private applyMcpSwitch(server: McpServerSwitch): void {
		const data = this.data;
		const servers = data?.mcpServers;
		if (data === undefined || servers === undefined) {
			return;
		}
		let changed = false;
		const next = servers.map(entry => {
			if (entry.name !== server.name || entry.on === server.on) {
				return entry;
			}
			changed = true;
			return { ...entry, on: server.on };
		});
		if (!changed) {
			return;
		}
		this.data = { ...data, mcpServers: next };
		this._onDidChange.fire();
	}

	dispose(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
		}
		this._onDidChange.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}

/** One block of the panel, drawing its rows from the store every block shares. */
class StatusSectionProvider implements vscode.TreeDataProvider<StatusItem>, vscode.Disposable {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<StatusItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly store: StatusStore, private readonly section: StatusSection) {
		this.disposables.push(store.onDidChange(() => this._onDidChangeTreeData.fire(undefined)));
	}

	getTreeItem(item: StatusItem): vscode.TreeItem {
		return item;
	}

	async getChildren(item?: StatusItem): Promise<StatusItem[]> {
		if (item !== undefined) {
			return item.children ?? [];
		}
		if (this.store.current === undefined) {
			await this.store.refresh();
		}
		const data = this.store.current;
		if (data === undefined) {
			return [new StatusItem('The status is not available yet — it will appear in a moment.')];
		}
		return sectionRows(this.section, data);
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}

/**
 * The counter a block's header shows, or nothing when that block has nothing to count.
 *
 * It is the number the block is **about**, not how many rows it has: the providers there are, how
 * many MCP servers want a sign-in, how much of the durable agent is in flight, how many files the
 * project has touched. A block with no such number gets no badge at all, rather than a `0` the owner
 * would read as a measurement.
 */
function sectionBadge(section: StatusSection, d: StatusData | undefined): vscode.ViewBadge | undefined {
	if (d === undefined) {
		return undefined;
	}
	switch (section) {
		case 'providers': {
			const count = (d.providers ?? []).length;
			return count === 0 ? undefined : { value: count, tooltip: count === 1 ? '1 provider' : `${count} providers` };
		}
		case 'mcp': {
			const servers = d.mcpServers ?? [];
			const count = servers.filter(server => server.on && server.signIn === 'needed').length;
			// The badge is the servers that want the owner; the tooltip keeps the whole picture the row's
			// old description carried (how many there are, and how many are switched off).
			return count === 0 ? undefined : { value: count, tooltip: mcpCountDescription(servers) };
		}
		case 'host': {
			// What the folded block would otherwise hide: the durable work in flight. The daemon's
			// rows merged into this block, and "is anything going on?" is a folded-block question.
			const dur = d.durable;
			if (dur === undefined || !dur.up) {
				return undefined;
			}
			const running = (dur.streams ?? 0) + (dur.work ?? []).filter(row => row.inFlight === true).length;
			return running === 0 ? undefined : { value: running, tooltip: `${running} durable run${running === 1 ? '' : 's'} in flight` };
		}
		case 'subscription': {
			const sub = d.subscription;
			const tightest = sub?.windows[0];
			if (sub === undefined || tightest === undefined) {
				return undefined;
			}
			const pct = Math.round(tightest.usedPercent);
			return { value: pct, tooltip: `${pct}% of the ${tightest.label} used` };
		}
		case 'project': {
			const changes = d.projects === undefined
				? d.gitChanges
				: d.projects.reduce((total, project) => total + (project.changes ?? 0), 0);
			return changes === undefined || changes === 0 ? undefined : { value: changes, tooltip: `${changes} file${changes === 1 ? '' : 's'} with pending changes` };
		}
		case 'updates': {
			const count = (d.updates?.targets ?? []).length;
			return count === 0 ? undefined : { value: count, tooltip: `${count} update${count === 1 ? '' : 's'} available` };
		}
		case 'tasks': {
			// The block is "work the chat has out": the background jobs it launched and the durable
			// tasks it delegated, and the badge counts the running ones — a folded block that answers
			// "how much is in flight?".
			const jobs = d.jobs?.length ?? 0;
			const tasks = (d.durable?.work ?? []).filter(row => row.taskId !== undefined);
			const total = jobs + tasks.length;
			if (total === 0) {
				return undefined;
			}
			const running = jobs + tasks.filter(row => row.inFlight === true).length;
			const idle = total - running;
			return {
				value: total,
				tooltip: running === 0
					? `${total} idle`
					: idle === 0 ? `${running} running` : `${running} running · ${idle} idle`,
			};
		}
		default:
			// The Host and Session blocks count through their `host` case or not at all: the session's
			// numbers *are* its rows, and the model rides in one.
			return undefined;
	}
}

/** The rows one block draws, from the reading every block shares. */
function sectionRows(section: StatusSection, d: StatusData): StatusItem[] {
	switch (section) {
		case 'host': return hostSectionRows(d);
		case 'subscription': return subscriptionSectionRows(d);
		case 'updates': return updatesSectionRows(d);
		case 'providers': return providerSectionRows(d);
		case 'mcp': return mcpSectionRows(d);
		case 'session': return sessionSectionRows(d);
		case 'project': return projectSectionRows(d);
		case 'tasks': return tasksSectionRows(d);
	}
}

/**
 * The host in force: which pi runs, its version, the model in use, how hard it thinks, and the agents
 * it has launched from these folders. A reading that failed says so here — in the first block, once —
 * instead of repeating the same sentence in the other five.
 */
function hostSectionRows(d: StatusData): StatusItem[] {
	const rows: StatusItem[] = [
		// Which host runs the agent — always pi. There are two: the one inside PiCode, and the
		// machine's own installation when there is one. The row says which, in the word the owner
		// uses: the host, never "pi internal/external".
		new StatusItem('Host', { description: d.runtime === 'external' ? 'External' : 'Internal', icon: new vscode.ThemeIcon('circuit-board') }),
		new StatusItem('Version', { description: d.piVersion || '—', icon: new vscode.ThemeIcon('tag') }),
	];
	const model = d.model ?? d.defaultModel;
	if (model !== undefined) {
		rows.push(new StatusItem('Model', { description: model, icon: new vscode.ThemeIcon('chip') }));
	}
	if (d.thinkingLevel !== undefined) {
		// The level is how hard it thinks; whether the owner **sees** it is `picode.pi.reasoning`, and
		// the row is the switch for it: a click flips it, and the chat stops (or starts) writing the
		// thinking from the next turn on. The description says which it now is.
		rows.push(new StatusItem('Thinking', {
			description: d.reasoning === 'hidden' ? `${d.thinkingLevel} · not shown` : d.thinkingLevel,
			icon: new vscode.ThemeIcon('dashboard'),
			tooltip: d.reasoning === 'hidden'
				? 'Click to show the model\'s thinking in the chat.'
				: 'Click to hide the model\'s thinking in the chat.',
			command: { command: THINKING_TOGGLE_COMMAND, title: 'Toggle the thinking in the chat' },
		}));
	}
	if (d.agents !== undefined) {
		// The agents launched from the open projects, counted off their own transcripts, and the row is
		// also the way in: the same list the command opens. The durable daemon's work is part of this
		// block (below); this is the delegations pi itself ran.
		rows.push(new StatusItem('Launched agents', {
			description: d.agents.working > 0 ? `${d.agents.total} · ${d.agents.working} working` : String(d.agents.total),
			icon: new vscode.ThemeIcon('rocket'),
			command: { command: 'picode.agents', title: 'Show the agents launched from these folders' },
		}));
	}
	// The durable agent lives here, not in a block of its own: the daemon and its conversations are
	// facts about the host as much as its version is. When the daemon was not read at all, nothing is
	// said — an absent reading is not a state to name.
	rows.push(...durableRows(d));
	if (d.error !== undefined) {
		rows.push(new StatusItem('The status could not be read', { description: d.error, icon: stateIcon('warning', STATE_DOWN) }));
	}
	return rows;
}

/**
 * Every provider the host has, each saying where the editor learned of it.
 *
 * The settings page edits **declarations**; a provider whose models or sign-in live in the profile
 * has nothing there to edit, so without these rows the panel's count and that page disagreed in
 * silence — «El proveedor de nan no me sale en la lista de providers… en picode:status salen 2».
 */
function providerSectionRows(d: StatusData): StatusItem[] {
	const providers = d.providers ?? [];
	if (providers.length === 0) {
		return [new StatusItem('No providers', { icon: stateIcon('circle-outline', STATE_MUTED) })];
	}
	return providers.map(row => new StatusItem(row.id, {
		description: providerOrigin(row),
		icon: new vscode.ThemeIcon(row.declared ? 'check' : 'account'),
	}));
}

/** pi's MCP servers and their switches: the row *is* the switch, and a sign-in row is the fix. */
function mcpSectionRows(d: StatusData): StatusItem[] {
	const servers = d.mcpServers ?? [];
	if (servers.length === 0) {
		return [new StatusItem('No MCP servers', { icon: stateIcon('circle-outline', STATE_MUTED) })];
	}
	return mcpServerRows(servers).children ?? [];
}

/** The session's own numbers, or the honest state before the first turn. */
function sessionSectionRows(d: StatusData): StatusItem[] {
	const rows: StatusItem[] = [];
	const ctxTokens = d.ctxTokens;
	if (ctxTokens !== undefined) {
		const pct = d.ctxWindow !== undefined && d.ctxWindow > 0
			? ` (${Math.round(ctxTokens / d.ctxWindow * 100)}%)`
			: '';
		rows.push(new StatusItem('Context', {
			description: d.ctxWindow !== undefined
				? `${ctxTokens.toLocaleString()} / ${d.ctxWindow.toLocaleString()}${pct}`
				: ctxTokens.toLocaleString(),
			icon: new vscode.ThemeIcon('pulse'),
		}));
		rows.push(new StatusItem('Cost (session)', { description: '$' + (d.cost === undefined ? '0.000' : Number(d.cost).toFixed(3)), icon: new vscode.ThemeIcon('credit-card') }));
	} else {
		// The explanation is a tooltip instead of a line: the row is a state ("no turns yet"), and the
		// sentence beside it explained the machine's timing, not anything the row did not already say.
		rows.push(new StatusItem('No turns yet', {
			icon: stateIcon('circle-outline', STATE_MUTED),
			tooltip: "The session's usage appears after the first message.",
		}));
	}
	// The provider's quota moved to the Model Subscription block, above: a model without a meter
	// hides that block instead of carrying a row that reads like a session number.
	if (ctxTokens !== undefined) {
		if (d.inputTokens !== undefined) {
			rows.push(new StatusItem('Tokens in / out', { description: `${d.inputTokens.toLocaleString()} / ${(d.outputTokens ?? 0).toLocaleString()}`, icon: new vscode.ThemeIcon('arrow-swap') }));
		}
		if (d.cacheRead !== undefined && d.cacheWrite !== undefined) {
			rows.push(new StatusItem('Cache read / write', { description: `${d.cacheRead.toLocaleString()} / ${d.cacheWrite.toLocaleString()}`, icon: new vscode.ThemeIcon('archive') }));
		}
	}
	return rows;
}

/**
 * The durable daemon, as it answered this very refresh (`durable.ts` asks it with a bounded
 * connect), as the Host block's tail: when it is down the rows say so plainly and offer the start
 * action instead of standing empty, and when it is up every number is its answer, none of them
 * invented. Nothing when the daemon was not read at all — an absent reading is not a state to name.
 */
function durableRows(d: StatusData): StatusItem[] {
	const dur = d.durable;
	if (dur === undefined) {
		return [];
	}
	if (!dur.up) {
		return [
			new StatusItem('Daemon', {
				description: 'not running',
				icon: stateIcon('circle-slash', STATE_DOWN),
			}),
			new StatusItem('Start the durable agent', {
				icon: new vscode.ThemeIcon('debug-start'),
				command: { command: 'picode.durable.start', title: 'Start the durable agent' },
			}),
		];
	}
	const conversations = dur.conversations ?? 0;
	const subagents = dur.subagentTasks ?? 0;
	const streams = dur.streams ?? 0;
	return [
		new StatusItem('Daemon', {
			// The pid is the machine's business, not the owner's: the row says the daemon answers, and the
			// number that identifies the process is there for whoever goes looking.
			description: 'running',
			icon: stateIcon('server-process', STATE_OK),
			tooltip: dur.pid === undefined ? undefined : `pid ${dur.pid}`,
		}),
		// A counter at zero is not a row: the block header already says the daemon is idle, and three
		// rows reading "0" said that same thing three times.
		...(conversations === 0 ? [] : [new StatusItem('Conversations', {
			description: String(conversations),
			icon: new vscode.ThemeIcon('comment-discussion'),
			command: { command: 'picode.durable.list', title: 'Open a conversation transcript' },
		})]),
		...(subagents === 0 ? [] : [new StatusItem('Subagent conversations', {
			description: String(subagents),
			icon: new vscode.ThemeIcon('comment-discussion'),
		})]),
		// The durable work itself, one row each (`durable.ts` read it from the daemon this very
		// refresh): any conversation with a run in flight and no task behind it. The task-owned ones
		// are the Tasks block's rows — below, and only while any exist — and saying them here too
		// would be the same datum twice.
		...(dur.work ?? []).filter(row => row.taskId === undefined).map(row => new StatusItem(`Conversation ${row.conversationId}`, {
			description: [
				...(row.taskId === undefined ? [] : [`task ${row.taskId}`]),
				row.inFlight === undefined ? 'state unavailable' : row.inFlight ? 'in flight' : 'idle',
				`${row.entries} entries`,
			].join(' · '),
			icon: new vscode.ThemeIcon(row.inFlight === true ? 'sync' : 'circle-outline'),
			command: { command: 'picode.durable.list', title: 'Open a conversation transcript' },
		})),
		...(streams === 0 ? [] : [new StatusItem('Live streams', {
			description: String(streams),
			icon: stateIcon('radio-tower', STATE_OK),
		})]),
		new StatusItem('Stop the durable agent', {
			icon: new vscode.ThemeIcon('debug-stop'),
			command: { command: 'picode.durable.stop', title: 'Stop the durable agent' },
		}),
	];
}

/**
 * The project: in workspace mode one row per folder of the area, each with its own branch and its own
 * changes; in folder mode the single answer it has always been.
 */
function projectSectionRows(d: StatusData): StatusItem[] {
	if (d.projects !== undefined) {
		return d.projects.map(project => new StatusItem(project.name, {
			description: projectDescription(project),
			icon: new vscode.ThemeIcon('repo'),
		}));
	}
	const changes = d.gitChanges === undefined
		? '—'
		: d.gitInsertions !== undefined && d.gitDeletions !== undefined
			? `${d.gitChanges} files · +${d.gitInsertions.toLocaleString()} −${d.gitDeletions.toLocaleString()}`
			: String(d.gitChanges);
	return [
		new StatusItem('Branch', { description: d.gitBranch || '—', icon: new vscode.ThemeIcon('git-branch') }),
		new StatusItem('Changes', { description: changes, icon: new vscode.ThemeIcon('diff') }),
	];
}

/**
 * The work the chat has out: the background jobs it launched, then the tasks it delegated to the
 * durable agent.
 *
 * Both are "several things at once" from the owner's seat, and both read the same way — a name,
 * a state, and a click that opens the transcript. The jobs are the ones the chat itself started
 * (`background-jobs.ts`, the pill's own source); the tasks are the durable agent's background
 * conversations. Each leaves the list when it is done: a finished job's report is already in the
 * chat, and a finished task is the durable agent's history.
 */
function tasksSectionRows(d: StatusData): StatusItem[] {
	const tasks = (d.durable?.work ?? []).filter(row => row.taskId !== undefined);
	const jobs = d.jobs ?? [];
	if (jobs.length === 0 && tasks.length === 0) {
		// The block's `when` keeps this from being drawn in practice; the empty answer is for the one
		// refresh between the visibility write and the rows read.
		return [new StatusItem('No tasks', { icon: stateIcon('circle-outline', STATE_MUTED) })];
	}
	return [
		...jobs.map(job => new StatusItem(job.label ?? `Job ${job.jobNumber}`, {
			description: `running · ${elapsed(job.startedAt)}`,
			icon: stateIcon('sync', STATE_INFO),
			tooltip: job.command === undefined ? undefined : `${job.command}\n\nA background job of this chat; its report lands in the conversation when it ends.`,
		})),
		...tasks.map(row => new StatusItem(`Task ${row.taskId}`, {
			description: [
				row.inFlight === undefined ? 'state unavailable' : row.inFlight ? 'running' : 'idle',
				`${row.entries} entries`,
			].join(' · '),
			icon: row.inFlight === true ? stateIcon('sync', STATE_INFO) : new vscode.ThemeIcon('circle-outline'),
			tooltip: `Durable task ${row.taskId}, conversation ${row.conversationId}. A task is work the chat handed to the durable agent — one per batch of several things to do.`,
			command: { command: 'picode.durable.list', title: 'Open a conversation transcript' },
		})),
	];
}

/** How long a job has been running, in the shortest words that are still true. */
function elapsed(startedAt: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ${seconds % 60}s`;
	}
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * The model's subscription, as the provider reported it.
 *
 * One row per window, tightest first: the `4-hour window` before the billing period, because that
 * is the one that runs out first. Each says what share is used and when the window resets; the
 * colour is the traffic light the panel keeps — green while there is room, yellow as it fills, red
 * once the provider's own limit has been reached. A snapshot that outlived its endpoint is said so
 * in the tooltip: the newest one held, not a live read.
 */
function subscriptionSectionRows(d: StatusData): StatusItem[] {
	const sub = d.subscription;
	if (sub === undefined || sub.windows.length === 0) {
		// The block's `when` keeps this from being drawn in practice; the empty answer is for the one
		// refresh between the visibility write and the rows read.
		return [new StatusItem('No subscription meter', { icon: stateIcon('circle-outline', STATE_MUTED) })];
	}
	return sub.windows.map(window => {
		const pct = Math.round(window.usedPercent);
		const color = sub.limitReached || pct >= 90 ? STATE_DOWN : pct >= 60 ? STATE_ATTENTION : STATE_OK;
		const parts = [`${pct}% used`];
		if (window.resetAt !== null) {
			parts.push(`resets in ${resetsIn(window.resetAt)}`);
		}
		return new StatusItem(window.label, {
			description: parts.join(' · '),
			icon: stateIcon('symbol-numeric', color),
			tooltip: sub.fresh ? undefined : 'The provider did not answer the last read; this is the newest snapshot held.',
		});
	});
}

/** How long until a reset, in the shortest words that are still true. */
function resetsIn(resetAt: number): string {
	const seconds = Math.max(0, Math.round((resetAt - Date.now()) / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	if (hours < 24) {
		return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`;
}

/**
 * What needs updating in pi: the runtime itself, and the packages the profile loads.
 *
 * The rows are the **stored answer** of the update check (`updates-check.ts`), never a lookup run
 * here: the panel re-reads every five seconds, and asking npm about a dozen packages that often would
 * be its own kind of wrong. The check runs in the background and on demand — the action below — and
 * this block draws exactly what it last found, plus how old that answer is.
 *
 * With the machine's own pi in force there is nothing to update and nothing to offer: the check goes
 * quiet on purpose (`extension.ts`), so the block says why instead of claiming "up to date", which
 * would be a claim it cannot make about a pi this editor never writes to.
 */
function updatesSectionRows(d: StatusData): StatusItem[] {
	if (d.runtime === 'external') {
		return [new StatusItem('Your own pi', {
			description: 'updates where it lives',
			icon: stateIcon('info', STATE_INFO),
			tooltip: 'This window runs the pi installed on your machine. PiCode only reads it and never writes to it, so its updates are yours to run where it lives.',
		})];
	}

	const checkNow = (): StatusItem => new StatusItem('Check for updates', {
		icon: new vscode.ThemeIcon('refresh'),
		tooltip: 'Ask the registry now instead of waiting for the next background check.',
		command: { command: UPDATES_CHECK_COMMAND, title: 'Check for pi updates' },
	});

	const updates = d.updates;
	if (updates === undefined) {
		return [
			new StatusItem('Not checked yet', { icon: stateIcon('circle-outline', STATE_MUTED) }),
			checkNow(),
		];
	}

	const rows: StatusItem[] = [];
	for (const target of updates.targets) {
		// The runtime first, the packages after — the order `updatableTargets` keeps and the one the
		// notification reads in. A row carries no command of its own: one update takes the runtime and
		// every package together, so a per-row action would promise a choice pi does not offer.
		rows.push(new StatusItem(target.name, {
			description: `${target.installed} → ${target.latest}`,
			icon: stateIcon('arrow-up', STATE_INFO),
			tooltip: `${target.name} ${target.latest} is available; ${target.installed} is what is installed.`,
		}));
	}
	if (rows.length === 0) {
		rows.push(new StatusItem('Up to date', { icon: stateIcon('check', STATE_OK) }));
	} else {
		rows.push(new StatusItem('Update now', {
			icon: new vscode.ThemeIcon('cloud-download'),
			tooltip: 'Update pi and its packages. The chat restarts and the window reloads when it is done.',
			command: { command: UPDATES_APPLY_COMMAND, title: 'Update pi' },
		}));
	}
	rows.push(new StatusItem('Last checked', { description: describeAge(updates.checkedAt), icon: new vscode.ThemeIcon('history') }));
	rows.push(checkNow());
	return rows;
}

/** How long ago a moment was, in the shortest words that are still true. */
function describeAge(at: number): string {
	const minutes = Math.floor(Math.max(0, Date.now() - at) / 60_000);
	if (minutes < 1) {
		return 'just now';
	}
	if (minutes < 60) {
		return `${minutes} min ago`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours} h ago`;
	}
	const days = Math.floor(hours / 24);
	return days === 1 ? 'yesterday' : `${days} days ago`;
}
