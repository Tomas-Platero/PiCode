import * as vscode from "vscode";
import {
  describeGentle,
  describeUpdate,
  describeVersions,
  summarizeGentle,
  GENTLE_PACKAGE,
  type GentleState,
  type GentleUpdateReport,
} from "./gentle";
import type { GentleActions } from "./menu";
import { buildWebviewHtml } from "./webview-html";

/**
 * Gentle AI's own panel, in its own activity-bar container.
 *
 * The editor decides that a container opens a sidebar, so the icon on the left opens
 * this: the layer's real state, one line per reading it gives, the commands it
 * registered in this session, and the switches that are the owner's. Nothing here is
 * a second implementation of Gentle AI — the state comes from the same builder and
 * every action ends in the same runner the popup's Gentle AI category is wired to,
 * which is why the two surfaces cannot disagree about what Gentle AI is doing.
 */

/**
 * The buttons the panel draws, by id.
 *
 * The ids are the panel's own vocabulary, not a copy of the popup's row names: each
 * one is resolved by the host into the `GentleActions` method the popup calls, so
 * there is one runner behind both surfaces.
 */
export type GentleActionId =
  | "install"
  | "update"
  | "review"
  | "telemetry-enable"
  | "telemetry-disable"
  | "telemetry-preview"
  | "sdd-status"
  | "doctor";

/**
 * What the panel may ask the host to run.
 *
 * A command row is not one of the action buttons — the panel draws those from the
 * session's own command list, under their own heading — but it is the same kind of
 * request: the id plus, for a command, the command itself.
 */
export type GentleRunId = GentleActionId | "command";

export interface GentleActionRow {
  id: GentleActionId;
  label: string;
  detail?: string;
  /**
   * The editor's primary surface. Only installing Gentle AI changes the setup itself;
   * the rest are switches, and a column of primary buttons says nothing.
   */
  primary?: boolean;
}

/**
 * The actions worth offering for this state.
 *
 * The list mirrors the popup's Gentle AI category row for row — install while the
 * package is missing, the switches once it is there — and the telemetry choices are
 * three buttons rather than the popup's submenu, because a sidebar has no quick pick
 * to open. What matters is that both surfaces end in the same runner.
 *
 * The update row exists only while there is one: an update button that installs the
 * version already installed is a button that lies about what it does, and the version
 * line above it already says the layer is current. It is primary because it is the same
 * kind of act as installing — it changes the setup rather than flipping a switch.
 */
export function buildGentleActions(
  state: GentleState,
  update?: GentleUpdateReport,
): GentleActionRow[] {
  if (!state.installed) {
    return [
      {
        id: "install",
        label: `Instalar ${GENTLE_PACKAGE}`,
        detail: `Se instalará con pi install npm:${GENTLE_PACKAGE}`,
        primary: true,
      },
    ];
  }

  const rdd = state.review.rdd;
  return [
    ...(update?.available ? [updateRow(update)] : []),
    {
      id: "review",
      label:
        rdd === "on"
          ? "Desactivar la revisión por candidato"
          : "Activar la revisión por candidato",
      detail:
        rdd === "unknown"
          ? "gentle-ai no informó del estado de RDD"
          : `RDD ${rdd} · global ${state.review.global}, clon ${state.review.cloneLocal}`,
    },
    {
      id: "telemetry-enable",
      label: "Activar la telemetría anónima",
      detail: "Envío desactivado hasta que lo actives aquí",
    },
    {
      id: "telemetry-disable",
      label: "Desactivar la telemetría anónima",
      detail: "Nada sale de esta máquina",
    },
    {
      id: "telemetry-preview",
      label: "Ver qué enviaría la telemetría",
      detail: "Ejecuta gentle-ai telemetry preview",
    },
    {
      id: "sdd-status",
      label: "Fase del cambio activo (SDD)",
      detail: "Ejecuta gentle-ai sdd-status",
    },
    {
      id: "doctor",
      label: "Diagnóstico del ecosistema",
      detail: "Ejecuta gentle-ai doctor",
    },
  ];
}

/**
 * The one row that carries the update, naming the version it installs.
 *
 * The names come from the report rather than from a second reading, and `describeUpdate`
 * is not reused here: the headline already names the version in the panel, while the
 * button has to say what it will run.
 */
function updateRow(update: GentleUpdateReport): GentleActionRow {
  const behind = update.packages.filter((pair) => pair.latest !== undefined);
  const versions = behind.map((pair) => `${pair.name} ${pair.latest ?? ""}`).join(" y ");
  return {
    id: "update",
    label: "Actualizar Gentle AI",
    detail: `Instala ${versions} con el mismo pi install que la instalación`,
    primary: true,
  };
}

/**
 * The host side of the panel.
 *
 * `gentle` is the popup's own port, passed in rather than imported: this module must
 * not import the entry point that registers it, and the same object on both surfaces
 * is what keeps them from drifting.
 */
export interface GentleViewHost {
  gentle: GentleActions;
  /** Runs one of the panel's requests, by id. The command is set for command rows. */
  runAction(id: GentleRunId, command?: string): Promise<void>;
  /**
   * What the registry publishes for each package of the layer, against what is
   * installed. Injected for the same reason the state is: the panel renders readings, it
   * does not take them, and the two packages are read once in the host and cached there.
   */
  update(): Promise<GentleUpdateReport>;
}

export class GentleView implements vscode.WebviewViewProvider {
  public static readonly viewId = "picode.gentle";

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly host: GentleViewHost,
  ) {}

  public static create(extensionUri: vscode.Uri, host: GentleViewHost): GentleView {
    return new GentleView(extensionUri, host);
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
        void this.handleMessage(message);
      },
      null,
      this.disposables,
    );
    view.onDidDispose(() => this.releaseView(), null, this.disposables);

    await this.pushState();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.releaseView();
  }

  /** Re-reads the state, for when the panel is already open and something changed. */
  public async refresh(): Promise<void> {
    await this.pushState();
  }

  private releaseView(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.view = undefined;
  }

  private post(message: unknown): void {
    if (this.view === undefined || this.disposed) {
      return;
    }
    void this.view.webview.postMessage(message);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== "string") {
      return;
    }

    switch (message.type) {
      case "ready": {
        await this.pushState();
        break;
      }
      case "run": {
        const id = message.action;
        if (!isRunId(id)) {
          break;
        }
        const command = typeof message.command === "string" ? message.command : undefined;
        try {
          await this.host.runAction(id, command);
          // The action may have changed anything the panel reads — it installs the
          // package, flips a switch the status line reports — so the state is asked
          // for again instead of being patched here with a guess.
          await this.pushState();
        } catch (error) {
          // Reported in the panel, not swallowed: the editor's own notification can be
          // gone by the time the owner looks back at the sidebar.
          this.post({ type: "error", message: `La acción no terminó: ${describeError(error)}` });
        }
        break;
      }
      default:
        break;
    }
  }

  private async pushState(): Promise<void> {
    if (this.view === undefined) {
      return;
    }
    try {
      const state = await this.host.gentle.state();
      // A check that cannot be taken is itself a state the panel states out loud, so a
      // failure here never turns into a blank line under the version heading.
      const update = await this.readUpdate();
      this.post({
        type: "state",
        state,
        // The phrasing is not written here. Both readings come from gentle.ts, so the
        // panel and the popup describe the same situation with the same words.
        summary: summarizeGentle(state),
        lines: describeGentle(state),
        commands: state.commands,
        actions: buildGentleActions(state, update),
        version: { headline: describeUpdate(update), lines: describeVersions(update) },
      });
    } catch (error) {
      this.post({
        type: "error",
        message: `No se pudo leer el estado de Gentle AI: ${describeError(error)}`,
      });
    }
  }

  private async readUpdate(): Promise<GentleUpdateReport> {
    try {
      return await this.host.update();
    } catch {
      // An empty report is the panel's own way of saying the check failed, and it is
      // reached only if the host's own reading — which already reports its failures —
      // threw anyway.
      return { packages: [], available: false };
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    // The mark is the brand's own logo, which only a panel can draw: the activity bar
    // masks its icon, so `gentle.svg` is the silhouette there. As in the chat panel,
    // the webview cannot spell a URL into the extension's media directory, so the host
    // resolves it with `asWebviewUri` while the document is built and the renderer
    // reads the answer back out of the markup.
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "gentle-logo.png"),
    );
    return buildWebviewHtml({
      webview,
      extensionUri: this.extensionUri,
      title: "PiCode: Gentle AI",
      body: gentleBody(logoUri.toString()),
      scripts: ["gentle.js"],
      styles: ["main.css", "gentle.css"],
    });
  }
}

function gentleBody(logoUri: string): string {
  return `    <header class="gentle-head">
      <img id="logo" class="gentle-logo" alt="" data-gentle-logo="${logoUri}" />
      <div class="gentle-title">
        <span class="gentle-name">Gentle AI</span>
        <span id="summary" class="gentle-summary">leyendo…</span>
      </div>
    </header>
    <p id="notice" class="gentle-notice" hidden></p>
    <p class="section">Estado</p>
    <div id="lines" class="gentle-lines"></div>
    <p class="section">Versión</p>
    <div id="version" class="gentle-version"></div>
    <p class="section">Comandos</p>
    <div id="commands" class="gentle-commands"></div>
    <p class="section">Acciones</p>
    <div id="actions" class="gentle-actions"></div>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRunId(value: unknown): value is GentleRunId {
  return (
    value === "install" ||
    value === "update" ||
    value === "review" ||
    value === "telemetry-enable" ||
    value === "telemetry-disable" ||
    value === "telemetry-preview" ||
    value === "sdd-status" ||
    value === "doctor" ||
    value === "command"
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
