/**
 * Answers pi's `extension_ui_request` records with the editor's own dialogs.
 *
 * pi asks its host for input and blocks until it is answered (see
 * `PiExtensionUiDialogRequest` in `protocol.ts`). Until this module existed the
 * client typed those requests and ignored them, which is why a provider login
 * could not be completed from inside the editor and the owner had to open a
 * terminal instead.
 *
 * This module owns the *answering*: what the owner decided, expressed as a
 * `PiExtensionUiAnswer`. It never builds the wire record — the client does, so
 * the request's `id` can only come from the request. And it draws nothing: the
 * editor's quick pick, modal and input box are the whole interface, because a
 * second look-alike set of dialogs would be one more thing to keep faithful.
 *
 * The `vscode` import is what makes this module untestable without an editor.
 * The pure wire contract it produces is tested in `test/pi-ui-bridge.test.js`;
 * the dialog interactions are not, and are not pretended to be.
 */
import * as vscode from "vscode";
import type { PiExtensionUiAnswer, PiExtensionUiRequest } from "./protocol";

/**
 * The host's answer to one request: a decision, or `undefined` when the request
 * carries no answer at all. Installing this on the RPC client is what makes pi's
 * dialogs work from inside the editor.
 */
export type PiExtensionUiHandler = (
  request: PiExtensionUiRequest,
) => Promise<PiExtensionUiAnswer | undefined> | PiExtensionUiAnswer | undefined;

/**
 * The editor's quick pick, shared by pi's extension dialogs and its provider
 * login. Returns the chosen item's index so each caller can turn it back into
 * whatever it actually offered -- a plain string, or an option id.
 */
async function chooseFromList(
  title: string,
  items: readonly vscode.QuickPickItem[],
): Promise<number | undefined> {
  const picked = await vscode.window.showQuickPick([...items], {
    title,
    ignoreFocusOut: true,
  });
  return picked === undefined ? undefined : items.indexOf(picked);
}

/**
 * The editor's single-line input box, shared by the extension dialogs and the
 * login prompts. `password` masks what the owner types, which the extension
 * request protocol has no flag for -- the reason this helper exists instead of
 * calling `showInputBox` twice.
 */
async function askForText(options: {
  title: string;
  placeholder?: string;
  password: boolean;
}): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: options.title,
    prompt: options.title,
    ...(options.placeholder === undefined ? {} : { placeHolder: options.placeholder }),
    ...(options.password ? { password: true } : {}),
    ignoreFocusOut: true,
  });
}

/**
 * One function per family, in the order the protocol declares them:
 * `select` -> quick pick, `confirm` -> modal, `input` -> input box, `notify` ->
 * the notification matching `notifyType`. `editor` is answered `cancelled`, and
 * the four methods that configure a terminal are ignored on purpose.
 *
 * No timer is scheduled anywhere. The optional `timeout` on a request belongs to
 * pi; answering after it has expired would invent a decision the owner never
 * made.
 */
export async function handleExtensionUiRequest(
  request: PiExtensionUiRequest,
): Promise<PiExtensionUiAnswer | undefined> {
  switch (request.method) {
    case "select": {
      // `ignoreFocusOut` is what lets the owner switch to a browser mid-login
      // without the pick being dismissed, which is the main thing this bridge
      // exists for. Dismissing the pick (Escape) is `cancelled`.
      const index = await chooseFromList(
        request.title,
        request.options.map((option) => ({ label: option })),
      );
      return index === undefined ? { cancelled: true } : { value: request.options[index] };
    }

    case "confirm": {
      const choice = await vscode.window.showWarningMessage(
        request.title,
        { modal: true, detail: request.message },
        "Sí",
        "No",
      );
      if (choice === "Sí") {
        return { confirmed: true };
      }
      if (choice === "No") {
        return { confirmed: false };
      }
      // Dismissed without choosing: pi reads `cancelled` on `confirm` as `false`.
      return { cancelled: true };
    }

    case "input": {
      const value = await askForText({
        title: request.title,
        password: false,
        ...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }),
      });
      return value === undefined ? { cancelled: true } : { value };
    }

    case "editor": {
      // `editor` asks for multi-line free text. The editor has no native
      // equivalent, and answering with a single line would silently mangle what
      // the owner typed, so the honest answer is `cancelled` rather than a
      // plausible-looking truncation.
      //
      // Nothing the owner needs reaches here. The provider login's prompts are a
      // choice or one line of free text: pi's OAuth adapter routes them through
      // `provider-composer.js` (`onManualCodeInput` -> `prompt({type:"manual_code"})`),
      // and the login dialog renders the manual code with a single-line `Input`
      // (`dist/modes/interactive/components/login-dialog.js`). The RPC `editor`
      // method is reached only by an extension that asks for it by name
      // (`ctx.ui.editor`, forwarded by `dist/core/extensions/runner.js`); no
      // built-in path calls it.
      void vscode.window.showWarningMessage(
        "PiCode no puede mostrar un editor multilínea, así que la petición se ha cancelado.",
      );
      return { cancelled: true };
    }

    case "notify": {
      const message = request.message;
      if (request.notifyType === "warning") {
        void vscode.window.showWarningMessage(message);
      } else if (request.notifyType === "error") {
        void vscode.window.showErrorMessage(message);
      } else {
        void vscode.window.showInformationMessage(message);
      }
      return undefined;
    }

    case "setStatus":
    case "setWidget":
    case "setTitle":
    case "set_editor_text":
      // These four configure pi's own terminal interface: a footer status entry,
      // a widget above or below the editor, the window title and the text already
      // typed in the editor. The panel is not that terminal — it has no footer,
      // no widget slot and no pi text editor — so there is nothing faithful to do
      // with them and ignoring them is the honest behaviour. This is the hook if
      // the panel ever draws its own terminal: `set_editor_text` would prefill
      // the panel's own input box, and the other three would need a place to live.
      return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Provider login: pi's `AuthInteraction`, answered with the same dialogs
 * ------------------------------------------------------------------ */

/**
 * pi-ai's auth types (`@earendil-works/pi-ai/dist/auth/types.d.ts`), quoted
 * rather than imported because pi is ESM-only and loaded by URL at runtime.
 *
 * `ModelRuntime.login(providerId, type, interaction)` is the call that persists
 * a credential to `auth.json`; `setRuntimeApiKey` is an in-memory override pi
 * does not persist. `AuthInteraction` is what pi asks the host for while that
 * login runs.
 */
export type AuthPrompt =
  | { signal?: AbortSignal; type: "text"; message: string; placeholder?: string }
  | { signal?: AbortSignal; type: "secret"; message: string; placeholder?: string }
  | {
      signal?: AbortSignal;
      type: "select";
      message: string;
      options: readonly AuthChoice[];
    }
  | { signal?: AbortSignal; type: "manual_code"; message: string; placeholder?: string };

/** One `select` option: `id` is what pi gets back, `label` is what the owner reads. */
export interface AuthChoice {
  id: string;
  label: string;
  description?: string;
}

/** A login event pi announces and never waits on. */
export type AuthEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

export interface AuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}

/** What the editor is asked, one descriptor per `AuthPrompt` variant. */
export type AuthDialog =
  | { kind: "input"; title: string; password: boolean; placeholder?: string }
  | { kind: "choose"; title: string; options: readonly AuthChoice[] };

/**
 * Maps one login prompt to the editor dialog that answers it. Pure, so the
 * mapping is tested without an editor; `createAuthInteraction` is the only
 * thing here that touches `vscode`.
 *
 * Two shapes do not fit `PiExtensionUiRequest`, and it is the mapping that
 * adapts them instead of a second dialog: a `secret` must be masked
 * (`password: true`, which the extension protocol has no field for), and a
 * `select` separates the `id` pi gets back from the `label` the owner reads
 * (the extension protocol's options are bare strings).
 */
export function authPromptToDialog(prompt: AuthPrompt): AuthDialog {
  switch (prompt.type) {
    case "select":
      return { kind: "choose", title: prompt.message, options: prompt.options };
    case "secret":
      return {
        kind: "input",
        title: prompt.message,
        password: true,
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      };
    case "text":
    case "manual_code":
      return {
        kind: "input",
        title: prompt.message,
        password: false,
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      };
  }
}

/** Thrown when the owner dismisses a login prompt, so a cancelled login is not a failed one. */
export class AuthPromptCancelled extends Error {
  constructor(title: string) {
    super(`Login cancelled: ${title}`);
    this.name = "AuthPromptCancelled";
  }
}

/**
 * The string pi's login expects from one editor answer, or a thrown
 * cancellation. `undefined` is the editor saying the owner dismissed the
 * prompt, and an empty string would be worse than an error: it would submit an
 * empty authorization code as if the owner had typed it. A `select` must answer
 * with an option id, so a value that is not one of the offered ids is refused
 * instead of reaching pi as an unknown choice.
 */
export function authDialogAnswer(dialog: AuthDialog, answer: string | undefined): string {
  if (answer === undefined) {
    throw new AuthPromptCancelled(dialog.title);
  }
  if (dialog.kind === "choose" && !dialog.options.some((option) => option.id === answer)) {
    throw new Error(`"${answer}" is not one of the offered options for ${dialog.title}`);
  }
  return answer;
}

/** What a login event becomes on screen: a message, and a URL to open if it carries one. */
export interface AuthNotice {
  message: string;
  url?: string;
}

/** Maps a login event to the notice shown to the owner. Pure, like the prompt mapping. */
export function authEventToNotice(event: AuthEvent): AuthNotice {
  switch (event.type) {
    case "info": {
      const links = (event.links ?? []).map((link) =>
        link.label === undefined ? link.url : `${link.label}: ${link.url}`,
      );
      return {
        message: links.length === 0 ? event.message : `${event.message}\n${links.join("\n")}`,
      };
    }
    case "auth_url":
      return {
        message:
          event.instructions === undefined ? event.url : `${event.instructions}\n${event.url}`,
        url: event.url,
      };
    case "device_code":
      return {
        message: `Introduce el código ${event.userCode} en ${event.verificationUri}`,
        url: event.verificationUri,
      };
    case "progress":
      return { message: event.message };
  }
}

/**
 * Builds the `AuthInteraction` pi calls during `ModelRuntime.login`. The prompts
 * go through the same quick pick and input box as pi's extension dialogs, so
 * there is one dialog layer and not a second set of look-alikes.
 *
 * Known gap: `AuthPrompt.signal` and `AuthInteraction.signal` cannot dismiss an
 * editor dialog that is already open (VS Code offers no way to close its own
 * quick pick or input box programmatically). A prompt pi aborts while the owner
 * still has it on screen can therefore still be answered, and that answer
 * reaches a login that has already moved on, where pi discards it. The
 * alternative -- a host-side timer answering on the owner's behalf -- is the
 * failure this module exists to avoid.
 */
export function createAuthInteraction(): AuthInteraction {
  return {
    async prompt(prompt) {
      const dialog = authPromptToDialog(prompt);
      if (dialog.kind === "choose") {
        const index = await chooseFromList(
          dialog.title,
          dialog.options.map((option) => ({
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
        );
        return authDialogAnswer(dialog, index === undefined ? undefined : dialog.options[index].id);
      }
      const value = await askForText({
        title: dialog.title,
        password: dialog.password,
        ...(dialog.placeholder === undefined ? {} : { placeholder: dialog.placeholder }),
      });
      return authDialogAnswer(dialog, value);
    },
    notify(event) {
      const { message, url } = authEventToNotice(event);
      if (url === undefined) {
        void vscode.window.showInformationMessage(message);
        return;
      }
      void vscode.window.showInformationMessage(message, "Abrir en el navegador").then((choice) => {
        if (choice !== undefined) {
          void vscode.env.openExternal(vscode.Uri.parse(url));
        }
      });
    },
  };
}
