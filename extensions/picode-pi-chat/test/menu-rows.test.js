/*
 * Exercises the categorized popup's rows.
 *
 * The popup is what the owner sees when they click the pi icon, and its rows claim
 * things about live state. A category that says "0 instaladas" while the count is
 * simply unknown, or "sin modelo" while a model is running, is worse than saying
 * nothing — so the rows are built by pure functions and checked here.
 *
 * menu.ts imports `vscode`, which is stubbed through a resolver hook.
 *
 * Run with: npm test
 */
const path = require("node:path");
const Module = require("node:module");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "vscode-stub.js");
  }
  return originalResolve.call(this, request, ...rest);
};

const { buildCategories, buildCategorySettings, describeAuthCheck } = require("../out/menu.js");

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

const full = {
  model: "DeepSeek V4 Pro",
  reasoning: "max",
  runtime: "pi del PATH 0.86.1",
  runtimeAvailable: true,
  managedInstalled: false,
  installedCount: 10,
  messageCount: 42,
  streaming: false,
  providerCount: 3,
};

const actions = (rows) => rows.filter((row) => row.kind === "item").map((row) => row.action).join(",");

// --- first level -----------------------------------------------------------

const categories = buildCategories(full);
check("there is one category per area", categories.length === 6, `${categories.length}`);
check(
  "each category shows its current value next to the name",
  categories[0].description === "DeepSeek V4 Pro" &&
    categories[1].description === "10 instaladas" &&
    categories[2].description === "pi del PATH 0.86.1" &&
    categories[3].description === "3 con modelos" &&
    categories[4].description === "leyendo…" &&
    categories[5].description === "en reposo",
  JSON.stringify(categories.map((row) => row.description)),
);
check(
  "a loaded gentle is reported with its version and review switch",
  buildCategories({
    ...full,
    gentle: {
      installed: true,
      active: true,
      commandCount: 12,
      commands: ["/gentle:status"],
      version: "3.4.0",
      review: { rdd: "off", global: "off", cloneLocal: "unset" },
      telemetry: "enabled",
    },
  })[4].description === "activo · v3.4.0 · revisión off",
  buildCategories({
    ...full,
    gentle: {
      installed: true,
      active: true,
      commandCount: 12,
      commands: [],
      version: "3.4.0",
      review: { rdd: "off", global: "off", cloneLocal: "unset" },
      telemetry: "enabled",
    },
  })[4].description,
);

const unknown = buildCategories({
  runtime: "pi del PATH",
  runtimeAvailable: true,
  managedInstalled: false,
  streaming: false,
});
check(
  "an unknown count says it is counting instead of claiming zero",
  unknown[1].description === "contando…" && unknown[3].description === "leyendo…",
  JSON.stringify(unknown.map((row) => row.description)),
);
check(
  "a missing session says so rather than showing zero messages",
  unknown[5].description === "en reposo" && unknown[5].detail === "sin sesión",
  unknown[5].detail,
);
check(
  "a running agent shows as working",
  buildCategories({ ...full, streaming: true })[5].description === "trabajando",
  "",
);

// --- second level ----------------------------------------------------------

check("every category opens with a way back", buildCategorySettings("modelo", full)[0].action === "back", "");
check(
  "the model category shows the live model and reasoning",
  buildCategorySettings("modelo", full)[2].label === "Modelo: DeepSeek V4 Pro" &&
    buildCategorySettings("modelo", full)[3].label === "Razonamiento: max",
  "",
);
check(
  "the extensions category offers list, search and update",
  actions(buildCategorySettings("extensiones", full)) === "back,installed,search,update",
  actions(buildCategorySettings("extensiones", full)),
);
check(
  "the installed count is in the label",
  buildCategorySettings("extensiones", full)[2].label === "Extensiones instaladas (10)…",
  buildCategorySettings("extensiones", full)[2].label,
);
check(
  "the runtime category names what is in use and offers the managed install",
  buildCategorySettings("runtime", full)[2].label === "En uso: pi del PATH 0.86.1" &&
    buildCategorySettings("runtime", full)[3].action === "reinstallRuntime" &&
    buildCategorySettings("runtime", full)[3].label.startsWith("Instalar"),
  "",
);
check(
  "an already installed managed runtime offers a reinstall",
  buildCategorySettings("runtime", { ...full, managedInstalled: true })[3].label.startsWith(
    "Reinstalar",
  ),
  "",
);
check(
  "the session category offers usage, new, abort and restart",
  actions(buildCategorySettings("sesion", full)) === "back,usage,newSession,abort,restart",
  actions(buildCategorySettings("sesion", full)),
);

const withUsage = buildCategorySettings("sesion", {
  ...full,
  usage: {
    input: 3000,
    output: 600,
    cacheRead: 500,
    cacheWrite: 0,
    reasoning: 0,
    contextTokens: 2400,
    cost: 0.0223,
    assistantMessages: 2,
    toolCalls: 1,
  },
  contextWindow: 200_000,
});
check(
  "the usage row shows the same line as the panel",
  withUsage.find((row) => row.action === "usage").description ===
    "3,6k tokens · 500 en caché · 0,0223 $ · contexto 1% de 200k",
  withUsage.find((row) => row.action === "usage").description,
);
check(
  "a session with no replies says so instead of showing zeros",
  buildCategorySettings("sesion", {
    ...full,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      contextTokens: 0,
      cost: 0,
      assistantMessages: 0,
      toolCalls: 0,
    },
  }).find((row) => row.action === "usage").description === "sin respuestas todavía",
  "",
);
check(
  "without usage data the row admits it rather than inventing a figure",
  buildCategorySettings("sesion", full).find((row) => row.action === "usage").description ===
    "sin datos",
  "",
);

const gentleActive = {
  installed: true,
  active: true,
  commandCount: 2,
  commands: ["/gentle:status", "/gentle:doctor"],
  version: "3.4.0",
  review: { rdd: "off", global: "off", cloneLocal: "unset" },
  telemetry: "enabled",
};

const gentleRows = buildCategorySettings("gentle", { ...full, gentle: gentleActive });
check(
  "the gentle category offers status, the two switches, sdd and doctor",
  gentleRows.some((row) => row.action === "gentleStatus") &&
    gentleRows.some((row) => row.action === "gentleReview") &&
    gentleRows.some((row) => row.action === "gentleTelemetry") &&
    gentleRows.some((row) => row.action === "gentleSdd") &&
    gentleRows.some((row) => row.action === "gentleDoctor"),
  JSON.stringify(gentleRows.map((row) => row.action)),
);
check(
  "the review row says what picking it will do",
  gentleRows.find((row) => row.action === "gentleReview").label === "Revisión por candidato: off" &&
    gentleRows.find((row) => row.action === "gentleReview").detail.startsWith("Pulsa para activarla"),
  gentleRows.find((row) => row.action === "gentleReview").detail,
);
check(
  "with the review already on the row offers to turn it off",
  buildCategorySettings("gentle", {
    ...full,
    gentle: { ...gentleActive, review: { rdd: "on", global: "on", cloneLocal: "unset" } },
  })
    .find((row) => row.action === "gentleReview")
    .detail.startsWith("Pulsa para desactivarla"),
  "",
);
check(
  "the loaded commands become rows that send themselves",
  gentleRows
    .filter((row) => row.action === "gentleCommand")
    .map((row) => row.command)
    .join(",") === "/gentle:status,/gentle:doctor",
  JSON.stringify(gentleRows.filter((row) => row.action === "gentleCommand").map((row) => row.command)),
);
check(
  "an uninstalled gentle offers to install it and nothing else",
  buildCategorySettings("gentle", full).some((row) => row.action === "gentleInstall") &&
    buildCategorySettings("gentle", full).every((row) => row.action !== "gentleReview"),
  JSON.stringify(buildCategorySettings("gentle", full).map((row) => row.action)),
);

const providers = buildCategorySettings("proveedores", full, [
  { name: "deepseek", models: 12 },
  { name: "google", models: 1 },
]);
check(
  "a provider row carries its name and how many models it has",
  providers[2].provider === "deepseek" &&
    providers[2].description === "12 modelos" &&
    providers[3].description === "1 modelo",
  JSON.stringify(providers.slice(2).map((row) => row.description)),
);
check(
  "with no providers the category says so instead of showing an empty list",
  buildCategorySettings("proveedores", full, [])[2].label.includes("Ningún proveedor"),
  "",
);

// --- auth ------------------------------------------------------------------

check(
  "an auth answer is reported without inventing an interpretation",
  describeAuthCheck('{"status":"not_ready","provider":"deepseek","reason":"credentials_not_configured"}') ===
    "not_ready (credentials_not_configured)",
  "",
);
check("a non-JSON answer is shown as it came", describeAuthCheck("boom") === "boom", "");
check("an empty answer says so", describeAuthCheck("   ") === "sin respuesta", "");

let failed = 0;
for (const result of results) {
  console.log(
    `${result.ok ? "ok  " : "FAIL"} ${result.label}${result.ok || !result.detail ? "" : ` -> ${result.detail}`}`,
  );
  if (!result.ok) {
    failed += 1;
  }
}
console.log(
  failed === 0 ? `\nALL ${results.length} CHECKS PASS` : `\n${failed} of ${results.length} CHECKS FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
