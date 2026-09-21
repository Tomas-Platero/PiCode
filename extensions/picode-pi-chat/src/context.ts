import * as vscode from "vscode";

/**
 * The editor context a message carries.
 *
 * The agent runs inside the workspace and can read any file by itself, so what is
 * injected is what it cannot reconstruct from a path: which file the owner was
 * looking at, which lines they had selected, and what the editor currently reports
 * as broken. File contents travel only for a selection, because that is the part a
 * path and a line range cannot convey on their own — and a whole file would be both
 * redundant and expensive.
 *
 * The block is built by a pure function so what a message actually contains can be
 * asserted without an editor.
 */

export interface EditorReference {
  kind: "file" | "selection" | "workspace" | "problems";
  /** The one-liner that goes in the list. */
  label: string;
  /** Text carried inline, for references where the text is the point. */
  body?: string;
}

/** Selections longer than this are summarised instead of pasted. */
export const MAX_INLINE_CHARS = 4000;

/**
 * Shortens a body that is too large to carry, saying so rather than silently cutting.
 *
 * A truncated paste that does not admit it is worse than no paste: the agent would
 * reason about a file as if it had seen all of it.
 */
export function truncateBody(body: string, limit = MAX_INLINE_CHARS): string {
  if (body.length <= limit) {
    return body;
  }
  const kept = body.slice(0, limit);
  const dropped = body.length - limit;
  return `${kept}\n\n[... recortado: ${dropped} caracteres más. Lee el archivo si necesitas el resto.]`;
}

/**
 * Prefixes the owner's message with the reference block.
 *
 * The owner's own words come last so they are the freshest thing in the message, and
 * with no references the message is passed through untouched.
 */
export function composePrompt(message: string, references: readonly EditorReference[]): string {
  if (references.length === 0) {
    return message;
  }

  const listed = references.filter((reference) => reference.body === undefined);
  const inline = references.filter((reference) => reference.body !== undefined);

  const parts: string[] = ["[Contexto del editor en PiCode]"];
  for (const reference of listed) {
    parts.push(`- ${reference.label}`);
  }

  for (const reference of inline) {
    parts.push("");
    parts.push(`--- ${reference.label} ---`);
    parts.push(truncateBody(reference.body ?? ""));
  }

  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push(message);

  return parts.join("\n");
}

/**
 * Reads what the editor currently has open.
 *
 * Everything here is what the editor already knows: no file is read from disk and no
 * command is run, so attaching context costs nothing and cannot fail on a missing
 * tool.
 */
export function collectReferences(): EditorReference[] {
  const references: EditorReference[] = [];

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    references.push({
      kind: "workspace",
      label: `carpeta abierta: ${folder.name} (${folder.uri.fsPath})`,
    });
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return references;
  }

  const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
  references.push({
    kind: "file",
    label: `archivo activo: ${relative} (${editor.document.languageId}, ${editor.document.lineCount} líneas)`,
  });

  const selection = editor.selection;
  if (!selection.isEmpty) {
    references.push({
      kind: "selection",
      label: `selección en ${relative} (líneas ${selection.start.line + 1}-${selection.end.line + 1})`,
      body: editor.document.getText(selection),
    });
  }

  const problems = vscode.languages.getDiagnostics(editor.document.uri);
  if (problems.length > 0) {
    const errors = problems.filter(
      (problem) => problem.severity === vscode.DiagnosticSeverity.Error,
    ).length;
    const warnings = problems.length - errors;
    references.push({
      kind: "problems",
      label: `problemas en ${relative}: ${errors} error(es), ${warnings} aviso(s)`,
      body: problems
        .slice(0, 20)
        .map((problem) => `${problem.range.start.line + 1}: ${problem.message}`)
        .join("\n"),
    });
  }

  return references;
}
