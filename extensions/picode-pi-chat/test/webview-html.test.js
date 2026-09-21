/*
 * Exercises the document both panels are built from.
 *
 * The content security policy here is the kind of thing that fails silently. When
 * it started as `default-src 'none'` plus `style-src`, `font-src` and `script-src`
 * it had no `img-src`, so images inherited `'none'` and the editor blocked every
 * one of them. Nothing threw: the element existed, the transcript kept its layout,
 * and only the picture was missing, which is why a user found it instead of a test.
 * The same class of failure applies to the nonce — a script tag whose nonce does
 * not match the policy renders its markup and then does nothing.
 *
 * `webview-html.ts` imports `vscode` for `Uri.joinPath`, stubbed through a resolver
 * hook like the other suites. The module is TypeScript, so the suite loads the
 * compiled copy the way `runtime.test.js` does.
 *
 * Run with: npm test
 */
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "vscode-stub.js");
  }
  return originalResolve.call(this, request, ...rest);
};

const EXTENSION_ROOT = path.resolve(__dirname, "..");

// Distinctive on purpose: a policy that happens to contain the editor's real
// prefix would make the assertions below pass without the code doing anything.
const CSP_SOURCE = "vscode-webview://csp-source";

const resourceUri = (uri) =>
  `vscode-webview-resource://media/${uri.fsPath.replace(/\\/g, "/").split("/").pop()}`;

const webview = {
  cspSource: CSP_SOURCE,
  asWebviewUri: resourceUri,
};

const extensionUri = { fsPath: path.join("D:", "fake", "extension") };

const cspOf = (html) => {
  const match = html.match(/Content-Security-Policy" content="([^"]*)"/);
  return match ? match[1] : "";
};

// Reads one directive out of the policy, so a check can never be satisfied by a
// fragment that lives in a neighbouring one.
const directive = (csp, name) => {
  const match = csp.match(new RegExp(`(?:^|;\\s*)${name}\\s+([^;]*)`));
  return match ? match[1].trim() : "";
};

const nonceOf = (html) => {
  const match = html.match(/<script nonce="([^"]*)"/);
  return match ? match[1] : "";
};

const scriptSrcs = (html) =>
  [...html.matchAll(/<script nonce="[^"]*" src="([^"]*)"><\/script>/g)].map((match) => match[1]);

const linkHrefs = (html) =>
  [...html.matchAll(/<link href="([^"]*)" rel="stylesheet" \/>/g)].map((match) => match[1]);

async function main() {
  const compiled = path.join(EXTENSION_ROOT, "out", "webview-html.js");
  if (!fs.existsSync(compiled)) {
    console.error(`Missing ${compiled}. Run "npm run compile" first.`);
    process.exit(2);
  }
  const loaded = await import(pathToFileURL(compiled).href);
  const module = loaded.buildWebviewHtml ? loaded : loaded.default;

  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

  const scripts = ["markdown.js", "main.js"];
  const styles = ["codicon.css", "main.css"];
  const html = module.buildWebviewHtml({
    webview,
    extensionUri,
    title: "PiCode: agente pi",
    body: "<p>hola</p>",
    scripts,
    styles,
  });
  const csp = cspOf(html);

  // --- images ----------------------------------------------------------------

  // The regression this file exists for. Thumbnails reach the webview as data
  // URLs, so without `data:` the picture is blocked and nothing else changes.
  const imgSrc = directive(csp, "img-src");
  check(
    "img-src allows data: because the panel's thumbnails are data URLs",
    imgSrc.split(/\s+/).includes("data:"),
    `img-src -> ${imgSrc || "(absent)"}`,
  );
  check(
    "img-src also allows the webview cspSource, so media/ images load too",
    imgSrc.split(/\s+/).includes(CSP_SOURCE),
    `img-src -> ${imgSrc || "(absent)"}`,
  );

  // --- the rest of the policy ------------------------------------------------

  // Pinned because it is what makes every other directive load-bearing: a policy
  // that starts allowing everything by default makes the omissions harmless.
  check(
    "default-src 'none' still denies everything that was not named",
    directive(csp, "default-src") === "'none'",
    `default-src -> ${directive(csp, "default-src") || "(absent)"}`,
  );

  const nonce = nonceOf(html);
  check(
    "script-src authorises the same nonce the script tag carries",
    nonce.length > 0 && directive(csp, "script-src").includes(`'nonce-${nonce}'`),
    `nonce -> ${nonce || "(absent)"}; script-src -> ${directive(csp, "script-src") || "(absent)"}`,
  );
  check(
    "the nonce is not empty on either side",
    nonce.length > 0 && nonceOf(html).length > 0,
    `length -> ${nonce.length}`,
  );

  // The vendored codicon font is a real resource: a missing font-src costs the
  // icons without printing an error anywhere.
  check(
    "style-src carries the cspSource",
    directive(csp, "style-src").includes(CSP_SOURCE),
    `style-src -> ${directive(csp, "style-src") || "(absent)"}`,
  );
  check(
    "font-src carries the cspSource",
    directive(csp, "font-src").includes(CSP_SOURCE),
    `font-src -> ${directive(csp, "font-src") || "(absent)"}`,
  );

  // --- resources -------------------------------------------------------------

  // Order is asserted, not just presence: markdown.js has to be in place before
  // main.js runs, and two arrays that were silently concatenated would still be
  // wrong here even though every URI appeared.
  const expectedScripts = scripts.map((name) =>
    resourceUri({ fsPath: path.join(extensionUri.fsPath, "media", name) }),
  );
  const expectedLinks = styles.map((name) =>
    resourceUri({ fsPath: path.join(extensionUri.fsPath, "media", name) }),
  );

  const producedScripts = scriptSrcs(html);
  check(
    "each name in scripts produces one <script> at the URI asWebviewUri returned, in order",
    producedScripts.length === scripts.length &&
      producedScripts.every((src, index) => src === expectedScripts[index]),
    JSON.stringify(producedScripts),
  );

  const producedLinks = linkHrefs(html);
  check(
    "each name in styles produces one <link> at the URI asWebviewUri returned, in order",
    producedLinks.length === styles.length &&
      producedLinks.every((href, index) => href === expectedLinks[index]),
    JSON.stringify(producedLinks),
  );

  // --- the nonce is per document ---------------------------------------------

  const second = module.buildWebviewHtml({
    webview,
    extensionUri,
    title: "PiCode: agente pi",
    body: "<p>hola</p>",
    scripts,
    styles,
  });
  const secondNonce = nonceOf(second);
  check(
    "two documents get two different nonces, so a nonce is not a constant",
    nonce.length > 0 && secondNonce.length > 0 && secondNonce !== nonce,
    `${nonce} vs ${secondNonce || "(absent)"}`,
  );

  // --- report ----------------------------------------------------------------

  let failed = 0;
  for (const result of results) {
    console.log(
      `${result.ok ? "ok  " : "FAIL"} ${result.label}${result.ok || !result.detail ? "" : ` -> ${result.detail}`}`,
    );
    if (!result.ok) {
      failed += 1;
    }
  }
  console.log(
    failed === 0
      ? `\nALL ${results.length} CHECKS PASS`
      : `\n${failed} of ${results.length} CHECKS FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("webview-html checks failed:", error);
  process.exit(2);
});
