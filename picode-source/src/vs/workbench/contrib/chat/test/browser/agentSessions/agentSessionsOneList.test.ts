/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { AgentSessionProviders } from '../../../browser/agentSessions/agentSessions.js';
import { AgentSessionStatus } from '../../../browser/agentSessions/agentSessionsModel.js';
import { DEFAULT_EXCLUDES, DURABLE_SESSION_PROVIDER, normalizedExcludes, PI_TRANSCRIPT_SESSION_PROVIDER, RETIRED_SESSION_PROVIDERS } from '../../../browser/agentSessions/agentSessionsFilter.js';

/**
 * The owner retired the whole question of which list the panel shows:
 * «dejemos de filtrar por durable, pi o local». The panel shows **the one list** — the
 * conversations that live in durable (pi thinks, durable remembers) — and the retired providers
 * (`Local`, the editor's duplicate record; `pi`, the transcripts of the CLI and of imports)
 * never appear and are never offered as a filter.
 */
suite('Agent Sessions Filter — one list, no filter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the one list is pi\u2019s transcripts, and only pi\u2019s', () => {
		// The retired providers start excluded and pi starts visible; nothing else starts hidden.
		assert.deepStrictEqual([...DEFAULT_EXCLUDES.providers].sort(), [...RETIRED_SESSION_PROVIDERS].sort());
		assert.ok(!DEFAULT_EXCLUDES.providers.includes(DURABLE_SESSION_PROVIDER));
	});

	test('durable can never be hidden, however the filter was stored', () => {
		// An install that still offered the provider toggles may have stored `pi` hidden and a
		// retired provider visible; normalization must undo both, not trust the stored state.
		const stored = normalizedExcludes({
			providers: [DURABLE_SESSION_PROVIDER, AgentSessionProviders.AgentHostCopilot],
			states: [],
			archived: true,
			read: false,
			repositoryGroupCapped: true,
		});
		assert.ok(!stored.providers.includes(DURABLE_SESSION_PROVIDER));
		for (const retired of RETIRED_SESSION_PROVIDERS) {
			assert.ok(stored.providers.includes(retired));
		}
		// A provider the one-list rule says nothing about keeps its own stored state, and the
		// retired `pi` transcripts keep their stored exclusion.
		assert.ok(stored.providers.includes(AgentSessionProviders.AgentHostCopilot));
		assert.ok(stored.providers.includes(PI_TRANSCRIPT_SESSION_PROVIDER));
	});

	test('the stored state is carried through, not replaced', () => {
		// Normalization only fixes the providers; the state toggles are the owner's own choices.
		const stored = normalizedExcludes({
			providers: [],
			states: [AgentSessionStatus.Failed],
			archived: false,
			read: true,
			repositoryGroupCapped: false,
		});
		assert.deepStrictEqual(stored.states, [AgentSessionStatus.Failed]);
		assert.strictEqual(stored.archived, false);
		assert.strictEqual(stored.read, true);
		assert.strictEqual(stored.repositoryGroupCapped, false);
	});
});
