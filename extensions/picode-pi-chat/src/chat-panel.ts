import * as vscode from "vscode";
import { PiRpcClient, type PiSubscription } from "./pi-rpc-client";
import { isPanelEvent, type PiEvent, type PiSessionState } from "./protocol";

type PanelStatus = "idle" | "running" | "settled" | "error";

/**
 * Hosts the pi chat webview: owns the panel, routes agent events into it and
 * forwards user actions back to the RPC client. The webview is presentation
 * only; all truth (process, protocol, state) stays in the extension host.
 */
export class ChatPanel {
  public static readonly viewType = "picode.piChat";
  private static current: ChatPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly client: PiRpcClient;
  private readonly disposables: vscode.Disposable[] = [];
  private eventSubscription: PiSubscription | undefined;
  private disposed = false;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, client: PiRpcClient) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.client = client;

    this.panel.webview.html = this.buildHtml(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        void this.handleWebviewMessage(message);
      },
      null,
      this.disposables,
    );

    this.eventSubscription = client.onEvent((event) => this.handleEvent(event));
  }

  /** Reveals the existing panel or creates the singleton one. */
  public static createOrShow(context: vscode.ExtensionContext, client: PiRpcClient): ChatPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(column);
      return ChatPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(ChatPanel.viewType, "PiCode: pi Agent", column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });

    ChatPanel.current = new ChatPanel(panel, context.extensionUri, client);
    return ChatPanel.current;
  }

  /** True when a chat panel is currently open. */
  public static isOpen(): boolean {
    return ChatPanel.current !== undefined;
  }

  /** Refreshes the visible session state (used by session commands). */
  public async refreshState(): Promise<void> {
    await this.pushState();
  }

  /** Notifies the webview that a new session started and the transcript is gone. */
  public notifySessionReset(): void {
    this.post({ type: "clear" });
  }

  /** Reports a command failure in the panel without killing the session. */
  public notifyError(message: string): void {
    this.postStatus("error");
    this.post({ type: "error", message });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    if (ChatPanel.current === this) {
      ChatPanel.current = undefined;
    }

    // Detach from the shared client first so no event can reach a dead panel.
    this.eventSubscription?.dispose();
    this.eventSubscription = undefined;

    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }

  /* ---------------------------------------------------------------- *
   * Agent -> webview
   * ---------------------------------------------------------------- */

  private handleEvent(event: PiEvent): void {
    if (event.type === "agent_start") {
      this.postStatus("running");
    } else if (event.type === "agent_settled") {
      this.postStatus("settled");
    } else if (event.type === "extension_error") {
      this.postStatus("error");
      this.post({ type: "error", message: `Extension error: ${event.error}` });
    }

    if (isPanelEvent(event)) {
      this.post({ type: "piEvent", event });
    }

    // `message_end` is authoritative and `agent_settled` closes a run, so both
    // are good moments to resync the cheap state summary shown in the panel.
    if (event.type === "message_end" || event.type === "agent_settled") {
      void this.pushState();
    }
  }

  private async pushState(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      const state = await this.client.getState();
      this.post({ type: "state", state: toWebviewState(state) });
    } catch (error) {
      // State is a convenience; a stopped process is reported by its own error.
      this.postStatus("error");
      this.post({ type: "error", message: toErrorMessage(error) });
    }
  }

  private postStatus(status: PanelStatus): void {
    this.post({ type: "status", status });
  }

  private post(message: unknown): void {
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  /* ---------------------------------------------------------------- *
   * Webview -> agent
   * ---------------------------------------------------------------- */

  private async handleWebviewMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== "string") {
      return;
    }

    switch (message.type) {
      case "ready": {
        await this.pushState();
        break;
      }
      case "prompt": {
        const text = typeof message.text === "string" ? message.text.trim() : "";
        if (text.length === 0) {
          return;
        }
        this.postStatus("running");
        try {
          await this.client.prompt(text);
        } catch (error) {
          this.postStatus("error");
          this.post({ type: "error", message: toErrorMessage(error) });
        }
        break;
      }
      case "abort": {
        try {
          await this.client.abort();
          this.postStatus("idle");
        } catch (error) {
          this.postStatus("error");
          this.post({ type: "error", message: toErrorMessage(error) });
        }
        break;
      }
      case "newSession": {
        try {
          await this.client.newSession();
          this.notifySessionReset();
          await this.pushState();
        } catch (error) {
          this.postStatus("error");
          this.post({ type: "error", message: toErrorMessage(error) });
        }
        break;
      }
      default:
        break;
    }
  }

  /* ---------------------------------------------------------------- *
   * Webview document
   * ---------------------------------------------------------------- */

  private buildHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "main.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "main.css"),
    );
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>PiCode: pi Agent</title>
  </head>
  <body>
    <header class="toolbar">
      <span id="status" class="status status-idle">idle</span>
      <span id="session" class="session"></span>
      <button id="new-session" type="button" class="secondary">New session</button>
      <button id="abort" type="button" class="secondary" disabled>Abort</button>
    </header>
    <main id="messages" class="messages" aria-live="polite"></main>
    <section id="tool-section" class="tool-section" hidden>
      <h2 class="tool-heading">Tool activity</h2>
      <ul id="tools" class="tools"></ul>
    </section>
    <form id="composer" class="composer">
      <textarea
        id="prompt"
        class="prompt"
        rows="3"
        placeholder="Ask pi to do something. Enter sends, Shift+Enter adds a line."
      ></textarea>
      <button id="send" type="submit" class="primary">Send</button>
    </form>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

/** Projection of the session state the webview is allowed to see. */
interface WebviewSessionState {
  model?: string;
  sessionName?: string;
  sessionId?: string;
  messageCount?: number;
  pendingMessageCount?: number;
  thinkingLevel?: string;
}

function toWebviewState(state: PiSessionState): WebviewSessionState {
  const model = state.model;
  return {
    model: typeof model?.id === "string" ? model.id : undefined,
    sessionName: state.sessionName,
    sessionId: state.sessionId,
    messageCount: state.messageCount,
    pendingMessageCount: state.pendingMessageCount,
    thinkingLevel: state.thinkingLevel,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}
