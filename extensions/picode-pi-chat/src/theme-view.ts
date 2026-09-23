/*
 * The theme panel: the tab that browses themes, previews one and applies it.
 *
 * It is the drawing half of the feature and nothing else. Which themes exist, what one looks
 * like once painted, and what applying it does are `theme-service.ts`'s three answers, and
 * this module only routes them: the webview asks, the service answers, the webview paints.
 * The one thing it does own is **what a message may reach**: a webview is a document this
 * extension does not control, so the only URL it can talk the host into opening is the site
 * that previews themes, and the only command it can ask for is the reload the service said
 * was needed.
 *
 * That is also why the panel reuses `buildWebviewHtml` instead of writing its own document:
 * the content security policy and the script nonce exist once for every panel in this
 * extension, and a second copy is how one of them ends up without a nonce — a webview that
 * renders its markup and then does nothing, silently.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { RELOAD_WINDOW_LABEL } from "./instance-import-command";
import { DEFAULT_REGISTRY_BASE } from "./theme-catalog";
import {
  createThemeService,
  registryBaseFrom,
  type ApplyResult,
  type ThemeRow,
  type ThemeService,
} from "./theme-service";
import { buildWebviewHtml } from "./webview-html";

/** The command the palette, the popup menu and the settings row all run. */
export const SELECT_THEME_COMMAND = "picode.piChat.selectTheme";

/** The site that previews themes, and the only host this panel may open. */
export const GALLERY_HOST = "vscodethemes.com";

/**
 * The only external URL a message from the webview may open.
 *
 * The check is a host comparison and a scheme comparison, not a prefix match on the whole
 * URL: `https://vscodethemes.com.example.test` starts with the string and is somebody else's
 * machine, which is exactly the mistake a `startsWith` here would make.
 */
export function externalUrlToOpen(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  return host === GALLERY_HOST || host.endsWith(`.${GALLERY_HOST}`) ? parsed.toString() : undefined;
}

/**
 * The registry base of the running product, read from the tree this extension ships in.
 *
 * `product.json` sits two levels above an extension (`<app>/extensions/<id>`), which is the
 * same walk `runtime.ts` does to find the pi runtime — the app tree is what both are after.
 * In a development host there is no such file and the fallback is the gallery PiCode ships,
 * so the panel works in both shapes.
 */
export function registryBaseFor(extensionUri: vscode.Uri): string {
  try {
    const product = path.resolve(extensionUri.fsPath, "..", "..", "product.json");
    return registryBaseFrom(JSON.parse(readFileSync(product, "utf8")));
  } catch {
    return DEFAULT_REGISTRY_BASE;
  }
}

/**
 * What the owner reads after a theme was applied.
 *
 * Two facts and no more: which theme, and whether the editor knows it yet. A path is never
 * part of it — the owner chose a theme, not a file — and the reload is named only when the
 * service said it changes something.
 */
export function appliedMessage(row: ThemeRow, themeId: string, result: ApplyResult): string {
  const label = row.themes.find((theme) => theme.id === themeId)?.label ?? themeId;
  const how = result.installed ? " instalado y aplicado" : " aplicado";
  const reload = result.needsReload
    ? ` El editor todavía no conoce el tema: ${RELOAD_WINDOW_LABEL} para verlo.`
    : "";
  return `Tema «${label}»${how}.${reload}`;
}

/**
 * The service, built over the editor.
 *
 * Every editor API the feature needs is named here once, so the service itself holds no
 * `vscode` and the whole of it — the install-then-apply decision included — is tested without
 * an editor. The cache lives under the extension's own global storage, inside PiCode's
 * profile, like everything else PiCode writes.
 */
export function themeServiceFor(context: vscode.ExtensionContext): ThemeService {
  return createThemeService({
    installedExtensions: () =>
      vscode.extensions.all.map((extension) => ({
        id: extension.id,
        extensionPath: extension.extensionPath,
        packageJSON: extension.packageJSON,
      })),
    configuration: () => ({
      current: () =>
        vscode.workspace.getConfiguration("workbench").get<string>("colorTheme"),
      apply: async (themeId: string) => {
        await vscode.workspace
          .getConfiguration("workbench")
          .update("colorTheme", themeId, vscode.ConfigurationTarget.Global);
      },
    }),
    install: async (extensionId: string) => {
      await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        extensionId,
      );
    },
    registryBase: registryBaseFor(context.extensionUri),
    cacheDir: path.join(context.globalStorageUri.fsPath, "themes"),
  });
}

const THEME_BODY = `    <div id="theme-root" class="theme-root"></div>`;

/** The panel: one tab per window, revealed rather than duplicated. */
export class ThemeView {
  public static readonly viewType = "picode.theme";

  public static create(context: vscode.ExtensionContext): ThemeView {
    return new ThemeView(context, themeServiceFor(context));
  }

  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** The rows the webview is looking at, so a message names one instead of carrying it. */
  private rows: readonly ThemeRow[] = [];

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: ThemeService,
  ) {}

  /** Opens the tab, revealing it rather than opening a second one. */
  public async show(): Promise<void> {
    if (this.panel !== undefined) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      ThemeView.viewType,
      "Temas",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
      },
    );
    this.panel = panel;
    panel.webview.html = buildWebviewHtml({
      webview: panel.webview,
      extensionUri: this.context.extensionUri,
      title: "Temas",
      body: THEME_BODY,
      scripts: ["theme-gallery.js", "theme.js"],
      styles: ["codicon.css", "main.css", "theme.css"],
    });
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.accept(message);
      }),
    );
    panel.onDidDispose(() => {
      this.dispose();
    });
  }

  public dispose(): void {
    for (;;) {
      const disposable = this.disposables.pop();
      if (disposable === undefined) {
        break;
      }
      disposable.dispose();
    }
    this.panel?.dispose();
    this.panel = undefined;
  }

  /**
   * What the webview asked for.
   *
   * Each branch is a message the gallery actually posts; anything else is ignored, because a
   * document cannot be trusted to send only what its own script sends.
   */
  private async accept(message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const request = message as Record<string, unknown>;
    const type = typeof request.type === "string" ? request.type : "";
    switch (type) {
      case "ready":
        await this.sendThemes("");
        return;
      case "search":
        await this.sendThemes(typeof request.query === "string" ? request.query : "");
        return;
      case "preview":
        await this.sendPreview(request);
        return;
      case "apply":
        await this.apply(request);
        return;
      case "openGallery":
        await this.openGallery(request);
        return;
      case "reload":
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
        return;
      default:
        return;
    }
  }

  /** The rows, from the installed extensions first and then from the gallery. */
  private async sendThemes(query: string): Promise<void> {
    const installed = this.service.installed();
    let catalog: readonly ThemeRow[] = [];
    let error: string | undefined;
    try {
      catalog = await this.service.catalog(query);
    } catch (cause) {
      // The installed themes are still worth showing: the panel works offline, and saying
      // why the rest is missing is more useful than an empty list.
      error = `No se pudo consultar el catálogo de temas (${cause instanceof Error ? cause.message : String(cause)}).`;
    }
    this.rows = [...installed, ...catalog];
    const current = this.service.current();
    void this.post({
      type: "themes",
      rows: this.rows,
      query,
      ...(current === undefined ? {} : { current }),
      ...(error === undefined ? {} : { error }),
    });
  }

  /** One theme, painted, or the reason it could not be read. */
  private async sendPreview(request: Record<string, unknown>): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === request.rowId);
    const themeId = typeof request.themeId === "string" ? request.themeId : "";
    const requestId = typeof request.requestId === "number" ? request.requestId : 0;
    if (row === undefined) {
      void this.post({ type: "preview", requestId, ok: false, reason: "Ese tema ya no está en la lista." });
      return;
    }
    const answer = await this.service.preview(row, themeId);
    if (!answer.ok) {
      void this.post({ type: "preview", requestId, ok: false, reason: answer.reason });
      return;
    }
    void this.post({
      type: "preview",
      requestId,
      ok: true,
      variant: answer.variant,
      preview: answer.preview,
    });
  }

  /** Applying one theme, and saying what happened. */
  private async apply(request: Record<string, unknown>): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === request.rowId);
    const themeId = typeof request.themeId === "string" ? request.themeId : "";
    if (row === undefined) {
      return;
    }
    let result: ApplyResult;
    try {
      result = await this.service.apply(row, themeId);
    } catch (cause) {
      void this.post({
        type: "applied",
        rowId: row.id,
        themeId,
        result: { applied: false, installed: false, needsReload: false },
        message: `No se pudo aplicar el tema: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      return;
    }
    void this.post({
      type: "applied",
      rowId: row.id,
      themeId,
      result,
      message: appliedMessage(row, themeId, result),
    });
    // The row is now installed, and the list says so — without a new search, because the
    // catalogue itself did not change.
    this.rows = this.rows.map((candidate) =>
      candidate.id === row.id ? { ...candidate, installed: true } : candidate,
    );
  }

  /** The one external destination a message can reach. */
  private async openGallery(request: Record<string, unknown>): Promise<void> {
    const url = typeof request.url === "string" ? request.url : "";
    const allowed = externalUrlToOpen(url);
    if (allowed === undefined) {
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(allowed));
  }

  private post(message: unknown): Thenable<boolean> | undefined {
    return this.panel?.webview.postMessage(message);
  }
}

/** Opens the panel. What every surface that offers the picker runs. */
export async function selectTheme(context: vscode.ExtensionContext): Promise<void> {
  const view = ThemeView.create(context);
  try {
    await view.show();
  } catch (error) {
    view.dispose();
    throw error;
  }
}
