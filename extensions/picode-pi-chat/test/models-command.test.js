/*
 * Exercises the custom-endpoint command: where it reads and writes, what it refuses, and
 * the exact words it says while doing it.
 *
 * The command itself is never run here — it would open pickers, and there is no editor —
 * but every decision it makes before a picker is. Three things are asserted, and the first
 * is the one the whole feature turns on:
 *
 * - **The profile.** `readModelsProviders` is a total mapping from the selected instance to
 *   a directory, and it is the *same* mapping the provider login uses: `managed` names
 *   `<distribution>/data/pi-agent`, and `path`/`custom` name the profile the owner's
 *   installed pi reads (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`). The guarded readers'
 *   answer is proven absent at the source, because on an empty internal profile it names the
 *   machine's profile — and this surface would then show a stranger's providers while saying
 *   they belong to the instance the row names. The check runs the resolver over throwaway
 *   distributions and a fixture `PI_CODING_AGENT_DIR`, so no profile on this machine is read
 *   or written.
 * - **The file.** A missing `models.json` is an empty list and no error; one with providers
 *   answers their ids and the one-line summary the settings row shows; and a file that does
 *   not parse is refused with its own sentence instead of being reported as empty, because a
 *   write over it would drop whatever it held.
 * - **The words.** Each field's validator and each ending are read from the module's own
 *   exports rather than restated here, so the sentence the owner reads while typing is the
 *   sentence this suite pins. One check is a privacy rule: the ending after a provider was
 *   written never prints the key it was given, in any of pi's three forms.
 *
 * The `vscode` module is stubbed through a resolver hook, as the other suites do, so the
 * compiled module loads without an editor; `TEST_RUNTIME_MODE` is what the stub answers for
 * `picode.pi.runtime`, and it is the only thing here that pretends to be an editor.
 *
 * Run with: npm test
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
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

/** The one thing the stub reads back for `picode.pi.runtime`. */
function mode(value) {
  if (value === undefined) {
    delete process.env.TEST_RUNTIME_MODE;
  } else {
    process.env.TEST_RUNTIME_MODE = value;
  }
}

/** Writes a file, creating its parent directories. */
function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A `models.json` declaring the given providers, in file order. */
function modelsJson(providers) {
  return JSON.stringify({ providers }, null, 2);
}

async function main() {
  const commandPath = path.join(EXTENSION_ROOT, "out", "models-command.js");
  const configPath = path.join(EXTENSION_ROOT, "out", "models-config.js");
  for (const compiled of [commandPath, configPath]) {
    if (!fs.existsSync(compiled)) {
      console.error(`Missing ${compiled}. Run "npm run compile" first.`);
      process.exit(2);
    }
  }
  const api = await import(pathToFileURL(commandPath).href);
  const config = await import(pathToFileURL(configPath).href);

  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });
  const cleanups = [];
  const cleanup = (dir) => cleanups.push(dir);

  // --- a throwaway distribution, and a throwaway machine profile -------------

  /*
   * The distribution is laid out the way the real one is — `<root>/resources/app/
   * extensions/picode-pi-chat` — because the resolver walks four levels up from the
   * extension's own path to find `<root>/data/pi-agent`. The owner's profile is a fixture
   * directory the environment points at, which is exactly how pi itself resolves it.
   */
  function distribution(prefix) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanup(root);
    return {
      extensionUri: { fsPath: path.join(root, "resources", "app", "extensions", "picode-pi-chat") },
      internalProfile: path.join(root, "data", "pi-agent"),
    };
  }

  const machineProfile = fs.mkdtempSync(path.join(os.tmpdir(), "picode-machine-profile-"));
  cleanup(machineProfile);

  const agentDirBefore = process.env.PI_CODING_AGENT_DIR;

  // --- the target profile, per mode -----------------------------------------

  const ownDistribution = distribution("picode-models-dist-");

  // PiCode's own instance, with nothing declared yet and no file at all.
  mode("managed");
  process.env.PI_CODING_AGENT_DIR = machineProfile;
  writeFile(
    path.join(machineProfile, "models.json"),
    modelsJson({ stranger: { baseUrl: "https://example.test/v1", api: "openai-completions" } }),
  );

  const emptyOwn = api.readModelsProviders(ownDistribution.extensionUri);
  check(
    "the managed instance's models.json is read from <distribution>/data/pi-agent",
    emptyOwn.profileDir === ownDistribution.internalProfile,
    `${emptyOwn.profileDir} (expected ${ownDistribution.internalProfile})`,
  );
  check(
    "the managed instance is named as PiCode's own profile",
    emptyOwn.owned === true && emptyOwn.profileName === "el perfil propio de PiCode",
    `${emptyOwn.owned} / ${emptyOwn.profileName}`,
  );
  check(
    "anti-mute: with PiCode's own profile empty, the machine's providers are not shown as its own",
    emptyOwn.providers.length === 0 &&
      emptyOwn.problem === undefined &&
      !emptyOwn.summary.includes("stranger"),
    JSON.stringify({ providers: emptyOwn.providers, summary: emptyOwn.summary }),
  );
  check(
    "a missing models.json is the empty object pi itself would read, so the first write starts from it",
    emptyOwn.json !== undefined &&
      Object.keys(emptyOwn.json).length === 0 &&
      emptyOwn.summary === "Ninguno todavía en el perfil propio de PiCode.",
    `${JSON.stringify(emptyOwn.json)} / ${emptyOwn.summary}`,
  );
  check(
    "the summary names the profile in words and never a path",
    !emptyOwn.summary.includes(ownDistribution.internalProfile) &&
      !emptyOwn.summary.includes("/") &&
      !emptyOwn.summary.includes("\\"),
    emptyOwn.summary,
  );

  // The owner's instance: the same file name under a different profile, and a different name.
  mode("path");
  const ownerState = api.readModelsProviders(ownDistribution.extensionUri);
  check(
    "the path instance reads the profile PI_CODING_AGENT_DIR names",
    ownerState.profileDir === machineProfile && ownerState.owned === false,
    `${ownerState.profileDir} (expected ${machineProfile})`,
  );
  check(
    "the path instance is named as the owner's own pi",
    ownerState.profileName === "el perfil de tu pi",
    ownerState.profileName,
  );

  mode("custom");
  check(
    "the custom instance reads the same profile the path instance does",
    api.readModelsProviders(ownDistribution.extensionUri).profileDir === machineProfile,
    api.readModelsProviders(ownDistribution.extensionUri).profileDir,
  );

  delete process.env.PI_CODING_AGENT_DIR;
  mode("path");
  check(
    "without the variable, the owner's profile is pi's own default directory",
    api.readModelsProviders(ownDistribution.extensionUri).profileDir ===
      path.join(os.homedir(), ".pi", "agent"),
    api.readModelsProviders(ownDistribution.extensionUri).profileDir,
  );
  process.env.PI_CODING_AGENT_DIR = machineProfile;

  // --- what the file declares, and what a broken one is ----------------------

  const declared = {
    ollama: {
      baseUrl: "http://localhost:11434/v1",
      api: "openai-completions",
      apiKey: "$OLLAMA_API_KEY",
      models: [{ id: "qwen2.5-coder:7b" }, "llama3.1:8b"],
    },
    gateway: {
      baseUrl: "https://gateway.example.test/v1",
      api: "openai-responses",
      models: [{ id: "auto" }],
    },
    foreign: { baseUrl: "https://foreign.example.test/v1", api: "mistral-conversations" },
    fourth: { baseUrl: "https://fourth.example.test/v1", api: "openai-completions" },
    fifth: { baseUrl: "https://fifth.example.test/v1", api: "openai-completions" },
  };
  writeFile(path.join(machineProfile, "models.json"), modelsJson(declared));

  const read = api.readModelsProviders(ownDistribution.extensionUri);
  check(
    "a models.json with providers answers their ids, ordered by id, whatever order the file declared them in",
    read.providers.map((provider) => provider.id).join(",") ===
      "fifth,foreign,fourth,gateway,ollama",
    JSON.stringify(read.providers.map((provider) => provider.id)),
  );
  check(
    "the summary is the one line the settings row shows, built by the module that owns it",
    read.summary ===
      config.describeConfiguredProviders(read.providers, "el perfil de tu pi") &&
      read.summary.startsWith("5 proveedores propios en el perfil de tu pi"),
    read.summary,
  );
  check(
    "the parsed file is handed on, so a write starts from what pi reads",
    read.json !== undefined && read.providers.length === 5,
    JSON.stringify(read.json === undefined),
  );

  writeFile(path.join(machineProfile, "models.json"), "{ not json");
  const broken = api.readModelsProviders(ownDistribution.extensionUri);
  check(
    "a models.json that is not JSON is refused, never reported as empty",
    broken.problem === "not-json" &&
      broken.json === undefined &&
      broken.providers.length === 0 &&
      broken.summary === api.refusedSummary("el perfil de tu pi") &&
      broken.summary !== "Ninguno todavía en el perfil de tu pi.",
    JSON.stringify({ problem: broken.problem, summary: broken.summary }),
  );
  check(
    "the refusal says which file, which problem, and that nothing is written over it",
    api.refusedText("el perfil de tu pi", "not-json").includes("models.json") &&
      api.refusedText("el perfil de tu pi", "not-json").includes("el perfil de tu pi") &&
      api.refusedText("el perfil de tu pi", "not-json").includes("JSON") &&
      api.refusedText("el perfil de tu pi", "not-json").includes("se escribe encima") &&
      !api.refusedText("el perfil de tu pi", "not-json").includes(machineProfile),
    api.refusedText("el perfil de tu pi", "not-json"),
  );
  check(
    "each of the four ways the file can be unusable has its own sentence",
    new Set([
      api.refusedText("un perfil", "not-json"),
      api.refusedText("un perfil", "not-object"),
      api.refusedText("un perfil", "providers-not-object"),
      api.refusedText("un perfil", "unreadable"),
    ]).size === 4,
    JSON.stringify([
      api.refusedText("un perfil", "not-json"),
      api.refusedText("un perfil", "not-object"),
      api.refusedText("un perfil", "providers-not-object"),
      api.refusedText("un perfil", "unreadable"),
    ]),
  );
  writeFile(path.join(machineProfile, "models.json"), modelsJson(declared));

  // A `auth.json` that is a directory proves the I/O failure is not read as "empty" either.
  const unreadable = distribution("picode-models-unreadable-");
  fs.mkdirSync(path.join(unreadable.internalProfile, "models.json"), { recursive: true });
  mode("managed");
  const unreadableState = api.readModelsProviders(unreadable.extensionUri);
  check(
    "an unreadable models.json is refused too, and not reported as empty",
    unreadableState.problem === "unreadable" &&
      unreadableState.summary === api.refusedSummary("el perfil propio de PiCode"),
    JSON.stringify({ problem: unreadableState.problem, summary: unreadableState.summary }),
  );
  mode("path");

  // --- the rows the pickers draw --------------------------------------------

  const rows = api.providerRows(read.providers);
  const ollamaRow = rows.find((row) => row.id === "ollama");
  const gatewayRow = rows.find((row) => row.id === "gateway");
  check(
    "a provider row is labelled by its id and carries endpoint, api, models and whether it has a key",
    ollamaRow !== undefined &&
      ollamaRow.label === "ollama" &&
      ollamaRow.description === "http://localhost:11434/v1 · openai-completions" &&
      ollamaRow.detail ===
        `qwen2.5-coder:7b, llama3.1:8b · ${api.PROVIDER_ROW_MARKERS.hasKey}` &&
      gatewayRow !== undefined &&
      gatewayRow.detail === `auto · ${api.PROVIDER_ROW_MARKERS.noKey}`,
    JSON.stringify([ollamaRow, gatewayRow]),
  );
  check(
    "a provider whose entry declares no model says so instead of showing nothing",
    api.providerRow({ id: "x", models: [], hasKey: false }).detail ===
      `${api.PROVIDER_ROW_MARKERS.noModels} · ${api.PROVIDER_ROW_MARKERS.noKey}`,
    api.providerRow({ id: "x", models: [], hasKey: false }).detail,
  );
  check(
    "removing is offered only when there is something to remove",
    api.actionItems([]).map((item) => item.action).join(",") === "add" &&
      api.actionItems(read.providers).map((item) => item.action).join(",") === "add,remove",
    JSON.stringify(api.actionItems(read.providers).map((item) => item.action)),
  );
  check(
    "the two actions are the owner's words, and only the first is a description of the row's own flow",
    api.actionItems(read.providers)[0].label === "Añadir un proveedor" &&
      api.actionItems(read.providers)[1].label === "Quitar un proveedor",
    JSON.stringify(api.actionItems(read.providers).map((item) => item.label)),
  );
  check(
    "the api rows come from pi's own declared list, with the id the file will hold",
    api.apiItems().length === config.PROVIDER_APIS.length &&
      api.apiItems()[0].value === config.PROVIDER_APIS[0].value &&
      api.apiItems()[0].label === config.PROVIDER_APIS[0].label &&
      api.apiItems()[0].description === config.PROVIDER_APIS[0].value,
    JSON.stringify(api.apiItems()[0]),
  );

  // --- what each field of the form accepts ----------------------------------

  check(
    "a provider id is required and has pi's own shape",
    api.idProblem("") === api.MODELS_TEXTS.idRequired &&
      api.idProblem("   ") === api.MODELS_TEXTS.idRequired &&
      api.idProblem("ollama") === undefined &&
      api.idProblem("qwen.local_2-x") === undefined &&
      api.idProblem("ollama/v1") === api.MODELS_TEXTS.idInvalid &&
      api.idProblem("-ollama") === api.MODELS_TEXTS.idInvalid &&
      api.idProblem("with space") === api.MODELS_TEXTS.idInvalid &&
      api.idProblem("a".repeat(65)) === api.MODELS_TEXTS.idInvalid,
    String(api.idProblem("ollama/v1")),
  );
  check(
    "the endpoint is required and has to be an http(s) URL",
    api.baseUrlProblem("") === api.MODELS_TEXTS.baseUrlRequired &&
      api.baseUrlProblem("http://localhost:11434/v1") === undefined &&
      api.baseUrlProblem(" https://gateway.example.test/v1 ") === undefined &&
      api.baseUrlProblem("localhost:11434") === api.MODELS_TEXTS.baseUrlInvalid &&
      api.baseUrlProblem("ftp://example.test") === api.MODELS_TEXTS.baseUrlInvalid,
    String(api.baseUrlProblem("localhost:11434")),
  );
  check(
    "the models field refuses a value that declares nothing",
    api.modelIdsProblem("") === api.MODELS_TEXTS.modelsRequired &&
      api.modelIdsProblem("   ,  ;  ") === api.MODELS_TEXTS.modelsRequired &&
      // `gpt 4` is refused rather than guessed at, so a value made only of those is empty.
      api.modelIdsProblem("gpt 4") === api.MODELS_TEXTS.modelsRequired &&
      api.modelIdsProblem("qwen2.5-coder:7b, llama3.1:8b") === undefined,
    String(api.modelIdsProblem("gpt 4")),
  );
  check(
    "the key field accepts pi's three forms, refuses a malformed one, and empty is not an error",
    api.keyProblem("") === undefined &&
      api.keyProblem("   ") === undefined &&
      api.keyProblem("$OLLAMA_API_KEY") === undefined &&
      api.keyProblem("${OLLAMA_API_KEY}") === undefined &&
      api.keyProblem("!security find-generic-password -w") === undefined &&
      api.keyProblem("sk-a-literal-key") === undefined &&
      api.keyProblem("$1BAD") === api.MODELS_TEXTS.keyEnvInvalid &&
      api.keyProblem("!") === api.MODELS_TEXTS.keyCommandInvalid,
    JSON.stringify([
      api.keyProblem("$1BAD"),
      api.keyProblem("!"),
      api.keyProblem("${OLLAMA_API_KEY}"),
    ]),
  );

  // --- the endings ----------------------------------------------------------

  const input = {
    id: "ollama",
    baseUrl: "http://localhost:11434/v1",
    api: "openai-completions",
    apiKey: "sk-THE-SECRET-KEY-42",
    modelIds: ["qwen2.5-coder:7b", "llama3.1:8b"],
  };
  const added = api.addedText(input, "el perfil de tu pi", []);
  check(
    "the ending after a write names what was declared, in which profile, and the reload",
    added.includes("ollama") &&
      added.includes("el perfil de tu pi") &&
      added.includes("http://localhost:11434/v1") &&
      added.includes("openai-completions") &&
      added.includes("2 modelos") &&
      added.includes("Recargar la ventana"),
    added,
  );
  check(
    "the ending after a write prints no path and never the key, in any of its forms",
    !added.includes(machineProfile) &&
      !added.includes("/home") &&
      !added.includes(input.apiKey) &&
      !added.includes("sk-") &&
      !api
        .addedText({ ...input, apiKey: "$OLLAMA_API_KEY" }, "un perfil", [])
        .includes("$OLLAMA_API_KEY") &&
      !api
        .addedText({ ...input, apiKey: "!security -w" }, "un perfil", [])
        .includes("!security"),
    added,
  );
  check(
    "a model id the form had to discard is named instead of dropped silently",
    api.addedText(input, "un perfil", ["gpt 4"]).includes("gpt 4") &&
      !api.addedText(input, "un perfil", []).includes("gpt 4"),
    api.addedText(input, "un perfil", ["gpt 4"]),
  );
  check(
    "one model is counted in the singular",
    api.addedText({ ...input, modelIds: ["auto"] }, "un perfil", []).includes("1 modelo.") &&
      !api.addedText({ ...input, modelIds: ["auto"] }, "un perfil", []).includes("1 modelos"),
    api.addedText({ ...input, modelIds: ["auto"] }, "un perfil", []),
  );
  check(
    "the ending after a removal names the id, the profile and the reload",
    api.removedText("ollama", "el perfil propio de PiCode").includes("ollama") &&
      api.removedText("ollama", "el perfil propio de PiCode").includes(
        "el perfil propio de PiCode",
      ) &&
      api.removedText("ollama", "el perfil propio de PiCode").includes("Recargar la ventana") &&
      !api.removedText("ollama", "un perfil").includes(machineProfile),
    api.removedText("ollama", "el perfil propio de PiCode"),
  );
  check(
    "the write failure ending carries the reason it was given and not a paraphrase",
    api.writeFailedText("EACCES: permission denied").includes("EACCES") &&
      api.writeFailedText("EACCES: permission denied").includes("models.json"),
    api.writeFailedText("EACCES: permission denied"),
  );
  check(
    "every ending is as many different sentences as there are endings",
    new Set([
      api.MODELS_TEXTS.cancelled,
      api.refusedSummary("un perfil"),
      api.refusedText("un perfil", "not-json"),
      added,
      api.removedText("ollama", "un perfil"),
      api.writeFailedText("boom"),
    ]).size === 6,
    JSON.stringify([added, api.removedText("ollama", "un perfil")]),
  );

  // --- the target profile, checked at the source -----------------------------

  const commandSource = fs.readFileSync(path.join(SOURCE_ROOT, "models-command.ts"), "utf8");
  check(
    "the command resolves its target through the writer's unguarded answer",
    /\binstanceProfileDir\s*\(/.test(commandSource) &&
      /instanceProfileDir\(extensionUri, mode\)/.test(commandSource),
    "no instanceProfileDir(extensionUri, mode) call found",
  );
  check(
    "the command never names the guarded readers' answer",
    !commandSource.includes("selectedAgentDir"),
    "the guarded reader resolver is named in the command source",
  );
  check(
    "the command names no command id of the provider login",
    !commandSource.includes("picode.piChat.loginProvider") &&
      !commandSource.includes("LOGIN_PROVIDER_COMMAND"),
    "the login command id is named in the command source",
  );
  check(
    "the two profile decisions are imported from the modules that own them",
    /import\s*\{[^}]*\binstanceProfileDir\b[^}]*\bprofileNameFor\b[^}]*\}\s*from\s*"\.\/instance"/.test(
      commandSource,
    ) &&
      /import\s*\{[^}]*\bdescribeConfiguredProviders\b[^}]*\bwriteModelsFile\b[^}]*\}\s*from\s*"\.\/models-config"/.test(
        commandSource,
      ),
    "the command does not take its resolvers or its file handling from the modules that own them",
  );
  check(
    "the reload offer is the one label the other surfaces use",
    /import \{ RELOAD_WINDOW_LABEL \} from "\.\/instance-import-command";/.test(commandSource),
    "the reload label is not the shared one",
  );
  check(
    "the write goes through the module that preserves what it does not own",
    /upsertConfiguredProvider\(/.test(commandSource) &&
      /removeConfiguredProvider\(/.test(commandSource) &&
      !/writeFileSync|renameSync/.test(commandSource),
    "the command writes the file itself instead of going through models-config",
  );
  check(
    "the refusal is decided before any picker is opened",
    commandSource.indexOf("state.problem !== undefined") <
      commandSource.indexOf("await chooseAction("),
    "the refusal does not come before the first picker",
  );
  /*
   * The confirmation in front of the write, pinned at the source because the flow itself
   * needs an editor to run. It is the one guard the owner's profile has, and the defect it
   * prevents — writing a profile that belongs to every other pi tool on the machine, without
   * asking — is invisible in a diff that only looks at what the write does.
   */
  check(
    "the flow asks one confirmation before writing, and it is the last thing before the write",
    /await confirmWrite\(state, change\)/.test(commandSource) &&
      commandSource.indexOf("await confirmWrite(state, change)") <
        commandSource.indexOf("writeState(state, change.json)") &&
      /state\.owned\b/.test(commandSource),
    "no confirmWrite before writeState",
  );
  check(
    "the confirmation in the owner's profile names the act and the profile, and the login's is not reused",
    api.MODELS_TEXTS.ownerAddConfirm("ollama").includes("guardar el proveedor «ollama»") &&
      api.MODELS_TEXTS.ownerAddConfirm("ollama").includes("perfil de tu pi") &&
      api.MODELS_TEXTS.ownerRemoveConfirm("ollama").includes("quitar el proveedor «ollama»") &&
      api.MODELS_TEXTS.ownerRemoveConfirm("ollama").includes("perfil de tu pi") &&
      api.MODELS_TEXTS.ownerContinue.includes("perfil de mi pi") &&
      api.MODELS_TEXTS.ownerDeclined.includes("No se cambió nada") &&
      !api.MODELS_TEXTS.ownerAddConfirm("ollama").includes(machineProfile),
    api.MODELS_TEXTS.ownerAddConfirm("ollama"),
  );
  check(
    "quitting a declared provider asks first, and says what does not change",
    api.MODELS_TEXTS.removeConfirm("ollama", "el perfil de tu pi").includes("quitar el proveedor «ollama»") &&
      api.MODELS_TEXTS.removeConfirm("ollama", "el perfil de tu pi").includes("Lo que pi trae de serie no cambia") &&
      api.MODELS_TEXTS.removeConfirm("ollama", "el perfil de tu pi").includes("el perfil de tu pi") &&
      api.MODELS_TEXTS.removeContinue === "Quitar",
    api.MODELS_TEXTS.removeConfirm("ollama", "el perfil de tu pi"),
  );
  check(
    "the one field that can hold a literal credential does not echo",
    /password: true/.test(commandSource) &&
      /\{ optional: true, password: true \}/.test(commandSource),
    "the key field is not masked",
  );

  const extensionSource = fs.readFileSync(path.join(SOURCE_ROOT, "extension.ts"), "utf8");
  check(
    "extension.ts registers the command id it imports",
    extensionSource.includes("MODELS_PROVIDERS_COMMAND") &&
      /registerCommand\(MODELS_PROVIDERS_COMMAND/.test(extensionSource) &&
      /modelsProviders\(context\)/.test(extensionSource),
    "the registration for MODELS_PROVIDERS_COMMAND was not found",
  );
  check(
    "extension.ts feeds the settings row from the same reading the command takes",
    /setModelsConfigStateSource\(\(\) => readModelsProviders\(context\.extensionUri\)\.summary\)/.test(
      extensionSource,
    ),
    "the models.json state source is not wired to the reader's summary",
  );

  // --- the command the palette runs ------------------------------------------

  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, "package.json"), "utf8"));
  const declaredRow = (manifest.contributes.commands ?? []).find(
    (entry) => entry.command === api.MODELS_PROVIDERS_COMMAND,
  );
  check(
    "the command id is declared in the manifest with a Spanish title",
    api.MODELS_PROVIDERS_COMMAND === "picode.piChat.modelsProviders" &&
      declaredRow !== undefined &&
      /^PiCode: /.test(declaredRow.title),
    JSON.stringify(declaredRow),
  );
  check(
    "the new suite is registered in the test chain",
    String(manifest.scripts.test).includes("test/models-command.test.js"),
    manifest.scripts.test,
  );

  // --- the exact text the owner reads ----------------------------------------

  console.log("--- the rows of the first picker, as the owner reads them ---");
  for (const item of api.actionItems(read.providers)) {
    console.log(`${item.label} — ${item.description}`);
  }
  console.log("--- the providers the removal picker lists, verbatim ---");
  for (const row of rows) {
    console.log(`${row.label} — ${row.description} (${row.detail})`);
  }
  console.log("--- the endings, verbatim ---");
  console.log(`[empty]    ${emptyOwn.summary}`);
  console.log(`[refused]  ${api.refusedText("el perfil de tu pi", "not-json")}`);
  console.log(`[added]    ${added}`);
  console.log(`[removed]  ${api.removedText("ollama", "el perfil propio de PiCode")}`);
  console.log(`[cancel]   ${api.MODELS_TEXTS.cancelled}`);
  console.log("---");

  // --- report ------------------------------------------------------------------

  if (agentDirBefore === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = agentDirBefore;
  }
  delete process.env.TEST_RUNTIME_MODE;
  for (const dir of cleanups) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

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
