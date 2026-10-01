/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DEFAULT_DIALECT, isRecord, type ProviderDeclaration } from './declarations';
import { fetchModelIds } from './endpoint';

/**
 * The editor's side of connecting a model provider.
 *
 * What a provider **is** and where pi finds it lives elsewhere: `declarations.ts` owns the
 * lines the owner writes in the settings list and the projection of those lines into pi's own
 * files, and `endpoint.ts` owns asking an endpoint what models it has. What is left here is
 * the part that needs the editor — the provider the editor's model list asks about, and the
 * one command that opens the editor's own provider surface.
 *
 * ## The two ways in, and why the dialogs are gone
 *
 * The first version of this flow asked four questions in four floating boxes (name, address,
 * dialect, key). The owner's answer was blunt: *"no quiero la ventanita de arriba, quiero
 * añadir items abajo con sus campos necesarios"*. So:
 *
 * - the **settings row** under Chat is a form: one row per provider, with its four fields, added
 *   in place (`declarations.ts` reads what it holds), and
 * - the **editor's own provider form** is the other way in, with the key kept as a secret — its
 *   values arrive here as `options.configuration`.
 *
 * A provider with a **subscription** (ChatGPT Plus/Pro, Claude Pro/Max…) is neither: it has no
 * address to declare, so it is a list and a login, in `login.ts`.
 */

/**
 * The row under Chat links to this id, so the id stays: what changed is what it does.
 *
 * It is where the owner connects a provider **with a subscription**: pi's catalogue, the login,
 * one list. The endpoints with an address and a dialect are declared in the settings row's own
 * form and never come through here, and the editor's own provider screen is reached the way any
 * editor surface is — from the model picker.
 */
export const CONNECT_PROVIDER_COMMAND = 'picode.connectProvider';

/** The vendor pi and the editor both use for this product. */
const VENDOR = 'picode';

/* ------------------------------------------------------------------ *
 * The editor's own configuration
 * ------------------------------------------------------------------ */

/**
 * What the owner fills in, in the editor's own configuration for this provider.
 *
 * These are the fields **declared in the contribution**, which the editor renders itself — with
 * the key marked as a secret, so it is stored encrypted and never shown back. No dialog of ours
 * is involved, which is the whole reason this path exists.
 */
export interface ProviderConfiguration {
	readonly id?: string;
	readonly endpoint?: string;
	readonly api?: string;
	readonly apiKey?: string;
}

/** The declared fields, read defensively: these values are typed by a person. */
export function readConfiguration(raw: unknown): ProviderConfiguration {
	if (!isRecord(raw)) {
		return {};
	}
	const text = (key: string): string | undefined => {
		const value = raw[key];
		return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
	};
	return {
		...(text('id') === undefined ? {} : { id: text('id') }),
		...(text('endpoint') === undefined ? {} : { endpoint: text('endpoint') }),
		...(text('api') === undefined ? {} : { api: text('api') }),
		...(text('apiKey') === undefined ? {} : { apiKey: text('apiKey') }),
	};
}

/** One edge of the configuration, as the projection reads it: a declaration without id rules. */
export function declarationFrom(config: ProviderConfiguration): ProviderDeclaration | undefined {
	if (config.endpoint === undefined) {
		return undefined;
	}
	return {
		id: (config.id ?? 'pi').toLowerCase(),
		baseUrl: config.endpoint.replace(/\/$/, ''),
		api: config.api ?? DEFAULT_DIALECT,
		...(config.apiKey === undefined ? {} : { key: config.apiKey }),
	};
}

/**
 * The models the configured endpoint answers with, in the editor's model shape.
 *
 * Read from the endpoint itself and not from the profile, because this is the one path where
 * the owner just typed the address: a list of models read from a file written by a different
 * flow is exactly the confusion this path exists to remove.
 */
export async function modelsForConfiguration(config: ProviderConfiguration): Promise<vscode.LanguageModelChatInformation[]> {
	if (config.endpoint === undefined) {
		return [];
	}
	const id = (config.id ?? 'pi').toLowerCase();
	const ids = (await fetchModelIds(config.endpoint, config.apiKey)) ?? [];
	return ids.map(model => ({
		id: `${id}/${model}`,
		name: model,
		family: id,
		version: '1',
		maxInputTokens: 128000,
		maxOutputTokens: 16384,
		detail: id,
		capabilities: { toolCalling: true },
	}));
}

/** The vendor the editor's model list groups these under. */
export { VENDOR };
