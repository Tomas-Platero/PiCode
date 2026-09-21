import * as vscode from "vscode";

/**
 * Builds the document for a panel webview.
 *
 * Both views in the PiCode container share this, so the content security policy,
 * the nonce and the resource URIs are defined once. The reason is not brevity: a
 * webview whose script tag misses the nonce renders its markup and then does
 * nothing, silently, which is exactly the failure worth having a single copy of.
 */
export function buildWebviewHtml(options: {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  title: string;
  body: string;
  scripts?: readonly string[];
  styles?: readonly string[];
}): string {
  const nonce = createNonce();
  const csp = [
    "default-src 'none'",
    `style-src ${options.webview.cspSource}`,
    `font-src ${options.webview.cspSource}`,
    // `default-src 'none'` covers `img-src` too, so without this line every image
    // in the panel is blocked — and the failure is silent: the element is there,
    // the transcript keeps its layout, and only the picture is missing. The panel
    // rendered nothing but text until attachments arrived, which is why this was
    // absent and why nothing caught it: an omission from a restrictive policy looks
    // exactly like a working policy until something needs the permission.
    //
    // `data:` is what the thumbnails are, since the host hands the webview a data
    // URL rather than bytes it could send back. `cspSource` is kept for any image
    // that eventually comes from the extension's own media directory.
    `img-src ${options.webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  const resources = (names: readonly string[] | undefined, render: (uri: vscode.Uri) => string): string =>
    (names ?? [])
      .map((name) =>
        render(
          options.webview.asWebviewUri(
            vscode.Uri.joinPath(options.extensionUri, "media", name),
          ),
        ),
      )
      .join("\n");

  const links = resources(options.styles, (uri) => `    <link href="${uri}" rel="stylesheet" />`);
  const scripts = resources(
    options.scripts,
    (uri) => `    <script nonce="${nonce}" src="${uri}"></script>`,
  );

  return `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
${links}
    <title>${options.title}</title>
  </head>
  <body>
${options.body}
${scripts}
  </body>
</html>`;
}

export function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}
