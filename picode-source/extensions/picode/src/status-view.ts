/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

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
	error?: string;
}

export function registerStatusTreeView(): vscode.Disposable {
	const provider = new StatusTreeProvider();
	return vscode.window.registerTreeDataProvider(STATUS_VIEW_TYPE, provider);
}

class StatusItem extends vscode.TreeItem {

	constructor(
		label: string,
		options: { description?: string; children?: StatusItem[] } = {},
	) {
		super(label, options.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		if (options.description !== undefined) {
			this.description = options.description;
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
	private readonly timer = setInterval(() => { void this.refresh(); }, 5000);

	constructor() {
		void this.refresh();
	}

	async refresh(): Promise<void> {
		try {
			const data = await vscode.commands.executeCommand<StatusData>(STATUS_DATA_COMMAND);
			if (data !== undefined) {
				this.data = data;
			}
		} catch (error) {
			// The connector may not be activated yet; the next tick tries again.
			this.data = { error: error instanceof Error ? error.message : String(error) };
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

		const piRows: StatusItem[] = [
			new StatusItem('Runtime', { description: d.runtime === 'external' ? 'External (machine)' : 'Internal' }),
			new StatusItem('Version', { description: d.piVersion || '—' }),
			new StatusItem('Providers', { description: String(d.providers ?? 0) }),
		];
		const model = d.model ?? d.defaultModel;
		if (model !== undefined) {
			piRows.push(new StatusItem('Model', { description: model }));
		}
		if (d.thinkingLevel !== undefined) {
			piRows.push(new StatusItem('Effort', { description: d.thinkingLevel }));
		}
		out.push(new StatusItem('pi', { children: piRows }));

		// Gentle AI lives in the internal profile; with the external pi it appears only
		// when the machine's own profile happens to carry it.
		if (d.runtime === 'internal' || d.gentleInstalled === true) {
			const gentleRows: StatusItem[] = [
				new StatusItem('State', { description: d.gentleInstalled ? 'Installed' + (d.gentleVersion ? ' · v' + d.gentleVersion : '') : 'Not installed' }),
			];
			if (d.gentleInstalled) {
				gentleRows.push(
					new StatusItem('Skills', { description: String(d.skills ?? 0) }),
				);
			}
			out.push(new StatusItem('Gentle AI', { children: gentleRows }));
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
			}));
			sessionRows.push(new StatusItem('Cost (session)', { description: '$' + (d.cost === undefined ? '0.000' : Number(d.cost).toFixed(3)) }));
		} else {
			sessionRows.push(new StatusItem('No turns yet', { description: "The session's usage appears after the first message." }));
		}
		// The provider's quota sits with the session's numbers it is read beside, and it is
		// drawn even before the first turn: it is live provider data, not session data.
		if (d.usage !== undefined) {
			sessionRows.push(new StatusItem('Usage', { description: d.usage }));
		}
		if (ctxTokens !== undefined) {
			if (d.inputTokens !== undefined) {
				sessionRows.push(new StatusItem('Tokens in / out', { description: `${d.inputTokens.toLocaleString()} / ${(d.outputTokens ?? 0).toLocaleString()}` }));
			}
			if (d.cacheRead !== undefined && d.cacheWrite !== undefined) {
				sessionRows.push(new StatusItem('Cache read / write', { description: `${d.cacheRead.toLocaleString()} / ${d.cacheWrite.toLocaleString()}` }));
			}
		}
		out.push(new StatusItem('Session', { children: sessionRows }));

		const changes = d.gitChanges === undefined
			? '—'
			: d.gitInsertions !== undefined && d.gitDeletions !== undefined
				? `${d.gitChanges} files · +${d.gitInsertions.toLocaleString()} −${d.gitDeletions.toLocaleString()}`
				: String(d.gitChanges);
		out.push(new StatusItem('Project', { children: [
			new StatusItem('Branch', { description: d.gitBranch || '—' }),
			new StatusItem('Changes', { description: changes }),
			new StatusItem('MCP servers', { description: String(d.mcpServers ?? 0) }),
		] }));

		if (d.error !== undefined) {
			out.push(new StatusItem('Status error: ' + d.error));
		}
		return out;
	}

	dispose(): void {
		clearInterval(this.timer);
	}
}
