import * as path from "node:path";
import * as vscode from "vscode";
import { AjustesView } from "./ajustes-view";
import { loadImageTools, type ImageTools } from "./attachments";
import { ChatView, type ChatViewHost } from "./chat-view";
import {
  GENTLE_PANEL_TARGET,
  installSources,
  resolveCategoryTarget,
  showCatalogSearch,
  showInstalledPackages,
  showPiMenu,
  updateExtensions,
  type PiCategoryId,
  type PiMenuDeps,
  type PiMenuSnapshot,
  type ProviderSummary,
  type GentleActions,
} from "./menu";
import {
  GENTLE_SOURCES,
  OnboardingView,
  type OnboardingResult,
  type OnboardingTarget,
} from "./onboarding";
import { parseInstalledPackages, runPiCli, runExecutable } from "./pi-cli";
import { setPiVersionStateSource, type PiSettingValue } from "./pi-settings";
import {
  formatBytes,
  listSessions,
  parseSession,
  projectSessionsDir,
  readSession,
  sessionsRoot,
  type SessionSummary,
} from "./sessions";
import { GentleView, type GentleRunId } from "./gentle-view";
import { SettingsView } from "./settings-view";
import { discoverSkills, installedPackagesLister } from "./skills";
import {
  buildUpdateReport,
  firstMeaningfulLine,
  gentleCommands,
  parseReviewMode,
  readInstalledPackageVersion,
  resolveGentleBinary,
  summarizeGentle,
  unknownGentleState,
  GENTLE_LAYER_PACKAGES,
  GENTLE_PACKAGE,
  type GentleState,
  type GentleUpdateReport,
} from "./gentle";
import { resolveLatestVersions } from "./catalog";
import { PiRpcClient } from "./pi-rpc-client";
import { PiSdkClient } from "./pi-sdk-client";
import type { PiClient } from "./pi-client";
import type { PiModel, PiSlashCommand, PiThinkingLevel } from "./protocol";
import {
  buildPiUpdateReport,
  chooseBackend,
  describeRuntime,
  installManagedRuntime,
  latestPublishedVersion,
  managedInstalled,
  readPin,
  readTransport,
  resolveOnPath,
  resolveRuntime,
  resolveSdkEntry,
  type PiTransport,
  type PiUpdateReport,
  type ResolvedRuntime,
  type RuntimeDescriptor,
  type RuntimeMode,
} from "./runtime";
import {
  countMcpServers,
  describeEnvironment,
  parseBranch,
  type EnvironmentStats,
} from "./stats";
import { instanceProfile, instanceProfileEnv } from "./instance";
import { IMPORT_PROFILE_COMMAND, importProfileIntoInstance } from "./instance-import-command";
import { resolveAgentDir } from "./transcription";

let client: PiClient | undefined;
let view: ChatView | undefined;
/** The directory the agent runs in, which is also the project its sessions belong to. */
let agentCwd: string | undefined;
let ajustesView: AjustesView | undefined;
let gentleView: GentleView | undefined;
let settingsView: SettingsView | undefined;
let onboardingView: OnboardingView | undefined;
let outputChannel: vscode.OutputChannel | undefined;
/** pi's image helpers, cached per SDK entry: importing an ESM package is not free. */
let attachmentToolsEntry: string | undefined;
let attachmentToolsPromise: Promise<ImageTools | undefined> | undefined;

/**
 * The editor settings the panel's own behaviour depends on.
 *
 * A write to one of these has to reach the panel without a window reload, so this is the
 * whole list the configuration listener below reacts to. `picode.pi.*` is deliberately
 * absent: `runtime`, `executablePath`, `transport` and `extraArgs` decide which pi runs,
 * and switching the running pi is the job of the selectRuntime and selectTransport
 * commands, which restart the process. A configuration listener must not restart pi
 * behind the owner's back.
 */
const PANEL_SETTINGS: readonly string[] = [
  "picode.context.attach",
  "picode.panel.reasoning",
  "picode.media.ffmpegPath",
  "picode.media.transcription",
];

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("PiCode");
  context.subscriptions.push(outputChannel);

  // The settings tab's version row shows a fact only this side can read — the version
  // PiCode's own pi is on and the one the registry publishes — so the row is handed that
  // reading once here, and it renders what the last check found from then on.
  setPiVersionStateSource(() => managedPiCheck?.report.message);

  view = ChatView.create(context.extensionUri, {
    ensureClient: () => ensureClient(context.extensionUri),
    applyModel: (modelId, provider) =>
      withLiveClient((rpc) => applyModel(rpc, modelId, provider)),
    applyThinkingLevel: (level) => withLiveClient((rpc) => applyThinkingLevel(rpc, level)),
    restart: () => resetClient(),
    // The panel's `/` dropdown draws the list the popup's menu already draws, read from
    // the same bound client and shared through the same short-lived cache.
    commands: async () => (view?.bound ? readCommands(view.bound) : []),
    // The same two the popup's session picker uses: the panel's empty state offers the
    // project's previous conversations, so both surfaces read and load one list.
    recentSessions: () => listProjectSessions(),
    resumeSession: (session) => resumeSession(session),
    environment: () => readEnvironment(),
    imageTools: () => attachmentTools(context.extensionUri),
    // The view reports host-side failures that must not interrupt the transcript;
    // the shared channel already exists here, so one is not created for it.
    ...(outputChannel ? { output: outputChannel } : {}),
  } satisfies ChatViewHost);

  // One Gentle AI port for every surface that touches it. The popup's category and the
  // sidebar panel both read the state and run the actions through this object, so a
  // second copy of either cannot appear on one surface and not the other.
  const gentle = gentleActions(context);

  // pi's configuration lives in popup menus, reached from the status bar icon and
  // from a button on the chat view's title. Package management is the one surface
  // that talks to the pi CLI rather than to the RPC protocol, and it always talks
  // to the active runtime's CLI.
  const menu: PiMenuDeps = {
    runtime: () => resolveRuntime(context.extensionUri),
    profileEnv: () => piProfileEnv(context.extensionUri, resolveRuntime(context.extensionUri)),
    snapshot: () => menuSnapshot(context.extensionUri),
    providers: () => listProviders(),
    selectModel: () => withLiveClient(selectModel),
    selectThinkingLevel: () => withLiveClient(selectThinkingLevel),
    selectRuntime: () => selectRuntime(context),
    selectTransport: () => selectTransport(context),
    installManagedRuntime: () => installManagedFromMenu(context),
    sendCommand: (name) => sendSlashCommand(name),
    sessions: () => listProjectSessions(),
    resumeSession: (session) => resumeSession(session),
    gentle,
    newSession: () => startNewSession(),
    abort: () => abortRun(),
    restart: () => resetClient(),
    log: (line) => outputChannel?.appendLine(`[pi] ${line}`),
    offerRestart: (what) => offerRestart(what),
  };

  // The icon on the left opens this panel, because the editor decides that a
  // container shows a sidebar. The card is a shortcut into the settings tab, which
  // is where configuration now happens.
  const settings = SettingsView.create(context.extensionUri, {
    resolveEntry: () => resolveSdkEntry(context.extensionUri),
    cwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    models: async () => {
      const client = view?.bound;
      return client ? client.getAvailableModels().catch(() => []) : [];
    },
    // The skills the settings tab lists, discovered from the same runtime the chat
    // runs and pi's own agent directory. It is scope-aware because the caller hands
    // it that scope's `packages` value: a package filter is what turns a skill on or
    // off, so the two scopes can show different states for the same skill.
    skills: async (packages) => {
      const runtime = resolveRuntime(context.extensionUri);
      return discoverSkills({
        agentDir: resolveAgentDir(),
        cwd: agentCwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        listPackages: installedPackagesLister(runtime, piProfileEnv(context.extensionUri, runtime)),
        packageEntries: packages,
      });
    },
    // PiCode's own settings are the editor's, not pi's: they are read and written
    // through the configuration API, and always globally.
    picode: () => ({
      get: (key: string) => {
        const value = vscode.workspace.getConfiguration("picode.pi").get<unknown>(key);
        return typeof value === "string" || typeof value === "boolean" ? value : undefined;
      },
      set: async (key: string, value: unknown) => {
        await vscode.workspace
          .getConfiguration("picode.pi")
          .update(key, value, vscode.ConfigurationTarget.Global);
      },
    }),
    // A catalogue row installs through the menu's own path, so the confirmation and
    // the restart offer are the ones the packages table and the wizard already use.
    install: (sources) => installSources(menu, sources),
    applied: (key, value) => applyWrittenSetting(key, value),
  });
  settingsView = settings;

  const ajustes = AjustesView.create(context.extensionUri, {
    snapshot: () => menuSnapshot(context.extensionUri),
    // The sidebar's ids and the settings rail's ids are two different id spaces, so the
    // translation happens here, at the one boundary that receives a sidebar id: a
    // sidebar category is mapped to where it lives, and anything else passes through.
    openSettings: async (category?: PiCategoryId) => {
      const target = resolveCategoryTarget(category);
      if (target === GENTLE_PANEL_TARGET) {
        // `gentle` is not a settings category: it reveals the Gentle AI container.
        await vscode.commands.executeCommand(target);
        return;
      }
      await showSettingsTab(context.extensionUri, target);
    },
  });
  ajustesView = ajustes;

  // Gentle AI's own container: the same state builder and the same runner the menu
  // above uses, so the panel is a second way to see and switch the same thing. The
  // restart is injected rather than routed through `runAction` because it is the
  // editor's own operation, not a gentle-ai subcommand: the panel's button and the
  // chat toolbar's end in this one `resetClient`.
  const gentlePanel = GentleView.create(context.extensionUri, {
    gentle,
    runAction: (id: GentleRunId, command?: string) =>
      runGentleAction(menu, gentle, id, command),
    restart: async () => {
      await resetClient();
      // The panel re-reads its state as soon as this returns, and the reading it would
      // otherwise get is the cached one that says the commands are missing. Dropping it
      // here is what makes the button visibly do something.
      invalidateGentle();
    },
    update: () => gentleUpdate(context.extensionUri),
  });
  gentleView = gentlePanel;

  // The initial-setup wizard. Every question it asks delegates to a function the rest
  // of the editor already uses: the runtime switch `selectRuntime` applies, the Gentle
  // AI state the popup and the panel share, and the package install the packages table
  // runs. That is what keeps the wizard from being a second configuration surface that
  // drifts from the first.
  const onboarding = OnboardingView.create(context.extensionUri, {
    runtime: () => describeRuntime(context.extensionUri),
    configuredPath: () =>
      vscode.workspace.getConfiguration("picode.pi").get<string>("executablePath", "pi"),
    applyRuntime: async (mode, customPath) =>
      applyRuntimeMode(context, mode, {
        customPath,
        current: await describeRuntime(context.extensionUri),
      }),
    gentle: () => gentleState(context.extensionUri),
    installGentle: () => installGentleLayer(menu),
    complete: async () => {
      // `globalState.update` answers with a Thenable, and the panel may want to finish
      // only once the marker is written; awaiting it here keeps the promise shape.
      await context.globalState.update(ONBOARDING_KEY, true);
    },
    open: (target) => openOnboardingTarget(context.extensionUri, target),
  });
  onboardingView = onboarding;

  context.subscriptions.push(
    // `retainContextWhenHidden` keeps the webview alive while the sidebar is
    // collapsed, so a visible transcript is not thrown away by hiding it.
    vscode.window.registerWebviewViewProvider(ChatView.viewId, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(AjustesView.viewId, ajustes, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(GentleView.viewId, gentlePanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("picode.piChat.menu", () => showPiMenu(menu)),
    vscode.commands.registerCommand("picode.piChat.settings", async () => {
      await showSettingsTab(context.extensionUri);
    }),
    // The settings tab's version row runs this. It is not offered in the palette: the row
    // is where the fact it acts on is stated, so it is where the action belongs.
    vscode.commands.registerCommand("picode.piChat.updatePi", async () => {
      await updateManagedPi(context);
    }),
    vscode.commands.registerCommand("picode.piChat.menu.installed", () =>
      showInstalledPackages(menu),
    ),
    vscode.commands.registerCommand("picode.piChat.menu.search", () => showCatalogSearch(menu)),
    vscode.commands.registerCommand("picode.piChat.menu.update", () => updateExtensions(menu)),
    vscode.commands.registerCommand("picode.piChat.open", async () => {
      await revealChatView();
    }),
    vscode.commands.registerCommand("picode.piChat.selectRuntime", async () => {
      await selectRuntime(context);
    }),
    // Repeatable on purpose: the same wizard, opened from the palette, is how the
    // runtime is changed or Gentle AI switched on later without any reinstall.
    vscode.commands.registerCommand("picode.piChat.onboarding", async () => {
      await onboardingView?.show();
    }),
    vscode.commands.registerCommand("picode.piChat.selectTransport", async () => {
      await selectTransport(context);
    }),
    vscode.commands.registerCommand("picode.piChat.selectModel", async () => {
      await withLiveClient(selectModel);
    }),
    vscode.commands.registerCommand("picode.piChat.selectThinkingLevel", async () => {
      await withLiveClient(selectThinkingLevel);
    }),
    vscode.commands.registerCommand("picode.piChat.newSession", () => startNewSession()),
    vscode.commands.registerCommand("picode.piChat.abort", () => abortRun()),
    vscode.commands.registerCommand("picode.piChat.restart", async () => {
      await resetClient();
    }),
    // The panel seeds its context toggle and its reasoning disposition when the view is
    // created, so a write made outside the panel's own surfaces -- the settings file,
    // the Settings editor -- would otherwise keep the panel on the activation-time value
    // until the window reloaded. One listener covers the whole `picode` section, and
    // only the keys the panel actually reads move it.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("picode")) {
        return;
      }
      const changed = PANEL_SETTINGS.filter((key) => event.affectsConfiguration(key));
      if (changed.length === 0) {
        return;
      }
      view?.applyConfiguration(changed);
    }),
  );

  // The one-shot import from the machine's own profile. Registered on its own so the
  // block above — which every other command shares — is not touched by this feature.
  context.subscriptions.push(
    vscode.commands.registerCommand(IMPORT_PROFILE_COMMAND, () =>
      importProfileIntoInstance(context),
    ),
  );

  // First run. Deliberately not awaited: the resolution probes a process, and
  // activation must not wait on I/O to finish. The wizard opens only when there is no
  // usable pi and it was never completed, so it never lands on a working setup.
  void maybeOpenOnboarding(context);
}

export function deactivate(): void {
  view?.dispose();
  view = undefined;
  ajustesView?.dispose();
  ajustesView = undefined;
  gentleView?.dispose();
  gentleView = undefined;
  settingsView?.dispose();
  settingsView = undefined;
  onboardingView?.dispose();
  onboardingView = undefined;
  client?.stop();
  client = undefined;
}

/**
 * Reveals the chat view. `<viewId>.focus` is registered by the editor for every
 * contributed view; the container command is the documented fallback and is also
 * what shows the secondary side bar when it is hidden.
 */
async function revealChatView(): Promise<void> {
  try {
    await vscode.commands.executeCommand(`${ChatView.viewId}.focus`);
  } catch {
    await vscode.commands.executeCommand(`workbench.view.extension.${ChatView.containerId}`);
  }
}

/**
 * Returns a started client, or undefined when pi cannot be started. Used by the
 * view when it resolves, so the process exists exactly while there is a surface
 * asking for it.
 */
async function ensureClient(extensionUri: vscode.Uri): Promise<PiClient | undefined> {
  const rpc = getClient(extensionUri);
  return (await ensureStarted(rpc)) ? rpc : undefined;
}

/**
 * Drops the client so the next request spawns from the current configuration.
 * The client holds the executable it was created with, so switching the runtime
 * and restarting the process are the same operation.
 */
async function resetClient(): Promise<void> {
  client?.stop();
  client = undefined;
  // A different pi is a different set of loaded commands, so the cached list must not
  // outlive the process it was read from.
  invalidateCommands();

  // Only restart the process if the view is open: starting pi is a consequence
  // of opening the container, never of a stray command.
  if (view?.isVisible) {
    await view.rebind();
  }
}

/**
 * Pushes a setting the owner just wrote to the pi that is running.
 *
 * pi reads its settings when it starts and keeps them in memory, so a write from the
 * options tab reaches the file but not the process. Two groups cannot wait for a
 * restart: the default model, which decides what a new session starts with, and the
 * two settings that pick which pi runs at all — those are read once, at process
 * start, so applying them *is* a restart. Everything else is left alone: pi will
 * read it when it next needs it.
 */
async function applyWrittenSetting(key: string, value: PiSettingValue): Promise<void> {
  if (key === "picode.runtime" || key === "picode.transport") {
    await resetClient();
    return;
  }
  if (key !== "defaultModel") {
    return;
  }

  const rpc = view?.bound;
  if (rpc === undefined || typeof value !== "string" || value.trim() === "") {
    // Cleared, or nothing is running: the panel still re-reads so it stops
    // claiming a model the settings no longer name.
    await view?.refreshState();
    return;
  }

  try {
    await rpc.setModel(value);
    outputChannel?.appendLine(`[pi] modelo por defecto aplicado a la sesión: ${value}`);
  } catch (error) {
    reportCommandFailure(`aplicar el modelo por defecto "${value}"`, error);
  }
  await view?.refreshState();
}

/**
 * Re-applies the configured default model to a session that just started.
 *
 * `newSession` makes pi resolve the model from its own settings, which it may hold
 * stale in memory. Re-applying what the options tab wrote is what makes "the new
 * session starts with the default" true without a restart.
 */
async function reapplyDefaultModel(rpc: PiClient): Promise<void> {
  const model = await settingsView?.defaultModel();
  if (model === undefined) {
    return;
  }
  try {
    await rpc.setModel(model);
    outputChannel?.appendLine(`[pi] modelo por defecto re-aplicado: ${model}`);
  } catch (error) {
    reportCommandFailure(`aplicar el modelo por defecto "${model}"`, error);
  }
}

/**
 * The values the popup and the sidebar panel show.
 *
 * Every one is best-effort: both surfaces are useful with no session running and
 * nothing installed, and a value that cannot be read says so rather than lying.
 * The package count comes from the CLI, so it is cached briefly instead of
 * spawning a process for every navigation step inside the menu.
 */
async function menuSnapshot(extensionUri: vscode.Uri): Promise<PiMenuSnapshot> {
  const runtime = await describeRuntime(extensionUri);
  const version = runtime.version ? ` ${runtime.version}` : "";
  const label =
    runtime.mode === "managed"
      ? `pi propio de PiCode${version}`
      : runtime.mode === "custom"
        ? `ejecutable propio${version}`
        : `pi del PATH${version}`;

  const client = view?.bound;
  const state = client ? await client.getState().catch(() => undefined) : undefined;
  const installed = await countInstalled(extensionUri);

  let providerCount: number | undefined;
  let commands: PiSlashCommand[] = [];
  if (client) {
    providerCount = await client
      .getAvailableModels()
      .then(countProviders)
      .catch(() => undefined);
    commands = await readCommands(client);
  }

  return {
    runtime: label,
    runtimeAvailable: runtime.available,
    transport: summarizeTransport(),
    embeddedAvailable: runtime.embeddedAvailable,
    managedInstalled: runtime.managedInstalled,
    streaming: state?.isStreaming === true,
    ...(state?.model ? { model: state.model.name ?? state.model.id } : {}),
    ...(state?.thinkingLevel ? { reasoning: state.thinkingLevel } : {}),
    ...(state?.messageCount === undefined ? {} : { messageCount: state.messageCount }),
    ...(installed === undefined ? {} : { installedCount: installed }),
    ...(providerCount === undefined ? {} : { providerCount }),
    ...(commands.length > 0 ? { commands } : {}),
    ...(view ? { usage: view.usage } : {}),
    ...(view?.modelContextWindow === undefined ? {} : { contextWindow: view.modelContextWindow }),
    gentle: await gentleState(extensionUri),
  };
}

function countProviders(models: readonly { provider?: string }[]): number {
  const names = new Set<string>();
  for (const model of models) {
    if (model.provider) {
      names.add(model.provider);
    }
  }
  return names.size;
}

const INSTALLED_COUNT_TTL_MS = 15_000;
let installedCountCache: { value: number | undefined; at: number } | undefined;

/** Called after a change, so the next read reflects it. */
function invalidateInstalledCount(): void {
  installedCountCache = undefined;
}

/**
 * The environment additions that point a spawned pi at the selected instance's profile.
 *
 * The decision itself is `instanceProfileEnv()`'s, in `instance.ts`, and it stays there:
 * this only composes the two halves — which profile this runtime selects, and what a
 * spawner does with it — because six call sites would otherwise repeat the composition
 * and one of them would eventually get it wrong. `runtime` is passed rather than resolved
 * here, so the profile cannot follow a different program than the one being spawned.
 */
function piProfileEnv(extensionUri: vscode.Uri, runtime: ResolvedRuntime): Record<string, string> {
  return instanceProfileEnv(instanceProfile(extensionUri, runtime.mode));
}

/** How many packages pi reports, or undefined when the CLI cannot answer. */
async function countInstalled(extensionUri: vscode.Uri): Promise<number | undefined> {
  const now = Date.now();
  if (installedCountCache && now - installedCountCache.at < INSTALLED_COUNT_TTL_MS) {
    return installedCountCache.value;
  }

  let value: number | undefined;
  try {
    const runtime = resolveRuntime(extensionUri);
    const result = await runPiCli(runtime, ["list"], undefined, () => {}, piProfileEnv(extensionUri, runtime));
    value = parseInstalledPackages(result.text).length;
  } catch {
    value = undefined;
  }
  installedCountCache = { value, at: now };
  return value;
}

const COMMANDS_TTL_MS = 15_000;
let commandsCache: { value: PiSlashCommand[]; at: number } | undefined;

/** Called when the answer can have changed, so the next read asks again. */
function invalidateCommands(): void {
  commandsCache = undefined;
}

/**
 * The commands pi has loaded: extensions, prompt templates and skills.
 *
 * Three surfaces draw the same list — the popup's menu, the Gentle AI section and the
 * chat panel's `/` dropdown — and all three ask the same process, so the answer is kept
 * briefly and shared: the panel opening is not a reason for a second round trip.
 *
 * A read that fails is an empty list. The list is context around a command the owner is
 * writing, not a session failure, and the caller decides what an empty list means.
 */
async function readCommands(client: PiClient): Promise<PiSlashCommand[]> {
  const now = Date.now();
  if (commandsCache && now - commandsCache.at < COMMANDS_TTL_MS) {
    return commandsCache.value;
  }
  const value = await client.getCommands().catch(() => [] as PiSlashCommand[]);
  commandsCache = { value, at: now };
  return value;
}

/** The providers that have models configured, read from the live session. */
async function listProviders(): Promise<ProviderSummary[]> {
  const client = view?.bound;
  if (!client) {
    return [];
  }

  const models = await client.getAvailableModels().catch(() => []);
  const counts = new Map<string, number>();
  for (const model of models) {
    const name = model.provider ?? "otros";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, models: count }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Starts a fresh conversation, opening the panel first if pi is not running. */
async function startNewSession(): Promise<void> {
  await withLiveClient(async (rpc) => {
    await rpc.newSession();
    await reapplyDefaultModel(rpc);
    view?.notifySessionReset();
    await view?.refreshState();
  }, "iniciar una sesión nueva");
}

async function abortRun(): Promise<void> {
  if (!client?.isRunning) {
    void vscode.window.showInformationMessage(
      "PiCode: no hay ningún proceso de pi en ejecución.",
    );
    return;
  }
  try {
    await client.abort();
  } catch (error) {
    reportCommandFailure("detener la ejecución actual", error);
  }
}

/**
 * Installs the pinned runtime into the distribution.
 *
 * Shared by the runtime picker and by the popup's Runtime category, so the
 * confirmation and the progress reporting exist once.
 */
async function installManaged(
  context: vscode.ExtensionContext,
  current: RuntimeDescriptor,
  version?: string,
): Promise<ManagedInstallOutcome> {
  const outcome = await runManagedInstall(context, current, version);
  // The picker reports a failed install the way it reports its other failures. The
  // settings tab's version row does not come through here: it has a banner of its own.
  if (!outcome.ok && !outcome.declined) {
    void vscode.window.showErrorMessage(`PiCode: ${outcome.message}`);
  }
  return outcome;
}

/** What an install attempt did, whichever surface asked for it. */
interface ManagedInstallOutcome {
  ok: boolean;
  /** True when the owner answered "no" to the confirmation, so nothing failed. */
  declined: boolean;
  message: string;
  /** The version that ended up recorded, when the install succeeded. */
  version?: string;
}

/**
 * Confirms, installs, and reports nothing: the caller owns how a failure is shown.
 *
 * `version` installs a published version other than the one the record holds, which is how
 * the settings tab moves the managed pi forward. The confirmation names that version, so
 * the owner approves the version that will actually be installed.
 */
async function runManagedInstall(
  context: vscode.ExtensionContext,
  current: RuntimeDescriptor,
  version?: string,
): Promise<ManagedInstallOutcome> {
  const target = version ?? current.pin.version;
  const answer = await vscode.window.showWarningMessage(
    `PiCode va a instalar ${current.pin.package}@${target} en ${current.managedRoot}. ` +
      "Descarga unos cientos de megabytes. Tu pi global no se toca.",
    { modal: true },
    "Instalar",
  );
  if (answer !== "Instalar") {
    return { ok: false, declined: true, message: "Cancelaste la instalación." };
  }

  outputChannel?.show(true);
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `PiCode: instalando pi ${target}`,
    },
    () =>
      installManagedRuntime(
        context.extensionUri,
        (line) => outputChannel?.appendLine(`[runtime] ${line}`),
        target,
      ),
  );
  if (!result.ok) {
    return { ok: false, declined: false, message: result.message };
  }
  outputChannel?.appendLine(`[runtime] ${result.message}`);
  return {
    ok: true,
    declined: false,
    message: result.message,
    ...(result.version ? { version: result.version } : {}),
  };
}

/** The Runtime category's install row: installs PiCode's own pi and switches to it. */
async function installManagedFromMenu(context: vscode.ExtensionContext): Promise<void> {
  const current = await describeRuntime(context.extensionUri);
  // The same applier the picker and the wizard use: choosing the managed runtime and
  // installing it because it is missing are one operation, not two code paths.
  const applied = await applyRuntimeMode(context, "managed", { current });
  if (!applied.ok) {
    // `installManaged` already reported the failure it saw; a second message for the
    // same event would only repeat it.
    return;
  }
}

/**
 * What the settings tab's version row shows, and when it was read.
 *
 * The row's value is a fact about this installation — the version the record holds, and
 * whether the bundle is actually there — joined with an answer from the registry, so the
 * host reads it and keeps it: the webview is painted from the values `readAll` hands it in
 * one synchronous pass, and a registry round trip cannot happen inside that pass.
 */
let managedPiCheck: { report: PiUpdateReport; at: number } | undefined;

/**
 * How long a version check is reused.
 *
 * The registry is asked when the settings tab is opened, never on a repaint, and the answer
 * changes on the order of days; a second visit inside this window reuses it instead of
 * asking again. The update action does not use the cache: it asks again, because that is
 * the moment the answer decides what gets installed.
 */
const MANAGED_PI_CHECK_TTL_MS = 5 * 60 * 1000;

/**
 * Reads the record and the registry's latest, and keeps them for the row to read.
 *
 * Never rejects: a record that cannot be read, or a registry that cannot be reached, leaves
 * the row with no line rather than with a wrong one, and the tab still opens.
 */
async function refreshManagedPiCheck(extensionUri: vscode.Uri): Promise<void> {
  const now = Date.now();
  if (managedPiCheck !== undefined && now - managedPiCheck.at < MANAGED_PI_CHECK_TTL_MS) {
    return;
  }

  try {
    const pin = readPin(extensionUri);
    const report = buildPiUpdateReport({
      installed: pin.version,
      managedInstalled: managedInstalled(extensionUri, pin),
      latest: await latestPublishedVersion(pin),
    });
    managedPiCheck = { report, at: Date.now() };
    outputChannel?.appendLine(
      `[runtime] pi propio ${report.installed} · última publicada ${report.latest ?? "desconocida"}`,
    );
  } catch (error) {
    outputChannel?.appendLine(
      `[runtime] no se pudo leer la versión del pi propio: ${toErrorMessage(error)}`,
    );
  }
}

/**
 * Opens the settings tab, with the version row's fact read before it paints.
 *
 * Every entry point to the tab goes through here: the panel renders the values the host
 * pushed in one pass, so a check started after that pass would only reach the owner on the
 * next repaint — and this row exists to state its fact *before* he decides anything.
 */
async function showSettingsTab(extensionUri: vscode.Uri, startAt?: string): Promise<void> {
  await refreshManagedPiCheck(extensionUri);
  await settingsView?.show(startAt);
}

/**
 * Moves PiCode's own pi to the latest published version, from the settings tab's row.
 *
 * The four steps the row promises: ask the registry, install through the one installer the
 * runtime picker uses, record what landed, and restart pi so the new version is the one
 * running. A failure is thrown, and the tab shows it in the banner it already uses for a
 * failed write — a silent no-op here would leave the owner believing an updated pi is
 * running. Declining the confirmation is not a failure and is not reported as one.
 */
async function updateManagedPi(context: vscode.ExtensionContext): Promise<void> {
  const extensionUri = context.extensionUri;

  let current: RuntimeDescriptor;
  try {
    current = await describeRuntime(extensionUri);
  } catch (error) {
    throw new Error(
      `No se pudo leer qué versión de pi está anotada: ${toErrorMessage(error)}`,
    );
  }
  const pin = current.pin;

  const latest = await latestPublishedVersion(pin);
  if (latest === undefined) {
    throw new Error(
      "No se pudo averiguar cuál es la última versión publicada de pi: el registro npm no respondió.",
    );
  }

  if (current.managedInstalled && latest === pin.version) {
    void vscode.window.showInformationMessage(
      `PiCode: el pi propio ya está en la última versión publicada (${latest}).`,
    );
    return;
  }

  const outcome = await runManagedInstall(context, current, latest);
  if (!outcome.ok) {
    if (outcome.declined) {
      return;
    }
    throw new Error(`No se pudo actualizar el pi de PiCode: ${outcome.message}`);
  }

  const installed = outcome.version ?? latest;
  // The record just changed, so the row's reading of it did too. Seeding the cache with
  // the check this command already made keeps that from costing a second registry call.
  managedPiCheck = {
    report: buildPiUpdateReport({ installed, managedInstalled: true, latest }),
    at: Date.now(),
  };
  outputChannel?.appendLine(`[runtime] pi propio actualizado a ${installed}.`);

  await resetClient();
  // The panel repaints only when the host pushes a new state, and this click came from it:
  // reopening the tab is that push, and it is what makes the row show the new version.
  await showSettingsTab(extensionUri);
  void vscode.window.showInformationMessage(
    `PiCode: el pi propio está ahora en la versión ${installed}.`,
  );
}

/**
 * The key that records that the wizard ran to completion.
 *
 * `globalState` rather than a settings entry: it is a fact about this installation,
 * not a preference, and it must not appear in the settings tab as something to edit.
 */
const ONBOARDING_KEY = "picode.onboarding.completed";

/**
 * Opens the initial-setup wizard once, on a machine that cannot run pi yet.
 *
 * The condition is the runtime resolution the rest of the editor already uses — mode,
 * executable and version probe — not a new check: "no usable pi" means
 * `describeRuntime` found no executable, or found one that does not answer. It never
 * opens when the wizard was already completed, and never when a pi resolves, so a
 * working setup is never interrupted.
 *
 * Called without `await` from `activate`: the probe spawns a process, and activation
 * must stay free of I/O.
 */
async function maybeOpenOnboarding(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(ONBOARDING_KEY) === true) {
    return;
  }

  let runtime: RuntimeDescriptor;
  try {
    runtime = await describeRuntime(context.extensionUri);
  } catch (error) {
    outputChannel?.appendLine(
      `[onboarding] no se pudo resolver el runtime: ${toErrorMessage(error)}`,
    );
    return;
  }

  if (runtime.available && runtime.version !== undefined) {
    return;
  }

  outputChannel?.appendLine(
    "[onboarding] no hay un pi utilizable y la configuración inicial no se completó: se abre el asistente",
  );
  await onboardingView?.show();
}

/**
 * Installs both halves of the Gentle AI layer from the wizard.
 *
 * It goes through `installSources`, the same function the packages table's install rows
 * use, so the confirmation, the per-package progress and the restart offer are the ones
 * that already exist. The wizard only differs in naming both commands in one dialog and
 * in showing the outcome inside its panel.
 */
async function installGentleLayer(deps: PiMenuDeps): Promise<OnboardingResult> {
  const outcome = await installSources(deps, GENTLE_SOURCES);
  if (outcome.ok) {
    invalidateGentle();
  }
  return { ok: outcome.ok, message: outcome.message };
}

/** Sends the wizard's closing summary to the surface it names. */
async function openOnboardingTarget(
  extensionUri: vscode.Uri,
  target: OnboardingTarget,
): Promise<void> {
  switch (target) {
    case "chat":
      await revealChatView();
      break;
    case "settings":
      await showSettingsTab(extensionUri);
      break;
    case "gentle":
      await vscode.commands.executeCommand(GENTLE_PANEL_TARGET);
      break;
  }
}

/**
 * pi loads its packages when it starts, so an install or a removal only takes
 * effect after a restart. The owner's conversation lives in that process, which
 * is why this asks instead of restarting on its own.
 */
async function offerRestart(what: string): Promise<void> {
  invalidateInstalledCount();
  const choice = await vscode.window.showInformationMessage(
    `PiCode: ${what}. pi carga las extensiones al arrancar, así que hay que reiniciarlo para que surta efecto.`,
    "Reiniciar ahora",
  );
  if (choice === "Reiniciar ahora") {
    await resetClient();
  }
}

/**
 * Lets the owner choose which pi runs, and installs PiCode's own pi on selection
 * when it is not there yet.
 *
 * The choice is written to global user settings rather than to workspace state,
 * because it describes the machine's runtimes, not the project's.
 */
async function selectRuntime(context: vscode.ExtensionContext): Promise<void> {
  let current: RuntimeDescriptor;
  try {
    current = await describeRuntime(context.extensionUri);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `PiCode: no se pudo leer el runtime de pi. ${toErrorMessage(error)}`,
    );
    return;
  }

  const configuration = vscode.workspace.getConfiguration("picode.pi");
  const customPath = configuration.get<string>("executablePath", "pi");
  const active = (version: string | undefined): string =>
    version ? `activo ahora \u00b7 ${version}` : "activo ahora";

  interface RuntimeChoice extends vscode.QuickPickItem {
    mode: RuntimeMode;
  }

  const choices: RuntimeChoice[] = [
    {
      mode: "path",
      label: "$(terminal) El pi de tu PATH",
      description: current.mode === "path" ? active(current.version) : "",
      detail: "Tu instalación propia. Cambia cuando actualices pi.",
    },
    {
      mode: "managed",
      label: "$(package) El pi propio de PiCode",
      description:
        current.mode === "managed" ? active(current.version) : `fijado ${current.pin.version}`,
      detail: current.managedInstalled
        ? `Instalado en ${current.managedRoot}, aislado de tu pi global.`
        : "Se instala en la carpeta de PiCode al elegirlo, así la versión es reproducible y tu pi global no se toca.",
    },
    {
      mode: "custom",
      label: "$(file-directory) Un ejecutable concreto",
      description: current.mode === "custom" ? customPath : "",
      detail: "Usa picode.pi.executablePath tal cual está escrito.",
    },
  ];

  const picked = await vscode.window.showQuickPick(choices, {
    title: "PiCode: ¿qué pi debe ejecutarse?",
    placeHolder: summarizeRuntime(current),
  });
  if (!picked) {
    return;
  }

  let chosenPath: string | undefined;
  if (picked.mode === "custom") {
    const entered = await vscode.window.showInputBox({
      title: "PiCode: ruta del ejecutable de pi",
      value: customPath,
      prompt: "Una ruta absoluta, o un nombre que se resuelva en el PATH.",
    });
    if (entered === undefined) {
      return;
    }
    // The empty string is a real answer: it means "go back to the bare name", which is
    // why the choice carries the raw text and the shared applier decides the fallback.
    chosenPath = entered;
  }

  const applied = await applyRuntimeMode(context, picked.mode, {
    customPath: chosenPath,
    current,
  });
  if (!applied.ok) {
    void vscode.window.showErrorMessage(`PiCode: ${applied.message}`);
    return;
  }

  void vscode.window.showInformationMessage(`PiCode: usando ${RUNTIME_LABELS[picked.mode]}.`);
}

/**
 * Applies a chosen pi runtime: writes the mode, installs PiCode's own pi when the
 * choice needs one that is not there, and rebinds the client.
 *
 * Extracted from the runtime picker so the initial-setup wizard applies a choice the
 * same way. There is one place that decides what switching pi costs, which is the
 * point: a wizard with its own runtime logic would be a second definition of the
 * setting, free to drift from the picker that shows it.
 *
 * The result is returned rather than announced because the two callers report
 * differently — the picker in a notification, the wizard inside its own panel.
 */
async function applyRuntimeMode(
  context: vscode.ExtensionContext,
  mode: RuntimeMode,
  choice: { customPath?: string; current: RuntimeDescriptor },
): Promise<OnboardingResult> {
  const configuration = vscode.workspace.getConfiguration("picode.pi");

  if (mode === "custom") {
    const entered = choice.customPath?.trim() ?? "";
    await configuration.update(
      "executablePath",
      entered.length > 0 ? entered : "pi",
      vscode.ConfigurationTarget.Global,
    );
  }

  if (mode === "managed" && !choice.current.managedInstalled) {
    const installed = await installManaged(context, choice.current);
    if (!installed.ok) {
      return {
        ok: false,
        message: "No se instaló el pi propio de PiCode, así que el runtime no cambió.",
      };
    }
  }

  await configuration.update("runtime", mode, vscode.ConfigurationTarget.Global);
  await resetClient();
  outputChannel?.appendLine(`[runtime] mode is now "${mode}".`);
  return { ok: true, message: `Ahora PiCode ejecuta ${RUNTIME_LABELS[mode]}.` };
}

/**
 * Lets the owner choose how PiCode talks to pi.
 *
 * Its own question, not a fourth entry in the runtime picker: the runtime says
 * which pi, this says how PiCode reaches it, and the two are independent. The
 * embedded choice is only offered when the active pi publishes an entry to
 * import, because an option that cannot run reads as a bug in the setting.
 */
async function selectTransport(context: vscode.ExtensionContext): Promise<void> {
  const current = await describeRuntime(context.extensionUri);
  const active = readTransport();

  interface TransportChoice extends vscode.QuickPickItem {
    transport: PiTransport;
  }

  const choices: TransportChoice[] = [
    {
      transport: "rpc",
      label: "$(terminal) RPC: pi como proceso aparte",
      description: active === "rpc" ? "activo ahora" : "",
      detail:
        "Arranca `pi --mode rpc` y habla con él por JSON en stdio. Es lo que PiCode ha usado siempre.",
    },
    {
      transport: "embedded",
      label: "$(vm) Embebido: pi dentro del editor",
      description:
        active === "embedded"
          ? "activo ahora"
          : current.embeddedAvailable
            ? ""
            : "no disponible",
      detail: current.embeddedAvailable
        ? "Carga el mismo pi con su SDK, sin proceso hijo. Las extensiones de pi pueden dibujar su propia interfaz. `picode.pi.extraArgs` no se aplica."
        : `El pi activo (${current.display}) no publica una entrada que el SDK pueda importar.`,
    },
  ];

  const picked = await vscode.window.showQuickPick(choices, {
    title: "PiCode: ¿cómo debe hablar con pi?",
    placeHolder: active === "embedded" ? "Ahora: embebido" : "Ahora: RPC",
  });
  if (!picked) {
    return;
  }

  if (picked.transport === "embedded" && !current.embeddedAvailable) {
    void vscode.window.showInformationMessage(
      `PiCode: el transporte embebido no puede ejecutarse porque ${current.display} no publica una entrada del SDK.`,
    );
    return;
  }

  await vscode.workspace
    .getConfiguration("picode.pi")
    .update("transport", picked.transport, vscode.ConfigurationTarget.Global);
  await resetClient();
  outputChannel?.appendLine(`[pi] transport is now "${picked.transport}".`);
  void vscode.window.showInformationMessage(
    `PiCode: hablando con pi por ${picked.transport === "rpc" ? "RPC" : "transporte embebido"}.`,
  );
}

/** How each runtime mode is named in the interface. */
const RUNTIME_LABELS: Record<RuntimeMode, string> = {
  path: "el pi de tu PATH",
  managed: "el pi propio de PiCode",
  custom: "un ejecutable concreto",
};

const GENTLE_TTL_MS = 20_000;
let gentleCache: { value: GentleState; at: number } | undefined;

function invalidateGentle(): void {
  gentleCache = undefined;
}

/**
 * How long the registry's answer about the layer is reused.
 *
 * Longer than the state's own cache because it is not about this machine at all: a
 * published version changes on the order of days, the panel repaints on every action,
 * and every repaint would otherwise be two requests to the registry.
 */
const GENTLE_UPDATE_TTL_MS = 5 * 60 * 1000;
let gentleUpdateCache: { value: GentleUpdateReport; at: number } | undefined;

function invalidateGentleUpdate(): void {
  gentleUpdateCache = undefined;
}

/**
 * What each package of the Gentle AI layer is installed as, and what the registry
 * publishes as its latest.
 *
 * Two independent readings, joined by the pure report builder: `pi list` says where each
 * package lives (it prints no version, so the version is read from the package's own
 * manifest) and the registry's `/latest` says what exists. Either one failing is a state
 * the panel states out loud rather than a silent "no update".
 *
 * Cached, because a repaint is not a reason to ask the registry anything, and dropped
 * by the update action so the panel re-reads a version it just replaced.
 */
async function gentleUpdate(extensionUri: vscode.Uri): Promise<GentleUpdateReport> {
  const now = Date.now();
  if (gentleUpdateCache && now - gentleUpdateCache.at < GENTLE_UPDATE_TTL_MS) {
    return gentleUpdateCache.value;
  }

  const installed = new Map<string, string | undefined>();
  try {
    const runtime = resolveRuntime(extensionUri);
    const listed = await runPiCli(runtime, ["list"], undefined, (): void => {}, piProfileEnv(extensionUri, runtime));
    const packages = parseInstalledPackages(listed.text);
    for (const name of GENTLE_LAYER_PACKAGES) {
      const entry = packages.find((item) => item.source === `npm:${name}`);
      installed.set(
        name,
        entry?.path === undefined ? undefined : readInstalledPackageVersion(entry.path),
      );
    }
  } catch {
    // A listing that cannot be read leaves every installed version unknown, which the
    // panel reports as an incomplete check.
  }

  let latest = new Map<string, string | undefined>();
  try {
    latest = await resolveLatestVersions(GENTLE_LAYER_PACKAGES);
  } catch {
    // The resolver answers per package rather than throwing; this only catches the
    // impossible case, and leaves every published version unknown when it happens.
  }

  const report = buildUpdateReport(
    GENTLE_LAYER_PACKAGES.map((name) => ({
      name,
      installed: installed.get(name),
      latest: latest.get(name),
    })),
  );
  gentleUpdateCache = { value: report, at: now };
  outputChannel?.appendLine(
    `[gentle] versiones ${report.packages
      .map((pair) => `${pair.name} ${pair.installed ?? "?"} -> ${pair.latest ?? "?"}`)
      .join(", ")}`,
  );
  return report;
}

/**
 * What PiCode can tell about Gentle AI.
 *
 * There is no API that says whether it is active, but there is something better than
 * a guess: the running session's own command list. Only a loaded gentle-pi registers
 * its commands, so a package that is installed and not loaded is a different state,
 * and it is reported as one instead of being shown as working.
 *
 * Cached because it costs several processes to answer.
 */
async function gentleState(extensionUri: vscode.Uri): Promise<GentleState> {
  const now = Date.now();
  if (gentleCache && now - gentleCache.at < GENTLE_TTL_MS) {
    return gentleCache.value;
  }

  const state = unknownGentleState();
  const silent = (): void => {};

  try {
    const runtime = resolveRuntime(extensionUri);
    const listed = await runPiCli(runtime, ["list"], undefined, silent, piProfileEnv(extensionUri, runtime));
    const entry = parseInstalledPackages(listed.text).find(
      (item) => item.source === `npm:${GENTLE_PACKAGE}`,
    );
    state.installed = entry !== undefined;
    if (entry?.path) {
      state.packageRoot = entry.path;
    }
    state.binary = resolveGentleBinary(entry?.path);
  } catch {
    // A listing that cannot be read leaves the state unknown, which the label says.
  }

  const client = view?.bound;
  if (client) {
    const commands = await readCommands(client);
    const gentle = gentleCommands(commands);
    state.commandCount = gentle.length;
    state.commands = gentle.map((command) =>
      command.name.startsWith("/") ? command.name : `/${command.name}`,
    );
    state.active = gentle.length > 0;
  }

  if (state.binary) {
    const version = await runExecutable(state.binary, ["version"], {
      shell: false,
      onOutput: silent,
    });
    state.version = firstMeaningfulLine(version.text, "");

    const review = await runExecutable(state.binary, ["review", "mode", "status"], {
      shell: false,
      onOutput: silent,
    });
    state.review = parseReviewMode(review.text);

    const telemetry = await runExecutable(state.binary, ["telemetry", "status"], {
      shell: false,
      onOutput: silent,
    });
    state.telemetry = firstMeaningfulLine(telemetry.text, "desconocido");
  }

  gentleCache = { value: state, at: now };
  // The channel is where a diagnostic belongs, and it is also the only observable
  // trace that PiCode read Gentle AI's real state rather than guessing.
  outputChannel?.appendLine(`[gentle] ${summarizeGentle(state)}`);
  return state;
}

/** Everything the popup needs to act on Gentle AI. */
function gentleActions(context: vscode.ExtensionContext): GentleActions {
  const log = (line: string): void => outputChannel?.appendLine(`[gentle] ${line}`);

  /** Runs a gentle-ai subcommand and reports what it said. */
  const run = async (args: readonly string[], title: string): Promise<string> => {
    const current = await gentleState(context.extensionUri);
    if (!current.binary) {
      void vscode.window.showErrorMessage(
        "PiCode: no se encontró el binario gentle-ai. Instala gentle-pi o ponlo en el PATH.",
      );
      return "";
    }

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title },
      () =>
        runExecutable(current.binary as string, args, {
          shell: false,
          onOutput: log,
        }),
    );

    void vscode.window.showInformationMessage(title, {
      modal: true,
      detail: result.text.trim() || "gentle-ai no devolvió nada.",
    });
    invalidateGentle();
    return result.text;
  };

  return {
    state: () => gentleState(context.extensionUri),
    run,

    setReview: async (on: boolean) => {
      await run(["review", "mode", on ? "enable" : "disable"], "PiCode: revisión por candidato");
    },

    telemetry: async (action: "enable" | "disable" | "preview") => {
      await run(["telemetry", action], "PiCode: telemetría de Gentle AI");
    },

    install: async () => {
      const answer = await vscode.window.showWarningMessage(
        `¿Instalar ${GENTLE_PACKAGE} en pi?`,
        {
          modal: true,
          detail: `Se instalará con "pi install npm:${GENTLE_PACKAGE}". Los paquetes de pi ejecutan código con acceso completo al sistema.`,
        },
        "Instalar",
      );
      if (answer !== "Instalar") {
        return;
      }

      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `PiCode: instalando ${GENTLE_PACKAGE}` },
        () => {
          const runtime = resolveRuntime(context.extensionUri);
          return runPiCli(
            runtime,
            ["install", `npm:${GENTLE_PACKAGE}`],
            undefined,
            log,
            piProfileEnv(context.extensionUri, runtime),
          );
        },
      );
      if (!result.ok) {
        void vscode.window.showErrorMessage(
          `PiCode: pi install terminó con código ${result.code ?? "desconocido"}.`,
        );
        return;
      }
      invalidateGentle();
      offerRestart(`${GENTLE_PACKAGE} quedó instalado`);
    },
  };
}

/**
 * Runs one of the Gentle AI panel's requests.
 *
 * The panel draws buttons, not popup rows, so the ids are its own; every case still
 * ends in the same `GentleActions` method the popup's Gentle AI category calls (and,
 * for a command, in the same sender its command rows use). That is what keeps the two
 * surfaces one implementation rather than two.
 */
async function runGentleAction(
  deps: PiMenuDeps,
  gentle: GentleActions,
  id: GentleRunId,
  command?: string,
): Promise<void> {
  switch (id) {
    case "install":
      await gentle.install();
      break;
    case "update":
      await updateGentleLayer(deps);
      break;
    case "review": {
      const state = await gentle.state();
      await gentle.setReview(state.review.rdd !== "on");
      break;
    }
    case "restart":
      // The panel draws this row under the missing-commands line, and its click is
      // handled before it reaches here; the case exists so the id has one meaning on
      // both sides of the host boundary.
      await deps.restart();
      break;
    case "telemetry-enable":
      await gentle.telemetry("enable");
      break;
    case "telemetry-disable":
      await gentle.telemetry("disable");
      break;
    case "telemetry-preview":
      await gentle.telemetry("preview");
      break;
    case "sdd-status":
      await gentle.run(["sdd-status"], "PiCode: ODD");
      break;
    case "doctor":
      await gentle.run(["doctor"], "PiCode: diagnóstico de Gentle AI");
      break;
    case "command":
      // The panel only offers commands pi itself registered, but the id alone would be
      // nothing to send: an action without its command is ignored, not guessed.
      if (command !== undefined && command.length > 0) {
        await sendSlashCommand(command);
      }
      break;
  }
}

/**
 * Updates the Gentle AI layer.
 *
 * An update is an install of the newer spec and nothing else: this is `installSources`,
 * the same path the wizard and the catalogue rows use, which keeps the confirmation
 * that names the exact commands, the progress and the restart offer the owner already
 * knows. Both commands go in together because the layer is two packages, and updating
 * only the orchestrator would leave the memory provider behind.
 *
 * Both readings are dropped afterwards so the panel re-reads what is now installed
 * instead of showing the version the install just replaced.
 */
async function updateGentleLayer(deps: PiMenuDeps): Promise<void> {
  await installSources(deps, GENTLE_SOURCES);
  invalidateGentle();
  invalidateGentleUpdate();
}

/**
 * Sends a slash command to the running session.
 *
 * pi runs a command when it receives a message that starts with it, so this is a prompt
 * rather than a separate protocol call: there is no "invoke command" command, and
 * inventing one would be a second, divergent path for the same thing.
 */
async function sendSlashCommand(name: string): Promise<void> {
  await withLiveClient(async (rpc) => {
    await rpc.prompt(name, rpc.isStreaming ? { streamingBehavior: "steer" } : undefined);
  }, `enviar ${name}`);
}

/**
 * pi's own image helpers, for preparing attachments.
 *
 * Loaded once and cached per SDK entry: the entry is an ESM module import, and
 * paying for it on every message would be waste. A failure is logged and reported
 * as `undefined` rather than thrown, because attachments are an addition to the
 * panel: a pi that cannot prepare them must not stop the panel from working.
 */
function attachmentTools(extensionUri: vscode.Uri): Promise<ImageTools | undefined> {
  const entry = resolveSdkEntry(extensionUri);
  if (entry === undefined) {
    outputChannel?.appendLine(
      "[pi] no hay entrada del SDK: los adjuntos de imagen no están disponibles",
    );
    return Promise.resolve(undefined);
  }

  if (attachmentToolsPromise === undefined || attachmentToolsEntry !== entry) {
    attachmentToolsEntry = entry;
    attachmentToolsPromise = loadAttachmentTools(entry);
  }
  return attachmentToolsPromise;
}

async function loadAttachmentTools(entry: string): Promise<ImageTools | undefined> {
  try {
    return await loadImageTools(entry);
  } catch (error) {
    outputChannel?.appendLine(`[pi] adjuntos de imagen no disponibles: ${toErrorMessage(error)}`);
    return undefined;
  }
}

/**
 * The conversations pi has for this project.
 *
 * Read from disk because the protocol has no command that lists them: it can load a session
 * once its path is known, and finding the path is the part pi does not expose.
 */
async function listProjectSessions(): Promise<SessionSummary[]> {
  const extraArgs = vscode.workspace
    .getConfiguration("picode.pi")
    .get<string[]>("extraArgs", []);
  const directory = projectSessionsDir(agentCwd ?? process.cwd(), sessionsRoot(extraArgs));
  return directory === undefined ? [] : listSessions(directory);
}

/**
 * The figures that describe where the agent runs, for the panel's bottom strip.
 *
 * Best-effort by design: a missing config file, a folder outside a repository or a
 * git that is not installed each mean one figure is unknown, never that the panel
 * fails. The file read and the subprocess are not free, so the view caches the
 * result for the life of a bind instead of calling this on every reply.
 */
async function readEnvironment(): Promise<EnvironmentStats> {
  const cwd = agentCwd ?? process.cwd();

  // The MCP config lives next to pi's other configuration, and where that is is
  // already known in one place; reading it here keeps that knowledge there.
  let mcps: number | undefined;
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.file(path.join(resolveAgentDir(), "mcp.json")),
    );
    mcps = countMcpServers(Buffer.from(bytes).toString("utf8"));
  } catch {
    mcps = undefined;
  }

  return describeEnvironment({
    ...(mcps === undefined ? {} : { mcps }),
    sessions: (await listProjectSessions()).length,
    project: path.basename(cwd),
    ...(await currentBranch(cwd)),
  });
}

/**
 * The current git branch, or nothing when there is none to report.
 *
 * A repository-less folder, a missing git and a non-zero exit all land in the same
 * place: no branch. A detached HEAD is dropped by `parseBranch`, because `HEAD` is a
 * state and not a name to put where a branch belongs.
 */
async function currentBranch(cwd: string): Promise<{ branch?: string }> {
  const git = resolveOnPath("git");
  if (git === undefined) {
    return {};
  }

  const result = await runExecutable(git, ["rev-parse", "--abbrev-ref", "HEAD"], {
    shell: /\.(cmd|bat)$/i.test(git),
    cwd,
    onOutput: () => {},
  });
  if (!result.ok) {
    return {};
  }

  const branch = parseBranch(result.text);
  return branch === undefined ? {} : { branch };
}

/**
 * Loads a previous conversation into the running agent.
 *
 * The conversation is also read back from its own file and replayed into the panel, so the
 * owner sees the conversation pi now holds instead of an empty column. Reading is best
 * effort: a file that cannot be read or parsed falls back to saying so, because an empty
 * panel with no reason reads as a broken one.
 */
async function resumeSession(session: SessionSummary): Promise<void> {
  await withLiveClient(async (rpc) => {
    const result = await rpc.switchSession(session.file);
    if (result.cancelled === true) {
      void vscode.window.showInformationMessage(
        "PiCode: una extensión de pi canceló el cambio de sesión.",
      );
      return;
    }

    const label = session.name ?? session.title ?? session.stamp;
    outputChannel?.appendLine(`[pi] sesión cargada: ${session.file}`);

    try {
      const replay = parseSession(readSession(session.file));
      outputChannel?.appendLine(
        `[pi] historial cargado: ${session.file} ` +
          `(${replay.messages.length - replay.omitted} de ${replay.messages.length} mensajes)`,
      );
      await view?.notifyHistory(replay);
    } catch (error) {
      outputChannel?.appendLine(
        `[pi] no se pudo leer el historial de ${session.file}: ${toErrorMessage(error)}`,
      );
      view?.notifySessionSwitched(
        `Sesión cargada: ${label}. pi tiene la conversación y ${formatBytes(session.bytes)} de historial; el panel no lo reproduce, así que escribe para continuar.`,
      );
      await view?.refreshState();
    }
  }, "reanudar una sesión");
}

/**
 * Runs an interaction against the live client, revealing the view first when no
 * session is running yet: the model and reasoning pickers act on a session, not
 * on configuration, so there is nothing to offer until pi is up.
 */
async function withLiveClient(
  action: (rpc: PiClient) => Promise<void>,
  what = "cambiar los ajustes de la sesión",
): Promise<void> {
  const rpc = view?.bound;
  if (!rpc) {
    await revealChatView();
    return;
  }
  try {
    await action(rpc);
  } catch (error) {
    reportCommandFailure(what, error);
  }
}

/**
 * Model picker over `get_available_models`, grouped by provider.
 *
 * The provider is passed explicitly instead of the `provider/model-id` string the
 * client also accepts: it splits that form at the first slash, which is
 * unambiguous for every provider observed but loses information if a model id
 * itself contains a slash.
 */
async function selectModel(rpc: PiClient): Promise<void> {
  const [models, state] = await Promise.all([rpc.getAvailableModels(), rpc.getState()]);
  if (models.length === 0) {
    void vscode.window.showInformationMessage("PiCode: pi no informó de ningún modelo configurado.");
    return;
  }

  interface ModelItem extends vscode.QuickPickItem {
    model: PiModel;
  }

  const current = state.model;
  const sorted = [...models].sort((left, right) => {
    const byProvider = (left.provider ?? "").localeCompare(right.provider ?? "");
    return byProvider !== 0
      ? byProvider
      : (left.name ?? left.id).localeCompare(right.name ?? right.id);
  });

  const items: Array<ModelItem | vscode.QuickPickItem> = [];
  let provider: string | undefined;
  for (const model of sorted) {
    if (model.provider !== provider) {
      provider = model.provider;
      items.push({ label: provider ?? "otros", kind: vscode.QuickPickItemKind.Separator });
    }

    const traits = [
      model.reasoning ? "razonamiento" : undefined,
      typeof model.contextWindow === "number"
        ? `${Math.round(model.contextWindow / 1000)}k de contexto`
        : undefined,
    ].filter((trait): trait is string => trait !== undefined);

    items.push({
      model,
      label: model.name ?? model.id,
      description: traits.join(" \u00b7 "),
      detail: model.id,
      picked: current?.id === model.id,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "PiCode: modelo",
    placeHolder: current ? `Actual: ${current.id}` : "Elige un modelo",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked || !("model" in picked)) {
    return;
  }

  await applyModel(rpc, picked.model.id, picked.model.provider);
}

/**
 * Reasoning-level picker.
 *
 * The choices come from `get_available_thinking_levels` and not from the full
 * enum, because pi rejects a level the current model does not support: `xhigh`
 * and `max` only exist for some models.
 */
async function selectThinkingLevel(rpc: PiClient): Promise<void> {
  const [levels, state] = await Promise.all([
    rpc.getAvailableThinkingLevels(),
    rpc.getState(),
  ]);

  if (levels.length === 0) {
    void vscode.window.showInformationMessage(
      "PiCode: pi no informó de niveles de razonamiento para el modelo actual.",
    );
    return;
  }

  interface LevelItem extends vscode.QuickPickItem {
    level: PiThinkingLevel;
  }

  const current = state.thinkingLevel;
  const items: LevelItem[] = levels.map((level) => ({
    level,
    label: level,
    description: level === current ? "actual" : "",
    picked: level === current,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: "PiCode: nivel de razonamiento",
    placeHolder: current ? `Actual: ${current}` : "Elige un nivel de razonamiento",
  });
  if (!picked) {
    return;
  }

  await applyThinkingLevel(rpc, picked.level);
}

/**
 * Applies a model to the live session. Shared by the panel's dropdown and the
 * palette command, so both paths report and log identically.
 */
async function applyModel(rpc: PiClient, modelId: string, provider?: string): Promise<void> {
  const applied = await rpc.setModel(modelId, provider);
  outputChannel?.appendLine(`[pi] model is now ${applied.provider ?? "?"}/${applied.id}.`);
}

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly PiThinkingLevel[];

/**
 * Guards the level before it reaches the protocol. The value crosses the webview
 * boundary as a string, and pi rejects a level the current model does not support,
 * so an unvalidated value would surface as a protocol failure instead of a bug
 * here.
 */
function isThinkingLevel(value: string): value is PiThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Applies a reasoning level to the live session. */
async function applyThinkingLevel(rpc: PiClient, level: string): Promise<void> {
  if (!isThinkingLevel(level)) {
    throw new Error(`"${level}" no es un nivel de razonamiento que pi acepte.`);
  }
  await rpc.setThinkingLevel(level);
  outputChannel?.appendLine(`[pi] reasoning level is now ${level}.`);
}

/** One line describing the active runtime, for pickers and messages. */
function summarizeRuntime(runtime: RuntimeDescriptor): string {
  const version = runtime.version ? ` ${runtime.version}` : "";
  if (runtime.mode === "managed") {
    return `pi propio de PiCode${version}${runtime.available ? "" : " (sin instalar)"}`;
  }
  if (runtime.mode === "custom") {
    return `Ejecutable propio${version}: ${runtime.display}`;
  }
  return `pi del PATH${version}${runtime.available ? "" : " (no encontrado)"}`;
}

/** One line describing the transport, for the popup and the sidebar panel. */
function summarizeTransport(): string {
  return readTransport() === "embedded" ? "embebido (en el editor)" : "RPC (proceso aparte)";
}

/**
 * Creates the client on first use so activation stays cheap; configuration is
 * read here, not at activation time. The transport decides which backend runs;
 * the runtime decides which pi that backend loads.
 */
function getClient(extensionUri: vscode.Uri): PiClient {
  if (client) {
    return client;
  }

  const configuration = vscode.workspace.getConfiguration("picode.pi");
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  // Recorded because the session files are filed under the agent's working directory, and
  // listing another one would report "no sessions" for a project that has them.
  agentCwd = cwd ?? process.cwd();

  const choice = chooseBackend(extensionUri);
  if (choice.unavailable !== undefined) {
    outputChannel?.appendLine(`[pi] transporte embebido no disponible: ${choice.unavailable}`);
    void vscode.window.showWarningMessage(
      `PiCode: no se puede usar el transporte embebido. ${choice.unavailable} Se usará RPC.`,
    );
  }

  if (choice.transport === "embedded" && choice.sdkEntry !== undefined) {
    // The embedded backend reads pi's own flags from configuration; a command-line
    // argument has no meaning without a command line, so ignoring it silently would
    // leave the owner believing a setting took effect.
    const extraArgs = configuration.get<string[]>("extraArgs", []);
    if (extraArgs.length > 0) {
      outputChannel?.appendLine(
        `[pi] picode.pi.extraArgs se ignora con el transporte embebido: ${extraArgs.join(" ")}`,
      );
      void vscode.window.showWarningMessage(
        `PiCode: picode.pi.extraArgs no se aplica al transporte embebido (${extraArgs.join(" ")}).`,
      );
    }

    client = new PiSdkClient({
      entry: choice.sdkEntry,
      ...(cwd ? { cwd } : {}),
      ...(outputChannel ? { output: outputChannel } : {}),
    });
    outputChannel?.appendLine(`[pi] starting embedded session from ${choice.sdkEntry}`);
    return client;
  }

  const runtime = resolveRuntime(extensionUri);
  client = new PiRpcClient({
    executablePath: runtime.executable,
    argsPrefix: runtime.argsPrefix,
    extraArgs: configuration.get<string[]>("extraArgs", []),
    env: piProfileEnv(extensionUri, runtime),
    ...(cwd ? { cwd } : {}),
    ...(outputChannel ? { output: outputChannel } : {}),
  });
  outputChannel?.appendLine(
    `[pi] starting from ${runtime.mode} runtime: ${runtime.display}`,
  );
  return client;
}

async function ensureStarted(rpc: PiClient): Promise<boolean> {
  try {
    await rpc.start();
  } catch (error) {
    const message = toErrorMessage(error);
    outputChannel?.appendLine(`[pi] ${message}`);
    void vscode.window
      .showErrorMessage(`PiCode: ${message}`, "Abrir la configuración")
      .then((choice) => {
        if (choice === "Abrir la configuración") {
          // The setting that explains a failure is the one that chose the backend,
          // so an embedded transport opens its own control instead of the runtime's.
          const setting =
            readTransport() === "embedded"
              ? "picode.pi.transport"
              : "picode.pi.executablePath";
          void vscode.commands.executeCommand("workbench.action.openSettings", setting);
        }
      });
    return false;
  }

  return true;
}

function reportCommandFailure(action: string, error: unknown): void {
  const message = toErrorMessage(error);
  outputChannel?.appendLine(`[pi] failed to ${action}: ${message}`);
  void vscode.window.showErrorMessage(`PiCode: no se pudo ${action}. ${message}`);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
