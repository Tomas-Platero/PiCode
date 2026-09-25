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
 *
 * T3c adds the two steps that make the copy usable, and they belong to this same flow:
 * the packages the copy left configured are installed through the existing install path,
 * into the very directory the copy wrote — never through the resolver's guard, which
 * would answer with the machine's profile while PiCode's own is still credential-less;
 * and the flow closes by telling the truth about which profile the editor is on, because
 * the running agent was built at startup and the panel is re-read on every refresh. The
 * reload is offered only when the copy can actually carry the instance: credentials came
 * across **and** the selected runtime is PiCode's own. With no credentials nothing
 * switches yet, and with any other runtime the editor keeps running the owner's pi, so
 * both say so — naming the row that changes it — instead of offering a reload that would
 * change nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  instanceAgentDir,
  parseCredentials,
  parsePackages,
  scanProfile,
  type DirectoryInventory,
  type JsonValue,
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
import { installSources, type PiMenuDeps } from "./menu";
import { resolveRuntime } from "./runtime";
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
  sessions: "Sesiones",
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
  const sessionsSelectable = inventory.sessions.exists && inventory.sessions.count !== 0;
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
    entry("sessions", sessionsSelectable, describeDirectory(inventory.sessions)),
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
 * What the target holds — pure over the files' own text
 * ------------------------------------------------------------------ */

/** A JSON file's value, or `undefined` when the text is absent or is not JSON. */
function parseJson(text: string | undefined): JsonValue | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * The package sources a `settings.json` text configures.
 *
 * Pure over the text on purpose: the flow reads the **target** profile's file — what
 * actually landed, not what the source held — and that reading has to be exercisable
 * without a profile. The shape is parsed by the scan's own `parsePackages`, so the list
 * installed here and the list the inventory showed cannot drift apart, and a settings
 * file that is missing or malformed simply has no packages to install.
 */
export function packageSourcesFromSettings(text: string | undefined): string[] {
  return parsePackages(parseJson(text)).sources;
}

/**
 * The providers an `auth.json` text names.
 *
 * Reads the top-level keys and nothing else, exactly as the scan does, so a credential
 * value cannot travel out of the file even while deciding whether one is there.
 */
export function credentialProvidersFromAuth(text: string | undefined): string[] {
  return parseCredentials(parseJson(text)).providers;
}

/**
 * The environment the package install runs with: the import's own target, explicitly.
 *
 * `instanceAgentDir(uri, "managed")` is the **unguarded** answer and it is the one that
 * belongs here. `selectedAgentDir()` is for readers: it follows the anti-mute guard, and
 * that guard answers with the machine's profile the instant PiCode's own profile has no
 * credentials. The owner may have chosen not to bring credentials, so a guarded answer
 * would install the packages somewhere other than the directory the files were just
 * copied into. The install belongs to the import, so it targets the copy's own target.
 */
export function importProfileEnv(target: string): Record<string, string> {
  return { PI_CODING_AGENT_DIR: target };
}

/* ------------------------------------------------------------------ *
 * The closing step
 * ------------------------------------------------------------------ */

/** The button that reloads the window after the import, in the owner's words. */
export const RELOAD_WINDOW_LABEL = "Recargar la ventana";

/**
 * The row that picks which pi runs, named by the label the PiCode settings category shows.
 *
 * Spelled here rather than inline in `CLOSING_TEXTS.otherRuntime` so the closing points at
 * one named place, and so a test can assert the row the message sends the owner to.
 */
export const RUNTIME_ROW_LABEL = "Qué pi se ejecuta";

/**
 * The three closing messages, one per state the import can leave behind.
 *
 * They are the flow's last word, so they say the one thing this screen must never get
 * wrong: which profile the editor is actually on. The facts the panel shows are re-read on
 * every refresh, but the agent's client is built once at startup, so right after a copy the
 * panel would read PiCode's own profile while the running agent still uses the machine's —
 * the reload is what closes that gap. It is offered only when the copy can actually carry
 * the instance, which needs two facts at once, and this table carries the wording for all
 * three outcomes so no caller paraphrases it.
 */
export const CLOSING_TEXTS = {
  ready:
    "El perfil propio de PiCode ya tiene lo que trajiste. El agente que está corriendo " +
    "todavía usa el perfil de tu pi, así que recarga la ventana para que use el nuevo.",
  withoutCredentials:
    "El perfil propio de PiCode se llenó, pero no tiene credenciales, así que todavía no " +
    "puede hablar con ningún modelo y nada ha cambiado: el editor sigue usando el perfil " +
    "de tu pi. Vuelve a importar marcando las credenciales para encenderlo.",
  otherRuntime:
    "El perfil propio de PiCode se llenó, pero el editor sigue ejecutando tu pi, no el de " +
    `PiCode, así que la copia todavía no se usa. Cambia la fila «${RUNTIME_ROW_LABEL}» y ` +
    "elige el pi propio de PiCode para que la copia entre en uso.",
} as const;

/**
 * The two facts the closing decision is made of, both handed in by the caller.
 *
 * Keeping them explicit is what lets the decision be a pure function of the only two
 * things that matter here: whether the copy can talk to a model, and whether the editor is
 * even pointing at the profile the copy went into.
 */
export interface ClosingFacts {
  /** Whether credentials came across into the copy, which is what lets it talk to a model. */
  hasCredentials: boolean;
  /** Whether the selected runtime is PiCode's own pi, whose profile is the copy's target. */
  managed: boolean;
}

/** The closing message and whether it offers the reload, decided together so they cannot drift. */
export interface ClosingMessage {
  /** The message to show, prefix and all. */
  text: string;
  /** True only when reloading the window would actually change the profile the agent uses. */
  reload: boolean;
}

/**
 * The closing message for the import's outcome.
 *
 * Pure, and the single place the decision and its wording live. The reload is offered only
 * when PiCode's own pi is selected (the copy fills the profile that pi reads) and the copy
 * has credentials (so the anti-mute guard will let every reader and every spawn follow it).
 * Any other runtime means the editor keeps using the owner's pi no matter what is in
 * PiCode's profile, so the honest answer names the row that would change that instead of
 * promising a reload that would not.
 */
export function closingMessage(facts: ClosingFacts): ClosingMessage {
  if (!facts.managed) {
    return { text: `PiCode: ${CLOSING_TEXTS.otherRuntime}`, reload: false };
  }
  if (!facts.hasCredentials) {
    return { text: `PiCode: ${CLOSING_TEXTS.withoutCredentials}`, reload: false };
  }
  return { text: `PiCode: ${CLOSING_TEXTS.ready}`, reload: true };
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
 *
 * `deps` is the menu the editor already built, because the install of the copied
 * packages goes through that same path (`installSources`) rather than a second one.
 */
export async function importProfileIntoInstance(
  context: vscode.ExtensionContext,
  deps: PiMenuDeps,
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
  // it line by line rather than summarizing into a claim the report does not make. It
  // is awaited so it is dismissed before the install confirmation opens underneath it.
  await vscode.window.showInformationMessage("PiCode: importación terminada", {
    modal: true,
    detail: reportLines(report).join("\n"),
  });

  // The packages the copy left configured are installed into the import's own target,
  // read back from the target so an import that did not bring settings — or brought
  // them in an earlier pass — installs what is actually there. `installSources` owns
  // the confirmation and the progress; its own restart offer is suppressed because
  // this flow offers the reload once, at the end, when it can actually mean something.
  const targetSettings = readTextIfPresent(path.join(to, "settings.json"));
  const sources = packageSourcesFromSettings(targetSettings);
  if (sources.length > 0) {
    await installSources(
      {
        ...deps,
        profileEnv: () => importProfileEnv(to),
        offerRestart: () => {},
      },
      sources,
    );
  }

  // The reload is the closing step, and the decision is made of two facts at once:
  // without credentials the profile cannot carry the instance, so the guard keeps every
  // reader and every spawn on the machine's profile; and with any runtime but PiCode's own
  // the editor reads the owner's profile no matter what the copy holds. Either way a reload
  // would change nothing, and the closing says so instead of offering the button.
  const hasCredentials =
    credentialProvidersFromAuth(readTextIfPresent(path.join(to, "auth.json"))).length > 0;
  const closing = closingMessage({
    hasCredentials,
    managed: resolveRuntime(context.extensionUri).mode === "managed",
  });
  if (!closing.reload) {
    void vscode.window.showInformationMessage(closing.text);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    closing.text,
    RELOAD_WINDOW_LABEL,
  );
  if (choice === RELOAD_WINDOW_LABEL) {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

/** A file's text, or `undefined` when it is missing or cannot be read. */
function readTextIfPresent(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The progress line for one item, read from the same table the report uses. */
function progressMessage(item: ImportItemReport): string {
  return `${ITEM_LABELS[item.item]}…`;
}
