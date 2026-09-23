/*
 * Exercises the pure halves of the provider-login command, and pins the one decision that
 * must never come from the wrong place: the profile the credential is written to.
 *
 * The command itself is never run here: it would load the real pi, ask the machine for a
 * provider list and then offer to log in, and it must never touch any profile on this
 * machine. What is checked instead is everything that decides what the owner reads — the
 * provider list rows, the key-versus-subscription decision, and the wording of the four
 * endings — plus two source-level guards:
 *
 * - `pi-login-command.ts` resolves its target through `instanceAgentDir(` and never
 *   through the guarded readers' `selectedAgentDir`, because on an empty internal profile
 *   that answer names the machine's profile, and a first login exists to fill the other
 *   one. The module deliberately does not name the guarded resolver at all, so the raw
 *   scan cannot be fooled by a comment.
 * - `extension.ts` registers the command id, and `package.json` declares it with a
 *   Spanish title, so the palette and the registration cannot drift apart.
 *
 * The owner-facing sentences are taken from the product's own exported tables and
 * builders (`LOGIN_TEXTS`, `PROVIDER_KINDS`, `PROVIDER_MARKERS`,
 * `loginSuccessText`, `loginSyncFailureText`) instead of being restated here, so there is
 * one copy of every wording. They are printed verbatim at the end.
 *
 * The `vscode` module is stubbed through a resolver hook, as the other suites do, so the
 * compiled module loads without an editor.
 *
 * Run with: npm test
 */
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

const EXTENSION_ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = path.join(EXTENSION_ROOT, "src");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "vscode-stub.js");
  }
  return originalResolve.call(this, request, ...rest);
};

/** The facts of an unconfigured, key-only provider. */
function keyFacts(overrides = {}) {
  return {
    id: "zhipu",
    name: "Zhipu",
    keyLogin: true,
    subscriptionLogin: false,
    usingOAuth: false,
    usingSubscription: false,
    configured: false,
    ...overrides,
  };
}

async function main() {
  const commandPath = path.join(EXTENSION_ROOT, "out", "pi-login-command.js");
  if (!fs.existsSync(commandPath)) {
    console.error(`Missing compiled output. Run "npm run compile" first.`);
    process.exit(2);
  }
  const api = await import(pathToFileURL(commandPath).href);

  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

  // --- the key-versus-subscription decision ----------------------------------

  check(
    "a provider with a key login and no stored credential is a key",
    api.loginType(keyFacts()) === "api_key",
    String(api.loginType(keyFacts())),
  );
  check(
    "a provider whose only interactive login is OAuth is a subscription",
    api.loginType(keyFacts({ keyLogin: false, subscriptionLogin: true })) === "oauth",
    String(api.loginType(keyFacts({ keyLogin: false, subscriptionLogin: true }))),
  );
  check(
    "a stored subscription wins over an offered key login",
    api.loginType(keyFacts({ usingSubscription: true, usingOAuth: true })) === "oauth",
    String(api.loginType(keyFacts({ usingSubscription: true, usingOAuth: true }))),
  );
  check(
    "a stored non-subscription OAuth credential is still OAuth, not a key",
    api.loginType(keyFacts({ usingOAuth: true })) === "oauth",
    String(api.loginType(keyFacts({ usingOAuth: true }))),
  );
  check(
    "a provider with no interactive login at all cannot be logged in",
    api.loginType(keyFacts({ keyLogin: false, subscriptionLogin: false })) === undefined,
    String(api.loginType(keyFacts({ keyLogin: false, subscriptionLogin: false }))),
  );

  // --- how a provider entry reads --------------------------------------------

  const subscriptionEntry = api.providerEntry(
    keyFacts({ id: "copilot", name: "GitHub Copilot", keyLogin: false, subscriptionLogin: true, usingSubscription: true, usingOAuth: true, configured: true }),
  );
  check(
    "the entry is named by the provider's own name and the kind in the owner's words",
    subscriptionEntry.label === "GitHub Copilot" &&
      subscriptionEntry.description === api.PROVIDER_KINDS.oauth &&
      subscriptionEntry.type === "oauth",
    JSON.stringify(subscriptionEntry),
  );
  check(
    "a provider that already holds a credential says so",
    subscriptionEntry.detail === api.PROVIDER_MARKERS.configured,
    subscriptionEntry.detail,
  );
  const freshEntry = api.providerEntry(keyFacts());
  check(
    "a provider with no credential says so, in its own words",
    freshEntry.detail === api.PROVIDER_MARKERS.missing &&
      freshEntry.description === api.PROVIDER_KINDS.api_key,
    JSON.stringify(freshEntry),
  );
  check(
    "an unloggable provider is skipped rather than offered and then failing",
    api.providerEntry(keyFacts({ keyLogin: false, subscriptionLogin: false })) === undefined,
    JSON.stringify(api.providerEntry(keyFacts({ keyLogin: false, subscriptionLogin: false }))),
  );

  // --- the catalogue, read from a runtime ------------------------------------

  const asked = [];
  const fakeRuntime = {
    getProviders: () => [
      { id: "zhipu", name: "Zhipu", auth: { apiKey: { login: () => {} } } },
      { id: "ambient", name: "Ambient", auth: { apiKey: {} } },
      { id: "copilot", name: "GitHub Copilot", auth: { oauth: {} } },
    ],
    isUsingOAuth: (id) => {
      asked.push(`oauth:${id}`);
      return id === "copilot";
    },
    isUsingSubscription: (id) => {
      asked.push(`subscription:${id}`);
      return id === "copilot";
    },
    hasConfiguredAuth: (id) => {
      asked.push(`configured:${id}`);
      return id === "copilot";
    },
  };
  const entries = api.providerEntries(fakeRuntime);
  check(
    "the list is built from the runtime's own providers, without a provider table here",
    entries.map((entry) => entry.id).join(",") === "copilot,zhipu",
    JSON.stringify(entries),
  );
  check(
    "the provider names and their kinds are the runtime's and the owner's, not pi's ids",
    entries[0].label === "GitHub Copilot" &&
      entries[0].description === api.PROVIDER_KINDS.oauth &&
      entries[1].label === "Zhipu" &&
      entries[1].description === api.PROVIDER_KINDS.api_key,
    JSON.stringify(entries),
  );
  check(
    "every provider's facts are asked of the runtime, one call each",
    asked.includes("oauth:zhipu") &&
      asked.includes("subscription:zhipu") &&
      asked.includes("configured:zhipu") &&
      asked.includes("oauth:ambient") &&
      asked.includes("oauth:copilot"),
    JSON.stringify(asked),
  );
  check(
    "a provider with neither interactive login is left out of the list",
    !entries.some((entry) => entry.id === "ambient"),
    JSON.stringify(entries),
  );

  // --- the synchronisation error, read without reading the secret ------------

  const sync = api.synchronizationFailure({
    name: "CredentialSynchronizationError",
    providerId: "omni",
    operation: "login",
    credential: { type: "api_key", key: "SECRET-VALUE" },
  });
  check(
    "a CredentialSynchronizationError yields its provider and operation",
    sync !== undefined && sync.providerId === "omni" && sync.operation === "login",
    JSON.stringify(sync),
  );
  check(
    "nothing else is read as a synchronisation failure",
    api.synchronizationFailure(new Error("boom")) === undefined &&
      api.synchronizationFailure(undefined) === undefined &&
      api.synchronizationFailure({
        name: "Error",
        providerId: "omni",
        operation: "login",
      }) === undefined &&
      api.synchronizationFailure({ name: "CredentialSynchronizationError" }) === undefined,
    JSON.stringify([
      api.synchronizationFailure(new Error("boom")),
      api.synchronizationFailure(undefined),
      api.synchronizationFailure({ name: "CredentialSynchronizationError" }),
    ]),
  );

  // --- the four endings ------------------------------------------------------

  const profile = path.join("C:", "PiCode", "data", "pi-agent");
  const success = api.loginSuccessText("Zhipu", profile);
  const syncFailure = api.loginSyncFailureText("Zhipu", "login");

  check(
    "the refusal says PiCode owns no profile and points at the row that changes it",
    api.LOGIN_TEXTS.ownerInstance.includes("perfil propio") &&
      api.LOGIN_TEXTS.ownerInstance.includes("Qué pi se ejecuta"),
    api.LOGIN_TEXTS.ownerInstance,
  );
  check(
    "the no-SDK ending says the update is the way out",
    api.LOGIN_TEXTS.noSdk.includes("no sabe iniciar sesión desde el SDK") &&
      api.LOGIN_TEXTS.noSdk.includes("Actualiza"),
    api.LOGIN_TEXTS.noSdk,
  );
  check(
    "the cancelled ending does not read like a failure",
    api.LOGIN_TEXTS.cancelled.includes("cerraste") &&
      !/fall|error|no se pudo/i.test(api.LOGIN_TEXTS.cancelled),
    api.LOGIN_TEXTS.cancelled,
  );
  check(
    "the success ending names the provider, the profile and the reload",
    success.includes("Zhipu") &&
      success.includes(profile) &&
      success.includes("Recarga la ventana") &&
      success.includes("perfil propio de PiCode"),
    success,
  );
  check(
    "the synchronisation ending names the provider and the operation, in the owner's words",
    syncFailure.includes("Zhipu") &&
      syncFailure.includes(api.operationText("login")) &&
      !syncFailure.includes("login") &&
      syncFailure.includes("sí se guardó") &&
      syncFailure.includes("a ciegas"),
    syncFailure,
  );
  check(
    "the four endings are four different sentences",
    new Set([
      api.LOGIN_TEXTS.ownerInstance,
      api.LOGIN_TEXTS.noSdk,
      api.LOGIN_TEXTS.cancelled,
      success,
      syncFailure,
    ]).size === 5,
    JSON.stringify([
      api.LOGIN_TEXTS.ownerInstance,
      api.LOGIN_TEXTS.noSdk,
      api.LOGIN_TEXTS.cancelled,
      success,
      syncFailure,
    ]),
  );
  check(
    "an unknown operation is passed through instead of guessed at",
    api.operationText("somethingNew") === "somethingNew",
    api.operationText("somethingNew"),
  );

  // --- the target profile, checked at the source -----------------------------

  const commandSource = fs.readFileSync(
    path.join(SOURCE_ROOT, "pi-login-command.ts"),
    "utf8",
  );
  check(
    "the command resolves its target through instanceAgentDir(",
    /\binstanceAgentDir\s*\(/.test(commandSource),
    "no instanceAgentDir( call found",
  );
  check(
    "the command never names the guarded readers' answer",
    !commandSource.includes("selectedAgentDir"),
    "the guarded reader resolver is named in the command source",
  );

  const extensionSource = fs.readFileSync(path.join(SOURCE_ROOT, "extension.ts"), "utf8");
  check(
    "extension.ts registers the command id it imports",
    extensionSource.includes("LOGIN_PROVIDER_COMMAND") &&
      /registerCommand\(\s*LOGIN_PROVIDER_COMMAND/.test(extensionSource) &&
      /loginProvider\(context\)/.test(extensionSource),
    "the registration for LOGIN_PROVIDER_COMMAND was not found",
  );

  // --- the command the palette runs ------------------------------------------

  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, "package.json"), "utf8"));
  const declared = (manifest.contributes.commands ?? []).find(
    (entry) => entry.command === api.LOGIN_PROVIDER_COMMAND,
  );
  check(
    "the command id is declared in the manifest with a Spanish title",
    api.LOGIN_PROVIDER_COMMAND === "picode.piChat.loginProvider" &&
      declared !== undefined &&
      /^PiCode: /.test(declared.title),
    JSON.stringify(declared),
  );
  check(
    "the new suite is registered in the test chain",
    String(manifest.scripts.test).includes("test/pi-login-command.test.js"),
    manifest.scripts.test,
  );

  // --- the exact text the owner reads -----------------------------------------

  const listed = api.providerEntries(fakeRuntime);
  console.log("--- the provider list, as the owner reads it ---");
  for (const entry of listed) {
    console.log(`${entry.label} — ${entry.description} (${entry.detail})`);
  }
  console.log("--- the endings, verbatim ---");
  console.log(`[refusal]  ${api.LOGIN_TEXTS.ownerInstance}`);
  console.log(`[no sdk]   ${api.LOGIN_TEXTS.noSdk}`);
  console.log(`[cancel]   ${api.LOGIN_TEXTS.cancelled}`);
  console.log(`[success]  ${success}`);
  console.log(`[sync]     ${syncFailure}`);
  console.log("---");

  // --- report ------------------------------------------------------------------

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
