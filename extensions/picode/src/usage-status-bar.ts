/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The subscription counter in the status bar: how much of the model's allowance is used.
 *
 * It shows only while the chat is on a model whose meter the editor can read (NaN's, today —
 * `usage-data.ts` says why the others have none), and hides otherwise. The number is the
 * tightest window, the one that runs out first; a click opens the whole meter in a small list.
 */

import * as vscode from 'vscode';
import type { SubscriptionStatus } from './status-contract';
import { readCurrentSubscription } from './status-data';

/** Re-reads cost nothing between network reads: `usage-data.ts` caches each one for a minute. */
const REFRESH_MS = 15_000;

const NAN_DASHBOARD_URL = 'https://cloud.nan.builders';

const SHOW_COMMAND = 'picode.usage.show';

/** `2h 10m`, `3d 4h`, `5m`: how long until a window resets. */
function untilText(resetAt: number, now: number): string {
	const minutes = Math.max(0, Math.round((resetAt - now) / 60_000));
	const days = Math.floor(minutes / 1_440);
	const hours = Math.floor((minutes % 1_440) / 60);
	const rest = minutes % 60;
	if (days > 0) {
		return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	}
	if (hours > 0) {
		return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
	}
	return `${rest}m`;
}

function resetText(resetAt: number | null, now: number): string {
	return resetAt === null ? '' : `resets in ${untilText(resetAt, now)}`;
}

/** Whether any window is spent: the model answers nothing until it resets. */
function isExhausted(status: SubscriptionStatus): boolean {
	return status.limitReached || status.windows.some(window => window.usedPercent >= 100);
}

function tooltipOf(status: SubscriptionStatus, now: number): vscode.MarkdownString {
	const lines = [`$(pulse) **${status.meter}**`, ''];
	for (const window of status.windows) {
		const reset = resetText(window.resetAt, now);
		lines.push(`- ${window.label}: **${Math.round(window.usedPercent)}%** used${reset.length > 0 ? ` · ${reset}` : ''}`);
	}
	if (isExhausted(status)) {
		lines.push('', '$(error) Allowance used up: this model answers again when it resets.');
	}
	if (!status.fresh) {
		lines.push('', '$(warning) Could not refresh: showing the last reading.');
	}
	const markdown = new vscode.MarkdownString(lines.join('\n'), true);
	return markdown;
}

/** Registers the counter and the list behind it; the caller's context collects both. */
export function registerUsageStatusBar(context: vscode.ExtensionContext, distributionRoot: string, onSessionChanged: vscode.Event<void>): void {
	const item = vscode.window.createStatusBarItem('picode.usage', vscode.StatusBarAlignment.Right, 100);
	item.name = 'Model subscription';
	item.command = SHOW_COMMAND;
	context.subscriptions.push(item);

	let current: SubscriptionStatus | undefined;
	let refreshing = false;

	const paint = (): void => {
		if (current === undefined || current.windows.length === 0) {
			item.hide();
			return;
		}
		const now = Date.now();
		const tightest = current.windows[0]!;
		const percent = Math.round(tightest.usedPercent);
		if (isExhausted(current)) {
			item.text = '$(error) Limit reached';
			item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
		} else {
			item.text = `$(pulse) ${percent}%`;
			item.backgroundColor = percent >= 80 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
		}
		item.tooltip = tooltipOf(current, now);
		item.show();
	};

	const refresh = async (): Promise<void> => {
		if (refreshing) {
			return;
		}
		refreshing = true;
		try {
			current = await readCurrentSubscription(distributionRoot);
		} catch {
			current = undefined;
		} finally {
			refreshing = false;
		}
		paint();
	};

	context.subscriptions.push(vscode.commands.registerCommand(SHOW_COMMAND, async () => {
		await refresh();
		if (current === undefined) {
			void vscode.window.showInformationMessage('This model has no subscription usage to show.');
			return;
		}
		const now = Date.now();
		type Row = vscode.QuickPickItem & { readonly open?: boolean };
		const rows: Row[] = current.windows.map(window => ({
			label: `$(clock) ${window.label}`,
			description: `${Math.round(window.usedPercent)}% used`,
			detail: resetText(window.resetAt, now) || undefined,
		}));
		rows.push(
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: '$(link-external) Open the NaN dashboard', open: true },
		);
		const picked = await vscode.window.showQuickPick(rows, {
			title: `${current.meter} · subscription usage${isExhausted(current) ? ' · limit reached' : ''}`,
			placeHolder: current.fresh ? undefined : 'Could not refresh: showing the last reading',
		});
		if (picked?.open === true) {
			void vscode.env.openExternal(vscode.Uri.parse(NAN_DASHBOARD_URL));
		}
	}));

	const timer = setInterval(() => void refresh(), REFRESH_MS);
	context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));
	context.subscriptions.push(onSessionChanged(() => void refresh()));
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('picode.providers')) {
			void refresh();
		}
	}));
	void refresh();
}
