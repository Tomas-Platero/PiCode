// Loads the owner's pi agent profile (READ-ONLY) and builds a pi-ai provider
// for the OmniRoute LAN gateway described in it. Credentials, if any, are read
// at runtime from the profile's auth.json and are never copied or logged.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createProvider } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

export const DEFAULT_PROFILE_DIR =
	process.env.PI_AGENT_PROFILE || "C:/Users/tapla/AppData/Local/Programs/PiCode/data/pi-agent";

/** READ-ONLY peek at the profile's auth.json for this provider's key, if any. */
function readAuthKey(profileDir, providerId) {
	try {
		const auth = JSON.parse(readFileSync(join(profileDir, "auth.json"), "utf8"));
		const entry = auth[providerId];
		return typeof entry?.key === "string" && entry.key.length > 0 ? entry.key : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Build a pi-ai Provider from the profile's `providers.<providerId>` block.
 * The gateway speaks the OpenAI Responses API (`api: "openai-responses"`).
 * The profile says `auth: "none"` and there is no auth.json entry for it, so
 * auth resolves as "configured, keyless" — pi-ai sends no Authorization header
 * and the gateway accepts the request (verified: POST /v1/responses → 200).
 */
export function loadOmniProvider(profileDir = DEFAULT_PROFILE_DIR, providerId = process.env.PI_AGENT_PROVIDER || "omni") {
	const profile = JSON.parse(readFileSync(join(profileDir, "models.json"), "utf8"));
	const prov = profile.providers[providerId];
	if (!prov) throw new Error(`provider "${providerId}" not found in ${join(profileDir, "models.json")}`);

	const compat = (m) => ({
		sessionAffinityFormat: m?.compat?.sessionAffinityFormat ?? prov.compat?.sessionAffinityFormat,
		supportsLongCacheRetention: m?.compat?.supportsLongCacheRetention ?? prov.compat?.supportsLongCacheRetention,
		supportsMaxOutputTokens: m?.compat?.supportsMaxOutputTokens ?? prov.compat?.supportsMaxOutputTokens,
	});

	const models = (prov.models ?? [])
		.filter((m) => m.api === "openai-responses")
		.map((m) => ({
			id: m.id,
			name: m.name ?? m.id,
			provider: providerId,
			api: "openai-responses",
			baseUrl: prov.baseUrl, // per-model: the SDK posts to model.baseUrl, not provider.baseUrl
			reasoning: m.reasoning === true,
			contextWindow: m.contextWindow ?? 128000,
			maxTokens: m.maxTokens ?? 16384,
			input: m.input ?? ["text"],
			cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [] },
			compat: compat(m),
		}));

	return createProvider({
		id: providerId,
		name: `OmniRoute LAN gateway (${providerId})`,
		baseUrl: prov.baseUrl,
		auth: {
			apiKey: {
				name: "OmniRoute gateway key",
				resolve: async ({ credential }) => {
					const key = credential?.key ?? readAuthKey(profileDir, providerId);
					if (key) return { auth: { apiKey: key }, source: "profile auth.json" };
					// The profile says auth: "none" and there is no auth.json entry. The
					// gateway accepts any bearer value on the chat endpoint (verified:
					// POST /v1/responses with `authorization: Bearer test` -> 200), but the
					// openai-responses API refuses a request with no apiKey at all. Send a
					// clearly non-secret placeholder — no credential is invented or stored.
					return {
						auth: { apiKey: "keyless-gateway" },
						source: "keyless (profile auth: none)",
					};
				},
			},
		},
		models,
		api: openAIResponsesApi(),
	});
}
