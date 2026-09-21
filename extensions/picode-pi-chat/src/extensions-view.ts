import * as vscode from "vscode";
import {
  parseInstalledPackages,
  runPiCli,
  searchCatalog,
  type CatalogPackage,
  type InstalledPackage,
} from "./pi-cli";
import type { ResolvedRuntime } from "./runtime";
import { buildWebviewHtml } from "./webview-html";

const EXTENSIONS_BODY = `    <header class="toolbar">
      <button id="tab-installed" class="tab tab-active" type="button">Instaladas</button>
      <button id="tab-catalog" class="tab" type="button">Catálogo</button>
      <button id="refresh" class="secondary" type="button" title="Volver a leer la lista de pi">Actualizar</button>
    </header>
    <div class="runtime-strip">
      <span id="busy" class="runtime-chip">listo</span>
    </div>
    <section id="panel-installed" class="panel">
      <p id="installed-summary" class="summary">leyendo la lista de pi…</p>
      <ul id="installed" class="package-list"></ul>
      <p id="installed-raw" class="raw" hidden></p>
    </section>
    <section id="panel-catalog" class="panel" hidden>
      <form id="search-form" class="search">
        <input
          id="search-input"
          class="dropdown-filter"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="Buscar en el catálogo de pi…"
        />
        <button id="search-button" class="primary" type="submit">Buscar</button>
      </form>
      <p id="catalog-summary" class="summary"></p>
      <ul id="catalog" class="package-list"></ul>
    </section>
    <section id="log-section" class="log-section" hidden>
      <div class="log-head">
        <span class="log-title">Salida de pi</span>
        <button id="log-clear" class="secondary" type="button">Limpiar</button>
      </div>
      <pre id="log" class="log"></pre>
    </section>`;

/**
 * What the extensions view needs from the extension host.
 *
 * The runtime is resolved per call rather than captured, so switching pi does not
 * leave this view managing packages with the previous one.
 */
export interface ExtensionsViewHost {
  runtime(): ResolvedRuntime;
  /** Mirrors a CLI line into the PiCode output channel. */
  log(line: string): void;
  /** Confirms, then reports, a change pi only picks up after a restart. */
  offerRestart(what: string): void;
}

/**
 * Manages pi packages from the panel.
 *
 * This is PiCode's first non-RPC integration: pi installs, removes, updates and
 * lists its packages through its own CLI, and the RPC protocol does not expose
 * them. Everything here runs the CLI of the **active** runtime, so a package is
 * managed by the pi that will actually load it.
 */
export class ExtensionsView implements vscode.WebviewViewProvider {
  public static readonly viewId = "picode.extensions";

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly host: ExtensionsViewHost,
  ) {}

  public static create(extensionUri: vscode.Uri, host: ExtensionsViewHost): ExtensionsView {
    return new ExtensionsView(extensionUri, host);
  }

  public get isVisible(): boolean {
    return this.view !== undefined;
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
      title: "PiCode: extensiones de pi",
      body: EXTENSIONS_BODY,
      scripts: ["extensions.js"],
      styles: ["main.css", "extensions.css"],
    });
    view.webview.onDidReceiveMessage(
      (message: unknown) => {
        void this.handleMessage(message);
      },
      null,
      this.disposables,
    );
    view.onDidDispose(() => this.releaseView(), null, this.disposables);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.releaseView();
  }

  /** Re-reads the installed list, for the panel and for the status line. */
  public async refresh(): Promise<void> {
    await this.readInstalled();
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

  private setBusy(busy: boolean, label = "listo"): void {
    this.post({ type: "busy", busy, label });
  }

  private log(line: string): void {
    this.post({ type: "log", line });
    this.host.log(line);
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.setBusy(false, "error");
    this.post({ type: "error", message });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const record = message as Record<string, unknown>;

    switch (record.type) {
      case "ready": {
        await this.readInstalled();
        break;
      }
      case "readInstalled": {
        await this.readInstalled();
        break;
      }
      case "search": {
        const query = typeof record.query === "string" ? record.query : "";
        await this.search(query);
        break;
      }
      case "install": {
        const name = typeof record.name === "string" ? record.name : "";
        await this.install(name);
        break;
      }
      case "remove": {
        const source = typeof record.source === "string" ? record.source : "";
        await this.remove(source);
        break;
      }
      case "update": {
        await this.update();
        break;
      }
      default:
        break;
    }
  }

  private async readInstalled(): Promise<void> {
    try {
      this.setBusy(true, "leyendo…");
      const result = await runPiCli(this.host.runtime(), ["list"], undefined, (line) =>
        this.log(line),
      );
      const packages: InstalledPackage[] = parseInstalledPackages(result.text);
      this.post({ type: "installed", packages, raw: result.text });
      this.setBusy(false, `${packages.length} instalados`);
    } catch (error) {
      this.fail(error);
    }
  }

  private async search(query: string): Promise<void> {
    try {
      this.setBusy(true, "buscando…");
      const packages: CatalogPackage[] = await searchCatalog(query);
      this.post({ type: "catalog", packages, query });
      this.setBusy(false, `${packages.length} resultados`);
    } catch (error) {
      this.fail(error);
    }
  }

  private async install(name: string): Promise<void> {
    if (name.length === 0) {
      return;
    }

    // pi's own documentation is explicit that packages run with full system
    // access, so installing one is confirmed with a modal rather than a click in
    // a webview, and the exact command is shown.
    const answer = await vscode.window.showWarningMessage(
      `¿Instalar ${name} en pi?`,
      {
        modal: true,
        detail:
          "Los paquetes de pi ejecutan código con acceso completo al sistema. " +
          `Se instalará con "pi install npm:${name}" y se añadirá a tu configuración de pi.`,
      },
      "Instalar",
    );
    if (answer !== "Instalar") {
      return;
    }

    try {
      this.setBusy(true, "instalando…");
      const result = await runPiCli(
        this.host.runtime(),
        ["install", `npm:${name}`],
        undefined,
        (line) => this.log(line),
      );
      if (!result.ok) {
        throw new Error(`pi install terminó con código ${result.code ?? "desconocido"}`);
      }
      await this.readInstalled();
      this.host.offerRestart(`${name} quedó instalado`);
    } catch (error) {
      this.fail(error);
    }
  }

  private async remove(source: string): Promise<void> {
    if (source.length === 0) {
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      `¿Quitar ${source} de pi?`,
      { modal: true, detail: `Se ejecutará "pi remove ${source}".` },
      "Quitar",
    );
    if (answer !== "Quitar") {
      return;
    }

    try {
      this.setBusy(true, "quitando…");
      const result = await runPiCli(this.host.runtime(), ["remove", source], undefined, (line) =>
        this.log(line),
      );
      if (!result.ok) {
        throw new Error(`pi remove terminó con código ${result.code ?? "desconocido"}`);
      }
      await this.readInstalled();
      this.host.offerRestart(`${source} quedó fuera`);
    } catch (error) {
      this.fail(error);
    }
  }

  private async update(): Promise<void> {
    try {
      this.setBusy(true, "actualizando…");
      const result = await runPiCli(
        this.host.runtime(),
        ["update", "--extensions"],
        undefined,
        (line) => this.log(line),
      );
      if (!result.ok) {
        throw new Error(`pi update terminó con código ${result.code ?? "desconocido"}`);
      }
      await this.readInstalled();
      this.host.offerRestart("las extensiones quedaron actualizadas");
    } catch (error) {
      this.fail(error);
    }
  }
}
