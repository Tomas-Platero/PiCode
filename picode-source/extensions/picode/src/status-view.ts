/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { DurableStatus } from './durable';

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

export const STATUS_VIEW_TYPE = 'picode.statusView';
export const STATUS_DATA_COMMAND = 'picode.setup.status';

/** How often the rows are re-read while the panel is on screen. */
const STATUS_REFRESH_MS = 5000;

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

/** The line one server's row shows, and the codicon beside it. */
function mcpRowDescription(server: McpServerSwitch): { description: string; icon: string } {
	if (!server.on) {
		return { description: 'off', icon: 'circle-slash' };
	}
	if (server.signIn === 'needed') {
		return { description: 'needs sign-in', icon: 'warning' };
	}
	if (server.signIn === 'unknown') {
		return { description: 'on · sign-in unknown', icon: 'circle-outline' };
	}
	return { description: 'on', icon: 'circle-filled' };
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
				icon: new vscode.ThemeIcon(row.icon),
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
	providers?: number;
	defaultModel?: string;
	model?: string;
	thinkingLevel?: string;
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
 * Registers the view, with a provider that only works while the view is on screen.
 *
 * The reading behind it costs a `git` call per folder plus the profile, and the rhythm used to be
 * five seconds of that **for ever**: with the panel closed, nobody was reading the answers. The tree
 * says when it appears and when it goes away, and the timer lives in between.
 */
export function registerStatusTreeView(extensionUri: vscode.Uri): vscode.Disposable {
	const provider = new StatusTreeProvider(extensionUri);
	const view = vscode.window.createTreeView(STATUS_VIEW_TYPE, { treeDataProvider: provider });
	const visibility = view.onDidChangeVisibility(event => provider.setWatched(event.visible));
	provider.setWatched(view.visible);
	return vscode.Disposable.from(provider, view, visibility);
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

class StatusTreeProvider implements vscode.TreeDataProvider<StatusItem>, vscode.Disposable {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<StatusItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private data: StatusData | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private watched = false;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly extensionUri: vscode.Uri) {
		this.disposables.push(onDidToggleMcpServer.event(server => this.applyMcpSwitch(server)));
	}

	/**
	 * Starts or stops the refresh, as the panel is shown or hidden.
	 *
	 * `watched` comes from the tree itself: nothing here guesses whether the owner is looking. Coming
	 * back on screen refreshes at once, because what was left on screen is as old as the time away.
	 */
	setWatched(watched: boolean): void {
		if (watched === this.watched) {
			return;
		}
		this.watched = watched;
		if (!watched) {
			if (this.timer !== undefined) {
				clearInterval(this.timer);
				this.timer = undefined;
			}
			return;
		}
		void this.refresh();
		this.timer = setInterval(() => { void this.refresh(); }, STATUS_REFRESH_MS);
	}

	/**
	 * Repaints one MCP row with the state the switch just wrote, without re-reading anything.
	 *
	 * The two things a flip changes — the icon and the `on`/`off` description — both come from
	 * `data.mcpServers`, so the row can be moved without asking for the whole reading again.
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
		this._onDidChangeTreeData.fire(undefined);
	}

	async refresh(): Promise<void> {
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
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(item: StatusItem): vscode.TreeItem {
		return item;
	}

	async getChildren(item?: StatusItem): Promise<StatusItem[]> {
		if (item === undefined) {
			if (this.data === undefined) {
				await this.refresh();
			}
			if (this.data === undefined) {
				return [new StatusItem('The status is not available yet — it will appear in a moment.')];
			}
			return this.sections(this.data);
		}
		return item.children ?? [];
	}

	private sections(d: StatusData): StatusItem[] {
		const out: StatusItem[] = [];
		// Every icon id here was verified against `src/vs/base/common/codiconsLibrary.ts` —
		// a codicon the library does not register renders as a broken box, so no guesses.
		const media = (name: string): vscode.Uri => vscode.Uri.joinPath(this.extensionUri, 'media', name);

		/**
		 * A brand mark, as the two files a tree row needs.
		 *
		 * A row's icon is an **image**, so the ink inside the file is the ink that is drawn — there is no
		 * mask and no theme colour. One file per mark meant one theme where it vanished: the rose is pure
		 * black (invisible on a dark background) and the PiCode mark a pale grey (barely there on a light
		 * one). The pair is what makes both marks the same weight in either theme.
		 */
		const mark = (lightThemeFile: string, darkThemeFile: string): StatusIcon => ({
			light: media(lightThemeFile),
			dark: media(darkThemeFile),
		});

		const piRows: StatusItem[] = [
			// Which host runs the agent — always pi. There are two: the one inside PiCode, and the
			// machine's own installation when there is one. The row says which, in the word the owner
			// uses: the host, never "pi internal/external".
			new StatusItem('Host', { description: d.runtime === 'external' ? 'External' : 'Internal', icon: new vscode.ThemeIcon('circuit-board') }),
			new StatusItem('Version', { description: d.piVersion || '—', icon: new vscode.ThemeIcon('tag') }),
			new StatusItem('Providers', { description: String(d.providers ?? 0), icon: new vscode.ThemeIcon('plug') }),
			// The servers live in pi's own profile, which is where this counts them — not the project's
			// business, which is where the row used to sit.
			new StatusItem('MCP servers', {
				description: mcpCountDescription(d.mcpServers ?? []),
				icon: new vscode.ThemeIcon('server-process'),
				// One row per server, and the row *is* the switch: `enabled` is pi's own key, and the panel is
				// the only place a switched-off server is still listed — the page stops offering it the moment
				// it is off (`mcp-provider.ts`), so without these rows it could not be switched back on.
				...(mcpServerRows(d.mcpServers ?? [])),
			}),
		];
		const model = d.model ?? d.defaultModel;
		if (model !== undefined) {
			piRows.push(new StatusItem('Model', { description: model, icon: new vscode.ThemeIcon('chip') }));
		}
		if (d.thinkingLevel !== undefined) {
			piRows.push(new StatusItem('Thinking', { description: d.thinkingLevel, icon: new vscode.ThemeIcon('dashboard') }));
		}
		out.push(new StatusItem('pi', { children: piRows, icon: mark('picode-light.svg', 'picode.svg') }));

		const sessionRows: StatusItem[] = [];
		const ctxTokens = d.ctxTokens;
		if (ctxTokens !== undefined) {
			const pct = d.ctxWindow !== undefined && d.ctxWindow > 0
				? ` (${Math.round(ctxTokens / d.ctxWindow * 100)}%)`
				: '';
			sessionRows.push(new StatusItem('Context', {
				description: d.ctxWindow !== undefined
					? `${ctxTokens.toLocaleString()} / ${d.ctxWindow.toLocaleString()}${pct}`
					: ctxTokens.toLocaleString(),
				icon: new vscode.ThemeIcon('pulse'),
			}));
			sessionRows.push(new StatusItem('Cost (session)', { description: '$' + (d.cost === undefined ? '0.000' : Number(d.cost).toFixed(3)), icon: new vscode.ThemeIcon('credit-card') }));
		} else {
			sessionRows.push(new StatusItem('No turns yet', { description: "The session's usage appears after the first message.", icon: new vscode.ThemeIcon('history') }));
		}
		// The provider's quota sits with the session's numbers it is read beside, and it is
		// drawn even before the first turn: it is live provider data, not session data.
		if (d.usage !== undefined) {
			sessionRows.push(new StatusItem('Usage', { description: d.usage, icon: new vscode.ThemeIcon('symbol-numeric') }));
		}
		if (ctxTokens !== undefined) {
			if (d.inputTokens !== undefined) {
				sessionRows.push(new StatusItem('Tokens in / out', { description: `${d.inputTokens.toLocaleString()} / ${(d.outputTokens ?? 0).toLocaleString()}`, icon: new vscode.ThemeIcon('arrow-swap') }));
			}
			if (d.cacheRead !== undefined && d.cacheWrite !== undefined) {
				sessionRows.push(new StatusItem('Cache read / write', { description: `${d.cacheRead.toLocaleString()} / ${d.cacheWrite.toLocaleString()}`, icon: new vscode.ThemeIcon('archive') }));
			}
		}
		out.push(new StatusItem('Session', { children: sessionRows, icon: new vscode.ThemeIcon('history') }));

		// The durable daemon, as it answered this very refresh (`durable.ts` asks it with a
		// bounded connect): when it is down the section says so plainly and offers the start
		// action instead of an empty section, and when it is up every number is its answer,
		// none of them invented.
		if (d.durable !== undefined) {
			const dur = d.durable;
			const durableRows: StatusItem[] = dur.up ? [
				new StatusItem('Daemon', {
					description: dur.pid === undefined ? 'running' : `running · pid ${dur.pid}`,
					icon: new vscode.ThemeIcon('server-process'),
				}),
				new StatusItem('Conversations', {
					description: String(dur.conversations ?? 0),
					icon: new vscode.ThemeIcon('comment-discussion'),
					command: { command: 'picode.durable.list', title: 'Open a conversation transcript' },
				}),
				...(dur.subagentTasks === undefined ? [] : [new StatusItem('Subagent conversations', {
					description: String(dur.subagentTasks),
					icon: new vscode.ThemeIcon('comment-discussion'),
				})]),
				// The durable work itself, one row each (`durable.ts` read it from the daemon
				// this very refresh): the subagent-owned conversations and any conversation
				// with a run in flight, each with the state its snapshot actually carries.
				// A conversation that could not be snapshotted says so — no row guesses.
				...(dur.work ?? []).map(row => new StatusItem(`Conversation ${row.conversationId}`, {
					description: [
						...(row.taskId === undefined ? [] : [`task ${row.taskId}`]),
						row.inFlight === undefined ? 'state unavailable' : row.inFlight ? 'in flight' : 'idle',
						`${row.entries} entries`,
					].join(' · '),
					icon: new vscode.ThemeIcon(row.inFlight === true ? 'sync' : 'circle-outline'),
					command: { command: 'picode.durable.list', title: 'Open a conversation transcript' },
				})),
				new StatusItem('Live streams', {
					description: String(dur.streams ?? 0),
					icon: new vscode.ThemeIcon('radio-tower'),
				}),
				new StatusItem('Stop the durable agent', {
					icon: new vscode.ThemeIcon('debug-stop'),
					command: { command: 'picode.durable.stop', title: 'Stop the durable agent' },
				}),
			] : [
				new StatusItem('Daemon', {
					description: 'not running',
					icon: new vscode.ThemeIcon('circle-slash'),
				}),
				new StatusItem('Start the durable agent', {
					icon: new vscode.ThemeIcon('debug-start'),
					command: { command: 'picode.durable.start', title: 'Start the durable agent' },
				}),
			];
			out.push(new StatusItem('Durable', { children: durableRows, icon: new vscode.ThemeIcon('layers') }));
		}

		if (d.projects !== undefined) {
			// Workspace mode: one row per folder of the area, each with its own branch and changes.
			out.push(new StatusItem('Project', { children: d.projects.map(project => new StatusItem(project.name, {
				description: projectDescription(project),
				icon: new vscode.ThemeIcon('repo'),
			})), icon: new vscode.ThemeIcon('root-folder') }));
		} else {
			const changes = d.gitChanges === undefined
				? '—'
				: d.gitInsertions !== undefined && d.gitDeletions !== undefined
					? `${d.gitChanges} files · +${d.gitInsertions.toLocaleString()} −${d.gitDeletions.toLocaleString()}`
					: String(d.gitChanges);
			out.push(new StatusItem('Project', { children: [
				new StatusItem('Branch', { description: d.gitBranch || '—', icon: new vscode.ThemeIcon('git-branch') }),
				new StatusItem('Changes', { description: changes, icon: new vscode.ThemeIcon('diff') }),
			], icon: new vscode.ThemeIcon('root-folder') }));
		}

		if (d.error !== undefined) {
			out.push(new StatusItem('The status could not be read', { description: d.error }));
		}
		return out;
	}

	dispose(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
		}
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}
