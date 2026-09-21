/*
 * Exercises the Gentle AI readers.
 *
 * Everything here reads output PiCode does not control: gentle-ai's own words. The
 * fixtures are real answers captured from gentle-ai 3.4.0 on this machine, because a
 * parser that only agrees with invented input is worse than none — it would show a
 * confident wrong state in the popup.
 *
 * gentle.ts imports runtime.ts, which imports `vscode`, stubbed through a hook.
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

const {
  gentleCommands,
  parseReviewMode,
  firstMeaningfulLine,
  summarizeGentle,
  describeGentle,
  unknownGentleState,
} = require("../out/gentle.js");

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

// Real output of `gentle-ai review mode status`.
const REAL_REVIEW = [
  "receipt-driven development: off (decided by global)",
  "  global:      off",
  "  clone-local: unset",
  "",
].join("\r\n");

const review = parseReviewMode(REAL_REVIEW);
check("the review switch is read as off", review.rdd === "off", review.rdd);
check(
  "both scopes are read",
  review.global === "off" && review.cloneLocal === "unset",
  `${review.global} / ${review.cloneLocal}`,
);

const enabled = parseReviewMode(
  ["receipt-driven development: on (decided by clone)", "  global:      off", "  clone-local: on"].join("\n"),
);
check("an enabled switch is read as on", enabled.rdd === "on", enabled.rdd);

const garbage = parseReviewMode("something else entirely\n");
check(
  "an unrecognised answer is unknown rather than assumed off",
  garbage.rdd === "unknown" && garbage.global === "desconocido",
  JSON.stringify(garbage),
);

// --- commands, which are how a loaded package is detected ------------------

const commands = [
  { name: "gentle:status" },
  { name: "/gentle:doctor" },
  { name: "compact" },
  { name: "picode:noop" },
];
const gentle = gentleCommands(commands);
check(
  "only the gentle commands are taken, with or without a slash",
  gentle.length === 2 && gentle[0].name === "gentle:status",
  JSON.stringify(gentle.map((command) => command.name)),
);
check("a session without gentle commands reports none", gentleCommands([{ name: "compact" }]).length === 0, "");

// --- labels ----------------------------------------------------------------

check(
  "a first line is taken from a noisy answer",
  firstMeaningfulLine("\n\n  telemetry: enabled\n") === "telemetry: enabled",
  "",
);
check("an empty answer falls back", firstMeaningfulLine("   \n") === "sin respuesta", "");

check("an unknown state says it is reading", summarizeGentle(undefined) === "leyendo…", "");
check(
  "an absent gentle is reported as not installed",
  summarizeGentle(unknownGentleState()) === "no instalado",
  summarizeGentle(unknownGentleState()),
);
check(
  "an installed but unloaded package is not reported as active",
  summarizeGentle({ ...unknownGentleState(), installed: true }) === "instalado, sin cargar",
  summarizeGentle({ ...unknownGentleState(), installed: true }),
);

const active = {
  ...unknownGentleState(),
  installed: true,
  active: true,
  commandCount: 12,
  version: "3.4.0",
  review: { rdd: "off", global: "off", cloneLocal: "unset" },
};
check(
  "an active gentle shows its version and the review state",
  summarizeGentle(active) === "activo · v3.4.0 · revisión off",
  summarizeGentle(active),
);
check(
  "the status lines distinguish installed from loaded",
  describeGentle(active).some((line) => line.includes("cargado en esta sesión: sí, 12 comandos")) &&
    describeGentle(unknownGentleState()).some((line) => line.includes("cargado en esta sesión: no")),
  JSON.stringify(describeGentle(active)),
);

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
