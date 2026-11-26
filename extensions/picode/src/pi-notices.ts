/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { l10n } from './l10n.ts';

export interface PiNotices {
	readonly cacheMisses?: boolean;
	readonly cacheWarming?: boolean;
	readonly compactionCosts?: boolean;
	readonly reasoningDrops?: boolean;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function number(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function dropped(message: unknown): { type: string; count: number } | undefined {
	const diagnostics = record(message)['diagnostics'];
	if (!Array.isArray(diagnostics)) { return undefined; }
	for (const raw of diagnostics) {
		const diagnostic = record(raw);
		const kind = diagnostic['type'] === 'openai_input_transformations' ? 'reasoning' : diagnostic['type'] === 'anthropic_input_transformations' ? 'thinking_dropped' : undefined;
		const transformations = record(diagnostic['details'])['transformations'];
		if (kind && Array.isArray(transformations)) {
			const count = transformations.filter(value => record(value)['type'] === kind).length;
			if (count) { return { type: kind, count }; }
		}
	}
	return undefined;
}

/** Convert live pi events to optional, user-facing notices. */
export function piNotice(event: unknown, enabled: PiNotices, entries: readonly unknown[]): string | undefined {
	const item = record(event);
	const entry = record(item['entry']);
	if (enabled.cacheWarming && item['type'] === 'entry_appended' && entry['type'] === 'usage' && entry['kind'] === 'cache_warm') {
		const cost = number(record(record(entry['usage'])['cost'])['total']);
		return l10n.t('Cache refreshed (cost: ${0}).', cost.toFixed(4));
	}
	if (enabled.compactionCosts && item['type'] === 'compaction_end' && record(item['result'])['usage']) {
		const cost = number(record(record(record(item['result'])['usage'])['cost'])['total']);
		return l10n.t('Context compacted (cost: ${0}).', cost.toFixed(4));
	}
	const message = record(item['message']);
	if (item['type'] !== 'message_end' || message['role'] !== 'assistant') { return undefined; }
	if (message['stopReason'] === 'aborted' || message['stopReason'] === 'error') { return undefined; }
	if (enabled.reasoningDrops) {
		const current = dropped(message);
		const previous = entries.slice().reverse().map(record).find(e => e['type'] === 'message' && record(e['message'])['role'] === 'assistant');
		const earlier = dropped(previous?.['message']);
		if (current && (!earlier || earlier.type !== current.type || current.count > earlier.count)) {
			return l10n.t('The model provider omitted some earlier reasoning.');
		}
	}
	if (enabled.cacheMisses) {
		const usage = record(message['usage']);
		const input = number(usage['input']);
		const read = number(usage['cacheRead']);
		const write = number(usage['cacheWrite']);
		let previous: Record<string, unknown> | undefined;
		let reportedCache = false;
		for (const raw of entries) {
			const e = record(raw);
			if (e['type'] === 'compaction' || e['type'] === 'branch_summary') { previous = undefined; reportedCache = false; continue; }
			const candidate = e['type'] === 'usage' && e['kind'] === 'cache_warm' ? record(e['usage']) : e['type'] === 'message' && record(e['message'])['role'] === 'assistant' ? record(record(e['message'])['usage']) : undefined;
			if (candidate && number(candidate['input']) + number(candidate['cacheRead']) + number(candidate['cacheWrite']) > 0) {
				previous = candidate;
				reportedCache ||= number(candidate['cacheRead']) + number(candidate['cacheWrite']) > 0;
			}
		}
		if (previous && (read + write > 0 || reportedCache)) {
			const before = number(previous['input']) + number(previous['cacheRead']) + number(previous['cacheWrite']);
			const missed = Math.min(before, input + read + write) - read;
			if (missed > 1024) { return l10n.t('The prompt cache missed {0} tokens.', String(missed)); }
		}
	}
	return undefined;
}
