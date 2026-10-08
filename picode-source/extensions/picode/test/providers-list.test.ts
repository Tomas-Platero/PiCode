/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The providers the host has, and where each one came from.
 *
 * The owner's report is the test: «El proveedor de nan no me sale en la lista de providers, revisa
 * esto. Si te das cuenta en picode:status salen 2 proveedores.» One provider was declared in PiCode's
 * settings and the other existed only as a sign-in in pi's profile, and the panel's count merged them
 * while the settings page could only show the declared one.
 */

import * as assert from 'assert';
import { test } from 'node:test';
import { providerInventory } from '../src/providers-list.ts';

test('a provider carried by pi is a row, and it is not declared', () => {
	// Exactly his profile: `omni` declared (and with models), `nan` only as a sign-in.
	const rows = providerInventory(['omni'], ['omni'], ['nan']);

	assert.deepStrictEqual(rows.map(row => row.id), ['nan', 'omni']);
	assert.deepStrictEqual(rows[0], { id: 'nan', declared: false, models: false, credential: true });
	// Which is the answer the panel has to give: why one can be edited where the other cannot.
	assert.strictEqual(rows[1].declared, true);
	assert.strictEqual(rows[1].models, true);
	assert.strictEqual(rows[1].credential, false);
});

test('one provider in several sources is one row, not three', () => {
	// A declaration writes models **and** a key, so the common case is all three at once.
	const rows = providerInventory(['omni'], ['omni'], ['omni']);
	assert.strictEqual(rows.length, 1);
	assert.deepStrictEqual(rows[0], { id: 'omni', declared: true, models: true, credential: true });
});

test('ids are trimmed, blanks are not providers, and the order is by name', () => {
	const rows = providerInventory(['  zeta  '], [], ['', '   ', 'alpha']);
	assert.deepStrictEqual(rows.map(row => row.id), ['alpha', 'zeta']);
	assert.deepStrictEqual(rows[1], { id: 'zeta', declared: true, models: false, credential: false });
});

test('nothing anywhere is an empty list, not a row without an id', () => {
	assert.deepStrictEqual(providerInventory([], [], []), []);
});
