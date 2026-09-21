import { spawn } from "node:child_process";
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
import {
  VIDEO_LIMITS,
  extractFrames,
  ffmpegInstallHint,
  formatVideoNote,
  probeVideo,
  resolveFfmpeg,
  type CommandRunner,
  type VideoFrame,
  type VideoProbe,
} from "./video";
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
      <div id="attachments" class="attachments" hidden></div>
      <div class="composer-actions">
        <button id="attach" type="button" class="icon-button" title="Adjuntar una imagen o un vídeo" aria-label="Adjuntar"><span class="codicon codicon-device-camera"></span></button>
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
  /**
   * The images the owner has attached to the message being written.
   *
   * Bytes cross the webview boundary exactly once, when the image is added, and
   * the webview only learns an id and a thumbnailable data URL. Submitting sends
   * ids, so a webview can forge an id but not invent bytes, and pi's helpers run
   * once per image instead of once per add plus once per send.
   */
  private readonly attachments = new Map<string, PreparedImage>();
  /**
   * The line that tells the model the stills in the message came from a video.
   *
   * Kept under the id of each still, next to the image itself, so it lives and dies
   * with the store: an id that no longer resolves cannot smuggle a stale sentence
   * into the prompt, and two videos in one message are both described instead of
   * only the last one.
   */
  private readonly videoNotes = new Map<string, string>();
  /** Makes every id unique within a session, so an old id cannot resolve to a new image. */
  private attachmentSerial = 0;

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
    // An id belongs to the session that minted it: a chip the webview still holds
    // after a reset must not resolve to an image the new session never saw.
    this.clearAttachments();
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
    // The prepared bytes belong to the webview that held their ids; once it is
    // gone nothing can refer to them, and keeping them alive keeps memory nothing
    // can use.
    this.clearAttachments();

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
   * Prepares the bytes that just arrived and answers the webview once.
   *
   * Both entry points — bytes the webview already holds and files the host read
   * from a dialog — end here, because everything after "here are some bytes" is
   * the same: the count gate, pi's helpers, the store, and one reply that says what
   * was added and what was refused.
   *
   * `refusals` carries the failures that happened before the bytes existed (a file
   * the dialog offered but the disk would not read), so one request gets one answer
   * instead of a reply per file.
   *
   * `notes` runs parallel to `candidates` and carries, for a still taken from a
   * video, the line that says so. It is the only thing that tells the model these
   * images are frames of a moving picture, so it is stored with them rather than
   * sent to the webview.
   */
  private async acceptAttachments(
    candidates: readonly PrepareImageInput[],
    refusals: readonly AttachmentRefusal[] = [],
    notes?: readonly (string | undefined)[],
  ): Promise<void> {
    // Nothing arrived and nothing failed: there is nobody to answer. A cancelled
    // dialog lands here, and answering it would read as a refusal.
    if (candidates.length === 0 && refusals.length === 0) {
      return;
    }

    const refused: AttachmentRefusal[] = [...refusals];

    if (this.attachments.size + candidates.length > ATTACHMENT_LIMITS.maxCount) {
      // The whole batch is refused rather than the overflow: which images fit is
      // the owner's decision, not the panel's.
      const overLimit =
        `Ya hay ${this.attachments.size} imágenes adjuntas y el máximo por mensaje es ` +
        `${ATTACHMENT_LIMITS.maxCount}; no se añadió ninguna de las ` +
        `${candidates.length} que llegaron.`;
      for (const candidate of candidates) {
        refused.push({ name: candidateName(candidate), reason: overLimit });
      }
      this.post({ type: "attachments", added: [], refused });
      return;
    }

    const added: WebviewAttachment[] = [];

    if (candidates.length > 0) {
      const tools = await this.host.imageTools?.();
      if (!tools) {
        // One refusal for the batch: the failure is a fact about this pi, not about
        // any one file. Reported rather than silently dropped, because an image that
        // disappears without a word is worse than one the panel says it cannot send.
        refused.push({
          name:
            candidates.length === 1
              ? candidateName(candidates[0])
              : `${candidates.length} imágenes`,
          reason:
            "No se pueden adjuntar imágenes: este pi no publica las funciones que las " +
            "preparan. Actualiza pi para adjuntarlas, o envía el mensaje solo con el texto.",
        });
        this.post({ type: "attachments", added, refused });
        return;
      }

      for (const [index, candidate] of candidates.entries()) {
        const outcome = await prepareImage(tools, candidate, ATTACHMENT_LIMITS);
        if (!outcome.ok) {
          refused.push({ name: candidateName(candidate), reason: outcome.reason });
          continue;
        }
        const id = this.nextAttachmentId();
        this.attachments.set(id, outcome.image);
        // A still taken from a video carries the line that says so. Storing it under
        // the id means the prompt repeats it for exactly as long as one of that
        // video's stills is still attached, and never after.
        const note = notes?.[index];
        if (note !== undefined) {
          this.videoNotes.set(id, note);
        }
        added.push({
          id,
          mimeType: outcome.image.mimeType,
          width: outcome.image.width,
          height: outcome.image.height,
          resized: outcome.image.resized,
          // The webview draws the thumbnail from this URL and never holds the raw
          // base64, so what it could send back stays what it already had.
          dataUrl: `data:${outcome.image.mimeType};base64,${outcome.image.data}`,
        });
      }
    }

    this.post({ type: "attachments", added, refused });
  }

  /**
   * Reads the files a dialog returned and prepares each one for the wire.
   *
   * An image is read and handed to the image pipeline. A video is sampled with
   * ffmpeg and every still takes that same route, so the count gate, the store and
   * the answer to the webview do not change: a video is a small batch of images that
   * arrived through a different door. The owner sees each still as its own chip and
   * can drop the ones that do not belong.
   */
  private async acceptPickedFiles(chosen: readonly vscode.Uri[]): Promise<void> {
    const candidates: PrepareImageInput[] = [];
    /** Parallel to `candidates`: the video note a still carries, when it is one. */
    const notes: (string | undefined)[] = [];
    const refusals: AttachmentRefusal[] = [];
    const videos: PickedVideo[] = [];

    for (const uri of chosen) {
      const name = uriName(uri);
      if (name !== undefined && VIDEO_EXTENSIONS.includes(extensionOf(name))) {
        videos.push({ uri, name });
        continue;
      }
      try {
        const candidate: PrepareImageInput = { bytes: await vscode.workspace.fs.readFile(uri) };
        if (name !== undefined) {
          candidate.name = name;
        }
        candidates.push(candidate);
        notes.push(undefined);
      } catch (error) {
        // A chosen file the disk will not give up is one refusal, not a failed
        // batch: the other files still deserve to be attached.
        refusals.push({
          name: name ?? "imagen",
          reason:
            "No se pudo adjuntar la imagen. No se pudo leer el archivo: " + toErrorMessage(error),
        });
      }
    }

    if (videos.length > 0) {
      // Resolved once for the whole run: four stills must not mean four searches of
      // the PATH, and one missing ffmpeg is one fact about this machine rather than
      // one per file.
      const ffmpeg = resolveFfmpeg(readFfmpegPath());
      for (const video of videos) {
        if (ffmpeg === undefined) {
          refusals.push({
            name: video.name,
            reason:
              "No se pudo adjuntar el vídeo. No se encontró ffmpeg, que es el programa que " +
              `extrae sus fotogramas: instálalo con \`${ffmpegInstallHint()}\` o indica su ` +
              "ruta en picode.media.ffmpegPath. PiCode no incluye ffmpeg.",
          });
          continue;
        }
        const stills = await this.readVideoStills(video, ffmpeg);
        if ("reason" in stills) {
          refusals.push({ name: video.name, reason: stills.reason });
          continue;
        }
        const note = formatVideoNote(stills.frames, stills.probe, video.name);
        for (const frame of stills.frames) {
          candidates.push({ bytes: frame.bytes, name: video.name });
          // Every still of one video carries the same line; the prompt says it once.
          // Two videos carry two different lines, so both are described.
          notes.push(note);
        }
      }
    }

    await this.acceptAttachments(candidates, refusals, notes);
  }

  /**
   * Samples a video into stills, or says why it cannot.
   *
   * The size is checked first and against the file's own metadata: refusing a 2 GB
   * recording has to cost a stat rather than a read, and ffmpeg must not run over a
   * file PiCode already knows it will not send.
   */
  private async readVideoStills(
    video: PickedVideo,
    ffmpeg: string,
  ): Promise<{ frames: VideoFrame[]; probe: VideoProbe } | { reason: string }> {
    let size: number;
    try {
      const stats = await vscode.workspace.fs.stat(video.uri);
      size = stats.size;
    } catch (error) {
      return {
        reason:
          "No se pudo adjuntar el vídeo. No se pudo leer el archivo: " + toErrorMessage(error),
      };
    }
    if (size > VIDEO_LIMITS.maxBytes) {
      return {
        reason:
          `No se pudo adjuntar el vídeo. Pesa ${formatBytes(size)} y el límite por archivo ` +
          `es ${formatBytes(VIDEO_LIMITS.maxBytes)}. Recórtalo antes de adjuntarlo.`,
      };
    }

    const file = video.uri.fsPath;
    const outcome = await probeVideo(runFfmpeg, ffmpeg, file);
    if (!outcome.ok) {
      return { reason: `No se pudo adjuntar el vídeo. ${outcome.reason}` };
    }
    const frames = await extractFrames(runFfmpeg, ffmpeg, file, outcome.probe);
    if (frames.length === 0) {
      return {
        reason:
          `No se pudo adjuntar el vídeo. ffmpeg no devolvió ningún fotograma legible de ` +
          `${video.name}; comprueba que el archivo se reproduzca y que ffmpeg sea una ` +
          "versión completa.",
      };
    }
    return { frames, probe: outcome.probe };
  }

  /**
   * Resolves the ids a prompt submitted against the store.
   *
   * The count of ids that no longer resolve is returned rather than thrown away,
   * because a chip the panel is still drawing over nothing has to be noticed. The
   * video notes travel back with the images, deduplicated, so one video is described
   * once however many of its stills are attached.
   */
  private resolveAttachments(value: unknown): {
    images: PreparedImage[];
    notes: string[];
    missing: number;
  } {
    const images: PreparedImage[] = [];
    const notes: string[] = [];
    let missing = 0;
    if (!Array.isArray(value)) {
      return { images, notes, missing };
    }

    for (const id of value) {
      // The payload crosses the webview boundary, so nothing about it is trusted:
      // an entry that is not a string is not an id.
      if (typeof id !== "string") {
        continue;
      }
      const image = this.attachments.get(id);
      if (image === undefined) {
        missing += 1;
        continue;
      }
      images.push(image);
      const note = this.videoNotes.get(id);
      if (note !== undefined && !notes.includes(note)) {
        notes.push(note);
      }
    }
    return { images, notes, missing };
  }

  /** The next id, unique within the session that mints it. */
  private nextAttachmentId(): string {
    this.attachmentSerial += 1;
    return `attachment-${this.attachmentSerial}`;
  }

  /**
   * Drops every prepared image and the note that explained it.
   *
   * Called when the message has been sent, when the session changes, and when the
   * view goes away: an id only means something inside the session that minted it,
   * and a note names stills that no longer exist.
   */
  private clearAttachments(): void {
    this.attachments.clear();
    this.videoNotes.clear();
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
      case "attachBytes": {
        // The bytes the webview already holds, from a paste or a drop. Nothing is
        // prepared here that the store will not own: the count gate and pi's format
        // detection run now, while the owner is still looking at the image.
        await this.acceptAttachments(readImageCandidates(message.images));
        break;
      }
      case "pickImages": {
        // The webview cannot open a file dialog, so the choosing happens here and
        // the bytes never reach the webview in a form it could send back.
        const chosen = await vscode.window.showOpenDialog({
          title: "PiCode: adjuntar archivos",
          openLabel: "Adjuntar",
          canSelectMany: true,
          filters: {
            Imágenes: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
            Vídeos: [...VIDEO_EXTENSIONS],
          },
        });
        // A cancelled dialog answers with nothing at all: an empty `attachments`
        // message would read as a refusal of something the owner never chose.
        if (chosen === undefined || chosen.length === 0) {
          break;
        }

        await this.acceptPickedFiles(chosen);
        break;
      }
      case "detachAttachment": {
        // An unknown id is not an error: the webview may drop a chip the store has
        // already forgotten, and there is nothing to say about that.
        if (typeof message.id === "string") {
          this.attachments.delete(message.id);
          // Its note goes with it: a line describing stills that are no longer
          // attached would tell the model about images it will never receive.
          this.videoNotes.delete(message.id);
        }
        break;
      }
      case "clearAttachments": {
        this.clearAttachments();
        break;
      }
      case "prompt": {
        const text = typeof message.text === "string" ? message.text.trim() : "";
        if (text.length === 0 || !this.client) {
          return;
        }

        // The bytes were prepared when the image was added, so submitting only
        // carries ids. An id that no longer resolves is a chip the panel is still
        // drawing over nothing, and it is said once rather than lost silently.
        const { images, notes, missing } = this.resolveAttachments(message.attachmentIds);
        if (missing > 0) {
          this.post({
            type: "error",
            message:
              missing === 1
                ? "Una imagen adjunta ya no está disponible y no se envió; vuelve a adjuntarla si la querías incluir."
                : `${missing} imágenes adjuntas ya no están disponibles y no se enviaron; ` +
                  "vuelve a adjuntarlas si las querías incluir.",
          });
        }

        // The notes go before the owner's words, like the editor-context block: what
        // PiCode adds is a preamble, and the message itself comes last. The video note
        // comes first because it says what the images are before the image note says
        // how big they are.
        const preamble = [...notes];
        const note = formatAttachmentNote(images);
        if (note !== undefined) {
          preamble.push(note);
        }
        // Collected at send time, not when the panel opened, so it describes the
        // editor as it is when the message is actually sent.
        const body = composePrompt(text, this.attachContext ? collectReferences() : []);
        const outgoing = preamble.length === 0 ? body : `${preamble.join("\n")}\n\n${body}`;

        this.postStatus("running");
        try {
          await this.client.prompt(
            outgoing,
            images.length > 0 ? { images: images.map(toPiImageContent) } : undefined,
          );
        } catch (error) {
          this.postStatus("error");
          this.post({ type: "error", message: toErrorMessage(error) });
          // The attachments stay: sending failed, and retrying should not mean
          // attaching again.
          break;
        }
        // Sent: the panel is composing a different message now, and the ids of the
        // last one must not resolve into it.
        this.clearAttachments();
        this.post({ type: "attachmentsCleared" });
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

/** One attachment the panel may draw, as the webview receives it. */
interface WebviewAttachment {
  id: string;
  mimeType: string;
  width?: number;
  height?: number;
  resized: boolean;
  /** The bytes as a URL the webview renders and cannot send back whole. */
  dataUrl: string;
}

/** One attachment that did not make it, and why, for the panel to show. */
interface AttachmentRefusal {
  name: string;
  reason: string;
}

/** The label a refusal uses for a candidate the webview never named. */
function candidateName(candidate: PrepareImageInput): string {
  return typeof candidate.name === "string" && candidate.name.length > 0
    ? candidate.name
    : "imagen";
}

/** The file's own name, from the URI a dialog returned. */
function uriName(uri: vscode.Uri): string | undefined {
  const name = uri.fsPath.split(/[\\/]/).pop();
  return name !== undefined && name.length > 0 ? name : undefined;
}

/** A chosen file that has to be sampled with ffmpeg. */
interface PickedVideo {
  uri: vscode.Uri;
  name: string;
}

/**
 * The video containers the picker offers, which is also how a chosen file is routed.
 *
 * Membership is decided by extension alone, because the file has not been read yet:
 * a container ffmpeg cannot open is refused later with ffmpeg's own words, which is
 * a better answer than a guess made here.
 */
const VIDEO_EXTENSIONS: readonly string[] = ["mp4", "mov", "m4v", "webm", "mkv", "avi"];

/** The lowercase extension of a file name, without the dot. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The configured ffmpeg, exactly as the setting holds it. */
function readFfmpegPath(): string {
  const configured = vscode.workspace
    .getConfiguration("picode.media")
    .get<string>("ffmpegPath", "");
  return typeof configured === "string" ? configured : "";
}

/**
 * Runs ffmpeg as a child process.
 *
 * `video.ts` takes a `CommandRunner` rather than spawning anything itself, which is
 * what lets its logic be tested without ffmpeg installed. This is the real one, and
 * it is the only place the video path touches the machine: nothing is written to
 * disk, because both the probe and each frame come back on a stream.
 */
const runFfmpeg: CommandRunner = {
  run(command, args) {
    return new Promise((resolve) => {
      const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
      let child;
      try {
        child = spawn(command, [...args], {
          shell: needsShell,
          windowsHide: true,
          env: { ...process.env, NO_COLOR: "1" },
        });
      } catch (error) {
        resolve({ code: null, stdout: new Uint8Array(0), stderr: toErrorMessage(error) });
        return;
      }

      const chunks: Buffer[] = [];
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      // A binary that cannot be started, or that a permission denies, reports on
      // `error` instead of closing with a code; either way ffmpeg said nothing, and
      // the probe turns that into a refusal naming the install command.
      child.on("error", (error) => {
        resolve({ code: null, stdout: new Uint8Array(0), stderr: `${stderr}${error.message}` });
      });
      child.on("close", (code) => {
        resolve({ code, stdout: Uint8Array.from(Buffer.concat(chunks)), stderr });
      });
    });
  },
};

/** A byte count the way the refusal message reads it. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) {
    return `${Math.round(kilobytes)} KB`;
  }
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}

/**
 * Reads the attachments a webview message carried.
 *
 * The payload crosses the webview boundary, so nothing about it is trusted: an
 * entry that is not an object with a non-empty `data` string is skipped rather than
 * sent anywhere. The claimed type is only passed along as a label for the refusal
 * message — pi's detector decides the real one, so a webview that lies about it
 * changes nothing.
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
    const candidate: PrepareImageInput = { base64: entry.data };
    if (typeof entry.mimeType === "string" && entry.mimeType.length > 0) {
      candidate.claimedMimeType = entry.mimeType;
    }
    if (typeof entry.name === "string" && entry.name.length > 0) {
      candidate.name = entry.name;
    }
    candidates.push(candidate);
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
