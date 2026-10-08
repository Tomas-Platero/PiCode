/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The agents the editor launched, as one list.
 *
 * `/agents` in the terminal answers one question — what did I start, and what is it doing —
 * and the editor could not: a delegation shows as a card inside the conversation that asked
 * for it, so an agent whose conversation is closed, or one launched from a conversation the
 * owner is not looking at, has no surface at all. The transcripts themselves are the answer —
 * a transcript whose header carries a `parentSession` is a delegation — and this module turns
 * them into rows.
 *
 * ## The state is read, not inferred
 *
 * pi appends a transcript entry once its message is complete, so the last message entry says
 * what the turn is doing: `assistant` — the agent answered and owes nothing; `user` or
 * `toolResult` — it was handed something and still owes an answer; no message at all — nothing
 * was asked of it yet. Every other shape of "is it running?" would be a guess: a clock-based
 * guess calls an agent that finished a minute ago `working`, and one that has been thinking for
 * a long time `finished`.
 *
 * No `vscode` import and no clock of its own: the rows are a pure function of a listing and the
 * `now` the caller passes, so `node --test` runs this file directly.
 */


/**
 * The listing facts this module reads, named here so the file stands alone.
 *
 * The production build cannot carry a `.ts` extension in an import, while `node --test` needs
 * the real specifier, so a module a test imports has to be self-contained. What it needs of a
 * transcript is small, and saying it here is also what keeps the agents list from depending on
 * how the conversations list happens to be built. `PiSessionFile` satisfies this shape.
 */
export interface AgentTranscript {
	readonly id: string;
	readonly file: string;
	readonly label: string;
	readonly mtime: number;
	readonly parent?: string;
	readonly lastRole?: 'user' | 'assistant' | 'toolResult';
}

/** What the agent's own transcript says about its turn. */
export type AgentState = 'working' | 'answered' | 'empty';

/** One launched agent, as the list shows it. */
export interface LaunchedAgent {
	readonly id: string;
	readonly file: string;
	/** The delegation's own prompt — the first user text it was given. */
	readonly label: string;
	/** The transcript that launched it, when its header named one. */
	readonly parent?: string;
	/** That parent's own label, when the same listing knows it. */
	readonly parentLabel?: string;
	/** When this transcript last grew — the newest moment the agent did anything. */
	readonly mtime: number;
	readonly state: AgentState;
}

/** The state a transcript's own last message entry names. */
export function agentStateOf(file: AgentTranscript): AgentState {
	if (file.lastRole === undefined) {
		return 'empty';
	}
	return file.lastRole === 'assistant' ? 'answered' : 'working';
}

/**
 * The delegations among a listing, as rows: the ones still owing an answer first, then the
 * newest, and never two rows that the eye cannot tell apart.
 */
export function launchedAgents(files: readonly AgentTranscript[]): LaunchedAgent[] {
	const labelOf = new Map(files.map(file => [file.file, file.label]));
	return files.flatMap(file => file.parent === undefined ? [] : [{
		id: file.id,
		file: file.file,
		label: file.label,
		parent: file.parent,
		parentLabel: labelOf.get(file.parent),
		mtime: file.mtime,
		state: agentStateOf(file),
	}])
		.sort((a, b) => Number(b.state === 'working') - Number(a.state === 'working')
			|| b.mtime - a.mtime
			|| compareText(a.id, b.id));
}

/** How many agents were launched, and how many of them still owe an answer. */
export function agentsSummary(agents: readonly LaunchedAgent[]): { total: number; working: number } {
	return { total: agents.length, working: agents.filter(agent => agent.state === 'working').length };
}

/**
 * How long ago the agent last did anything, in the shortest honest words.
 *
 * The transcript carries one clock — the file's own mtime — and this is it said plainly: the
 * list never claims an agent is *running*, only when it was last written to.
 */
export function lastActivity(mtime: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - mtime) / 1000));
	if (seconds < 60) {
		return 'just now';
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes} min ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours} h ago`;
	}
	return `${Math.round(hours / 24)} d ago`;
}

/** A text order that depends on the text alone — no locale, so it is the same on any machine. */
function compareText(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	return a < b ? -1 : 1;
}
