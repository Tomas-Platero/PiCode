import * as vscode from "vscode";
import {
  parseInstalledPackages,
  runPiCli,
  searchCatalog,
  type CatalogPackage,
  type InstalledPackage,
} from "./pi-cli";
import type { ResolvedRuntime } from "./runtime";
import type { PiSlashCommand } from "./protocol";
import type { PiSettingsCategoryId } from "./pi-settings";
import { formatBytes, type SessionSummary } from "./sessions";
import { emptyUsage, describeUsage, summarizeUsage, type UsageTotals } from "./usage";
import { summarizeGentleCategory, describeGentle, type GentleState } from "./gentle";

/**
 * pi's configuration, as a categorized popup.
 *
 * The owner asked for the shape the Settings editor has: a first level of
 * categories, each showing its current value, and a second level with the settings
 * inside, with a way back. It is all native quick picks, so the editor's filtering,
 * keyboard handling and accessibility come for free instead of being rebuilt in a
 * webview.
 *
 * The levels are built by pure functions, so what the popup claims about live state
 * is testable without an editor.
 */

export type PiCategoryId =
  | "modelo"
  | "extensiones"
  | "runtime"
  | "proveedores"
  | "gentle"
  | "sesion";

export const CATEGORY_LABELS: Record<PiCategoryId, string> = {
  modelo: "Modelo y razonamiento",
  extensiones: "Extensiones de pi",
  runtime: "Qué pi se ejecuta",
  proveedores: "Proveedores y credenciales",
  gentle: "Gentle AI",
  sesion: "Sesión de pi",
};

/**
 * The sidebar's declared order, and therefore the complete set of ids it can post.
 *
 * Gentle AI is deliberately absent. The layer has its own activity-bar entry and its own
 * panel, so the row here was a second door to the same room; the card keeps only the
 * doors that lead somewhere new. `gentle` is still a declared `PiCategoryId` — the
 * settings popup implements that category — but no sidebar row can produce it any more.
 *
 * Exported because it is the one source of truth for that set: a guard elsewhere has to
 * derive from it instead of repeating the ids, which is exactly how `gentle` was once
 * dropped from a hand-written chain and the Gentle AI row opened the settings tab.
 */
export const CATEGORY_ORDER: readonly PiCategoryId[] = [
  "modelo",
  "extensiones",
  "runtime",
  "proveedores",
  "sesion",
];

/**
 * The Gentle AI panel, reached through the container the activity-bar entry opens.
 *
 * It is a marker rather than a rail id on purpose: `gentle` is not a settings
 * category, so its target has to be distinguishable from one.
 */
export const GENTLE_PANEL_TARGET = "workbench.view.extension.picode-gentle";

/**
 * Where each sidebar category actually lives.
 *
 * The sidebar and the settings rail are two separate id spaces: this one is the
 * sidebar's (`PiCategoryId`), and the rail's is `PI_SETTINGS_CATEGORIES`. The sidebar
 * posts its own id, and a rail that does not know it silently opens on its first
 * category — which is exactly the bug this table fixes. Keeping the translation as
 * data here, next to the labels and the order it belongs with, is what lets a test
 * assert that every target still exists in the rail and stop the two lists drifting
 * apart again.
 */
export const CATEGORY_TARGETS: Record<
  PiCategoryId,
  PiSettingsCategoryId | typeof GENTLE_PANEL_TARGET
> = {
  modelo: "modelo",
  extensiones: "paquetes",
  runtime: "picode",
  // `proveedores` has no section of its own yet: credentials get one later in the
  // program, and until then the model section is the closest honest target, since
  // that is where a provider is actually chosen.
  proveedores: "modelo",
  // `gentle` is not a settings category at all. Its value is not a rail id: it means
  // "the Gentle AI container", and the boundary opens that panel instead.
  //
  // It stays declared even though the card no longer draws the row, because the `Record`
  // above needs a destination for every id it declares and `gentle` is still a
  // `PiCategoryId`: the settings popup implements that category. Removing this entry
  // means removing the popup's category first, not just the row that used to reach it.
  gentle: GENTLE_PANEL_TARGET,
  sesion: "sesion",
};

/**
 * Translates a sidebar id, and leaves everything else exactly as it arrived.
 *
 * Only the sidebar's own ids are translated. A rail id, or no id at all, is passed
 * through untouched, so the palette command and every other caller keep behaving as
 * they always did.
 */
export function resolveCategoryTarget(category: string | undefined): string | undefined {
  if (category === undefined || !Object.hasOwn(CATEGORY_TARGETS, category)) {
    return category;
  }
  return CATEGORY_TARGETS[category as PiCategoryId];
}

export interface PiMenuSnapshot {
  model?: string;
  reasoning?: string;
  runtime: string;
  runtimeAvailable: boolean;
  /** How PiCode talks to pi, already phrased for display. */
  transport: string;
  /** False when the active pi publishes no SDK entry, so only RPC can run. */
  embeddedAvailable: boolean;
  managedInstalled: boolean;
  installedCount?: number;
  messageCount?: number;
  streaming: boolean;
  providerCount?: number;
  gentle?: GentleState;
  /** What the session has cost, when a session has said anything yet. */
  usage?: UsageTotals;
  contextWindow?: number;
  /** Everything the session has loaded: commands, prompt templates and skills. */
  commands?: readonly PiSlashCommand[];
}

export interface PiCategoryRow {
  id: PiCategoryId;
  label: string;
  description?: string;
  detail?: string;
}

/**
 * The first level: the door each category opens, and the value behind it.
 *
 * The visible second line says what pressing the row does, not what the value is: the
 * sidebar draws only this line, and the card above it already carries the pi, the model
 * and the extension count. The current value travels in `detail`, which the popup shows
 * under the row and the sidebar deliberately does not, so no fact is stated twice on the
 * card.
 */
export function buildCategories(snapshot: PiMenuSnapshot): PiCategoryRow[] {
  const installed =
    snapshot.installedCount === undefined ? "contando…" : `${snapshot.installedCount} instaladas`;
  const providers =
    snapshot.providerCount === undefined ? "leyendo…" : `${snapshot.providerCount} con modelos`;
  const messages =
    snapshot.messageCount === undefined ? "sin sesión" : `${snapshot.messageCount} mensajes`;
  const session = `${snapshot.streaming ? "Trabajando" : "En reposo"} · ${messages}`;

  return CATEGORY_ORDER.map((id) => {
    switch (id) {
      case "modelo":
        return {
          id,
          label: CATEGORY_LABELS.modelo,
          description: "Elegir el modelo y cuánto razona",
          detail: `Modelo: ${snapshot.model ?? "sin modelo"} · razonamiento: ${
            snapshot.reasoning ?? "no disponible"
          }`,
        };
      case "extensiones":
        return {
          id,
          label: CATEGORY_LABELS.extensiones,
          description: "Ver y gestionar los paquetes",
          detail: installed,
        };
      case "runtime":
        return {
          id,
          label: CATEGORY_LABELS.runtime,
          description: "Cambiar qué pi se ejecuta",
          detail: `${snapshot.runtime} · ${snapshot.transport}${
            snapshot.runtimeAvailable ? "" : " · no encontrado"
          }`,
        };
      case "proveedores":
        return {
          id,
          label: CATEGORY_LABELS.proveedores,
          description: "Configurar accesos",
          detail: providers,
        };
      default:
        return {
          id: "sesion",
          label: CATEGORY_LABELS.sesion,
          description: "Uso, conversaciones y reinicio",
          detail: session,
        };
    }
  });
}

export type PiSettingAction =
  | "back"
  | "model"
  | "thinking"
  | "installed"
  | "search"
  | "installSource"
  | "installLocal"
  | "update"
  | "runtime"
  | "transport"
  | "reinstallRuntime"
  | "provider"
  | "gentleStatus"
  | "gentleReview"
  | "gentleTelemetry"
  | "gentleSdd"
  | "gentleDoctor"
  | "gentleInstall"
  | "gentleCommand"
  | "usage"
  | "sessions"
  | "piCommands"
  | "newSession"
  | "abort"
  | "restart";

export interface PiSettingRow {
  kind: "item" | "separator";
  label: string;
  description?: string;
  detail?: string;
  action?: PiSettingAction;
  /** Set for the provider rows, so the action knows which one was chosen. */
  provider?: string;
  /** Set for the gentle rows, which send the command as a prompt. */
  command?: string;
}

export interface ProviderSummary {
  name: string;
  models: number;
}

/** What the popup needs from Gentle AI, in one place. */
export interface GentleActions {
  state(): Promise<GentleState>;
  /** Runs a gentle-ai subcommand and returns its output, for the report popup. */
  run(args: readonly string[], title: string): Promise<string>;
  setReview(on: boolean): Promise<void>;
  telemetry(action: "enable" | "disable" | "preview"): Promise<void>;
  install(): Promise<void>;
}

/**
 * The second level: the settings inside a category.
 *
 * A "back" row opens the list rather than closing the popup, because Escape is the
 * only other way out of a quick pick and losing the menu entirely just to move up
 * one level is the opposite of how the Settings editor behaves.
 */
export function buildCategorySettings(
  category: PiCategoryId,
  snapshot: PiMenuSnapshot,
  providers: readonly ProviderSummary[] = [],
): PiSettingRow[] {
  const back: PiSettingRow = {
    kind: "item",
    action: "back",
    label: "‹ Volver a las categorías",
  };

  switch (category) {
    case "modelo":
      return [
        back,
        { kind: "separator", label: "Sesión actual" },
        {
          kind: "item",
          action: "model",
          label: `Modelo: ${snapshot.model ?? "sin modelo"}`,
          detail: "Elegir el modelo de esta sesión",
        },
        {
          kind: "item",
          action: "thinking",
          label: `Razonamiento: ${snapshot.reasoning ?? "no disponible"}`,
          detail: "Nivel de razonamiento del modelo actual",
        },
      ];

    case "extensiones":
      return [
        back,
        { kind: "separator", label: "Paquetes" },
        {
          kind: "item",
          action: "installed",
          label:
            snapshot.installedCount === undefined
              ? "Extensiones instaladas…"
              : `Extensiones instaladas (${snapshot.installedCount})…`,
          detail: "Ver las que pi carga, y quitar",
        },
        {
          kind: "item",
          action: "search",
          label: "Buscar e instalar…",
          detail: "Catálogo de paquetes de pi, por nombre o por lo que hacen",
        },
        {
          kind: "item",
          action: "update",
          label: "Actualizar extensiones",
          detail: "Ejecuta pi update --extensions",
        },
        { kind: "separator", label: "Desde otra fuente" },
        {
          kind: "item",
          action: "installSource",
          label: "Instalar desde una fuente…",
          detail: "Una especificación de pi: npm:paquete, git:github.com/usuario/repo@v1, o una URL de git",
        },
        {
          kind: "item",
          action: "installLocal",
          label: "Instalar desde una carpeta local…",
          detail: "El catálogo es solo npm; esto cubre repos git y rutas del disco",
        },
      ];

    case "runtime":
      return [
        back,
        { kind: "separator", label: "Runtime" },
        {
          kind: "item",
          action: "runtime",
          label: `En uso: ${snapshot.runtime}`,
          detail: "Elegir entre el pi de tu PATH, el de PiCode o uno concreto",
        },
        {
          kind: "item",
          action: "transport",
          label: `Transporte: ${snapshot.transport}`,
          detail: snapshot.embeddedAvailable
            ? "RPC arranca pi como proceso aparte; el embebido lo carga dentro del editor"
            : "El pi activo no publica una entrada del SDK, así que solo RPC puede ejecutarse",
        },
        {
          kind: "item",
          action: "reinstallRuntime",
          label: snapshot.managedInstalled
            ? "Reinstalar el pi propio de PiCode"
            : "Instalar el pi propio de PiCode",
          detail: "Versión fijada, dentro de la distribución y aislado del global",
        },
      ];

    case "proveedores": {
      if (providers.length === 0) {
        return [
          back,
          { kind: "separator", label: "Proveedores" },
          { kind: "item", label: "Ningún proveedor con modelos configurados" },
        ];
      }
      return [
        back,
        { kind: "separator", label: "Proveedores" },
        ...providers.map(
          (provider): PiSettingRow => ({
            kind: "item",
            action: "provider",
            provider: provider.name,
            label: provider.name,
            description: provider.models === 1 ? "1 modelo" : `${provider.models} modelos`,
            detail: "Comprobar si tiene credenciales listas",
          }),
        ),
      ];
    }

    case "gentle": {
      const gentle = snapshot.gentle;
      const rows: PiSettingRow[] = [back, { kind: "separator", label: "Estado" }];

      rows.push({
        kind: "item",
        action: "gentleStatus",
        label: `Gentle AI: ${summarizeGentleCategory(gentle)}`,
        detail: "Paquete, binario, versión y si está cargado en esta sesión",
      });

      if (gentle === undefined || !gentle.installed) {
        rows.push({
          kind: "item",
          action: "gentleInstall",
          label: "Instalar gentle-pi",
          detail: "Se instalará con pi install npm:gentle-pi",
        });
        return rows;
      }

      const rdd = gentle.review.rdd;
      rows.push(
        {
          kind: "item",
          action: "gentleReview",
          label: `Revisión por candidato: ${rdd === "unknown" ? "desconocida" : rdd}`,
          detail:
            rdd === "on"
              ? "Pulsa para desactivarla (global " +
                gentle.review.global +
                ", clon " +
                gentle.review.cloneLocal +
                ")"
              : "Pulsa para activarla",
        },
        {
          kind: "item",
          action: "gentleTelemetry",
          label: `Telemetría anónima: ${gentle.telemetry}`,
          detail: "Activar, desactivar o ver exactamente qué se enviaría",
        },
        {
          kind: "item",
          action: "gentleSdd",
          label: "ODD: fase del cambio activo",
          detail: "Ejecuta gentle-ai sdd-status",
        },
        {
          kind: "item",
          action: "gentleDoctor",
          label: "Diagnóstico del ecosistema",
          detail: "Ejecuta gentle-ai doctor",
        },
      );

      if (gentle.commands.length > 0) {
        rows.push({
          kind: "separator",
          label: gentle.active ? "Comandos cargados" : "Comandos (requieren reiniciar pi)",
        });
        for (const command of gentle.commands) {
          rows.push({
            kind: "item",
            action: "gentleCommand",
            command,
            label: command,
            detail: "Se envía al agente como un mensaje",
          });
        }
      }

      return rows;
    }

    default:
      return [
        back,
        { kind: "separator", label: "Uso" },
        {
          kind: "item",
          action: "usage",
          label: "Uso y coste",
          description: usageSummary(snapshot),
          detail: "Tokens, coste acumulado y cuánto contexto queda",
        },
        { kind: "separator", label: "Conversación" },
        { kind: "item", action: "newSession", label: "Nueva sesión", detail: "Empieza de cero" },
        {
          kind: "item",
          action: "sessions",
          // No count here on purpose: it would mean reading every session file to draw a
          // menu, and the picker shows the list anyway.
          label: "Sesiones de este proyecto…",
          detail: "Reanudar una conversación anterior de esta carpeta",
        },
        {
          kind: "item",
          action: "abort",
          label: "Detener la ejecución",
          detail: snapshot.streaming ? "Hay una ejecución en curso" : "No hay nada en curso",
        },
        { kind: "separator", label: "Comandos" },
        {
          kind: "item",
          action: "piCommands",
          label:
            snapshot.commands === undefined
              ? "Comandos de pi…"
              : `Comandos de pi (${snapshot.commands.length})…`,
          // Everything the session loaded, not only what PiCode happened to know about:
          // extensions, prompt templates and skills all register here.
          detail: "Los que la sesión tiene cargados: extensiones, plantillas y skills",
        },
        { kind: "separator", label: "Proceso" },
        {
          kind: "item",
          action: "restart",
          label: "Reiniciar pi",
          detail: "Recarga el runtime y las extensiones que pi cargue al arrancar",
        },
      ];
  }
}

/** The usage row's value: the same line the chat panel shows under its toolbar. */
function usageSummary(snapshot: PiMenuSnapshot): string {
  if (!snapshot.usage) {
    return "sin datos";
  }
  return summarizeUsage(snapshot.usage, snapshot.contextWindow) || "sin respuestas todavía";
}

/** The session's cost, broken down, in a report rather than a row. */
function showUsage(snapshot: PiMenuSnapshot): void {
  void vscode.window.showInformationMessage("PiCode: uso y coste de la sesión", {
    modal: true,
    detail: describeUsage(snapshot.usage ?? emptyUsage(), snapshot.contextWindow).join("\n"),
  });
}

/** One line for what `pi auth check` answered, without pretending to interpret it. */
export function describeAuthCheck(output: string): string {
  try {
    const parsed = JSON.parse(output.trim()) as { status?: unknown; reason?: unknown };
    const status = typeof parsed.status === "string" ? parsed.status : "desconocido";
    const reason = typeof parsed.reason === "string" ? ` (${parsed.reason})` : "";
    return `${status}${reason}`;
  } catch {
    return output.trim() || "sin respuesta";
  }
}

export interface PiMenuDeps {
  runtime(): ResolvedRuntime;
  /**
   * The environment additions that point a spawned pi at the profile of the instance
   * the active runtime selects: `PI_CODING_AGENT_DIR` for PiCode's own instance,
   * nothing for the owner's. Read from the same setting as {@link runtime}, so the
   * profile always follows the program — this object is where the menu gets both.
   */
  profileEnv(): Record<string, string>;
  /** Current session, runtime and counts, for the popup's own labels. */
  snapshot(): Promise<PiMenuSnapshot>;
  providers(): Promise<ProviderSummary[]>;
  selectModel(): Promise<void>;
  selectThinkingLevel(): Promise<void>;
  selectRuntime(): Promise<void>;
  selectTransport(): Promise<void>;
  installManagedRuntime(): Promise<void>;
  /**
   * Sends a slash command to the running session as a message.
   *
   * General rather than gentle-specific: a command is a command, whoever registered it.
   */
  sendCommand(name: string): Promise<void>;
  /** The conversations pi has for this project, newest first. */
  sessions(): Promise<SessionSummary[]>;
  /** Loads one of them into the running agent. */
  resumeSession(session: SessionSummary): Promise<void>;
  gentle: GentleActions;
  newSession(): Promise<void>;
  abort(): Promise<void>;
  restart(): Promise<void>;
  log(line: string): void;
  offerRestart(what: string): void;
}

/**
 * The categorized popup. Escape always leaves; "Volver" moves up one level.
 *
 * `startAt` opens straight into a category, which is what the sidebar's buttons do:
 * the icon gets you the category, the popup gets you the settings.
 */
export async function showPiMenu(deps: PiMenuDeps, startAt?: PiCategoryId): Promise<void> {
  deps.log("menú de pi abierto");
  let level: PiCategoryId | undefined = startAt;

  for (;;) {
    const snapshot = await deps.snapshot();

    if (level === undefined) {
      const picked = await pickCategory(snapshot);
      if (!picked) {
        return;
      }
      level = picked;
      continue;
    }

    const category = level;
    const providers = category === "proveedores" ? await deps.providers() : [];
    const chosen = await pickSetting(category, snapshot, providers);
    if (chosen === undefined) {
      return;
    }
    if (chosen.action === "back") {
      level = undefined;
      continue;
    }

    // A category stays open after a change, the way the Settings editor does, so
    // several settings can be adjusted without walking back through the levels.
    const keepGoing = await runSetting(deps, category, chosen, snapshot);
    if (!keepGoing) {
      return;
    }
  }
}

async function pickCategory(snapshot: PiMenuSnapshot): Promise<PiCategoryId | undefined> {
  interface CategoryItem extends vscode.QuickPickItem {
    id: PiCategoryId;
  }

  const items: CategoryItem[] = buildCategories(snapshot).map((row) => ({
    id: row.id,
    label: row.label,
    ...(row.description ? { description: row.description } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: "PiCode",
    placeHolder: "Configuración de pi",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.id;
}

async function pickSetting(
  category: PiCategoryId,
  snapshot: PiMenuSnapshot,
  providers: readonly ProviderSummary[],
): Promise<PiSettingRow | undefined> {
  interface SettingItem extends vscode.QuickPickItem {
    row: PiSettingRow;
  }

  const items: SettingItem[] = buildCategorySettings(category, snapshot, providers).map((row) => ({
    row,
    label: row.label,
    ...(row.kind === "separator" ? { kind: vscode.QuickPickItemKind.Separator } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: `PiCode: ${CATEGORY_LABELS[category]}`,
    placeHolder: "Elige un ajuste",
    matchOnDetail: true,
  });
  return picked?.row;
}

/** Returns false when the popup should close instead of returning to the category. */
async function runSetting(
  deps: PiMenuDeps,
  category: PiCategoryId,
  row: PiSettingRow,
  snapshot: PiMenuSnapshot,
): Promise<boolean> {
  switch (row.action) {
    case "usage":
      // The snapshot is already in hand, so the report does not re-read the state.
      showUsage(snapshot);
      return true;
    case "piCommands":
      await showPiCommands(deps, snapshot);
      return true;
    case "sessions":
      await showSessions(deps);
      return false;
    case "model":
      await deps.selectModel();
      return true;
    case "thinking":
      await deps.selectThinkingLevel();
      return true;
    case "runtime":
      await deps.selectRuntime();
      return true;
    case "transport":
      await deps.selectTransport();
      return true;
    case "reinstallRuntime":
      await deps.installManagedRuntime();
      return true;
    case "newSession":
      await deps.newSession();
      return true;
    case "abort":
      await deps.abort();
      return true;
    case "restart":
      await deps.restart();
      return false;
    case "installed":
      await showInstalledPackages(deps);
      return category === "extensiones";
    case "search":
      await showCatalogSearch(deps);
      return category === "extensiones";
    case "installSource":
      await installFromInput(deps);
      return category === "extensiones";
    case "installLocal":
      await installFromFolder(deps);
      return category === "extensiones";
    case "update":
      await updateExtensions(deps);
      return category === "extensiones";
    case "provider":
      if (row.provider) {
        await checkProvider(deps, row.provider);
      }
      return true;
    case "gentleStatus":
      await showGentleStatus(deps);
      return true;
    case "gentleReview": {
      const state = await deps.gentle.state();
      await deps.gentle.setReview(state.review.rdd !== "on");
      return true;
    }
    case "gentleTelemetry":
      await showGentleTelemetry(deps);
      return true;
    case "gentleSdd":
      await deps.gentle.run(["sdd-status"], "PiCode: ODD");
      return true;
    case "gentleDoctor":
      await deps.gentle.run(["doctor"], "PiCode: diagnóstico de Gentle AI");
      return true;
    case "gentleInstall":
      await deps.gentle.install();
      return false;
    case "gentleCommand":
      if (row.command) {
        await deps.sendCommand(row.command);
      }
      return false;
    default:
      return true;
  }
}

/**
 * Everything the session has loaded, as one searchable list.
 *
 * pi registers extensions, prompt templates and skills in the same place, so this is
 * the complete surface rather than the slice PiCode happens to understand. Picking one
 * sends it to the agent, which is how a slash command is invoked here.
 */
async function showPiCommands(deps: PiMenuDeps, snapshot: PiMenuSnapshot): Promise<void> {
  const commands = snapshot.commands ?? [];
  if (commands.length === 0) {
    void vscode.window.showInformationMessage(
      "PiCode: pi no informó de ningún comando para esta sesión.",
    );
    return;
  }

  interface CommandItem extends vscode.QuickPickItem {
    command: string;
  }

  const items: CommandItem[] = commands.map((command) => {
    const name = command.name.startsWith("/") ? command.name : `/${command.name}`;
    return {
      command: name,
      label: name,
      description: command.source,
      ...(command.description ? { detail: command.description } : {}),
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: `PiCode: comandos de pi (${items.length})`,
    placeHolder: "Elige uno: se envía al agente como mensaje",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return;
  }
  await deps.sendCommand(picked.command);
}

/**
 * The conversations this project already has.
 *
 * pi stores one file per conversation and the protocol can switch to one, but nothing in the
 * protocol lists them, so the files are read directly. Subagent runs land here too — pi names
 * those itself, which is what makes them recognisable as something the owner did not start.
 */
async function showSessions(deps: PiMenuDeps): Promise<void> {
  const sessions = await deps.sessions();
  if (sessions.length === 0) {
    void vscode.window.showInformationMessage(
      "PiCode: pi no tiene sesiones guardadas para esta carpeta.",
    );
    return;
  }

  interface SessionItem extends vscode.QuickPickItem {
    session: SessionSummary;
  }

  const items: SessionItem[] = sessions.map((session) => ({
    session,
    label: session.name ?? session.title ?? session.stamp,
    description: [session.stamp, formatBytes(session.bytes)].join(" · "),
    detail: session.name && session.title ? session.title : session.file,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: `PiCode: sesiones de este proyecto (${items.length})`,
    placeHolder: "Elige una para continuar donde lo dejaste",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return;
  }
  await deps.resumeSession(picked.session);
}

/** Everything PiCode knows about Gentle AI, in a report rather than a row. */
async function showGentleStatus(deps: PiMenuDeps): Promise<void> {
  const state = await deps.gentle.state();
  void vscode.window.showInformationMessage(`PiCode: Gentle AI`, {
    modal: true,
    detail: describeGentle(state).join("\n"),
  });
}

/**
 * The telemetry opt-out, with the payload on offer.
 *
 * gentle-ai can print exactly what it would send, which turns a vague privacy
 * question into a checkable one, so that option is in the same dialog as the switch.
 */
async function showGentleTelemetry(deps: PiMenuDeps): Promise<void> {
  const state = await deps.gentle.state();
  const answer = await vscode.window.showInformationMessage(
    `PiCode: telemetría de Gentle AI — ${state.telemetry}`,
    { modal: true, detail: "Es anónima y opcional. Puedes ver el contenido exacto antes de decidir." },
    "Ver qué se enviaría",
    "Activar",
    "Desactivar",
  );

  if (answer === "Ver qué se enviaría") {
    await deps.gentle.telemetry("preview");
  } else if (answer === "Activar") {
    await deps.gentle.telemetry("enable");
  } else if (answer === "Desactivar") {
    await deps.gentle.telemetry("disable");
  }
}

/**
 * Reports whether pi can authenticate a provider.
 *
 * Read-only on purpose: writing credentials means touching pi's `auth.json`, which
 * is a secret-handling decision rather than a menu item.
 */
async function checkProvider(deps: PiMenuDeps, provider: string): Promise<void> {
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `PiCode: comprobando ${provider}` },
    () =>
      runPiCli(
        deps.runtime(),
        ["auth", "check", "--provider", provider, "--json"],
        undefined,
        () => {},
        deps.profileEnv(),
      ),
  );

  void vscode.window.showInformationMessage(
    `PiCode: ${provider} → ${describeAuthCheck(result.text)}`,
    { modal: true, detail: "Para configurar credenciales, usa pi auth o el ajuste del proveedor." },
  );
}

interface PackageItem extends vscode.QuickPickItem {
  source: string;
}

/**
 * The installed packages, each with a button to remove it.
 *
 * `buttons` on a quick pick item is the editor's own affordance for a per-row
 * action, so removal does not need a second menu.
 */
export async function showInstalledPackages(deps: PiMenuDeps): Promise<void> {
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "PiCode: leyendo las extensiones" },
    () => runPiCli(deps.runtime(), ["list"], undefined, deps.log, deps.profileEnv()),
  );

  const packages: InstalledPackage[] = parseInstalledPackages(result.text);
  if (packages.length === 0) {
    // The listing format is not a documented contract, so an unrecognised one is
    // shown raw rather than reported as "nothing installed".
    void vscode.window.showInformationMessage("PiCode: pi no informa de extensiones instaladas.", {
      modal: true,
      detail: result.text.trim() || "pi no devolvió nada.",
    });
    return;
  }

  const items: PackageItem[] = packages.map((entry) => ({
    source: entry.source,
    label: entry.source,
    description: entry.scope,
    ...(entry.path ? { detail: entry.path } : {}),
    buttons: [{ iconPath: new vscode.ThemeIcon("trash"), tooltip: `Quitar ${entry.source}` }],
  }));

  const quickPick = vscode.window.createQuickPick<PackageItem>();
  quickPick.title = `PiCode: extensiones instaladas (${packages.length})`;
  quickPick.placeholder = "Elige una para copiar su ruta, o pulsa la papelera para quitarla";
  quickPick.items = items;
  quickPick.matchOnDetail = true;

  quickPick.onDidTriggerItemButton((event) => {
    quickPick.hide();
    void removePackage(deps, event.item.source);
  });
  quickPick.onDidAccept(() => {
    const picked = quickPick.selectedItems[0];
    quickPick.hide();
    if (picked?.detail) {
      void vscode.env.clipboard.writeText(picked.detail);
      void vscode.window.showInformationMessage("PiCode: ruta copiada al portapapeles.");
    }
  });
  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}

interface CatalogItem extends vscode.QuickPickItem {
  package: CatalogPackage;
}

/**
 * The catalog, filtered live as the owner types.
 *
 * `onDidChangeValue` is what makes this a searchable popup rather than a list: the
 * registry is queried on each change and a stale response is discarded by token,
 * because responses can arrive out of order.
 */
export async function showCatalogSearch(deps: PiMenuDeps): Promise<void> {
  const quickPick = vscode.window.createQuickPick<CatalogItem>();
  quickPick.title = "PiCode: buscar extensiones de pi";
  quickPick.placeholder = "Escribe para buscar en el catálogo (por nombre o por lo que hacen)";
  quickPick.busy = true;

  let token = 0;
  const load = async (query: string): Promise<void> => {
    const mine = (token += 1);
    quickPick.busy = true;
    try {
      const results = await searchCatalog(query);
      if (mine !== token) {
        return;
      }
      quickPick.items = results.map(toCatalogItem);
      quickPick.busy = false;
    } catch (error) {
      if (mine !== token) {
        return;
      }
      quickPick.busy = false;
      void vscode.window.showErrorMessage(
        `PiCode: no se pudo consultar el catálogo. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  quickPick.onDidChangeValue((value) => void load(value));
  quickPick.onDidAccept(() => {
    const picked = quickPick.selectedItems[0];
    quickPick.hide();
    if (picked) {
      void installPackage(deps, picked.package);
    }
  });
  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
  await load("");
}

function toCatalogItem(pkg: CatalogPackage): CatalogItem {
  const meta = [
    pkg.version,
    pkg.monthlyDownloads > 0 ? `${Math.round(pkg.monthlyDownloads / 1000)}k/mes` : undefined,
  ].filter((part): part is string => part !== undefined);

  return {
    package: pkg,
    label: pkg.name,
    description: meta.join(" · "),
    detail: pkg.description,
  };
}

/**
 * Installs a catalogue entry, by its npm name.
 *
 * The catalog is npm only, which is why the two source rows exist next to it: pi also
 * accepts git refs and local paths, and those are what the catalogue cannot cover.
 */
async function installPackage(deps: PiMenuDeps, pkg: CatalogPackage): Promise<void> {
  await installSource(deps, `npm:${pkg.name}`);
}

/** Asks for a source spec, the way pi documents them. */
async function installFromInput(deps: PiMenuDeps): Promise<void> {
  const source = await vscode.window.showInputBox({
    title: "PiCode: instalar una extensión de pi",
    prompt: "Una fuente de pi: npm:paquete, git:github.com/usuario/repo@v1, o una URL de git.",
    placeHolder: "git:github.com/usuario/repo@v1",
    ignoreFocusOut: true,
  });
  if (source === undefined) {
    return;
  }
  await installSource(deps, source.trim());
}

/**
 * Installs from a folder on disk.
 *
 * A picker rather than a text field, because a path typed by hand is a path typed
 * wrong, and this is the source no catalogue can offer.
 */
async function installFromFolder(deps: PiMenuDeps): Promise<void> {
  const chosen = await vscode.window.showOpenDialog({
    title: "PiCode: instalar una extensión desde una carpeta local",
    openLabel: "Instalar esta carpeta",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
  });
  const folder = chosen?.[0];
  if (!folder) {
    return;
  }
  await installSource(deps, folder.fsPath);
}

/**
 * What an install attempt did.
 *
 * The popup ignores it — it reports through the editor's own notifications — but the
 * initial-setup wizard shows the outcome inside its panel, so the result has to
 * travel back instead of ending in a notification that can be gone by the time the
 * owner looks at the panel again.
 */
export interface InstallOutcome {
  ok: boolean;
  /** True when the owner dismissed the confirmation, so nothing ran. */
  cancelled: boolean;
  message: string;
}

/**
 * Installs a package from any source pi accepts.
 *
 * pi's documentation is explicit that packages run with full access to the system, so
 * the confirmation names the exact command and shows the source as written rather than
 * paraphrased: what the owner is about to run should be readable in the dialog.
 */
async function installSource(deps: PiMenuDeps, source: string): Promise<void> {
  await installSources(deps, [source]);
}

/**
 * Installs one or more packages behind a single confirmation.
 *
 * The confirmation names every exact command, because that is what the owner is
 * about to run and a list of packages would hide the commands behind a summary. The
 * progress and the restart offer are the ones the single-source path always had; a
 * source list is only how the Gentle AI layer's two halves — the orchestrator and
 * its memory provider — go in together instead of one dialog each.
 */
export async function installSources(
  deps: PiMenuDeps,
  sources: readonly string[],
): Promise<InstallOutcome> {
  const specs = sources.map((source) => source.trim()).filter((source) => source.length > 0);
  if (specs.length === 0) {
    return { ok: false, cancelled: true, message: "No hay nada que instalar." };
  }

  const commands = specs.map((spec) => `"pi install ${spec}"`).join(" y ");
  const answer = await vscode.window.showWarningMessage(
    `¿Instalar ${specs.join(" y ")} en pi?`,
    {
      modal: true,
      detail: `Los paquetes de pi ejecutan código con acceso completo al sistema. Se instalará con ${commands}.`,
    },
    "Instalar",
  );
  if (answer !== "Instalar") {
    return { ok: false, cancelled: true, message: "No se instaló nada." };
  }

  for (const spec of specs) {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `PiCode: instalando ${spec}` },
      () => runPiCli(deps.runtime(), ["install", spec], undefined, deps.log, deps.profileEnv()),
    );
    if (!result.ok) {
      const reason = `pi install terminó con código ${result.code ?? "desconocido"}.`;
      const message = specs.length > 1 ? `${reason} Falló al instalar ${spec}.` : reason;
      void vscode.window.showErrorMessage(`PiCode: ${message}`);
      return { ok: false, cancelled: false, message };
    }
  }

  deps.offerRestart(`${specs.join(" y ")} quedó instalado`);
  return { ok: true, cancelled: false, message: `Instalado ${specs.join(" y ")}.` };
}

async function removePackage(deps: PiMenuDeps, source: string): Promise<void> {
  const answer = await vscode.window.showWarningMessage(
    `¿Quitar ${source} de pi?`,
    { modal: true, detail: `Se ejecutará "pi remove ${source}".` },
    "Quitar",
  );
  if (answer !== "Quitar") {
    return;
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `PiCode: quitando ${source}` },
    () => runPiCli(deps.runtime(), ["remove", source], undefined, deps.log, deps.profileEnv()),
  );
  if (!result.ok) {
    void vscode.window.showErrorMessage(
      `PiCode: pi remove terminó con código ${result.code ?? "desconocido"}.`,
    );
    return;
  }
  deps.offerRestart(`${source} quedó fuera`);
}

export async function updateExtensions(deps: PiMenuDeps): Promise<void> {
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "PiCode: actualizando extensiones" },
    () => runPiCli(deps.runtime(), ["update", "--extensions"], undefined, deps.log, deps.profileEnv()),
  );
  if (!result.ok) {
    void vscode.window.showErrorMessage(
      `PiCode: pi update terminó con código ${result.code ?? "desconocido"}.`,
    );
    return;
  }
  deps.offerRestart("las extensiones quedaron actualizadas");
}
