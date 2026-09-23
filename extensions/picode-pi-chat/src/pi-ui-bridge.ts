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
      const choice = await vscode.window.showQuickPick([...request.options], {
        title: request.title,
        ignoreFocusOut: true,
      });
      return choice === undefined ? { cancelled: true } : { value: choice };
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
      const value = await vscode.window.showInputBox({
        title: request.title,
        prompt: request.title,
        ...(request.placeholder === undefined ? {} : { placeHolder: request.placeholder }),
        ignoreFocusOut: true,
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
