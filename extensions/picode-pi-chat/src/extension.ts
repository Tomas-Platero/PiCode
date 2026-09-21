import * as vscode from "vscode";
import { ChatView } from "./chat-view";
import { PiRpcClient } from "./pi-rpc-client";

let client: PiRpcClient | undefined;
let view: ChatView | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let defaultModelApplied = false;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("PiCode");
  context.subscriptions.push(outputChannel);

  view = ChatView.create(context.extensionUri, ensureClient);

  context.subscriptions.push(
    // `retainContextWhenHidden` keeps the webview alive while the sidebar is
    // collapsed, so a visible transcript is not thrown away by hiding it.
    vscode.window.registerWebviewViewProvider(ChatView.viewId, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("picode.piChat.open", async () => {
      await revealChatView();
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
      client?.stop();
      // Configuration is read when the client is created, so a restart is also
      // how a changed executable path or extra arguments take effect.
      client = undefined;
      defaultModelApplied = false;

      // Only restart the process if the view is open: starting pi is a
      // consequence of opening the container, never of a stray command.
      if (view?.isVisible) {
        await view.rebind();
      }
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
async function ensureClient(): Promise<PiRpcClient | undefined> {
  const rpc = getClient();
  return (await ensureStarted(rpc)) ? rpc : undefined;
}

/**
 * Creates the client on first use so activation stays cheap; configuration is
 * read here, not at activation time.
 */
function getClient(): PiRpcClient {
  if (client) {
    return client;
  }

  const configuration = vscode.workspace.getConfiguration("picode.pi");
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  client = new PiRpcClient({
    executablePath: configuration.get<string>("executablePath", "pi"),
    extraArgs: configuration.get<string[]>("extraArgs", []),
    ...(cwd ? { cwd } : {}),
    ...(outputChannel ? { output: outputChannel } : {}),
  });
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
