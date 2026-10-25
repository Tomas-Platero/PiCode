/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The memory protocol: the few lines that make an agent *use* its memory instead of owning it.
 *
 * One text, two engines. The chat injects it as a system-prompt section; the durable agent reads
 * the same words from the file the connector writes into the profile (`memory-protocol.md`), so
 * there is never a version of this rule that says something different in one place than the other.
 *
 * What it is not: a description of the engine. The model does not need to know that there is a
 * SQLite store, a server or a version. It needs to know **when to look** and **what is worth
 * keeping**, which is exactly what a person would tell a new colleague in their first minute.
 *
 * Length is part of the design. Every token here is paid on every single turn, so the text is
 * measured by `MEMORY_PROTOCOL_BUDGET` — the tests fail a growing prompt rather than a wrong one.
 */

import { join } from 'path';

/** What the agent is told. Written in the language the product speaks to its model: English. */
export const MEMORY_PROTOCOL = `Your long-term memory is shared with other agents on this machine. Use it before guessing.

- Search before answering about this project's decisions, conventions or history. Call \`mem_search\` with what you are looking for, then \`mem_get_observation\` on the best match.
- Save what should outlive this conversation: a decision and its reason, a convention, a trap that cost time. Call \`mem_save\` with a title that states it and content that explains why.
- Do not save the transcript — what was asked, what you plan, anything already in the code or in AGENTS.md. That is the durable record's job, and repeating it here turns memory into noise.
- Keep each memory with the project it belongs to. When something holds everywhere, say so in its scope.
- If two memories disagree, say it instead of choosing silently: the engine keeps the conflict, a person decides.`;

/** The ceiling the protocol may reach, in characters. Around 800 is the whole of the text above. */
export const MEMORY_PROTOCOL_BUDGET = 1_200;

/**
 * The section to inject, or `undefined` when this session has no memory tools.
 *
 * The tools are the signal, never a setting: a session whose `engram` server did not connect must
 * not be told to call tools it does not have. Both halves of the pair are required — searching
 * without saving fills a memory that never learns, and saving without searching fills a drawer
 * nobody opens.
 */
export function memorySection(toolNames: readonly string[]): string | undefined {
	const has = (marker: string) => toolNames.some(name => name.toLowerCase().includes(marker));
	return has('mem_search') && has('mem_save') ? MEMORY_PROTOCOL : undefined;
}

/** Where the durable agent reads the same words from: the profile the connector writes. */
export function memoryProtocolFile(profileDir: string): string {
	return join(profileDir, 'memory-protocol.md');
}
