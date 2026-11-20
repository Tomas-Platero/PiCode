/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isSecretReference, piProfilePartOf, restoreSecrets, scrubSecrets, skippedPiProfileParts } from '../../common/piProfileContent.js';

suite('PiProfileContent', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const models = {
		providers: {
			omni: { baseUrl: 'https://omni.example/v1', api: 'openai-completions', apiKey: 'sk-live-1234567890abcdef', models: [{ id: 'm1' }] },
			local: { baseUrl: 'http://localhost:1234/v1', apiKey: 'LOCAL_KEY', headers: { 'X-Team': 'Bearer ${TEAM_TOKEN}', 'X-Secret': 'abc.def.ghi' } },
		},
	};
	const mcp = {
		mcpServers: {
			aikido: { command: 'npx', args: ['-y', '@aikidosec/mcp'], env: { AIKIDO_API_KEY: 'ak_1234567890', LOG_LEVEL: '${LOG_LEVEL}' } },
			github: { url: 'https://api.github.example/mcp', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } },
			vercel: { url: 'https://mcp.vercel.example', headers: { Authorization: 'Bearer vc_abcdefghijklmnop' } },
		},
	};

	test('a value that only points at a key is a reference', () => {
		for (const value of ['OMNI_KEY', '$OMNI_KEY', '${OMNI_KEY}', '${env:OMNI_KEY}', 'Bearer ${GITHUB_TOKEN}', '!op read op://vault/omni', '', undefined, 3]) {
			assert.strictEqual(isSecretReference(value), true, String(value));
		}
		for (const value of ['sk-live-1234567890abcdef', 'Bearer vc_abcdefghijklmnop', 'abc.def.ghi', 'Bearer ${TOKEN}extra', 'AKIAIOSFODNN7EXAMPLE']) {
			assert.strictEqual(isSecretReference(value), false, String(value));
		}
	});

	test('models.json leaves without the keys written in full', () => {
		const scrubbed = JSON.parse(scrubSecrets('models.json', JSON.stringify(models))!);
		assert.strictEqual(scrubbed.providers.omni.apiKey, undefined);
		assert.strictEqual(scrubbed.providers.omni.baseUrl, 'https://omni.example/v1');
		assert.deepStrictEqual(scrubbed.providers.omni.models, [{ id: 'm1' }]);
		assert.strictEqual(scrubbed.providers.local.apiKey, 'LOCAL_KEY');
		assert.deepStrictEqual(scrubbed.providers.local.headers, { 'X-Team': 'Bearer ${TEAM_TOKEN}' });
	});

	test('mcp.json leaves without the keys written in full, servers and references kept', () => {
		const text = scrubSecrets('mcp.json', JSON.stringify(mcp))!;
		const scrubbed = JSON.parse(text);
		assert.deepStrictEqual(Object.keys(scrubbed.mcpServers), ['aikido', 'github', 'vercel']);
		assert.deepStrictEqual(scrubbed.mcpServers.aikido.env, { LOG_LEVEL: '${LOG_LEVEL}' });
		assert.deepStrictEqual(scrubbed.mcpServers.aikido.args, ['-y', '@aikidosec/mcp']);
		assert.deepStrictEqual(scrubbed.mcpServers.github.headers, { Authorization: 'Bearer ${GITHUB_TOKEN}' });
		assert.deepStrictEqual(scrubbed.mcpServers.vercel.headers, {});
		assert.ok(!text.includes('ak_1234567890') && !text.includes('vc_abcdefghijklmnop'));
	});

	test('the sign-in secret of an MCP server stays home too', () => {
		const scrubbed = JSON.parse(scrubSecrets('mcp.json', JSON.stringify({ mcpServers: { jira: { url: 'https://jira.example', oauth: { clientId: 'CLIENT_ID', clientSecret: 'cs-9876543210' } } } }))!);
		assert.deepStrictEqual(scrubbed.mcpServers.jira.oauth, { clientId: 'CLIENT_ID' });
	});

	test('a file that is not JSON is not sent at all', () => {
		assert.strictEqual(scrubSecrets('models.json', '{ "providers": '), undefined);
		assert.strictEqual(scrubSecrets('mcp.json', '[]'), undefined);
	});

	test('scrubbing twice gives the same file, so an unchanged file is not sent again', () => {
		const once = scrubSecrets('mcp.json', JSON.stringify(mcp))!;
		assert.strictEqual(scrubSecrets('mcp.json', once), once);
	});

	test('a file that comes down gets this computer\'s keys back', () => {
		const incoming = scrubSecrets('mcp.json', JSON.stringify({ mcpServers: { ...mcp.mcpServers, extra: { url: 'https://extra.example' } } }))!;
		const restored = JSON.parse(restoreSecrets('mcp.json', incoming, JSON.stringify(mcp)));
		assert.deepStrictEqual(restored.mcpServers.aikido.env, { LOG_LEVEL: '${LOG_LEVEL}', AIKIDO_API_KEY: 'ak_1234567890' });
		assert.deepStrictEqual(restored.mcpServers.vercel.headers, { Authorization: 'Bearer vc_abcdefghijklmnop' });
		assert.deepStrictEqual(restored.mcpServers.extra, { url: 'https://extra.example' });

		const models2 = JSON.parse(restoreSecrets('models.json', scrubSecrets('models.json', JSON.stringify(models))!, JSON.stringify(models)));
		assert.deepStrictEqual(models2, models);
	});

	test('a key is never taken from the cloud, and a provider removed elsewhere stays removed', () => {
		const incoming = JSON.stringify({ providers: { other: { baseUrl: 'https://other.example' } } });
		const restored = JSON.parse(restoreSecrets('models.json', incoming, JSON.stringify(models)));
		assert.deepStrictEqual(restored, { providers: { other: { baseUrl: 'https://other.example' } } });
		assert.strictEqual(restoreSecrets('models.json', incoming, undefined), incoming);
	});

	test('a reference that came down wins over the key this computer had', () => {
		const incoming = JSON.stringify({ providers: { omni: { baseUrl: 'https://omni.example/v1', apiKey: 'OMNI_KEY' } } });
		const restored = JSON.parse(restoreSecrets('models.json', incoming, JSON.stringify(models)));
		assert.strictEqual(restored.providers.omni.apiKey, 'OMNI_KEY');
	});

	test('every file belongs to the row that shows it', () => {
		const cases: [string, string][] = [
			['agents/reviewer.md', 'agents'], ['chains/4r-review.chain.md', 'agents'], ['specpi/x.md', 'agents'],
			['subagents/a.md', 'subagents'], ['subagents.json', 'subagents'],
			['skills/web-preview/SKILL.md', 'skills'],
			['gentle-ai/profiles.json', 'agentProfiles'], ['gentle-ai/profile-fallbacks.json', 'agentProfiles'], ['gentle-ai/models.json', 'agentProfiles'],
			['mcp.json', 'mcp'], ['mcp-adapter.json', 'mcp'],
			['models.json', 'models'],
			['settings.json', 'agentSettings'], ['trust.json', 'agentSettings'], ['gentle-ai/persona.json', 'agentSettings'], ['gentle-ai/permission-mode.json', 'agentSettings'],
			['memory/daily/2026-10-07.md', 'memory'],
		];
		for (const [key, part] of cases) {
			assert.strictEqual(piProfilePartOf(key), part, key);
		}
	});

	test('the switched-off parts are read leniently', () => {
		assert.deepStrictEqual([...skippedPiProfileParts(['memory', 'nope', 3, 'mcp'])], ['memory', 'mcp']);
		assert.deepStrictEqual([...skippedPiProfileParts(undefined)], []);
		assert.deepStrictEqual([...skippedPiProfileParts('memory')], []);
	});
});
