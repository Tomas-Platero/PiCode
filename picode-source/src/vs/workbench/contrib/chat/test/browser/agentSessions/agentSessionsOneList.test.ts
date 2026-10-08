/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { AgentSessionProviders } from '../../../browser/agentSessions/agentSessions.js';
import { DEFAULT_EXCLUDES, excludesAfterToggle, ONE_LIST_SESSION_PROVIDERS, PI_TRANSCRIPT_SESSION_PROVIDER } from '../../../browser/agentSessions/agentSessionsFilter.js';

/**
 * PiCode records its own conversations twice — the editor's `Local` sessions and pi's transcripts —
 * and the owner asked for one list at a time: «Me gustaría que siempre filtrara por defecto por las
 * "local" y luego yo si quiero poner las externas, nunca ambas juntas».
 */
suite('Agent Sessions Filter — one list at a time', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the panel opens on the editor\u2019s list', () => {
		// pi's transcripts are the same conversations recorded a second time, so they start hidden
		// and the editor's own sessions are what the panel shows.
		assert.deepStrictEqual([...DEFAULT_EXCLUDES.providers], [PI_TRANSCRIPT_SESSION_PROVIDER]);
		assert.ok(!DEFAULT_EXCLUDES.providers.includes(AgentSessionProviders.Local));
	});

	test('showing one half of the list hides the other', () => {
		// `excludes` holds what is hidden. Turning pi on must hide Local, and the other way round:
		// that is the "never both" the owner asked for.
		assert.deepStrictEqual(excludesAfterToggle([PI_TRANSCRIPT_SESSION_PROVIDER], PI_TRANSCRIPT_SESSION_PROVIDER), [AgentSessionProviders.Local]);
		assert.deepStrictEqual(excludesAfterToggle([AgentSessionProviders.Local], AgentSessionProviders.Local), [PI_TRANSCRIPT_SESSION_PROVIDER]);
	});

	test('hiding one does not reveal the other', () => {
		// Turning a provider *off* keeps the other half exactly as it was; the group only moves when
		// one of them is turned back on.
		assert.deepStrictEqual(excludesAfterToggle([], PI_TRANSCRIPT_SESSION_PROVIDER), [PI_TRANSCRIPT_SESSION_PROVIDER]);
		assert.deepStrictEqual(excludesAfterToggle([PI_TRANSCRIPT_SESSION_PROVIDER], AgentSessionProviders.Local), [PI_TRANSCRIPT_SESSION_PROVIDER, AgentSessionProviders.Local]);
	});

	test('a provider outside the group is untouched', () => {
		// The rule is about the two views of PiCode's own conversations, not about every provider a
		// user might have: another agent's list keeps its own state.
		const other = AgentSessionProviders.AgentHostCopilot;
		assert.ok(!ONE_LIST_SESSION_PROVIDERS.includes(other));
		assert.deepStrictEqual(excludesAfterToggle([PI_TRANSCRIPT_SESSION_PROVIDER], other), [PI_TRANSCRIPT_SESSION_PROVIDER, other]);
	});
});
