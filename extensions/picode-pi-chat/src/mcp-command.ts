/*
 * The command that writes the workspace's own `.vscode/mcp.json` from the selected
 * instance's pi configuration.
 *
 * `mcp-native.ts` is the translation and holds no I/O; this module is the other half:
 * it resolves which profile's `mcp.json` to read, asks before it replaces a file the
 * owner may have edited by hand, writes it, and reports what could not be translated.
 *
 * The target is the **workspace's** file and not the user's, because MCP servers in the
 * editor are a property of where you are working: one project's servers must not follow
 * the owner into another. A command with no folder open has no target, and says so.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { mcpJsonText, toNativeMcp, type McpMigration } from "./mcp-native";
import type { JsonValue } from "./instance";
import { selectedAgentDir } from "./instance";

export const MIGRATE_MCP_COMMAND = "picode.piChat.migrateMcp";

/** The relative location of the file the editor reads. */
const NATIVE_MCP_RELATIVE = [".vscode", "mcp.json"];

/** A JSON document's value, or `undefined` when it is absent, broken or not an object. */
function parseJsonObject(text: string | undefined): JsonValue | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
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

/**
 * The translation of a `mcp.json` text, or the reason there is nothing to translate.
 *
 * Pure over the text, so the two answers a command has to tell apart — "there is no
 * file" and "the file is there but declares nothing" — are decided without an editor.
 */
export function migrationFromText(
  text: string | undefined,
): { migration: McpMigration } | { empty: true } {
  const migration = toNativeMcp(parseJsonObject(text));
  if (Object.keys(migration.config.servers).length === 0) {
    return { empty: true };
  }
  return { migration };
}

/**
 * The command: translates the selected instance's MCP servers into the workspace's
 * `.vscode/mcp.json`.
 *
 * Returns without writing anything when there is no profile to read, nothing to
 * translate, or the owner declines to replace an existing file. The servers become
 * visible in the editor's own MCP picker because `mcp.json` is core behaviour, not
 * something Copilot brings.
 */
export async function migrateMcpToWorkspace(extensionUri: vscode.Uri): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    void vscode.window.showErrorMessage(
      "PiCode: abre una carpeta antes de migrar los servidores MCP, porque el fichero de destino vive en el espacio de trabajo.",
    );
    return;
  }

  const runtime = vscode.workspace.getConfiguration("picode.pi").get<string>("runtime", "path");
  const runtimeMode = runtime === "managed" || runtime === "custom" ? runtime : "path";
  const agentDir = selectedAgentDir(extensionUri, runtimeMode);
  const source = path.join(agentDir, "mcp.json");

  const decided = migrationFromText(readTextIfPresent(source));
  if ("empty" in decided) {
    void vscode.window.showInformationMessage(
      `PiCode: no hay servidores MCP que migrar. Se leyó ${path.basename(source)} del perfil de pi y no declara ninguno.`,
    );
    return;
  }

  const targetDir = path.join(folder.uri.fsPath, ...NATIVE_MCP_RELATIVE.slice(0, -1));
  const target = path.join(folder.uri.fsPath, ...NATIVE_MCP_RELATIVE);

  if (existsSync(target)) {
    const choice = await vscode.window.showWarningMessage(
      "PiCode: ya existe un .vscode/mcp.json en esta carpeta. Migrar lo reemplaza.",
      { modal: true },
      "Reemplazar",
    );
    if (choice !== "Reemplazar") {
      return;
    }
  }

  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(target, mcpJsonText(decided.migration));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`PiCode: no se pudo escribir ${target}. ${message}`);
    return;
  }

  const count = Object.keys(decided.migration.config.servers).length;
  const skipped = decided.migration.skipped;
  if (skipped.length === 0) {
    void vscode.window.showInformationMessage(
      `PiCode: ${count} ${count === 1 ? "servidor MCP migrado" : "servidores MCP migrados"} a .vscode/mcp.json.`,
    );
    return;
  }

  await vscode.window.showInformationMessage("PiCode: migración de MCP terminada", {
    modal: true,
    detail: [
      `${count} migrados.`,
      ...skipped.map((server) => `${server.name}: no se migró — ${server.reason}.`),
    ].join("\n"),
  });
}
