/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { FocusMode } from '../../../../platform/native/common/native.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { AICustomizationManagementSection } from '../../chat/common/aiCustomizationWorkspaceService.js';
import { addAlert, evaluateAlerts, IAlertMeter, ITriggeredAlert, IUsageAlert, readAlerts, readFired } from './picodeUsageAlertsData.js';

/**
 * Plan usage alerts in the editor: where they are kept, and the watcher that reads the plans and
 * tells the user when one of their alerts goes off — in the editor, and as a system notification
 * when PiCode is in the background.
 */

export const USAGE_ALERTS_STORAGE_KEY = 'picode.usageAlerts';
const FIRED_STORAGE_KEY = 'picode.usageAlerts.fired';
/** The connector's light reading: only the plan meters. */
const SUBSCRIPTIONS_COMMAND = 'picode.setup.subscriptions';
/** The connector caches each network read for a minute; reading more often learns nothing. */
const WATCH_MS = 60_000;
/** The first read waits for the connector to start. */
const FIRST_READ_MS = 15_000;

export function getUsageAlerts(storageService: IStorageService): IUsageAlert[] {
	return readAlerts(storageService.get(USAGE_ALERTS_STORAGE_KEY, StorageScope.PROFILE));
}

function storeAlerts(storageService: IStorageService, alerts: readonly IUsageAlert[]): void {
	storageService.store(USAGE_ALERTS_STORAGE_KEY, JSON.stringify(alerts), StorageScope.PROFILE, StorageTarget.USER);
}

export function addUsageAlert(storageService: IStorageService, provider: string, meter: string | undefined, percent: number): boolean {
	const alerts = getUsageAlerts(storageService);
	const next = addAlert(alerts, provider, meter, percent, generateUuid());
	if (next.length === alerts.length) {
		return false;
	}
	storeAlerts(storageService, next);
	return true;
}

export function toggleUsageAlert(storageService: IStorageService, id: string): void {
	storeAlerts(storageService, getUsageAlerts(storageService).map(alert => alert.id === id ? { ...alert, enabled: !alert.enabled } : alert));
}

export function removeUsageAlert(storageService: IStorageService, id: string): void {
	storeAlerts(storageService, getUsageAlerts(storageService).filter(alert => alert.id !== id));
}

function providerName(id: string): string {
	switch (id) {
		case 'nan': return 'NaN';
		case 'openai-codex': return 'ChatGPT';
		case 'anthropic': return 'Claude';
		default: return id;
	}
}

function windowName(label: string): string {
	return label.length > 0 ? label[0].toUpperCase() + label.slice(1) : label;
}

class PicodeUsageAlertsWatcher extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.picodeUsageAlerts';

	private timer: ReturnType<typeof setTimeout> | undefined;
	private reading = false;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHostService private readonly hostService: IHostService,
	) {
		super();
		this._register({ dispose: () => clearTimeout(this.timer) });
		// A new or changed alert is checked straight away, so one already passed says so at once.
		this._register(storageService.onDidChangeValue(StorageScope.PROFILE, USAGE_ALERTS_STORAGE_KEY, this._store)(() => this.schedule(500)));
		this.schedule(FIRST_READ_MS);
	}

	private schedule(delay: number): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.check(), delay);
	}

	private async check(): Promise<void> {
		if (this.reading) {
			return;
		}
		this.reading = true;
		try {
			// Nothing to watch, nothing to read: the plans are only read while an alert is switched on.
			if (getUsageAlerts(this.storageService).some(alert => alert.enabled)) {
				await this.read();
			}
		} finally {
			this.reading = false;
			this.schedule(WATCH_MS);
		}
	}

	private async read(): Promise<void> {
		let data: { readonly subscriptions?: readonly IAlertMeter[] } | undefined;
		try {
			data = await this.commandService.executeCommand(SUBSCRIPTIONS_COMMAND);
		} catch {
			return;
		}
		if (data === undefined) {
			return;
		}
		// Read again right before deciding: another PiCode window may have just told the user.
		const alerts = getUsageAlerts(this.storageService);
		const fired = readFired(this.storageService.get(FIRED_STORAGE_KEY, StorageScope.PROFILE));
		const result = evaluateAlerts(alerts, (data.subscriptions ?? []).filter(meter => meter.windows.length > 0), fired, Date.now());
		if (JSON.stringify(result.fired) !== JSON.stringify(fired)) {
			this.storageService.store(FIRED_STORAGE_KEY, JSON.stringify(result.fired), StorageScope.PROFILE, StorageTarget.MACHINE);
		}
		// Several alerts of one window at once: the highest one says it all.
		const byWindow = new Map<string, ITriggeredAlert>();
		for (const triggered of result.triggered) {
			const key = `${triggered.alert.provider}|${triggered.meter ?? ''}|${triggered.window.label}`;
			const kept = byWindow.get(key);
			if (kept === undefined || kept.alert.percent < triggered.alert.percent) {
				byWindow.set(key, triggered);
			}
		}
		for (const triggered of byWindow.values()) {
			this.notify(triggered);
		}
	}

	private notify(triggered: ITriggeredAlert): void {
		const plan = triggered.meter !== undefined && triggered.meter.length > 0 ? triggered.meter : providerName(triggered.alert.provider);
		const window = windowName(triggered.window.label);
		const open = localize('picodeUsageAlerts.open', "Open usage limits");
		const openLimits = () => void this.commandService.executeCommand('aiCustomization.openManagementEditor', AICustomizationManagementSection.UsageLimits);
		this.notificationService.prompt(
			triggered.percent >= 95 ? Severity.Error : Severity.Warning,
			localize('picodeUsageAlerts.message', "{0} · {1}: {2}% used. Your alert was set at {3}%.", plan, window, triggered.percent, triggered.alert.percent),
			[{ label: open, run: openLimits }],
		);
		// In the background, the system tells too, like an alarm on a phone.
		if (!this.hostService.hasFocus) {
			void this.hostService.showToast({
				title: localize('picodeUsageAlerts.toastTitle', "{0} at {1}%", plan, triggered.percent),
				body: localize('picodeUsageAlerts.toastBody', "{0} · your alert was set at {1}%", window, triggered.alert.percent),
				actions: [open],
			}, CancellationToken.None).then(result => {
				if (result.clicked || typeof result.actionIndex === 'number') {
					void this.hostService.focus(mainWindow, { mode: FocusMode.Force });
					openLimits();
				}
			});
		}
	}
}

registerWorkbenchContribution2(PicodeUsageAlertsWatcher.ID, PicodeUsageAlertsWatcher, WorkbenchPhase.AfterRestored);
