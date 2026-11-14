/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Where the model's context goes, for the Context block of Status.
 *
 * pi only tells the total (`getContextUsage`). The parts are estimated here, with pi's own
 * heuristic (four characters a token), from what pi sends the model: its system text, split by
 * the `<section>` tags it renders, the tools it declares and the messages. When the total is
 * known the messages take what the other parts leave, so the rows always add up to it; without it
 * every row is an estimate. No `vscode` import: the tests load this file directly.
 */

export type ContextPartId = 'messages' | 'project' | 'pi' | 'skills' | 'other' | 'tools' | 'mcp';

export interface IContextPart {
	readonly id: ContextPartId;
	readonly tokens: number;
}

export interface IContextBreakdown {
	readonly window: number;
	/** What the conversation uses now: pi's total when it has one, the estimate otherwise. */
	readonly used: number;
	/** Whether `used` is pi's own number, not the sum of the estimates. */
	readonly exact: boolean;
	/** Largest first, empty parts left out. */
	readonly parts: readonly IContextPart[];
	/** The margin pi keeps before it compacts on its own. */
	readonly reserve: number;
	readonly free: number;
	/** How much more fits before pi compacts. */
	readonly untilCompaction: number;
}

export interface IContextTool {
	readonly name: string;
	readonly description?: string;
	readonly parameters?: unknown;
}

export interface IContextInput {
	readonly systemPrompt: string;
	readonly messages: readonly unknown[];
	readonly tools: readonly IContextTool[];
	/** The tools declared to the model; without the list, every tool counts. */
	readonly activeToolNames?: readonly string[];
	readonly contextWindow: number;
	/** pi's total, when it knows it (it does not right after a compaction). */
	readonly usedTokens?: number | null;
	readonly reserveTokens: number;
	/** pi's own per-message estimate; four characters a token of its JSON otherwise. */
	readonly estimateMessage?: (message: unknown) => number;
}

/** pi's heuristic for text it has no count for. */
export function estimateText(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Sections pi renders that are its own instructions, as opposed to the project's or an extension's. */
const PI_SECTIONS = new Set(['tools', 'rules', 'docs', 'cwd']);

/**
 * Splits pi's system text into its own instructions (the preamble and the `tools`, `rules`, `docs`
 * and `cwd` sections), the project files (`project_context`), the skills list (`skills`) and the
 * rest (`addendum` and what extensions add). A text with no sections is all pi's own.
 */
export function splitSystemPrompt(prompt: string): { readonly pi: string; readonly project: string; readonly skills: string; readonly other: string } {
	let pi = '';
	let project = '';
	let skills = '';
	let other = '';
	const section = /<([a-z_][a-z0-9_-]*)>\n[\s\S]*?\n<\/\1>/g;
	let last = 0;
	for (const match of prompt.matchAll(section)) {
		pi += prompt.slice(last, match.index);
		last = match.index + match[0].length;
		const name = match[1];
		if (PI_SECTIONS.has(name)) {
			pi += match[0];
		} else if (name === 'project_context') {
			project += match[0];
		} else if (name === 'skills') {
			skills += match[0];
		} else {
			other += match[0];
		}
	}
	pi += prompt.slice(last);
	return { pi: pi.trim(), project, skills, other };
}

function isSystemMessage(message: unknown): boolean {
	return typeof message === 'object' && message !== null && (message as { role?: unknown }).role === 'system';
}

export function contextBreakdown(input: IContextInput): IContextBreakdown {
	const prompt = splitSystemPrompt(input.systemPrompt);
	const active = input.activeToolNames ? new Set(input.activeToolNames) : undefined;
	let tools = 0;
	let mcp = 0;
	for (const tool of input.tools) {
		if (active && !active.has(tool.name)) {
			continue;
		}
		const size = estimateText(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
		if (tool.name.startsWith('mcp__')) {
			mcp += size;
		} else {
			tools += size;
		}
	}
	const fixed: IContextPart[] = [
		{ id: 'project', tokens: estimateText(prompt.project) },
		{ id: 'pi', tokens: estimateText(prompt.pi) },
		{ id: 'skills', tokens: estimateText(prompt.skills) },
		{ id: 'other', tokens: estimateText(prompt.other) },
		{ id: 'tools', tokens: tools },
		{ id: 'mcp', tokens: mcp },
	];
	const fixedTotal = fixed.reduce((total, part) => total + part.tokens, 0);
	const estimate = input.estimateMessage ?? (message => estimateText(JSON.stringify(message) ?? ''));
	const exact = typeof input.usedTokens === 'number';
	// The system messages pi keeps in the transcript repeat the system text: counted once, above.
	const messages = exact
		? Math.max(0, (input.usedTokens as number) - fixedTotal)
		: input.messages.filter(message => !isSystemMessage(message)).reduce((total: number, message) => total + estimate(message), 0);
	const used = exact ? Math.max(input.usedTokens as number, fixedTotal) : fixedTotal + messages;
	const window = Math.max(0, input.contextWindow);
	const reserve = Math.max(0, input.reserveTokens);
	return {
		window,
		used,
		exact,
		parts: [{ id: 'messages' as const, tokens: messages }, ...fixed].filter(part => part.tokens > 0).sort((a, b) => b.tokens - a.tokens),
		reserve,
		free: Math.max(0, window - used - reserve),
		untilCompaction: Math.max(0, window - reserve - used),
	};
}
