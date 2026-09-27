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
	mcpServers?: number;
	skills?: number;
	agents?: number;
	sessions?: number;
	gitBranch?: string;
	gitChanges?: number;
	ctxTokens?: number;
	ctxWindow?: number;
	cost?: number;
	inputTokens?: number;
	outputTokens?: number;
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
		if (d.defaultModel !== undefined) {
			piRows.push(new StatusItem('Default model', { description: d.defaultModel }));
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
					new StatusItem('Agents', { description: String(d.agents ?? 0) }),
				);
			}
			out.push(new StatusItem('Gentle AI', { children: gentleRows }));
		}

		const sessionRows: StatusItem[] = [];
		if (d.ctxTokens !== undefined) {
			const pct = d.ctxWindow !== undefined && d.ctxWindow > 0
				? ` (${Math.round(d.ctxTokens / d.ctxWindow * 100)}%)`
				: '';
			sessionRows.push(new StatusItem('Context', {
				description: d.ctxWindow !== undefined
					? `${d.ctxTokens.toLocaleString()} / ${d.ctxWindow.toLocaleString()} tokens${pct}`
					: `${d.ctxTokens.toLocaleString()} tokens`,
			}));
			sessionRows.push(new StatusItem('Cost (session)', { description: '$' + (d.cost === undefined ? '0.000' : Number(d.cost).toFixed(3)) }));
			if (d.inputTokens !== undefined) {
				sessionRows.push(new StatusItem('Tokens in / out', { description: `${d.inputTokens.toLocaleString()} / ${(d.outputTokens ?? 0).toLocaleString()}` }));
			}
		} else {
			sessionRows.push(new StatusItem('No turns yet', { description: 'The usage appears after the first message.' }));
		}
		out.push(new StatusItem('Session', { children: sessionRows }));

		out.push(new StatusItem('Project', { children: [
			new StatusItem('Branch', { description: d.gitBranch || '—' }),
			new StatusItem('Pending changes', { description: d.gitChanges === undefined ? '—' : String(d.gitChanges) }),
			new StatusItem('MCP servers', { description: String(d.mcpServers ?? 0) }),
			new StatusItem('Sessions', { description: String(d.sessions ?? 0) }),
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
