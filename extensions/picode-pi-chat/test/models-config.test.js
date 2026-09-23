/*
 * Exercises the compiled `models.json` layer in plain Node.
 *
 * The module this suite covers is the contract a later surface builds on, so almost
 * everything here is a pure check: what a file parses into, what a provider looks like
 * once reduced to a row, what a merge keeps and what it replaces, and what the owner
 * reads. Three things are asserted beyond the pure halves, because they are the
 * reasons the module exists at all:
 *
 * - a merge never mutates its argument and never drops a key it does not own — not a
 *   provider's `name`/`headers`/`compat`, and not a model's `contextWindow` across a
 *   re-save, because a hand-written endpoint that loses its extra keys on save is
 *   worse than no form at all;
 * - a write is a replace, not a truncation: the target is read back as the same JSON,
 *   a second write replaces the first, no temp file survives, and a write that cannot
 *   complete throws while taking its own temp file with it;
 * - the file stays free of the credential file's name and of any editor import, so the
 *   layer can be reason about — and tested — without either.
 *
 * The real file I/O runs under `os.tmpdir()`; nothing in this suite reads or writes a
 * real profile. No `vscode` stub is installed here, and that is the point: the module
 * imports no editor module, so the compiled output loads as it is.
 *
 * Run with: npm test
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const EXTENSION_ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = path.join(EXTENSION_ROOT, "src");

async function main() {
  const compiled = path.join(EXTENSION_ROOT, "out", "models-config.js");
  if (!fs.existsSync(compiled)) {
    console.error(`Missing ${compiled}. Run "npm run compile" first.`);
    process.exit(2);
  }
  const loaded = await import(pathToFileURL(compiled).href);
  const api = loaded.parseModelsText ? loaded : loaded.default;

  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });
  const cleanups = [];
  const cleanup = (dir) => cleanups.push(dir);

  /** A configured provider reduced to what the sentence builder needs. */
  const provider = (id) => ({ id, models: [], hasKey: false });

  /* --- parsing a file ----------------------------------------------------- */

  const absent = api.parseModelsText(undefined);
  check(
    "an absent file parses as an empty object",
    absent.ok === true && Object.keys(absent.json).length === 0,
    JSON.stringify(absent),
  );

  const blank = [api.parseModelsText(""), api.parseModelsText("  \n\t ")];
  check(
    "an empty or whitespace-only file parses as an empty object",
    blank.every((result) => result.ok === true && Object.keys(result.json).length === 0),
    JSON.stringify(blank),
  );

  const broken = api.parseModelsText('{ "providers": ');
  check(
    "text that is not JSON is reported as such",
    broken.ok === false && broken.problem === "not-json",
    JSON.stringify(broken),
  );

  const notObject = ["[1]", '"text"', "3", "null"].map((text) => api.parseModelsText(text));
  check(
    "JSON that is not an object is reported as such",
    notObject.every((result) => result.ok === false && result.problem === "not-object"),
    JSON.stringify(notObject),
  );

  const providersNotObject = ['{"providers": []}', '{"providers": null}', '{"providers": "x"}'].map(
    (text) => api.parseModelsText(text),
  );
  check(
    "a providers section that is not an object is reported as such",
    providersNotObject.every(
      (result) => result.ok === false && result.problem === "providers-not-object",
    ),
    JSON.stringify(providersNotObject),
  );

  const file = {
    providers: {
      ollama: {
        name: "Ollama",
        baseUrl: "http://localhost:11434/v1",
        api: "openai-completions",
        apiKey: "ollama",
        models: [{ id: "qwen2.5-coder:7b", contextWindow: 32768 }],
      },
    },
  };
  const accepted = api.parseModelsText(JSON.stringify(file));
  check(
    "a readable file parses as it was, extra keys included",
    accepted.ok === true && JSON.stringify(accepted.json) === JSON.stringify(file),
    JSON.stringify(accepted),
  );

  /* --- the bytes that go back to disk ------------------------------------- */

  const text = api.modelsFileText(file);
  check(
    "the text round-trips through the parser unchanged",
    JSON.stringify(api.parseModelsText(text)) === JSON.stringify({ ok: true, json: file }),
    text,
  );
  check(
    "the text is pi's own shape: two-space indentation and a trailing newline",
    text.endsWith("}\n") && text.includes('\n  "providers"'),
    JSON.stringify(text.slice(0, 40)),
  );

  /* --- what a file declares ----------------------------------------------- */

  const listed = api.listConfiguredProviders({
    providers: {
      zeta: {
        name: "Zeta",
        baseUrl: "http://z/v1",
        api: "openai-completions",
        models: [{ id: "b" }, "a", { id: "b" }, { nope: 1 }, 7],
      },
      alpha: { apiKey: "$OPENAI_KEY", models: [{ id: "m" }] },
      broken: "not an object",
      middle: { name: 7, baseUrl: null, api: 5, apiKey: "  ", models: "nope" },
    },
  });
  check(
    "providers are listed by id, sorted",
    listed.map((entry) => entry.id).join(",") === "alpha,broken,middle,zeta",
    JSON.stringify(listed.map((entry) => entry.id)),
  );
  check(
    "model ids come from both of pi's shapes, in order and once each",
    listed[3].models.join(",") === "b,a" && listed[0].models.join(",") === "m",
    JSON.stringify([listed[3].models, listed[0].models]),
  );
  check(
    "an entry that is not an object is still listed, with nothing to show",
    listed[1].id === "broken" &&
      listed[1].name === undefined &&
      listed[1].models.length === 0 &&
      listed[1].hasKey === false,
    JSON.stringify(listed[1]),
  );
  check(
    "a field that is not a string is absent rather than coerced",
    listed[2].name === undefined &&
      listed[2].baseUrl === undefined &&
      listed[2].api === undefined &&
      listed[2].models.length === 0,
    JSON.stringify(listed[2]),
  );

  const keyed = api.listConfiguredProviders({
    providers: {
      literal: { apiKey: "sk-literal" },
      env: { apiKey: "$OPENAI_API_KEY" },
      braces: { apiKey: "${OPENAI_API_KEY}" },
      command: { apiKey: "!op read op://vault/key" },
      blank: { apiKey: "   " },
      empty: { apiKey: "" },
      numeric: { apiKey: 7 },
    },
  });
  const keyedById = Object.fromEntries(keyed.map((entry) => [entry.id, entry.hasKey]));
  check(
    "a key is recognised in all three of pi's forms",
    keyedById.literal && keyedById.env && keyedById.braces && keyedById.command,
    JSON.stringify(keyedById),
  );
  check(
    "a blank, empty or non-string key is no key",
    !keyedById.blank && !keyedById.empty && !keyedById.numeric,
    JSON.stringify(keyedById),
  );
  check(
    "a file with no usable providers section lists none",
    api.listConfiguredProviders({}).length === 0 &&
      api.listConfiguredProviders({ providers: [] }).length === 0 &&
      api.listConfiguredProviders({ providers: "x" }).length === 0,
    JSON.stringify([
      api.listConfiguredProviders({}).length,
      api.listConfiguredProviders({ providers: [] }).length,
    ]),
  );

  /* --- adding and replacing a provider ------------------------------------ */

  const before = {
    providers: {
      keep: {
        name: "Keep",
        baseUrl: "http://keep/v1",
        api: "openai-responses",
        apiKey: "sk-keep",
        headers: { "X-Keep": "1" },
        compat: { supportsDeveloperRole: false },
        models: [{ id: "m1", contextWindow: 1000 }],
      },
    },
    other: 1,
  };
  const snapshot = JSON.stringify(before);
  const added = api.upsertConfiguredProvider(before, {
    id: "ollama",
    baseUrl: "http://localhost:11434/v1",
    api: "openai-completions",
    apiKey: "$OLLAMA_KEY",
    modelIds: ["qwen2.5-coder:7b"],
  });
  check(
    "a new provider is written with what the form collected, and only that",
    JSON.stringify(added.providers.ollama) ===
      JSON.stringify({
        baseUrl: "http://localhost:11434/v1",
        api: "openai-completions",
        apiKey: "$OLLAMA_KEY",
        models: [{ id: "qwen2.5-coder:7b" }],
      }),
    JSON.stringify(added.providers.ollama),
  );
  check(
    "name is never invented for a provider that never had one",
    !("name" in added.providers.ollama),
    JSON.stringify(Object.keys(added.providers.ollama)),
  );
  check(
    "the argument is not mutated",
    JSON.stringify(before) === snapshot,
    snapshot,
  );
  check(
    "the other providers and the rest of the file are carried over untouched",
    JSON.stringify(added.providers.keep) === JSON.stringify(before.providers.keep) &&
      added.other === 1,
    JSON.stringify(Object.keys(added)),
  );

  const resaved = api.upsertConfiguredProvider(before, {
    id: "keep",
    baseUrl: "http://keep/v2",
    api: "openai-completions",
    apiKey: undefined,
    modelIds: ["m1", "m2"],
  });
  check(
    "a re-save sets the endpoint and the api to the form's own values",
    resaved.providers.keep.baseUrl === "http://keep/v2" &&
      resaved.providers.keep.api === "openai-completions",
    JSON.stringify(resaved.providers.keep),
  );
  check(
    "the entry's unknown keys survive a re-save",
    resaved.providers.keep.name === "Keep" &&
      resaved.providers.keep.headers["X-Keep"] === "1" &&
      resaved.providers.keep.compat.supportsDeveloperRole === false,
    JSON.stringify(resaved.providers.keep),
  );
  check(
    "a model that was already declared keeps its own keys, and a new one is bare",
    JSON.stringify(resaved.providers.keep.models) ===
      JSON.stringify([{ id: "m1", contextWindow: 1000 }, { id: "m2" }]),
    JSON.stringify(resaved.providers.keep.models),
  );
  check(
    "an untouched key field keeps the key the entry already had",
    resaved.providers.keep.apiKey === "sk-keep",
    String(resaved.providers.keep.apiKey),
  );

  const cleared = api.upsertConfiguredProvider(before, {
    id: "keep",
    baseUrl: "http://keep/v1",
    api: "openai-responses",
    apiKey: "",
    modelIds: ["m1"],
  });
  check(
    "the empty string removes the key",
    !("apiKey" in cleared.providers.keep),
    JSON.stringify(Object.keys(cleared.providers.keep)),
  );

  const replaced = api.upsertConfiguredProvider(before, {
    id: "keep",
    baseUrl: "http://keep/v1",
    api: "openai-responses",
    apiKey: "sk-new",
    modelIds: ["m1"],
  });
  check(
    "any other string sets the key",
    replaced.providers.keep.apiKey === "sk-new",
    String(replaced.providers.keep.apiKey),
  );

  const fromNothing = api.upsertConfiguredProvider({}, {
    id: "a",
    baseUrl: "http://a/v1",
    api: "openai-completions",
    apiKey: undefined,
    modelIds: [],
  });
  check(
    "a file with no providers section gains one",
    Object.keys(fromNothing.providers).join(",") === "a" &&
      fromNothing.providers.a.models.length === 0 &&
      !("apiKey" in fromNothing.providers.a),
    JSON.stringify(fromNothing),
  );

  const fromBareString = api.upsertConfiguredProvider(
    { providers: { s: { models: ["plain"] } } },
    { id: "s", baseUrl: "http://s/v1", api: "openai-completions", apiKey: undefined, modelIds: ["plain"] },
  );
  check(
    "a model declared as a bare string comes back in pi's object form",
    JSON.stringify(fromBareString.providers.s.models) === JSON.stringify([{ id: "plain" }]),
    JSON.stringify(fromBareString.providers.s.models),
  );

  /* --- removing a provider ------------------------------------------------- */

  const removed = api.removeConfiguredProvider(
    { providers: { a: { baseUrl: "http://a" }, b: { baseUrl: "http://b" } }, other: 1 },
    "b",
  );
  check(
    "removing a provider leaves the others and the rest of the file",
    Object.keys(removed.providers).join(",") === "a" &&
      JSON.stringify(removed.providers.a) === JSON.stringify({ baseUrl: "http://a" }) &&
      removed.other === 1,
    JSON.stringify(removed),
  );
  const emptied = api.removeConfiguredProvider(
    { providers: { a: { baseUrl: "http://a" } }, other: 2 },
    "a",
  );
  check(
    "the providers section stays an object when it ends up empty",
    typeof emptied.providers === "object" &&
      !Array.isArray(emptied.providers) &&
      Object.keys(emptied.providers).length === 0 &&
      emptied.other === 2,
    JSON.stringify(emptied),
  );
  const untouched = api.removeConfiguredProvider({ providers: { a: {} } }, "nope");
  check(
    "removing an id the file does not carry changes nothing",
    Object.keys(untouched.providers).join(",") === "a",
    JSON.stringify(untouched.providers),
  );

  /* --- the sentence the panel shows ---------------------------------------- */

  const profileName = "el perfil de tu pi";
  const none = api.describeConfiguredProviders([], profileName);
  const one = api.describeConfiguredProviders([provider("ollama")], profileName);
  const several = api.describeConfiguredProviders(
    ["a", "b", "c"].map(provider),
    profileName,
  );
  const many = api.describeConfiguredProviders(
    ["a", "b", "c", "d", "e", "f"].map(provider),
    profileName,
  );
  check(
    "no providers reads as none",
    none === "Ninguno todavía en el perfil de tu pi.",
    none,
  );
  check("one provider is named", one === "1 proveedor propio en el perfil de tu pi: ollama.", one);
  check(
    "two to four providers are all named",
    several === "3 proveedores propios en el perfil de tu pi: a, b, c.",
    several,
  );
  check(
    "past four, three are named and the rest counted",
    many === "6 proveedores propios en el perfil de tu pi: a, b, c y 3 más.",
    many,
  );
  check(
    "the sentence carries the profile in words and never a path",
    [none, one, several, many].every((line) => !line.includes("/") && !line.includes("\\")),
    many,
  );

  /* --- the values the form accepts ---------------------------------------- */

  check(
    "a provider id accepts what pi's own ids look like",
    ["ollama", "qwen2.5", "my-gateway", "a_b.c-d", "a", "x".repeat(64)].every((value) =>
      api.isProviderId(value),
    ),
    JSON.stringify(["ollama", "x".repeat(64)].map((value) => api.isProviderId(value))),
  );
  check(
    "a provider id refuses an empty, spaced, ill-started or oversized value",
    ["", "1 2", "-x", ".x", "my gateway", "x".repeat(65)].every(
      (value) => !api.isProviderId(value),
    ),
    JSON.stringify(["", "-x", "x".repeat(65)].map((value) => api.isProviderId(value))),
  );
  check(
    "a base URL accepts http and https",
    api.isBaseUrl("http://localhost:11434/v1") && api.isBaseUrl("https://api.example.test/v1"),
    JSON.stringify([api.isBaseUrl("http://localhost:11434/v1"), api.isBaseUrl("https://x/v1")]),
  );
  check(
    "a base URL refuses another scheme, a bare host and a value that is not a URL",
    !api.isBaseUrl("ftp://x/v1") &&
      !api.isBaseUrl("localhost:11434") &&
      !api.isBaseUrl("not a url") &&
      !api.isBaseUrl(""),
    JSON.stringify(["ftp://x/v1", "localhost:11434", "not a url"].map((value) => api.isBaseUrl(value))),
  );
  check(
    "an environment variable name accepts pi's $NAME form and refuses the rest",
    ["OPENAI_API_KEY", "_x", "A1"].every((value) => api.isEnvVarName(value)) &&
      ["1A", "A-B", "A B", "", "$X"].every((value) => !api.isEnvVarName(value)),
    JSON.stringify(["OPENAI_API_KEY", "1A", "A B"].map((value) => api.isEnvVarName(value))),
  );

  const ids = api.parseModelIds("a, b;c\nd ,,  a");
  check(
    "the field splits on commas, semicolons and newlines, trims, and drops repeats",
    ids.ids.join(",") === "a,b,c,d",
    JSON.stringify(ids),
  );
  const odd = api.parseModelIds("good, gpt 4, good");
  check(
    "an entry that still holds whitespace is rejected, not guessed at",
    odd.ids.join(",") === "good" && odd.rejected.join(",") === "gpt 4",
    JSON.stringify(odd),
  );
  check(
    "an id is never rewritten, colons and dots included",
    api.parseModelIds("qwen2.5-coder:7b").ids[0] === "qwen2.5-coder:7b" &&
      api.parseModelIds("a\nb").ids.join(",") === "a,b",
    JSON.stringify(api.parseModelIds("qwen2.5-coder:7b").ids),
  );
  check(
    "an empty field yields nothing at all",
    api.parseModelIds("  , ; \n ").ids.length === 0 &&
      api.parseModelIds("  , ; \n ").rejected.length === 0 &&
      api.parseModelIds("").ids.length === 0,
    JSON.stringify(api.parseModelIds("  , ; \n ")),
  );

  check(
    "the api ids are pi's eight, in the order the picker offers them",
    api.PROVIDER_APIS.map((option) => option.value).join(",") ===
      [
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
        "google-generative-ai",
        "google-vertex",
        "mistral-conversations",
        "azure-openai-responses",
        "bedrock-converse-stream",
      ].join(","),
    JSON.stringify(api.PROVIDER_APIS.map((option) => option.value)),
  );
  check(
    "the most compatible api is first and says so, and every option has a label",
    api.PROVIDER_APIS[0].label.includes("el más compatible") &&
      api.PROVIDER_APIS.every((option) => option.label.trim() !== "" && option.value !== option.label),
    JSON.stringify(api.PROVIDER_APIS[0]),
  );

  /* --- the file ------------------------------------------------------------ */

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picode-models-"));
  cleanup(dir);
  const target = path.join(dir, "nested", "models.json");

  const missing = api.readModelsFile(target);
  check("a file that is not there reads as missing", missing.kind === "missing", JSON.stringify(missing));

  const asDirectory = path.join(dir, "a-directory");
  fs.mkdirSync(asDirectory, { recursive: true });
  const unreadable = api.readModelsFile(asDirectory);
  check(
    "a target that cannot be read as a file reports why instead of throwing",
    unreadable.kind === "unreadable" &&
      typeof unreadable.reason === "string" &&
      unreadable.reason.trim() !== "",
    JSON.stringify(unreadable),
  );

  api.writeModelsFile(target, file);
  const readBack = api.readModelsFile(target);
  const parsedBack = api.parseModelsText(readBack.kind === "text" ? readBack.text : undefined);
  check(
    "a write creates the directory it needs, and reads back as the same file",
    readBack.kind === "text" &&
      parsedBack.ok === true &&
      JSON.stringify(parsedBack.json) === JSON.stringify(file),
    JSON.stringify(parsedBack),
  );
  check(
    "the write leaves no temp file beside the target",
    fs.readdirSync(path.dirname(target)).join(",") === "models.json",
    fs.readdirSync(path.dirname(target)).join(","),
  );

  const second = {
    providers: { only: { baseUrl: "http://only/v1", api: "openai-completions", models: [{ id: "m" }] } },
  };
  api.writeModelsFile(target, second);
  const parsedSecond = api.parseModelsText(fs.readFileSync(target, "utf8"));
  check(
    "a second write replaces the first instead of merging into it",
    parsedSecond.ok === true &&
      parsedSecond.json.providers.only !== undefined &&
      parsedSecond.json.providers.ollama === undefined,
    JSON.stringify(parsedSecond),
  );
  check(
    "the replacement still leaves exactly one file behind",
    fs.readdirSync(path.dirname(target)).join(",") === "models.json",
    fs.readdirSync(path.dirname(target)).join(","),
  );

  // A target that cannot be replaced: the rename fails after the temp file exists, and
  // the temp file must not be left for the next reader to find.
  const blocked = path.join(dir, "blocked.json");
  fs.mkdirSync(path.join(blocked, "keep"), { recursive: true });
  let threw = false;
  try {
    api.writeModelsFile(blocked, second);
  } catch {
    threw = true;
  }
  check(
    "a write that cannot replace its target throws and takes its temp file with it",
    threw && fs.readdirSync(dir).every((name) => !name.includes(".tmp")),
    `${threw} / ${fs.readdirSync(dir).join(",")}`,
  );

  const modeDir = fs.mkdtempSync(path.join(os.tmpdir(), "picode-models-mode-"));
  cleanup(modeDir);
  const literalFile = path.join(modeDir, "literal.json");
  const envFile = path.join(modeDir, "env.json");
  const reference = path.join(modeDir, "reference.json");
  const keyedEntry = (apiKey) => ({
    providers: { a: { baseUrl: "http://a/v1", api: "openai-completions", apiKey, models: [] } },
  });
  api.writeModelsFile(literalFile, keyedEntry("sk-literal"));
  api.writeModelsFile(envFile, keyedEntry("$A_KEY"));
  fs.writeFileSync(reference, "x");
  if (process.platform === "win32") {
    check(
      "Windows: both writes land, and no mode is claimed about a platform that has none",
      fs.existsSync(literalFile) && fs.existsSync(envFile),
      `${fs.existsSync(literalFile)} / ${fs.existsSync(envFile)}`,
    );
  } else {
    const mode = (name) => fs.statSync(name).mode & 0o777;
    check(
      "a literal key narrows the file to its owner",
      mode(literalFile) === 0o600,
      mode(literalFile).toString(8),
    );
    check(
      "an interpolated key leaves the file at the mode every file gets",
      mode(envFile) === mode(reference),
      `${mode(envFile).toString(8)} vs ${mode(reference).toString(8)}`,
    );
  }

  /* --- the two guards at the source --------------------------------------- */

  const source = fs.readFileSync(path.join(SOURCE_ROOT, "models-config.ts"), "utf8");
  check(
    "the module imports no editor module",
    !/from\s+["']vscode["']/.test(source) && !/require\(\s*["']vscode["']\s*\)/.test(source),
    "an editor import was found in the module",
  );
  check(
    "the module never mentions the credential file",
    !source.includes("auth.json"),
    "the credential file is named in the module",
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, "package.json"), "utf8"));
  check(
    "the suite is registered in the test chain, right after the login suite",
    String(manifest.scripts.test).includes(
      "node test/pi-login-command.test.js && node test/models-config.test.js",
    ),
    manifest.scripts.test,
  );

  /* --- what the owner reads, verbatim -------------------------------------- */

  console.log("--- el resumen que ve el dueño ---");
  for (const line of [none, one, several, many]) {
    console.log(line);
  }
  console.log("--- un proveedor, tal cual ---");
  console.log(JSON.stringify(listed[3], null, 2));
  console.log("---");

  for (const temporary of cleanups) {
    fs.rmSync(temporary, { recursive: true, force: true });
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
