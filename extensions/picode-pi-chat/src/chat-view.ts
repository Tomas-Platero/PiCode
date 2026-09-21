import * as vscode from "vscode";
import { PiRpcClient, type PiSubscription } from "./pi-rpc-client";
import { isPanelEvent, type PiEvent, type PiSessionState } from "./protocol";
import type { RuntimeDescriptor } from "./runtime";

type ViewStatus = "idle" | "running" | "settled" | "error";

/**
 * What the view needs from the extension host. Keeping this explicit means the
 * view never reaches for configuration or the process itself.
 */
export interface ChatViewHost {
  /** A started client for the active runtime, or undefined when pi cannot start. */
  ensureClient(): Promise<PiRpcClient | undefined>;
  /** Describes the active runtime for the panel's runtime control. */
  describeRuntime(): Promise<RuntimeDescriptor>;
  /** Opens the runtime picker and applies the choice. */
  selectRuntime(): Promise<void>;
}

/**
 * Hosts the pi chat as a native view in the secondary side bar.
 *
 * The editor owns a view's lifecycle: it resolves this provider when the
 * container becomes visible and disposes the view when the container is closed.
 * The class therefore attaches to whatever view it is handed instead of owning
 * one, and it must tolerate `view === undefined` for every action a command can
 * trigger while the sidebar is closed.
 *
 * The provider is registered with `retainContextWhenHidden`, so collapsing the
 * sidebar does not reload the webview and the transcript survives.
 *
 * Activation stays opt-in: nothing here runs at startup. pi is started on the
 * first `resolveWebviewView`, which only happens because the user opened the
 * container (ADR-009).
 */
export class ChatView implements vscode.WebviewViewProvider {
  public static readonly viewId = "picode.piChat";
  /** Container id, declared in the manifest under `secondarySidebar`. */
  public static readonly containerId = "picode";

  private view: vscode.WebviewView | undefined;
  private client: PiRpcClient | undefined;
  private eventSubscription: PiSubscription | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private boundClient: PiRpcClient | undefined;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly host: ChatViewHost,
  ) {}

  public static create(extensionUri: vscode.Uri, host: ChatViewHost): ChatView {
    return new ChatView(extensionUri, host);
  }

  /** True when the container is open and the webview is attached. */
  public get isVisible(): boolean {
    return this.view !== undefined;
  }

  /** The client the webview is currently bound to, if any. */
  public get bound(): PiRpcClient | undefined {
    return this.boundClient;
  }

  public async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.releaseView();
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.buildHtml(view.webview);
    view.webview.onDidReceiveMessage(
      (message: unknown) => {
        void this.handleWebviewMessage(message);
      },
      null,
      this.disposables,
    );
    view.onDidDispose(() => this.releaseView(), null, this.disposables);

    await this.bindClient();
  }

  /**
   * Re-binds to the current client. A restart replaces the client object, so the
   * view has to drop its subscription to the dead one and attach to the new one.
   */
  public async rebind(): Promise<void> {
    await this.bindClient();
  }

  /** Refreshes the visible session state (used by session commands). */
  public async refreshState(): Promise<void> {
    await this.pushState();
  }

  /**
   * Refreshes the runtime control. Called after a runtime switch so the panel
   * never shows a runtime the process is not actually running.
   */
  public async refreshRuntime(): Promise<void> {
    await this.pushRuntime();
  }

  /** Notifies the webview that a new session started and the transcript is gone. */
  public notifySessionReset(): void {
    this.post({ type: "clear" });
  }

  /** Reports a command failure in the view without killing the session. */
  public notifyError(message: string): void {
    this.postStatus("error");
    this.post({ type: "error", message });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.releaseView();
  }

  /* ---------------------------------------------------------------- *
   * Attachment
   * ---------------------------------------------------------------- */

  private async bindClient(): Promise<void> {
    const client = await this.host.ensureClient();

    if (this.disposed) {
      return;
    }
    if (!client) {
      this.postStatus("error");
      this.post({
        type: "error",
        message:
          "pi could not be started. Check picode.pi.executablePath and the PiCode output channel.",
      });
      return;
    }

    // Detach from any previous client first, so no event can reach a webview
    // that is bound to a different process.
    this.eventSubscription?.dispose();
    this.client = client;
    this.boundClient = client;
    this.eventSubscription = client.onEvent((event) => this.handleEvent(event));

    await this.pushState();
    await this.pushRuntime();
  }

  private releaseView(): void {
    this.eventSubscription?.dispose();
    this.eventSubscription = undefined;

    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.view = undefined;
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
    // are good moments to resync the cheap state summary shown in the view.
    if (event.type === "message_end" || event.type === "agent_settled") {
      void this.pushState();
    }
  }

  private async pushState(): Promise<void> {
    if (this.view === undefined || !this.client) {
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

  private postStatus(status: ViewStatus): void {
    this.post({ type: "status", status });
  }

  /**
   * Reports which pi the session is running. The control is informational first:
   * a switcher that does not say what is active invites the owner to guess.
   */
  private async pushRuntime(): Promise<void> {
    if (this.view === undefined) {
      return;
    }
    try {
      const runtime = await this.host.describeRuntime();
      this.post({ type: "runtime", runtime });
    } catch (error) {
      this.post({
        type: "error",
        message: `Could not read the pi runtime: ${toErrorMessage(error)}`,
      });
    }
  }

  private post(message: unknown): void {
    if (this.view === undefined || this.disposed) {
      return;
    }
    void this.view.webview.postMessage(message);
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
        await this.pushRuntime();
        break;
      }
      case "selectRuntime": {
        await this.host.selectRuntime();
        await this.pushRuntime();
        break;
      }
      case "refreshRuntime": {
        await this.pushRuntime();
        break;
      }
      case "prompt": {
        const text = typeof message.text === "string" ? message.text.trim() : "";
        if (text.length === 0 || !this.client) {
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
        if (!this.client) {
          return;
        }
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
        if (!this.client) {
          return;
        }
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
    <title>PiCode: pi agent</title>
  </head>
  <body>
    <header class="toolbar">
      <span id="status" class="status status-idle">idle</span>
      <span id="session" class="session"></span>
      <button id="new-session" type="button" class="secondary" title="Start a new pi session">New</button>
      <button id="abort" type="button" class="secondary" disabled title="Stop the current run">Stop</button>
    </header>
    <div class="runtime-strip">
      <button
        id="runtime"
        type="button"
        class="runtime-chip"
        title="Choose which pi PiCode runs"
      >checking pi\u2026</button>
    </div>
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
