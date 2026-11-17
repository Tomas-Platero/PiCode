/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Plan usage alerts, without the editor around them: which alerts there are, and which of them a
 * fresh reading of the plans sets off.
 *
 * An alert belongs to a provider's plan and watches every window of it (5-hour, weekly, billing
 * period…). It goes off once per window when that window reaches its percentage, and is ready again
 * when the window drops below it or starts over (its reset time has passed).
 */

export interface IUsageAlert {
	readonly id: string;
	/** The provider whose plan it watches (`openai-codex`, `anthropic`, `nan`). */
	readonly provider: string;
	/** The model (meter) it watches; none means every model of the plan (alerts saved before 2026-11-16). */
	readonly meter?: string;
	/** Goes off when a window reaches this much used, 1 to 100. */
	readonly percent: number;
	readonly enabled: boolean;
}

export interface IAlertWindow {
	readonly label: string;
	readonly usedPercent: number;
	readonly resetAt: number | null;
}

export interface IAlertMeter {
	readonly meter?: string;
	readonly provider?: string;
	readonly windows: readonly IAlertWindow[];
}

/** Which alert already went off for which window, and the reset time that window had then. */
export type FiredAlerts = Readonly<Record<string, number | null>>;

export interface ITriggeredAlert {
	readonly alert: IUsageAlert;
	readonly meter: string | undefined;
	readonly window: IAlertWindow;
	readonly percent: number;
}

/** A percentage people can set: a whole number from 1 to 100, or nothing. */
export function parseAlertPercent(value: string): number | undefined {
	const trimmed = value.trim().replace(/%$/, '').trim();
	if (!/^\d{1,3}$/.test(trimmed)) {
		return undefined;
	}
	const percent = Number(trimmed);
	return percent >= 1 && percent <= 100 ? percent : undefined;
}

/** The saved alerts; anything that is not a well-formed alert is dropped. */
export function readAlerts(raw: string | undefined): IUsageAlert[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw ?? '[]');
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	return parsed.filter((item): item is IUsageAlert => typeof item === 'object' && item !== null
		&& typeof item.id === 'string' && typeof item.provider === 'string' && typeof item.enabled === 'boolean'
		&& (item.meter === undefined || typeof item.meter === 'string')
		&& Number.isInteger(item.percent) && item.percent >= 1 && item.percent <= 100);
}

/** Whether an alert watches this model of this plan. */
export function watches(alert: IUsageAlert, provider: string | undefined, meter: string | undefined): boolean {
	return alert.provider === provider && (alert.meter === undefined || alert.meter === (meter ?? ''));
}

/** The alerts of one model, lowest percentage first. */
export function alertsOf(alerts: readonly IUsageAlert[], provider: string, meter: string | undefined): IUsageAlert[] {
	return alerts.filter(alert => watches(alert, provider, meter)).sort((a, b) => a.percent - b.percent);
}

/** Adds an alert to a model; a model already watching that percentage keeps the one it has. */
export function addAlert(alerts: readonly IUsageAlert[], provider: string, meter: string | undefined, percent: number, id: string): IUsageAlert[] {
	if (alerts.some(alert => watches(alert, provider, meter) && alert.percent === percent)) {
		return [...alerts];
	}
	return [...alerts, { id, provider, meter: meter ?? '', percent, enabled: true }];
}

export function readFired(raw: string | undefined): Record<string, number | null> {
	try {
		const parsed: unknown = JSON.parse(raw ?? '{}');
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return {};
		}
		const fired: Record<string, number | null> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (value === null || typeof value === 'number') {
				fired[key] = value;
			}
		}
		return fired;
	} catch {
		return {};
	}
}

function firedKey(alert: IUsageAlert, meter: IAlertMeter, window: IAlertWindow): string {
	return `${alert.id}|${meter.meter ?? ''}|${window.label}`;
}

/**
 * The alerts a reading sets off, and what to remember afterwards. A window under the percentage, or
 * one whose recorded reset time has passed, is ready to go off again; records of alerts that no
 * longer exist are forgotten.
 */
export function evaluateAlerts(alerts: readonly IUsageAlert[], meters: readonly IAlertMeter[], fired: FiredAlerts, now: number): { triggered: ITriggeredAlert[]; fired: Record<string, number | null> } {
	const next: Record<string, number | null> = {};
	const alive = new Set(alerts.map(alert => alert.id));
	for (const [key, value] of Object.entries(fired)) {
		if (alive.has(key.slice(0, key.indexOf('|')))) {
			next[key] = value;
		}
	}
	const triggered: ITriggeredAlert[] = [];
	for (const alert of alerts) {
		for (const meter of meters) {
			if (!watches(alert, meter.provider, meter.meter)) {
				continue;
			}
			for (const window of meter.windows) {
				const key = firedKey(alert, meter, window);
				const percent = Math.max(0, Math.min(100, Math.round(window.usedPercent)));
				if (percent < alert.percent) {
					delete next[key];
					continue;
				}
				const previous = next[key];
				const startedOver = previous !== undefined && previous !== null && previous <= now;
				if (previous !== undefined && !startedOver) {
					continue;
				}
				next[key] = window.resetAt;
				if (alert.enabled) {
					triggered.push({ alert, meter: meter.meter, window, percent });
				}
			}
		}
	}
	return { triggered, fired: next };
}
