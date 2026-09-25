/*
 * pi's capabilities as Language Model Tools of the editor.
 *
 * Two different things travel here, and keeping them apart is the point:
 *
 * - `picode_pi_status` reads a fact only this extension can read: which instance of pi
 *   is selected, which executable that resolves to, and what the live session is on.
 * - `picode_ask_pi` hands a whole sub-task to pi and answers with what pi said. pi's own
 *   file, terminal and memory tools run inside that turn — they are the agent loop pi
 *   already has, not something the editor has to re-declare as tools.
 *
 * The text builders are pure and exported, so the wording is pinned by tests instead of
 * being whatever the last edit happened to write.
 */

import * as vscode from "vscode";
import { CollectingSink, PiTurnForwarder, type TurnCancellation } from "./chat-turn";
import type { PiClient } from "./pi-client";
import type { PiEvent } from "./protocol";

export const PI_STATUS_TOOL = "picode_pi_status";
export const PI_ASK_TOOL = "picode_ask_pi";

/** The facts the status tool reports, gathered by the caller that can resolve them. */
export interface PiInstanceStatus {
  /** The selected instance mode, e.g. `path`, `managed` or `custom`. */
  mode: string;
  /** How the resolved executable is named for a person, never a raw absolute path. */
  display: string;
  /** The profile in force, named for a person. */
  profile: string;
  /** The model the live session is on, when there is a session. */
  model?: string;
  /** The session's own name, when it has one. */
  sessionName?: string;
}

/** The status tool's answer, as plain text. */
export function formatStatus(status: PiInstanceStatus): string {
  const lines = [
    `Instancia de pi: ${status.mode}`,
    `Ejecutable: ${status.display}`,
    `Perfil: ${status.profile}`,
    `Modelo: ${status.model ?? "sin sesión activa"}`,
  ];
  if (status.sessionName !== undefined && status.sessionName.length > 0) {
    lines.push(`Sesión: ${status.sessionName}`);
  }
  return lines.join("\n");
}

/**
 * Runs one prompt to completion and returns the assistant text.
 *
 * The turn is awaited through `agent_settled`, not through `prompt()`: `prompt()`
 * settles when pi accepts the command, which for a long sub-task is the beginning and
 * not the end. Cancellation aborts at pi so the promise resolves with a real ending.
 */
export async function askPi(client: PiClient, prompt: string, token: TurnCancellation): Promise<string> {
  const sink = new CollectingSink();
  const forwarder = new PiTurnForwarder(sink);
  const subscription = client.onEvent((event: PiEvent) => forwarder.handle(event));
  const cancellation = token.onCancellationRequested(() => {
    void client.abort().catch(() => undefined);
  });

  try {
    await client.prompt(prompt);
    await forwarder.settled;
    return sink.text;
  } finally {
    cancellation.dispose();
    subscription.dispose();
  }
}

export interface PiToolDeps {
  /** The shared client, or `undefined` when pi cannot be started. */
  ensureClient(): Promise<PiClient | undefined>;
  /** The status facts, read from the instance resolver and the live session. */
  status(): Promise<PiInstanceStatus>;
  log(line: string): void;
}

const NO_CLIENT_TEXT =
  "No se pudo arrancar pi. Revisa la configuración de la extensión (picode.pi.executablePath) y el canal de salida PiCode.";

/**
 * Registers both tools and keeps their disposables on the extension context, so
 * deactivation unregisters them exactly once.
 */
export function registerPiTools(context: vscode.ExtensionContext, deps: PiToolDeps): void {
  const status = vscode.lm.registerTool<Record<string, never>>(PI_STATUS_TOOL, {
    async invoke() {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(formatStatus(await deps.status())),
      ]);
    },
  });

  const ask = vscode.lm.registerTool<{ prompt: string }>(PI_ASK_TOOL, {
    async invoke(options, token) {
      const client = await deps.ensureClient();
      if (client === undefined) {
        deps.log(`tool ${PI_ASK_TOOL}: no client`);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(NO_CLIENT_TEXT)]);
      }
      const text = await askPi(client, options.input.prompt, token);
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
    },
  });

  context.subscriptions.push(status, ask);
}
