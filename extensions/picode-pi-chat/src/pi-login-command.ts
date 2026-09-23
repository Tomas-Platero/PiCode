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
 * The profile is the whole point. PiCode owns exactly one profile —
 * `<distribution>/data/pi-agent`, `instanceAgentDir(uri, "managed")` — and it is
 * deliberately unguarded here so it names that directory even while it is still empty,
 * which is precisely the state a first login exists to fill. The *guarded readers'*
 * answer is never consulted: on an empty internal profile it names the machine's own
 * profile, and writing that would be PiCode writing a profile it does not own.
 *
 * The catalogue is read from the runtime the SDK builds for that same profile, so the
 * list comes from pi instead of a table hand-written here, and the login writes through
 * the very runtime whose `auth.json` is the target's. Building it with
 * `createAgentSessionServices` (and not the bare `ModelRuntime.create`) is what lets a
 * provider registered by an extension installed in the profile appear in the list: it is
 * the same step a session takes before it is created, without creating a session.
 *
 * The split is the same one the import command uses: everything that decides what the
 * owner reads is pure and testable without an editor (`loginType`, `providerEntry`,
 * `providerEntries`, `synchronizationFailure`, `loginSuccessText`,
 * `loginSyncFailureText`, `loginFailureText`), and only the flow touches `vscode`.
 */

import { pathToFileURL } from "node:url";
import * as vscode from "vscode";
import { instanceAgentDir } from "./instance";
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
 * Which login pi will run for a provider, or `undefined` when it cannot log one in.
 *
 * A provider with neither an interactive key login nor an OAuth login is left out rather
 * than offered and then failing. The current credential decides first (`isUsingOAuth`
 * and `isUsingSubscription` answer that, and a subscription is the more specific of the
 * two), and only then do the provider's declared methods decide: a key when one is on
 * offer, and OAuth when a subscription is the only way in.
 */
export function loginType(facts: ProviderFacts): AuthType | undefined {
  if (facts.usingSubscription) {
    return "oauth";
  }
  if (facts.usingOAuth) {
    return "oauth";
  }
  if (facts.keyLogin) {
    return "api_key";
  }
  if (facts.subscriptionLogin) {
    return "oauth";
  }
  return undefined;
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
export function providerEntries(runtime: LoginRuntime): ProviderEntry[] {
  const entries: ProviderEntry[] = [];
  for (const provider of runtime.getProviders()) {
    const entry = providerEntry({
      id: provider.id,
      name: provider.name,
      keyLogin: typeof provider.auth.apiKey?.login === "function",
      subscriptionLogin: provider.auth.oauth !== undefined,
      usingOAuth: runtime.isUsingOAuth(provider.id),
      usingSubscription: runtime.isUsingSubscription(provider.id),
      configured: runtime.hasConfiguredAuth(provider.id),
    });
    if (entry !== undefined) {
      entries.push(entry);
    }
  }
  return entries.sort((left, right) => left.label.localeCompare(right.label));
}

/* ------------------------------------------------------------------ *
 * The pure wording of the four endings
 * ------------------------------------------------------------------ */

/**
 * The sentences that need no provider to be written, one per refusal or ending.
 *
 * Each is the whole message of a refusal, so they are kept together for a test to assert
 * rather than restate. `ownerInstance` is the refusal that matters most: with the owner's
 * own pi selected there is no profile PiCode owns, so there is nowhere to log in to.
 */
export const LOGIN_TEXTS = {
  ownerInstance:
    "El pi que ejecuta el editor es el tuyo, y PiCode no tiene un perfil propio donde guardar " +
    "credenciales. Cambia la fila «Qué pi se ejecuta» al pi propio de PiCode y vuelve a intentarlo.",
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
 * The profile is named because it is the fact that makes the login meaningful — the
 * credential is in PiCode's own profile and nowhere else — and because the running agent
 * was built at startup from a possibly different directory.
 */
export function loginSuccessText(provider: string, profile: string): string {
  return (
    `Credenciales de ${provider} guardadas en el perfil propio de PiCode (${profile}). ` +
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

/* ------------------------------------------------------------------ *
 * Loading the runtime for the target profile
 * ------------------------------------------------------------------ */

/** What loading the SDK produced: a runtime, or the reason it could not be built. */
export type LoginRuntimeLoad =
  | { kind: "ready"; runtime: LoginRuntime }
  | { kind: "no-sdk" }
  | { kind: "unreadable" };

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
    quickPick.items = entries.map((entry) => ({
      entry,
      label: entry.label,
      description: entry.description,
      detail: entry.detail,
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
 * The command: logs one provider in, writing into PiCode's own profile.
 *
 * The target is resolved first and the flow stops there when the selected instance is the
 * owner's own, because PiCode owns no profile and may not write the owner's. Everything
 * after that works on that one directory: the runtime is built over its files, the list
 * comes from that runtime, and the credential goes back through that same runtime.
 *
 * Nothing here performs a login by itself; `runtime.login` is pi's own flow, and the
 * interaction pi asks for is the editor's dialogs, so there is one set of prompts.
 */
export async function loginProvider(context: vscode.ExtensionContext): Promise<void> {
  // The unguarded writer's answer for the selected instance: PiCode's own profile when
  // PiCode's own pi is selected, `undefined` when the owner's pi is. Passing the selected
  // mode is what makes that `undefined` real; the guarded readers' answer is deliberately
  // not consulted, because on an empty internal profile it names the machine's profile,
  // which is exactly the directory this login must never write.
  const runtimeMode = resolveRuntime(context.extensionUri).mode;
  const target = instanceAgentDir(context.extensionUri, runtimeMode);
  if (target === undefined) {
    void vscode.window.showErrorMessage(`PiCode: ${LOGIN_TEXTS.ownerInstance}`);
    return;
  }

  const entry = resolveSdkEntry(context.extensionUri);
  if (entry === undefined) {
    void vscode.window.showErrorMessage(`PiCode: ${LOGIN_TEXTS.noSdk}`);
    return;
  }

  const load = await loadLoginRuntime(entry, target);
  if (load.kind === "no-sdk") {
    void vscode.window.showErrorMessage(`PiCode: ${LOGIN_TEXTS.noSdk}`);
    return;
  }
  if (load.kind === "unreadable") {
    void vscode.window.showErrorMessage(`PiCode: ${LOGIN_TEXTS.noCatalogue}`);
    return;
  }
  const runtime = load.runtime;
  if (typeof runtime.login !== "function") {
    void vscode.window.showErrorMessage(`PiCode: ${LOGIN_TEXTS.noSdk}`);
    return;
  }

  const entries = providerEntries(runtime);
  if (entries.length === 0) {
    void vscode.window.showInformationMessage(`PiCode: ${LOGIN_TEXTS.noProviders}`);
    return;
  }

  const chosen = await chooseProvider(entries);
  if (chosen === undefined) {
    return;
  }

  try {
    await runtime.login(chosen.id, chosen.type, createAuthInteraction());
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
    void vscode.window.showErrorMessage(
      `PiCode: ${loginFailureText(chosen.label, asErrorMessage(error))}`,
    );
    return;
  }

  // The credential is in the profile's `auth.json`, but the running agent was built at
  // startup and keeps the runtime it was built with, so the reload is what makes it use
  // the new credential. It is offered rather than promised.
  const choice = await vscode.window.showInformationMessage(
    `PiCode: ${loginSuccessText(chosen.label, target)}`,
    RELOAD_WINDOW_LABEL,
  );
  if (choice === RELOAD_WINDOW_LABEL) {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
