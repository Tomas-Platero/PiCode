import * as vscode from "vscode";
import { ChatView, type ChatViewHost } from "./chat-view";
import { ExtensionsView } from "./extensions-view";
import { PiRpcClient } from "./pi-rpc-client";
import type { PiModel, PiThinkingLevel } from "./protocol";
import {
  describeRuntime,
  installManagedRuntime,
  resolveRuntime,
  type RuntimeDescriptor,
  type RuntimeMode,
} from "./runtime";

let client: PiRpcClient | undefined;
let view: ChatView | undefined;
let extensionsView: ExtensionsView | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let defaultModelApplied = false;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("PiCode");
  context.subscriptions.push(outputChannel);

  view = ChatView.create(context.extensionUri, {
    ensureClient: () => ensureClient(context.extensionUri),
    describeRuntime: () => describeRuntime(context.extensionUri),
    selectRuntime: () => selectRuntime(context),
    applyModel: (modelId, provider) =>
      withLiveClient((rpc) => applyModel(rpc, modelId, provider)),
    applyThinkingLevel: (level) => withLiveClient((rpc) => applyThinkingLevel(rpc, level)),
  } satisfies ChatViewHost);

  // Package management is the one surface that talks to the pi CLI rather than to
  // the RPC protocol, and it always talks to the active runtime's CLI.
  const extensions = ExtensionsView.create(context.extensionUri, {
    runtime: () => resolveRuntime(context.extensionUri),
    log: (line) => outputChannel?.appendLine(`[pi] ${line}`),
    offerRestart: (what) => offerRestart(what),
  });
  extensionsView = extensions;

  context.subscriptions.push(
    // `retainContextWhenHidden` keeps the webview alive while the sidebar is
    // collapsed, so a visible transcript is not thrown away by hiding it.
    vscode.window.registerWebviewViewProvider(ChatView.viewId, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(ExtensionsView.viewId, extensions, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("picode.piChat.open", async () => {
      await revealChatView();
    }),
    vscode.commands.registerCommand("picode.piChat.selectRuntime", async () => {
      await selectRuntime(context);
    }),
    vscode.commands.registerCommand("picode.piChat.selectModel", async () => {
      await withLiveClient(selectModel);
    }),
    vscode.commands.registerCommand("picode.piChat.selectThinkingLevel", async () => {
      await withLiveClient(selectThinkingLevel);
    }),
    vscode.commands.registerCommand("picode.piChat.newSession", async () => {
      const rpc = view?.bound;
      if (!rpc) {
        await revealChatView();
        return;
      }
      try {
        await rpc.newSession();
        view?.notifySessionReset();
        await view?.refreshState();
      } catch (error) {
        reportCommandFailure("iniciar una sesión nueva", error);
      }
    }),
    vscode.commands.registerCommand("picode.piChat.abort", async () => {
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
    }),
    vscode.commands.registerCommand("picode.piChat.restart", async () => {
      await resetClient();
    }),
  );
}

export function deactivate(): void {
  view?.dispose();
  view = undefined;
  extensionsView?.dispose();
  extensionsView = undefined;
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
async function ensureClient(extensionUri: vscode.Uri): Promise<PiRpcClient | undefined> {
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

  // The installed list belongs to the runtime, so it is re-read when the runtime
  // changes. A hidden view would run the CLI for nobody.
  if (extensionsView?.isVisible) {
    await extensionsView.refresh();
  }
}

/**
 * pi loads its packages when it starts, so an install or a removal only takes
 * effect after a restart. The owner's conversation lives in that process, which
 * is why this asks instead of restarting on its own.
 */
async function offerRestart(what: string): Promise<void> {
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
    const answer = await vscode.window.showWarningMessage(
      `PiCode va a instalar ${current.pin.package}@${current.pin.version} en ${current.managedRoot}. ` +
        "Descarga unos cientos de megabytes. Tu pi global no se toca.",
      { modal: true },
      "Instalar",
    );
    if (answer !== "Instalar") {
      return;
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
      return;
    }
    outputChannel?.appendLine(`[runtime] ${result.message}`);
  }

  await configuration.update("runtime", picked.mode, vscode.ConfigurationTarget.Global);
  await resetClient();
  outputChannel?.appendLine(`[runtime] mode is now "${picked.mode}".`);
  void vscode.window.showInformationMessage(`PiCode: usando ${RUNTIME_LABELS[picked.mode]}.`);
}

/** How each runtime mode is named in the interface. */
const RUNTIME_LABELS: Record<RuntimeMode, string> = {
  path: "el pi de tu PATH",
  managed: "el pi propio de PiCode",
  custom: "un ejecutable concreto",
};

/**
 * Runs an interaction against the live client, revealing the view first when no
 * session is running yet: the model and reasoning pickers act on a session, not
 * on configuration, so there is nothing to offer until pi is up.
 */
async function withLiveClient(action: (rpc: PiRpcClient) => Promise<void>): Promise<void> {
  const rpc = view?.bound;
  if (!rpc) {
    await revealChatView();
    return;
  }
  try {
    await action(rpc);
  } catch (error) {
    reportCommandFailure("cambiar los ajustes de la sesión", error);
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
async function selectModel(rpc: PiRpcClient): Promise<void> {
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
async function selectThinkingLevel(rpc: PiRpcClient): Promise<void> {
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
async function applyModel(rpc: PiRpcClient, modelId: string, provider?: string): Promise<void> {
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
async function applyThinkingLevel(rpc: PiRpcClient, level: string): Promise<void> {
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

/**
 * Creates the client on first use so activation stays cheap; configuration is
 * read here, not at activation time.
 */
function getClient(extensionUri: vscode.Uri): PiRpcClient {
  if (client) {
    return client;
  }

  const configuration = vscode.workspace.getConfiguration("picode.pi");
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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

async function ensureStarted(rpc: PiRpcClient): Promise<boolean> {
  try {
    await rpc.start();
  } catch (error) {
    const message = toErrorMessage(error);
    outputChannel?.appendLine(`[pi] ${message}`);
    void vscode.window
      .showErrorMessage(`PiCode: ${message}`, "Abrir la configuración")
      .then((choice) => {
        if (choice === "Abrir la configuración") {
          void vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "picode.pi.executablePath",
          );
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
async function applyDefaultModel(rpc: PiRpcClient): Promise<void> {
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
