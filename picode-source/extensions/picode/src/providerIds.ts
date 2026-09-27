/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Model ids, in the two shapes this product passes them between.
 *
 * The editor qualifies a model with its vendor and our provider qualifies it with the provider
 * the model came from, so the id the chat hands a participant is
 * `picode/<provider>/<model>` — and the model id itself may contain slashes
 * (`anthropic/claude-sonnet-4` inside the `omni` provider). Splitting it is therefore a decision
 * with a rule, not a `split('/')`: only the first segment is the provider.
 *
 * One module for it, because two places take a qualified id apart — the model list that builds
 * them and the chat that gets one back — and a second rule would be a second answer.
 *
 * No `vscode` import, so it can be exercised by running it.
 */

/** A model id, split into the provider that serves it and the model's own id. */
export interface ModelRef {
	readonly providerId: string;
	readonly modelId: string;
}

/**
 * Splits a qualified id, keeping everything after the first slash as the model.
 *
 * An id with no slash is read as a model of an unknown provider rather than as a provider with no
 * model: that is what an id the editor built without a provider looks like, and it must not be
 * sent to an endpoint as a model id nobody meant.
 */
export function splitModelId(qualified: string): ModelRef {
	const cut = qualified.indexOf('/');
	return cut === -1
		? { providerId: '', modelId: qualified }
		: { providerId: qualified.slice(0, cut), modelId: qualified.slice(cut + 1) };
}

/**
 * The provider and model behind the editor's own model object, or `undefined` when it is not one
 * of ours.
 *
 * The vendor is checked rather than assumed: the chat can be talking to a model another provider
 * supplied, and handing that id to pi would ask for a model that does not exist there.
 */
export function modelRefOf(model: { readonly vendor?: string; readonly id: string } | undefined, vendor: string): ModelRef | undefined {
	if (model === undefined || model.vendor !== vendor) {
		return undefined;
	}
	const withoutVendor = model.id.startsWith(`${vendor}/`) ? model.id.slice(vendor.length + 1) : model.id;
	const ref = splitModelId(withoutVendor);
	return ref.providerId.length === 0 || ref.modelId.length === 0 ? undefined : ref;
}
