/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { TaskRow } from './session-tasks';

/**
 * The PiCode status view: a native tree in the activity bar's PiCode container — the pi
 * in force, the provider and default model, the session's usage and cost, the project's
 * branch and pending changes, and Gentle AI's state.
 *
 * A tree, deliberately, and not a webview: the data is a handful of rows, the theme is
 * the editor's own, and a native view cannot fail to render. The rows refresh on a slow
 * timer; errors surface as rows instead of empty panels.
 */

export const STATUS_VIEW_TYPE = 'picode.statusView';
export const STATUS_DATA_COMMAND = 'picode.setup.status';

/** How often the rows are re-read while the panel is on screen. */
const STATUS_REFRESH_MS = 5000;

export interface StatusData {
	runtime?: string;
	piVersion?: string;
	gentleInstalled?: boolean;
	gentleVersion?: string;
	providers?: number;
	defaultModel?: string;
	model?: string;
	thinkingLevel?: string;
	mcpServers?: number;
	/** How many of them are switched off (`enabled: false`): a row that is not offered is still counted. */
	mcpServersOff?: number;
	skills?: number;
	gitBranch?: string;
	gitChanges?: number;
	gitInsertions?: number;
	gitDeletions?: number;
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
	/** The session's task list (gentle-pi's todo tool), last snapshot; absent when none exists. */
	tasks?: readonly TaskRow[];
	error?: string;
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
		options: { description?: string; children?: StatusItem[]; icon?: StatusIcon } = {},
	) {
		super(label, options.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		if (options.description !== undefined) {
			this.description = options.description;
		}
		if (options.icon !== undefined) {
			this.iconPath = options.icon;
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

	constructor(private readonly extensionUri: vscode.Uri) { }

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
			new StatusItem('Runtime', { description: d.runtime === 'external' ? 'Your own pi' : "PiCode's own pi", icon: new vscode.ThemeIcon('circuit-board') }),
			new StatusItem('Version', { description: d.piVersion || '—', icon: new vscode.ThemeIcon('tag') }),
			new StatusItem('Providers', { description: String(d.providers ?? 0), icon: new vscode.ThemeIcon('plug') }),
			// The servers live in pi's own profile, which is where this counts them — not the project's
			// business, which is where the row used to sit.
			new StatusItem('MCP servers', {
				description: d.mcpServersOff === undefined || d.mcpServersOff === 0 ? String(d.mcpServers ?? 0) : `${d.mcpServers ?? 0} · ${d.mcpServersOff} off`,
				icon: new vscode.ThemeIcon('server-process'),
			}),
		];
		const model = d.model ?? d.defaultModel;
		if (model !== undefined) {
			piRows.push(new StatusItem('Model', { description: model, icon: new vscode.ThemeIcon('chip') }));
		}
		if (d.thinkingLevel !== undefined) {
			piRows.push(new StatusItem('Effort', { description: d.thinkingLevel, icon: new vscode.ThemeIcon('dashboard') }));
		}
		out.push(new StatusItem('pi', { children: piRows, icon: mark('picode-light.svg', 'picode.svg') }));

		// Gentle AI lives in the internal profile; with the external pi it appears only
		// when the machine's own profile happens to carry it.
		if (d.runtime === 'internal' || d.gentleInstalled === true) {
			const gentleRows: StatusItem[] = [
				new StatusItem('State', { description: d.gentleInstalled ? 'Installed' + (d.gentleVersion ? ' · v' + d.gentleVersion : '') : 'Not installed', icon: new vscode.ThemeIcon('check') }),
			];
			if (d.gentleInstalled) {
				gentleRows.push(
					new StatusItem('Skills', { description: String(d.skills ?? 0), icon: new vscode.ThemeIcon('lightbulb') }),
				);
			}
			out.push(new StatusItem('Gentle AI', { children: gentleRows, icon: mark('gentle-ai.svg', 'gentle-ai-dark.svg') }));
		}

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
		// The session's task list, exactly as the todo tool last left it — the row per task
		// carries the status icon, the note becomes the description. No list, no rows.
		for (const task of d.tasks ?? []) {
			sessionRows.push(new StatusItem(task.title, {
				description: task.note,
				icon: new vscode.ThemeIcon(task.status === 'done' ? 'check' : task.status === 'in_progress' ? 'sync' : 'circle-large-outline'),
			}));
		}
		out.push(new StatusItem('Session', { children: sessionRows, icon: new vscode.ThemeIcon('history') }));

		const changes = d.gitChanges === undefined
			? '—'
			: d.gitInsertions !== undefined && d.gitDeletions !== undefined
				? `${d.gitChanges} files · +${d.gitInsertions.toLocaleString()} −${d.gitDeletions.toLocaleString()}`
				: String(d.gitChanges);
		out.push(new StatusItem('Project', { children: [
			new StatusItem('Branch', { description: d.gitBranch || '—', icon: new vscode.ThemeIcon('git-branch') }),
			new StatusItem('Changes', { description: changes, icon: new vscode.ThemeIcon('diff') }),
		], icon: new vscode.ThemeIcon('root-folder') }));

		if (d.error !== undefined) {
			out.push(new StatusItem('Status error: ' + d.error));
		}
		return out;
	}

	dispose(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
		}
	}
}
