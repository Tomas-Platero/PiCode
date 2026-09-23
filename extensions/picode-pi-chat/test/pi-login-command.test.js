/*
 * Exercises the pure halves of the provider-login command, and pins the one decision that
 * must never come from the wrong place: the profile the credential is written to.
 *
 * The command itself is never run here: it would load the real pi, ask the machine for a
 * provider list and then offer to log in, and it must never touch any profile on this
 * machine. What is checked instead is everything that decides what the owner reads — the
 * provider list rows, the key-versus-subscription decision, and the wording of the endings —
 * plus the catalogue's source, exercised over fake runtimes so no profile is built: with a
 * live session the list comes from it and the target profile is not built at all, and with
 * no session the fallback builds it exactly once. Four source-level guards close the rest:
 *
 * - `pi-login-command.ts` resolves its target through `instanceProfileDir(`, the unguarded
 *   writer's answer, and never through the guarded readers' `selectedAgentDir`: on an empty
 *   internal profile that answer names the machine's profile, and a first login exists to
 *   fill the other one. The module deliberately does not name the guarded resolver at all,
 *   so the raw scan cannot be fooled by a comment.
 * - the same module still asks `instanceAgentDir(` — the reader that is `undefined` when the
 *   selected instance is the owner's own pi — because who owns the target, and not where it
 *   is, is what the confirmation and the success wording depend on. That confirmation is a
 *   modal, gated on the owner's instance, and it sits after the provider was chosen and
 *   before anything is written or started.
 * - `pi-sdk-client.ts` hands the running session's runtime out read-only, and the command
 *   reads the catalogue from it while the write keeps its own runtime over the target, so
 *   no older list can send a credential into the profile the row no longer points at.
 * - `extension.ts` registers the command id, wires the session's runtime to it, and
 *   `package.json` declares it with a Spanish title, so the palette and the registration
 *   cannot drift apart.
 *
 * The owner-facing sentences are taken from the product's own exported tables and
 * builders (`LOGIN_TEXTS`, `PROVIDER_KINDS`, `PROVIDER_MARKERS`, `loginSuccessText`,
 * `loginSyncFailureText`, and `profileNameFor` from `instance.ts` — the two profile names
 * have one home, so they are read from it instead of being restated here) instead of being
 * copied here, so there is one copy of every wording. They are printed verbatim at the end.
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
  const instancePath = path.join(EXTENSION_ROOT, "out", "instance.js");
  for (const compiled of [commandPath, instancePath]) {
    if (!fs.existsSync(compiled)) {
      console.error(`Missing ${compiled}. Run "npm run compile" first.`);
      process.exit(2);
    }
  }
  const api = await import(pathToFileURL(commandPath).href);
  // The two profile names are read from the module that owns them, not restated here.
  const instance = await import(pathToFileURL(instancePath).href);

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

  // The list must come from the runtime of the profile in force when there is one, and
  // building PiCode's own profile is exactly what must not happen merely by opening the
  // command. Both halves are executed over fake runtimes, because the real ones would
  // build a real profile on this machine.
  const liveFake = {
    getProviders: () => [],
    isUsingOAuth: () => false,
    isUsingSubscription: () => false,
    hasConfiguredAuth: () => false,
    login: async () => ({ type: "api_key" }),
  };
  let targetBuilds = 0;
  const withLive = await api.catalogueRuntime(liveFake, async () => {
    targetBuilds += 1;
    return undefined;
  });
  check(
    "with a live session the list comes from it and the target profile is never built",
    withLive === liveFake && targetBuilds === 0,
    `runtime is the live one: ${withLive === liveFake}, target builds: ${targetBuilds}`,
  );

  const fallbackFake = {
    getProviders: () => [],
    isUsingOAuth: () => false,
    isUsingSubscription: () => false,
    hasConfiguredAuth: () => false,
    login: async () => ({ type: "api_key" }),
  };
  let fallbackBuilds = 0;
  const withoutLive = await api.catalogueRuntime(undefined, async () => {
    fallbackBuilds += 1;
    return fallbackFake;
  });
  check(
    "with no session the fallback builds the target's runtime, exactly once",
    withoutLive === fallbackFake && fallbackBuilds === 1,
    `runtime is the fallback: ${withoutLive === fallbackFake}, target builds: ${fallbackBuilds}`,
  );

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

  // --- the unknown-provider error, read by its shape -------------------------

  // pi-ai's `Models.login` throws `ModelsError("provider", "Unknown provider: <id>")`
  // when the runtime has no provider by that id. The match is by the error's shape — the
  // class `name` and the `code` — plus the message prefix, because other `ModelsError`s
  // share the `provider` code and must keep flowing to the generic ending. These checks
  // execute both directions: the exact shape is recognised, and every near miss is not.
  const unknownShape = { name: "ModelsError", code: "provider", message: "Unknown provider: omni" };
  check(
    "pi's Unknown provider error is recognised and its id read",
    api.unknownProvider(unknownShape) === "omni",
    JSON.stringify(api.unknownProvider(unknownShape)),
  );
  check(
    "another failure is not swallowed as an unknown provider",
    api.unknownProvider(new Error("boom")) === undefined &&
      api.unknownProvider(undefined) === undefined &&
      api.unknownProvider("Unknown provider: omni") === undefined &&
      api.unknownProvider({ name: "Error", code: "provider", message: "Unknown provider: omni" }) === undefined &&
      api.unknownProvider({
        name: "ModelsError",
        code: "auth",
        message: "Zhipu does not support api_key login",
      }) === undefined &&
      api.unknownProvider({
        name: "ModelsError",
        code: "provider",
        message: "Provider omni does not support deferred responses",
      }) === undefined &&
      api.unknownProvider({ name: "ModelsError", code: "provider" }) === undefined,
    JSON.stringify([
      api.unknownProvider(new Error("boom")),
      api.unknownProvider(undefined),
      api.unknownProvider("Unknown provider: omni"),
      api.unknownProvider({ name: "Error", code: "provider", message: "Unknown provider: omni" }),
      api.unknownProvider({ name: "ModelsError", code: "auth", message: "Zhipu does not support api_key login" }),
      api.unknownProvider({
        name: "ModelsError",
        code: "provider",
        message: "Provider omni does not support deferred responses",
      }),
      api.unknownProvider({ name: "ModelsError", code: "provider" }),
    ]),
  );

  // --- the four endings ------------------------------------------------------

  const successOwn = api.loginSuccessText("Zhipu", instance.profileNameFor(true));
  const successOwner = api.loginSuccessText("Zhipu", instance.profileNameFor(false));
  const syncFailure = api.loginSyncFailureText("Zhipu", "login");
  const unknownProvider = api.unknownProviderText("Zhipu", true);
  const unknownProviderOwner = api.unknownProviderText("Zhipu", false);

  check(
    "the confirmation says where the credential goes and whose profile that is",
    api.LOGIN_TEXTS.ownerProfileConfirm.includes("el perfil de tu pi") &&
      api.LOGIN_TEXTS.ownerProfileConfirm.includes("el mismo que usa tu pi instalado en ") &&
      api.LOGIN_TEXTS.ownerProfileConfirm.includes("El pi que ejecuta el editor es el tuyo") &&
      !/no se puede|no tiene un perfil/i.test(api.LOGIN_TEXTS.ownerProfileConfirm),
    api.LOGIN_TEXTS.ownerProfileConfirm,
  );
  check(
    "the confirmation is one button and one honest refusal, and neither reads as a failure",
    api.LOGIN_TEXTS.ownerProfileContinue.includes("perfil de mi pi") &&
      api.LOGIN_TEXTS.ownerProfileDeclined.includes("no se escribió nada") &&
      api.LOGIN_TEXTS.ownerProfileDeclined.includes("No se inició sesión") &&
      !/error|fall/i.test(api.LOGIN_TEXTS.ownerProfileDeclined),
    `${api.LOGIN_TEXTS.ownerProfileContinue} / ${api.LOGIN_TEXTS.ownerProfileDeclined}`,
  );
  check(
    "the old refusal to log in with the owner's pi selected is gone from the table",
    api.LOGIN_TEXTS.ownerInstance === undefined &&
      !Object.values(api.LOGIN_TEXTS).some((text) => /Cambia la fila/.test(text)),
    JSON.stringify(api.LOGIN_TEXTS.ownerInstance),
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
    "the success ending names the provider, the profile in words, and the reload",
    successOwn.includes("Zhipu") &&
      successOwn.includes("el perfil propio de PiCode") &&
      successOwn.includes("Recarga la ventana"),
    successOwn,
  );
  check(
    "the success ending prints no path, whichever profile it wrote",
    !successOwn.includes("/") &&
      !successOwn.includes("\\") &&
      !successOwner.includes("/") &&
      !successOwner.includes("\\"),
    `${successOwn} / ${successOwner}`,
  );
  check(
    "with the owner's pi selected the success ending names his profile instead",
    successOwner.includes("el perfil de tu pi") &&
      !successOwner.includes("perfil propio de PiCode") &&
      successOwner.includes("Recarga la ventana"),
    successOwner,
  );
  check(
    "the two profile names are the two the writer may have written into",
    instance.profileNameFor(true) === "el perfil propio de PiCode" &&
      instance.profileNameFor(false) === "el perfil de tu pi",
    `${instance.profileNameFor(true)} / ${instance.profileNameFor(false)}`,
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
    "the endings are as many different sentences as there are endings",
    new Set([
      api.LOGIN_TEXTS.ownerProfileConfirm,
      api.LOGIN_TEXTS.ownerProfileDeclined,
      api.LOGIN_TEXTS.noSdk,
      api.LOGIN_TEXTS.noCatalogue,
      api.LOGIN_TEXTS.noProviders,
      api.LOGIN_TEXTS.cancelled,
      successOwn,
      successOwner,
      syncFailure,
    ]).size === 9,
    JSON.stringify([
      api.LOGIN_TEXTS.ownerProfileConfirm,
      api.LOGIN_TEXTS.ownerProfileDeclined,
      api.LOGIN_TEXTS.noSdk,
      api.LOGIN_TEXTS.noCatalogue,
      api.LOGIN_TEXTS.noProviders,
      api.LOGIN_TEXTS.cancelled,
      successOwn,
      successOwner,
      syncFailure,
    ]),
  );
  check(
    "the confirmation's button is a label, not one of the sentences",
    ![
      api.LOGIN_TEXTS.ownerProfileConfirm,
      api.LOGIN_TEXTS.ownerProfileDeclined,
      successOwn,
      successOwner,
    ].includes(api.LOGIN_TEXTS.ownerProfileContinue) &&
      api.LOGIN_TEXTS.ownerProfileContinue.length < api.LOGIN_TEXTS.ownerProfileConfirm.length,
    api.LOGIN_TEXTS.ownerProfileContinue,
  );
  check(
    "an unknown operation is passed through instead of guessed at",
    api.operationText("somethingNew") === "somethingNew",
    api.operationText("somethingNew"),
  );
  check(
    "the unknown-provider ending explains the missing package and points at the import in the row's words",
    unknownProvider.includes("Zhipu") &&
      unknownProvider.includes("paquete") &&
      unknownProvider.includes("Importar el perfil de tu pi"),
    unknownProvider,
  );
  check(
    "for the owner's own profile the same ending names his profile and the door that works there",
    unknownProviderOwner.includes("el perfil de tu pi") &&
      unknownProviderOwner.includes("paquete") &&
      unknownProviderOwner.includes("pestaña de extensiones") &&
      !unknownProviderOwner.includes("Importar el perfil de tu pi"),
    unknownProviderOwner,
  );
  check(
    "the unknown-provider ending is not the generic failure ending",
    unknownProvider !== api.loginFailureText("Zhipu", "Unknown provider: zhipu"),
    unknownProvider,
  );
  check(
    "the unknown-provider ending is its own sentence, not one of the others",
    new Set([
      api.LOGIN_TEXTS.ownerProfileConfirm,
      api.LOGIN_TEXTS.ownerProfileDeclined,
      api.LOGIN_TEXTS.noSdk,
      api.LOGIN_TEXTS.cancelled,
      successOwn,
      successOwner,
      syncFailure,
      unknownProvider,
    ]).size === 8,
    JSON.stringify([unknownProvider]),
  );

  // --- the target profile, checked at the source -----------------------------

  const commandSource = fs.readFileSync(
    path.join(SOURCE_ROOT, "pi-login-command.ts"),
    "utf8",
  );
  check(
    "the command resolves its target through the writer's unguarded answer",
    /\binstanceProfileDir\s*\(/.test(commandSource),
    "no instanceProfileDir( call found",
  );
  check(
    "the command never names the guarded readers' answer",
    !commandSource.includes("selectedAgentDir"),
    "the guarded reader resolver is named in the command source",
  );
  check(
    "the command still asks instanceAgentDir( for who owns the target",
    /\binstanceAgentDir\s*\(/.test(commandSource) &&
      /ownsProfile\s*=\s*instanceAgentDir\([^;]*!==\s*undefined/.test(commandSource),
    "the ownership flag is not derived from instanceAgentDir(",
  );
  check(
    "the target is the profile of the selected instance, and no longer a refusal",
    !/LOGIN_TEXTS\.ownerInstance/.test(commandSource) &&
      !commandSource.includes("target === undefined") &&
      /const target = instanceProfileDir\(context\.extensionUri, runtimeMode\)/.test(
        commandSource,
      ),
    "the target is not resolved through instanceProfileDir, or the old refusal survived",
  );
  check(
    "the two instance decisions are imported from the module that owns them",
    /import\s*\{[^}]*\binstanceAgentDir\b[^}]*\binstanceProfileDir\b[^}]*\bprofileNameFor\b[^}]*\}\s*from\s*"\.\/instance"/.test(
      commandSource,
    ),
    "the login command does not take its resolvers and the profile names from instance.ts",
  );
  check(
    "the modal confirmation is gated on the owner's instance",
    /if \(!ownsProfile\) \{\s*const proceed = await vscode\.window\.showWarningMessage\(/.test(
      commandSource,
    ) &&
      commandSource.includes("LOGIN_TEXTS.ownerProfileConfirm") &&
      commandSource.includes("LOGIN_TEXTS.ownerProfileContinue") &&
      commandSource.includes("LOGIN_TEXTS.ownerProfileDeclined") &&
      /\{ modal: true \}/.test(commandSource),
    "the owner's profile is written without a modal confirmation gated on the owner's instance",
  );
  check(
    "the confirmation sits after the provider was chosen and before anything is written",
    commandSource.indexOf("chooseProvider(entries)") <
      commandSource.indexOf("if (!ownsProfile)") &&
      commandSource.indexOf("if (!ownsProfile)") <
        commandSource.indexOf("writer.login(chosen.id") &&
      commandSource.indexOf("if (!ownsProfile)") < commandSource.indexOf("const writer ="),
    "the confirmation is not between the provider choice and the write",
  );
  check(
    "the success ending names the profile in words, never the path it wrote",
    /loginSuccessText\(chosen\.label, profileNameFor\(ownsProfile\)\)/.test(commandSource) &&
      !/loginSuccessText\(chosen\.label, target\)/.test(commandSource),
    "the success ending still prints the target path",
  );
  check(
    "the command reads the running session's runtime, and falls back to the target's",
    /const running = liveRuntime\(\);/.test(commandSource) &&
      /await catalogueRuntime\(running, async \(\)/.test(commandSource),
    "the live runtime is not the catalogue source, or the fallback is gone",
  );
  check(
    "the command keeps the no-session fallback and writes down what it may create",
    /builtForTarget = await targetRuntime\(\);/.test(commandSource) &&
      commandSource.includes("createAgentSessionServices({ agentDir: target })") &&
      commandSource.includes("empty `auth.json`"),
    "the fallback or its documented cost is missing",
  );
  check(
    "the write keeps its own runtime over the target profile, never the live one",
    /const writer = builtForTarget \?\? \(await targetRuntime\(\)\)/.test(commandSource) &&
      /writer\.login\(chosen\.id, chosen\.type, createAuthInteraction\(\)\)/.test(
        commandSource,
      ) &&
      !/catalogue\.login\(/.test(commandSource),
    "the login call is not anchored to the target profile's own runtime",
  );
  check(
    "the flow recognises the unknown-provider shape before the generic ending",
    /if \(unknownProvider\(error\) !== undefined\) \{/.test(commandSource) &&
      commandSource.indexOf("unknownProvider(error)") <
        commandSource.indexOf("loginFailureText(chosen.label, asErrorMessage(error))"),
    "the unknown-provider branch is missing or comes after the generic failure",
  );

  const sdkSource = fs.readFileSync(path.join(SOURCE_ROOT, "pi-sdk-client.ts"), "utf8");
  check(
    "the embedded client hands its running session's runtime out read-only",
    /get sessionRuntime\(\): SdkModelRuntime \| undefined/.test(sdkSource) &&
      /return this\.session\?\.modelRuntime;/.test(sdkSource),
    "no sessionRuntime getter returning the session's runtime or undefined",
  );

  const extensionSource = fs.readFileSync(path.join(SOURCE_ROOT, "extension.ts"), "utf8");
  check(
    "extension.ts registers the command id it imports",
    extensionSource.includes("LOGIN_PROVIDER_COMMAND") &&
      /registerCommand\(\s*LOGIN_PROVIDER_COMMAND/.test(extensionSource) &&
      /loginProvider\(context,\s*liveLoginRuntime\)/.test(extensionSource),
    "the registration for LOGIN_PROVIDER_COMMAND was not found",
  );
  check(
    "extension.ts wires the running session's runtime to the command",
    /client instanceof PiSdkClient \? client\.sessionRuntime : undefined/.test(extensionSource),
    "the live login runtime accessor is not wired",
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
  console.log(`[confirm]  ${api.LOGIN_TEXTS.ownerProfileConfirm}`);
  console.log(`[button]   ${api.LOGIN_TEXTS.ownerProfileContinue}`);
  console.log(`[declined] ${api.LOGIN_TEXTS.ownerProfileDeclined}`);
  console.log(`[no sdk]   ${api.LOGIN_TEXTS.noSdk}`);
  console.log(`[cancel]   ${api.LOGIN_TEXTS.cancelled}`);
  console.log(`[success]  ${successOwn}`);
  console.log(`[success]  ${successOwner}`);
  console.log(`[sync]     ${syncFailure}`);
  console.log(`[unknown]  ${unknownProvider}`);
  console.log(`[unknown-owner]  ${unknownProviderOwner}`);
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
