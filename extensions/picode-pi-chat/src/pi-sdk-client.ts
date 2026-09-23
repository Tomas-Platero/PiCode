import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type * as vscode from "vscode";
import type { AuthInteraction } from "./pi-ui-bridge";
import type { PiClient, PiSubscription } from "./pi-client";
import {
  toPiCommands,
  toPiEvent,
  toPiModel,
  toPiSessionState,
  type SdkSessionSnapshot,
} from "./pi-sdk-protocol";
import type {
  PiCycleModelData,
  PiEvent,
  PiModel,
  PiNewSessionData,
  PiPromptOptions,
  PiSessionState,
  PiSlashCommand,
  PiSwitchSessionData,
  PiThinkingLevel,
} from "./protocol";

/**
 * The slice of the pi SDK this client calls.
 *
 * pi is ESM-only and loaded at runtime through an absolute URL, so it cannot be
 * imported for typing: a static import would make the extension compile against
 * a package that may not be installed and pin these shapes to one pi version.
 * This interface is the contract instead — every member is one this file
 * actually uses, with the shapes verified against the installed `.d.ts` files.
 */
export interface SdkModule {
  createAgentSessionServices(options: SdkServicesOptions): Promise<SdkSessionServices>;
  createAgentSessionFromServices(options: SdkFromServicesOptions): Promise<SdkSessionResult>;
  SessionManager: SdkSessionManager;
  getAgentDir(): string;
  /**
   * The SDK's `ModelRuntime`, the class that owns one profile's `auth.json`.
   * Optional because an older pi entry need not export it; `login` is the only
   * caller and it refuses with a message the owner can read instead of failing
   * on a property of `undefined`.
   */
  ModelRuntime?: SdkModelRuntimeFactory;
}

/** The factory side of `ModelRuntime`: one runtime per profile directory. */
export interface SdkModelRuntimeFactory {
  create(options: SdkModelRuntimePaths): Promise<SdkModelRuntime>;
}

/**
 * The two files that decide which profile a runtime reads and writes.
 *
 * This is the exact pair `createAgentSessionServices` builds its own runtime
 * with (`authPath` and `modelsPath` under the profile), quoted here because the
 * SDK is ESM-only and loaded by URL, so it cannot be imported for typing.
 */
export interface SdkModelRuntimePaths {
  authPath: string;
  modelsPath: string;
}

export interface SdkServicesOptions {
  cwd: string;
  agentDir: string;
}

/**
 * Everything `createAgentSessionFromServices` needs, plus what this client reads.
 *
 * The composition matters: building the services registers the providers the
 * owner's extensions declare before a session is created, which is what lets the
 * session resolve its configured default model. `createAgentSession` on its own
 * does not (see the note inside `PiSdkClient.launch`).
 */
export interface SdkSessionServices {
  resourceLoader: SdkResourceLoader;
  /** Extension and package problems the SDK collected while loading resources. */
  diagnostics?: readonly SdkDiagnostic[];
}

export interface SdkDiagnostic {
  type: string;
  message: string;
}

export interface SdkFromServicesOptions {
  services: SdkSessionServices;
  /** Omitted for the first session; supplied when a new or existing one is loaded. */
  sessionManager?: SdkSessionManagerHandle;
}

/** What the loader reads back after a reload; only the counts and lists are used. */
export interface SdkResourceLoader {
  getExtensions(): { extensions: readonly unknown[] };
  getSkills(): { skills: readonly unknown[] };
  getPrompts(): { prompts: readonly unknown[] };
  getThemes(): { themes: readonly unknown[] };
}

export interface SdkSessionResult {
  session: SdkAgentSession;
}

/** A session-manager instance, opaque here: it is only ever handed back to the SDK. */
export type SdkSessionManagerHandle = object;

/** A model object as the SDK hands it over; `toPiModel` narrows it for the panel. */
export type SdkModelValue = object;

export interface SdkSessionManager {
  create(cwd: string): SdkSessionManagerHandle;
  open(path: string): SdkSessionManagerHandle;
}

/**
 * pi's `Provider`, reduced to the facts a provider list reads.
 *
 * Quoted rather than imported, like every other pi shape here: pi is ESM-only
 * and loaded by URL. `auth` names the two interactive logins, which is what
 * decides whether a provider can be logged in at all.
 */
export interface SdkProvider {
  readonly id: string;
  readonly name: string;
  readonly auth: SdkProviderAuth;
}

/** pi's `ProviderAuth`; a method that is not a function is not an interactive login. */
export interface SdkProviderAuth {
  apiKey?: { login?: unknown };
  oauth?: unknown;
}

export interface SdkModelRuntime {
  getModel(providerId: string, modelId: string): SdkModelValue | undefined;
  getAvailable(providerId?: string): Promise<readonly SdkModelValue[]>;
  /**
   * The providers this runtime's own profile has. It is the profile's answer and
   * not a table: a provider an extension installed in that profile registered is
   * in here, which is why the running session's runtime is what the login
   * command reads the catalogue from (see `PiSdkClient.sessionRuntime`).
   */
  getProviders(): readonly SdkProvider[];
  isUsingOAuth(providerId: string): boolean;
  isUsingSubscription(providerId: string): boolean;
  hasConfiguredAuth(providerId: string): boolean;
  /**
   * Persists a provider credential through the runtime's own store. The method
   * exists on every pi this client supports; the defensive check inside `login`
   * is what keeps an older entry from failing later with a vaguer error.
   */
  login(
    providerId: string,
    type: AuthType,
    interaction: AuthInteraction,
  ): Promise<SdkCredential>;
}

/** pi's `AuthType`; pi-ai owns the union (`dist/auth/types.d.ts`). */
export type AuthType = "api_key" | "oauth";

/** A stored credential; opaque here because pi owns its fields. */
export interface SdkCredential {
  type: AuthType;
  [key: string]: unknown;
}

export interface SdkExtensionRunner {
  getRegisteredCommands(): readonly unknown[];
}

/**
 * The `AgentSession` surface this client drives.
 *
 * Getters are optional so a defensive read never throws; the values themselves
 * stay `unknown` at the boundary because they arrive from a module loaded at
 * runtime, and `pi-sdk-protocol.ts` is where they get narrowed.
 */
export interface SdkAgentSession {
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
  /**
   * Extension errors are not part of the session event union: they arrive
   * through `ExtensionBindings.onError`, which is why the client binds them.
   */
  bindExtensions(bindings: { onError?: (error: unknown) => void }): Promise<void>;
  prompt(text: string, options?: PiPromptOptions): Promise<void>;
  abort(): Promise<void>;
  readonly model?: unknown;
  readonly thinkingLevel?: string;
  readonly isStreaming?: boolean;
  readonly isCompacting?: boolean;
  readonly sessionFile?: string;
  readonly sessionId?: string;
  readonly sessionName?: string;
  readonly messages?: readonly unknown[];
  readonly pendingMessageCount?: number;
  readonly autoCompactionEnabled?: boolean;
  readonly steeringMode?: string;
  readonly followUpMode?: string;
  readonly modelRuntime: SdkModelRuntime;
  readonly extensionRunner: SdkExtensionRunner;
  getAvailableThinkingLevels(): readonly unknown[];
  setThinkingLevel(level: PiThinkingLevel): void;
  /** The SDK's `ThinkingLevel`; narrowed by `asThinkingLevel` before use. */
  cycleThinkingLevel(): string | undefined;
  setModel(model: SdkModelValue): Promise<void>;
  cycleModel(): Promise<SdkCycleModelValue | undefined>;
}

/** The result of a model cycle, as the SDK hands it over. */
export interface SdkCycleModelValue {
  model?: unknown;
  thinkingLevel?: unknown;
  isScoped?: unknown;
}

export interface PiSdkClientOptions {
  /** Absolute path of the pi package's ESM entry (`dist/index.js`). */
  entry: string;
  /** Working directory for the agent. */
  cwd?: string;
  /** Global pi configuration directory. Omitted, pi resolves its own. */
  agentDir?: string;
  /**
   * Loads the SDK. Injected so the client can be exercised without a real pi;
   * production leaves it out and the entry is imported by URL.
   */
  load?: () => Promise<SdkModule>;
  /** Diagnostic sink; a VS Code OutputChannel named "PiCode" in production. */
  output?: vscode.OutputChannel;
}

/**
 * `import()` that survives this project's CommonJS output.
 *
 * TypeScript rewrites a literal dynamic import to `require()` when the module
 * target is CommonJS, and pi publishes its entry as ESM that `require()` cannot
 * load. Building the import at runtime keeps it a genuine dynamic `import()`.
 */
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<unknown>;

/**
 * Client for pi's SDK: loads the owner's own pi inside the host process and
 * drives one `AgentSession`, fanning its events out as wire events.
 */
export class PiSdkClient implements PiClient {
  private readonly options: PiSdkClientOptions;
  private readonly listeners = new Set<(event: PiEvent) => void>();

  private sdk: SdkModule | undefined;
  private session: SdkAgentSession | undefined;
  /** The loaded resources and model runtime, reused for every rebuilt session. */
  private services: SdkSessionServices | undefined;
  /** Detaches this session's listener; cleared with the session it belongs to. */
  private unsubscribe: (() => void) | undefined;
  /** In-flight launch, so concurrent `start()` callers share one load. */
  private starting: Promise<void> | undefined;

  constructor(options: PiSdkClientOptions) {
    this.options = options;
  }

  /** True while a run is in flight; mirrors the session's own flag. */
  get isStreaming(): boolean {
    return this.session?.isStreaming === true;
  }

  get isRunning(): boolean {
    return this.session !== undefined;
  }

  /**
   * The model runtime the running session was built with, or `undefined` while
   * there is no session.
   *
   * Read-only by design: it is the same object the session already owns, exposed
   * because a session is private to this file. It is the only honest source for
   * "which providers does the profile in force have", since a runtime built over
   * another profile answers for that profile instead — which is exactly the
   * poorer list this getter exists to stop. Nothing here builds, replaces or
   * reconfigures the runtime; the session is still built by `launch` and no
   * other way.
   */
  get sessionRuntime(): SdkModelRuntime | undefined {
    return this.session?.modelRuntime;
  }

  /** Subscribes to agent events. The returned handle removes the listener. */
  onEvent(listener: (event: PiEvent) => void): PiSubscription {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * Loads pi and builds the session. Idempotent: a second call while the session
   * is alive resolves immediately, and concurrent callers share one launch.
   *
   * The in-flight promise is what makes the second property true. `isRunning`
   * only becomes true once the session exists, which happens after several
   * awaits, so the check alone is a check-then-act: two callers arriving before
   * that point both pass it and each builds a session. Two sessions in one
   * window means two agents working the same workspace, which is worse than a
   * slow start.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }

    const attempt = this.launch();
    this.starting = attempt;
    try {
      await attempt;
    } finally {
      this.starting = undefined;
    }
  }

  prompt(text: string, options?: PiPromptOptions): Promise<void> {
    const session = this.requireSession();
    const images = options?.images;
    // The SDK's options are optional exactly like the RPC client's are: omitting
    // them while idle is the normal path, and a busy agent is told how to queue.
    // An empty object is not the same as no object to the SDK, so it is only
    // passed when it actually carries something.
    const sdkOptions: PiPromptOptions = {
      ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
      ...(images && images.length > 0 ? { images } : {}),
    };
    return session.prompt(
      text,
      sdkOptions.streamingBehavior !== undefined || sdkOptions.images !== undefined
        ? sdkOptions
        : undefined,
    );
  }

  async abort(): Promise<void> {
    await this.requireSession().abort();
  }

  /** Starts a fresh conversation with a brand new empty session. */
  async newSession(): Promise<PiNewSessionData> {
    await this.rebuild((sdk, cwd) => sdk.SessionManager.create(cwd));
    return { cancelled: false };
  }

  /** Loads an existing session file, which is how a conversation is resumed. */
  async switchSession(sessionPath: string): Promise<PiSwitchSessionData> {
    await this.rebuild((sdk) => sdk.SessionManager.open(sessionPath));
    return {};
  }

  async getState(): Promise<PiSessionState> {
    const session = this.requireSession();
    const snapshot: SdkSessionSnapshot = {
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
      sessionName: session.sessionName,
      messageCount: session.messages?.length,
      pendingMessageCount: session.pendingMessageCount,
      autoCompactionEnabled: session.autoCompactionEnabled,
      steeringMode: session.steeringMode,
      followUpMode: session.followUpMode,
    };
    return toPiSessionState(snapshot);
  }

  /**
   * Logs a provider in from inside the editor and persists its credential into
   * the profile named by `agentDir`.
   *
   * The ability is here because the RPC transport cannot do it: `/login` is
   * interactive-mode only and there is no login command in the RPC union, and
   * `setRuntimeApiKey` is an in-memory override pi does not persist
   * (`docs/sdk.md`), so a key set that way leaves the profile looking
   * credential-less on the next reload and PiCode's anti-mute guard keeps
   * saying the instance is not usable.
   *
   * `agentDir` is the profile this call **fills**, and it is required with no
   * default on purpose, so the compiler refuses an omission instead of letting a
   * future caller inherit the wrong profile by saying nothing. Callers pass the
   * **unguarded writer's answer** — `instanceAgentDir(extensionUri, "managed")`,
   * the same answer the import's package install uses. `selectedAgentDir()` is
   * for readers: it follows the anti-mute guard, which answers the machine's
   * profile while PiCode's own is still empty, and that empty profile is exactly
   * what a first login exists to fill. Defaulting to the client's read directory
   * would therefore write the owner's own `~/.pi/agent/auth.json` on the first
   * login — PiCode writing a profile it does not own, the one thing this feature
   * may never do.
   *
   * The write goes through a runtime whose `auth.json` is the target's.
   * `createAgentSessionServices({ agentDir })` builds its `ModelRuntime` with
   * `authPath: join(agentDir, "auth.json")`, and the session keeps that same
   * runtime, so the session's runtime owns one directory and no other. When the
   * target is that directory it is reused; when the two differ, a runtime is
   * built for the target the same way the SDK builds its own (see
   * `runtimeForLogin`). A credential written elsewhere is not live in this
   * session until the client is rebuilt — the same reload the import asks for.
   *
   * pi resolves once the provider's catalog and availability are locally
   * consistent. When the credential was committed but that synchronization
   * failed it rejects with pi's `CredentialSynchronizationError`; that error
   * still means the write happened, so its `providerId`, `operation` and
   * `credential` fields are there to inspect and the mutation must never be
   * retried blindly.
   */
  async login(
    providerId: string,
    type: AuthType,
    interaction: AuthInteraction,
    agentDir: string,
  ): Promise<SdkCredential> {
    const session = this.requireSession();
    const runtime = await this.runtimeForLogin(session, agentDir);
    if (typeof runtime.login !== "function") {
      throw new Error(
        "Este pi no sabe iniciar sesión desde el SDK. Actualiza el pi integrado.",
      );
    }
    return runtime.login(providerId, type, interaction);
  }

  async getAvailableModels(): Promise<PiModel[]> {
    const available = await this.requireSession().modelRuntime.getAvailable();
    const models: PiModel[] = [];
    for (const entry of available) {
      const model = toPiModel(entry);
      if (model) {
        models.push(model);
      }
    }
    return models;
  }

  /**
   * Switches model.
   *
   * With an explicit provider the two halves are unambiguous. Without one, the
   * reference is usually the id the picker reported — and ids can themselves
   * contain a slash (`deepseek/deepseek-v4-pro` on this machine), so the search
   * over what the runtime offers comes first and the `provider/model-id` split is
   * the fallback for a reference written the way pi's own `defaultModel` setting
   * documents it.
   */
  async setModel(modelRef: string, provider?: string): Promise<PiModel> {
    const session = this.requireSession();
    const runtime = session.modelRuntime;

    let resolved: SdkModelValue | undefined;
    if (provider !== undefined && provider.length > 0) {
      resolved =
        runtime.getModel(provider, modelRef) ??
        (await findAvailableModel(runtime, modelRef, provider));
    } else {
      resolved = await findAvailableModel(runtime, modelRef, undefined);
      if (resolved === undefined) {
        const reference = splitModelReference(modelRef);
        resolved = reference
          ? runtime.getModel(reference.provider, reference.modelId)
          : undefined;
      }
    }
    if (resolved === undefined) {
      throw new Error(
        `Model reference "${modelRef}" did not match any available model. ` +
          'Use "provider/model-id" (for example "anthropic/claude-sonnet-4").',
      );
    }

    const model = toPiModel(resolved);
    if (!model) {
      throw new Error(`The model for reference "${modelRef}" has no id.`);
    }
    await session.setModel(resolved);
    return model;
  }

  /**
   * Cycles to the next available model. The SDK answers `undefined` when only one
   * model is configured, which is not an error.
   */
  async cycleModel(): Promise<PiCycleModelData | null> {
    const result = await this.requireSession().cycleModel();
    if (!result) {
      return null;
    }

    const data: PiCycleModelData = { model: toPiModel(result.model) ?? null };
    const level = asThinkingLevel(result.thinkingLevel);
    if (level) {
      data.thinkingLevel = level;
    }
    if (typeof result.isScoped === "boolean") {
      data.isScoped = result.isScoped;
    }
    return data;
  }

  async getAvailableThinkingLevels(): Promise<PiThinkingLevel[]> {
    const session = this.requireSession();
    const levels: PiThinkingLevel[] = [];
    for (const level of session.getAvailableThinkingLevels()) {
      const narrowed = asThinkingLevel(level);
      if (narrowed) {
        levels.push(narrowed);
      }
    }
    return levels;
  }

  async setThinkingLevel(level: PiThinkingLevel): Promise<void> {
    this.requireSession().setThinkingLevel(level);
  }

  async cycleThinkingLevel(): Promise<PiThinkingLevel | null> {
    return asThinkingLevel(this.requireSession().cycleThinkingLevel());
  }

  /** Extension commands, prompt templates and skills, in one list. */
  async getCommands(): Promise<PiSlashCommand[]> {
    const session = this.requireSession();
    const loader = this.requireServices().resourceLoader;
    return toPiCommands({
      commands: session.extensionRunner.getRegisteredCommands(),
      skills: loader.getSkills().skills,
      prompts: loader.getPrompts().prompts,
    });
  }

  /** Releases the session and its listener. Idempotent. */
  stop(): void {
    this.releaseSession();
    this.sdk = undefined;
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private async launch(): Promise<void> {
    const sdk = await this.loadSdk();
    const cwd = this.options.cwd ?? process.cwd();
    const agentDir = this.options.agentDir ?? sdk.getAgentDir();

    // The services step is not ceremony: it loads the owner's extensions and
    // applies the providers they register to the model runtime *before* the
    // session is built. `createAgentSession` alone skips that, so a default model
    // served by an extension-registered provider is not found and the session
    // starts on pi's `unknown` placeholder — which then rejects every prompt with
    // "No API key found". Verified on this machine: the loader yields pending
    // registrations for `omni` and `nan`.
    const services = await sdk.createAgentSessionServices({ cwd, agentDir });
    const loader = services.resourceLoader;
    const { session } = await sdk.createAgentSessionFromServices({ services });

    this.sdk = sdk;
    await this.attach(session, services);

    // These counts are the only observable proof that the embedded path read the
    // owner's own configuration instead of starting from a bare session.
    this.log(
      `Loaded ${loader.getExtensions().extensions.length} extension(s), ` +
        `${loader.getSkills().skills.length} skill(s), ` +
        `${loader.getPrompts().prompts.length} prompt(s) and ` +
        `${loader.getThemes().themes.length} theme(s) from ${agentDir}.`,
    );
    for (const diagnostic of services.diagnostics ?? []) {
      this.log(`[${diagnostic.type}] ${diagnostic.message}`);
    }
    this.log(`pi SDK session started (${session.sessionId ?? "no id"}).`);
  }

  /** Builds a session with an explicit session manager, reusing the loaded services. */
  private async rebuild(
    createSessionManager: (sdk: SdkModule, cwd: string) => SdkSessionManagerHandle,
  ): Promise<void> {
    this.requireSession();
    const sdk = this.requireSdk();
    const services = this.requireServices();
    const cwd = this.options.cwd ?? process.cwd();

    const { session } = await sdk.createAgentSessionFromServices({
      services,
      sessionManager: createSessionManager(sdk, cwd),
    });
    await this.attach(session, services);
    this.log(`pi SDK session is now ${session.sessionId ?? "unknown"}.`);
  }

  /**
   * Adopts a session: subscribes first, then binds the error channel, then drops
   * whatever it replaces so no listener or session is ever left behind. The whole
   * services record is kept — it carries the model runtime that already has the
   * owner's providers registered, and rebuilds have to reuse it.
   */
  private async attach(session: SdkAgentSession, services: SdkSessionServices): Promise<void> {
    this.releaseSession();
    this.session = session;
    this.services = services;
    this.unsubscribe = session.subscribe((event) => this.forward(event));

    try {
      await session.bindExtensions({ onError: (error) => this.forwardExtensionError(error) });
    } catch (error) {
      this.log(`Could not bind extension error reporting: ${asErrorMessage(error)}`);
    }
  }

  /** Releases the session, its listener and its services. The SDK module stays loaded. */
  private releaseSession(): void {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch (error) {
        this.log(`Could not remove the event listener: ${asErrorMessage(error)}`);
      }
    }

    const session = this.session;
    this.session = undefined;
    this.services = undefined;
    if (session) {
      try {
        session.dispose();
      } catch (error) {
        this.log(`Could not dispose the session: ${asErrorMessage(error)}`);
      }
    }
  }

  private forward(event: unknown): void {
    const wire = toPiEvent(event);
    if (wire) {
      this.dispatch(wire);
    }
  }

  private forwardExtensionError(error: unknown): void {
    const record =
      typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
    const payload: Extract<PiEvent, { type: "extension_error" }> = {
      type: "extension_error",
      error: typeof record.error === "string" ? record.error : asErrorMessage(error),
    };
    if (typeof record.extensionPath === "string") {
      payload.extensionPath = record.extensionPath;
    }
    if (typeof record.event === "string") {
      payload.event = record.event;
    }
    this.dispatch(payload);
  }

  private dispatch(event: PiEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async loadSdk(): Promise<SdkModule> {
    const injected = this.options.load;
    if (injected) {
      return injected();
    }
    const loaded = await dynamicImport(pathToFileURL(this.options.entry).href);
    return loaded as SdkModule;
  }

  private requireSession(): SdkAgentSession {
    if (!this.session) {
      throw new Error("pi SDK session is not running.");
    }
    return this.session;
  }

  private requireServices(): SdkSessionServices {
    if (!this.services) {
      throw new Error("pi SDK session is not running.");
    }
    return this.services;
  }

  private requireSdk(): SdkModule {
    if (!this.sdk) {
      throw new Error("pi SDK is not loaded.");
    }
    return this.sdk;
  }

  /**
   * The runtime whose `auth.json` lives in `agentDir`.
   *
   * The session's runtime belongs to the directory the client was built with, so
   * it is the right one only when the target is that same directory; building a
   * second runtime over the same files would be a second writer of one profile.
   * For any other target the runtime is built the way the SDK builds its own, by
   * handing it the profile's two files, because that pair is what decides where a
   * credential is read and written.
   */
  private async runtimeForLogin(
    session: SdkAgentSession,
    agentDir: string,
  ): Promise<SdkModelRuntime> {
    if (isSameDirectory(this.ownAgentDir(), agentDir)) {
      return session.modelRuntime;
    }
    const factory = this.requireSdk().ModelRuntime;
    if (factory === undefined || typeof factory.create !== "function") {
      throw new Error(
        "Este pi no sabe escribir credenciales en el perfil de PiCode. Actualiza el pi integrado.",
      );
    }
    return factory.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
    });
  }

  /**
   * The profile directory this client was built with, whichever way it was
   * chosen (`options.agentDir`, or pi's own default).
   */
  private ownAgentDir(): string {
    return this.options.agentDir ?? this.requireSdk().getAgentDir();
  }

  private log(message: string): void {
    this.options.output?.appendLine(`[pi-sdk] ${message}`);
  }
}

/**
 * Whether two paths name the same profile directory.
 *
 * `login` uses this to decide whether the session's runtime already owns the
 * target's `auth.json`. A trailing separator or a `.` segment must not read as
 * "another profile", or the directory that is already the session's would get a
 * second runtime writing the same file. Case is deliberately not folded: both
 * values come from the same resolver on the same machine.
 */
export function isSameDirectory(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/** Splits a `provider/model-id` reference, or undefined when there is no such pair. */
function splitModelReference(
  modelRef: string,
): { provider: string; modelId: string } | undefined {
  const separator = modelRef.indexOf("/");
  if (separator <= 0 || separator === modelRef.length - 1) {
    return undefined;
  }
  return { provider: modelRef.slice(0, separator), modelId: modelRef.slice(separator + 1) };
}

/**
 * Finds a model the runtime offers by id. Several providers can serve the same
 * id, so an explicit provider is used to break the tie before falling back to
 * the first match.
 */
async function findAvailableModel(
  runtime: SdkModelRuntime,
  modelId: string,
  provider: string | undefined,
): Promise<SdkModelValue | undefined> {
  const available = await runtime.getAvailable();
  const matches = available.filter((entry) => toPiModel(entry)?.id === modelId);
  if (provider !== undefined) {
    const sameProvider = matches.find((entry) => toPiModel(entry)?.provider === provider);
    if (sameProvider) {
      return sameProvider;
    }
  }
  return matches[0];
}

/**
 * The SDK's `ThinkingLevel` is a subset of the protocol's, so a string is the
 * whole check and the cast only records that; anything else is dropped.
 */
function asThinkingLevel(value: unknown): PiThinkingLevel | null {
  return typeof value === "string" ? (value as PiThinkingLevel) : null;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
