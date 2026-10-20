// lib/settings.js — the durable agent reads PiCode's own settings.
//
// Reading the editor's user settings file directly is deliberate: these options
// belong in the editor (`picode.durable.*`, declared in
// `picode-source/src/vs/workbench/contrib/picode/browser/picodeConfiguration.ts`),
// but this program is not inside the editor yet — it is run by hand from the
// repository, outside PiCode, so there is no settings service to ask. The file
// is opened READ-ONLY and only the `picode.durable.*` keys are picked out.
// When the agent is eventually hosted by the editor this file read is replaced
// by whatever the editor hands it; the keys and the precedence stay the same.
//
// Precedence for every option: command-line flag > setting > built-in default.
// (For the model only, environment variables sit between the setting and the
// built-in default, because PI_AGENT_MODEL/PI_AGENT_PROVIDER are the override
// the agent has always had: flag > setting > env > default.)
//
// Every effective option is reported on stderr, one line, so nobody has to
// guess why the agent behaved as it did:
//   [settings] mcp=on (picode.durable.mcp)
//   [settings] guard=on (default)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the editor keeps its user settings. Override with PICODE_USER_SETTINGS
 * (used by the verification runs to point at a temporary file).
 */
export function userSettingsPath() {
	if (process.env.PICODE_USER_SETTINGS) return process.env.PICODE_USER_SETTINGS;
	if (process.platform === "win32") {
		const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
		return join(appData, "PiCode", "User", "settings.json");
	}
	// Off Windows, PiCode follows the same layout as VS Code.
	return join(homedir(), ".config", "PiCode", "User", "settings.json");
}

/** The option name → the settings key it maps to. */
export const DURABLE_KEYS = {
	mcp: "picode.durable.mcp",
	guard: "picode.durable.guard",
	model: "picode.durable.model",
	agent: "picode.durable.agent",
};

/** The types the settings must have; anything else is a typo and is reported. */
const EXPECTED_TYPES = { mcp: "boolean", guard: "boolean", model: "string", agent: "string" };

/** Built-in defaults, used when neither a flag nor a setting says otherwise. */
export const DURABLE_DEFAULTS = {
	mcp: true, // the MCP bridge is on (today's behaviour without --no-mcp)
	guard: true, // the deterministic guard is on (today's always-on behaviour)
	model: "omni/auto", // same as common.js: provider omni, modelId auto
	agent: undefined, // no profile agent
};

/**
 * Strip `//` line comments and `/*` block comments the way the editor tolerates
 * them in its settings (it is JSONC, not strict JSON). Strings are respected —
 * a `//` inside a string value is left alone.
 */
function stripComments(text) {
	let out = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (inString) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++; // skip the closing '/'
			continue;
		}
		out += ch;
	}
	return out;
}

function typeName(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/**
 * Read the editor's user settings file (READ-ONLY) and pick out the
 * `picode.durable.*` keys.
 *
 * Never throws. A missing file, unreadable JSON, or a key of the wrong type
 * falls back to the default — and says so, in `notes`, so a typo'd setting is
 * never silently ignored.
 *
 * @returns {{ path: string, values: Record<string, boolean|string>, notes: string[] }}
 */
export function readDurableSettings(settingsPath = userSettingsPath()) {
	const out = { path: settingsPath, values: {}, notes: [] };
	let raw;
	try {
		raw = readFileSync(settingsPath, "utf8");
	} catch (error) {
		if (error?.code !== "ENOENT") {
			out.notes.push(`${settingsPath} could not be read (${error?.message ?? error}) — defaults in effect`);
		} else {
			out.notes.push(`no PiCode settings file at ${settingsPath} — defaults in effect`);
		}
		return out;
	}
	let parsed;
	try {
		parsed = JSON.parse(stripComments(raw));
	} catch (error) {
		out.notes.push(`${settingsPath} is not valid JSON (${error?.message ?? error}) — defaults in effect`);
		return out;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		out.notes.push(`${settingsPath} does not hold a settings object — defaults in effect`);
		return out;
	}
	for (const [option, key] of Object.entries(DURABLE_KEYS)) {
		const value = parsed[key];
		if (value === undefined) continue;
		if (typeof value !== EXPECTED_TYPES[option] || value === null) {
			out.notes.push(`${key}: expected ${EXPECTED_TYPES[option]}, got ${typeName(value)} — ignored, default in effect`);
			continue;
		}
		const cleaned = typeof value === "string" ? value.trim() : value;
		if (typeof cleaned === "string" && cleaned === "") {
			out.notes.push(`${key}: empty string — ignored, default in effect`);
			continue;
		}
		out.values[option] = cleaned;
	}
	return out;
}

/** `"omni/auto"` → `{ provider: "omni", modelId: "auto" }`; anything without a `/` is null. */
export function parseModelSetting(value) {
	const text = String(value ?? "").trim();
	const slash = text.indexOf("/");
	if (slash <= 0 || slash === text.length - 1) return null;
	return { provider: text.slice(0, slash), modelId: text.slice(slash + 1) };
}

/**
 * Apply the precedence: flag > setting > (model only: env) > default.
 *
 * `flags` carries what the command line explicitly said (undefined = not said):
 * `{ mcp?: false, guard?: false, model?: string, agent?: string }`.
 * `settings` is a `readDurableSettings()` result.
 *
 * Every resolved option is `{ value, source }`; `source` is the exact reason
 * string shown in the `[settings]` lines. Notes from the settings read travel
 * on the result so they are printed too.
 */
export function resolveDurableOptions({ flags = {}, settings = readDurableSettings() } = {}) {
	const out = { ...settings, options: {} };

	const from = (option, flagValue, envValue, envSource, fallback) => {
		if (flagValue !== undefined) return { value: flagValue, source: "flag" };
		if (settings.values[option] !== undefined) return { value: settings.values[option], source: DURABLE_KEYS[option] };
		if (envValue !== undefined && envValue !== "") return { value: envValue, source: envSource };
		return { value: fallback, source: "default" };
	};

	out.options.mcp = from("mcp", flags.mcp, undefined, undefined, DURABLE_DEFAULTS.mcp);
	out.options.guard = from("guard", flags.guard, undefined, undefined, DURABLE_DEFAULTS.guard);

	// The model: flag > setting > env > default, normalized to `provider/model`.
	let model;
	if (flags.model !== undefined) {
		model = { value: flags.model, source: "flag" };
	} else if (settings.values.model !== undefined) {
		model = { value: settings.values.model, source: DURABLE_KEYS.model };
	} else {
		const envModel = process.env.PI_AGENT_MODEL;
		const envProvider = process.env.PI_AGENT_PROVIDER;
		if (envModel || envProvider) {
			model = { value: `${envProvider || "omni"}/${envModel || "auto"}`, source: "PI_AGENT_MODEL/PI_AGENT_PROVIDER" };
		} else {
			model = { value: DURABLE_DEFAULTS.model, source: "default" };
		}
	}
	if (parseModelSetting(model.value) === null) {
		out.notes.push(`${DURABLE_KEYS.model}: expected "provider/model", got "${model.value}" — ignored, default in effect`);
		model = { value: DURABLE_DEFAULTS.model, source: "default" };
	}
	out.options.model = model;

	const agent = from("agent", flags.agent, undefined, undefined, DURABLE_DEFAULTS.agent);
	out.options.agent = agent.value === undefined ? undefined : agent;

	return out;
}

/**
 * Print where each effective option came from — one line per option, on stderr,
 * plus the settings reader's notes (missing file, typos). Agent is only printed
 * when one is set: "no agent" is the normal state, not a choice to explain.
 */
export function printDurableOptions(resolved, write = (line) => console.error(line)) {
	for (const note of resolved.notes) write(`[settings] ${note}`);
	const show = (option) => {
		const choice = resolved.options[option];
		if (choice === undefined) return;
		const shown = typeof choice.value === "boolean" ? (choice.value ? "on" : "off") : choice.value;
		write(`[settings] ${option}=${shown} (${choice.source})`);
	};
	for (const option of ["mcp", "guard", "model", "agent"]) show(option);
}
