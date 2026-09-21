import * as vscode from "vscode";
import { buildCategories, type PiCategoryId, type PiCategoryRow, type PiMenuSnapshot } from "./menu";
import { buildWebviewHtml } from "./webview-html";

const AJUSTES_BODY = `    <div class="card">
      <div class="card-row"><span class="card-label">pi</span><span id="card-runtime" class="card-value">leyendo…</span></div>
      <div class="card-row"><span class="card-label">Modelo</span><span id="card-model" class="card-value">—</span></div>
      <div class="card-row"><span class="card-label">Razonamiento</span><span id="card-thinking" class="card-value">—</span></div>
      <div class="card-row"><span class="card-label">Extensiones</span><span id="card-extensions" class="card-value">—</span></div>
    </div>
    <button id="menu" class="primary wide" type="button">Abrir el menú de pi</button>
    <p class="section">Categorías</p>
    <div id="categories" class="categories"></div>`;

/**
 * The launcher the owner asked to reach from an icon on the left.
 *
 * A view container opens a sidebar, not a popup — the editor decides that, not the
 * extension — so the icon opens this: the live state at a glance and one button per
 * category, and the popup itself is one click away, in the same categories the popup
 * uses. The rows come from the same builder as the popup, so the two surfaces can
 * never disagree about a label.
 */
export interface AjustesViewHost {
  snapshot(): Promise<PiMenuSnapshot>;
  openMenu(category?: PiCategoryId): Promise<void>;
  /**
   * Called when the panel is shown, which is what clicking the icon does.
   *
   * A view container can only open a sidebar, so the icon cannot run a command by
   * itself; showing the panel is the closest the editor offers, and the host
   * decides from there whether a popup is appropriate.
   */
  autoOpenMenu(): Promise<void>;
}

export class AjustesView implements vscode.WebviewViewProvider {
  public static readonly viewId = "picode.ajustes";

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly host: AjustesViewHost,
  ) {}

  public static create(extensionUri: vscode.Uri, host: AjustesViewHost): AjustesView {
    return new AjustesView(extensionUri, host);
  }

  public async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.releaseView();
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = buildWebviewHtml({
      webview: view.webview,
      extensionUri: this.extensionUri,
      title: "PiCode: ajustes de pi",
      body: AJUSTES_BODY,
      scripts: ["ajustes.js"],
      styles: ["main.css", "ajustes.css"],
    });
    view.webview.onDidReceiveMessage(
      (message: unknown) => {
        void this.handleMessage(message);
      },
      null,
      this.disposables,
    );
    view.onDidDispose(() => this.releaseView(), null, this.disposables);

    // The panel's whole purpose is the popup, so it opens it on being shown rather
    // than asking for a second click.
    await this.host.autoOpenMenu();
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
    if (typeof message !== "object" || message === null) {
      return;
    }
    const record = message as Record<string, unknown>;

    switch (record.type) {
      case "ready": {
        await this.pushState();
        break;
      }
      case "refresh": {
        await this.pushState();
        break;
      }
      case "openMenu": {
        const category = record.category;
        await this.host.openMenu(isCategory(category) ? category : undefined);
        // The menu may have changed something, so the card is re-read once it closes.
        await this.pushState();
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
      const snapshot = await this.host.snapshot();
      const categories: PiCategoryRow[] = buildCategories(snapshot);
      this.post({ type: "state", snapshot, categories });
    } catch (error) {
      this.post({
        type: "error",
        message: `No se pudo leer el estado de pi: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}

function isCategory(value: unknown): value is PiCategoryId {
  return (
    value === "modelo" ||
    value === "extensiones" ||
    value === "runtime" ||
    value === "proveedores" ||
    value === "sesion"
  );
}
