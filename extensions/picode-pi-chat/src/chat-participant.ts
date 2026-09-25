/*
 * `@pi` as a Chat Participant of the editor.
 *
 * Why a participant and not the model picker: the Language Model Chat Provider API —
 * the mechanism that would put pi inside the editor's own model selector — is the one
 * documented as tied to a GitHub Copilot plan. A participant is independent of it, and
 * `contributes.chatParticipants` with `isDefault: true` is enough for pi to be the
 * agent a chat opens with: `ChatAgentService._preferExtensionAgent` prefers an
 * extension-contributed default agent over the core ones.
 *
 * The turn itself is not implemented here. `PiTurnForwarder` maps pi's event stream to
 * markdown and progress, and this module only moves those onto the participant's
 * stream and owns the lifecycle: subscribe, prompt, await the settle, clean up.
 */

import * as vscode from "vscode";
import { PiTurnForwarder } from "./chat-turn";
import type { PiClient } from "./pi-client";
import type { PiEvent } from "./protocol";

export const PI_PARTICIPANT_ID = "picode.pi";

export interface ChatParticipantDeps {
  /** The same client the panel uses: one pi process, one instance, one transport. */
  ensureClient(): Promise<PiClient | undefined>;
  /** Where a host-side failure is written so it is diagnosable after the fact. */
  log(line: string): void;
}

/** What the reader is told when pi could not be started at all. */
const NO_CLIENT_MESSAGE =
  "No se pudo arrancar pi. Revisa **picode.pi.executablePath** y el canal de salida PiCode.";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the request handler. Separate from registration so the lifecycle can be
 * exercised without an editor, and so the participant adds no behaviour the panel
 * would not also get from the same client.
 */
export function createPiRequestHandler(
  deps: ChatParticipantDeps,
): vscode.ChatRequestHandler {
  return async (request, _context, stream, token) => {
    const client = await deps.ensureClient();
    if (client === undefined) {
      stream.markdown(NO_CLIENT_MESSAGE);
      return {};
    }

    const forwarder = new PiTurnForwarder({
      markdown: (text) => stream.markdown(text),
      progress: (text) => stream.progress(text),
    });
    const subscription = client.onEvent((event: PiEvent) => forwarder.handle(event));
    const cancellation = token.onCancellationRequested(() => {
      // `abort` settles the run at pi, which is what makes the forwarder's promise
      // resolve; a host-side timeout would instead invent an ending pi never had.
      void client.abort().catch((error: unknown) => deps.log(`abort failed: ${errorText(error)}`));
    });

    // A contributed slash command arrives as its own field, and pi reads commands from
    // the text, so the two have to be joined back into the one shape pi accepts.
    const prompt = request.command === undefined ? request.prompt : `/${request.command} ${request.prompt}`;

    try {
      await client.prompt(prompt);
      const outcome = await forwarder.settled;
      if (!outcome.ok && outcome.error !== undefined) {
        stream.markdown(`\n\n> PiCode: ${outcome.error}\n`);
      }
      return {};
    } catch (error) {
      const message = errorText(error);
      deps.log(`chat turn failed: ${message}`);
      forwarder.finish({ ok: false, error: message });
      stream.markdown(`\n\n> PiCode: ${message}\n`);
      return {};
    } finally {
      cancellation.dispose();
      subscription.dispose();
    }
  };
}

/**
 * Registers `@pi` and returns the participant, so a caller can keep its handle if it
 * ever needs one. The participant is also pushed onto the extension's subscriptions,
 * which is what disposes it on deactivation.
 */
export function registerPiChatParticipant(
  context: vscode.ExtensionContext,
  deps: ChatParticipantDeps,
): vscode.ChatParticipant {
  const participant = vscode.chat.createChatParticipant(PI_PARTICIPANT_ID, createPiRequestHandler(deps));
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "picode-icon.png");
  context.subscriptions.push(participant);
  return participant;
}
