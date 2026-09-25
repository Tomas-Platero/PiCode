/*
 * Exercises the two pure text-building steps of the import command, and the refusal
 * that guards the copy, in plain Node.
 *
 * The command itself is never run here: it would scan the real profile on this
 * machine and then offer to copy it. What is checked is the part that decides what the
 * owner reads — the inventory as list entries, the import report as lines, and the
 * three refusals — plus the command id the palette uses. The inventory fixtures are
 * built by the real `scanProfile()` over temporary directories, so the entries are
 * exercised against the scan's actual shapes rather than a hand-written object that
 * could drift from them.
 *
 * The owner-facing sentences are taken from the product's own exported tables
 * (`ITEM_LABELS`, `STATUS_TEXTS`, `REFUSALS`, `ENTRY_DESCRIPTIONS`) instead of being
 * restated here, so there is one copy of every wording. The dynamic details (counts,
 * provider and server names) are checked for the fact they must carry — a number with
 * a noun, and the names — and printed verbatim at the end.
 *
 * The `vscode` module is stubbed through a resolver hook, as runtime.test.js and
 * instance.test.js do, so the compiled module loads without an editor.
 *
 * Run with: npm test
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

const EXTENSION_ROOT = path.resolve(__dirname, "..");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "vscode-stub.js");
  }
  return originalResolve.call(this, request, ...rest);
};

/** Writes a file, creating its parent directories. */
function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A fresh temporary directory the caller must clean up. */
function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A source profile holding one of everything the scan reads. */
function completeProfile() {
  const dir = tempDir("picode-import-cmd-");
  writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify({ packages: ["npm:pi-lens", { source: "git:github.com/x/y" }] }),
  );
  writeFile(
    path.join(dir, "auth.json"),
    JSON.stringify({
      anthropic: { type: "api_key", key: "secret" },
      nan: { type: "api_key", key: "other" },
    }),
  );
  writeFile(
    path.join(dir, "models.json"),
    JSON.stringify({
      providers: {
        omni: { models: [{ id: "auto" }, { id: "auto/best" }] },
        other: { models: [{ id: "m" }] },
      },
    }),
  );
  writeFile(
    path.join(dir, "mcp.json"),
    JSON.stringify({
      mcpServers: { local: { command: "node" }, remote: { url: "https://example.test/mcp" } },
    }),
  );
  writeFile(path.join(dir, "skills", "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
  writeFile(path.join(dir, "skills", "beta", "SKILL.md"), "---\nname: beta\n---\n");
  writeFile(path.join(dir, "memory", "one.md"), "a\n");
  writeFile(path.join(dir, "memory", "two.md"), "b\n");
  writeFile(path.join(dir, "sessions", "2026-01-01.json"), "{}\n");
  return dir;
}

/** A report carrying each of the five statuses once, plus a directory and a failure. */
function fiveStatusReport() {
  return {
    from: "origen",
    to: "destino",
    items: [
      { item: "settings", status: "copied", path: "destino/settings.json" },
      { item: "models", status: "overwritten", path: "destino/models.json" },
      { item: "mcp", status: "absent", path: "destino/mcp.json" },
      { item: "skills", status: "overwritten", path: "destino/skills", files: 2 },
      { item: "memory", status: "declined", path: "destino/memory" },
      { item: "sessions", status: "copied", path: "destino/sessions", files: 3 },
      {
        item: "credentials",
        status: "failed",
        path: "destino/auth.json",
        reason: "el origen no es JSON válido",
      },
    ],
    counts: { copied: 2, overwritten: 2, absent: 1, declined: 1, failed: 1 },
  };
}

/** Whether a detail carries at least one count followed by the noun that names it. */
function countHasNoun(detail) {
  return /\d+\s+\S/.test(detail);
}

async function main() {
  const commandPath = path.join(EXTENSION_ROOT, "out", "instance-import-command.js");
  const instancePath = path.join(EXTENSION_ROOT, "out", "instance.js");
  if (!fs.existsSync(commandPath) || !fs.existsSync(instancePath)) {
    console.error(`Missing compiled output. Run "npm run compile" first.`);
    process.exit(2);
  }
  const command = await import(pathToFileURL(commandPath).href);
  const instance = await import(pathToFileURL(instancePath).href);
  const api = command.inventoryEntries ? command : command.default;

  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });
  const cleanups = [];
  const cleanup = (dir) => cleanups.push(dir);

  // --- the list an inventory with every section produces ---------------------

  const complete = completeProfile();
  cleanup(complete);
  const fullEntries = api.inventoryEntries(instance.scanProfile(complete));
  const byItem = Object.fromEntries(fullEntries.map((entry) => [entry.item, entry]));

  check(
    "every item has a row, in the copy's own order",
    fullEntries.map((entry) => entry.item).join(",") ===
      "settings,models,mcp,skills,memory,sessions,credentials",
    fullEntries.map((entry) => entry.item).join(","),
  );
  check(
    "a section the scan found content for is selectable",
    ["settings", "models", "mcp", "skills", "memory", "sessions", "credentials"].every(
      (item) => byItem[item].selectable === true,
    ),
    JSON.stringify(fullEntries),
  );
  check(
    "each row is named from the product's own label table",
    fullEntries.every((entry) => entry.label === api.ITEM_LABELS[entry.item]),
    JSON.stringify(fullEntries.map((entry) => entry.label)),
  );
  check(
    "credentials are marked as their own decision and named by provider",
    byItem.credentials.description === api.ENTRY_DESCRIPTIONS.credentialsSeparate &&
      byItem.credentials.detail.includes("anthropic") &&
      byItem.credentials.detail.includes("nan"),
    JSON.stringify(byItem.credentials),
  );
  check(
    "every populated detail carries a number with the noun that names it",
    fullEntries.every((entry) => countHasNoun(entry.detail)),
    JSON.stringify(fullEntries.map((entry) => entry.detail)),
  );
  check(
    "the MCP row names the servers and the skills row counts them",
    byItem.mcp.detail.includes("local") &&
      byItem.mcp.detail.includes("remote") &&
      countHasNoun(byItem.skills.detail),
    JSON.stringify({ mcp: byItem.mcp.detail, skills: byItem.skills.detail }),
  );

  // --- the list an inventory with empty sections produces --------------------

  const empty = tempDir("picode-import-cmd-empty-");
  cleanup(empty);
  const emptyEntries = api.inventoryEntries(instance.scanProfile(empty));
  check(
    "an empty profile still shows every row, none of them selectable",
    emptyEntries.length === 7 && emptyEntries.every((entry) => entry.selectable === false),
    JSON.stringify(emptyEntries),
  );
  check(
    "a row with nothing behind it is marked from the product's own description",
    emptyEntries.every((entry) => entry.description === api.ENTRY_DESCRIPTIONS.empty),
    JSON.stringify(emptyEntries.map((entry) => entry.description)),
  );

  // --- the report as owner-facing lines --------------------------------------

  const report = fiveStatusReport();
  const lines = api.reportLines(report);
  check(
    "there is one line per item, in the report's order",
    lines.length === report.items.length,
    JSON.stringify(lines),
  );
  check(
    "each line names the item and its status from the product's own tables",
    report.items.every(
      (item, index) =>
        lines[index].startsWith(`${api.ITEM_LABELS[item.item]}: ${api.STATUS_TEXTS[item.status]}`),
    ),
    JSON.stringify(lines),
  );
  check(
    "the five statuses have five distinct texts",
    new Set(Object.values(api.STATUS_TEXTS)).size === 5,
    JSON.stringify(api.STATUS_TEXTS),
  );
  check(
    "a directory says how many files it moved",
    lines[3] ===
      `${api.ITEM_LABELS.skills}: ${api.STATUS_TEXTS.overwritten}, 2 archivos.`,
    lines[3],
  );
  check(
    "a failure carries the reason the report gave and nothing more",
    lines[6].startsWith(
      `${api.ITEM_LABELS.credentials}: ${api.STATUS_TEXTS.failed} —`,
    ) && lines[6].includes(report.items[6].reason),
    lines[6],
  );

  // --- reading the target's own files, pure over their text -------------------

  const settingsText = JSON.stringify({
    packages: ["npm:pi-lens", { source: "git:github.com/x/y" }, "", { source: "" }, 7, null],
  });
  const sources = api.packageSourcesFromSettings(settingsText);
  check(
    "the package list is read from the settings text, both source shapes",
    sources.length === 2 && sources[0] === "npm:pi-lens" && sources[1] === "git:github.com/x/y",
    JSON.stringify(sources),
  );
  check(
    "a missing, broken or non-object settings text names no packages",
    api.packageSourcesFromSettings(undefined).length === 0 &&
      api.packageSourcesFromSettings("{ not json").length === 0 &&
      api.packageSourcesFromSettings("[1,2]").length === 0 &&
      api.packageSourcesFromSettings(JSON.stringify({ packages: "npm:x" })).length === 0,
    JSON.stringify([
      api.packageSourcesFromSettings(undefined),
      api.packageSourcesFromSettings("{ not json"),
      api.packageSourcesFromSettings("[1,2]"),
      api.packageSourcesFromSettings(JSON.stringify({ packages: "npm:x" })),
    ]),
  );

  const authText = JSON.stringify({
    anthropic: { type: "api_key", key: "SECRET-VALUE" },
    nan: { type: "api_key", key: "OTHER-SECRET" },
  });
  const providers = api.credentialProvidersFromAuth(authText);
  check(
    "the credentials are read as provider names, never values",
    providers.join(",") === "anthropic,nan" &&
      providers.every((name) => !name.includes("SECRET")),
    JSON.stringify(providers),
  );
  check(
    "a missing, broken or non-object auth text names no providers",
    api.credentialProvidersFromAuth(undefined).length === 0 &&
      api.credentialProvidersFromAuth("nope").length === 0 &&
      api.credentialProvidersFromAuth('[1,2]').length === 0,
    JSON.stringify([
      api.credentialProvidersFromAuth(undefined),
      api.credentialProvidersFromAuth("nope"),
      api.credentialProvidersFromAuth('[1,2]'),
    ]),
  );

  // --- the install's environment and the closing -----------------------------

  const target = path.join(os.tmpdir(), "picode-import-cmd-target");
  const env = api.importProfileEnv(target);
  check(
    "the install runs with the import's own target, explicitly",
    Object.keys(env).length === 1 && env.PI_CODING_AGENT_DIR === target,
    JSON.stringify(env),
  );

  const closingReady = api.closingMessage({ hasCredentials: true, managed: true });
  const closingNoCredentials = api.closingMessage({ hasCredentials: false, managed: true });
  const closingOtherRuntime = api.closingMessage({ hasCredentials: true, managed: false });
  const closingOtherRuntimeNoCredentials = api.closingMessage({
    hasCredentials: false,
    managed: false,
  });
  check(
    "each closing is built from the product's own table",
    closingReady.text === `PiCode: ${api.CLOSING_TEXTS.ready}` &&
      closingNoCredentials.text === `PiCode: ${api.CLOSING_TEXTS.withoutCredentials}` &&
      closingOtherRuntime.text === `PiCode: ${api.CLOSING_TEXTS.otherRuntime}`,
    JSON.stringify({ closingReady, closingNoCredentials, closingOtherRuntime }),
  );
  check(
    "the three closing texts say three different things",
    new Set([closingReady.text, closingNoCredentials.text, closingOtherRuntime.text]).size === 3,
    JSON.stringify([closingReady.text, closingNoCredentials.text, closingOtherRuntime.text]),
  );
  check(
    "only PiCode's own pi with credentials offers the reload",
    closingReady.reload === true &&
      closingNoCredentials.reload === false &&
      closingOtherRuntime.reload === false &&
      closingOtherRuntimeNoCredentials.reload === false &&
      api.RELOAD_WINDOW_LABEL === "Recargar la ventana",
    JSON.stringify({
      closingReady,
      closingNoCredentials,
      closingOtherRuntime,
      closingOtherRuntimeNoCredentials,
      reload: api.RELOAD_WINDOW_LABEL,
    }),
  );
  check(
    "the reload-less closings name what actually blocks the switch",
    closingReady.text.includes("recarga la ventana") &&
      closingNoCredentials.text.includes("no tiene credenciales") &&
      closingNoCredentials.text.includes("nada ha cambiado") &&
      closingOtherRuntime.text.includes(`«${api.RUNTIME_ROW_LABEL}»`) &&
      !closingOtherRuntime.text.includes("recarga la ventana") &&
      api.RUNTIME_ROW_LABEL === "Qué pi se ejecuta",
    JSON.stringify({
      closingNoCredentials: closingNoCredentials.text,
      closingOtherRuntime: closingOtherRuntime.text,
    }),
  );

  // --- the three refusals -----------------------------------------------------

  const fromDir = path.join(os.tmpdir(), "picode-import-cmd-from");
  const toDir = path.join(os.tmpdir(), "picode-import-cmd-to");
  const nested = path.join(fromDir, "nested", "target");

  const missing = api.importRefusal(fromDir, toDir, { sourceExists: false, hasContent: false });
  const withoutContent = api.importRefusal(fromDir, toDir, {
    sourceExists: true,
    hasContent: false,
  });
  const same = api.importRefusal(fromDir, fromDir, { sourceExists: true, hasContent: true });
  const inside = api.importRefusal(fromDir, nested, { sourceExists: true, hasContent: true });
  const containsTarget = api.importRefusal(nested, fromDir, {
    sourceExists: true,
    hasContent: true,
  });
  const allowed = api.importRefusal(fromDir, toDir, { sourceExists: true, hasContent: true });

  check(
    "a source that does not exist is refused in words",
    missing === api.REFUSALS.sourceMissing,
    String(missing),
  );
  check(
    "a source with nothing importable is refused in words",
    withoutContent === api.REFUSALS.sourceEmpty,
    String(withoutContent),
  );
  check(
    "the same directory and either nesting direction are refused in words",
    same === api.REFUSALS.overlapping &&
      inside === api.REFUSALS.overlapping &&
      containsTarget === api.REFUSALS.overlapping,
    JSON.stringify({ same, inside, containsTarget }),
  );
  check(
    "the three refusals are three different sentences",
    new Set([missing, withoutContent, same]).size === 3,
    JSON.stringify([missing, withoutContent, same]),
  );
  check(
    "a source with content and a separate target is not refused",
    allowed === undefined,
    String(allowed),
  );

  // --- the command the palette runs -------------------------------------------

  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, "package.json"), "utf8"));
  const declared = (manifest.contributes.commands ?? []).find(
    (entry) => entry.command === api.IMPORT_PROFILE_COMMAND,
  );
  check(
    "the command id is declared in the manifest with a Spanish title",
    api.IMPORT_PROFILE_COMMAND === "picode.piChat.importProfile" &&
      declared !== undefined &&
      /^PiCode: /.test(declared.title),
    JSON.stringify(declared),
  );

  // --- the exact text the owner reads -----------------------------------------

  console.log("--- list entries (complete fixture) ---");
  for (const entry of fullEntries) {
    console.log(`${entry.selectable ? "[x]" : "[ ]"} ${entry.label} — ${entry.detail}${entry.description ? ` (${entry.description})` : ""}`);
  }
  console.log("--- list entries (empty fixture) ---");
  for (const entry of emptyEntries) {
    console.log(`${entry.selectable ? "[x]" : "[ ]"} ${entry.label} — ${entry.detail}${entry.description ? ` (${entry.description})` : ""}`);
  }
  console.log("--- report lines ---");
  for (const line of lines) {
    console.log(line);
  }
  console.log("--- target reads (pure over the files' text) ---");
  console.log(`packages from settings -> ${JSON.stringify(sources)}`);
  console.log(`providers from auth -> ${JSON.stringify(providers)}`);
  console.log(`install environment -> ${JSON.stringify(env)}`);
  console.log("--- closing texts ---");
  for (const closing of [closingReady, closingNoCredentials, closingOtherRuntime]) {
    console.log(`[${closing.reload ? api.RELOAD_WINDOW_LABEL : "no button"}] ${closing.text}`);
  }
  console.log("--- refusals ---");
  console.log(missing);
  console.log(withoutContent);
  console.log(same);
  console.log("---");

  // --- report ------------------------------------------------------------------

  for (const dir of cleanups) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  let failed = 0;
  for (const result of results) {
    console.log(
      `${result.ok ? "ok  " : "FAIL"} ${result.label}${result.ok ? "" : ` -> ${result.detail}`}`,
    );
    if (!result.ok) {
      failed += 1;
    }
  }
  console.log(
    failed === 0
      ? `\nALL ${results.length} CHECKS PASS`
      : `\n${failed} of ${results.length} CHECKS FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("harness error:", error);
  process.exit(2);
});
