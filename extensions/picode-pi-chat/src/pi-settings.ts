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
 *   the five resource lists (`packages`, `extensions`, `skills`, `prompts`,
 *   `themes`); everything else is global-only.
 */

import { pathToFileURL } from "node:url";
import type { PiThinkingLevel } from "./protocol";

export type PiSettingScope = "global" | "project";

export type PiSettingKind = "boolean" | "select" | "number" | "text" | "list";

export type PiSettingValue = boolean | number | string | string[] | undefined;

export type PiSettingsCategoryId =
  | "estado"
  | "picode"
  | "modelo"
  | "razonamiento"
  | "compactacion"
  | "reintentos"
  | "red"
  | "herramientas"
  | "paquetes"
  | "apariencia"
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
  /** True when no setter exists, so the row shows a value and no control. */
  readOnly: boolean;
  /** For `select`. */
  options?: readonly PiSettingOption[];
  /** For `number`: the smallest value the control accepts. */
  minimum?: number;
  /** For `number`: a short unit shown after the input ("ms", "tokens"). */
  unit?: string;
  /**
   * True when a running agent will not see the change until it restarts, so the
   * row can say so rather than the owner wondering why nothing happened.
   */
  needsRestart?: boolean;
  read(manager: PiSettingsManager, scope: PiSettingScope): PiSettingValue;
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

  /* Apariencia */
  getThemeSetting(): string | undefined;
  setTheme(theme: string): void;
  setThemePaths(paths: string[]): void;
  setProjectThemePaths(paths: string[]): void;
  getCollapseChangelog(): boolean;
  setCollapseChangelog(collapse: boolean): void;

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
 * are pi's own `Settings` keys, which is why the four resource lists are
 * `extensions`, `skills`, `prompts` and `themes` rather than "paths".
 */
export interface PiSettingsRecord {
  packages?: readonly PiPackageSource[];
  extensions?: readonly string[];
  skills?: readonly string[];
  prompts?: readonly string[];
  themes?: readonly string[];
}

/**
 * A package entry as pi stores it: a source string, or an object that filters which
 * resources the package contributes. Only the source is read and written here; the
 * filtering fields belong to pi's package manager, not to this surface.
 */
export type PiPackageSource = string | { source: string };

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
    id: "razonamiento",
    label: "Razonamiento",
    description: "Cuánto piensa el agente antes de responder y qué se muestra de ese proceso.",
  },
  {
    id: "compactacion",
    label: "Compactación",
    description: "Cuándo y cómo pi resume la conversación para no quedarse sin contexto.",
  },
  {
    id: "reintentos",
    label: "Reintentos",
    description: "Qué hace pi cuando una llamada al proveedor o un turno del agente falla.",
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
    description: "Qué paquetes, extensiones, skills, plantillas y temas carga pi, y qué telemetría envía.",
  },
  {
    id: "apariencia",
    label: "Apariencia",
    description: "Tema de pi y detalles de su interfaz.",
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
      const options = descriptor.options ?? [];
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
  }
}

/* ------------------------------------------------------------------ *
 * Reading and writing helpers
 * ------------------------------------------------------------------ */

/** The scope's own settings object, which is the only per-scope read there is. */
function scopedRecord(manager: PiSettingsManager, scope: PiSettingScope): PiSettingsRecord {
  return scope === "project" ? manager.getProjectSettings() : manager.getGlobalSettings();
}

/** The source id of a package entry, whichever of pi's two forms it was stored in. */
function packageId(entry: PiPackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
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
 * Text a setter requires as a string. `undefined` here means "unset", and the three
 * settings that use this helper (default provider, default model, theme) have no
 * setter that clears them, so the empty string — which pi's own readers treat as
 * unset — is what is written.
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
  return [...value];
}

/** The resource lists that hold plain paths; `packages` is the one that does not. */
type PiSettingsStringListField = "extensions" | "skills" | "prompts" | "themes";

/** Reads a resource list out of one scope, leaving "not set here" as `undefined`. */
function readScopedList(
  manager: PiSettingsManager,
  scope: PiSettingScope,
  field: PiSettingsStringListField,
): string[] | undefined {
  const stored = scopedRecord(manager, scope)[field];
  return stored === undefined ? undefined : [...stored];
}

/* ------------------------------------------------------------------ *
 * The catalogue
 * ------------------------------------------------------------------ */

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
      "Proveedor con el que arrancan las sesiones nuevas. Un modelo sin proveedor se " +
      "resuelve contra el catálogo completo.",
    kind: "text",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    read: (manager) => manager.getDefaultProvider(),
    // pi has no setter that clears this pair, so "vacío" writes an empty string,
    // which pi's own readers already treat as unset.
    write: (manager, _scope, value) => manager.setDefaultProvider(toRequiredText(value, "defaultProvider")),
  },
  {
    key: "defaultModel",
    category: "modelo",
    label: "Modelo por defecto",
    description:
      "Modelo que usan las sesiones nuevas. Déjalo vacío para que pi siga con el que " +
      "ya tenga configurado.",
    kind: "text",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    read: (manager) => manager.getDefaultModel(),
    write: (manager, _scope, value) => manager.setDefaultModel(toRequiredText(value, "defaultModel")),
  },

  /* --- Razonamiento ----------------------------------------------- */

  {
    key: "defaultThinkingLevel",
    category: "razonamiento",
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
    category: "razonamiento",
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
    category: "razonamiento",
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
    category: "razonamiento",
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

  /* --- Compactación ----------------------------------------------- *
   * All five are read-only: pi exposes getters for the compaction and branch-summary
   * token budgets but no setter for any of them, so the row shows the value pi
   * resolved (including its own default when the setting is absent) and offers no
   * control rather than a control that cannot work.
   */

  {
    key: "compaction.enabled",
    category: "compactacion",
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
    category: "compactacion",
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
    category: "compactacion",
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
    category: "compactacion",
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
    category: "compactacion",
    label: "No preguntar al resumir una rama",
    description: "Resume la rama directamente, sin pedir confirmación antes de continuar.",
    kind: "boolean",
    scopes: GLOBAL_SCOPE,
    readOnly: true,
    read: (manager) => manager.getBranchSummarySettings().skipPrompt,
  },

  /* --- Reintentos ------------------------------------------------- *
   * Only `enabled` has a setter. pi reads the three numbers from the settings file
   * but publishes no way to write them, so they are shown as they are.
   */

  {
    key: "retry.enabled",
    category: "reintentos",
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
    category: "reintentos",
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
    category: "reintentos",
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
    category: "reintentos",
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
   * The five resource lists are the only settings pi can also write per project,
   * and each one has a different setter for each scope. An empty list clears the
   * scope's object; the project scope needs a trusted project, which pi enforces
   * itself and reports through `drainErrors()`.
   */

  {
    key: "packages",
    category: "paquetes",
    label: "Paquetes",
    description:
      "Paquetes de npm o git de los que pi carga extensiones, skills, plantillas y temas.",
    kind: "list",
    scopes: ALL_SCOPES,
    readOnly: false,
    read: (manager, scope) => {
      const stored = scopedRecord(manager, scope).packages;
      return stored === undefined ? undefined : stored.map(packageId);
    },
    write: (manager, scope, value) => {
      const entries = toList(value, "packages");
      if (scope === "project") {
        manager.setProjectPackages(entries);
      } else {
        manager.setPackages(entries);
      }
    },
  },
  {
    key: "extensions",
    category: "paquetes",
    label: "Rutas de extensiones",
    description: "Carpetas o ficheros con extensiones de pi que se cargan además de las de los paquetes.",
    kind: "list",
    scopes: ALL_SCOPES,
    readOnly: false,
    read: (manager, scope) => readScopedList(manager, scope, "extensions"),
    write: (manager, scope, value) => {
      const paths = toList(value, "extensions");
      if (scope === "project") {
        manager.setProjectExtensionPaths(paths);
      } else {
        manager.setExtensionPaths(paths);
      }
    },
  },
  {
    key: "skills",
    category: "paquetes",
    label: "Rutas de skills",
    description: "Carpetas con skills que pi puede invocar como comandos.",
    kind: "list",
    scopes: ALL_SCOPES,
    readOnly: false,
    read: (manager, scope) => readScopedList(manager, scope, "skills"),
    write: (manager, scope, value) => {
      const paths = toList(value, "skills");
      if (scope === "project") {
        manager.setProjectSkillPaths(paths);
      } else {
        manager.setSkillPaths(paths);
      }
    },
  },
  {
    key: "prompts",
    category: "paquetes",
    label: "Rutas de plantillas de prompt",
    description: "Carpetas con plantillas que el owner lanza como comandos de barra.",
    kind: "list",
    scopes: ALL_SCOPES,
    readOnly: false,
    read: (manager, scope) => readScopedList(manager, scope, "prompts"),
    write: (manager, scope, value) => {
      const paths = toList(value, "prompts");
      if (scope === "project") {
        manager.setProjectPromptTemplatePaths(paths);
      } else {
        manager.setPromptTemplatePaths(paths);
      }
    },
  },
  {
    key: "enableInstallTelemetry",
    category: "paquetes",
    label: "Telemetría de instalación",
    description:
      "Envía a pi un aviso anónimo cuando se instala o actualiza un paquete. Ayuda a " +
      "saber qué paquetes se usan de verdad.",
    kind: "boolean",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    read: (manager) => manager.getEnableInstallTelemetry(),
    write: (manager, _scope, value) =>
      manager.setEnableInstallTelemetry(toBoolean(value, "enableInstallTelemetry")),
  },
  {
    key: "enableAnalytics",
    category: "paquetes",
    label: "Analítica",
    description:
      "Envía estadísticas de uso a pi. Al activarla por primera vez se genera un " +
      "identificador anónimo que acompaña a esos envíos.",
    kind: "boolean",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    read: (manager) => manager.getEnableAnalytics(),
    write: (manager, _scope, value) =>
      manager.setEnableAnalytics(toBoolean(value, "enableAnalytics")),
  },

  /* --- Apariencia ------------------------------------------------- *
   * `theme` has no project setter (only the theme *paths* do), so the theme itself
   * is global-only and the project scope would be a control that cannot work.
   */

  {
    key: "theme",
    category: "apariencia",
    label: "Tema",
    description: "Tema que pi usa en su propia interfaz.",
    kind: "text",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    read: (manager) => manager.getThemeSetting(),
    write: (manager, _scope, value) => manager.setTheme(toRequiredText(value, "theme")),
  },
  {
    key: "themes",
    category: "apariencia",
    label: "Rutas de temas",
    description: "Carpetas con temas propios que se suman a los que pi ya trae.",
    kind: "list",
    scopes: ALL_SCOPES,
    readOnly: false,
    read: (manager, scope) => readScopedList(manager, scope, "themes"),
    write: (manager, scope, value) => {
      const paths = toList(value, "themes");
      if (scope === "project") {
        manager.setProjectThemePaths(paths);
      } else {
        manager.setThemePaths(paths);
      }
    },
  },
  {
    key: "collapseChangelog",
    category: "apariencia",
    label: "Changelog plegado",
    description: "Muestra el changelog de una versión nueva plegado en lugar de abierto.",
    kind: "boolean",
    scopes: GLOBAL_SCOPE,
    readOnly: false,
    read: (manager) => manager.getCollapseChangelog(),
    write: (manager, _scope, value) =>
      manager.setCollapseChangelog(toBoolean(value, "collapseChangelog")),
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

  /*
   * No descriptors for `estado` and `picode` in this file, deliberately. Both
   * categories are declared above so the rail has its final order, but what fills
   * them is not a setting of pi: `estado` is pi's runtime health (version, paths,
   * providers, sessions, usage) and `picode` is this extension's own configuration.
   * Later tasks add them; until then `describeSettings` skips both.
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

/** Lookup by key, built once so `write` is not a linear scan per keystroke. */
const DESCRIPTORS_BY_KEY: ReadonlyMap<string, PiSettingDescriptor> = new Map(
  PI_SETTING_DESCRIPTORS.map((descriptor) => [descriptor.key, descriptor]),
);

/* ------------------------------------------------------------------ *
 * The service
 * ------------------------------------------------------------------ */

export interface PiSettingsServiceOptions {
  /** Absolute path of the pi package's ESM entry (`dist/index.js`). */
  entry: string;
  /** Working directory whose project settings are read. */
  cwd?: string;
  /** Global pi configuration directory. Omitted, pi resolves its own. */
  agentDir?: string;
  /** Loads the SDK. Injected so the service can be exercised without a real pi. */
  load?: () => Promise<PiSettingsModule>;
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
  /** Problems pi reported while loading or writing its settings file. */
  private readonly sdkProblems: PiSettingsDiagnostic[] = [];
  /** Problems raised by a descriptor's getter during the last `readAll`. */
  private readProblems: PiSettingsDiagnostic[] = [];

  private constructor(manager: PiSettingsManager) {
    this.manager = manager;
  }

  static async create(options: PiSettingsServiceOptions): Promise<PiSettingsService> {
    const module = await loadSettingsModule(options);
    const cwd = options.cwd ?? process.cwd();
    const agentDir = options.agentDir ?? module.getAgentDir();
    const service = new PiSettingsService(module.SettingsManager.create(cwd, agentDir));
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
        values[descriptor.key] = descriptor.read(this.manager, scope);
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

  /** Writes one value through pi's own typed setter and flushes it. */
  async write(scope: PiSettingScope, key: string, value: unknown): Promise<void> {
    const descriptor = DESCRIPTORS_BY_KEY.get(key);
    if (!descriptor) {
      throw new Error(`Unknown setting "${key}".`);
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
  return descriptor.kind === "text" && typeof value === "string";
}
