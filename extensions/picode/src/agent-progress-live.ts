/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/** Gentle's session-scoped subagent service, without its terminal RPC transport. */
interface AgentService {
	readonly schema: string;
	read(): { sessionId: string; agents: unknown[] };
	observe(listener: (sessionId: string) => void): () => void;
	dispose(): void;
}

interface AgentPi {
	on(event: string, handler: (...args: any[]) => void): unknown;
	readonly events?: { emit(channel: string, payload: unknown): void };
}

export function agentProgressExtension(publish: (agents: unknown[], source: object) => void, begin: (source: object) => void = () => {}, end: (source: object) => void = () => {}): { name: string; hidden: true; factory: (pi: AgentPi) => void } {
	return {
		name: 'picode-agent-progress', hidden: true,
		factory: pi => {
			const source = {};
			let generation = 0;
			let started = false;
			let service: AgentService | undefined;
			let unsubscribe: (() => void) | undefined;
			const stop = () => {
				generation++;
				try { unsubscribe?.(); } catch { /* session already closed */ }
				try { service?.dispose(); } catch { /* session already closed */ }
				unsubscribe = undefined;
				service = undefined;
				if (started) { started = false; end(source); }
			};
			pi.on('session_start', (_event: unknown, context: object) => {
				stop();
				started = true;
				begin(source);
				const current = generation;
				try {
					pi.events?.emit('gentle:desktop:agents-service', { context, respond: (value: unknown) => {
						const candidate = value as Partial<AgentService> | undefined;
						if (candidate?.schema !== 'gentle-pi.desktop-agents-service/v1' || typeof candidate.read !== 'function' || typeof candidate.observe !== 'function' || typeof candidate.dispose !== 'function') { return; }
						if (generation !== current || service !== undefined) { candidate.dispose(); return; }
						service = candidate as AgentService;
						try {
							const initial = service.read();
							if (typeof initial?.sessionId !== 'string' || !Array.isArray(initial.agents)) { stop(); return; }
							const sessionId = initial.sessionId;
							publish(initial.agents, source);
							unsubscribe = service.observe(changed => {
								if (generation !== current || changed !== sessionId || service === undefined) { return; }
								try {
									const next = service.read();
									if (next?.sessionId === sessionId && Array.isArray(next.agents)) { publish(next.agents, source); }
								} catch { /* owner is no longer available */ }
							});
						} catch { stop(); }
					} });
				} catch { stop(); }
			});
			pi.on('session_shutdown', stop);
		},
	};
}
