/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DurableStatus } from './durable';
import type { PiProviderRow } from './providers-list';
import type { UpdatesSnapshot } from './updates-check';
/**
 * The one answer the status surface draws, and the commands it acts through.
 *
 * The status used to be a tree in the activity bar with its own copies of this shape; the tree is
 * gone and three surfaces read this contract instead: the Status section of the Agent Customizations
 * page, the MCP Servers section (which takes the servers out of it), and the providers list in
 * Settings. One reading, one shape, three readers — a second copy is how the numbers start to
 * disagree with each other.
 *
 * Nothing is invented: a fact the connector cannot obtain stays `undefined`, and every reader draws
 * its own answer for an absent field instead of a zero it does not have.
 */

export const STATUS_DATA_COMMAND = 'picode.setup.status';

/**
 * One allowance window of the model's subscription, as the provider reported it.
 */
export interface SubscriptionWindowRow {
	/** The window in words: `4-hour window`, `weekly window`, or `billing period`. */
	readonly label: string;
	readonly usedPercent: number;
	/** When the window resets, in epoch ms; `null` when the provider did not say. */
	readonly resetAt: number | null;
}

/**
 * The subscription meter of the model in force.
 *
 * Only what the provider itself answered: a window the payload did not carry is not here, and
 * neither is a model the meter does not name.
 */
export interface SubscriptionStatus {
	/** The meter's own id, which names the model it meters. */
	readonly meter: string;
	/** The windows, tightest first — the one that runs out first leads. */
	readonly windows: readonly SubscriptionWindowRow[];
	readonly limitReached: boolean;
	/** `false` when the snapshot outlived its endpoint: the newest one held, not a live read. */
	readonly fresh: boolean;
}

/**
 * One background job the chat itself launched (`background-jobs.ts`, the same rows the pill above
 * the chat input reads), from its start until its completion message closes it.
 */
export interface BackgroundJobStatus {
	readonly jobNumber: string;
	readonly label?: string;
	readonly command?: string;
	readonly startedAt: number;
}

/**
 * One of pi's MCP servers: the name, whether pi will start it, and whether pi can actually use it
 * (`mcp-provider.ts` computes the sign-in fact).
 */
export interface McpServerSwitch {
	readonly name: string;
	readonly on: boolean;
	/**
	 * `ok` — pi can use it; `needed` — enabled but pi has no sign-in for it; `unknown` — the
	 * answer cannot be had (the profile's sign-ins are off-limits). Left out when `off`.
	 */
	readonly signIn?: 'ok' | 'needed' | 'unknown';
	/**
	 * Where this row comes from: `profile` — the profile's own `mcp.json` (the list the
	 * settings form edits); `project` — the workspace's `.pi/mcp.json`, which pi loads for
	 * trusted projects; `discovered` — a server a pi extension or plugin connected into the
	 * live session, which has no entry anywhere the form can edit. Left out for the profile
	 * rows the reading has always answered.
	 */
	readonly origin?: 'profile' | 'project' | 'discovered';
}

/**
 * One folder of the workspace area, as the Project card lists it in workspace mode.
 *
 * The name is the folder's own name, never its full path: the surface says what the
 * folder is, not where it lives.
 */
export interface ProjectGitInfo {
	readonly name: string;
	branch?: string;
	changes?: number;
	insertions?: number;
	deletions?: number;
}

export interface StatusData {
	runtime?: string;
	piVersion?: string;
	/**
	 * Every provider the host has, each with where the editor learned of it. A list and not a count:
	 * the count disagreed with the settings page (which edits only the **declarations**) and the owner
	 * read that as a missing provider.
	 */
	providers?: readonly PiProviderRow[];
	defaultModel?: string;
	model?: string;
	thinkingLevel?: string;
	/** Whether the agent's thinking is written into the chat (`picode.pi.reasoning`). */
	reasoning?: 'shown' | 'hidden';
	/** pi's MCP servers, with the switch pi reads: the MCP section shows them and can flip them. */
	mcpServers?: readonly McpServerSwitch[];
	gitBranch?: string;
	gitChanges?: number;
	gitInsertions?: number;
	gitDeletions?: number;
	/**
	 * The workspace area, one entry per folder — present only when the project mode in
	 * force is `workspace`, and the Project card then lists one line per folder. Absent
	 * in folder mode, where the single fields above are the whole answer.
	 */
	projects?: readonly ProjectGitInfo[];
	ctxTokens?: number;
	ctxWindow?: number;
	cost?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** The durable daemon as it answered right now (`durable.ts`): up or down, and what it holds. */
	durable?: DurableStatus;
	/**
	 * The subscription meter of the model in force, as the provider reported it
	 * (`usage-data.ts` reads it; NaN's quota is the route that exists). `undefined` when the
	 * model has no meter the editor can read — the card then hides itself rather than standing
	 * empty or inventing a window.
	 */
	subscription?: SubscriptionStatus;
	/**
	 * The chat's background jobs still running (`background-jobs.ts`), the same answer the pill
	 * above the chat input reads. Each leaves when its completion message closes it, so a job
	 * that failed or finished is not listed: the card is work still out, and a finished
	 * job's report is already in the chat.
	 */
	jobs?: readonly BackgroundJobStatus[];
	/**
	 * The last update check's stored answer (`updates-check.ts`), and nothing at all when it has never
	 * run. Never a fresh lookup: this reading happens every five seconds, and asking npm about a dozen
	 * packages that often would be its own kind of wrong — the card offers a check to run instead.
	 */
	updates?: UpdatesSnapshot;
	error?: string;
}

/** The way into the providers' settings page, offered by the Providers card. */
export const STATUS_PROVIDER_SETTINGS_COMMAND = 'picode.status.openProviderSettings';

/**
 * The two things the Updates card can do: run the update, or ask the registry again.
 *
 * Both are registered by `extension.ts` and both are the code the notification already runs — the
 * card opens no second path to the same work, it only adds a place to reach the first one from.
 */
export const UPDATES_APPLY_COMMAND = 'picode.updates.apply';
export const UPDATES_CHECK_COMMAND = 'picode.updates.check';
