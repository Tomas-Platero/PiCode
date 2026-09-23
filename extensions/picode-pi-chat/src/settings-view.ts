import * as vscode from "vscode";
import { resolvePackageTypes } from "./catalog";
import { searchCatalogPage, type CatalogPackage } from "./pi-cli";
import type { InstallOutcome } from "./menu";
import {
  describeSettingWire,
  describeSettings,
  PI_SETTING_DESCRIPTORS,
  PiSettingsService,
  withPackageSkill,
  type PiCodeConfigStore,
  type PiPackageEntry,
  type PiSettingDescriptor,
  type PiSettingOption,
  type PiSettingScope,
  type PiSettingValue,
  type SettingWire,
} from "./pi-settings";
import type { SkillDiscoveryResult } from "./skills";
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

/**
 * How many catalogue rows one registry search loads.
 *
 * It is what the footer reports as loaded, and the tab pages over it without searching
 * again. Every row of it costs one registry document to tag, so the window is the cost
 * of a search as well as the browse depth; the resolver's own cache makes revisiting a
 * page free. The registry's total — which runs into the thousands — is never fetched.
 *
 * 120 is six pages of twenty: several pages to browse through without a long wait.
 */
const CATALOG_WINDOW = 120;

/** One catalogue row as the webview renders it: the search fields plus the type tags. */
interface CatalogRowWire {
  name: string;
  version: string;
  description: string;
  monthlyDownloads: number;
  tags: string[];
  publishedAt?: string;
  repository?: string;
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
  /**
   * The skills pi can see, discovered from the same runtime the chat uses.
   *
   * The rows depend on the scope's own `packages` value — that is what pi filters
   * packages by — so the view passes the entries it already read for the current
   * scope: a filter written in one scope must not change what the other scope shows.
   */
  skills(packages: readonly PiPackageEntry[]): Promise<SkillDiscoveryResult>;
  /** PiCode's own configuration, for the rows that live in the editor's settings. */
  picode(): PiCodeConfigStore | undefined;
  /**
   * Installs catalogue packages through the menu's own path.
   *
   * A catalogue row is only a caller: `installSources` keeps the confirmation, the
   * exact command it names and the restart offer, so a row cannot become a second,
   * unconfirmed install route.
   */
  install(sources: readonly string[]): Promise<InstallOutcome>;
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
 * How long a skill listing may be reused.
 *
 * The cache key already covers this panel's own writes; the lifetime covers the one
 * thing a key cannot see — a package installed, or a skill file added, while the tab
 * stayed open.
 */
const SKILLS_TTL_MS = 15_000;

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
  /** The last skill discovery, with the key it was made for. See `discoveredSkills`. */
  private skillsCache:
    | { key: string; at: number; value: SkillDiscoveryResult }
    | undefined;
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
      // The two pure row modules first: `settings.js` reads `PiCodePackageRows` and
      // `PiCodeSkillRows` while it renders their tables, so the reversed order would
      // leave it with nothing to draw from.
      scripts: ["package-rows.js", "skill-rows.js", "settings.js"],
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
      case "toggleSkill": {
        const service = await this.ensureService();
        if (service === undefined) {
          this.post({ type: "error", message: this.serviceError ?? "No se pudo escribir." });
          return;
        }
        if (
          !isScope(record.scope) ||
          typeof record.pattern !== "string" ||
          typeof record.packageSource !== "string" ||
          typeof record.enabled !== "boolean"
        ) {
          return;
        }
        await this.toggleSkill(
          service,
          record.scope,
          record.pattern,
          record.packageSource,
          record.enabled,
        );
        // Repaint either way: on success this is what keeps the pane in place with
        // the new state, and on a refusal it restores the switch to what pi stores.
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
      case "catalogSearch": {
        const query = typeof record.query === "string" ? record.query : "";
        await this.searchCatalog(query);
        break;
      }
      case "catalogInstall": {
        const name = typeof record.name === "string" ? record.name.trim() : "";
        if (name.length === 0) {
          return;
        }
        await this.options.install([`npm:${name}`]);
        // Re-read whatever the install changed. `pi install` writes the package into
        // pi's own settings, and this repaint is what makes the row stop offering it.
        await this.pushState();
        break;
      }
      case "openLink": {
        const href = typeof record.href === "string" ? record.href : "";
        const lowered = href.toLowerCase();
        // The renderer already refuses anything else. The host repeats the check
        // because the webview boundary is where trust ends, and the renderer is one
        // message away from being replaced.
        if (
          !lowered.startsWith("http://") &&
          !lowered.startsWith("https://") &&
          !lowered.startsWith("mailto:")
        ) {
          return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(href));
        break;
      }
      case "refresh": {
        const service = await this.ensureService();
        await service?.reload();
        // A refresh is the owner asking for a re-read, so the cached listing goes with
        // it: reusing it here would answer the one question the button exists to ask.
        this.skillsCache = undefined;
        await this.pushState();
        break;
      }
      default:
        break;
    }
  }

  /**
   * One registry search for the catalogue tab, plus the type tags of the window it
   * loaded.
   *
   * The search is asked once for the whole window the tab pages through, never once
   * per page: the registry is the slow part, and the window is what the footer calls
   * "loaded". The type tags cost one npm document per row, so they are resolved only
   * for that window — never for the registry's total — and the resolver's own cache
   * makes revisiting a page free.
   */
  private async searchCatalog(query: string): Promise<void> {
    try {
      const page = await searchCatalogPage(query, { limit: CATALOG_WINDOW });
      // One registry document per loaded row, so eight at a time halves the wait; the
      // resolver's cache makes revisiting a page free.
      const types = await resolvePackageTypes(page.packages, { concurrency: 8 });
      this.post({
        type: "catalogState",
        query,
        total: page.total,
        rows: page.packages.map((pkg) => toCatalogRow(pkg, types)),
      });
    } catch (error) {
      // The same visible contract as a failed write: an error line in the tab, never a
      // list that is empty for a reason the owner cannot see.
      this.post({
        type: "catalogError",
        message: `No se pudo consultar el catálogo: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  /**
   * The skill discovery, reused while the answer cannot have changed.
   *
   * `pi list` is a process, and the pane repaints after every write, so asking for the
   * listing on each repaint would make every switch in this tab pay for a spawn. The
   * cache key is the scope's `packages` value, because that is what decides which
   * package skills are on: a toggle changes it, which is exactly when the answer went
   * stale, so the invalidation is the data rather than an event to remember to fire.
   */
  private async discoveredSkills(
    scope: PiSettingScope,
    packages: readonly PiPackageEntry[],
  ): Promise<SkillDiscoveryResult> {
    const key = `${scope}|${JSON.stringify(packages)}`;
    const now = Date.now();
    if (
      this.skillsCache !== undefined &&
      this.skillsCache.key === key &&
      now - this.skillsCache.at < SKILLS_TTL_MS
    ) {
      return this.skillsCache.value;
    }
    const value = await this.options.skills(packages);
    this.skillsCache = { key, at: now, value };
    return value;
  }

  private async pushState(): Promise<void> {
    if (this.service === undefined || this.panel === undefined) {
      return;
    }
    try {
      const values = await this.service.readAll(this.scope);
      const groups = groupsWithOptions(await this.availableModels(), values);
      // The discovery is scope-aware on purpose: whether a package skill is on is
      // decided by this scope's `packages` value, so the entries read above are what
      // the discovery is told to filter by.
      const found = await this.discoveredSkills(this.scope, packageEntriesOf(values.packages));
      this.post({
        type: "state",
        scope: this.scope,
        groups,
        values,
        skills: found.skills,
        skillProblems: found.problems,
        diagnostics: this.service.diagnostics(),
        ...(this.startAt !== undefined ? { startAt: this.startAt } : {}),
      });
      this.startAt = undefined;
    } catch (error) {
      // A discovery that throws lands here too: the tab's existing error path
      // reports it, so a failed listing never renders as an empty skills list the
      // owner would read as "no skills".
      this.post({
        type: "error",
        message: `No se pudo leer el estado de pi: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  /**
   * Flips one package skill, by rewriting that package's row in the scope's
   * `packages` setting.
   *
   * The webview names the skill (its pattern) and its package, never a whole list:
   * the host reads what pi stores and rebuilds only that package's entry, so a
   * write cannot drop a filter the webview never saw. The package's complete set of
   * skill patterns comes from a fresh discovery — `withPackageSkill` needs all of
   * them to express "this one off" as the allow-list of the rest.
   */
  private async toggleSkill(
    service: PiSettingsService,
    scope: PiSettingScope,
    pattern: string,
    packageSource: string,
    enabled: boolean,
  ): Promise<void> {
    const values = await service.readAll(scope);
    const packages = packageEntriesOf(values.packages);

    let found: SkillDiscoveryResult;
    try {
      // The cached listing is preferred on purpose: the pushState that follows this
      // toggle would otherwise discover the same thing a second time for one click.
      found = await this.discoveredSkills(scope, packages);
    } catch (error) {
      this.post({
        type: "writeError",
        message: `No se pudieron leer las skills: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return;
    }

    const skill = found.skills.find(
      (candidate) =>
        candidate.source === "package" &&
        candidate.packageSource === packageSource &&
        candidate.pattern === pattern,
    );
    if (skill === undefined || !skill.canToggle || skill.pattern === undefined) {
      this.post({
        type: "writeError",
        message:
          "Solo las skills de un paquete se pueden activar o desactivar; escribe esa skill desde su paquete en la tabla de Paquetes.",
      });
      return;
    }

    const packageSkills = found.skills
      .filter(
        (candidate) =>
          candidate.source === "package" &&
          candidate.packageSource === packageSource &&
          typeof candidate.pattern === "string",
      )
      .map((candidate) => candidate.pattern as string);

    const index = packages.findIndex((entry) => entry.source === packageSource);
    if (index < 0) {
      this.post({
        type: "writeError",
        message: "Ese paquete ya no está instalado, así que su skill tampoco se puede cambiar.",
      });
      return;
    }

    const next = packages.slice();
    next[index] = withPackageSkill(packages[index], pattern, enabled, packageSkills);
    try {
      const written = await service.write(scope, "packages", next);
      await this.options.applied("packages", written);
    } catch (error) {
      this.post({
        type: "writeError",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function isScope(value: unknown): value is PiSettingScope {
  return value === "global" || value === "project";
}

/** One search result plus its resolved type tags, in the shape the webview renders. */
function toCatalogRow(pkg: CatalogPackage, types: Map<string, string[]>): CatalogRowWire {
  const tags = types.get(pkg.name);
  return {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    monthlyDownloads: pkg.monthlyDownloads,
    tags: tags !== undefined && tags.length > 0 ? tags : ["package"],
    ...(pkg.publishedAt === undefined ? {} : { publishedAt: pkg.publishedAt }),
    ...(pkg.repository === undefined ? {} : { repository: pkg.repository }),
  };
}

/**
 * The `packages` value as the editor rows the discovery and the switch use.
 *
 * `readAll` already returns `PiPackageEntry[]` for that key, so this only narrows
 * the shared `PiSettingValue` union; anything that is not a row is dropped rather
 * than trusted, because the value crosses the webview once on its way to a write.
 */
function packageEntriesOf(value: PiSettingValue): PiPackageEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: PiPackageEntry[] = [];
  for (const item of value) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as { source?: unknown }).source === "string"
    ) {
      entries.push(item as PiPackageEntry);
    }
  }
  return entries;
}
