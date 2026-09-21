import * as vscode from "vscode";
import { collectReferences, composePrompt } from "./context";
import { PiRpcClient, type PiSubscription } from "./pi-rpc-client";
import { isPanelEvent, type PiAssistantContent, type PiEvent, type PiSessionState, type PiUsage } from "./protocol";
import { addMessageUsage, emptyUsage, summarizeUsage, type UsageTotals } from "./usage";
import { buildWebviewHtml } from "./webview-html";

type ViewStatus = "idle" | "running" | "settled" | "error";

/**
 * What the view needs from the extension host. Keeping this explicit means the
 * view never reaches for configuration or the process itself.
 */
export interface ChatViewHost {
  /** A started client for the active runtime, or undefined when pi cannot start. */
  ensureClient(): Promise<PiRpcClient | undefined>;
  /** Applies a model chosen in the panel's own dropdown. */
  applyModel(modelId: string, provider?: string): Promise<void>;
  /** Applies a reasoning level chosen in the panel's own dropdown. */
  applyThinkingLevel(level: string): Promise<void>;
}

const CHAT_BODY = `    <header class="toolbar">
      <span id="status" class="status status-idle">en reposo</span>
      <span id="session" class="session"></span>
      <button id="new-session" type="button" class="secondary" title="Empezar una sesión nueva de pi">Nueva</button>
      <button id="abort" type="button" class="secondary" disabled title="Detener la ejecución actual">Detener</button>
    </header>
    <main id="messages" class="messages" aria-live="polite"></main>
    <section id="tool-section" class="tool-section" hidden>
      <h2 class="tool-heading">Actividad de herramientas</h2>
      <ul id="tools" class="tools"></ul>
    </section>
    <form id="composer" class="composer">
      <textarea
        id="prompt"
        class="prompt"
        rows="3"
        placeholder="Pídele algo a pi. Enter envía; Shift+Enter añade una línea."
      ></textarea>
      <div class="composer-actions">
        <button
          id="model"
          type="button"
          class="dropdown-toggle model-chip"
          title="Elegir el modelo"
          aria-haspopup="listbox"
        >Modelo\u2026</button>
        <button
          id="thinking"
          type="button"
          class="dropdown-toggle thinking-chip"
          title="Elegir el nivel de razonamiento"
          aria-haspopup="listbox"
        >Razonamiento\u2026</button>
        <button id="send" type="submit" class="primary">Enviar</button>
      </div>
    </form>
    <div id="dropdown" class="dropdown" hidden>
      <input
        id="dropdown-filter"
        class="dropdown-filter"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="Buscar\u2026"
      />
      <ul id="dropdown-options" class="dropdown-options" tabindex="-1" role="listbox"></ul>
    </div>`;

/**
 * Hosts the pi chat as a native view in the secondary side bar.
 * *
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
  /** What this session has cost, added up from the messages pi reports. */
  private totals: UsageTotals = emptyUsage();
  private contextWindow: number | undefined;
  /**
   * Whether messages carry the editor context.
   *
   * Per session, seeded from the setting: the owner may want it on by default without
   * every toggle writing to their settings file.
   */
  private attachContext =
    vscode.workspace.getConfiguration("picode.context").get<boolean>("attach", false);

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

  /** The session's running total, for the panel and for the popup's report. */
  public get usage(): UsageTotals {
    return this.totals;
  }

  /** The current model's context window, when pi reports one. */
  public get modelContextWindow(): number | undefined {
    return this.contextWindow;
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

  /** Notifies the webview that a new session started and the transcript is gone. */
  public notifySessionReset(): void {
    this.totals = emptyUsage();
    this.contextWindow = undefined;
    this.post({ type: "clear" });
  }

  /**
   * Notifies the webview that another conversation was loaded.
   *
   * The transcript is cleared because the loaded session's history is not replayed: pi has
   * the conversation, the view does not. Saying so is the difference between an empty panel
   * that looks broken and an empty panel that is explained.
   */
  public notifySessionSwitched(note: string): void {
    this.notifySessionReset();
    this.post({ type: "note", text: note });
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
          "No se pudo arrancar pi. Revisa picode.pi.executablePath y el canal de salida PiCode.",
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
    await this.pushModels();
    await this.pushThinkingLevels();
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

    // Only `message_end` is counted: it carries the authoritative message, while the
    // streaming updates and the start event do not state a final usage.
    if (event.type === "message_end") {
      this.absorbUsage(event.message);
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
      this.contextWindow = state.model?.contextWindow;
      this.post({
        type: "state",
        state: toWebviewState(state),
        // Formatted here, where the totals live, so the renderer stays presentation.
        usage: summarizeUsage(this.totals, this.contextWindow),
        contextAttached: this.attachContext,
      });
    } catch (error) {
      // State is a convenience; a stopped process is reported by its own error.
      this.postStatus("error");
      this.post({ type: "error", message: toErrorMessage(error) });
    }
  }

  /**
   * Adds one assistant reply to the session's running total.
   *
   * Takes an unknown because the event payload is untrusted JSON until its role is
   * checked, and this is the boundary where that check happens.
   */
  private absorbUsage(message: unknown): void {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const record = message as {
      role?: unknown;
      usage?: PiUsage;
      content?: PiAssistantContent[];
    };
    if (record.role !== "assistant") {
      return;
    }
    this.totals = addMessageUsage(this.totals, record.usage, record.content);
  }

  private postStatus(status: ViewStatus): void {
    this.post({ type: "status", status });
  }

  /**
   * Sends the model catalogue the panel's dropdown filters over. Pushed once per
   * bind rather than per interaction: switching model does not change it.
   */
  private async pushModels(): Promise<void> {
    if (this.view === undefined || !this.client) {
      return;
    }
    try {
      this.post({ type: "models", models: await this.client.getAvailableModels() });
    } catch (error) {
      this.post({ type: "error", message: toErrorMessage(error) });
    }
  }

  /** Sends the reasoning levels the current model supports. */
  private async pushThinkingLevels(): Promise<void> {
    if (this.view === undefined || !this.client) {
      return;
    }
    try {
      this.post({
        type: "thinkingLevels",
        levels: await this.client.getAvailableThinkingLevels(),
      });
    } catch (error) {
      this.post({ type: "error", message: toErrorMessage(error) });
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
        await this.pushModels();
        await this.pushThinkingLevels();
        break;
      }
      case "setModel": {
        const modelId = typeof message.modelId === "string" ? message.modelId : "";
        if (modelId.length === 0) {
          break;
        }
        const provider = typeof message.provider === "string" ? message.provider : undefined;
        await this.host.applyModel(modelId, provider);
        // A different model supports different reasoning levels, so both the
        // state and the level list are refreshed together.
        await this.pushState();
        await this.pushThinkingLevels();
        break;
      }
      case "setThinkingLevel": {
        const level = typeof message.level === "string" ? message.level : "";
        if (level.length === 0) {
          break;
        }
        await this.host.applyThinkingLevel(level);
        await this.pushState();
        break;
      }
      case "prompt": {
        const text = typeof message.text === "string" ? message.text.trim() : "";
        if (text.length === 0 || !this.client) {
          return;
        }
        this.postStatus("running");
        try {
          // Collected at send time, not when the panel opened, so it describes the
          // editor as it is when the message is actually sent.
          const references = this.attachContext ? collectReferences() : [];
          await this.client.prompt(composePrompt(text, references));
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
    return buildWebviewHtml({
      webview,
      extensionUri: this.extensionUri,
      title: "PiCode: agente pi",
      body: CHAT_BODY,
      scripts: ["main.js"],
      styles: ["main.css"],
    });
  }
}

/** Projection of the session state the webview is allowed to see. */
interface WebviewSessionState {
  model?: string;
  modelName?: string;
  provider?: string;
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
    modelName: typeof model?.name === "string" ? model.name : undefined,
    provider: typeof model?.provider === "string" ? model.provider : undefined,
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
