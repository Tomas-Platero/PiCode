/*
 * Exercises the version comparison and the update check behind the Gentle AI panel.
 *
 * The comparison decides one thing — whether an update is offered — and it is the kind
 * of code a diff cannot show as wrong: `"0.10.0" > "0.9.9"` is false as text, and a panel
 * built on text would quietly stop offering updates the day a minor version reached two
 * digits. The comparison is therefore tested directly, and so is the wording of the three
 * states the panel can show, which must never be a blank.
 *
 * The registry half is hermetic: `globalThis.fetch` is replaced by a stub before the
 * modules are loaded, the stub records every URL it was asked for, and the real registry
 * is never reached.
 *
 * Run with: npm test
 */
const path = require("node:path");
const Module = require("node:module");

// catalog.ts and gentle.ts both reach runtime.ts, which imports `vscode`. The stub keeps
// them loadable outside an editor.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "vscode-stub.js");
  }
  return originalResolve.call(this, request, ...rest);
};

// --- the stubbed registry ---------------------------------------------------

/** Every request the code under test made, in order. */
const calls = [];

/** How the next request is answered; each check installs its own handler. */
let respond = () => {
  throw new Error("the test did not declare what the registry answers");
};

globalThis.fetch = async (url, init) => {
  const call = { url: String(url), headers: (init && init.headers) || {} };
  calls.push(call);
  return respond(call);
};

const resetRegistry = (handler) => {
  calls.length = 0;
  respond = handler;
};

const jsonResponse = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {
    get: (name) => (name.toLowerCase() in headers ? headers[name.toLowerCase()] : null),
  },
  json: async () => body,
});

const {
  compareVersions,
  isNewerVersion,
  readInstalledPackageVersion,
  buildUpdateReport,
  describeUpdate,
  describeVersions,
  GENTLE_LAYER_PACKAGES,
} = require("../out/gentle.js");
const { resolveLatestVersions } = require("../out/catalog.js");

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });
const shape = (value) => String(value);

// --- the comparison rules ---------------------------------------------------

// One table, one row per rule the function promises, so a reviewer reads the contract
// instead of reconstructing it from the implementation.
const rules = [
  ["numeric fields, not text: 0.10.0 is newer than 0.9.9", "0.10.0", "0.9.9", 1],
  ["and the other way round", "0.9.9", "0.10.0", -1],
  ["a two-digit patch wins the same way: 1.0.10 over 1.0.9", "1.0.10", "1.0.9", 1],
  ["a major version beats the number it shares: 2.0.0 over 1.9.9", "2.0.0", "1.9.9", 1],
  ["identical versions are equal", "1.2.3", "1.2.3", 0],
  ["a missing field counts as zero: 1.2 equals 1.2.0", "1.2", "1.2.0", 0],
  ["and a trailing zero is no difference either", "1.2.3", "1.2.3.0", 0],
  ["build metadata is ignored: 1.2.3+build.5 equals 1.2.3", "1.2.3+build.5", "1.2.3", 0],
  ["two different build metadata are still the same version", "1.2.3+build.5", "1.2.3+build.9", 0],
  ["a prerelease is older than the release it leads to", "1.0.0-rc.1", "1.0.0", -1],
  ["and the release is newer than its prerelease", "1.0.0", "1.0.0-rc.1", 1],
  ["two prereleases are ordered by their numbers", "1.0.0-rc.10", "1.0.0-rc.9", 1],
  ["a numeric identifier is lower than an alphanumeric one", "1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
  ["a shorter prerelease is lower when the rest is equal", "1.0.0-alpha", "1.0.0-alpha.1", -1],
  ["a leading v is accepted, as other tools print it", "v1.4.0", "1.4.0", 0],
  ["a v-prefixed version still compares by its numbers", "v1.4.0", "v1.10.0", -1],
  ["a prerelease with build metadata is ordered by the prerelease", "1.0.0-rc.1+sha", "1.0.0-rc.2+sha", -1],
  ["unreadable versions do not throw and equal text is equal", "no-es-una-versión", "no-es-una-versión", 0],
  ["an empty version is older than a real one", "", "1.0.0", -1],
];

rules.forEach(([label, left, right, expected]) => {
  const sign = Math.sign(compareVersions(left, right));
  check(
    label,
    sign === expected,
    `compareVersions(${JSON.stringify(left)}, ${JSON.stringify(right)}) = ${shape(sign)} (want ${expected})`,
  );
});

check(
  "isNewerVersion is the same answer as a positive comparison",
  isNewerVersion("0.10.0", "0.9.9") === true &&
    isNewerVersion("0.9.9", "0.10.0") === false &&
    isNewerVersion("1.2.3", "1.2.3") === false &&
    isNewerVersion("1.0.0", "1.0.0-rc.1") === true,
  `${isNewerVersion("0.10.0", "0.9.9")} / ${isNewerVersion("1.2.3", "1.2.3")}`,
);

// --- the installed version, read from a real manifest ------------------------

// The extension's own directory is a package root: reading it needs no fixture written
// anywhere, and it is the same shape the code reads for gentle-pi and gentle-engram.
const extensionRoot = path.join(__dirname, "..");
const ownVersion = require("../package.json").version;
check(
  "the installed version is the one the package's own manifest declares",
  readInstalledPackageVersion(extensionRoot) === ownVersion,
  `${readInstalledPackageVersion(extensionRoot)} (want ${ownVersion})`,
);
check(
  "a directory without a manifest is unknown rather than an error",
  readInstalledPackageVersion(__dirname) === undefined,
  shape(readInstalledPackageVersion(__dirname)),
);
check(
  "a path that does not exist is unknown rather than an error",
  readInstalledPackageVersion(path.join(extensionRoot, "no-such-directory")) === undefined,
  shape(readInstalledPackageVersion(path.join(extensionRoot, "no-such-directory"))),
);

// --- the three states of the panel's version line ---------------------------

check(
  "the layer is the two packages the wizard installs",
  GENTLE_LAYER_PACKAGES.join(",") === "gentle-pi,gentle-engram",
  GENTLE_LAYER_PACKAGES.join(","),
);

const behind = buildUpdateReport([
  { name: "gentle-pi", installed: "1.2.4", latest: "1.2.5" },
  { name: "gentle-engram", installed: "0.4.2", latest: "0.4.2" },
]);
check("an older installed version is an available update", behind.available === true, String(behind.available));
check(
  "the available update names the version and the one installed",
  describeUpdate(behind) === "Actualización disponible: gentle-pi 1.2.5 (tienes 1.2.4).",
  describeUpdate(behind),
);

const current = buildUpdateReport([
  { name: "gentle-pi", installed: "0.10.0", latest: "0.10.0" },
  { name: "gentle-engram", installed: "0.4.2", latest: "0.4.2" },
]);
check("equal versions are not an update", current.available === false, String(current.available));
check(
  "the current state says so and names the installed versions",
  describeUpdate(current) === "Todo al día: gentle-pi 0.10.0 · gentle-engram 0.4.2.",
  describeUpdate(current),
);

const registryFailed = buildUpdateReport([
  { name: "gentle-pi", installed: "1.2.4", latest: "1.2.5" },
  { name: "gentle-engram", installed: "0.4.2", latest: undefined },
]);
check(
  "one package behind still offers its update while the other was not answered for",
  registryFailed.available === true,
  describeUpdate(registryFailed),
);
check(
  "a package the registry did not answer for is named, not silently dropped",
  describeUpdate(registryFailed) === "Actualización disponible: gentle-pi 1.2.5 (tienes 1.2.4).",
  describeUpdate(registryFailed),
);

const allFailed = buildUpdateReport([
  { name: "gentle-pi", installed: "1.2.4", latest: undefined },
  { name: "gentle-engram", installed: "0.4.2", latest: undefined },
]);
check("a failed check is not reported as an update", allFailed.available === false, String(allFailed.available));
check(
  "the failed check names the packages that left it incomplete",
  describeUpdate(allFailed) ===
    "No se pudo comprobar si hay actualización: gentle-pi y gentle-engram sin una versión que comparar.",
  describeUpdate(allFailed),
);

// An unreadable installed version cannot claim an update on its own, and with nothing
// else behind, the line is the incomplete check rather than a blank.
const noInstalledVersion = buildUpdateReport([
  { name: "gentle-pi", installed: undefined, latest: "1.2.5" },
  { name: "gentle-engram", installed: "0.4.2", latest: "0.4.2" },
]);
check(
  "an unreadable installed version never claims an update, even with a published one",
  noInstalledVersion.available === false && noInstalledVersion.packages[0].installed === undefined,
  describeUpdate(noInstalledVersion),
);
check(
  "and the state says the check was incomplete rather than showing a blank",
  describeUpdate(noInstalledVersion) ===
    "No se pudo comprobar si hay actualización: gentle-pi sin una versión que comparar.",
  describeUpdate(noInstalledVersion),
);
check(
  "the unreadable package is still spelled out line by line",
  describeVersions(noInstalledVersion).join(" | ") ===
    "gentle-pi: instalada desconocida · publicada 1.2.5 | gentle-engram: instalada 0.4.2 · publicada 0.4.2",
  describeVersions(noInstalledVersion).join(" | "),
);

// An update in one package and an unknown version in the other: the update is the
// headline, because it is the thing the owner can act on, and the unknown package is
// still named in its own line rather than dropped.
const mixed = buildUpdateReport([
  { name: "gentle-pi", installed: undefined, latest: "1.2.5" },
  { name: "gentle-engram", installed: "0.4.2", latest: "0.4.3" },
]);
check(
  "an update in one package is offered even while the other's version is unknown",
  mixed.available === true && describeUpdate(mixed).includes("gentle-engram 0.4.3"),
  describeUpdate(mixed),
);
check(
  "and the unknown package still appears in the per-package lines",
  describeVersions(mixed)[0].includes("instalada desconocida"),
  describeVersions(mixed)[0],
);

check(
  "an empty report still says the check failed instead of leaving the line blank",
  describeUpdate(buildUpdateReport([])) === "No se pudo comprobar si hay actualización.",
  describeUpdate(buildUpdateReport([])),
);

check(
  "the per-package lines name the installed and the published version",
  describeVersions(behind).join(" | ") ===
    "gentle-pi: instalada 1.2.4 · publicada 1.2.5 | gentle-engram: instalada 0.4.2 · publicada 0.4.2",
  describeVersions(behind).join(" | "),
);
check(
  "a side that is missing is spelled desconocida, not left out",
  describeVersions(allFailed).join(" | ") ===
    "gentle-pi: instalada 1.2.4 · publicada desconocida | gentle-engram: instalada 0.4.2 · publicada desconocida",
  describeVersions(allFailed).join(" | "),
);

const pairs = [{ name: "gentle-pi", installed: "1.2.4", latest: "1.2.5" }];
const built = buildUpdateReport(pairs);
check(
  "building a report copies the pairs instead of holding the caller's objects",
  built.packages[0] !== pairs[0] && pairs[0].installed === "1.2.4",
  String(built.packages[0] === pairs[0]),
);

// --- the registry, through the stub -----------------------------------------

async function main() {
  resetRegistry(() =>
    jsonResponse({ name: "gentle-pi", version: "1.2.5", pi: { extensions: ["./ext"] } }),
  );
  const latest = await resolveLatestVersions(GENTLE_LAYER_PACKAGES);
  check(
    "the check asks the registry's own URL, one per package of the layer",
    calls.map((call) => call.url).join(" ") ===
      "https://registry.npmjs.org/gentle-pi/latest https://registry.npmjs.org/gentle-engram/latest",
    calls.map((call) => call.url).join(" "),
  );
  check(
    "the check asks for the full document, the same way the type resolver does",
    calls.every((call) => call.headers.accept === "application/json"),
    JSON.stringify(calls[0] && calls[0].headers),
  );
  check(
    "the published version is the document's own version field",
    latest.get("gentle-pi") === "1.2.5" && latest.get("gentle-engram") === "1.2.5",
    JSON.stringify(Array.from(latest.entries())),
  );

  // A 404: the registry has no such package, which is a failed check and not a crash.
  resetRegistry(() => jsonResponse({ error: "Not found" }, 404));
  const missing = await resolveLatestVersions(["gentle-pi"]);
  check(
    "a package the registry does not have is an entry with no version",
    missing.has("gentle-pi") && missing.get("gentle-pi") === undefined,
    JSON.stringify(Array.from(missing.entries())),
  );
  check("a 404 is not retried", calls.length === 1, `${calls.length} requests`);

  // An outage: the answer is unknown, and the other package's answer survives.
  resetRegistry((call) => {
    if (call.url.includes("gentle-engram")) {
      throw new Error("la red se cayó");
    }
    return jsonResponse({ version: "2.0.0" });
  });
  const partial = await resolveLatestVersions(GENTLE_LAYER_PACKAGES);
  check(
    "a package that cannot be reached is unknown while its sibling still answers",
    partial.get("gentle-engram") === undefined && partial.get("gentle-pi") === "2.0.0",
    JSON.stringify(Array.from(partial.entries())),
  );
  check(
    "every package asked about is in the answer, the failed one included",
    partial.size === 2,
    `${partial.size} entries`,
  );

  // A refusal, then a success: the retry the type resolver already had.
  let attempt = 0;
  resetRegistry(() => {
    attempt += 1;
    return attempt === 1
      ? jsonResponse({ error: "throttled" }, 503, { "retry-after": "0" })
      : jsonResponse({ version: "3.0.0" });
  });
  const retried = await resolveLatestVersions(["gentle-pi"], { retryDelayMs: 1 });
  check(
    "a refusal is waited out rather than reported as a failed check",
    calls.length === 2 && retried.get("gentle-pi") === "3.0.0",
    `${calls.length} requests, ${retried.get("gentle-pi")}`,
  );

  resetRegistry(() => jsonResponse({ error: "bad request" }, 400));
  const rejected = await resolveLatestVersions(["gentle-pi"], { maxAttempts: 3, retryDelayMs: 1 });
  check(
    "a client error that will not change is not retried and leaves the version unknown",
    calls.length === 1 && rejected.get("gentle-pi") === undefined,
    `${calls.length} requests`,
  );

  resetRegistry(() => jsonResponse({ version: "1.0.0" }));
  await resolveLatestVersions([]);
  check("asking about nothing costs no request", calls.length === 0, `${calls.length} requests`);
}

let failed = 0;
const report = () => {
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
};

main().then(report, (error) => {
  console.error(error);
  process.exit(1);
});
