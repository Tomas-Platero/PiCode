import * as vscode from "vscode";
import {
  parseInstalledPackages,
  runPiCli,
  searchCatalog,
  type CatalogPackage,
  type InstalledPackage,
} from "./pi-cli";
import type { ResolvedRuntime } from "./runtime";
import { emptyUsage, describeUsage, summarizeUsage, type UsageTotals } from "./usage";
import { summarizeGentle, describeGentle, type GentleState } from "./gentle";

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

const CATEGORY_ORDER: readonly PiCategoryId[] = [
  "modelo",
  "extensiones",
  "runtime",
  "proveedores",
  "gentle",
  "sesion",
];

export interface PiMenuSnapshot {
  model?: string;
  reasoning?: string;
  runtime: string;
  runtimeAvailable: boolean;
  managedInstalled: boolean;
  installedCount?: number;
  messageCount?: number;
  streaming: boolean;
  providerCount?: number;
  gentle?: GentleState;
  /** What the session has cost, when a session has said anything yet. */
  usage?: UsageTotals;
  contextWindow?: number;
}

export interface PiCategoryRow {
  id: PiCategoryId;
  label: string;
  description?: string;
  detail?: string;
}

/** The first level: what each category currently holds. */
export function buildCategories(snapshot: PiMenuSnapshot): PiCategoryRow[] {
  const installed =
    snapshot.installedCount === undefined ? "contando…" : `${snapshot.installedCount} instaladas`;
  const providers =
    snapshot.providerCount === undefined ? "leyendo…" : `${snapshot.providerCount} con modelos`;
  const messages =
    snapshot.messageCount === undefined ? "sin sesión" : `${snapshot.messageCount} mensajes`;

  return CATEGORY_ORDER.map((id) => {
    switch (id) {
      case "modelo":
        return {
          id,
          label: CATEGORY_LABELS.modelo,
          description: snapshot.model ?? "sin modelo",
          detail: `Razonamiento: ${snapshot.reasoning ?? "no disponible"}`,
        };
      case "extensiones":
        return {
          id,
          label: CATEGORY_LABELS.extensiones,
          description: installed,
          detail: "Instalar, ver y actualizar lo que pi carga",
        };
      case "runtime":
        return {
          id,
          label: CATEGORY_LABELS.runtime,
          description: snapshot.runtime,
          detail: snapshot.runtimeAvailable ? "Disponible" : "No encontrado",
        };
      case "proveedores":
        return {
          id,
          label: CATEGORY_LABELS.proveedores,
          description: providers,
          detail: "Comprobar si un proveedor tiene credenciales",
        };
      case "gentle":
        return {
          id,
          label: CATEGORY_LABELS.gentle,
          description: summarizeGentle(snapshot.gentle),
          detail: "Estado, revisión, telemetría y sus comandos",
        };
      default:
        return {
          id: "sesion",
          label: CATEGORY_LABELS.sesion,
          description: snapshot.streaming ? "trabajando" : "en reposo",
          detail: messages,
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
  | "update"
  | "runtime"
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
  /** Sends a gentle slash command to the running session. */
  sendCommand(name: string): Promise<void>;
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
        label: `Gentle AI: ${summarizeGentle(gentle)}`,
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
          label: "SDD: fase del cambio activo",
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
          action: "abort",
          label: "Detener la ejecución",
          detail: snapshot.streaming ? "Hay una ejecución en curso" : "No hay nada en curso",
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
  /** Current session, runtime and counts, for the popup's own labels. */
  snapshot(): Promise<PiMenuSnapshot>;
  providers(): Promise<ProviderSummary[]>;
  selectModel(): Promise<void>;
  selectThinkingLevel(): Promise<void>;
  selectRuntime(): Promise<void>;
  installManagedRuntime(): Promise<void>;
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
    case "model":
      await deps.selectModel();
      return true;
    case "thinking":
      await deps.selectThinkingLevel();
      return true;
    case "runtime":
      await deps.selectRuntime();
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
      await deps.gentle.run(["sdd-status"], "PiCode: SDD");
      return true;
    case "gentleDoctor":
      await deps.gentle.run(["doctor"], "PiCode: diagnóstico de Gentle AI");
      return true;
    case "gentleInstall":
      await deps.gentle.install();
      return false;
    case "gentleCommand":
      if (row.command) {
        await deps.gentle.sendCommand(row.command);
      }
      return false;
    default:
      return true;
  }
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
    () => runPiCli(deps.runtime(), ["list"], undefined, deps.log),
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
 * Installs a package, after naming the exact command.
 *
 * pi's own documentation is explicit that packages run with full access to the
 * system, so this is a modal rather than a single selection in a list.
 */
async function installPackage(deps: PiMenuDeps, pkg: CatalogPackage): Promise<void> {
  const answer = await vscode.window.showWarningMessage(
    `¿Instalar ${pkg.name} en pi?`,
    {
      modal: true,
      detail:
        "Los paquetes de pi ejecutan código con acceso completo al sistema. " +
        `Se instalará con "pi install npm:${pkg.name}" y se añadirá a tu configuración de pi.`,
    },
    "Instalar",
  );
  if (answer !== "Instalar") {
    return;
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `PiCode: instalando ${pkg.name}` },
    () => runPiCli(deps.runtime(), ["install", `npm:${pkg.name}`], undefined, deps.log),
  );
  if (!result.ok) {
    void vscode.window.showErrorMessage(
      `PiCode: pi install terminó con código ${result.code ?? "desconocido"}.`,
    );
    return;
  }
  deps.offerRestart(`${pkg.name} quedó instalado`);
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
    () => runPiCli(deps.runtime(), ["remove", source], undefined, deps.log),
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
    () => runPiCli(deps.runtime(), ["update", "--extensions"], undefined, deps.log),
  );
  if (!result.ok) {
    void vscode.window.showErrorMessage(
      `PiCode: pi update terminó con código ${result.code ?? "desconocido"}.`,
    );
    return;
  }
  deps.offerRestart("las extensiones quedaron actualizadas");
}
