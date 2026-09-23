/*
 * T3 of the models-and-providers feature: the command that connects a provider pi does
 * not ship, and the reading behind the settings row that offers it.
 *
 * pi stores two different things in two different files. A credential lives in
 * `auth.json` and is written by pi's own login (`pi-login-command.ts`). A compatible
 * endpoint and its model ids live in `models.json`, a file pi **loads but never
 * writes** — its `ModelConfig` has a `load` and no writer — so the documented way in is
 * the file itself, and `models-config.ts` is the module that reads, merges and replaces
 * it. This module is the only thing that joins that file to the owner: it resolves the
 * profile of the selected instance, reads its `models.json`, and drives add and remove
 * over it without a terminal.
 *
 * The profile is the one the provider login writes to, and it is resolved the same way:
 * `instanceProfileDir(uri, mode)`, the *unguarded writer's* answer. For `managed` that is
 * PiCode's own profile — named even while it is still empty, which is exactly the state
 * this feature exists to fill — and for `path`/`custom` it is the profile the owner's
 * installed pi reads. The *guarded* readers' answer is deliberately never consulted, and
 * the module does not name that resolver at all, so the raw scan a suite runs over this
 * source cannot be fooled by a comment: on an empty internal profile the guarded answer
 * names the machine's profile, and this surface would then show a stranger's providers
 * while claiming they belong to the instance the owner selected. Which profile it is is
 * said in words (`profileNameFor`) and never by path.
 *
 * A `models.json` PiCode cannot read as JSON is refused and never overwritten: a file
 * that does not parse is a file someone else wrote, and a write over it would drop
 * whatever it held. That refusal is the flow's first step, before any picker.
 *
 * Every sentence the owner reads lives in the exported tables and builders below
 * (`MODELS_TEXTS`, `providerRow`, `addedText`, `removedText`, `refusedText`), so a test
 * asserts the wording instead of restating it, and so the two cannot drift apart. The
 * decisions that can be taken without an editor — the target profile, the summary, the
 * picker's rows, and the shape each field of the form accepts — are pure functions for
 * the same reason.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { instanceAgentDir, instanceProfileDir, profileNameFor } from "./instance";
import { RELOAD_WINDOW_LABEL } from "./instance-import-command";
import {
  PROVIDER_APIS,
  describeConfiguredProviders,
  isBaseUrl,
  isEnvVarName,
  isProviderId,
  listConfiguredProviders,
  parseModelIds,
  parseModelsText,
  readModelsFile,
  removeConfiguredProvider,
  upsertConfiguredProvider,
  writeModelsFile,
  type ConfiguredProvider,
  type ModelsFileProblem,
  type ModelsJson,
  type NewProviderInput,
} from "./models-config";
import { readMode } from "./runtime";

/** The command the palette runs and the panel's row points at. Registered once. */
export const MODELS_PROVIDERS_COMMAND = "picode.piChat.modelsProviders";

/** The file a declaration lives in, inside a profile. */
export const MODELS_FILE_NAME = "models.json";

/* ------------------------------------------------------------------ *
 * The owner-facing wording
 * ------------------------------------------------------------------ */

/**
 * Every sentence that needs no prompt to be written, in one table.
 *
 * Together for the same reason the login's table is: a test asserts the exact words the
 * product builds rather than a second copy of them, so the surface and its test cannot
 * describe the same flow differently. The validators below return these strings, which
 * is why they are strings and not a function each: the editor shows a validator's return
 * value as the field's error, and the owner reads the same sentence either way.
 */
export const MODELS_TEXTS = {
  pickTitle: "Proveedores y modelos propios",
  addLabel: "Añadir un proveedor",
  addDescription: "Escribe un endpoint y sus modelos en el models.json de la instancia elegida.",
  removeLabel: "Quitar un proveedor",
  removeDescription: "Borra un proveedor del models.json. Lo demás del fichero no se toca.",
  removeTitle: "Quitar un proveedor",
  removePlaceHolder: "Elige el proveedor que quieres quitar.",
  apiPickTitle: "Cómo habla con ese endpoint",
  apiPlaceHolder: "Es el protocolo que responde en la dirección que escribiste.",
  idPrompt: "Identificador del proveedor",
  idPlaceHolder: "ollama",
  idRequired: "Hace falta un identificador: es la clave del proveedor en models.json.",
  idInvalid:
    "Un identificador empieza por letra o número y solo lleva letras, números, punto, " +
    "guion y guion bajo, hasta 64 caracteres.",
  baseUrlPrompt: "Dirección del endpoint",
  baseUrlPlaceHolder: "http://localhost:11434/v1",
  baseUrlRequired: "Hace falta la dirección: pi rechaza un proveedor sin ella.",
  baseUrlInvalid: "La dirección tiene que empezar por http:// o https://.",
  keyPrompt: "Clave del endpoint (opcional)",
  keyPlaceHolder:
    "Vacío deja la que hubiera. $VARIABLE lee una variable de entorno; !comando ejecuta un comando.",
  keyEnvInvalid: "Una variable de entorno se escribe $NOMBRE, con letras, números y guion bajo.",
  keyCommandInvalid: "Un comando se escribe después de «!».",
  modelsPrompt: "Modelos que ofrece, separados por comas",
  modelsPlaceHolder: "qwen2.5-coder:7b, llama3.1:8b",
  modelsRequired: "pi no lee un proveedor sin modelos: escribe al menos uno.",
  removeConfirm: (id: string, profileName: string) =>
    `Se va a quitar el proveedor «${id}» del ${MODELS_FILE_NAME} de ${profileName}. ` +
    "Lo que pi trae de serie no cambia.",
  removeContinue: "Quitar",
  // The one confirmation the flow still owes, and the same rule the login follows: the
  // owner's profile is also the one his installed pi reads and every other pi tool on
  // the machine writes, so writing there is a decision he takes, not an effect he gets.
  // Two sentences for one decision because the button below is one: saving and removing
  // are not the same act, and a single neutral wording would name neither.
  ownerAddConfirm: (id: string) =>
    `Se va a guardar el proveedor «${id}» en el perfil de tu pi, el mismo que usa tu pi ` +
    "instalado en el equipo: el cambio también lo verá cualquier otra herramienta de pi de " +
    "la máquina.",
  ownerRemoveConfirm: (id: string) =>
    `Se va a quitar el proveedor «${id}» del perfil de tu pi, el mismo que usa tu pi ` +
    "instalado en el equipo: el cambio también lo verá cualquier otra herramienta de pi de " +
    "la máquina.",
  ownerContinue: "Escribir en el perfil de mi pi",
  ownerDeclined: "No se cambió nada: no se escribió en el perfil de tu pi.",
  cancelled: "No se cambió nada: cerraste la elección.",
} as const;

/**
 * Why the file cannot be used, in the owner's words.
 *
 * The four cases are the module's own problem codes plus the one I/O failure
 * `readModelsFile` reports, because they lead to the same ending and the owner does not
 * need to know which layer noticed.
 */
export const FILE_PROBLEM_TEXTS: Record<ModelsFileProblem | "unreadable", string> = {
  "not-json": "no es JSON válido",
  "not-object": "no es un objeto JSON",
  "providers-not-object": "su apartado `providers` no es un objeto",
  unreadable: "no se pudo leer",
};

/** What the picker says about a provider whose entry declares no model. */
export const PROVIDER_ROW_MARKERS = {
  noModels: "sin modelos declarados",
  hasKey: "con clave",
  noKey: "sin clave",
} as const;

/* ------------------------------------------------------------------ *
 * What the selected instance's `models.json` holds
 * ------------------------------------------------------------------ */

/**
 * The state of the file, read once per surface that needs it.
 *
 * `summary` is the single line the settings row shows, and the flow's picker uses it as
 * its placeholder, so the owner reads the same sentence in both places. `json` is kept
 * because a write must start from what pi reads — the merge in `models-config.ts`
 * preserves every key this module does not own — and it is `undefined` exactly when
 * `problem` is set, because a file PiCode cannot parse is never written over. A file that
 * is not there yet is `{}` rather than `undefined`: that is what pi reads, and it is the
 * shape the first write starts from.
 */
export interface ModelsProvidersState {
  /** Where the file lives. Never shown: the owner chose an instance, not a path. */
  profileDir: string;
  /** That profile in words, from `profileNameFor`. Never a path. */
  profileName: string;
  /** True when the profile is PiCode's own rather than the owner's installed pi. */
  owned: boolean;
  /** What the file declares. The order is the surface's — by id, like the pickers — not the file's. */
  providers: readonly ConfiguredProvider[];
  /** The line the settings row and the picker show. */
  summary: string;
  /** The parsed file, when there is a readable one to merge into. */
  json: ModelsJson | undefined;
  /** Why the file cannot be used, when it cannot. */
  problem: ModelsFileProblem | "unreadable" | undefined;
}

/**
 * The refusal as one line, for the settings row.
 *
 * A row that said "none yet" over a file that does not parse would be the one thing this
 * surface must not say — the owner would go looking for a declaration that is there — so
 * the row says the file cannot be used and the command says why in full.
 */
export function refusedSummary(profileName: string): string {
  return (
    `El ${MODELS_FILE_NAME} de ${profileName} no se puede usar tal cual; ` +
    "el comando explica por qué."
  );
}

/** The refusal in full: which file, which of the four problems, and why nothing is written. */
export function refusedText(
  profileName: string,
  problem: ModelsFileProblem | "unreadable",
): string {
  return (
    `El ${MODELS_FILE_NAME} de ${profileName} no se puede usar: ${FILE_PROBLEM_TEXTS[problem]}. ` +
    "No se muestra lo que declara ni se escribe encima, porque un fichero que PiCode no sabe " +
    "leer es un fichero que escribió otro."
  );
}

/**
 * Reads the selected instance's `models.json` into the shape every surface above needs.
 *
 * The two decisions this makes are the ones the feature turns on, and both are the
 * login's: the target is `instanceProfileDir(uri, mode)` — PiCode's own profile for its
 * own pi even while it is empty, the owner's profile for his — and the name is
 * `profileNameFor(owned)`, so there is one copy of each of the two profile names in the
 * product. Nothing here throws: a missing file is an empty list, and a file that does not
 * parse is a problem the caller refuses on.
 */
export function readModelsProviders(extensionUri: vscode.Uri): ModelsProvidersState {
  const mode = readMode();
  // Where the profile is and whose it is are two questions with two answers, and both
  // come from the resolver rather than from a comparison written here: `managed` is not a
  // synonym the panel may hold on its own, because a mode whose mapping changes would
  // otherwise leave this surface writing one profile while the login writes another.
  const owned = instanceAgentDir(extensionUri, mode) !== undefined;
  const profileDir = instanceProfileDir(extensionUri, mode);
  const profileName = profileNameFor(owned);

  const read = readModelsFile(path.join(profileDir, MODELS_FILE_NAME));

  const state = (rest: Omit<ModelsProvidersState, "profileDir" | "profileName" | "owned">) => ({
    profileDir,
    profileName,
    owned,
    ...rest,
  });

  if (read.kind === "unreadable") {
    return state({
      providers: [],
      summary: refusedSummary(profileName),
      json: undefined,
      problem: "unreadable",
    });
  }
  if (read.kind === "missing") {
    // A first entry: no file is not a file that cannot be read, so this is the one state
    // that is both empty and writable — starting from the `{}` pi itself would read.
    return state({
      providers: [],
      summary: describeConfiguredProviders([], profileName),
      json: {},
      problem: undefined,
    });
  }

  const parsed = parseModelsText(read.text);
  if (!parsed.ok) {
    return state({
      providers: [],
      summary: refusedSummary(profileName),
      json: undefined,
      problem: parsed.problem,
    });
  }

  const providers = listConfiguredProviders(parsed.json);
  return state({
    providers,
    summary: describeConfiguredProviders(providers, profileName),
    json: parsed.json,
    problem: undefined,
  });
}

/* ------------------------------------------------------------------ *
 * The pickers' rows, built without an editor
 * ------------------------------------------------------------------ */

/** One declared provider as the removal picker shows it. */
export interface ConfiguredProviderRow extends vscode.QuickPickItem {
  id: string;
  label: string;
  description: string;
  detail: string;
}

/** One thing the flow can do, as its first picker shows it. */
export interface ModelsActionItem extends vscode.QuickPickItem {
  action: "add" | "remove";
}

/** One `api` id as the picker shows it: pi's own id next to what it means. */
export interface ApiItem extends vscode.QuickPickItem {
  value: string;
}

/**
 * One provider as a row of the removal picker.
 *
 * The id is the label because it is the key the removal names and the provider half of
 * every `proveedor/modelo` reference; the endpoint and the api go in the description, and
 * the models and whether the entry carries a key in the detail. Whether it carries one is
 * stated and never shown — the file may hold a literal key, and this surface never prints
 * a credential.
 */
export function providerRow(provider: ConfiguredProvider): ConfiguredProviderRow {
  return {
    id: provider.id,
    label: provider.id,
    description: [provider.baseUrl, provider.api]
      .filter((part) => part !== undefined && part !== "")
      .join(" · "),
    detail: [
      provider.models.length === 0
        ? PROVIDER_ROW_MARKERS.noModels
        : provider.models.join(", "),
      provider.hasKey ? PROVIDER_ROW_MARKERS.hasKey : PROVIDER_ROW_MARKERS.noKey,
    ].join(" · "),
  };
}

/** Every declared provider as a row, in the order the list carries. */
export function providerRows(providers: readonly ConfiguredProvider[]): ConfiguredProviderRow[] {
  return providers.map(providerRow);
}

/**
 * What the flow offers, in the order it offers it.
 *
 * Removing is offered only when there is something to remove: an empty list has no row
 * to take out, and offering it would be offering a picker with nothing in it.
 */
export function actionItems(providers: readonly ConfiguredProvider[]): ModelsActionItem[] {
  const items: ModelsActionItem[] = [
    { action: "add", label: MODELS_TEXTS.addLabel, description: MODELS_TEXTS.addDescription },
  ];
  if (providers.length > 0) {
    items.push({
      action: "remove",
      label: MODELS_TEXTS.removeLabel,
      description: MODELS_TEXTS.removeDescription,
    });
  }
  return items;
}

/** pi's own `api` ids as the picker's rows: what it means first, the id it stores second. */
export function apiItems(): ApiItem[] {
  return PROVIDER_APIS.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.value,
  }));
}

/* ------------------------------------------------------------------ *
 * What each field of the form accepts
 * ------------------------------------------------------------------ */

/*
 * Each of these returns the sentence the field shows, or `undefined` when the value can
 * be written. They are the only gate between a keystroke and `models.json`, and pi
 * validates that file by throwing at load time rather than at the form, so the shapes
 * checked here are pi's own: `applyModelsJson` refuses a provider without `baseUrl` or
 * without an `api`, a provider id is a key and a path segment, and a model id is a name
 * that is never rewritten.
 */

/** Why a value cannot be a provider id, or `undefined` when it can. */
export function idProblem(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") {
    return MODELS_TEXTS.idRequired;
  }
  return isProviderId(trimmed) ? undefined : MODELS_TEXTS.idInvalid;
}

/** Why a value cannot be an endpoint, or `undefined` when it can. */
export function baseUrlProblem(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") {
    return MODELS_TEXTS.baseUrlRequired;
  }
  return isBaseUrl(trimmed) ? undefined : MODELS_TEXTS.baseUrlInvalid;
}

/** Why a value declares no model at all, or `undefined` when it declares one. */
export function modelIdsProblem(value: string): string | undefined {
  return parseModelIds(value).ids.length === 0 ? MODELS_TEXTS.modelsRequired : undefined;
}

/**
 * Why a value cannot be a key, or `undefined` when it can.
 *
 * pi accepts three forms and they are not equally sensitive: `$NAME`/`${NAME}` reads an
 * environment variable and `!command` runs a command, so the secret stays out of the
 * file, while anything else is the literal key and pi's own documentation warns that it
 * ends up on disk. All three are accepted — a local endpoint wants a literal, or none at
 * all — and only the two prefixed forms are shape-checked, because a literal is a
 * credential whose shape this module has no business guessing at. Empty means "leave the
 * entry's key alone", which is not an error: the form never saw the stored one.
 */
export function keyProblem(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (trimmed.startsWith("$")) {
    return isEnvVarName(trimmed.slice(1).replace(/^\{|\}$/g, ""))
      ? undefined
      : MODELS_TEXTS.keyEnvInvalid;
  }
  if (trimmed.startsWith("!")) {
    return trimmed.length === 1 ? MODELS_TEXTS.keyCommandInvalid : undefined;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * The pure endings
 * ------------------------------------------------------------------ */

/**
 * The ending after a provider was written: what was declared, in which profile, and the
 * reload.
 *
 * The profile is named in words, never by path, because which of the two profiles holds
 * the declaration is the fact that makes it meaningful. The key is deliberately not part
 * of the sentence in any form — `input` carries it and this function never reads it, which
 * is what the check in the suite pins — and the entries the form had to discard are named
 * rather than dropped silently, because a model id that was refused is a model the owner
 * will otherwise look for at the first call.
 */
export function addedText(
  input: NewProviderInput,
  profileName: string,
  rejected: readonly string[],
): string {
  const count = `${input.modelIds.length} modelo${input.modelIds.length === 1 ? "" : "s"}`;
  const declared =
    `${input.id} escrito en el ${MODELS_FILE_NAME} de ${profileName}: ${input.baseUrl} ` +
    `(${input.api}), con ${count}. ` +
    `${RELOAD_WINDOW_LABEL} para que pi lo lea.`;
  return rejected.length === 0
    ? declared
    : `${declared} Se descartaron, por no ser identificadores válidos: ${rejected.join(", ")}.`;
}

/** The ending after a provider was taken out: the id, the profile, and the reload. */
export function removedText(id: string, profileName: string): string {
  return (
    `${id} ya no está en el ${MODELS_FILE_NAME} de ${profileName}. ` +
    `${RELOAD_WINDOW_LABEL} para que pi lo lea.`
  );
}

/** The ending when the file could not be written: what failed, in pi's or the filesystem's words. */
export function writeFailedText(message: string): string {
  return `No se pudo escribir el ${MODELS_FILE_NAME}. ${message}`;
}

/* ------------------------------------------------------------------ *
 * The command
 * ------------------------------------------------------------------ */

/** What the flow decided to write: the merged file, the operation, and the sentence that reports it. */
interface WrittenChange {
  json: ModelsJson;
  /** The provider the change is about, for the confirmation in front of the write. */
  id: string;
  /** Which of the two acts it is, because the confirmation names it. */
  kind: "add" | "remove";
  text: string;
}

/**
 * The command: reads the selected instance's `models.json`, adds or removes one provider,
 * reports what was written and offers the reload.
 *
 * The refusal comes first and before any picker, because a file that does not parse is a
 * file the write below must not replace. Every ending is a notification; nothing here
 * needs a webview, and nothing here opens one.
 *
 * One confirmation stands between the change and the file, and it is the last thing before
 * the write: quitting a declared provider always asks (the entry may carry hand-tuned keys
 * that only the file knows), and writing anywhere in the owner's own profile asks as well —
 * with the same sentence for the same reason the login uses. Exactly one modal per act, so
 * nobody is asked twice about one decision.
 */
export async function modelsProviders(context: vscode.ExtensionContext): Promise<void> {
  const state = readModelsProviders(context.extensionUri);

  if (state.problem !== undefined) {
    void vscode.window.showErrorMessage(
      `PiCode: ${refusedText(state.profileName, state.problem)}`,
    );
    return;
  }

  const action = await chooseAction(state);
  if (action === undefined) {
    return cancelled();
  }

  const change = action === "add" ? await addProvider(state) : await removeProvider(state);
  if (change === undefined) {
    return cancelled();
  }

  const decision = await confirmWrite(state, change);
  if (decision === "declined") {
    return state.owned
      ? cancelled()
      : void vscode.window.showInformationMessage(`PiCode: ${MODELS_TEXTS.ownerDeclined}`);
  }
  if (decision === "dismissed" || !writeState(state, change.json)) {
    return;
  }

  // pi loads `models.json` once, when its model runtime is built, and the running agent
  // was built at startup — so the reload is what makes it read the new list. It is
  // offered rather than promised, exactly as the login offers it.
  const choice = await vscode.window.showInformationMessage(
    `PiCode: ${change.text}`,
    RELOAD_WINDOW_LABEL,
  );
  if (choice === RELOAD_WINDOW_LABEL) {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

/** The one refusal that is not an error: nothing was written because the owner closed a dialog. */
function cancelled(): void {
  void vscode.window.showInformationMessage(`PiCode: ${MODELS_TEXTS.cancelled}`);
}

/**
 * The confirmation in front of the write, or the fact that there is nothing to confirm.
 *
 * `dismissed` is the one ending that says nothing at all: it belongs to the case where
 * the write was only ever going to happen in PiCode's own profile, where closing the
 * dialog is the same as closing any other prompt, and where `cancelled()` has just spoken
 * for the change the owner asked for.
 */
type WriteDecision = "confirmed" | "declined" | "dismissed" | "none";

/**
 * Asks the one question this write owes, when it owes one.
 *
 * Quitting a declared provider is always asked about — the entry may carry keys a form
 * never collected, and the removal is not the file's only content — while writing in the
 * owner's own profile is asked about because that profile is not PiCode's. When both are
 * true there is one modal, not two: the sentence says which act it is about to do in
 * which profile, which is everything the owner needs to decide.
 *
 * The button is `ownerContinue` rather than the login's, because it also fronts a removal,
 * and one label has to fit both acts. The login keeps its own wording, where the act is
 * always the same one.
 */
async function confirmWrite(
  state: ModelsProvidersState,
  change: WrittenChange,
): Promise<WriteDecision> {
  if (!state.owned) {
    const message =
      change.kind === "add" ? MODELS_TEXTS.ownerAddConfirm(change.id) : MODELS_TEXTS.ownerRemoveConfirm(change.id);
    const answer = await vscode.window.showWarningMessage(
      `PiCode: ${message}`,
      { modal: true },
      MODELS_TEXTS.ownerContinue,
    );
    return answer === MODELS_TEXTS.ownerContinue ? "confirmed" : "declined";
  }
  if (change.kind === "add") {
    return "confirmed";
  }
  const answer = await vscode.window.showWarningMessage(
    `PiCode: ${MODELS_TEXTS.removeConfirm(change.id, state.profileName)}`,
    { modal: true },
    MODELS_TEXTS.removeContinue,
  );
  return answer === MODELS_TEXTS.removeContinue ? "confirmed" : "dismissed";
}

/**
 * The first picker: add, remove, or nothing.
 *
 * The placeholder is the summary line the settings row shows, so the inventory the owner
 * just read there is the same one he sees as he chooses. A `remove` is offered only when
 * `actionItems` decided there is something to take out.
 */
async function chooseAction(
  state: ModelsProvidersState,
): Promise<"add" | "remove" | undefined> {
  const picked = await vscode.window.showQuickPick(actionItems(state.providers), {
    title: MODELS_TEXTS.pickTitle,
    placeHolder: state.summary,
    ignoreFocusOut: true,
  });
  return picked?.action;
}

/** The removal: one declared provider, taken out of the file it was read from. */
async function removeProvider(
  state: ModelsProvidersState,
): Promise<WrittenChange | undefined> {
  const picked = await vscode.window.showQuickPick(providerRows(state.providers), {
    title: MODELS_TEXTS.removeTitle,
    placeHolder: MODELS_TEXTS.removePlaceHolder,
    ignoreFocusOut: true,
  });
  if (picked === undefined) {
    return undefined;
  }
  return {
    json: removeConfiguredProvider(state.json ?? {}, picked.id),
    id: picked.id,
    kind: "remove",
    text: removedText(picked.id, state.profileName),
  };
}

/**
 * The addition: the five fields pi needs, asked one at a time.
 *
 * The order is the order the file is read in — the key the entry will live under, the
 * endpoint, the protocol that answers there, the credential, and the models it serves —
 * and every field is validated against pi's own shape before the next one is asked, so a
 * refusal leaves the file untouched instead of half-declared. Closing any of them writes
 * nothing.
 */
async function addProvider(state: ModelsProvidersState): Promise<WrittenChange | undefined> {
  const id = await askField(MODELS_TEXTS.idPrompt, MODELS_TEXTS.idPlaceHolder, idProblem);
  if (id === undefined) {
    return undefined;
  }
  const baseUrl = await askField(
    MODELS_TEXTS.baseUrlPrompt,
    MODELS_TEXTS.baseUrlPlaceHolder,
    baseUrlProblem,
  );
  if (baseUrl === undefined) {
    return undefined;
  }

  const api = await vscode.window.showQuickPick(apiItems(), {
    title: MODELS_TEXTS.apiPickTitle,
    placeHolder: MODELS_TEXTS.apiPlaceHolder,
    ignoreFocusOut: true,
  });
  if (api === undefined) {
    return undefined;
  }

  const key = await askField(
    MODELS_TEXTS.keyPrompt,
    MODELS_TEXTS.keyPlaceHolder,
    keyProblem,
    // The key is the one field whose emptiness is an answer: leaving it empty keeps
    // whatever the entry already had, so the field is not required — and it is the one
    // field that does not echo, because a literal is the key itself.
    { optional: true, password: true },
  );
  if (key === undefined) {
    return undefined;
  }

  const models = await askField(
    MODELS_TEXTS.modelsPrompt,
    MODELS_TEXTS.modelsPlaceHolder,
    modelIdsProblem,
  );
  if (models === undefined) {
    return undefined;
  }

  const parsed = parseModelIds(models);
  const input: NewProviderInput = {
    id: id.trim(),
    baseUrl: baseUrl.trim(),
    api: api.value,
    // `undefined` is "the form did not touch the key", which is what an empty answer
    // means here: the stored value was never read, so silence cannot mean removal.
    apiKey: key.trim() === "" ? undefined : key.trim(),
    modelIds: parsed.ids,
  };

  return {
    json: upsertConfiguredProvider(state.json ?? {}, input),
    id: input.id,
    kind: "add",
    text: addedText(input, state.profileName, parsed.rejected),
  };
}

/**
 * One text field of the form, with its own validator.
 *
 * `validateInput` is the same function the validator exports, so the sentence the owner
 * reads while typing is the sentence the suite asserts — there is no second copy of it in
 * the layout.
 */
function askField(
  prompt: string,
  placeHolder: string,
  validate: (value: string) => string | undefined,
  field: { optional?: boolean; password?: boolean } = {},
): Thenable<string | undefined> {
  const box: vscode.InputBoxOptions = {
    prompt,
    placeHolder,
    ignoreFocusOut: true,
    validateInput: (value) =>
      !field.optional || value.trim() !== "" ? validate(value) : undefined,
  };
  // The field that can hold a literal credential is the one field that does not echo,
  // even though it also accepts the two forms that hold no secret: a masked variable
  // name costs nothing, and an unmasked key is on screen for as long as it is typed.
  if (field.password === true) {
    box.password = true;
  }
  return vscode.window.showInputBox(box);
}

/**
 * Replaces the profile's `models.json` with the merged one, or says why it could not.
 *
 * `writeModelsFile` writes a temp file and renames it over the target, so a failed write
 * leaves the file it could not replace exactly as it was; the reason is reported as pi or
 * the filesystem worded it, because it is theirs and not this module's to paraphrase.
 */
function writeState(state: ModelsProvidersState, json: ModelsJson): boolean {
  try {
    writeModelsFile(path.join(state.profileDir, MODELS_FILE_NAME), json);
    return true;
  } catch (error) {
    void vscode.window.showErrorMessage(
      `PiCode: ${writeFailedText(error instanceof Error ? error.message : String(error))}`,
    );
    return false;
  }
}
