import * as vscode from "vscode";
import { AjustesView } from "./ajustes-view";
import { loadImageTools, type ImageTools } from "./attachments";
import { ChatView, type ChatViewHost } from "./chat-view";
import {
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
import { parseInstalledPackages, runPiCli, runExecutable } from "./pi-cli";
import {
  formatBytes,
  listSessions,
  projectSessionsDir,
  sessionsRoot,
  type SessionSummary,
} from "./sessions";
import {
  firstMeaningfulLine,
  gentleCommands,
  parseReviewMode,
  resolveGentleBinary,
  summarizeGentle,
  unknownGentleState,
  GENTLE_PACKAGE,
  type GentleState,
} from "./gentle";
import { PiRpcClient } from "./pi-rpc-client";
import { PiSdkClient } from "./pi-sdk-client";
import type { PiClient } from "./pi-client";
import type { PiModel, PiSlashCommand, PiThinkingLevel } from "./protocol";
import {
  chooseBackend,
  describeRuntime,
  installManagedRuntime,
  readTransport,
  resolveRuntime,
  resolveSdkEntry,
  type PiTransport,
  type RuntimeDescriptor,
  type RuntimeMode,
} from "./runtime";

let client: PiClient | undefined;
let view: ChatView | undefined;
/** The directory the agent runs in, which is also the project its sessions belong to. */
let agentCwd: string | undefined;
let ajustesView: AjustesView | undefined;
/** When this session activated, used to tell a restored panel from a real click. */
let activatedAt = 0;
let startupResolveSkipped = false;
let outputChannel: vscode.OutputChannel | undefined;
let defaultModelApplied = false;
/** pi's image helpers, cached per SDK entry: importing an ESM package is not free. */
let attachmentToolsEntry: string | undefined;
let attachmentToolsPromise: Promise<ImageTools | undefined> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  activatedAt = Date.now();
  outputChannel = vscode.window.createOutputChannel("PiCode");
  context.subscriptions.push(outputChannel);

  view = ChatView.create(context.extensionUri, {
    ensureClient: () => ensureClient(context.extensionUri),
    applyModel: (modelId, provider) =>
      withLiveClient((rpc) => applyModel(rpc, modelId, provider)),
    applyThinkingLevel: (level) => withLiveClient((rpc) => applyThinkingLevel(rpc, level)),
    openMenu: () => showPiMenu(menu),
    restart: () => resetClient(),
    // The same two the popup's session picker uses: the panel's empty state offers the
    // project's previous conversations, so both surfaces read and load one list.
    recentSessions: () => listProjectSessions(),
    resumeSession: (session) => resumeSession(session),
    imageTools: () => attachmentTools(context.extensionUri),
    // The view reports host-side failures that must not interrupt the transcript;
    // the shared channel already exists here, so one is not created for it.
    ...(outputChannel ? { output: outputChannel } : {}),
  } satisfies ChatViewHost);

  // pi's configuration lives in popup menus, reached from the status bar icon and
  // from a button on the chat view's title. Package management is the one surface
  // that talks to the pi CLI rather than to the RPC protocol, and it always talks
  // to the active runtime's CLI.
  const menu: PiMenuDeps = {
    runtime: () => resolveRuntime(context.extensionUri),
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
    gentle: gentleActions(context),
    newSession: () => startNewSession(),
    abort: () => abortRun(),
    restart: () => resetClient(),
    log: (line) => outputChannel?.appendLine(`[pi] ${line}`),
    offerRestart: (what) => offerRestart(what),
  };

  // The icon on the left opens this panel, because the editor decides that a
  // container shows a sidebar. The popup itself is one click away from here.
  const ajustes = AjustesView.create(context.extensionUri, {
    snapshot: () => menuSnapshot(context.extensionUri),
    openMenu: (category?: PiCategoryId) => showPiMenu(menu, category),
    autoOpenMenu: () => autoOpenMenuFromPanel(menu),
  });
  ajustesView = ajustes;

  context.subscriptions.push(
    // `retainContextWhenHidden` keeps the webview alive while the sidebar is
    // collapsed, so a visible transcript is not thrown away by hiding it.
    vscode.window.registerWebviewViewProvider(ChatView.viewId, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(AjustesView.viewId, ajustes, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("picode.piChat.menu", () => showPiMenu(menu)),
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
  );
}

export function deactivate(): void {
  view?.dispose();
  view = undefined;
  ajustesView?.dispose();
  ajustesView = undefined;
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
  defaultModelApplied = false;

  // Only restart the process if the view is open: starting pi is a consequence
  // of opening the container, never of a stray command.
  if (view?.isVisible) {
    await view.rebind();
  }
}

const STARTUP_GRACE_MS = 20_000;

/**
 * Opens the popup because the sidebar panel was shown, which is what clicking the
 * left icon does.
 *
 * One resolve per session is skipped: at startup the editor restores whichever views
 * were open, and that resolve is not a click, so popping a menu nobody asked for is
 * worse than leaving the panel's own button to do it. Every resolve after that one
 * is a real click.
 */
async function autoOpenMenuFromPanel(menu: PiMenuDeps): Promise<void> {
  const sinceActivation = Date.now() - activatedAt;
  if (!startupResolveSkipped && sinceActivation < STARTUP_GRACE_MS) {
    startupResolveSkipped = true;
    outputChannel?.appendLine("[pi] panel restaurado al arrancar: el menú no se abre solo");
    return;
  }
  await showPiMenu(menu);
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
    commands = await client.getCommands().catch(() => []);
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

/** How many packages pi reports, or undefined when the CLI cannot answer. */
async function countInstalled(extensionUri: vscode.Uri): Promise<number | undefined> {
  const now = Date.now();
  if (installedCountCache && now - installedCountCache.at < INSTALLED_COUNT_TTL_MS) {
    return installedCountCache.value;
  }

  let value: number | undefined;
  try {
    const result = await runPiCli(resolveRuntime(extensionUri), ["list"], undefined, () => {});
    value = parseInstalledPackages(result.text).length;
  } catch {
    value = undefined;
  }
  installedCountCache = { value, at: now };
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
): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    `PiCode va a instalar ${current.pin.package}@${current.pin.version} en ${current.managedRoot}. ` +
      "Descarga unos cientos de megabytes. Tu pi global no se toca.",
    { modal: true },
    "Instalar",
  );
  if (answer !== "Instalar") {
    return false;
  }

  outputChannel?.show(true);
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `PiCode: instalando pi ${current.pin.version}`,
    },
    () =>
      installManagedRuntime(context.extensionUri, (line) =>
        outputChannel?.appendLine(`[runtime] ${line}`),
      ),
  );
  if (!result.ok) {
    void vscode.window.showErrorMessage(`PiCode: ${result.message}`);
    return false;
  }
  outputChannel?.appendLine(`[runtime] ${result.message}`);
  return true;
}

/** The Runtime category's install row: installs PiCode's own pi and switches to it. */
async function installManagedFromMenu(context: vscode.ExtensionContext): Promise<void> {
  const current = await describeRuntime(context.extensionUri);
  const installed = await installManaged(context, current);
  if (!installed) {
    return;
  }
  await vscode.workspace
    .getConfiguration("picode.pi")
    .update("runtime", "managed", vscode.ConfigurationTarget.Global);
  await resetClient();
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

  if (picked.mode === "custom") {
    const entered = await vscode.window.showInputBox({
      title: "PiCode: ruta del ejecutable de pi",
      value: customPath,
      prompt: "Una ruta absoluta, o un nombre que se resuelva en el PATH.",
    });
    if (entered === undefined) {
      return;
    }
    await configuration.update(
      "executablePath",
      entered.trim().length > 0 ? entered.trim() : "pi",
      vscode.ConfigurationTarget.Global,
    );
  }

  if (picked.mode === "managed" && !current.managedInstalled) {
    await installManaged(context, current);
  }

  await configuration.update("runtime", picked.mode, vscode.ConfigurationTarget.Global);
  await resetClient();
  outputChannel?.appendLine(`[runtime] mode is now "${picked.mode}".`);
  void vscode.window.showInformationMessage(`PiCode: usando ${RUNTIME_LABELS[picked.mode]}.`);
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
    const listed = await runPiCli(resolveRuntime(extensionUri), ["list"], undefined, silent);
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
    const commands = await client.getCommands().catch(() => []);
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
        () =>
          runPiCli(
            resolveRuntime(context.extensionUri),
            ["install", `npm:${GENTLE_PACKAGE}`],
            undefined,
            log,
          ),
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
 * Loads a previous conversation into the running agent.
 *
 * The view is cleared and told why: pi now holds the conversation, the panel does not, and
 * replaying the history into the webview is a separate job from resuming it.
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
    view?.notifySessionSwitched(
      `Sesión cargada: ${label}. pi tiene la conversación y ${formatBytes(session.bytes)} de historial; el panel no lo reproduce, así que escribe para continuar.`,
    );
    await view?.refreshState();
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

  await applyDefaultModel(rpc);
  return true;
}

/**
 * Applies `picode.pi.defaultModel` once per client. A model failure is not fatal
 * (pi already has a configured default), so it is reported as a warning.
 */
async function applyDefaultModel(rpc: PiClient): Promise<void> {
  if (defaultModelApplied) {
    return;
  }
  const configured = vscode.workspace
    .getConfiguration("picode.pi")
    .get<string>("defaultModel", "")
    .trim();
  if (configured.length === 0) {
    return;
  }

  try {
    await rpc.setModel(configured);
    defaultModelApplied = true;
    outputChannel?.appendLine(`[pi] default model set to "${configured}".`);
  } catch (error) {
    const message = toErrorMessage(error);
    outputChannel?.appendLine(`[pi] could not apply default model "${configured}": ${message}`);
    void vscode.window.showWarningMessage(
      `PiCode: could not apply picode.pi.defaultModel "${configured}": ${message}`,
    );
  }
}

function reportCommandFailure(action: string, error: unknown): void {
  const message = toErrorMessage(error);
  outputChannel?.appendLine(`[pi] failed to ${action}: ${message}`);
  void vscode.window.showErrorMessage(`PiCode: no se pudo ${action}. ${message}`);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
