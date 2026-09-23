/*
 * The catalogue of pi's own settings, and the service that reads and writes them.
 *
 * Two halves, deliberately separated:
 *
 * - The catalogue is data. For every setting it declares the category it belongs
 *   to, its Spanish label and description, how it is read, and — only when pi
 *   offers a setter — how it is written. Nothing here knows about webviews, so the
 *   row builder a later task writes can be tested against a fake manager.
 * - The service loads the installed pi at runtime, builds the SDK's
 *   `SettingsManager`, and exposes `readAll` / `write` over the catalogue.
 *
 * pi owns the settings file. Every write goes through pi's own typed setter and its
 * `flush()`, never through the JSON: the file is shared with the pi CLI, and the
 * setters are what serialize correctly against a running pi.
 *
 * The enumeration below is not a remembered list. It was read from the installed
 * `dist/core/settings-manager.d.ts`, one `get*` and one `set*` at a time. The two
 * mechanical consequences:
 *
 * - A getter with no setter becomes a read-only row. That is the honest state of
 *   that setting in pi (the compaction and branch-summary token budgets, the retry
 *   delays, the provider retry block, the WebSocket timeout, `externalEditor` and
 *   `sessionDir` are all in that group); inventing a write path — hand-editing the
 *   settings file — is out of scope for this surface.
 * - Only a setting with a project setter is offered in the project scope. That is
 *   the packages table; everything else is global-only.
 *
 * pi's own appearance settings (its theme, the theme paths and whether the
 * changelog starts collapsed) are deliberately absent: they configure pi's
 * terminal interface, which this surface does not govern.
 */

import { pathToFileURL } from "node:url";
import type { PiThinkingLevel } from "./protocol";

export type PiSettingScope = "global" | "project";

export type PiSettingKind =
  | "boolean"
  | "select"
  | "number"
  | "text"
  | "list"
  | "packages"
  | "skills"
  | "action";

/**
 * pi's four per-package resource filters, keyed by resource type.
 *
 * pi reads a list in two modes. With the default autoload its `applyPackageFilter`
 * treats the list as an allow-list: only the listed paths load, an empty list
 * disables every resource of that type, and the *absence* of the key is what means
 * "no filter, load everything". With `autoload: false` its `applyPackageDeltaFilter`
 * treats the list as a delta over "nothing loads": only the patterns it names load,
 * and an empty list loads nothing. In both modes the missing key is the only "no
 * filter", which is why an empty list must never be collapsed into it.
 */
export interface PiPackageFilters {
  extensions?: readonly string[];
  skills?: readonly string[];
  prompts?: readonly string[];
  themes?: readonly string[];
}

/** A package row: its source, whether it is paused, and the resource filters it carries. */
export interface PiPackageEntry extends PiPackageFilters {
  source: string;
  /** True when the package is kept but not loaded (pi stores autoload=false). */
  paused: boolean;
}

export type PiSettingValue =
  | boolean
  | number
  | string
  | string[]
  | PiPackageEntry[]
  | undefined;

export type PiSettingsCategoryId =
  | "estado"
  | "picode"
  | "modelo"
  | "analitica"
  | "red"
  | "herramientas"
  | "paquetes"
  | "skills"
  | "sesion";

export interface PiSettingOption {
  value: string;
  label: string;
}

export interface PiSettingDescriptor {
  /** Stable id. Where pi has a settings.json key, this is that key. */
  key: string;
  category: PiSettingsCategoryId;
  label: string;
  description: string;
  kind: PiSettingKind;
  /** Only the scopes this setting can actually be written to. */
  scopes: readonly PiSettingScope[];
  /**
   * True when no setter exists, so the row shows a value and no control. An
   * `action` is read-only too — there is nothing to write — but the renderer draws
   * its button before this flag is ever consulted, so a missing setter never turns
   * an action into a value with a "solo lectura" note.
   */
  readOnly: boolean;
  /** For `select`. */
  options?: readonly PiSettingOption[];
  /**
   * For a `select` without static options: the row may be cleared to "unset".
   * Only the provider and model dropdowns use this; their options come from the
   * live session, not from this file.
   */
  allowEmpty?: boolean;
  /** For `number`: the smallest value the control accepts. */
  minimum?: number;
  /** For `number`: a short unit shown after the input ("ms", "tokens"). */
  unit?: string;
  /**
   * True when a running agent will not see the change until it restarts, so the
   * row can say so rather than the owner wondering why nothing happened.
   */
  needsRestart?: boolean;
  /**
   * Set when the value lives in PiCode's own VS Code configuration instead of pi's
   * settings file. Such a descriptor declares no `read`/`write`: the service
   * dispatches through the injected `PiCodeConfigStore`, and the key here is the
   * configuration's own key name (`runtime`, `transport`).
   */
  picodeKey?: string;
  /**
   * For an `action`: the plain VS Code command id the row runs when clicked.
   *
   * An action row has no value at all, so it declares no `read` and no `write`: it
   * is a button whose label is the row's own label, and the host resolves the id
   * from this catalogue rather than trusting the webview with a command to run.
   */
  command?: string;
  /**
   * For an `action`: what its button says, when the row's own label does not name the
   * verb. The title names the thing, the button names what pressing it does.
   */
  actionLabel?: string;
  /** Absent for the descriptors that carry a `picodeKey`, and for an `action`. */
  read?(manager: PiSettingsManager, scope: PiSettingScope): PiSettingValue;
  write?(manager: PiSettingsManager, scope: PiSettingScope, value: PiSettingValue): void;
}

export interface PiSettingsCategory {
  id: PiSettingsCategoryId;
  label: string;
  description: string;
}

export interface PiSettingsGroup {
  category: PiSettingsCategory;
  settings: readonly PiSettingDescriptor[];
}

/**
 * A descriptor reduced to what the webview can receive and render.
 *
 * The descriptor carries `read` / `write` closures, which the structured clone a
 * `postMessage` performs cannot carry, and which the webview has no use for: it
 * renders the kind, the scopes and the value the host already read. This shape is
 * the serializable half of the contract, so the row builder can be tested without
 * a webview and without leaking a function into the document.
 */
export interface SettingWire {
  key: string;
  category: PiSettingsCategoryId;
  label: string;
  description: string;
  kind: PiSettingKind;
  readOnly: boolean;
  scopes: readonly PiSettingScope[];
  options?: readonly PiSettingOption[];
  allowEmpty?: boolean;
  minimum?: number;
  unit?: string;
  needsRestart?: boolean;
  /** For an `action`: the command id the button runs. */
  command?: string;
  /** For an `action`: the caption of its button. Absent means the host's default. */
  actionLabel?: string;
}

/* ------------------------------------------------------------------ *
 * The SDK's shape
 * ------------------------------------------------------------------ */

/**
 * The slice of pi's `SettingsManager` this module calls.
 *
 * pi is ESM-only and loaded at runtime through an absolute URL, so it cannot be
 * imported for typing: a static import would make the extension compile against a
 * package that may not be installed, and would pin these shapes to one pi version.
 * This interface is the contract instead — every member is one this file actually
 * calls, with the signature read from the installed `.d.ts`.
 */
export interface PiSettingsManager {
  reload(): Promise<void>;
  flush(): Promise<void>;
  drainErrors(): PiSettingsFileError[];

  /*
   * Raw per-scope objects. The typed getters return the value *merged* from both
   * scopes, so a scope-aware row has to read the scope's own object; this is the
   * only way to tell "the project overrides this" from "the project inherits it".
   */
  getGlobalSettings(): PiSettingsRecord;
  getProjectSettings(): PiSettingsRecord;

  /* Modelo */
  getDefaultProvider(): string | undefined;
  setDefaultProvider(provider: string): void;
  getDefaultModel(): string | undefined;
  setDefaultModel(modelId: string): void;
  /** Writes both halves of the default-model pair in one go. */
  setDefaultModelAndProvider(provider: string, modelId: string): void;

  /* Razonamiento */
  getDefaultThinkingLevel(): PiThinkingLevel | undefined;
  setDefaultThinkingLevel(level: PiThinkingLevel): void;
  getAllModelThinkingLevels(): Record<string, PiThinkingLevel>;
  setModelThinkingLevel(provider: string, modelId: string, level: PiThinkingLevel): void;
  removeModelThinkingLevel(provider: string, modelId: string): void;
  getHideThinkingBlock(): boolean;
  setHideThinkingBlock(hide: boolean): void;
  getShowCacheMissNotices(): boolean;
  setShowCacheMissNotices(show: boolean): void;

  /* Compactación */
  getCompactionEnabled(): boolean;
  setCompactionEnabled(enabled: boolean): void;
  getCompactionReserveTokens(): number;
  getCompactionKeepRecentTokens(): number;
  getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean };

  /* Reintentos */
  getRetryEnabled(): boolean;
  setRetryEnabled(enabled: boolean): void;
  getRetrySettings(): {
    enabled: boolean;
    maxRetries: number;
    baseDelayMs: number;
    maxAgentDelayMs: number;
  };

  /* Red */
  getHttpIdleTimeoutMs(): number;
  setHttpIdleTimeoutMs(timeoutMs: number): void;
  getProviderRetrySettings(): {
    timeoutMs?: number;
    maxRetries?: number;
    maxRetryDelayMs: number;
  };
  getWebSocketConnectTimeoutMs(): number | undefined;
  getCacheWarmingMode(): PiCacheWarmingMode;
  setCacheWarmingMode(mode: PiCacheWarmingMode): void;
  getTransport(): PiTransport;
  setTransport(transport: PiTransport): void;

  /* Herramientas y shell */
  getShellPath(): string | undefined;
  setShellPath(path: string | undefined): void;
  getShellCommandPrefix(): string | undefined;
  setShellCommandPrefix(prefix: string | undefined): void;
  getNpmCommand(): string[] | undefined;
  setNpmCommand(command: string[] | undefined): void;
  getExternalEditorCommand(): string;
  getQuietStartup(): boolean;
  setQuietStartup(quiet: boolean): void;
  getDefaultProjectTrust(): PiDefaultProjectTrust;
  setDefaultProjectTrust(defaultProjectTrust: PiDefaultProjectTrust): void;

  /* Paquetes y recursos */
  setPackages(packages: readonly PiPackageSource[]): void;
  setProjectPackages(packages: readonly PiPackageSource[]): void;
  setExtensionPaths(paths: string[]): void;
  setProjectExtensionPaths(paths: string[]): void;
  setSkillPaths(paths: string[]): void;
  setProjectSkillPaths(paths: string[]): void;
  setPromptTemplatePaths(paths: string[]): void;
  setProjectPromptTemplatePaths(paths: string[]): void;
  getEnableInstallTelemetry(): boolean;
  setEnableInstallTelemetry(enabled: boolean): void;
  getEnableAnalytics(): boolean;
  setEnableAnalytics(enabled: boolean): void;
  getEnableSkillCommands(): boolean;
  setEnableSkillCommands(enabled: boolean): void;

  /* Sesión */
  getSteeringMode(): PiSteeringMode;
  setSteeringMode(mode: PiSteeringMode): void;
  getFollowUpMode(): PiSteeringMode;
  setFollowUpMode(mode: PiSteeringMode): void;
  getSessionDir(): string | undefined;
}

/**
 * The fields of pi's settings file this module reads per scope.
 *
 * Only the keys that have a project setter are declared: every other setting lives
 * in the global object, where the typed getter is already the read path. The names
 * are pi's own `Settings` keys, which is why the resource lists are `extensions`,
 * `skills` and `prompts` rather than "paths".
 *
 * The top-level `themes` key is not declared any more: it was the theme-path list of
 * the retired Apariencia category, and pi's own appearance settings are out of this
 * surface's scope. A package's `themes` *filter* is a different thing and stays
 * declared on `PiPackageFilters`.
 */
export interface PiSettingsRecord {
  packages?: readonly PiPackageSource[];
  extensions?: readonly string[];
  skills?: readonly string[];
  prompts?: readonly string[];
}

/**
 * A package entry as pi stores it: a source string, or an object that filters which
 * resources the package contributes. The object's four filter arrays are read and
 * written too, because a filter this surface dropped would silently re-enable
 * whatever the owner had switched off in pi.
 */
export type PiPackageSource =
  | string
  | ({ source: string; autoload?: boolean } & PiPackageFilters);

export type PiCacheWarmingMode = "off" | "streaming" | "idle";

export type PiTransport = "sse" | "websocket" | "websocket-cached" | "auto";

export type PiDefaultProjectTrust = "ask" | "always" | "never";

export type PiSteeringMode = "all" | "one-at-a-time";

/** One problem pi reported while loading or saving settings. */
export interface PiSettingsFileError {
  scope: PiSettingScope;
  path?: string;
  error: Error;
}

/** The SDK entry points this module uses. */
export interface PiSettingsModule {
  SettingsManager: PiSettingsManagerClass;
  getAgentDir(): string;
}

export interface PiSettingsManagerClass {
  create(cwd: string, agentDir?: string): PiSettingsManager;
}

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

const GLOBAL_SCOPE: readonly PiSettingScope[] = ["global"];
const ALL_SCOPES: readonly PiSettingScope[] = ["global", "project"];

/** pi's `ThinkingLevel` union, in the order its own selector offers it. */
const THINKING_LEVELS: readonly PiThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const THINKING_LEVEL_OPTIONS: readonly PiSettingOption[] = [
  { value: "off", label: "Apagado" },
  { value: "minimal", label: "Mínimo" },
  { value: "low", label: "Bajo" },
  { value: "medium", label: "Medio" },
  { value: "high", label: "Alto" },
  { value: "xhigh", label: "Muy alto" },
  { value: "max", label: "Máximo" },
];

const STEERING_OPTIONS: readonly PiSettingOption[] = [
  { value: "all", label: "Todos a la vez" },
  { value: "one-at-a-time", label: "De uno en uno" },
];

const PROJECT_TRUST_OPTIONS: readonly PiSettingOption[] = [
  { value: "ask", label: "Preguntar" },
  { value: "always", label: "Confiar siempre" },
  { value: "never", label: "No confiar nunca" },
];

const CACHE_WARMING_OPTIONS: readonly PiSettingOption[] = [
  { value: "off", label: "Desactivado" },
  { value: "streaming", label: "Durante el streaming" },
  { value: "idle", label: "Durante el streaming y en reposo" },
];

const TRANSPORT_OPTIONS: readonly PiSettingOption[] = [
  { value: "auto", label: "Automático" },
  { value: "sse", label: "SSE" },
  { value: "websocket", label: "WebSocket" },
  { value: "websocket-cached", label: "WebSocket con caché" },
];

/** PiCode's runtime modes, in the order the picker offers them. */
const PICODE_RUNTIME_OPTIONS: readonly PiSettingOption[] = [
  { value: "managed", label: "pi propio de PiCode" },
  { value: "path", label: "El pi que ya tengo instalado" },
  { value: "custom", label: "Un ejecutable concreto" },
];

/** PiCode's transports, in the order the picker offers them. */
const PICODE_TRANSPORT_OPTIONS: readonly PiSettingOption[] = [
  { value: "rpc", label: "Proceso aparte (RPC)" },
  { value: "embedded", label: "Dentro del editor (SDK)" },
];

/* ------------------------------------------------------------------ *
 * Categories
 * ------------------------------------------------------------------ */

/** The rail, in its declared order. `describeSettings` never reorders these. */
export const PI_SETTINGS_CATEGORIES: readonly PiSettingsCategory[] = [
  {
    id: "estado",
    label: "Estado",
    description: "Lo que pi está usando ahora mismo. Son hechos, no ajustes: se leen y no se editan.",
  },
  {
    id: "picode",
    label: "PiCode",
    description: "Ajustes propios de la extensión: qué pi se ejecuta, cómo habla con él y qué contexto adjunta.",
  },
  {
    id: "modelo",
    label: "Modelo",
    description: "Con qué proveedor y qué modelo arrancan las sesiones nuevas.",
  },
  {
    id: "analitica",
    label: "Analítica",
    // The label alone does not say what the category holds, so the description
    // spells out the three groups that were merged into it: the thinking level, the
    // compaction of the context and the retries.
    description:
      "Cuánto piensa el agente (el nivel de razonamiento), cómo resume la conversación " +
      "cuando se queda sin contexto (la compactación) y qué hace cuando una llamada al " +
      "proveedor o un turno falla (los reintentos).",
  },
  {
    id: "red",
    label: "Red",
    description: "Tiempos de espera, reintentos del proveedor y transporte de las llamadas al modelo.",
  },
  {
    id: "herramientas",
    label: "Herramientas y shell",
    description: "Con qué shell ejecuta pi los comandos y cuánta confianza da a un proyecto abierto.",
  },
  {
    id: "paquetes",
    label: "Paquetes y recursos",
    description: "Qué paquetes carga pi; cada paquete aporta sus propias extensiones, skills, plantillas y temas.",
  },
  {
    id: "skills",
    label: "Skills",
    description: "Qué skills carga pi y si se pueden lanzar como comandos de barra.",
  },
  {
    id: "sesion",
    label: "Sesión",
    description: "Cómo trata el agente los mensajes que llegan mientras trabaja, y dónde guarda las sesiones.",
  },
];

/* ------------------------------------------------------------------ *
 * Coercion — the boundary with the webview
 * ------------------------------------------------------------------ */

/**
 * Turns a value arriving from the webview into one this setting accepts, or
 * `undefined` when it cannot be expressed as this kind at all. The webview is the
 * boundary: a number that arrives as "abc" must be refused here, not written and
 * then rejected by pi.
 *
 * `undefined` is also how a `text` setting says "unset" (an empty or
 * whitespace-only string); `PiSettingsService.write` is where those two meanings
 * are told apart, because it is the only place that knows the difference matters.
 */
export function coerceSettingValue(
  descriptor: PiSettingDescriptor,
  value: unknown,
): PiSettingValue | undefined {
  switch (descriptor.kind) {
    // An action carries no value: the row is a button. Nothing the webview sends
    // for it can be expressed as a setting, so every value is refused here.
    case "action":
      return undefined;

    // A skills row carries no value of its own either: its rows come from the
    // discovery, and the switch a package skill draws writes the `packages`
    // setting. Nothing the webview sends is this row's value.
    case "skills":
      return undefined;

    case "boolean":
      return typeof value === "boolean" ? value : undefined;

    case "number": {
      // A numeric string is accepted because that is what an <input> sends; an
      // empty one is not zero, which is why it is excluded before Number().
      const numeric =
        typeof value === "number"
          ? value
          : typeof value === "string" && value.trim() !== ""
            ? Number(value)
            : Number.NaN;
      if (!Number.isFinite(numeric)) {
        return undefined;
      }
      const minimum = descriptor.minimum;
      return minimum !== undefined && numeric < minimum ? minimum : numeric;
    }

    case "select": {
      if (typeof value !== "string") {
        return undefined;
      }
      const options = descriptor.options;
      // A select with no declared options is a dynamic one: the host supplies the
      // options from the live session, so the value cannot be checked against a
      // fixed list. Accept any non-empty string; whitespace means "unset".
      if (options === undefined || options.length === 0) {
        return value.trim() === "" ? undefined : value;
      }
      return options.some((option) => option.value === value) ? value : undefined;
    }

    case "text": {
      if (typeof value !== "string") {
        return undefined;
      }
      return value.trim() === "" ? undefined : value;
    }

    case "list": {
      if (!Array.isArray(value)) {
        return undefined;
      }
      const entries: string[] = [];
      for (const entry of value) {
        if (typeof entry !== "string" || entry.trim() === "") {
          return undefined;
        }
        entries.push(entry);
      }
      return entries;
    }

    case "packages": {
      if (!Array.isArray(value)) {
        return undefined;
      }
      const entries: PiPackageEntry[] = [];
      for (const entry of value) {
        if (typeof entry !== "object" || entry === null) {
          return undefined;
        }
        const record = entry as Record<string, unknown>;
        if (typeof record.source !== "string" || record.source.trim() === "") {
          return undefined;
        }
        const coerced: PiPackageEntry = { source: record.source, paused: record.paused === true };
        for (const field of PACKAGE_FILTER_FIELDS) {
          const filter = parsePackageFilter(record[field]);
          if (!filter.ok) {
            return undefined;
          }
          if (filter.values !== undefined) {
            coerced[field] = filter.values;
          }
        }
        entries.push(coerced);
      }
      return entries;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Reading and writing helpers
 * ------------------------------------------------------------------ */

/** The scope's own settings object, which is the only per-scope read there is. */
function scopedRecord(manager: PiSettingsManager, scope: PiSettingScope): PiSettingsRecord {
  return scope === "project" ? manager.getProjectSettings() : manager.getGlobalSettings();
}

/**
 * pi's four per-package resource filters, in pi's own key order.
 *
 * One list drives the read, the coercion and the write, so the three cannot drift
 * apart: a filter that one of them knows and another forgets is exactly how pi's
 * filtering would be destroyed on the next write.
 */
export const PACKAGE_FILTER_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

type PiPackageFilterField = (typeof PACKAGE_FILTER_FIELDS)[number];

/**
 * The result of reading one filter array off a value from the webview.
 *
 * Three outcomes are told apart because they mean different things: `ok` with no
 * `values` is "the entry declares no filter of this type", `ok` with `values` is a
 * real filter, and `ok: false` is a value that cannot be stored at all. An empty
 * array is a real filter too: it is what pi reads as "all off" when the autoload is
 * default, so folding it into "no filter" would silently turn every skill back on.
 */
interface PackageFilterParse {
  ok: boolean;
  values?: string[];
}

function parsePackageFilter(value: unknown): PackageFilterParse {
  if (value === undefined) {
    return { ok: true };
  }
  if (!Array.isArray(value)) {
    return { ok: false };
  }
  const values: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      return { ok: false };
    }
    values.push(entry);
  }
  return { ok: true, values };
}

/** A package entry reduced to what the editor renders: its source, pause and filters. */
function packageEntry(entry: PiPackageSource): PiPackageEntry {
  if (typeof entry === "string") {
    return { source: entry, paused: false };
  }
  const result: PiPackageEntry = { source: entry.source, paused: entry.autoload === false };
  for (const field of PACKAGE_FILTER_FIELDS) {
    const filter = entry[field];
    // An empty list is kept on purpose: with the default autoload pi reads it as
    // "nothing of this type loads", so dropping it here would re-enable everything.
    if (filter !== undefined) {
      result[field] = [...filter];
    }
  }
  return result;
}

/** Turns one editor package row back into pi's stored form. */
export function toPackageSource(entry: PiPackageEntry): PiPackageSource {
  const stored: { source: string; autoload?: boolean } & PiPackageFilters = {
    source: entry.source,
  };
  if (entry.paused) {
    stored.autoload = false;
  }
  for (const field of PACKAGE_FILTER_FIELDS) {
    const filter = entry[field];
    // An empty list is written, not dropped: pi reads it as "all off" with the
    // default autoload, and dropping the key would mean "no filter" instead.
    if (filter !== undefined) {
      stored[field] = [...filter];
    }
  }
  // A plain source stays a plain string, and a paused package stays an object with
  // `autoload: false`; a filter — including the empty allow-list that means "all
  // off" — forces the object form.
  const carriesFilters = PACKAGE_FILTER_FIELDS.some((field) => stored[field] !== undefined);
  return entry.paused || carriesFilters ? stored : entry.source;
}

/** Turns the editor's package rows back into pi's stored form. */
function toPackageList(value: PiSettingValue, key: string): PiPackageSource[] {
  if (!Array.isArray(value)) {
    throw new Error(`Setting "${key}" expects a list of packages.`);
  }
  return value.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { source?: unknown }).source !== "string" ||
      (entry as { source: string }).source.trim() === ""
    ) {
      throw new Error(`Setting "${key}" expects each package to declare a source.`);
    }
    return toPackageSource(entry as PiPackageEntry);
  });
}

/**
 * The `skills` key exactly as the entry stores it, or `undefined` when the entry
 * carries no key at all.
 *
 * pi reads the key in two modes (its `collectPackageResources` chooses between
 * `applyPackageFilter` and `applyPackageDeltaFilter`):
 *
 * - with the default autoload it is an allow-list, and an empty list disables every
 *   skill the package contributes;
 * - with `autoload: false` it is a delta over "nothing loads", so only the patterns
 *   it names turn a skill on.
 *
 * In both modes the absence of the key is what means "no filter", so `undefined` is
 * told apart from an empty array on purpose. An empty array only ever reaches this
 * function because the owner switched the package's last skill off, and folding it
 * into "no filter" is exactly the bug that would turn every skill back on.
 */
export function packageSkillFilter(entry: PiPackageEntry): readonly string[] | undefined {
  return entry.skills;
}

/**
 * The same package entry with one skill switched on or off.
 *
 * `packageSkills` is the complete set of skill patterns the package contributes,
 * which the discovery already knows and the table passes. It is what lets a switch
 * be expressed from either starting point: with the default autoload a package with
 * no filter loads every skill, so switching one off means writing the allow-list of
 * the rest; a package that already filters means removing the entry.
 *
 * The key is never collapsed away when it means something. Switching the last
 * skill off writes an **empty list**, which pi reads as "all off"; dropping the
 * key there would restore the default "no filter" and turn every skill back on.
 * Switching a skill on does drop the key, but only when the resulting allow-list
 * names every skill of the package, because that is identical to "no filter".
 *
 * The pause (`autoload: false`) is orthogonal and kept in every case; because a
 * paused package's list is a delta, it is never dropped even when it names every
 * skill, or the package would load nothing again.
 */
export function withPackageSkill(
  entry: PiPackageEntry,
  skill: string,
  enabled: boolean,
  packageSkills: readonly string[],
): PiPackageEntry {
  const result: PiPackageEntry = { source: entry.source, paused: entry.paused };
  for (const field of PACKAGE_FILTER_FIELDS) {
    const filter =
      field === "skills"
        ? nextSkillFilter(entry, entry.skills, skill, enabled, packageSkills)
        : entry[field];
    copyFilter(result, field, filter);
  }
  return result;
}

/**
 * The `skills` key the switch must leave behind, or `undefined` when the entry must
 * carry no key at all.
 *
 * The four cases the owner's table exercises:
 *
 * - no filter, switch one off, other skills exist -> the allow-list of the rest;
 * - no filter, switch one off, it is the only skill -> an empty allow-list;
 * - filtered, switch one off -> the rest, empty list kept when it was the last;
 * - switch one on -> added to the list, and the key is dropped only once the list
 *   names every skill of the package (with the default autoload).
 */
function nextSkillFilter(
  entry: PiPackageEntry,
  declared: readonly string[] | undefined,
  skill: string,
  enabled: boolean,
  packageSkills: readonly string[],
): readonly string[] | undefined {
  if (enabled) {
    if (declared === undefined) {
      // No key: a normal package already loads every skill, so switching one on is
      // a no-op and the entry stays as it is. A paused package loads nothing, so
      // its delta has to name the skill.
      return entry.paused ? [skill] : undefined;
    }
    if (declared.includes(skill)) {
      return [...declared];
    }
    const added = [...declared, skill];
    // A normal package whose allow-list names every skill is indistinguishable from
    // no filter, so the key goes away and the source stays a plain string. A paused
    // package keeps the delta: dropping it would load nothing again.
    if (!entry.paused && coversEverySkill(added, packageSkills)) {
      return undefined;
    }
    return added;
  }

  if (declared === undefined) {
    // A paused package already loads nothing, so switching one off removes nothing.
    if (entry.paused) {
      return undefined;
    }
    // With the default autoload every skill loads, so switching one off means
    // allowing every other skill. The package's only skill yields an empty
    // allow-list, which pi reads as "all off" — never a missing key.
    return packageSkills.filter((pattern) => pattern !== skill);
  }

  // Remove the entry, keeping an empty list when it was the last one: an empty
  // allow-list is "all off", while dropping the key would turn every skill back on.
  return declared.filter((pattern) => pattern !== skill);
}

/** Whether an allow-list names every skill the package contributes. */
function coversEverySkill(
  filter: readonly string[],
  packageSkills: readonly string[],
): boolean {
  // An unknown package (no known patterns) cannot be proven complete, so the key
  // stays rather than collapsing to "no filter".
  if (packageSkills.length === 0) {
    return false;
  }
  return packageSkills.every((pattern) => filter.includes(pattern));
}

/** Copies one filter onto a result entry, keeping an empty list when it is present. */
function copyFilter(
  result: PiPackageEntry,
  field: PiPackageFilterField,
  filter: readonly string[] | undefined,
): void {
  if (filter !== undefined) {
    result[field] = [...filter];
  }
}

function toBoolean(value: PiSettingValue, key: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Setting "${key}" expects a boolean value.`);
  }
  return value;
}

function toNumber(value: PiSettingValue, key: string): number {
  if (typeof value !== "number") {
    throw new Error(`Setting "${key}" expects a number.`);
  }
  return value;
}

function toSelect(value: PiSettingValue, key: string): string {
  if (typeof value !== "string") {
    throw new Error(`Setting "${key}" expects one of its declared options.`);
  }
  return value;
}

function toOptionalText(value: PiSettingValue, key: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Setting "${key}" expects a text value.`);
  }
  return value;
}

/**
 * Text a setter requires as a string. `undefined` here means "unset", and the two
 * settings that use this helper (default provider and default model) have no setter
 * that clears them, so the empty string — which pi's own readers treat as unset — is
 * what is written.
 */
function toRequiredText(value: PiSettingValue, key: string): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw new Error(`Setting "${key}" expects a text value.`);
  }
  return value;
}

function toList(value: PiSettingValue, key: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Setting "${key}" expects a list of strings.`);
  }
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(`Setting "${key}" expects a list of strings.`);
    }
    entries.push(entry);
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * The catalogue
 * ------------------------------------------------------------------ */

/**
 * The state of PiCode's own pi, read by the `picode.piVersion` row.
 *
 * That row is an action — it installs the latest published version — and the fact it shows
 * before the owner presses it is a reading of this installation (which version is on disk)
 * joined with a registry answer, so it is the host that computes it and caches it. A reader
 * is registered instead of imported because this module must stay loadable without
 * `vscode`, which is what owns the paths and the network; with no reader registered the row
 * has no value, which is what an action row with nothing to say looks like.
 */
let readPiVersionState: (() => string | undefined) | undefined;

export function setPiVersionStateSource(source: (() => string | undefined) | undefined): void {
  readPiVersionState = source;
}

/**
 * Every setting this surface knows, grouped by category in the declared order.
 *
 * The descriptor objects are literal and complete on purpose: this array is the
 * contract a later task renders and a reviewer reads against the installed pi.
 */
export const PI_SETTING_DESCRIPTORS: readonly PiSettingDescriptor[] = [
  /* --- Modelo ----------------------------------------------------- */

  {
    key: "defaultProvider",
    category: "modelo",
    label: "Proveedor por defecto",
    description:
      "Proveedor con el que arrancan las sesiones nuevas. Sin proveedor, pi ignora el " +
      "modelo de abajo y elige por su cuenta entre los que tengan credenciales.",
    kind: "select",
    allowEmpty: true,
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    read: (manager) => manager.getDefaultProvider(),
    // pi has no setter that clears this pair, so "vacío" writes an empty string,
    // which pi's own readers already treat as unset. The options are not declared
    // here: the host fills them from the live session's available models.
    write: (manager, _scope, value) => manager.setDefaultProvider(toRequiredText(value, "defaultProvider")),
  },
  {
    key: "defaultModel",
    category: "modelo",
    label: "Modelo por defecto",
    description:
      "Modelo que usan las sesiones nuevas, dentro del proveedor de arriba. Déjalo " +
      "vacío para que pi siga con el que ya tenga configurado.",
    kind: "select",
    allowEmpty: true,
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    read: (manager) => manager.getDefaultModel(),
    // pi resolves this as `getModel(defaultProvider, defaultModel)`, so the id alone
    // is not enough: writing both halves is what makes the choice survive, and pi
    // offers the paired setter precisely for a choice made in a picker. Cleared, the
    // id goes empty and the provider is left as it is.
    write: (manager, _scope, value) => {
      const modelId = toRequiredText(value, "defaultModel");
      const provider = manager.getDefaultProvider();
      if (modelId !== "" && provider !== undefined && provider !== "") {
        manager.setDefaultModelAndProvider(provider, modelId);
        return;
      }
      manager.setDefaultModel(modelId);
    },
  },

  /* --- Analítica -------------------------------------------------- *
   * One category for the three groups the owner asked to merge: how much the agent
   * thinks, how the conversation is compacted, and what happens when a call fails.
   * Every descriptor keeps its own `key`, because those are stable settings
   * identifiers, but all of them now declare the same `analitica` category.
   */

  {
    key: "defaultThinkingLevel",
    category: "analitica",
    label: "Nivel de razonamiento",
    description:
      "Cuánto piensa el agente por defecto. Los modelos con un nivel propio lo ignoran.",
    kind: "select",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    options: THINKING_LEVEL_OPTIONS,
    read: (manager) => manager.getDefaultThinkingLevel(),
    write: (manager, _scope, value) =>
      manager.setDefaultThinkingLevel(toSelect(value, "defaultThinkingLevel") as PiThinkingLevel),
  },
  {
    key: "modelThinkingLevels",
    category: "analitica",
    label: "Nivel por modelo",
    description:
      "Excepciones al nivel por defecto, una por modelo, con la forma «proveedor/modelo=nivel». " +
      "Se guardan en los ajustes globales, no en los del proyecto.",
    kind: "list",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    read: (manager) =>
      Object.entries(manager.getAllModelThinkingLevels()).map(([target, level]) => `${target}=${level}`),
    write: (manager, _scope, value) => writeModelThinkingLevels(manager, value),
  },
  {
    key: "hideThinkingBlock",
    category: "analitica",
    label: "Ocultar el bloque de razonamiento",
    description: "Esconde el razonamiento del modelo en la transcripción, aunque el modelo lo emita.",
    kind: "boolean",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    read: (manager) => manager.getHideThinkingBlock(),
    write: (manager, _scope, value) =>
      manager.setHideThinkingBlock(toBoolean(value, "hideThinkingBlock")),
  },
  {
    key: "showCacheMissNotices",
    category: "analitica",
    label: "Avisos de caché perdida",
    description:
      "Muestra un aviso cuando una llamada no reutiliza la caché del proveedor y se " +
      "vuelve a pagar el contexto completo.",
    kind: "boolean",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    read: (manager) => manager.getShowCacheMissNotices(),
    write: (manager, _scope, value) =>
      manager.setShowCacheMissNotices(toBoolean(value, "showCacheMissNotices")),
  },

  /* --- Analítica: compactación ------------------------------------ *
   * All five are read-only: pi exposes getters for the compaction and branch-summary
   * token budgets but no setter for any of them, so the row shows the value pi
   * resolved (including its own default when the setting is absent) and offers no
   * control rather than a control that cannot work.
   */

  {
    key: "compaction.enabled",
    category: "analitica",
    label: "Compactación automática",
    description:
      "Cuando la conversación se acerca al límite de contexto, pi la resume y sigue " +
      "trabajando con el resumen.",
    kind: "boolean",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    read: (manager) => manager.getCompactionEnabled(),
    write: (manager, _scope, value) =>
      manager.setCompactionEnabled(toBoolean(value, "compaction.enabled")),
  },
  {
    key: "compaction.reserveTokens",
    category: "analitica",
    label: "Tokens reservados",
    description: "Contexto que pi deja libre para poder generar el resumen sin quedarse sin sitio.",
    kind: "number",
    scopes: GLOBAL_SCOPE,
    readOnly: true,
    minimum: 0,
    unit: "tokens",
    read: (manager) => manager.getCompactionReserveTokens(),
  },
  {
    key: "compaction.keepRecentTokens",
    category: "analitica",
    label: "Tokens recientes que conserva",
    description: "Parte final de la conversación que pi mantiene literal, sin resumir.",
    kind: "number",
    scopes: GLOBAL_SCOPE,
    readOnly: true,
    minimum: 0,
    unit: "tokens",
    read: (manager) => manager.getCompactionKeepRecentTokens(),
  },
  {
    key: "branchSummary.reserveTokens",
    category: "analitica",
    label: "Tokens reservados al resumir una rama",
    description: "Espacio reservado cuando el resumen es el de una rama del árbol de sesiones.",
    kind: "number",
    scopes: GLOBAL_SCOPE,
    readOnly: true,
    minimum: 0,
    unit: "tokens",
    read: (manager) => manager.getBranchSummarySettings().reserveTokens,
  },
  {
    key: "branchSummary.skipPrompt",
    category: "analitica",
    label: "No preguntar al resumir una rama",
    description: "Resume la rama directamente, sin pedir confirmación antes de continuar.",
    kind: "boolean",
    scopes: GLOBAL_SCOPE,
    readOnly: true,
    read: (manager) => manager.getBranchSummarySettings().skipPrompt,
  },

  /* --- Analítica: reintentos -------------------------------------- *
   * Only `enabled` has a setter. pi reads the three numbers from the settings file
   * but publishes no way to write them, so they are shown as they are.
   */

  {
    key: "retry.enabled",
    category: "analitica",
    label: "Reintentar automáticamente",
    description: "Reintenta una llamada al proveedor o un turno del agente cuando falla por causas temporales.",
    kind: "boolean",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    read: (manager) => manager.getRetryEnabled(),
    write: (manager, _scope, value) => manager.setRetryEnabled(toBoolean(value, "retry.enabled")),
  },
  {
    key: "retry.maxRetries",
    category: "analitica",
    label: "Intentos como máximo",
    description: "Número de reintentos por turno del agente antes de dar el fallo por definitivo.",
    kind: "number",
    scopes: GLOBAL_SCOPE,
    readOnly: true,
    minimum: 0,
    read: (manager) => manager.getRetrySettings().maxRetries,
  },
  {
    key: "retry.baseDelayMs",
    category: "analitica",
    label: "Espera inicial",
    description: "Tiempo antes del primer reintento. Cada intento siguiente espera más.",
    kind: "number",
    scopes: GLOBAL_SCOPE,
    readOnly: true,
    minimum: 0,
    unit: "ms",
    read: (manager) => manager.getRetrySettings().baseDelayMs,
  },
  {
    key: "retry.maxAgentDelayMs",
    category: "analitica",
    label: "Espera máxima por turno",
    description: "Tope de la espera acumulada cuando un turno del agente se está reintentando.",
    kind: "number",
    scopes: GLOBAL_SCOPE,
    readOnly: true,
    minimum: 0,
    unit: "ms",
    read: (manager) => manager.getRetrySettings().maxAgentDelayMs,
  },

  /* --- Red -------------------------------------------------------- */

  {
    key: "httpIdleTimeoutMs",
    category: "red",
    label: "Tiempo de espera sin datos",
    description:
      "Cuánto aguanta pi una conexión HTTP abierta que deja de enviar datos antes de " +
      "cortarla. Es lo que evita quedarse colgado en una respuesta que nunca llega.",
    kind: "number",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    minimum: 0,
    unit: "ms",
    read: (manager) => manager.getHttpIdleTimeoutMs(),
    write: (manager, _scope, value) =>
      manager.setHttpIdleTimeoutMs(toNumber(value, "httpIdleTimeoutMs")),
  },
  {
    key: "retry.provider.timeoutMs",
    category: "red",
    label: "Tiempo de espera de la llamada",
    description: "Límite de la llamada al proveedor antes de contar el intento como fallido.",
    kind: "number",
    scopes: GLOBAL_SCOPE,
    readOnly: true,
    minimum: 0,
    unit: "ms",
    read: (manager) => manager.getProviderRetrySettings().timeoutMs,
  },
  {
    key: "retry.provider.maxRetries",
    category: "red",
    label: "Reintentos del proveedor",
    description: "Cuántas veces pi repite una llamada al proveedor antes de rendirse.",
    kind: "number",
    scopes: GLOBAL_SCOPE,
    readOnly: true,
    minimum: 0,
    read: (manager) => manager.getProviderRetrySettings().maxRetries,
  },
  {
    key: "retry.provider.maxRetryDelayMs",
    category: "red",
    label: "Espera máxima entre reintentos",
    description: "Tope de la espera entre reintentos de la misma llamada al proveedor.",
    kind: "number",
    scopes: GLOBAL_SCOPE,
    readOnly: true,
    minimum: 0,
    unit: "ms",
    read: (manager) => manager.getProviderRetrySettings().maxRetryDelayMs,
  },
  {
    key: "websocketConnectTimeoutMs",
    category: "red",
    label: "Tiempo de espera al conectar por WebSocket",
    description: "Límite para establecer la conexión cuando el transporte es WebSocket.",
    kind: "number",
    scopes: GLOBAL_SCOPE,
    readOnly: true,
    minimum: 0,
    unit: "ms",
    read: (manager) => manager.getWebSocketConnectTimeoutMs(),
  },
  {
    key: "cacheWarming",
    category: "red",
    label: "Calentamiento de caché",
    description:
      "Mantiene la caché del proveedor al día para que la siguiente llamada sea más " +
      "barata. Cuesta dinero, por eso está apagado si no se pide.",
    kind: "select",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    options: CACHE_WARMING_OPTIONS,
    needsRestart: true,
    read: (manager) => manager.getCacheWarmingMode(),
    write: (manager, _scope, value) =>
      manager.setCacheWarmingMode(toSelect(value, "cacheWarming") as PiCacheWarmingMode),
  },
  {
    key: "transport",
    category: "red",
    label: "Transporte",
    description: "Cómo habla pi con el proveedor: por SSE, por WebSocket, o dejando que lo elija.",
    kind: "select",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    options: TRANSPORT_OPTIONS,
    needsRestart: true,
    read: (manager) => manager.getTransport(),
    write: (manager, _scope, value) =>
      manager.setTransport(toSelect(value, "transport") as PiTransport),
  },

  /* --- Herramientas y shell --------------------------------------- */

  {
    key: "shellPath",
    category: "herramientas",
    label: "Shell",
    description:
      "Intérprete con el que pi ejecuta los comandos. Vacío usa el shell del sistema.",
    kind: "text",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    read: (manager) => manager.getShellPath(),
    write: (manager, _scope, value) => manager.setShellPath(toOptionalText(value, "shellPath")),
  },
  {
    key: "shellCommandPrefix",
    category: "herramientas",
    label: "Prefijo de los comandos",
    description: "Texto que pi pone delante de cada comando: útil para activar un entorno antes de ejecutarlo.",
    kind: "text",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    read: (manager) => manager.getShellCommandPrefix(),
    write: (manager, _scope, value) =>
      manager.setShellCommandPrefix(toOptionalText(value, "shellCommandPrefix")),
  },
  {
    key: "npmCommand",
    category: "herramientas",
    label: "Comando de npm",
    description: "Programa y argumentos con los que pi instala paquetes, por ejemplo «pnpm install».",
    kind: "list",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    read: (manager) => manager.getNpmCommand(),
    write: (manager, _scope, value) => manager.setNpmCommand(toList(value, "npmCommand")),
  },
  {
    key: "externalEditor",
    category: "herramientas",
    label: "Editor externo",
    description:
      "Editor que pi abre para editar un texto largo. Si no está configurado, usa la " +
      "variable de entorno del sistema.",
    kind: "text",
    scopes: GLOBAL_SCOPE,
    readOnly: true,
    read: (manager) => manager.getExternalEditorCommand(),
  },
  {
    key: "quietStartup",
    category: "herramientas",
    label: "Arranque silencioso",
    description: "No anuncia la versión ni los avisos de inicio al abrir una sesión.",
    kind: "boolean",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    read: (manager) => manager.getQuietStartup(),
    write: (manager, _scope, value) => manager.setQuietStartup(toBoolean(value, "quietStartup")),
  },
  {
    key: "defaultProjectTrust",
    category: "herramientas",
    label: "Confianza por defecto en un proyecto",
    description:
      "Qué hace pi la primera vez que abre un proyecto que pide permisos: preguntar, " +
      "confiar siempre o no confiar nunca.",
    kind: "select",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    options: PROJECT_TRUST_OPTIONS,
    read: (manager) => manager.getDefaultProjectTrust(),
    write: (manager, _scope, value) =>
      manager.setDefaultProjectTrust(toSelect(value, "defaultProjectTrust") as PiDefaultProjectTrust),
  },

  /* --- Paquetes y recursos ---------------------------------------- *
   * The packages table is all this category keeps. The resource-path lists that used
   * to live here are gone from the surface; what remains is the setting pi can also
   * write per project. An empty list clears the scope's object; the project scope
   * needs a trusted project, which pi enforces itself and reports through
   * `drainErrors()`.
   */

  {
    key: "packages",
    category: "paquetes",
    label: "Paquetes",
    description:
      "Paquetes de npm o git de los que pi carga extensiones, skills, plantillas y temas.",
    kind: "packages",
    scopes: ALL_SCOPES,
    readOnly: false,
    read: (manager, scope) => {
      const stored = scopedRecord(manager, scope).packages;
      return stored === undefined ? undefined : stored.map(packageEntry);
    },
    write: (manager, scope, value) => {
      const entries = toPackageList(value, "packages");
      if (scope === "project") {
        manager.setProjectPackages(entries);
      } else {
        manager.setPackages(entries);
      }
    },
  },
  /*
   * The skills list. Its rows are not pi's settings: they come from the discovery
   * (`src/skills.ts`), which walks pi's own directory, every installed package and
   * the project. That is why the descriptor carries no value of its own and no
   * setter — the host injects the discovered rows into the pushed state, and the
   * switch a package skill draws rewrites that package's entry in `packages`, which
   * is the setting pi actually filters by. Manual path entry is deliberately gone:
   * the three routes are automatic.
   *
   * Both scopes are offered because the scope's own `packages` value decides whether
   * a package skill is on, so the two scopes legitimately show different states.
   */
  {
    key: "discoveredSkills",
    category: "skills",
    label: "Skills que ve pi",
    description:
      "Las skills que pi encuentra por sus tres vías automáticas: su propia carpeta, " +
      "las de los paquetes instalados y las del proyecto. Solo las de un paquete se " +
      "pueden activar o desactivar.",
    kind: "skills",
    scopes: ALL_SCOPES,
    readOnly: true,
  },
  {
    key: "enableSkillCommands",
    category: "skills",
    label: "Skills como comandos",
    description:
      "Registra las skills en la lista de comandos de barra para poder lanzarlas como " +
      "/nombre. Apagado, pi las conoce pero no las ofrece como comando.",
    kind: "boolean",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    read: (manager) => manager.getEnableSkillCommands(),
    write: (manager, _scope, value) =>
      manager.setEnableSkillCommands(toBoolean(value, "enableSkillCommands")),
  },
  /* --- Sesión ----------------------------------------------------- */

  {
    key: "steeringMode",
    category: "sesion",
    label: "Modo de guía",
    description:
      "Qué pasa cuando escribes mientras el agente trabaja: se le manda todo de golpe o " +
      "mensaje a mensaje.",
    kind: "select",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    options: STEERING_OPTIONS,
    read: (manager) => manager.getSteeringMode(),
    write: (manager, _scope, value) =>
      manager.setSteeringMode(toSelect(value, "steeringMode") as PiSteeringMode),
  },
  {
    key: "followUpMode",
    category: "sesion",
    label: "Modo de seguimiento",
    description:
      "Qué pasa con los mensajes enviados al terminar un turno: se encolan todos o se " +
      "van entregando de uno en uno.",
    kind: "select",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    options: STEERING_OPTIONS,
    read: (manager) => manager.getFollowUpMode(),
    write: (manager, _scope, value) =>
      manager.setFollowUpMode(toSelect(value, "followUpMode") as PiSteeringMode),
  },
  {
    key: "sessionDir",
    category: "sesion",
    label: "Carpeta de sesiones",
    description: "Dónde guarda pi las sesiones. Vacío usa la carpeta que pi elige por defecto.",
    kind: "text",
    scopes: GLOBAL_SCOPE,
    readOnly: true,
    read: (manager) => manager.getSessionDir(),
  },

  /* --- PiCode ------------------------------------------------------ *
   * Not pi's settings: these decide which pi runs and how PiCode talks to it, and
   * they live in this extension's own VS Code configuration. The descriptor keys
   * are namespaced because pi already has a `transport` setting of its own, and the
   * two mean different things: pi's picks the wire protocol to a provider, this one
   * picks the process boundary. Neither can reach a running agent, which is why both
   * say so.
   *
   * The version row is here with them and is the one that is not configuration: it
   * states which version of PiCode's own pi is installed, and installing the latest
   * published one is what its button does.
   */

  {
    key: "picode.runtime",
    category: "picode",
    label: "Qué pi se ejecuta",
    description:
      "El pi propio de PiCode va con versión fijada y aislado del global; el que ya " +
      "tienes instalado se resuelve desde tu PATH. Vale para las sesiones nuevas.",
    kind: "select",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    options: PICODE_RUNTIME_OPTIONS,
    picodeKey: "runtime",
    needsRestart: true,
  },
  {
    key: "picode.transport",
    category: "picode",
    label: "Cómo habla con pi",
    description:
      "RPC arranca pi como proceso aparte y se comunica por JSON en stdio; el SDK lo " +
      "carga dentro del editor, sin proceso hijo.",
    kind: "select",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    options: PICODE_TRANSPORT_OPTIONS,
    picodeKey: "transport",
    needsRestart: true,
  },
  {
    key: "picode.piVersion",
    category: "picode",
    label: "Versión del pi propio",
    description:
      "El pi propio de PiCode se instala aparte de tu pi global, con una versión " +
      "concreta. El botón instala la última publicada y reinicia pi para usarla.",
    kind: "action",
    scopes: GLOBAL_SCOPE,
    // No value to write: the row is a button. Its value comes from the host, which is
    // the only side that can read the version on disk and ask the registry for the
    // latest one; without that reading the row shows no line at all.
    readOnly: true,
    command: "picode.piChat.updatePi",
    actionLabel: "Instalar la última publicada",
    read: () => readPiVersionState?.(),
  },
  {
    key: "picode.onboarding",
    category: "picode",
    label: "Repetir la configuración inicial",
    description:
      "Vuelve a abrir el asistente de configuración inicial: qué pi ejecuta PiCode y " +
      "si Gentle AI está activo. No borra nada, rehace esas mismas elecciones sobre " +
      "lo que ya está configurado.",
    kind: "action",
    scopes: GLOBAL_SCOPE,
    // No value, therefore nothing to write; the renderer draws the button before
    // this flag is consulted.
    readOnly: true,
    command: "picode.piChat.onboarding",
  },
  {
    key: "picode.importProfile",
    category: "picode",
    label: "Importar el perfil de tu pi",
    description:
      "Trae al perfil propio de PiCode una copia de lo que tiene el pi que ya usas " +
      "en esta máquina. El original no se toca: solo se lee.",
    kind: "action",
    scopes: GLOBAL_SCOPE,
    // No value, therefore nothing to write. The row is one more entry point to the
    // command `instance-import-command.ts` already registers, and not a second
    // implementation of it: the whole flow stays in that module, and the row only
    // names it so the owner can find it without the palette.
    readOnly: true,
    command: "picode.piChat.importProfile",
    actionLabel: "Importar ahora",
  },

  /*
   * No descriptors for `estado` in this file, deliberately: it is pi's runtime
   * health (version, paths, providers, sessions, usage), and it is filled from the
   * live session rather than from this catalogue, so `describeSettings` skips it.
   */
];

/** Replaces every per-model thinking level with the given `proveedor/modelo=nivel` list. */
function writeModelThinkingLevels(manager: PiSettingsManager, value: PiSettingValue): void {
  const entries = toList(value, "modelThinkingLevels");

  const next = new Map<string, PiThinkingLevel>();
  for (const entry of entries) {
    const assignment = entry.indexOf("=");
    const target = assignment > 0 ? entry.slice(0, assignment).trim() : "";
    const level = assignment > 0 ? entry.slice(assignment + 1).trim() : "";
    const separator = target.indexOf("/");
    if (
      separator <= 0 ||
      separator === target.length - 1 ||
      !THINKING_LEVELS.includes(level as PiThinkingLevel)
    ) {
      throw new Error(
        `Setting "modelThinkingLevels" expects "provider/model-id=level" entries; got "${entry}".`,
      );
    }
    next.set(target, level as PiThinkingLevel);
  }

  for (const existing of Object.keys(manager.getAllModelThinkingLevels())) {
    if (next.has(existing)) {
      continue;
    }
    const separator = existing.indexOf("/");
    manager.removeModelThinkingLevel(existing.slice(0, separator), existing.slice(separator + 1));
  }
  for (const [target, level] of next) {
    const separator = target.indexOf("/");
    manager.setModelThinkingLevel(target.slice(0, separator), target.slice(separator + 1), level);
  }
}

/**
 * Groups descriptors by category, in `PI_SETTINGS_CATEGORIES` order, dropping the
 * categories that end up empty: the rail must not offer a category with nothing
 * behind it.
 */
export function describeSettings(
  descriptors: readonly PiSettingDescriptor[],
): readonly PiSettingsGroup[] {
  const groups: PiSettingsGroup[] = [];
  for (const category of PI_SETTINGS_CATEGORIES) {
    const settings = descriptors.filter((descriptor) => descriptor.category === category.id);
    if (settings.length > 0) {
      groups.push({ category, settings });
    }
  }
  return groups;
}

/** The serializable half of a descriptor, for the settings tab's webview. */
export function describeSettingWire(descriptor: PiSettingDescriptor): SettingWire {
  return {
    key: descriptor.key,
    category: descriptor.category,
    label: descriptor.label,
    description: descriptor.description,
    kind: descriptor.kind,
    readOnly: descriptor.readOnly,
    scopes: descriptor.scopes,
    ...(descriptor.options ? { options: descriptor.options } : {}),
    ...(descriptor.allowEmpty ? { allowEmpty: true } : {}),
    ...(descriptor.minimum !== undefined ? { minimum: descriptor.minimum } : {}),
    ...(descriptor.unit ? { unit: descriptor.unit } : {}),
    ...(descriptor.needsRestart ? { needsRestart: true } : {}),
    ...(descriptor.command ? { command: descriptor.command } : {}),
    ...(descriptor.actionLabel ? { actionLabel: descriptor.actionLabel } : {}),
  };
}

/** Lookup by key, built once so `write` is not a linear scan per keystroke. */
const DESCRIPTORS_BY_KEY: ReadonlyMap<string, PiSettingDescriptor> = new Map(
  PI_SETTING_DESCRIPTORS.map((descriptor) => [descriptor.key, descriptor]),
);

/* ------------------------------------------------------------------ *
 * The service
 * ------------------------------------------------------------------ */

/**
 * PiCode's own VS Code configuration, as the catalogue sees it.
 *
 * Injected rather than imported: this module stays free of `vscode` so it can be
 * loaded and exercised in plain Node, and the two rows that live in the editor's
 * configuration are testable against a fake.
 */
export interface PiCodeConfigStore {
  get(key: string): string | boolean | undefined;
  set(key: string, value: unknown): Promise<void>;
}

export interface PiSettingsServiceOptions {
  /** Absolute path of the pi package's ESM entry (`dist/index.js`). */
  entry: string;
  /** Working directory whose project settings are read. */
  cwd?: string;
  /** Global pi configuration directory. Omitted, pi resolves its own. */
  agentDir?: string;
  /** Loads the SDK. Injected so the service can be exercised without a real pi. */
  load?: () => Promise<PiSettingsModule>;
  /** PiCode's own configuration, for the descriptors that carry a `picodeKey`. */
  picode?: PiCodeConfigStore;
}

/** A problem worth showing in the Estado category later. */
export interface PiSettingsDiagnostic {
  type: string;
  message: string;
}

/**
 * `import()` that survives this project's CommonJS output.
 *
 * TypeScript rewrites a literal dynamic import to `require()` when the module
 * target is CommonJS, and pi publishes its entry as ESM that `require()` cannot
 * load. Building the import at runtime keeps it a genuine dynamic `import()`.
 */
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<unknown>;

async function loadSettingsModule(options: PiSettingsServiceOptions): Promise<PiSettingsModule> {
  if (options.load) {
    return options.load();
  }
  const loaded = await dynamicImport(pathToFileURL(options.entry).href);
  return loaded as PiSettingsModule;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads and writes pi's own settings through the installed SDK's typed API.
 *
 * The manager is created once and kept: it holds the parsed settings and the write
 * queue, and pi's setters are what keep a write safe against a pi running in
 * another process.
 */
export class PiSettingsService {
  private readonly manager: PiSettingsManager;
  /** PiCode's own configuration; absent when the caller did not supply one. */
  private readonly picode: PiCodeConfigStore | undefined;
  /** Problems pi reported while loading or writing its settings file. */
  private readonly sdkProblems: PiSettingsDiagnostic[] = [];
  /** Problems raised by a descriptor's getter during the last `readAll`. */
  private readProblems: PiSettingsDiagnostic[] = [];

  private constructor(manager: PiSettingsManager, picode: PiCodeConfigStore | undefined) {
    this.manager = manager;
    this.picode = picode;
  }

  static async create(options: PiSettingsServiceOptions): Promise<PiSettingsService> {
    const module = await loadSettingsModule(options);
    const cwd = options.cwd ?? process.cwd();
    const agentDir = options.agentDir ?? module.getAgentDir();
    const service = new PiSettingsService(
      module.SettingsManager.create(cwd, agentDir),
      options.picode,
    );
    // A settings file that does not parse is the first thing pi reports, and the
    // owner needs to see it rather than a list of default values.
    service.collectSdkProblems();
    return service;
  }

  /**
   * Current value of every descriptor, per scope.
   *
   * Every descriptor is returned, whatever the scope: the view decides what it can
   * offer from `scopes`, and a project row for a global-only setting still has to
   * show the value that is in force. A getter that throws contributes `undefined`
   * and a diagnostic, and the rest of the catalogue still renders — one broken
   * setting must not blank the whole tab.
   */
  async readAll(scope: PiSettingScope): Promise<Record<string, PiSettingValue>> {
    const values: Record<string, PiSettingValue> = {};
    this.readProblems = [];
    for (const descriptor of PI_SETTING_DESCRIPTORS) {
      try {
        values[descriptor.key] = this.readDescriptor(descriptor, scope);
      } catch (error) {
        values[descriptor.key] = undefined;
        this.readProblems.push({
          type: "read_error",
          message: `${descriptor.key}: ${asErrorMessage(error)}`,
        });
      }
    }
    return values;
  }

  /** One descriptor's current value, read from whichever store owns it. */
  private readDescriptor(
    descriptor: PiSettingDescriptor,
    scope: PiSettingScope,
  ): PiSettingValue {
    if (descriptor.picodeKey !== undefined) {
      return this.picode?.get(descriptor.picodeKey);
    }
    return descriptor.read?.(this.manager, scope);
  }

  /**
   * Writes one value through pi's own typed setter and flushes it.
   *
   * Returns the value pi actually stored, which is the coerced one: the caller
   * needs it because a running pi holds its settings in memory, so a write here
   * reaches the file and not the process. Empty (`undefined`) means the setting was
   * cleared.
   */
  async write(scope: PiSettingScope, key: string, value: unknown): Promise<PiSettingValue> {
    const descriptor = DESCRIPTORS_BY_KEY.get(key);
    if (!descriptor) {
      throw new Error(`Unknown setting "${key}".`);
    }
    // An action has nothing to write, and saying so is the honest answer: the
    // generic read-only message would blame pi for a missing setter that was never
    // part of the contract.
    if (descriptor.kind === "action") {
      throw new Error(
        `Setting "${key}" is an action: it runs a command and has no value to write.`,
      );
    }
    if (descriptor.picodeKey !== undefined) {
      if (!descriptor.scopes.includes(scope)) {
        throw new Error(
          `Setting "${key}" cannot be written in the "${scope}" scope; PiCode offers it globally.`,
        );
      }
      const store = this.picode;
      if (store === undefined) {
        throw new Error(
          `Setting "${key}" lives in PiCode's own configuration, which was not supplied.`,
        );
      }
      const configured = coerceSettingValue(descriptor, value);
      if (configured === undefined) {
        throw new Error(`Setting "${key}" does not accept this value as a ${descriptor.kind}.`);
      }
      await store.set(descriptor.picodeKey, configured);
      return configured;
    }
    const setter = descriptor.write;
    if (descriptor.readOnly || !setter) {
      throw new Error(
        `Setting "${key}" is read-only: pi has no setter for it, so nothing can be written.`,
      );
    }
    if (!descriptor.scopes.includes(scope)) {
      throw new Error(
        `Setting "${key}" cannot be written in the "${scope}" scope; pi has no such setter.`,
      );
    }

    const coerced = coerceSettingValue(descriptor, value);
    if (coerced === undefined && !isClearRequest(descriptor, value)) {
      throw new Error(`Setting "${key}" does not accept this value as a ${descriptor.kind}.`);
    }

    setter(this.manager, scope, coerced);
    await this.manager.flush();
    // A refused project write (an untrusted project) surfaces here rather than as
    // a rejected promise: pi records it and keeps going.
    this.collectSdkProblems();
    return coerced;
  }

  /** Re-reads after a write so the caller renders what pi actually holds. */
  async reload(): Promise<void> {
    await this.manager.reload();
    this.collectSdkProblems();
  }

  /** Problems the SDK reported, for the Estado category later. */
  diagnostics(): readonly PiSettingsDiagnostic[] {
    return [...this.sdkProblems, ...this.readProblems];
  }

  private collectSdkProblems(): void {
    for (const problem of this.manager.drainErrors()) {
      this.sdkProblems.push({
        type: "warning",
        message: problem.path
          ? `Invalid settings file ${problem.path}: ${problem.error.message}`
          : `Invalid ${problem.scope} settings: ${problem.error.message}`,
      });
    }
  }
}

/**
 * Whether `undefined` from {@link coerceSettingValue} means "clear this setting"
 * rather than "this value cannot be expressed".
 *
 * Only `text` has a way to say "unset" — an empty or whitespace-only string — so it
 * is the only kind where the two meanings collide. Every other kind refuses
 * `undefined` as an unexpressible value.
 */
function isClearRequest(descriptor: PiSettingDescriptor, value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  // A text row and a dynamic select (no declared options) both write the empty
  // string as "unset", because pi has no setter that clears the provider/model pair.
  return (
    descriptor.kind === "text" ||
    (descriptor.kind === "select" &&
      (descriptor.options === undefined || descriptor.options.length === 0))
  );
}
