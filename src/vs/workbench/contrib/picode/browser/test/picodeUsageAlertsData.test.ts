/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Plan usage alerts, run on their own.
 *
 * What matters: an alert goes off once per window when it reaches its percentage, is ready again
 * when the window drops below it or starts over, stays quiet while switched off, and a plan can
 * hold as many alerts as wanted (but never the same percentage twice).
 */

import assert from 'assert';
import { test } from 'node:test';
import { addAlert, alertsOf, evaluateAlerts, IAlertMeter, IUsageAlert, parseAlertPercent, readAlerts, readFired, splitAcrossWindows } from '../picodeUsageAlertsData.js';

const NOW = 1_000_000;
const alert = (id: string, percent: number, enabled = true, provider = 'openai-codex'): IUsageAlert => ({ id, provider, percent, enabled });
const chatgpt = (fiveHour: number, weekly: number, resetAt: number | null = NOW + 3_600_000): IAlertMeter => ({
	meter: 'ChatGPT Plus', provider: 'openai-codex',
	windows: [{ label: '5h window', usedPercent: fiveHour, resetAt }, { label: 'weekly window', usedPercent: weekly, resetAt: NOW + 86_400_000 }],
});

test('an alert goes off when a window reaches its percentage, and only once', () => {
	const first = evaluateAlerts([alert('a', 50)], [chatgpt(52, 10)], {}, NOW);
	assert.deepStrictEqual(first.triggered.map(t => [t.alert.id, t.window.label, t.percent]), [['a', '5h window', 52]]);
	const second = evaluateAlerts([alert('a', 50)], [chatgpt(60, 10)], first.fired, NOW);
	assert.deepStrictEqual(second.triggered, []);
});

test('under the percentage nothing goes off', () => {
	assert.deepStrictEqual(evaluateAlerts([alert('a', 50)], [chatgpt(49.4, 10)], {}, NOW).triggered, []);
});

test('each window is watched on its own', () => {
	const result = evaluateAlerts([alert('a', 50)], [chatgpt(55, 70)], {}, NOW);
	assert.deepStrictEqual(result.triggered.map(t => t.window.label), ['5h window', 'weekly window']);
});

test('as many alerts as wanted, each going off at its own percentage', () => {
	const alerts = [alert('a', 25), alert('b', 50), alert('c', 75)];
	const result = evaluateAlerts(alerts, [chatgpt(60, 0)], {}, NOW);
	assert.deepStrictEqual(result.triggered.map(t => t.alert.id), ['a', 'b']);
	const later = evaluateAlerts(alerts, [chatgpt(80, 0)], result.fired, NOW);
	assert.deepStrictEqual(later.triggered.map(t => t.alert.id), ['c']);
});

test('dropping below the percentage makes the alert ready again', () => {
	const fired = evaluateAlerts([alert('a', 50)], [chatgpt(55, 0)], {}, NOW).fired;
	const dropped = evaluateAlerts([alert('a', 50)], [chatgpt(5, 0)], fired, NOW);
	assert.deepStrictEqual(dropped.triggered, []);
	assert.deepStrictEqual(evaluateAlerts([alert('a', 50)], [chatgpt(51, 0)], dropped.fired, NOW).triggered.length, 1);
});

test('a window that started over goes off again even if it was never read below the percentage', () => {
	const fired = evaluateAlerts([alert('a', 50)], [chatgpt(55, 0, NOW + 10)], {}, NOW).fired;
	const after = evaluateAlerts([alert('a', 50)], [chatgpt(60, 0, NOW + 5 * 3_600_000)], fired, NOW + 20);
	assert.deepStrictEqual(after.triggered.length, 1);
});

test('a switched-off alert stays quiet, and does not go off for the same window when switched on', () => {
	const off = evaluateAlerts([alert('a', 50, false)], [chatgpt(55, 0)], {}, NOW);
	assert.deepStrictEqual(off.triggered, []);
	assert.deepStrictEqual(evaluateAlerts([alert('a', 50)], [chatgpt(56, 0)], off.fired, NOW).triggered, []);
});

test('alerts only watch their own plan', () => {
	assert.deepStrictEqual(evaluateAlerts([alert('a', 10, true, 'anthropic')], [chatgpt(90, 90)], {}, NOW).triggered, []);
});

test('records of removed alerts are forgotten', () => {
	const fired = evaluateAlerts([alert('a', 50)], [chatgpt(55, 0)], {}, NOW).fired;
	assert.deepStrictEqual(evaluateAlerts([], [chatgpt(55, 0)], fired, NOW).fired, {});
});

test('the same percentage is never added twice to a model, but another model can have it', () => {
	const one = addAlert([], 'nan', 'qwen3.6', 'billing period', 50, 'a');
	assert.deepStrictEqual(one, [{ id: 'a', provider: 'nan', meter: 'qwen3.6', window: 'billing period', percent: 50, enabled: true }]);
	assert.strictEqual(addAlert(one, 'nan', 'qwen3.6', 'billing period', 50, 'b').length, 1);
	assert.strictEqual(addAlert(one, 'nan', 'glm5.3', 'billing period', 50, 'c').length, 2);
	assert.strictEqual(addAlert(one, 'anthropic', undefined, 'billing period', 50, 'd').length, 2);
	assert.deepStrictEqual(alertsOf([alert('x', 80), alert('y', 20), alert('z', 50, true, 'nan')], 'openai-codex', 'ChatGPT Plus').map(a => a.percent), [20, 80]);
});

test('an alert of one model leaves the other models of the plan alone', () => {
	const qwen = { id: 'q', provider: 'nan', meter: 'qwen3.6', percent: 50, enabled: true };
	const meters: IAlertMeter[] = [
		{ meter: 'qwen3.6', provider: 'nan', windows: [{ label: 'billing period', usedPercent: 20, resetAt: null }] },
		{ meter: 'glm5.3', provider: 'nan', windows: [{ label: 'billing period', usedPercent: 90, resetAt: null }] },
	];
	assert.deepStrictEqual(evaluateAlerts([qwen], meters, {}, NOW).triggered, []);
	assert.deepStrictEqual(evaluateAlerts([{ ...qwen, meter: 'glm5.3' }], meters, {}, NOW).triggered.map(t => t.meter), ['glm5.3']);
});

test('an alert saved for the whole plan still watches every model', () => {
	const meters: IAlertMeter[] = [
		{ meter: 'qwen3.6', provider: 'nan', windows: [{ label: 'billing period', usedPercent: 60, resetAt: null }] },
		{ meter: 'glm5.3', provider: 'nan', windows: [{ label: 'billing period', usedPercent: 70, resetAt: null }] },
	];
	assert.strictEqual(evaluateAlerts([alert('p', 50, true, 'nan')], meters, {}, NOW).triggered.length, 2);
	assert.strictEqual(alertsOf([alert('p', 50, true, 'nan')], 'nan', 'glm5.3').length, 1);
});

test('an alert of one window leaves the other windows of the model alone', () => {
	const weekly: IUsageAlert = { id: 'w', provider: 'openai-codex', meter: 'ChatGPT Plus', window: 'weekly window', percent: 50, enabled: true };
	assert.deepStrictEqual(evaluateAlerts([weekly], [chatgpt(90, 10)], {}, NOW).triggered, []);
	assert.deepStrictEqual(evaluateAlerts([weekly], [chatgpt(10, 60)], {}, NOW).triggered.map(t => t.window.label), ['weekly window']);
});

test('the same percentage can be set on two windows of one model, but not twice on one window', () => {
	const one = addAlert([], 'openai-codex', 'ChatGPT Plus', '5h window', 80, 'a');
	const two = addAlert(one, 'openai-codex', 'ChatGPT Plus', 'weekly window', 80, 'b');
	assert.strictEqual(two.length, 2);
	assert.strictEqual(addAlert(two, 'openai-codex', 'ChatGPT Plus', 'weekly window', 80, 'c').length, 2);
	assert.deepStrictEqual(alertsOf(two, 'openai-codex', 'ChatGPT Plus', 'weekly window').map(a => a.id), ['b']);
});

test('a model alert saved before windows had their own is split into one per window, and only once', () => {
	let n = 0;
	const old: IUsageAlert = { id: 'old', provider: 'openai-codex', meter: 'ChatGPT Plus', percent: 75, enabled: false };
	const plan = alert('plan', 60);
	const split = splitAcrossWindows([old, plan], 'openai-codex', 'ChatGPT Plus', ['5h window', 'weekly window'], () => `n${++n}`);
	assert.deepStrictEqual(split, [
		plan,
		{ id: 'n1', provider: 'openai-codex', meter: 'ChatGPT Plus', percent: 75, enabled: false, window: '5h window' },
		{ id: 'n2', provider: 'openai-codex', meter: 'ChatGPT Plus', percent: 75, enabled: false, window: 'weekly window' },
	]);
	const again = splitAcrossWindows(split, 'openai-codex', 'ChatGPT Plus', ['5h window', 'weekly window'], () => 'x');
	assert.strictEqual(again, split);
});

test('percentages people can type', () => {
	assert.strictEqual(parseAlertPercent('50'), 50);
	assert.strictEqual(parseAlertPercent(' 75 % '), 75);
	assert.strictEqual(parseAlertPercent('100'), 100);
	for (const bad of ['0', '101', '', 'abc', '4.5', '-3']) {
		assert.strictEqual(parseAlertPercent(bad), undefined, bad);
	}
});

test('saved data that is broken or not an alert is dropped', () => {
	assert.deepStrictEqual(readAlerts('nope'), []);
	assert.deepStrictEqual(readAlerts('{}'), []);
	assert.deepStrictEqual(readAlerts(JSON.stringify([alert('a', 50), { id: 'b', provider: 'x', percent: 500, enabled: true }, null])), [alert('a', 50)]);
	assert.deepStrictEqual(readFired('[1]'), {});
	assert.deepStrictEqual(readFired(JSON.stringify({ k: 3, j: null, z: 'x' })), { k: 3, j: null });
});
