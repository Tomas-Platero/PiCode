/*
 * T3 of the two-instances feature: the flow that drives the one-shot copy from
 * inside the editor.
 *
 * `scanProfile()` (instance.ts) reads what a profile holds and `importProfile()`
 * (instance-import.ts) copies a chosen subset of it. This module is the only thing
 * that joins them, and it exists because the owner must be able to import without a
 * terminal: it resolves both ends, refuses in Spanish before anything is written,
 * shows the inventory as a multi-select list written for the owner, runs the copy
 * with a visible progress notification, and reports item by item what happened.
 *
 * The two text-building steps are pure functions on purpose (`inventoryEntries` and
 * `reportLines`): they turn the scan and the report into the exact Spanish the owner
 * reads, so the wording can be tested without an editor and the UI layer keeps no
 * copy of it. The tables they read from (`ITEM_LABELS`, `STATUS_TEXTS`, `REFUSALS`,
 * `ENTRY_DESCRIPTIONS`) are exported for the same reason: a test asserts the text
 * the product builds instead of restating it, so the two cannot drift apart.
 *
 * The machine's own profile is read-only here. Every write lands under the target
 * `instanceAgentDir` resolves, and the flow refuses when the two ends overlap,
 * because a copy whose source is also its destination would put a write path under
 * the owner's own profile.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  instanceAgentDir,
  scanProfile,
  type DirectoryInventory,
  type ProfileInventory,
} from "./instance";
import {
  importProfile,
  type ImportItem,
  type ImportItemReport,
  type ImportItemStatus,
  type ImportReport,
  type ImportSelection,
} from "./instance-import";
import { resolveAgentDir } from "./transcription";

/** The command the palette runs. Declared in package.json and registered once. */
export const IMPORT_PROFILE_COMMAND = "picode.piChat.importProfile";

/* ------------------------------------------------------------------ *
 * The owner-facing wording
 * ------------------------------------------------------------------ */

/** What each imported thing is called on screen. */
export const ITEM_LABELS: Record<ImportItem, string> = {
  settings: "Ajustes y paquetes",
  models: "Modelos",
  mcp: "Servidores MCP",
  skills: "Skills",
  memory: "Memoria",
  credentials: "Credenciales",
};

/** What happened to one item, in the words the report shows. */
export const STATUS_TEXTS: Record<ImportItemStatus, string> = {
  copied: "copiado",
  overwritten: "sobreescrito",
  absent: "no estaba en el perfil que importas",
  declined: "no lo pediste",
  failed: "falló",
};

/** The two short markers a list entry can carry. */
export const ENTRY_DESCRIPTIONS = {
  /** Shown on an item the scan found nothing for, which cannot be selected. */
  empty: "sin contenido",
  /** Shown on credentials, the one item whose default is "no". */
  credentialsSeparate: "decisión aparte",
} as const;

/**
 * Why the import cannot run, one sentence per reason.
 *
 * Each is a full owner-facing sentence because it is shown as the only message of a
 * refusal, and the three are kept together so a test can assert the flow reaches
 * exactly these and not a paraphrase.
 */
export const REFUSALS = {
  sourceMissing: "No se encontró el perfil de tu pi en esta máquina, así que no hay nada que importar.",
  sourceEmpty: "El perfil de tu pi no tiene nada que importar.",
  overlapping:
    "El perfil de tu pi y el perfil propio de PiCode son el mismo o uno está dentro del otro, así que no se importó nada para no pisarse.",
} as const;

/* ------------------------------------------------------------------ *
 * Pure text: the inventory as a list
 * ------------------------------------------------------------------ */

/** One selectable row of the import list, already written for the owner. */
export interface ImportEntry {
  /** The item this row decides, which is what the copy receives back. */
  item: ImportItem;
  label: string;
  /** What the source holds, with a noun for every number. */
  detail: string;
  /** A short marker, present only when it says something. */
  description?: string;
  /** False when the scan found nothing: the row is shown but not selectable. */
  selectable: boolean;
}

/** `3 paquetes`, never a bare number: a count on its own names nothing. */
function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** What a directory-shaped item holds, or why its content is unknown. */
function describeDirectory(directory: DirectoryInventory): string {
  if (!directory.exists) {
    return "no hay nada que importar";
  }
  // A directory that exists but could not be listed is not an empty one; saying so
  // keeps "unknown" from reading as "nothing here".
  if (directory.count === undefined) {
    return "presente, pero no se pudo contar su contenido";
  }
  return counted(directory.count, "elemento", "elementos");
}

function entry(item: ImportItem, selectable: boolean, detail: string): ImportEntry {
  const description = !selectable
    ? ENTRY_DESCRIPTIONS.empty
    : item === "credentials"
      ? ENTRY_DESCRIPTIONS.credentialsSeparate
      : undefined;
  return {
    item,
    label: ITEM_LABELS[item],
    detail,
    selectable,
    ...(description !== undefined ? { description } : {}),
  };
}

/**
 * The scan as the rows the import list shows.
 *
 * Every item is always present, in the copy's own order, so the list and the report
 * have the same shape whatever the source holds. An item with nothing behind it keeps
 * its row — hiding it would make its absence an unexplained omission — but comes back
 * non-selectable, because choosing a thing that cannot arrive is not a choice.
 */
export function inventoryEntries(inventory: ProfileInventory): ImportEntry[] {
  const packages = inventory.packages;
  const models = inventory.models;
  const mcp = inventory.mcp;
  const credentials = inventory.credentials;

  const settingsSelectable = packages.count > 0;
  const modelsSelectable = models.providerCount > 0 || models.modelCount > 0;
  const mcpSelectable = mcp.count > 0;
  const skillsSelectable = inventory.skills > 0;
  const memorySelectable = inventory.memory.exists && inventory.memory.count !== 0;
  const credentialsSelectable = credentials.count > 0;

  return [
    entry(
      "settings",
      settingsSelectable,
      settingsSelectable
        ? counted(packages.count, "paquete configurado", "paquetes configurados")
        : "sin paquetes configurados",
    ),
    entry(
      "models",
      modelsSelectable,
      modelsSelectable
        ? `${counted(models.providerCount, "proveedor", "proveedores")}, ${counted(models.modelCount, "modelo", "modelos")}`
        : "sin modelos configurados",
    ),
    entry(
      "mcp",
      mcpSelectable,
      mcpSelectable
        ? `${counted(mcp.count, "servidor", "servidores")}: ${mcp.servers.map((server) => server.name).join(", ")}`
        : "sin servidores configurados",
    ),
    entry(
      "skills",
      skillsSelectable,
      skillsSelectable ? counted(inventory.skills, "skill", "skills") : "sin skills instaladas",
    ),
    entry("memory", memorySelectable, describeDirectory(inventory.memory)),
    // Credentials name their providers because that is the whole of the decision:
    // which providers come along. Their values are never read, so they cannot be shown.
    entry(
      "credentials",
      credentialsSelectable,
      credentialsSelectable
        ? `${counted(credentials.count, "proveedor con credenciales", "proveedores con credenciales")}: ${credentials.providers.join(", ")}`
        : "sin credenciales guardadas",
    ),
  ];
}

/* ------------------------------------------------------------------ *
 * Pure text: the report as lines
 * ------------------------------------------------------------------ */

/** One line per item, in the report's own order. */
export function reportLines(report: ImportReport): string[] {
  return report.items.map(lineForItem);
}

function lineForItem(item: ImportItemReport): string {
  let line = `${ITEM_LABELS[item.item]}: ${STATUS_TEXTS[item.status]}`;
  // A directory says how much it moved; a file has no count to give.
  if (item.files !== undefined && (item.status === "copied" || item.status === "overwritten")) {
    line += `, ${counted(item.files, "archivo", "archivos")}`;
  }
  // The reason is only meaningful on a failure; on anything else it is noise.
  if (item.status === "failed" && item.reason !== undefined && item.reason.trim() !== "") {
    line += ` — ${item.reason.trim()}`;
  }
  return `${line}.`;
}

/* ------------------------------------------------------------------ *
 * The refusal
 * ------------------------------------------------------------------ */

/** The two facts about the ends the refusal needs, answered by the caller. */
export interface ImportEndsFacts {
  /** Whether the source profile directory is there at all. */
  sourceExists: boolean;
  /** Whether the scan found anything selectable in it. */
  hasContent: boolean;
}

/**
 * Whether `parent` holds `candidate`, including when they are the same directory.
 *
 * `path.relative` is used rather than a string prefix so that `pi-agent-old` is not
 * read as living inside `pi-agent`; an empty relative path is the "same directory"
 * case, and a leading `..` is the only honest "outside".
 */
function contains(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Why the import must not run, or `undefined` when it can.
 *
 * Pure: both ends and the two facts are handed in, so the three refusals can be
 * exercised without a profile or an editor. The order is the order the owner would
 * discover them: there is no profile, the profile holds nothing, or the two ends
 * overlap — and the last one is the safety rule, because either direction would put
 * a write path under the owner's own profile.
 */
export function importRefusal(
  from: string,
  to: string,
  facts: ImportEndsFacts,
): string | undefined {
  if (!facts.sourceExists) {
    return REFUSALS.sourceMissing;
  }
  if (!facts.hasContent) {
    return REFUSALS.sourceEmpty;
  }
  if (contains(from, to) || contains(to, from)) {
    return REFUSALS.overlapping;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * The editor flow
 * ------------------------------------------------------------------ */

/** A list row the quick pick carries back to this module. */
interface ImportChoice extends vscode.QuickPickItem {
  entry: ImportEntry;
}

/**
 * Shows the entries and returns what the owner chose, or `undefined` when the list
 * was closed without accepting.
 *
 * The editor has no disabled flag on a list item, so "shown but not selectable" is
 * enforced by undoing a selection of one as soon as it is made. Credentials start
 * unchecked even though they are selectable: bringing a credential is a decision, and
 * a decision that is on by default is not one.
 */
function chooseEntries(entries: ImportEntry[]): Promise<ImportEntry[] | undefined> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<ImportChoice>();
    quickPick.title = "PiCode: importar el perfil de tu pi";
    quickPick.placeholder = "Elige qué traer. Lo que no elijas no se copia.";
    quickPick.canSelectMany = true;
    quickPick.ignoreFocusOut = true;
    quickPick.items = entries.map((entry) => ({
      entry,
      label: entry.label,
      detail: entry.detail,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      picked: entry.selectable && entry.item !== "credentials",
    }));

    quickPick.onDidChangeSelection((selected) => {
      const selectable = selected.filter((choice) => choice.entry.selectable);
      if (selectable.length !== selected.length) {
        quickPick.selectedItems = selectable;
      }
    });

    // `accepted` is read in `onDidHide`, which is where every close ends, so the
    // accepted selection is not lost to the hide it triggers.
    let accepted: ImportEntry[] | undefined;
    quickPick.onDidAccept(() => {
      accepted = quickPick.selectedItems.map((choice) => choice.entry);
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      quickPick.dispose();
      resolve(accepted);
    });
    quickPick.show();
  });
}

/**
 * The command: brings the machine's pi profile into PiCode's own instance, once.
 *
 * The source is the machine's profile — `PI_CODING_AGENT_DIR` when set, `~/.pi/agent`
 * otherwise — and the target is the internal instance's profile. Both are resolved
 * before anything is shown or written, and the flow stops at the first refusal. The
 * copy is a one-shot: nothing here is scheduled, watched or repeated.
 */
export async function importProfileIntoInstance(
  context: vscode.ExtensionContext,
): Promise<void> {
  const from = resolveAgentDir();
  const to = instanceAgentDir(context.extensionUri, "managed");

  // `managed` always resolves to a directory; the guard is here because the
  // resolver's type allows `undefined` for the instances that run the owner's own pi.
  if (to === undefined) {
    void vscode.window.showErrorMessage(
      "PiCode: la instancia propia de PiCode no tiene un perfil al que importar.",
    );
    return;
  }

  const sourceExists = existsSync(from);
  if (!sourceExists) {
    void vscode.window.showErrorMessage(`PiCode: ${REFUSALS.sourceMissing}`);
    return;
  }

  const inventory = scanProfile(from);
  const entries = inventoryEntries(inventory);
  const refusal = importRefusal(from, to, {
    sourceExists,
    hasContent: entries.some((entry) => entry.selectable),
  });
  if (refusal !== undefined) {
    void vscode.window.showErrorMessage(`PiCode: ${refusal}`);
    return;
  }

  const chosen = await chooseEntries(entries);
  if (chosen === undefined) {
    return;
  }
  if (chosen.length === 0) {
    void vscode.window.showInformationMessage(
      "PiCode: no se importó nada porque no elegiste ningún elemento.",
    );
    return;
  }

  const selection: ImportSelection = {};
  for (const entry of chosen) {
    selection[entry.item] = true;
  }

  const report = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "PiCode: importando el perfil de tu pi",
    },
    (progress) =>
      importProfile({
        from,
        to,
        selection,
        onProgress: (item) => progress.report({ message: progressMessage(item) }),
      }),
  );

  // The report is the only thing that says what happened: the notification repeats
  // it line by line rather than summarizing into a claim the report does not make.
  void vscode.window.showInformationMessage("PiCode: importación terminada", {
    modal: true,
    detail: reportLines(report).join("\n"),
  });
}

/** The progress line for one item, read from the same table the report uses. */
function progressMessage(item: ImportItemReport): string {
  return `${ITEM_LABELS[item.item]}…`;
}
