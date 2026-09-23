/*
 * The read, merge and write layer for one profile's `models.json`.
 *
 * pi loads this file but never writes it: its `ModelConfig` has a loader and no
 * writer, and pi's own documentation tells the owner to add an entry by hand. So
 * declaring a compatible endpoint — Ollama, LM Studio, vLLM, a gateway — means
 * editing that JSON, and this module is the only place in PiCode that does.
 *
 * Three rules shape everything below:
 *
 * - pi owns the schema and this module does not re-implement it. A provider without
 *   `baseUrl` or without an `api` throws inside pi, the accepted `api` ids are pi's,
 *   and any key this form does not own is still a valid part of the entry. So parsing
 *   asks only for the fields the form collects and the merge preserves everything
 *   else — `name`, `headers`, `compat`, `modelOverrides`, a model's own keys — as it
 *   was, including a model's extra keys across a re-save. Guessing at the rest of
 *   pi's shape here is how a hand-written endpoint would be destroyed by saving it.
 *   The two shapes that make pi **discard the whole file** — an entry that is not an
 *   object, and models that are not `{ id }` objects — are the exception: they are
 *   refused rather than tolerated, because listing providers pi is ignoring and then
 *   promising a reload that reads nothing is worse than saying the file cannot be used.
 * - What counts as JSON is pi's own reading, not the strictest one. pi parses this file
 *   as `JSON.parse(stripJsonComments(stripBom(content)))`, so `//` comments, a trailing
 *   comma and a BOM are all fine — and a file that arrives with comments goes back
 *   normalized, because the write serializes the parsed object. The tolerances are
 *   mirrored, and that normalization is reported to the owner instead of discovered.
 * - Nothing here opens the file pi's own login writes. A key that lives in
 *   `models.json` is an `apiKey` in one of pi's three forms — a literal, `$NAME` /
 *   `${NAME}` interpolation, or a leading `!command` — and that is the only key this
 *   module ever looks at. Credentials are the login command's business.
 * - A write never leaves a half-written file behind, because the reader is pi itself
 *   reloading on `/model`: the text goes to a sibling temp file and is renamed over
 *   the target, so a reader sees the old file or the new one and never a fragment.
 *
 * The module deliberately imports no editor module: kept as the pure half plus
 * `node:fs`, the parsing, the merge and the sentences can be exercised in plain Node
 * without an editor, and so can the flow built on top of it later.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

/**
 * A `models.json` as it was read.
 *
 * The values stay `unknown` on purpose: pi's schema is pi's, this module describes
 * only the handful of keys it owns, and narrowing the rest would mean refusing a file
 * pi accepts.
 */
export type ModelsJson = { [key: string]: unknown };

/** One provider a `models.json` declares, reduced to what a surface shows. */
export interface ConfiguredProvider {
  id: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  /** Its model ids, in file order. */
  models: readonly string[];
  /** True when the entry carries a non-empty `apiKey` in any of pi's three forms. */
  hasKey: boolean;
}

/** Why a file could not be read as a `models.json` pi would accept. */
export type ModelsFileProblem =
  | "not-json"
  | "not-object"
  | "providers-not-object"
  | "provider-not-object"
  | "models-not-objects";

export type ModelsFileParse =
  | {
      ok: true;
      json: ModelsJson;
      /**
       * True when the bytes were not strict JSON and pi's own tolerances were what made
       * them readable — `//` comments, a trailing comma, a BOM. The owner is told, because
       * the write that follows serializes the parsed object and drops them.
       */
      tolerated: boolean;
    }
  | { ok: false; problem: ModelsFileProblem };

export type ModelsFileRead =
  | { kind: "missing" }
  | { kind: "text"; text: string }
  | { kind: "unreadable"; reason: string };

/** What the form collects for one provider. */
export interface NewProviderInput {
  id: string;
  baseUrl: string;
  api: string;
  /** `undefined` keeps whatever key the entry already had; `""` removes it; anything else sets it. */
  apiKey: string | undefined;
  modelIds: readonly string[];
}

export interface ProviderApiOption {
  /** pi's own `api` id. */
  value: string;
  /** What the owner reads in the picker. */
  label: string;
}

/* ------------------------------------------------------------------ *
 * The parsed halves
 * ------------------------------------------------------------------ */

/**
 * A JSON object, told apart from an array and from `null`.
 *
 * Every shape question in this module goes through here, so "a plain object" cannot
 * mean one thing in the parser and another in the merge.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `providers` object of a file, or an empty one.
 *
 * A missing or malformed `providers` section is an empty one rather than a thrown
 * error: the merge has to survive a file a stranger wrote, and every caller below
 * treats "no providers" and "no usable providers" the same way.
 */
function providerRecords(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** The string a field holds, or `undefined` when it holds anything else. */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The id one declared model carries, or `undefined` when it carries none. */
function declaredModelId(entry: Record<string, unknown>): string | undefined {
  return optionalString(entry.id);
}

/**
 * The model ids an entry declares, in file order, each kept once.
 *
 * Only `{ id }` objects ever reach this: the parser refuses a file whose models are not
 * objects at all, because pi's own schema does (`ModelDefinitionSchema` requires `id`),
 * and one such entry makes pi discard every provider in the file. The id is never
 * rewritten — `qwen2.5-coder:7b` is a name, not a pattern — and a repeated id yields one
 * row, because the surface lists what the entry declares and not how often.
 */
function modelIds(value: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(value)) {
    return ids;
  }
  for (const entry of value) {
    const id = isRecord(entry) ? declaredModelId(entry) : undefined;
    if (id === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * The two shapes that make pi throw the whole file away, or `undefined`.
 *
 * pi validates the file against its own schema **before** it reads a single provider
 * (`ModelConfigSchema` / `ProviderConfigSchema` / `ModelDefinitionSchema` in
 * `dist/core/model-config.js`), so one provider that is not an object, or one `models`
 * that is not a list of `{ id }` objects, discards every entry. Reading such a file
 * anyway would let this surface list providers pi is ignoring and promise a reload that
 * reads nothing, so it is refused like any other file PiCode cannot use.
 *
 * Nothing beyond these two shapes is checked: pi's schema is pi's, and a copy of it here
 * is exactly what this module refuses to keep. A file pi rejects for some other reason is
 * listed as it stands, which is the honest reading of a file this module does not own.
 */
function shapeProblem(json: ModelsJson): ModelsFileProblem | undefined {
  const declared = providerRecords(json.providers);
  for (const entry of Object.values(declared)) {
    if (!isRecord(entry)) {
      return "provider-not-object";
    }
    const models = entry.models;
    if (models === undefined) {
      continue;
    }
    if (!Array.isArray(models) || models.some((model) => !isRecord(model))) {
      return "models-not-objects";
    }
  }
  return undefined;
}

/**
 * The text pi itself would parse, and whether pi's tolerances were what made it readable.
 *
 * The two replacements are pi's own, copied from `stripJsonComments` in
 * `dist/utils/json.js` and applied on top of pi's `stripBom` at
 * `dist/core/model-config.js:253`: `//` line comments and trailing commas go, string
 * literals are left alone. Mirroring them exactly — instead of inventing a relaxed JSON
 * of this module's own — is what keeps a file pi reads from being called invalid here;
 * block comments and single quotes stay invalid, because pi does not accept them either.
 */
function toleratedText(text: string): { text: string; tolerated: boolean } {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const stripped = withoutBom
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) =>
      tail ?? (match[0] === '"' ? match : ""),
    );
  return { text: stripped, tolerated: stripped !== withoutBom };
}

/**
 * Parses the bytes of a `models.json`, keeping pi's own shape and reporting only
 * what makes the file unreadable.
 *
 * An absent file, an empty one and a whitespace-only one are the same thing: a file
 * pi would read as "no custom providers", which is what a first write starts from.
 * Everything after that is the ways a file cannot be merged into — it is not JSON even
 * with pi's own tolerances, it is JSON but not an object, its `providers` section is not
 * an object, one of its providers is not an object, or a provider's models are not
 * `{ id }` objects. The distinction is kept because each one needs a different sentence in
 * front of the owner, and because a write over an unreadable file would silently drop
 * whatever it held. The parsed object is returned as it was, `providers` included, so the
 * merge can preserve the keys of a file this module does not fully understand.
 */
export function parseModelsText(text: string | undefined): ModelsFileParse {
  if (text === undefined || text.trim() === "") {
    return { ok: true, json: {}, tolerated: false };
  }
  const tolerant = toleratedText(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(tolerant.text);
  } catch {
    return { ok: false, problem: "not-json" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, problem: "not-object" };
  }
  if (parsed.providers !== undefined && !isRecord(parsed.providers)) {
    return { ok: false, problem: "providers-not-object" };
  }
  const shape = shapeProblem(parsed);
  if (shape !== undefined) {
    return { ok: false, problem: shape };
  }
  return { ok: true, json: parsed, tolerated: tolerant.tolerated };
}

/** The bytes pi's own stores write: two-space indentation and a final newline. */
export function modelsFileText(json: ModelsJson): string {
  return `${JSON.stringify(json, null, 2)}\n`;
}

/**
 * Every provider the file declares, one entry each, ordered by id.
 *
 * The order is the surface's, not the file's: the list is read by an owner looking
 * for one endpoint, and insertion order in a hand-edited file means nothing to him.
 * An entry that is not an object still appears — the id is the key, so there is
 * something to show and something to remove — with no name and no models rather than
 * being hidden from the only surface that could fix it.
 */
export function listConfiguredProviders(json: ModelsJson): readonly ConfiguredProvider[] {
  const declared = providerRecords(json.providers);
  const providers: ConfiguredProvider[] = [];
  for (const [id, entry] of Object.entries(declared)) {
    const record = isRecord(entry) ? entry : {};
    const apiKey = record.apiKey;
    providers.push({
      id,
      name: optionalString(record.name),
      baseUrl: optionalString(record.baseUrl),
      api: optionalString(record.api),
      models: modelIds(record.models),
      // `trim()` because a key of spaces is not a key: pi would send it as one, and
      // the surface would claim a credential the entry does not carry.
      hasKey: typeof apiKey === "string" && apiKey.trim() !== "",
    });
  }
  return providers.sort((left, right) => left.id.localeCompare(right.id));
}

/* ------------------------------------------------------------------ *
 * The merge
 * ------------------------------------------------------------------ */

/**
 * The model entry an id already declared, so a re-save does not erase what it carried.
 *
 * `contextWindow`, `maxTokens` and the rest of a model's own fields are pi's, not this
 * form's, and a hand-tuned one must survive the provider being saved again. A bare
 * string carries the id and nothing else, so it is not reused: `{ id }` says the same
 * thing in pi's own object form.
 */
function reusableModel(declared: unknown, id: string): Record<string, unknown> {
  if (Array.isArray(declared)) {
    for (const entry of declared) {
      if (isRecord(entry) && entry.id === id) {
        return entry;
      }
    }
  }
  return { id };
}

/**
 * The file with one provider added or replaced, without touching the argument.
 *
 * The entry starts from the raw object the file already had, so every key this module
 * does not own — `name`, `headers`, `compat`, `modelOverrides`, anything a future pi
 * adds — survives a re-save, and `name` is never invented for a provider that never
 * had one: pi shows the id when there is no name, and a made-up one would be PiCode's
 * word rather than pi's. Only what the form collects is written: `baseUrl`, `api`, the
 * models, and the key when the owner touched it.
 */
export function upsertConfiguredProvider(json: ModelsJson, input: NewProviderInput): ModelsJson {
  const declared = providerRecords(json.providers);
  const existing = declared[input.id];
  const entry: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};

  entry.baseUrl = input.baseUrl;
  entry.api = input.api;

  // `undefined` means the form did not touch the key, `""` means removal, and any
  // other string is the new value. Leaving the untouched case out of the write is what
  // lets a working credential survive a re-save, and removal has to be explicit
  // because pi reads a missing key and a written-out value differently.
  if (input.apiKey === "") {
    delete entry.apiKey;
  } else if (input.apiKey !== undefined) {
    entry.apiKey = input.apiKey;
  }

  // Read from the raw value before the assignment, because the reused objects come
  // from what the entry already declared.
  const previousModels = entry.models;
  entry.models = input.modelIds.map((id) => reusableModel(previousModels, id));

  return { ...json, providers: { ...declared, [input.id]: entry } };
}

/**
 * The file without one provider, everything else left alone.
 *
 * `providers` stays an object even when it ends up empty, because that is what pi
 * reads as "no custom providers" and an absent section is not the same file. Removing
 * an id the file does not carry is not an error: the surface offers the ids it listed,
 * and between the listing and the click another tool may have removed one.
 */
export function removeConfiguredProvider(json: ModelsJson, id: string): ModelsJson {
  const declared = { ...providerRecords(json.providers) };
  delete declared[id];
  return { ...json, providers: declared };
}

/* ------------------------------------------------------------------ *
 * The sentence the panel shows
 * ------------------------------------------------------------------ */

/**
 * What the selected profile's `models.json` holds, in one line.
 *
 * `profileName` is the profile in words — "el perfil propio de PiCode" or "el perfil
 * de tu pi" — never a path: the owner chose an instance, and which one is a fact he
 * can read. Past the fourth provider the ids stop being the answer and only the count
 * is, so the line names three and counts the rest instead of growing without bound.
 */
export function describeConfiguredProviders(
  providers: readonly ConfiguredProvider[],
  profileName: string,
): string {
  if (providers.length === 0) {
    return `Ninguno todavía en ${profileName}.`;
  }
  if (providers.length === 1) {
    return `1 proveedor propio en ${profileName}: ${providers[0].id}.`;
  }
  const count = `${providers.length} proveedores propios en ${profileName}`;
  if (providers.length <= 4) {
    return `${count}: ${providers.map((provider) => provider.id).join(", ")}.`;
  }
  const shown = providers
    .slice(0, 3)
    .map((provider) => provider.id)
    .join(", ");
  return `${count}: ${shown} y ${providers.length - 3} más.`;
}

/* ------------------------------------------------------------------ *
 * The values the form accepts
 * ------------------------------------------------------------------ */

/**
 * Whether a string can be a provider id.
 *
 * An id is a key in `models.json` and the provider half of every model reference
 * (`provider/model`), so the shape is deliberately narrow — the same characters a
 * package name and a slug use — and the length is capped because pi writes it into
 * paths and log lines.
 */
export function isProviderId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(value) && value.length <= 64;
}

/**
 * Whether a string is an endpoint pi can call.
 *
 * `new URL` decides, and the protocol is the only thing added on top: a relative path
 * or a bare host would parse as a URL of some other kind, and pi would fail on it at
 * the first call rather than at the form. Nothing is repaired here — a missing scheme
 * is the owner's typo, and silently prefixing `https://` would guess at which one.
 */
export function isBaseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/** Whether a string can name an environment variable, as `$NAME` interpolation needs. */
export function isEnvVarName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/**
 * The model ids one text field collected, and the entries that could not be ids.
 *
 * The field is a single input because the owner pastes a list there, so all three
 * separators people use are accepted. An id is never rewritten — no trimming beyond
 * the separator, no case folding, no splitting on the space inside
 * `qwen2.5-coder:7b`-style names — because a changed id is a model that does not
 * exist. An entry that still holds whitespace after trimming is reported instead of
 * guessed at: `gpt 4` is as likely to be one wrong id as two right ones, and a wrong
 * id in the file costs an hour at the first call.
 */
export function parseModelIds(text: string): { ids: string[]; rejected: string[] } {
  const ids: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[,;\r\n]+/)) {
    const entry = raw.trim();
    // A repeated entry says nothing new, whether it was an id or a mistake, so it is
    // read once and does not appear twice in either list.
    if (entry === "" || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    if (/\s/.test(entry)) {
      rejected.push(entry);
    } else {
      ids.push(entry);
    }
  }
  return { ids, rejected };
}

/**
 * The `api` ids this picker offers, in the order it offers them.
 *
 * A declared list, not a reading: pi publishes no catalogue of `api` ids to a client
 * that has not built its model runtime, so the list is pi's own — taken from the ids
 * its published API implementations register — and a **subset** of them. The ids left
 * out are the ones no hand-declared endpoint can be: the Codex and `pi-messages`
 * protocols, the image one, and `unknown`. An id outside pi's registry is refused by
 * pi's own `applyModelsJson` with a thrown error, so offering one in a picker would be
 * offering a failure. The first entry is first because it is what a local endpoint
 * (Ollama, LM Studio, vLLM) answers.
 */
export const PROVIDER_APIS: readonly ProviderApiOption[] = [
  { value: "openai-completions", label: "OpenAI (chat completions): el más compatible" },
  { value: "openai-responses", label: "OpenAI (responses)" },
  { value: "anthropic-messages", label: "Anthropic (messages)" },
  { value: "google-generative-ai", label: "Google (generative AI)" },
  { value: "google-vertex", label: "Google Vertex" },
  { value: "mistral-conversations", label: "Mistral" },
  { value: "azure-openai-responses", label: "Azure OpenAI (responses)" },
  { value: "bedrock-converse-stream", label: "Amazon Bedrock (converse)" },
];

/* ------------------------------------------------------------------ *
 * The file
 * ------------------------------------------------------------------ */

/**
 * A `models.json` read as bytes, told apart from one that is not there.
 *
 * "Missing" and "unreadable" are different answers because they lead to different
 * writes: a missing file is a first entry, while an unreadable one — a directory, a
 * locked file, a permission — must be refused rather than replaced, or the write
 * would drop whatever it held. The reason is carried for the log rather than the
 * owner, so it stays as the error string itself.
 */
export function readModelsFile(file: string): ModelsFileRead {
  if (!existsSync(file)) {
    return { kind: "missing" };
  }
  try {
    return { kind: "text", text: readFileSync(file, "utf8") };
  } catch (error) {
    return { kind: "unreadable", reason: String(error) };
  }
}

/** How many times this process has replaced a file, so two writes cannot share a temp name. */
let tempCounter = 0;

/**
 * Whether any provider carries a literal key, which is a secret sitting in the file.
 *
 * The three forms are not equally sensitive: an interpolated `$NAME` and a
 * `!command` keep the secret outside the file, while a literal is the key itself.
 * Only the literal justifies narrowing the file's permissions.
 */
function hasLiteralKey(json: ModelsJson): boolean {
  const declared = providerRecords(json.providers);
  for (const entry of Object.values(declared)) {
    if (!isRecord(entry)) {
      continue;
    }
    const key = entry.apiKey;
    if (typeof key === "string" && key.trim() !== "" && !key.startsWith("$") && !key.startsWith("!")) {
      return true;
    }
  }
  return false;
}

/**
 * Replaces a `models.json` with the given object, atomically.
 *
 * The temp file's name is derived from the target plus this process's pid and a module
 * counter — no timestamps and no randomness — so two PiCode windows writing the same
 * profile cannot collide on it, and a leftover from a crash is recognisable as a
 * sibling of the file it was about to become. The rename is what makes the write
 * atomic: pi reloads the file when the owner opens `/model`, and it must never read a
 * fragment of it. A failed write takes its temp file with it rather than leaving one
 * behind for the next reader to find.
 *
 * When the object carries a literal key, the temp file is **created** at the owner's own
 * mode rather than narrowed after the rename. Where a mode means something, the window
 * between the two left the secret readable, and a crash before the rename left a readable
 * temp behind for good; pi's own credential writer creates its file the same way
 * (`dist/core/auth-storage.js`). Where a mode means nothing the option is ignored, which is
 * the platform's business and never a failure.
 */
export function writeModelsFile(file: string, json: ModelsJson): void {
  const text = modelsFileText(json);
  mkdirSync(path.dirname(file), { recursive: true });

  tempCounter += 1;
  const temp = `${file}.${process.pid}.${tempCounter}.tmp`;
  const secret = hasLiteralKey(json);
  const encoding: "utf8" | { encoding: "utf8"; mode: number } = secret
    ? { encoding: "utf8", mode: 0o600 }
    : "utf8";
  try {
    writeFileSync(temp, text, encoding);
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may never have been created; the write's own failure is the one
      // worth reporting, and it is rethrown below.
    }
    throw error;
  }
}
