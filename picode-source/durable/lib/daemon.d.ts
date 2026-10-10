// Types for the durable daemon's module surface, as far as the connector's
// tests use it. The daemon is plain JavaScript (picode-source/durable), so
// this is the declaration the test typecheck reads — keep it in step with
// lib/daemon.js's exports.
export interface ResolvedDaemonOptions {
	options: {
		model: { value: string };
		agent?: { value?: string };
	};
}

export interface DaemonAgentParams {
	model?: string;
	agent?: string;
	cwd?: string;
}

/** Resolve `model`/`agent`/`cwd` request parameters against the daemon's own options. */
export function agentFor(
	resolved: ResolvedDaemonOptions,
	agents: readonly { name: string }[],
	params: DaemonAgentParams,
): Record<string, unknown>;

/** Start the daemon: open the shared storage, serve the protocol. */
export function startDaemon(resolved: unknown): Promise<unknown>;
