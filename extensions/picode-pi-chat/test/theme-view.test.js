/*
 * Exercises the theme panel's host half: what a webview message may reach, and what the
 * owner reads afterwards.
 *
 * The panel itself needs an editor, so what is checked here is every decision it makes
 * before drawing anything — and the two that matter most are security-shaped:
 *
 * - **the only external URL a message can open is the site that previews themes.** The
 *   webview is a document this extension does not control, and a prefix comparison on the
 *   whole URL would accept `https://vscodethemes.com.example.test`, which belongs to someone
 *   else. Host and scheme are compared instead, and the neighbouring cases are pinned;
 * - **the panel declares its own reading of the editor's theme**, rather than caching a value
 *   at activation, so the Aspecto row cannot keep saying one thing while the editor shows
 *   another.
 *
 * The rest is the shape of the surface: the panel reuses the document builder instead of
 * writing a second one (a webview whose script tag misses the nonce renders and then does
 * nothing, silently), the gallery component is loaded before the bootstrap that mounts it,
 * and the command the palette runs is the one the manifest declares.
 *
 * The `vscode` module is stubbed through a resolver hook as the other suites do; nothing here
 * starts an editor, opens a URL or installs anything.
 *
 * Run with: npm test
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

const EXTENSION_ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = path.join(EXTENSION_ROOT, "src");

const originalResolve = Module._resolveFilename;
const PANEL_STUB = path.join(__dirname, "vscode-panel-stub.js");
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    // The panel stub, not the resolver one: this suite drives a whole surface, so it needs
    // real panels, real messages and the editor's settings kept somewhere readable.
    return PANEL_STUB;
  }
  return originalResolve.call(this, request, ...rest);
};

async function main() {
  const compiled = path.join(EXTENSION_ROOT, "out", "theme-view.js");
  if (!fs.existsSync(compiled)) {
    console.error(`Missing ${compiled}. Run "npm run compile" first.`);
    process.exit(2);
  }
  const loaded = await import(pathToFileURL(compiled).href);
  const api = loaded.externalUrlToOpen ? loaded : loaded.default;

  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });
  const cleanups = [];
  const tempDir = (prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(dir);
    return dir;
  };
  const source = (name) => fs.readFileSync(path.join(SOURCE_ROOT, name), "utf8");
  // A file that is not there yet must fail a check, not crash the suite: the media half is
  // written by hand and a missing one is exactly what these checks exist to catch.
  const mediaFile = (name) => {
    try {
      return fs.readFileSync(path.join(EXTENSION_ROOT, "media", name), "utf8");
    } catch {
      return "";
    }
  };

  /* --- the panel is one tab, and it exists --- -------------------------------- */

  /*
   * The defect this exists for: `selectTheme` built a fresh view on every call, so the guard
   * that was supposed to reveal the open tab never held and the three doors into the gallery
   * opened three panels. It is checked here by running the real flow through the panel stub —
   * create, reveal, close and create again — because no reading of the source would have caught
   * it: every line was correct on its own.
   */
  const stub = require(PANEL_STUB);
  const settings = stub.__state;
  const themeDir = tempDir("picode-theme-panel-");
  fs.mkdirSync(path.join(themeDir, "themes"), { recursive: true });
  fs.writeFileSync(
    path.join(themeDir, "themes", "one.json"),
    JSON.stringify({
      name: "One",
      type: "dark",
      colors: { "editor.background": "#101010" },
      tokenColors: [{ scope: "comment", settings: { foreground: "#202020" } }],
    }),
  );
  settings.extensions = [
    {
      id: "fixture.theme",
      extensionPath: themeDir,
      packageJSON: {
        displayName: "Fixture Theme",
        version: "1.0.0",
        contributes: {
          themes: [{ id: "One", label: "One", uiTheme: "vs-dark", path: "./themes/one.json" }],
        },
      },
    },
  ];
  const context = {
    extensionUri: { fsPath: path.join(EXTENSION_ROOT) },
    globalStorageUri: { fsPath: path.join(themeDir, "storage") },
    globalState: { update: async () => undefined },
    subscriptions: [],
  };

  await api.selectTheme(context);
  check(
    "opening the gallery creates one panel",
    settings.panels.length === 1 && settings.panels[0].viewType === "picode.theme",
    JSON.stringify(settings.panels.map((panel) => panel.viewType)),
  );
  check(
    "the panel document is the shared builder's, with the gallery and its bootstrap",
    settings.panels[0].webview.html.includes("theme-gallery.js") &&
      settings.panels[0].webview.html.includes("theme.js") &&
      settings.panels[0].webview.html.includes("theme.css") &&
      settings.panels[0].webview.html.includes('id="theme-root"') &&
      /script-src 'nonce-/.test(settings.panels[0].webview.html),
    JSON.stringify({
      gallery: settings.panels[0].webview.html.includes("theme-gallery.js"),
      bootstrap: settings.panels[0].webview.html.includes("theme.js"),
      styles: settings.panels[0].webview.html.includes("theme.css"),
      root: settings.panels[0].webview.html.includes('id="theme-root"'),
      nonce: /script-src 'nonce-/.test(settings.panels[0].webview.html),
      start: settings.panels[0].webview.html.slice(0, 200),
    }),
  );
  await api.selectTheme(context);
  await api.selectTheme(context);
  check(
    "opening it again reveals the same tab instead of opening another one",
    settings.panels.length === 1 && settings.reveals === 2,
    `${settings.panels.length} panels, ${settings.reveals} reveals`,
  );
  settings.panels[0].__close();
  await api.selectTheme(context);
  check(
    "a closed tab does not stay as the panel that is open: the next call builds a fresh one",
    settings.panels.length === 2 && settings.panels[1].disposed === false,
    `${settings.panels.length} panels`,
  );
  settings.panels[1].__close();

  /*
   * The flow of the panel itself, over a service that answers instantly.
   *
   * The real one reaches the gallery the moment a panel says `ready`, and a test that waited
   * for open-vsx.org would be slow, flaky and dependent on somebody else's uptime. What is
   * checked here is the panel's own behaviour — what it sends, when, and what it does with the
   * answer — which is the half that had the defect.
   */
  const fakeRow = {
    id: "fixture.theme",
    displayName: "Fixture Theme",
    description: "",
    downloads: 0,
    version: "1.0.0",
    installed: true,
    galleryUrl: "https://vscodethemes.com/?q=Fixture",
    themes: [{ id: "One", label: "One", uiTheme: "vs-dark", path: "./themes/one.json" }],
  };
  const asked = { catalog: 0, apply: 0 };
  const fakeService = {
    installed: () => [fakeRow],
    catalog: async () => {
      asked.catalog += 1;
      return [];
    },
    preview: async () => ({
      ok: true,
      variant: { id: "One", label: "One" },
      preview: { dark: true, frame: {}, lines: [] },
    }),
    apply: async () => {
      asked.apply += 1;
      settings.settings["workbench.colorTheme"] = "One";
      return { applied: true, installed: false, needsReload: false, current: "One" };
    },
    current: () => settings.settings["workbench.colorTheme"],
  };
  const view = api.ThemeView.create(context, fakeService);
  await view.show();
  const panel = settings.panels[settings.panels.length - 1];
  panel.__receive({ type: "ready" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const listed = settings.posted.filter((message) => message.type === "themes");
  check(
    "the ready message gets the installed rows first, and then the gallery's",
    listed.length === 2 &&
      listed[0].rows.length === 1 &&
      listed[0].rows[0].id === "fixture.theme" &&
      listed[0].rows[0].installed === true &&
      listed[1].rows.length === 1 &&
      asked.catalog === 1,
    JSON.stringify({
      mensajes: listed.map((message) => message.rows.length),
      catalogos: asked.catalog,
    }),
  );

  panel.__receive({ type: "apply", rowId: "fixture.theme", themeId: "One" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const appliedSent = settings.posted.filter((message) => message.type === "applied").pop();
  const relisted = settings.posted[settings.posted.length - 1];
  check(
    "applying writes the editor's setting and says so",
    appliedSent !== undefined &&
      appliedSent.result.applied === true &&
      settings.settings["workbench.colorTheme"] === "One" &&
      appliedSent.message.includes("One") &&
      asked.apply === 1,
    JSON.stringify({
      applied: appliedSent === undefined ? null : appliedSent.result,
      settings: settings.settings,
      mensajes: settings.posted.map((message) => message.type),
    }),
  );
  check(
    "and the rows are sent again, so the panel cannot keep offering to install what it has",
    relisted.type === "themes" && relisted.rows[0].installed === true && appliedSent !== relisted,
    JSON.stringify({ ultimo: relisted.type }),
  );
  panel.__close();

  /* --- what a message may open ---------------------------------------------- */

  check(
    "the site that previews themes is the only host a message can open, over https",
    api.externalUrlToOpen("https://vscodethemes.com/?q=Dracula") !== undefined &&
      api.externalUrlToOpen("https://vscodethemes.com") !== undefined &&
      api.externalUrlToOpen("https://www.vscodethemes.com/?q=x") !== undefined,
    JSON.stringify([
      api.externalUrlToOpen("https://vscodethemes.com/?q=Dracula"),
      api.externalUrlToOpen("https://vscodethemes.com"),
    ]),
  );
  check(
    "a host that merely starts with the site's name is refused",
    api.externalUrlToOpen("https://vscodethemes.com.example.test/?q=x") === undefined &&
      api.externalUrlToOpen("https://notvscodethemes.com/?q=x") === undefined,
    String(api.externalUrlToOpen("https://vscodethemes.com.example.test/?q=x")),
  );
  check(
    "another scheme, another host and junk are refused",
    api.externalUrlToOpen("http://vscodethemes.com/?q=x") === undefined &&
      api.externalUrlToOpen("javascript:alert(1)") === undefined &&
      api.externalUrlToOpen("data:text/html,<b>x</b>") === undefined &&
      api.externalUrlToOpen("file:///etc/passwd") === undefined &&
      api.externalUrlToOpen("") === undefined &&
      api.externalUrlToOpen("not a url") === undefined,
    JSON.stringify([
      api.externalUrlToOpen("javascript:alert(1)"),
      api.externalUrlToOpen("file:///etc/passwd"),
    ]),
  );
  check(
    "the rule is the only way to reach the editor's openExternal",
    (source("theme-view.ts").match(/openExternal\(/g) ?? []).length === 1 &&
      /externalUrlToOpen\(url\)[\s\S]{0,200}openExternal\(/.test(source("theme-view.ts")),
    "openExternal is reachable without the allow-list",
  );

  /* --- the registry base of the running tree -------------------------------- */

  const appRoot = tempDir("picode-theme-app-");
  const extensionDir = path.join(appRoot, "resources", "app", "extensions", "picode-pi-chat");
  fs.mkdirSync(extensionDir, { recursive: true });
  const extensionUri = { fsPath: extensionDir };
  const writeProduct = (value) => {
    fs.writeFileSync(
      path.join(appRoot, "resources", "app", "product.json"),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  writeProduct({
    extensionsGallery: { serviceUrl: "https://open-vsx.org/vscode/gallery" },
  });
  check(
    "the registry base is read from the product this extension ships in",
    api.registryBaseFor(extensionUri) === "https://open-vsx.org/api",
    api.registryBaseFor(extensionUri),
  );
  writeProduct({ extensionsGallery: { serviceUrl: "https://gallery.example.test/gallery" } });
  check(
    "a product pointed at another gallery browses that host's registry",
    api.registryBaseFor(extensionUri) === "https://gallery.example.test/api",
    api.registryBaseFor(extensionUri),
  );
  writeProduct("{ not json");
  check(
    "a product that cannot be read falls back to the gallery PiCode ships",
    api.registryBaseFor(extensionUri) === "https://open-vsx.org/api",
    api.registryBaseFor(extensionUri),
  );
  fs.rmSync(path.join(appRoot, "resources", "app", "product.json"));
  check(
    "a development tree with no product of its own still has a gallery",
    api.registryBaseFor(extensionUri) === "https://open-vsx.org/api",
    api.registryBaseFor(extensionUri),
  );

  /* --- what the owner reads after applying ---------------------------------- */

  const row = {
    id: "dracula-theme.theme-dracula",
    displayName: "Dracula",
    description: "",
    downloads: 0,
    version: "2.25.1",
    installed: false,
    galleryUrl: "https://vscodethemes.com/?q=Dracula",
    themes: [{ id: "Dracula Theme", label: "Dracula Theme", path: "./theme/dracula.json" }],
  };
  const applied = api.appliedMessage(row, "Dracula Theme", {
    applied: true,
    installed: false,
    needsReload: false,
  });
  const installed = api.appliedMessage(row, "Dracula Theme", {
    applied: true,
    installed: true,
    needsReload: false,
  });
  const needsReload = api.appliedMessage(row, "Dracula Theme", {
    applied: true,
    installed: true,
    needsReload: true,
  });
  check(
    "the ending names the theme by its label, and says whether it had to be installed",
    applied === "Tema «Dracula Theme» aplicado." &&
      installed === "Tema «Dracula Theme» instalado y aplicado.",
    `${applied} / ${installed}`,
  );
  check(
    "the reload is named only when it changes something",
    needsReload.includes("Recargar la ventana") &&
      !applied.includes("Recargar la ventana") &&
      !installed.includes("Recargar la ventana"),
    needsReload,
  );
  check(
    "no ending prints a path",
    [applied, installed, needsReload].every((line) => !line.includes("/") && !line.includes("\\")),
    JSON.stringify([applied, installed, needsReload]),
  );
  check(
    "a theme whose id is not in the row still gets an ending",
    api.appliedMessage(row, "otro", { applied: true, installed: false, needsReload: false }).includes(
      "otro",
    ),
    api.appliedMessage(row, "otro", { applied: true, installed: false, needsReload: false }),
  );

  /* --- the surface's own shape ---------------------------------------------- */

  const viewSource = source("theme-view.ts");
  check(
    "the panel reuses the one document builder, so the CSP and the nonce exist once",
    viewSource.includes("buildWebviewHtml({") &&
      viewSource.includes('scripts: ["theme-gallery.js", "theme.js"]') &&
      viewSource.includes("styles: [") &&
      !viewSource.includes("Content-Security-Policy"),
    "the panel builds its own document",
  );
  check(
    "the gallery component is loaded before the script that mounts it",
    viewSource.indexOf("theme-gallery.js") < viewSource.indexOf('"theme.js"'),
    "the component is not loaded first",
  );
  const media = fs.readdirSync(path.join(EXTENSION_ROOT, "media"));
  check(
    "the files the panel declares are the ones that ship in media/",
    ["theme-gallery.js", "theme.js", "theme.css", "main.css", "codicon.css"].every((name) =>
      media.includes(name),
    ),
    JSON.stringify(media.filter((name) => name.startsWith("theme"))),
  );
  check(
    "the markup the panel draws holds the element the bootstrap mounts into",
    /THEME_BODY = `[\s\S]*id="theme-root"/.test(viewSource) &&
      mediaFile("theme.js").includes('getElementById("theme-root")'),
    "the body and the bootstrap disagree about the root element",
  );

  const extensionSource = source("extension.ts");
  check(
    "extension.ts registers the command id it imports, and feeds the Aspecto row",
    extensionSource.includes("SELECT_THEME_COMMAND") &&
      /registerCommand\(SELECT_THEME_COMMAND/.test(extensionSource) &&
      /setThemeStateSource\(\(\) => currentColorTheme\(\)\)/.test(extensionSource) &&
      /getConfiguration\("workbench"\)\.get<string>\("colorTheme"\)/.test(extensionSource),
    "the command or the reading is missing from the activation",
  );
  const settingsSource = source("pi-settings.ts");
  check(
    "the Aspecto category exists, with the reading and the command of its own",
    /id: "aspecto"/.test(settingsSource) &&
      /key: "picode\.colorTheme"/.test(settingsSource) &&
      /key: "picode\.selectTheme"/.test(settingsSource) &&
      /command: "picode\.piChat\.selectTheme"/.test(settingsSource) &&
      settingsSource.includes("setThemeStateSource"),
    "the settings catalogue has no Aspecto row",
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, "package.json"), "utf8"));
  const declared = (manifest.contributes.commands ?? []).find(
    (entry) => entry.command === api.SELECT_THEME_COMMAND,
  );
  check(
    "the command is declared in the manifest with a Spanish title",
    api.SELECT_THEME_COMMAND === "picode.piChat.selectTheme" &&
      declared !== undefined &&
      /^PiCode: /.test(declared.title),
    JSON.stringify(declared),
  );
  check(
    "the suite is registered in the test chain",
    String(manifest.scripts.test).includes("node test/theme-view.test.js"),
    manifest.scripts.test,
  );

  console.log("--- lo que se lee al aplicar ---");
  for (const line of [applied, installed, needsReload]) {
    console.log(line);
  }
  console.log("---");

  for (const temporary of cleanups) {
    fs.rmSync(temporary, { recursive: true, force: true });
  }

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
    failed === 0 ? `\nALL ${results.length} CHECKS PASS` : `\n${failed} of ${results.length} CHECKS FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("harness error:", error);
  process.exit(2);
});
