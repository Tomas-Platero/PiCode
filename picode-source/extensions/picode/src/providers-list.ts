/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The providers the host's profile knows, and **how** the editor knows each one.
 *
 * There are three sources, and they are not the same thing:
 *
 * - **declared**: a row in PiCode's own settings (`picode.providers`), which is what the settings
 *   page edits — the name, the address, the dialect and the key;
 * - **models**: the profile's `models.json` carries models for it — what pi itself reads, whether
 *   the models came from a declaration or from a package the owner installed;
 * - **credential**: the profile's `auth.json` holds a sign-in for it — a subscription or an account
 *   the owner connected, which is nobody's to declare in a settings row.
 *
 * The status panel counted the union and said «Providers 2» while the settings page listed one row,
 * and the owner read the disagreement as a missing provider: «El proveedor de nan no me sale en la
 * lista de providers, revisa esto. Si te das cuenta en picode:status salen 2 proveedores.» Both were
 * right about their own question. Keeping the three apart is what lets the panel answer the one he
 * actually asked — *which two?* — and say why one of them cannot be edited where the other is.
 *
 * No `vscode` import: the merge is a pure function of three lists, so the rules can be exercised by
 * running them.
 */

/** One provider of the host's profile, with where the editor learned about it. */
export interface PiProviderRow {
	readonly id: string;
	/** PiCode's settings declare it — the row the settings page can edit. */
	readonly declared: boolean;
	/** The profile carries models for it. */
	readonly models: boolean;
	/** The profile carries a credential (a sign-in) for it. */
	readonly credential: boolean;
}

/**
 * The union of the three sources, one row per provider, ordered by name.
 *
 * A provider can be in more than one source at once (a declaration writes models **and** a key), and
 * that is a row with several origins rather than several rows: the question is which providers the
 * host has, and it has one of each.
 */
export function providerInventory(
	declared: readonly string[],
	fromModels: readonly string[],
	fromCredentials: readonly string[],
): PiProviderRow[] {
	const byId = new Map<string, { declared: boolean; models: boolean; credential: boolean }>();
	const mark = (id: string, what: 'declared' | 'models' | 'credential'): void => {
		const trimmed = id.trim();
		if (trimmed.length === 0) {
			return;
		}
		const entry = byId.get(trimmed) ?? { declared: false, models: false, credential: false };
		entry[what] = true;
		byId.set(trimmed, entry);
	};
	for (const id of declared) {
		mark(id, 'declared');
	}
	for (const id of fromModels) {
		mark(id, 'models');
	}
	for (const id of fromCredentials) {
		mark(id, 'credential');
	}
	return [...byId.entries()]
		.map(([id, origins]) => ({ id, ...origins }))
		.sort((left, right) => compareText(left.id, right.id));
}

/** A text order that depends on the text alone — no locale, so the same answer on any machine. */
function compareText(left: string, right: string): number {
	if (left === right) {
		return 0;
	}
	return left < right ? -1 : 1;
}
