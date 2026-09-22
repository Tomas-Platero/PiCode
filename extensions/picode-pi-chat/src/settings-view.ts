import * as vscode from "vscode";
import {
  describeSettingWire,
  describeSettings,
  PI_SETTING_DESCRIPTORS,
  PiSettingsService,
  type PiCodeConfigStore,
  type PiSettingDescriptor,
  type PiSettingOption,
  type PiSettingScope,
  type PiSettingValue,
  type SettingWire,
} from "./pi-settings";
import { buildWebviewHtml } from "./webview-html";
import type { PiModel } from "./protocol";

/**
 * The options tab: pi's own settings, in the editor's Settings layout.
 *
 * A `WebviewPanel` — an editor tab, not a floating dialog — with a search box and
 * a Global / Proyecto selector across the top, a fixed rail of category names down
 * the left, and the selected category's rows on the right. One panel per session:
 * showing it again reveals the existing tab instead of opening a second.
 *
 * The markup and the renderer live in `media/settings.{js,css}`; this class is the
 * host half, the same split the chat panel uses. Only serializable `SettingWire`
 * values cross the boundary: the descriptor closures stay on this side.
 */

const SETTINGS_BODY = `    <header class="settings-header">
      <div class="settings-search">
        <input id="settings-search" class="settings-search-input" type="text" placeholder="Buscar ajustes" spellcheck="false" />
      </div>
      <div class="settings-scope" role="tablist" aria-label="Ámbito">
        <button id="scope-global" class="scope-tab" type="button" role="tab" aria-selected="true">Global</button>
        <button id="scope-project" class="scope-tab" type="button" role="tab" aria-selected="false">Proyecto</button>
      </div>
    </header>
    <div class="settings-body">
      <nav id="settings-rail" class="settings-rail" aria-label="Categorías"></nav>
      <section id="settings-content" class="settings-content"></section>
    </div>`;

interface SettingsCategoryWire {
  id: string;
  label: string;
  description: string;
}

interface SettingsGroupWire {
  category: SettingsCategoryWire;
  settings: readonly SettingWire[];
}

/** The catalogue, reduced once to the shape the webview renders. */
const GROUPS: readonly SettingsGroupWire[] = describeSettings(PI_SETTING_DESCRIPTORS).map(
  (group) => ({
    category: {
      id: group.category.id,
      label: group.category.label,
      description: group.category.description,
    },
    settings: group.settings.map(describeSettingWire),
  }),
);

/**
 * The command each action row runs, by row key.
 *
 * The webview names the row it clicked and never the command: the command stays the
 * host's to resolve from the catalogue, so a rewritten webview document cannot ask
 * the host to run an arbitrary command id.
 */
const ACTION_COMMANDS: ReadonlyMap<string, string> = new Map(
  PI_SETTING_DESCRIPTORS.filter(
    (descriptor): descriptor is PiSettingDescriptor & { command: string } =>
      descriptor.kind === "action" && typeof descriptor.command === "string",
  ).map((descriptor) => [descriptor.key, descriptor.command]),
);

export interface SettingsViewOptions {
  /** Absolute path of pi's ESM entry, or undefined when no pi is installed. */
  resolveEntry(): string | undefined;
  /** Working directory whose project settings are read. */
  cwd(): string | undefined;
  /** The models pi has configured, for the provider/model dropdowns. */
  models(): Promise<readonly PiModel[]>;
  /** PiCode's own configuration, for the rows that live in the editor's settings. */
  picode(): PiCodeConfigStore | undefined;
  /**
   * Called after a value was written, with the value pi actually stored.
   *
   * A running pi holds its settings in memory: a write from here reaches the file
   * and not the process, so the host is the one that can push the change to the
   * live session — or restart it, when only a restart applies.
   */
  applied(key: string, value: PiSettingValue): Promise<void>;
}

const MODELS_TTL_MS = 10_000;

/**
 * The catalogue with the provider/model dropdown options filled from the session.
 *
 * The two rows are not the same shape. `defaultProvider` is a provider name.
 * `defaultModel` is a bare model **id**, because pi resolves the pair as
 * `getModel(defaultProvider, defaultModel)` — and an id can itself contain a slash
 * (`deepseek/deepseek-v4-pro` on this machine), so a composited `provider/id` value
 * would resolve to nothing and the default would be ignored in silence.
 *
 * The model list is therefore filtered by the provider already chosen: a pi cannot
 * resolve a model from a provider that does not offer it. With no provider set, every
 * id is offered and the label carries its provider so the two stay tellable apart.
 */
function groupsWithOptions(
  models: readonly PiModel[],
  values: Readonly<Record<string, PiSettingValue>>,
): readonly SettingsGroupWire[] {
  const providers = [
    ...new Set(
      models
        .map((model) => model.provider)
        .filter((provider): provider is string => typeof provider === "string"),
    ),
  ].sort((left, right) => left.localeCompare(right));

  const chosenProvider = values.defaultProvider;
  const provider =
    typeof chosenProvider === "string" && chosenProvider !== "" ? chosenProvider : undefined;

  const offered = models.filter(
    (model) => provider === undefined || model.provider === provider,
  );
  const seen = new Set<string>();
  const modelOptions: PiSettingOption[] = [];
  for (const model of [...offered].sort((left, right) => left.id.localeCompare(right.id))) {
    if (seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    modelOptions.push({
      value: model.id,
      // With no provider to filter by, the provider is what tells two same-named ids
      // apart; with one, it would just repeat the row above.
      label:
        provider === undefined && model.provider
          ? `${model.name ?? model.id} (${model.provider})`
          : (model.name ?? model.id),
    });
  }

  return GROUPS.map((group) => ({
    ...group,
    settings: group.settings.map((setting) => {
      if (setting.key === "defaultProvider") {
        return {
          ...setting,
          options: providers.map((name) => ({ value: name, label: name })),
        };
      }
      if (setting.key === "defaultModel") {
        return { ...setting, options: modelOptions };
      }
      return setting;
    }),
  }));
}

export class SettingsView {
  public static readonly viewType = "picode.settings";

  private panel: vscode.WebviewPanel | undefined;
  private service: PiSettingsService | undefined;
  private serviceError: string | undefined;
  private scope: PiSettingScope = "global";
  private startAt: string | undefined;
  private modelsCache: { models: readonly PiModel[]; at: number } | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly options: SettingsViewOptions,
  ) {}

  public static create(extensionUri: vscode.Uri, options: SettingsViewOptions): SettingsView {
    return new SettingsView(extensionUri, options);
  }

  /** Opens the tab, revealing it rather than duplicating it when it already exists. */
  public async show(startAt?: string): Promise<void> {
    if (this.panel === undefined) {
      this.createPanel();
    }
    this.panel?.reveal();
    if (startAt !== undefined) {
      this.startAt = startAt;
    }

    const service = await this.ensureService();
    if (service === undefined) {
      this.post({
        type: "error",
        message: this.serviceError ?? "No se pudo cargar la configuración de pi.",
      });
      return;
    }
    await this.pushState();
  }

  public dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.panel?.dispose();
    this.panel = undefined;
  }

  /**
   * The model new sessions should start with, as pi's own settings hold it.
   *
   * Read on demand rather than cached: the host re-applies it after starting a
   * session, and a running pi resolves a new session from settings it may hold
   * stale, so this is the value that keeps the two in step.
   */
  public async defaultModel(): Promise<string | undefined> {
    const service = await this.ensureService();
    if (service === undefined) {
      return undefined;
    }
    const values = await service.readAll("global").catch(() => undefined);
    const model = values?.defaultModel;
    return typeof model === "string" && model.trim() !== "" ? model : undefined;
  }

  private createPanel(): void {
    this.panel = vscode.window.createWebviewPanel(
      SettingsView.viewType,
      "PiCode: ajustes de pi",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
        retainContextWhenHidden: true,
      },
    );
    this.panel.webview.html = buildWebviewHtml({
      webview: this.panel.webview,
      extensionUri: this.extensionUri,
      title: "PiCode: ajustes de pi",
      body: SETTINGS_BODY,
      // The pure module first: `settings.js` reads `globalThis.PiCodePackageRows`
      // while it renders the packages table, so the reversed order would leave it
      // with nothing to draw from.
      scripts: ["package-rows.js", "settings.js"],
      // `codicon.css` belongs here and not only in the chat panel: the packages
      // table's action column is two icon-only buttons, and a `.codicon` class with
      // no stylesheet behind it paints an empty square — a button that looks
      // broken rather than one that looks unstyled.
      styles: ["codicon.css", "main.css", "settings.css"],
    });
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        void this.handleMessage(message);
      },
      null,
      this.disposables,
    );
    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
      },
      null,
      this.disposables,
    );
  }

  /** Builds the `SettingsManager` once and keeps it; re-reads it on later shows. */
  private async ensureService(): Promise<PiSettingsService | undefined> {
    if (this.service !== undefined) {
      return this.service;
    }
    if (this.serviceError !== undefined) {
      return undefined;
    }

    const entry = this.options.resolveEntry();
    if (entry === undefined) {
      this.serviceError = "No se encontró un pi instalado: instala pi para ver sus ajustes.";
      return undefined;
    }

    try {
      const picode = this.options.picode();
      this.service = await PiSettingsService.create({
        entry,
        cwd: this.options.cwd(),
        ...(picode === undefined ? {} : { picode }),
      });
      return this.service;
    } catch (error) {
      this.serviceError = `No se pudo leer la configuración de pi: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return undefined;
    }
  }

  /** pi's available models, cached briefly so a write does not re-query every time. */
  private async availableModels(): Promise<readonly PiModel[]> {
    const now = Date.now();
    if (this.modelsCache !== undefined && now - this.modelsCache.at < MODELS_TTL_MS) {
      return this.modelsCache.models;
    }
    const models = await this.options.models().catch(() => []);
    this.modelsCache = { models, at: now };
    return models;
  }

  private post(message: unknown): void {
    if (this.panel === undefined) {
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const record = message as Record<string, unknown>;

    switch (record.type) {
      case "ready": {
        const service = await this.ensureService();
        if (service === undefined) {
          this.post({
            type: "error",
            message: this.serviceError ?? "No se pudo cargar la configuración de pi.",
          });
          return;
        }
        await this.pushState();
        break;
      }
      case "setScope": {
        if (isScope(record.scope)) {
          this.scope = record.scope;
        }
        await this.pushState();
        break;
      }
      case "write": {
        const service = await this.ensureService();
        if (service === undefined) {
          this.post({ type: "error", message: this.serviceError ?? "No se pudo escribir." });
          return;
        }
        if (!isScope(record.scope) || typeof record.key !== "string") {
          return;
        }
        let written: PiSettingValue;
        try {
          written = await service.write(record.scope, record.key, record.value);
        } catch (error) {
          this.post({
            type: "writeError",
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        await this.options.applied(record.key, written);
        await this.pushState();
        break;
      }
      case "action": {
        if (typeof record.key !== "string") {
          return;
        }
        const command = ACTION_COMMANDS.get(record.key);
        if (command === undefined) {
          return;
        }
        try {
          await vscode.commands.executeCommand(command);
        } catch (error) {
          // Same surface as a failed write: the owner has to see that the action
          // did nothing rather than a button that silently stopped working.
          this.post({
            type: "writeError",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }
      case "refresh": {
        const service = await this.ensureService();
        await service?.reload();
        await this.pushState();
        break;
      }
      default:
        break;
    }
  }

  private async pushState(): Promise<void> {
    if (this.service === undefined || this.panel === undefined) {
      return;
    }
    try {
      const values = await this.service.readAll(this.scope);
      const groups = groupsWithOptions(await this.availableModels(), values);
      this.post({
        type: "state",
        scope: this.scope,
        groups,
        values,
        diagnostics: this.service.diagnostics(),
        ...(this.startAt !== undefined ? { startAt: this.startAt } : {}),
      });
      this.startAt = undefined;
    } catch (error) {
      this.post({
        type: "error",
        message: `No se pudo leer el estado de pi: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }
}

function isScope(value: unknown): value is PiSettingScope {
  return value === "global" || value === "project";
}
