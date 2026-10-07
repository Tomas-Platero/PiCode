// Loads the owner's pi agent profile (READ-ONLY) and builds a pi-ai provider
// for the OmniRoute LAN gateway described in it. Credentials, if any, are read
// at runtime from the profile's auth.json and are never copied or logged.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProvider } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

/**
 * The profile to read when the editor did not name one.
 *
 * PiCode always names it (`PI_AGENT_PROFILE`), because the editor is the one that knows which
 * installation this is. This fallback is for the agent started by hand, and it is derived from
 * where the agent itself lives — `<app>/resources/pi-durable` carries the program, so the profile
 * is `<app>/data/pi-agent`, two levels up and back down. It used to be one machine's absolute
 * path, which was wrong for every install but the one it was written on: the agent ships inside
 * PiCode now, and "wherever PiCode is installed" has to hold for a human running the cli too.
 */
export const DEFAULT_PROFILE_DIR =
	process.env.PI_AGENT_PROFILE || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "pi-agent");

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
 * The plain, actionable reason this profile cannot back a model run — or null when it can.
 *
 * A profile with no provider is a normal state (a fresh install has one), so this is a
 * reported condition, never a crash: the daemon stays up and serves ping/sessions/
 * subscribe, and only a run (or fork) fails — with exactly this sentence. Every way a
 * models.json can be unusable is named here: missing, unreadable, not JSON, no providers
 * block, the named provider absent, the provider listing no usable model.
 */
export function profileModelProblem(profileDir = DEFAULT_PROFILE_DIR, providerId = process.env.PI_AGENT_PROVIDER || "omni") {
	const file = join(profileDir, "models.json");
	let raw;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") {
			return `the agent profile at ${profileDir} has no models.json — no model provider is set up, and the agent cannot run a prompt until one is configured there`;
		}
		return `the agent profile's models.json at ${profileDir} could not be read (${error?.message ?? error}) — the agent cannot run a prompt until it is fixed`;
	}
	let profile;
	try {
		profile = JSON.parse(raw);
	} catch (error) {
		return `${file} is empty or not valid JSON (${error?.message ?? error}) — the agent cannot run a prompt until a model provider is configured in it`;
	}
	const providers = profile?.providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
		return `${file} has no "providers" block — the agent cannot run a prompt until a model provider is configured there`;
	}
	const prov = providers[providerId];
	if (!prov || typeof prov !== "object") {
		const known = Object.keys(providers).join(", ") || "none";
		return `${file} has no provider "${providerId}" (providers present: ${known}) — the agent cannot run a prompt until that provider is configured there, or the model setting names one that exists`;
	}
	const usable = (Array.isArray(prov.models) ? prov.models : []).filter((m) => m?.api === "openai-responses");
	if (usable.length === 0) {
		const listed = Array.isArray(prov.models) ? `${prov.models.length} model(s), none with api "openai-responses"` : "no models";
		return `provider "${providerId}" in ${file} has ${listed} — the agent cannot run a prompt until it lists a model with api "openai-responses"`;
	}
	if (typeof prov.baseUrl !== "string" || prov.baseUrl.length === 0) {
		return `provider "${providerId}" in ${file} has no baseUrl — the agent cannot run a prompt until the provider says where its gateway is`;
	}
	return null;
}

/**
 * Build a pi-ai Provider from the profile's `providers.<providerId>` block.
 * The gateway speaks the OpenAI Responses API (`api: "openai-responses"`).
 * The profile says `auth: "none"` and there is no auth.json entry for it, so
 * auth resolves as "configured, keyless" — pi-ai sends no Authorization header
 * and the gateway accepts the request (verified: POST /v1/responses → 200).
 */
export function loadOmniProvider(profileDir = DEFAULT_PROFILE_DIR, providerId = process.env.PI_AGENT_PROVIDER || "omni") {
	const problem = profileModelProblem(profileDir, providerId);
	if (problem) throw new Error(problem); // the same sentence the daemon reports, never a raw ENOENT
	// The guard above read this very file and returned null, so it is proven present, readable,
	// parseable and complete before this line runs: a try/catch here would only hide that the guard
	// is where a broken profile is meant to be reported, in one sentence rather than a SyntaxError.
	const profile = JSON.parse(readFileSync(join(profileDir, "models.json"), "utf8"));
	const prov = profile.providers[providerId];

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
