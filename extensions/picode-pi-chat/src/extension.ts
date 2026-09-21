import * as vscode from "vscode";
import { ChatView, type ChatViewHost } from "./chat-view";
import { PiRpcClient } from "./pi-rpc-client";
import {
  describeRuntime,
  installManagedRuntime,
  resolveRuntime,
  type RuntimeDescriptor,
  type RuntimeMode,
} from "./runtime";

let client: PiRpcClient | undefined;
let view: ChatView | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let defaultModelApplied = false;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("PiCode");
  context.subscriptions.push(outputChannel);

  view = ChatView.create(context.extensionUri, {
    ensureClient: () => ensureClient(context.extensionUri),
    describeRuntime: () => describeRuntime(context.extensionUri),
    selectRuntime: () => selectRuntime(context),
  } satisfies ChatViewHost);

  context.subscriptions.push(
    // `retainContextWhenHidden` keeps the webview alive while the sidebar is
    // collapsed, so a visible transcript is not thrown away by hiding it.
    vscode.window.registerWebviewViewProvider(ChatView.viewId, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("picode.piChat.open", async () => {
      await revealChatView();
    }),
    vscode.commands.registerCommand("picode.piChat.selectRuntime", async () => {
      await selectRuntime(context);
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
        reportCommandFailure("start a new session", error);
      }
    }),
    vscode.commands.registerCommand("picode.piChat.abort", async () => {
      if (!client?.isRunning) {
        void vscode.window.showInformationMessage("PiCode: no pi process is running.");
        return;
      }
      try {
        await client.abort();
      } catch (error) {
        reportCommandFailure("abort the current run", error);
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
      `PiCode: could not read the pi runtime. ${toErrorMessage(error)}`,
    );
    return;
  }

  const configuration = vscode.workspace.getConfiguration("picode.pi");
  const customPath = configuration.get<string>("executablePath", "pi");
  const active = (version: string | undefined): string =>
    version ? `active now \u00b7 ${version}` : "active now";

  interface RuntimeChoice extends vscode.QuickPickItem {
    mode: RuntimeMode;
  }

  const choices: RuntimeChoice[] = [
    {
      mode: "path",
      label: "$(terminal) The pi on your PATH",
      description: current.mode === "path" ? active(current.version) : "",
      detail: "Your own installation. It changes whenever you update pi.",
    },
    {
      mode: "managed",
      label: "$(package) PiCode's own pi",
      description:
        current.mode === "managed" ? active(current.version) : `pinned ${current.pin.version}`,
      detail: current.managedInstalled
        ? `Installed in ${current.managedRoot}, isolated from your global pi.`
        : "Installs into PiCode's own folder when selected, so the version is reproducible and your global pi is left untouched.",
    },
    {
      mode: "custom",
      label: "$(file-directory) A specific executable",
      description: current.mode === "custom" ? customPath : "",
      detail: "Uses picode.pi.executablePath exactly as written.",
    },
  ];

  const picked = await vscode.window.showQuickPick(choices, {
    title: "PiCode: which pi should run?",
    placeHolder: summarizeRuntime(current),
  });
  if (!picked) {
    return;
  }

  if (picked.mode === "custom") {
    const entered = await vscode.window.showInputBox({
      title: "PiCode: path to the pi executable",
      value: customPath,
      prompt: "An absolute path, or a name resolved on PATH.",
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
      `PiCode will install ${current.pin.package}@${current.pin.version} into ${current.managedRoot}. ` +
        "That downloads a few hundred megabytes. Your global pi is not touched.",
      { modal: true },
      "Install",
    );
    if (answer !== "Install") {
      return;
    }

    outputChannel?.show(true);
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `PiCode: installing pi ${current.pin.version}`,
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
  void vscode.window.showInformationMessage(
    `PiCode: using ${picked.mode === "path" ? "the pi on your PATH" : picked.mode === "managed" ? "PiCode's own pi" : "a custom executable"}.`,
  );
}

/** One line describing the active runtime, for pickers and messages. */
function summarizeRuntime(runtime: RuntimeDescriptor): string {
  const version = runtime.version ? ` ${runtime.version}` : "";
  if (runtime.mode === "managed") {
    return `PiCode's own pi${version}${runtime.available ? "" : " (not installed)"}`;
  }
  if (runtime.mode === "custom") {
    return `Custom executable${version}: ${runtime.display}`;
  }
  return `PATH pi${version}${runtime.available ? "" : " (not found)"}`;
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
      .showErrorMessage(`PiCode: ${message}`, "Open Settings")
      .then((choice) => {
        if (choice === "Open Settings") {
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
  void vscode.window.showErrorMessage(`PiCode: could not ${action}. ${message}`);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
