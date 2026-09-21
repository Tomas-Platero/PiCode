import * as vscode from "vscode";
import {
  ATTACHMENT_LIMITS,
  formatAttachmentNote,
  prepareImage,
  type ImageTools,
  type PrepareImageInput,
  type PreparedImage,
} from "./attachments";
import { collectReferences, composePrompt } from "./context";
import type { PiClient, PiSubscription } from "./pi-client";
import { isPanelEvent, type PiAssistantContent, type PiEvent, type PiImageContent, type PiSessionState, type PiUsage } from "./protocol";
import { addMessageUsage, emptyUsage, summarizeUsage, type UsageTotals } from "./usage";
import { buildWebviewHtml } from "./webview-html";

type ViewStatus = "idle" | "running" | "settled" | "error";

/**
 * What the view needs from the extension host. Keeping this explicit means the
 * view never reaches for configuration or the process itself.
 */
export interface ChatViewHost {
  /** A started client for the active runtime, or undefined when pi cannot start. */
  ensureClient(): Promise<PiClient | undefined>;
  /** Applies a model chosen in the panel's own dropdown. */
  applyModel(modelId: string, provider?: string): Promise<void>;
  /** Applies a reasoning level chosen in the panel's own dropdown. */
  applyThinkingLevel(level: string): Promise<void>;
  /** Opens the pi configuration popup. */
  openMenu(): Promise<void>;
  /** Restarts the agent backend, keeping the panel where it is. */
  restart(): Promise<void>;
  /**
   * pi's own image helpers, or undefined when they could not be loaded.
   *
   * The view never resolves the pi entry itself: loading an ESM package is host
   * work, and a failure has to be reported once by the host instead of on every
   * message. Without them the panel still works; it just cannot attach images.
   */
  imageTools?(): Promise<ImageTools | undefined>;
  /**
   * Where host-side failures that must not interrupt the transcript are written.
   *
   * The shared channel belongs to the extension entry point, so the view receives
   * it instead of creating a second channel with the same name. Optional: a view
   * that is never given one still works, and link failures fall back to the log.
   */
  output?: vscode.OutputChannel;
}

const CHAT_BODY = `    <header class="toolbar">
      <span id="status" class="status" hidden></span>
      <span id="session" class="session"></span>
      <button id="new-session" type="button" class="icon-button" title="Empezar una sesión nueva de pi" aria-label="Nueva sesión"><span class="codicon codicon-comment-discussion"></span></button>
      <button id="abort" type="button" class="icon-button" disabled title="Detener la ejecución actual" aria-label="Detener"><span class="codicon codicon-debug-stop"></span></button>
      <button id="restart" type="button" class="icon-button" title="Reiniciar el proceso de pi" aria-label="Reiniciar"><span class="codicon codicon-refresh"></span></button>
      <button id="menu" type="button" class="icon-button" title="Configuración de pi" aria-label="Configuración"><span class="codicon codicon-settings-gear"></span></button>
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
        ><span class="codicon codicon-sparkle"></span><span class="chip-text">Modelo\u2026</span></button>
        <button
          id="thinking"
          type="button"
          class="dropdown-toggle thinking-chip"
          title="Elegir el nivel de razonamiento"
          aria-haspopup="listbox"
        ><span class="codicon codicon-lightbulb"></span><span class="chip-text">Razonamiento\u2026</span></button>
        <button id="send" type="submit" class="primary icon-button" title="Enviar (Enter)" aria-label="Enviar"><span class="codicon codicon-send"></span></button>
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
  private client: PiClient | undefined;
  private eventSubscription: PiSubscription | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private boundClient: PiClient | undefined;
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
  public get bound(): PiClient | undefined {
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

  /**
   * Prepares the attachments a prompt carried, reporting each refusal.
   *
   * A refusal is not a reason to drop the message: the owner still wants the text
   * to arrive, and they need to know which image was left behind and why. Only the
   * count limit is fatal, because it is a decision about the whole message.
   */
  private async prepareAttachments(
    candidates: readonly PrepareImageInput[],
  ): Promise<PreparedImage[]> {
    if (candidates.length === 0) {
      return [];
    }

    const tools = await this.host.imageTools?.();
    if (!tools) {
      // Reported rather than silently dropped: an image that disappears without a
      // word is worse than one the panel says it could not prepare.
      this.post({
        type: "error",
        message:
          "No se pueden adjuntar imágenes: pi no publica las funciones que las " +
          "preparan. El mensaje se envía solo con el texto.",
      });
      return [];
    }

    const prepared: PreparedImage[] = [];
    for (const candidate of candidates) {
      const outcome = await prepareImage(tools, candidate, ATTACHMENT_LIMITS);
      if (outcome.ok) {
        prepared.push(outcome.image);
      } else {
        this.post({ type: "error", message: outcome.reason });
      }
    }
    return prepared;
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

        const candidates = readImageCandidates(message.images);
        if (candidates.length > ATTACHMENT_LIMITS.maxCount) {
          this.postStatus("error");
          this.post({
            type: "error",
            message:
              `Se pueden adjuntar como máximo ${ATTACHMENT_LIMITS.maxCount} imágenes por ` +
              `mensaje, y llegaron ${candidates.length}. El mensaje no se envió.`,
          });
          return;
        }

        const images = await this.prepareAttachments(candidates);
        // The note goes before the owner's words, like the editor-context block:
        // whatever PiCode adds is a preamble, and the message itself comes last.
        const note = formatAttachmentNote(images);
        // Collected at send time, not when the panel opened, so it describes the
        // editor as it is when the message is actually sent.
        const body = composePrompt(text, this.attachContext ? collectReferences() : []);
        const outgoing = note === undefined ? body : `${note}\n\n${body}`;

        this.postStatus("running");
        try {
          await this.client.prompt(
            outgoing,
            images.length > 0 ? { images: images.map(toPiImageContent) } : undefined,
          );
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
      case "openMenu": {
        await this.host.openMenu();
        break;
      }
      case "restart": {
        await this.host.restart();
        break;
      }
      case "openLink": {
        const href = typeof message.href === "string" ? message.href : "";
        if (href.length === 0) {
          break;
        }
        // The renderer already refuses anything but http, https and mailto. The
        // host repeats the check because the webview boundary is where trust ends
        // and the renderer is one message away from being replaced.
        const lowered = href.toLowerCase();
        if (
          !lowered.startsWith("http://") &&
          !lowered.startsWith("https://") &&
          !lowered.startsWith("mailto:")
        ) {
          break;
        }
        try {
          await vscode.env.openExternal(vscode.Uri.parse(href));
        } catch (error) {
          const line = `[pi] could not open the link: ${toErrorMessage(error)}`;
          if (this.host.output) {
            this.host.output.appendLine(line);
          } else {
            // No shared channel was passed in; the failure still reaches the
            // developer log rather than disappearing.
            console.error(line);
          }
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
      scripts: ["markdown.js", "main.js"],
      styles: ["codicon.css", "main.css"],
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

/**
 * Reads the attachments a webview message carried.
 *
 * The payload crosses the webview boundary, so nothing about it is trusted: an
 * entry that is not an object with a non-empty `data` string and a `mimeType`
 * string is skipped rather than sent anywhere. The claimed type is only passed
 * along as a label for the refusal message; the detector decides the real one.
 */
function readImageCandidates(value: unknown): PrepareImageInput[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const candidates: PrepareImageInput[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    if (typeof entry.data !== "string" || entry.data.length === 0) {
      continue;
    }
    if (typeof entry.mimeType !== "string") {
      continue;
    }
    candidates.push({
      base64: entry.data,
      claimedMimeType: entry.mimeType,
      ...(typeof entry.name === "string" && entry.name.length > 0 ? { name: entry.name } : {}),
    });
  }
  return candidates;
}

/** The wire shape of one image: the same `{type,data,mimeType}` on both backends. */
function toPiImageContent(image: PreparedImage): PiImageContent {
  return { type: "image", data: image.data, mimeType: image.mimeType };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
