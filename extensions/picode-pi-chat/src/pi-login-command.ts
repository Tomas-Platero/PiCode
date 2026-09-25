/*
 * T6b of the two-instances feature: a provider login driven from inside the editor.
 *
 * pi can log a provider in through its SDK (`ModelRuntime.login`), and the interaction
 * it asks for during that login is built from the editor's own dialogs
 * (`createAuthInteraction`). Neither ability is reachable from a terminal-free flow on
 * its own, so this module is the command that joins them: it asks which provider, shows
 * what kind of credential each one wants in the owner's terms rather than pi's, runs the
 * login, and reports one of four honest endings.
 *
 * The profile is the whole point, and the rule about it is one line: the credential goes
 * into the profile of the instance the owner selected, and nowhere else. That is
 * `instanceProfileDir(uri, mode)`, the *unguarded writer's* answer, which names PiCode's
 * own profile — `<distribution>/data/pi-agent` — even while it is still empty, and names
 * the profile the owner's installed pi reads when his pi is the selected instance. The
 * *guarded readers'* answer is never consulted: on an empty internal profile it names the
 * machine's own one, which is exactly the state a first login exists to fill. Writing one
 * total mapping is also why this command has no refusal left: the profile it must fill is
 * the guarded one, so refusing there would refuse the only case that needs a login.
 *
 * What the mapping does not settle is who the target belongs to, and that is a second
 * question with its own answer: `instanceAgentDir(uri, mode)` is `undefined` exactly when
 * the selected instance is the owner's own pi. That profile is not PiCode's — it is the
 * one his installed pi reads and the one every other pi tool on the machine writes — so
 * the flow asks once, with a modal, after the provider was chosen and before anything is
 * written or started, and writes only once he says yes. Whichever of the two it wrote, it
 * names it in words (`profileNameFor`) rather than printing a path the owner has to
 * decode.
 *
 * The catalogue and the write come from different places, and on purpose. The list is
 * read from the runtime of the session already running when there is one — that runtime
 * was built over the profile in force at spawn time, so it knows the providers the
 * owner's installed packages registered — and from the runtime the SDK builds for the
 * target profile when there is no session yet. The write always keeps its own runtime
 * over the target profile, so the credential lands in the profile the selection names
 * *now*: the live runtime can be older than the row, and a credential written through it
 * would land in a profile the row no longer points at. Building either runtime with
 * `createAgentSessionServices` (and not the bare `ModelRuntime.create`) is what lets a
 * provider registered by an extension installed in that profile appear in the list: it is
 * the same step a session takes before it is created, without creating a session.
 *
 * The split is the same one the import command uses: everything that decides what the
 * owner reads is pure and testable without an editor (`loginType`, `providerEntry`,
 * `providerEntries`, `synchronizationFailure`, `loginSuccessText`,
 * `loginSyncFailureText`, `loginFailureText`), and only the flow touches `vscode`.
 */

import { pathToFileURL } from "node:url";
import * as vscode from "vscode";
import { instanceProfileDir, profileNameFor } from "./instance";
import { RELOAD_WINDOW_LABEL } from "./instance-import-command";
import {
  AuthPromptCancelled,
  createAuthInteraction,
  type AuthInteraction,
} from "./pi-ui-bridge";
import type { AuthType } from "./pi-sdk-client";
import { resolveRuntime, resolveSdkEntry } from "./runtime";

/** The command the palette runs. Declared in package.json and registered once. */
export const LOGIN_PROVIDER_COMMAND = "picode.piChat.loginProvider";

/* ------------------------------------------------------------------ *
 * The slice of pi's runtime this command calls
 * ------------------------------------------------------------------ */

/**
 * pi's `ProviderAuth`, reduced to the two interactive login methods.
 *
 * Quoted rather than imported because pi is ESM-only and loaded by URL at runtime. Only
 * presence matters here, and the shapes are taken from pi-ai's `auth/types.d.ts`:
 * `apiKey` may exist without a `login` (an ambient-only provider), while `oauth` always
 * carries one.
 */
export interface LoginProviderAuth {
  apiKey?: { login?: unknown };
  oauth?: unknown;
}

/** pi's `Provider`, reduced to what the list needs: an id, a name and its auth methods. */
export interface LoginProvider {
  readonly id: string;
  readonly name: string;
  readonly auth: LoginProviderAuth;
}

/**
 * The `ModelRuntime` slice this command calls.
 *
 * `login` is optional on purpose: an older pi need not carry it, and the flow refuses
 * with a sentence the owner can read instead of failing on a property of `undefined`.
 * The rest are the catalogue's own facts, so the key-versus-subscription decision and
 * the "already has credentials" marker come from pi and not from a table here.
 */
export interface LoginRuntime {
  getProviders(): readonly LoginProvider[];
  isUsingOAuth(providerId: string): boolean;
  isUsingSubscription(providerId: string): boolean;
  hasConfiguredAuth(providerId: string): boolean;
  login?(
    providerId: string,
    type: AuthType,
    interaction: AuthInteraction,
  ): Promise<unknown>;
}

/**
 * The SDK entry this command loads: only the one step that produces a runtime for a
 * profile. `createAgentSessionServices` is used rather than `ModelRuntime.create`
 * because it also registers the providers the profile's own extensions declare, so the
 * list is the one that instance would actually have. `agentDir` is named explicitly, so
 * nothing here can fall back to pi's own default.
 */
export interface LoginSdk {
  createAgentSessionServices(options: {
    cwd: string;
    agentDir: string;
  }): Promise<{ modelRuntime: LoginRuntime }>;
}

/**
 * Reads the runtime of the session that is already running, or `undefined` when there is
 * none — the wizard can reach the command before any chat exists. Supplied by the host,
 * because where a live session lives is the host's business.
 */
export type LiveLoginRuntime = () => LoginRuntime | undefined;

/**
 * `import()` that survives this project's CommonJS output.
 *
 * TypeScript rewrites a literal dynamic import to `require()` when the module target is
 * CommonJS, and pi publishes its entry as ESM that `require()` cannot load. Building the
 * import at runtime keeps it a genuine dynamic `import()`, exactly as the SDK client does.
 */
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<unknown>;

/* ------------------------------------------------------------------ *
 * The pure decision: what a provider entry says
 * ------------------------------------------------------------------ */

/** What the list calls each kind of login, in the owner's terms rather than pi's. */
export const PROVIDER_KINDS: Record<AuthType, string> = {
  api_key: "clave",
  oauth: "suscripción",
};

/** The two states a provider can be in, said as a fact and not as an internal value. */
export const PROVIDER_MARKERS = {
  configured: "ya tiene credenciales guardadas",
  missing: "todavía sin credenciales",
} as const;

/** The facts about one provider, read from the runtime before the decision is made. */
export interface ProviderFacts {
  id: string;
  name: string;
  /** pi offers an interactive key login for this provider. */
  keyLogin: boolean;
  /** pi offers an OAuth login for this provider, which is what a subscription is. */
  subscriptionLogin: boolean;
  /** The stored credential is OAuth. */
  usingOAuth: boolean;
  /** The stored credential is a subscription. */
  usingSubscription: boolean;
  /** A credential is already configured, stored or from the environment. */
  configured: boolean;
}

/** One selectable row of the provider list, already written for the owner. */
export interface ProviderEntry {
  id: string;
  /** The provider's own name; provider names are proper nouns, not jargon. */
  label: string;
  /** `clave` or `suscripción`, the one thing the owner decides between. */
  description: string;
  /** Whether the provider already holds a credential. */
  detail: string;
  /** The login pi will run, which is what the flow passes back to `login`. */
  type: AuthType;
}

/**
 * Every way into a provider, in the order the list should offer them.
 *
 * A provider is **not** one choice. Seven of pi's own providers (`anthropic`,
 * `github-copilot`, `kimi-coding`, `meta`, `openrouter`, `radius`, `xai`) accept both a
 * subscription and a key, and collapsing them into a single row is what made "connect
 * Claude with a Pro/Max account" impossible here even though pi supports it: the key was
 * checked first and the subscription never appeared.
 *
 * The order is a decision, not an accident. A credential that is already stored leads, so
 * the row that is in force is the first one read. Then the subscription, because it is
 * the narrower and more deliberate way in and the one that is otherwise invisible. The
 * key comes last, which is where it belongs: it always applies, so it needs no help being
 * found.
 *
 * A provider with neither method is left out rather than offered and then failing, which
 * is why this returns an empty list for one.
 */
export function providerOffers(facts: ProviderFacts): AuthType[] {
  const offers: AuthType[] = [];
  if (facts.usingSubscription || facts.usingOAuth) {
    offers.push("oauth");
  }
  if (facts.subscriptionLogin) {
    offers.push("oauth");
  }
  if (facts.keyLogin) {
    offers.push("api_key");
  }
  return [...new Set(offers)];
}

/**
 * The login pi will run when the owner does not pick one, or `undefined` when it cannot
 * log the provider in at all. It is the first offer, so the two can never disagree.
 */
export function loginType(facts: ProviderFacts): AuthType | undefined {
  return providerOffers(facts)[0];
}

/**
 * One provider as the list shows it, or `undefined` when it cannot be logged in.
 *
 * Pure over the facts, so the wording and the key-versus-subscription decision are
 * exercised without an editor, a profile or a provider.
 */
export function providerEntry(facts: ProviderFacts): ProviderEntry | undefined {
  const type = loginType(facts);
  if (type === undefined) {
    return undefined;
  }
  return {
    id: facts.id,
    label: facts.name,
    description: PROVIDER_KINDS[type],
    detail: facts.configured ? PROVIDER_MARKERS.configured : PROVIDER_MARKERS.missing,
    type,
  };
}

/**
 * The provider list a runtime offers, in the owner's own alphabetical order.
 *
 * The runtime is asked for its own providers and its own facts; nothing about pi's
 * catalogue is written down here. A provider that cannot be logged in is skipped, which
 * is why this list is usually shorter than the catalogue.
 */
/**
 * The providers nearly everybody comes for, in the order they are offered.
 *
 * pi ships 41 of them and the list came out alphabetical, which buried Claude, ChatGPT,
 * DeepSeek and Copilot under whichever provider happened to start with an early letter. This
 * is a curated **order**, not a filter: everything else is still offered, below these.
 *
 * The ids are pi's own (`anthropic`, `openai-codex`…), because that is what the runtime
 * answers with and what the login is performed against.
 */
export const FEATURED_PROVIDERS: readonly string[] = [
  "anthropic",
  "openai-codex",
  "openai",
  "google",
  "deepseek",
  "xai",
  "openrouter",
  "github-copilot",
  "mistral",
  "groq",
];

/**
 * The list's order: the featured providers first, in their curated order, and everything
 * else after them in the owner's alphabetical order.
 *
 * Pure, and it sorts by name and not by kind, so a provider that offers both ways in keeps
 * the order `providerOffers` chose for it — the subscription row continues to lead.
 */
export function sortProviderEntries(entries: readonly ProviderEntry[]): ProviderEntry[] {
  const rank = (id: string): number => {
    const index = FEATURED_PROVIDERS.indexOf(id);
    return index === -1 ? FEATURED_PROVIDERS.length : index;
  };
  return [...entries].sort((left, right) => {
    const byRank = rank(left.id) - rank(right.id);
    return byRank !== 0 ? byRank : left.label.localeCompare(right.label);
  });
}

export function providerEntries(runtime: LoginRuntime): ProviderEntry[] {
  const entries: ProviderEntry[] = [];
  for (const provider of runtime.getProviders()) {
    const facts: ProviderFacts = {
      id: provider.id,
      name: provider.name,
      keyLogin: typeof provider.auth.apiKey?.login === "function",
      subscriptionLogin: provider.auth.oauth !== undefined,
      usingOAuth: runtime.isUsingOAuth(provider.id),
      usingSubscription: runtime.isUsingSubscription(provider.id),
      configured: runtime.hasConfiguredAuth(provider.id),
    };

    // One row **per way in**, not per provider. A provider that offers two logins gets
    // two rows, which is the whole point: they are two different decisions for the owner
    // (a Claude subscription and an Anthropic key are not the same thing) and pi runs a
    // different flow for each. A provider with none gets no row at all.
    for (const type of providerOffers(facts)) {
      entries.push({
        id: facts.id,
        label: facts.name,
        description: PROVIDER_KINDS[type],
        detail: facts.configured ? PROVIDER_MARKERS.configured : PROVIDER_MARKERS.missing,
        type,
      });
    }
  }
  // The featured ones first so they are not buried, everything else alphabetical below.
  return sortProviderEntries(entries);
}

/** One row as the list paints it: a title, the kind or the state, and the state. */
export interface ProviderRow {
  label: string;
  description: string;
  detail: string | undefined;
}

/**
 * How the entries become rows.
 *
 * A provider that offers both ways in contributes two rows with the same name, and a
 * repeated name would make the owner read the same word twice to tell them apart. When a
 * name repeats, the way in becomes part of the label and the kind is not printed a second
 * time underneath, so each row says what it is once and what it is missing once. Pure, so
 * the wording is pinned by a test instead of by the widget.
 */
export function providerRows(entries: readonly ProviderEntry[]): ProviderRow[] {
  const nameCounts = new Map<string, number>();
  for (const entry of entries) {
    nameCounts.set(entry.label, (nameCounts.get(entry.label) ?? 0) + 1);
  }
  return entries.map((entry) => {
    const repeated = (nameCounts.get(entry.label) ?? 0) > 1;
    return {
      label: repeated ? `${entry.label} — ${entry.description}` : entry.label,
      description: repeated ? entry.detail : entry.description,
      detail: repeated ? undefined : entry.detail,
    };
  });
}

/**
 * The record Settings shows, with one provider added.
 *
 * Pure over the list so the merge is testable without an editor, a profile or a runtime.
 * A provider is recorded **once**: a second login of the same provider replaces its entry
 * instead of adding a line, because the row reports which providers are connected, not how
 * many times they were. Sorted, so the row's order does not depend on the order of logins.
 */
export function withConnectedProvider(
  current: readonly string[],
  provider: string,
  type: AuthType,
): string[] {
  const label = providerLabel(provider, type);
  const others = current.filter((value) => !value.startsWith(`${provider}${PROVIDER_LABEL_SEPARATOR}`));
  return [...others, label].sort((left, right) => left.localeCompare(right));
}

/** How one connected provider is written down: the provider and the way in. */
export const PROVIDER_LABEL_SEPARATOR = " — ";

export function providerLabel(provider: string, type: AuthType): string {
  return `${provider}${PROVIDER_LABEL_SEPARATOR}${PROVIDER_KINDS[type]}`;
}

/**
 * Writes that record where Settings reads it.
 *
 * The write is the whole reason the core declares the setting: a Settings row is a value,
 * and the extension is what keeps it true. It never throws at the caller — the credential
 * is already in place and a bookkeeping write must not turn a successful login into a
 * failure — so a refusal lands in the output channel instead.
 */
async function rememberConnectedProvider(provider: string, type: AuthType): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("picode.pi");
  const current = configuration.get<string[]>("providers", []);
  try {
    await configuration.update(
      "providers",
      withConnectedProvider(current, provider, type),
      vscode.ConfigurationTarget.Global,
    );
  } catch (error) {
    // Deliberately not rethrown, and this is the only place in this file that swallows:
    // the credential is already committed, so failing the whole flow over the row that
    // reports it would be worse than a stale row. It is still reported as an error, which
    // is where a failure of this kind belongs.
    console.error(`picode: could not record the connected provider: ${asErrorMessage(error)}`);
  }
}

/* ------------------------------------------------------------------ *
 * The pure wording of the four endings
 * ------------------------------------------------------------------ */

/**
 * The sentences that need no provider to be written, one per refusal or ending.
 *
 * Each is the whole message of a refusal, so they are kept together for a test to assert
 * rather than restate. The three `ownerProfile*` entries carry the one confirmation this
 * command still owes: with the owner's own pi selected the target is the profile his
 * installed pi reads, which also belongs to every other pi tool on the machine, so the
 * answer he gives decides whether the credential may go there.
 */
export const LOGIN_TEXTS = {
  noSdk: "Este pi no sabe iniciar sesión desde el SDK. Actualiza el pi integrado.",
  noCatalogue:
    "No se pudieron leer los proveedores de este pi, así que no se puede iniciar sesión desde aquí.",
  noProviders: "Ninguno de los proveedores de este pi se puede conectar desde aquí.",
  cancelled: "No se inició sesión: cerraste la petición de pi.",
} as const;

/**
 * pi's credential operations, said as what they do rather than as their own names.
 *
 * `CredentialSynchronizationError.operation` is one of pi's internal tokens
 * (`login`, `logout`, `setRuntimeApiKey`, `removeRuntimeApiKey`); the message names the
 * operation, and it names it in words the owner can act on. An unknown operation is
 * passed through rather than guessed at.
 */
export const LOGIN_OPERATIONS: Record<string, string> = {
  login: "guardar la credencial",
  logout: "borrar la credencial",
  setRuntimeApiKey: "guardar una clave temporal",
  removeRuntimeApiKey: "borrar una clave temporal",
};

/** The operation as the owner reads it. Pure, so an unknown token is still exercised. */
export function operationText(operation: string): string {
  return LOGIN_OPERATIONS[operation] ?? operation;
}

/**
 * The success ending: names the provider, names the profile that now holds the
 * credential, and says the reload is what makes the running agent use it.
 *
 * The profile is named in words, never by path, because which of the two profiles holds
 * the credential is the fact that makes the login meaningful — and because the running
 * agent was built at startup from a possibly different directory, which is what the
 * reload is for.
 *
 * `profileName` comes from `profileNameFor`, so the two possible names have one home.
 */
export function loginSuccessText(provider: string, profileName: string): string {
  return (
    `Credenciales de ${provider} guardadas en ${profileName}. ` +
    "Recarga la ventana para que el agente que está corriendo las use."
  );
}

/**
 * The synchronisation ending, which must never read like a failure.
 *
 * `CredentialSynchronizationError` means the credential **was** committed and the local
 * model/auth snapshot could not be synchronized afterwards. So the sentence names the
 * provider and the operation, says the credential is already stored, and warns against
 * repeating the mutation, which is the one thing that error exists to prevent.
 */
export function loginSyncFailureText(provider: string, operation: string): string {
  return (
    `La credencial de ${provider} sí se guardó, pero pi no pudo sincronizar el estado del ` +
    `proveedor durante «${operationText(operation)}». No repitas el inicio de sesión a ciegas: ` +
    "recarga la ventana y comprueba si el proveedor ya funciona."
  );
}

/** The plain failure ending: what was attempted, and what pi said. */
export function loginFailureText(provider: string, message: string): string {
  return `No se pudo iniciar sesión en ${provider}. ${message}`;
}

/**
 * The ending for a provider the target runtime does not know, which is not a failure to
 * retry but a missing package to bring in.
 *
 * The two runtimes can disagree on exactly one provider. The list comes from the profile
 * in force at spawn time — that is where the owner's installed packages register their
 * providers — while the credential goes to the profile the selection names now, so a
 * provider the first one knows and the second one has never installed makes pi's
 * `Models.login` throw `Unknown provider: <id>`. Changing the row between the spawn and
 * this command is enough to reach it, and so is importing a package into the target
 * profile after the session started.
 *
 * There is one profile and one door. The sentence used to branch on whose profile was
 * missing the package, and one of the two branches pointed at importing the machine's pi;
 * that import is gone (the owner ruled it out: nothing is taken from the PATH pi), so the
 * single way forward is installing the package in the pi the editor runs.
 */
export function unknownProviderText(provider: string): string {
  return (
    `El proveedor ${provider} lo aporta un paquete que ${profileNameFor()} todavía ` +
    "no tiene, y ahí es donde se guardan las credenciales. " +
    "Instala ese paquete —la pestaña de extensiones instala con el mismo pi que ejecuta el " +
    "editor— y vuelve a intentarlo."
  );
}

/**
 * The provider and the operation carried by a `CredentialSynchronizationError`, or
 * `undefined` for any other error.
 *
 * The class comes from a module loaded at runtime, so it cannot be imported for typing
 * or checked with `instanceof`; pi sets `.name` to the class name, and the two fields
 * are read by name. The `credential` field is deliberately never touched: it is the
 * secret, and nothing here needs it.
 */
export interface SynchronizationFailure {
  providerId: string;
  operation: string;
}

export function synchronizationFailure(error: unknown): SynchronizationFailure | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  if (record.name !== "CredentialSynchronizationError") {
    return undefined;
  }
  if (typeof record.providerId !== "string" || typeof record.operation !== "string") {
    return undefined;
  }
  return { providerId: record.providerId, operation: record.operation };
}

/**
 * The provider pi does not know, or `undefined` for any other failure.
 *
 * `Models.login` (pi-ai's `models.js`) throws a `ModelsError` when the requested
 * provider is not registered in the runtime it is called on. Its shape is exact and is
 * what is matched here: `name === "ModelsError"`, `code === "provider"`, and a message
 * that begins `Unknown provider: ` followed by the id. The class is loaded at runtime,
 * so it can neither be imported for typing nor checked with `instanceof`; the fields are
 * read by name, exactly as `synchronizationFailure` does above.
 *
 * The message prefix is checked on purpose, and it is the only prose matched anywhere in
 * this module. The `code` alone would not be enough: pi throws other `ModelsError`s with
 * `code === "provider"` (an unsupported deferred response, for one), and swallowing one
 * of those as "unknown provider" would hide a real failure. Conversely, a pi that renames
 * this message makes the match fail and the owner sees today's generic ending — the safe
 * direction for an unrecognised error, never a different failure dressed as this one. The
 * id is returned rather than only a boolean so the exact value matched is observable in a
 * test.
 */
export function unknownProvider(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  if (record.name !== "ModelsError" || record.code !== "provider") {
    return undefined;
  }
  const prefix = "Unknown provider: ";
  if (typeof record.message !== "string" || !record.message.startsWith(prefix)) {
    return undefined;
  }
  return record.message.slice(prefix.length);
}

/* ------------------------------------------------------------------ *
 * Loading the runtime for the target profile
 * ------------------------------------------------------------------ */

/** What loading the SDK produced: a runtime, or the reason it could not be built. */
export type LoginRuntimeLoad =
  | { kind: "ready"; runtime: LoginRuntime }
  | { kind: "no-sdk" }
  | { kind: "unreadable" };

/**
 * The runtime the provider list is read from: the one the running session was built
 * with, or the one `buildTarget` builds for the target profile when there is no session
 * yet.
 *
 * `buildTarget` is called **only** in that second case, and the reason is not thrift:
 * building a runtime over a profile is what may create the profile directory and an empty
 * `auth.json` inside it, so with a session running, merely listing providers must not
 * build anything. Extracted as a pure decision so a test proves that promise over two
 * fake runtimes instead of leaving it to be inferred from the flow.
 */
export async function catalogueRuntime(
  running: LoginRuntime | undefined,
  buildTarget: () => Promise<LoginRuntime | undefined>,
): Promise<LoginRuntime | undefined> {
  return running ?? (await buildTarget());
}

/**
 * Builds the runtime whose `auth.json` lives in `target`.
 *
 * `createAgentSessionServices({ agentDir: target })` is the SDK's own step for a profile:
 * it creates the `ModelRuntime` over that profile's two files and registers the providers
 * its extensions declare, which is what makes a provider like an extension's own appear
 * in the list. It creates no session, so this command cannot leave one behind.
 *
 * A missing `createAgentSessionServices` is an older pi and reads as "no SDK login"; a
 * load that throws is "could not read the catalogue". The two are kept apart because
 * they are two different sentences for the owner.
 */
async function loadLoginRuntime(entry: string, target: string): Promise<LoginRuntimeLoad> {
  let sdk: LoginSdk;
  try {
    sdk = (await dynamicImport(pathToFileURL(entry).href)) as LoginSdk;
  } catch {
    return { kind: "unreadable" };
  }
  if (typeof sdk.createAgentSessionServices !== "function") {
    return { kind: "no-sdk" };
  }

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  try {
    const services = await sdk.createAgentSessionServices({ cwd, agentDir: target });
    return { kind: "ready", runtime: services.modelRuntime };
  } catch {
    return { kind: "unreadable" };
  }
}

/* ------------------------------------------------------------------ *
 * The editor flow
 * ------------------------------------------------------------------ */

/** A list row the quick pick carries back to this module. */
interface ProviderChoice extends vscode.QuickPickItem {
  entry: ProviderEntry;
}

/**
 * Shows the providers and returns the chosen one, or `undefined` when the list was
 * closed without choosing.
 *
 * The entry travels on the item so a provider with a repeated display name cannot be
 * confused with another, and the two lines the owner reads are the entry's own: the kind
 * of credential and whether one is already stored.
 */
function chooseProvider(entries: ProviderEntry[]): Promise<ProviderEntry | undefined> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<ProviderChoice>();
    quickPick.title = "PiCode: iniciar sesión en un proveedor";
    quickPick.placeholder = "Elige el proveedor con el que quieres conectar.";
    quickPick.ignoreFocusOut = true;
    quickPick.items = providerRows(entries).map((row, index) => ({
      entry: entries[index],
      label: row.label,
      description: row.description,
      detail: row.detail,
    }));

    // `accepted` is read in `onDidHide`, which is where every close ends, so the
    // accepted choice is not lost to the hide it triggers.
    let accepted: ProviderEntry | undefined;
    quickPick.onDidAccept(() => {
      accepted = quickPick.selectedItems[0]?.entry;
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      quickPick.dispose();
      resolve(accepted);
    });
    quickPick.show();
  });
}

/**
 * The command: logs one provider in, writing into the profile of the selected instance.
 *
 * There is one total mapping — the profile of the instance the owner selected — so the
 * target is resolved first and always a directory: PiCode's own profile for its own pi,
 * and the profile his installed pi reads for `path`/`custom`, which is no longer a
 * refusal but a target with a confirmation in front of it. The credential goes into that
 * directory, through a runtime built over its files. The list, unlike the write, is read
 * from the running session's runtime when there is one, because that runtime belongs to
 * the profile in force and is the only one that knows the providers the owner's installed
 * packages registered.
 *
 * Nothing here performs a login by itself; the runtime's `login` is pi's own flow, and the
 * interaction pi asks for is the editor's dialogs, so there is one set of prompts.
 */
export async function loginProvider(
  context: vscode.ExtensionContext,
  liveRuntime: LiveLoginRuntime,
): Promise<void> {
  // One profile, and it is PiCode's own — the same one every other surface reads and writes.
  // A credential is left here and nowhere else: nothing is saved in the machine's pi.
  const runtimeMode = resolveRuntime(context.extensionUri).mode;
  const target = instanceProfileDir(context.extensionUri, runtimeMode);

  const entry = resolveSdkEntry(context.extensionUri);
  if (entry === undefined) {
    void vscode.window.showErrorMessage(`PiCode: ${LOGIN_TEXTS.noSdk}`);
    return;
  }

  /**
   * Builds the runtime whose `auth.json` lives in the target profile — the profile of the
   * selected instance, and the only one this command may write — and returns it, or
   * `undefined` after saying why it could not be built. `target` is the parameter that
   * decides the profile: it is handed to the SDK rather than derived from whatever the
   * running session happens to use.
   */
  const targetRuntime = async (): Promise<LoginRuntime | undefined> => {
    const load = await loadLoginRuntime(entry, target);
    if (load.kind === "ready") {
      return load.runtime;
    }
    void vscode.window.showErrorMessage(
      `PiCode: ${load.kind === "no-sdk" ? LOGIN_TEXTS.noSdk : LOGIN_TEXTS.noCatalogue}`,
    );
    return undefined;
  };

  // The list comes from the profile in force whenever a session is running: that runtime
  // was built over the profile the editor is actually using, so it is the one whose
  // installed packages registered the owner's providers (`omni`, `nan` on this machine).
  // The runtime built for `target` belongs to the profile the selection names now, which
  // while PiCode's own is still empty knows only the providers pi ships — which is why
  // reading the list from it answered with less than the instance has.
  const running = liveRuntime();
  // Kept so that when the fallback did build the target's runtime, the write below reuses
  // it instead of building a second one over the same profile.
  let builtForTarget: LoginRuntime | undefined;
  const catalogue = await catalogueRuntime(running, async () => {
    // No session yet: the first-run wizard reaches this command before any chat exists.
    // The fallback's cost is the pi behaviour that made this change worth making —
    // `createAgentSessionServices({ agentDir: target })` may create the target profile
    // directory and an empty `auth.json` inside it, so with no session merely opening
    // this command can still leave that file behind. Whichever profile is selected pays
    // that cost, PiCode's own or the owner's; it is a file created by looking, it flips no
    // guard, and it is not the credential — but it is why this branch is taken only with
    // no session at all.
    builtForTarget = await targetRuntime();
    return builtForTarget;
  });
  // `undefined` here means `targetRuntime` already showed why it could not be built.
  if (catalogue === undefined) {
    return;
  }

  if (typeof catalogue.login !== "function") {
    void vscode.window.showErrorMessage(`PiCode: ${LOGIN_TEXTS.noSdk}`);
    return;
  }

  const entries = providerEntries(catalogue);
  if (entries.length === 0) {
    void vscode.window.showInformationMessage(`PiCode: ${LOGIN_TEXTS.noProviders}`);
    return;
  }

  const chosen = await chooseProvider(entries);
  if (chosen === undefined) {
    return;
  }

  // The write never runs on the running session's runtime: that runtime owns the profile
  // in force at spawn time, which the row may have moved away from since, and a credential
  // written through it would land in the profile the row no longer points at. It keeps its
  // own runtime over `target` — the one the fallback already built, or one built now — so
  // the target parameter stays what decides where a credential goes.
  const writer = builtForTarget ?? (await targetRuntime());
  if (writer === undefined) {
    return;
  }
  if (typeof writer.login !== "function") {
    void vscode.window.showErrorMessage(`PiCode: ${LOGIN_TEXTS.noSdk}`);
    return;
  }

  try {
    await writer.login(chosen.id, chosen.type, createAuthInteraction());
  } catch (error) {
    // The owner closing a prompt is not a failure; the bridge reports it as its own
    // error precisely so it is not told as one.
    if (error instanceof AuthPromptCancelled) {
      void vscode.window.showInformationMessage(`PiCode: ${LOGIN_TEXTS.cancelled}`);
      return;
    }
    // Checked before the generic failure, because the credential was committed and
    // telling this as "could not log in" would send the owner to retry a write that
    // already happened.
    const synchronization = synchronizationFailure(error);
    if (synchronization !== undefined) {
      void vscode.window.showErrorMessage(
        `PiCode: ${loginSyncFailureText(chosen.label, synchronization.operation)}`,
      );
      return;
    }
    // Also checked before the generic failure, and only for the exact shape pi's
    // `Models.login` throws when the profile does not register the provider: the list came
    // from the profile in force at spawn time and the write goes to the one selected now,
    // and installing the package that provides it is what reconciles the two. Every other
    // error still falls through to the generic ending below.
    if (unknownProvider(error) !== undefined) {
      void vscode.window.showErrorMessage(`PiCode: ${unknownProviderText(chosen.label)}`);
      return;
    }
    void vscode.window.showErrorMessage(
      `PiCode: ${loginFailureText(chosen.label, asErrorMessage(error))}`,
    );
    return;
  }

  // Settings shows which providers are connected, so the row is written here, where a
  // login has just been committed against a known profile. Deliberately **after** the
  // write: recording a provider whose credential failed to land would make the row the
  // one part of this flow that lies.
  await rememberConnectedProvider(chosen.label, chosen.type);

  // The credential is in the profile's `auth.json`, but the running agent was built at
  // startup and keeps the runtime it was built with, so the reload is what makes it use
  // the new credential. It is offered rather than promised.
  const choice = await vscode.window.showInformationMessage(
    `PiCode: ${loginSuccessText(chosen.label, profileNameFor())}`,
    RELOAD_WINDOW_LABEL,
  );
  if (choice === RELOAD_WINDOW_LABEL) {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
