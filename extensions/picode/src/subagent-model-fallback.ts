/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { canTryAnotherModel, describeFailure, type ProviderFailure } from './subagent-failure';

/**
 * A pi extension every gentle-pi subagent loads: when the subagent's own model is refused — out of
 * allowance, key refused, rate limited, model not offered — it switches that subagent to the model
 * the chat is on and lets it carry on, once.
 *
 * Each Gentle agent answers with the model chosen for it (`gentle-models.ts`), which is not the
 * chat's. When that provider runs dry the task failed after one turn while the chat, on another
 * provider, kept working. The editor publishes the chat's model in `PICODE_CHAT_MODEL`; the
 * subagent inherits it and this extension reads it at the moment of the failure.
 *
 * It runs in the child pi process, loaded through gentle-pi's child injection signal
 * (`subagentInjectionEnv` in `product-env.ts`). It acts only in a subagent and never persists the
 * switch: the agent's own model stays chosen for the next task.
 *
 * No `vscode` import: pi loads the compiled file directly.
 */

/** Where the editor publishes the chat's model, as `provider/model`. */
export const CHAT_MODEL_ENV = 'PICODE_CHAT_MODEL';

/** The variable gentle-pi sets in every subagent it starts. */
const SUBAGENT_ENV = 'GENTLE_PI_AGENTS_CHILD';

interface ModelLike {
	readonly provider: string;
	readonly id: string;
}

/** The slice of pi's extension API this uses. */
export interface FallbackPi {
	on(event: 'agent_before_settle', handler: (event: { outcome: string; context: { contextMessages: readonly unknown[] } }, ctx: { modelRegistry: { find(provider: string, id: string): ModelLike | undefined } }) => Promise<unknown> | unknown): void;
	setModel(model: ModelLike): Promise<boolean>;
}

/** `provider/model`, split at the first slash (model ids may hold slashes of their own). */
export function parseModelRef(value: string | undefined): ModelLike | undefined {
	const ref = value?.trim() ?? '';
	const slash = ref.indexOf('/');
	if (slash <= 0 || slash === ref.length - 1) {
		return undefined;
	}
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/** The refusal that ended the run: the last assistant message, when it stopped on an error. */
export function refusalOf(messages: readonly unknown[]): ProviderFailure | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: unknown; stopReason?: unknown; errorMessage?: unknown; provider?: unknown; model?: unknown } | null;
		if (message?.role !== 'assistant') {
			continue;
		}
		if (message.stopReason !== 'error' || typeof message.errorMessage !== 'string') {
			return undefined;
		}
		return {
			provider: typeof message.provider === 'string' ? message.provider : '',
			model: typeof message.model === 'string' ? message.model : '',
			message: message.errorMessage,
		};
	}
	return undefined;
}

export default function subagentModelFallback(pi: FallbackPi, env: NodeJS.ProcessEnv = process.env): void {
	if (env[SUBAGENT_ENV] !== '1') {
		return;
	}
	let switched = false;
	pi.on('agent_before_settle', async (event, ctx) => {
		if (switched || event.outcome !== 'error') {
			return undefined;
		}
		const refusal = refusalOf(event.context.contextMessages);
		if (refusal === undefined || !canTryAnotherModel(refusal.message)) {
			return undefined;
		}
		const target = parseModelRef(env[CHAT_MODEL_ENV]);
		if (target === undefined || (target.provider === refusal.provider && target.id === refusal.model)) {
			return undefined;
		}
		const model = ctx.modelRegistry.find(target.provider, target.id);
		if (model === undefined) {
			return undefined;
		}
		try {
			if (!(await pi.setModel(model))) {
				return undefined;
			}
		} catch {
			return undefined;
		}
		switched = true;
		return {
			entries: [{
				type: 'custom_message',
				customType: 'picode-model-fallback',
				display: false,
				content: `The previous model could not answer (${describeFailure(refusal)}). You are now running on ${target.provider}/${target.id}. Carry on with the task from where it stopped.`,
			}],
			continue: true,
		};
	});
}
