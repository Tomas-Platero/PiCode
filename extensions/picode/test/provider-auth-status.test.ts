/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerCredentialNeedsAttention } from '../src/subscriptions.ts';

test('only a stored credential that cannot resolve needs attention', () => {
	assert.equal(providerCredentialNeedsAttention({ getProviderAuthStatus: () => ({ configured: false, source: 'stored' }) }, 'example'), true);
	assert.equal(providerCredentialNeedsAttention({ getProviderAuthStatus: () => ({ configured: true, source: 'stored' }) }, 'example'), false);
	assert.equal(providerCredentialNeedsAttention({ getProviderAuthStatus: () => ({ configured: false, source: 'none' }) }, 'example'), false);
	assert.equal(providerCredentialNeedsAttention({}, 'example'), false);
});
