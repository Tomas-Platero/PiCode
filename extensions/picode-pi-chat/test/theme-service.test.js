/*
 * Exercises the theme service: the rows, the preview and the apply-and-maybe-reload decision.
 *
 * The service is where the feature meets the editor, so what is asserted here is exactly the
 * part that would otherwise only be checked by clicking: that an installed theme is read
 * without a single network request, that a catalogue row is marked when the editor already
 * has it, and that the reload is offered **only** in the one case where it changes something
 * — a theme that had to be installed and that the editor does not know yet.
 *
 * Everything the editor owns is injected, so no `vscode` stub is installed and no real
 * profile is touched: the installed extensions are plain objects, the configuration is a
 * fake that records what it was asked to write, and `install` is a counter. The theme files
 * themselves live in a throwaway directory under `os.tmpdir()`.
 *
 * Run with: npm test
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const EXTENSION_ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = path.join(EXTENSION_ROOT, "src");

/** An installed extension the editor would report, with one theme in it. */
function installedExtension(id, dir, themes, extra = {}) {
  return {
    id,
    extensionPath: dir,
    packageJSON: {
      name: id.split(".")[1],
      displayName: extra.displayName ?? id,
      description: extra.description ?? "",
      version: extra.version ?? "1.0.0",
      contributes: { themes },
      ...(extra.packageJson ?? {}),
    },
  };
}

/** A configuration fake that records the write. */
function fakeConfiguration(initial) {
  const state = { current: initial, writes: [] };
  return {
    state,
    current: () => state.current,
    apply: async (themeId) => {
      state.writes.push(themeId);
      state.current = themeId;
    },
  };
}

async function main() {
  const compiled = path.join(EXTENSION_ROOT, "out", "theme-service.js");
  if (!fs.existsSync(compiled)) {
    console.error(`Missing ${compiled}. Run "npm run compile" first.`);
    process.exit(2);
  }
  const loaded = await import(pathToFileURL(compiled).href);
  const api = loaded.createThemeService ? loaded : loaded.default;

  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });
  const cleanups = [];
  const tempDir = (prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(dir);
    return dir;
  };

  /* --- what the product says ------------------------------------------------ */

  check(
    "the registry base comes from the product's own gallery, and falls back to Open VSX",
    api.registryBaseFrom({ extensionsGallery: { serviceUrl: "https://open-vsx.org/vscode/gallery" } }) ===
      "https://open-vsx.org/api" &&
      api.registryBaseFrom({ extensionsGallery: { serviceUrl: "https://gallery.example.test/gallery" } }) ===
        "https://gallery.example.test/api" &&
      api.registryBaseFrom({}) === "https://open-vsx.org/api" &&
      api.registryBaseFrom(null) === "https://open-vsx.org/api" &&
      api.registryBaseFrom({ extensionsGallery: { serviceUrl: "not a url" } }) ===
        "https://open-vsx.org/api",
    JSON.stringify([
      api.registryBaseFrom({ extensionsGallery: { serviceUrl: "https://open-vsx.org/vscode/gallery" } }),
      api.registryBaseFrom({}),
    ]),
  );
  check(
    "the site's link is a search for the theme's name, encoded",
    api.vscodethemesUrl("One Dark Pro") === "https://vscodethemes.com/?q=One%20Dark%20Pro" &&
      api.vscodethemesUrl("a&b") === "https://vscodethemes.com/?q=a%26b",
    api.vscodethemesUrl("One Dark Pro"),
  );

  /* --- the rows ------------------------------------------------------------- */

  const draculaDir = tempDir("picode-theme-row-");
  fs.mkdirSync(path.join(draculaDir, "themes"), { recursive: true });
  fs.writeFileSync(
    path.join(draculaDir, "themes", "dracula.json"),
    JSON.stringify({
      name: "Dracula",
      type: "dark",
      colors: { "editor.background": "#282a36", "editor.foreground": "#f8f8f2" },
      tokenColors: [{ scope: "comment", settings: { foreground: "#6272a4", fontStyle: "italic" } }],
    }),
  );
  const dracula = installedExtension(
    "dracula-theme.theme-dracula",
    draculaDir,
    [{ id: "Dracula Theme", label: "Dracula Theme", uiTheme: "vs-dark", path: "./themes/dracula.json" }],
    { displayName: "Dracula Theme Official", description: "A dark theme", version: "2.25.1" },
  );
  const builtIn = installedExtension(
    "vscode.theme-defaults",
    tempDir("picode-theme-builtin-"),
    [{ id: "Default Dark Modern", label: "Default Dark Modern", uiTheme: "vs-dark", path: "./themes/dark.json" }],
  );
  const noThemes = installedExtension("ms-vscode.powershell", tempDir("picode-theme-ps-"), [], {
    displayName: "PowerShell",
  });

  const rows = api.installedThemeRows([builtIn, noThemes, dracula]);
  check(
    "only the extensions that declare a theme become rows, in the editor's own order",
    rows.length === 2 &&
      rows[0].id === "vscode.theme-defaults" &&
      rows[1].id === "dracula-theme.theme-dracula",
    JSON.stringify(rows.map((row) => row.id)),
  );
  check(
    "a row carries what the gallery shows and knows it is installed",
    rows[1].displayName === "Dracula Theme Official" &&
      rows[1].description === "A dark theme" &&
      rows[1].version === "2.25.1" &&
      rows[1].installed === true &&
      rows[1].themes.length === 1 &&
      rows[1].themes[0].path === "./themes/dracula.json" &&
      rows[1].galleryUrl.startsWith("https://vscodethemes.com/?q="),
    JSON.stringify(rows[1]),
  );
  check(
    "a row for a catalogue entry is marked by whether the editor already has it",
    (() => {
      const candidate = {
        id: "catppuccin.catppuccin-vsc",
        displayName: "Catppuccin",
        description: "Soothing pastel theme",
        downloads: 1234,
        version: "3.0.0",
        iconUrl: "https://icon/x.png",
        downloadUrl: "https://vsix/x.vsix",
        declared: [{ id: "Catppuccin Mocha", label: "Catppuccin Mocha", path: "./themes/mocha.json" }],
      };
      const fresh = api.catalogueThemeRow(candidate, false);
      const have = api.catalogueThemeRow(candidate, true);
      return (
        fresh.installed === false &&
        have.installed === true &&
        fresh.iconUrl === "https://icon/x.png" &&
        fresh.downloadUrl === "https://vsix/x.vsix" &&
        fresh.downloads === 1234 &&
        fresh.themes[0].id === "Catppuccin Mocha"
      );
    })(),
    "a catalogue row was not marked as expected",
  );

  /* --- the service ---------------------------------------------------------- */

  const neverFetches = async () => {
    throw new Error("the service should not have touched the network");
  };
  const service = api.createThemeService({
    installedExtensions: () => [builtIn, noThemes, dracula],
    configuration: () => {
      throw new Error("not asked");
    },
    install: async () => {
      throw new Error("not asked");
    },
    registryBase: "https://open-vsx.org/api",
    fetchLike: neverFetches,
  });
  check(
    "the installed rows are answered with no network at all",
    service.installed().length === 2,
    JSON.stringify(service.installed().map((row) => row.id)),
  );

  const cacheDir = tempDir("picode-theme-svc-cache-");
  const searchUrl =
    "https://open-vsx.org/api/-/search?category=themes&sortBy=downloadCount&sortOrder=desc&size=40";
  const catalogService = api.createThemeService({
    installedExtensions: () => [dracula],
    configuration: () => fakeConfiguration(undefined),
    install: async () => undefined,
    registryBase: "https://open-vsx.org/api",
    cacheDir,
    fetchLike: async (url) => {
      if (String(url) === searchUrl) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            extensions: [
              {
                namespace: "dracula-theme",
                name: "theme-dracula",
                displayName: "Dracula Theme Official",
                downloadCount: 900000,
                version: "2.25.1",
                files: { manifest: "https://manifest/dracula", download: "https://vsix/dracula" },
              },
              {
                namespace: "catppuccin",
                name: "catppuccin-vsc",
                displayName: "Catppuccin",
                downloadCount: 500000,
                version: "3.0.0",
                files: { manifest: "https://manifest/catppuccin", download: "https://vsix/catppuccin" },
              },
            ],
          }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      const themes =
        String(url) === "https://manifest/dracula"
          ? [{ id: "Dracula Theme", label: "Dracula Theme", path: "./themes/dracula.json" }]
          : [{ id: "Catppuccin Mocha", label: "Catppuccin Mocha", path: "./themes/mocha.json" }];
      return { ok: true, status: 200, json: async () => ({ contributes: { themes } }), arrayBuffer: async () => new ArrayBuffer(0) };
    },
  });
  const catalog = await catalogService.catalog("");
  check(
    "the catalogue marks what the editor already has",
    catalog.length === 2 &&
      catalog.find((row) => row.id === "dracula-theme.theme-dracula").installed === true &&
      catalog.find((row) => row.id === "catppuccin.catppuccin-vsc").installed === false,
    JSON.stringify(catalog.map((row) => `${row.id}=${row.installed}`)),
  );

  /* --- the preview ---------------------------------------------------------- */

  const preview = await service.preview(rows[1], "Dracula Theme");
  check(
    "an installed theme is painted from its own file",
    preview.ok === true &&
      preview.variant.id === "Dracula Theme" &&
      preview.variant.uiTheme === "vs-dark" &&
      preview.preview.dark === true &&
      preview.preview.frame.editorBackground === "#282a36" &&
      preview.preview.lines[0][0].color === "#6272a4" &&
      preview.preview.lines[0][0].italic === true,
    JSON.stringify(preview.ok ? preview.preview.frame : preview),
  );
  const unreadable = await service.preview(
    { ...rows[1], id: "ghost.theme", installed: false, themes: rows[1].themes },
    "Dracula Theme",
  );
  check(
    "a theme that cannot be read answers with a reason that names it and prints no path",
    unreadable.ok === false &&
      unreadable.reason.includes("Dracula Theme") &&
      !unreadable.reason.includes("/") &&
      !unreadable.reason.includes("\\\\"),
    JSON.stringify(unreadable),
  );

  /* --- applying ------------------------------------------------------------- */

  const installedConfig = fakeConfiguration("Default Dark Modern");
  const installedService = api.createThemeService({
    installedExtensions: () => [dracula],
    configuration: () => installedConfig,
    install: async () => {
      throw new Error("an installed theme must not be installed again");
    },
    registryBase: "https://open-vsx.org/api",
  });
  const appliedInstalled = await installedService.apply(rows[1], "Dracula Theme");
  check(
    "applying a theme the editor has is one write and no reload",
    appliedInstalled.applied === true &&
      appliedInstalled.installed === false &&
      appliedInstalled.needsReload === false &&
      appliedInstalled.current === "Dracula Theme" &&
      installedConfig.state.writes.join(",") === "Dracula Theme",
    JSON.stringify([appliedInstalled, installedConfig.state.writes]),
  );

  const installedNow = [];
  const freshConfig = fakeConfiguration(undefined);
  const installingService = api.createThemeService({
    installedExtensions: () => [...installedNow],
    configuration: () => freshConfig,
    install: async (extensionId) => {
      installedNow.push(
        installedExtension(extensionId, tempDir("picode-theme-fresh-"), [
          { id: "Catppuccin Mocha", label: "Catppuccin Mocha", path: "./themes/mocha.json" },
        ]),
      );
    },
    registryBase: "https://open-vsx.org/api",
  });
  const catalogueRow = api.catalogueThemeRow(
    {
      id: "catppuccin.catppuccin-vsc",
      displayName: "Catppuccin",
      description: "",
      downloads: 1,
      version: "3.0.0",
      declared: [{ id: "Catppuccin Mocha", label: "Catppuccin Mocha", path: "./themes/mocha.json" }],
    },
    false,
  );
  const appliedFresh = await installingService.apply(catalogueRow, "Catppuccin Mocha");
  check(
    "applying a theme that is not installed installs it first, then writes the setting",
    appliedFresh.applied === true &&
      appliedFresh.installed === true &&
      freshConfig.state.writes.join(",") === "Catppuccin Mocha" &&
      installedNow.length === 1 &&
      installedNow[0].id === "catppuccin.catppuccin-vsc",
    JSON.stringify([appliedFresh, freshConfig.state.writes, installedNow.map((e) => e.id)]),
  );
  check(
    "and it needs no reload when the installed extension declares the theme it just applied",
    appliedFresh.needsReload === false,
    JSON.stringify(appliedFresh),
  );

  const deafConfig = fakeConfiguration(undefined);
  const deafService = api.createThemeService({
    installedExtensions: () => [],
    configuration: () => deafConfig,
    // An install that does not show up in the editor's list: the theme registry is behind.
    install: async () => undefined,
    registryBase: "https://open-vsx.org/api",
  });
  const appliedDeaf = await deafService.apply(catalogueRow, "Catppuccin Mocha");
  check(
    "a theme the editor does not know after installing is the one case that asks for a reload",
    appliedDeaf.applied === true &&
      appliedDeaf.installed === true &&
      appliedDeaf.needsReload === true &&
      deafConfig.state.writes.join(",") === "Catppuccin Mocha",
    JSON.stringify(appliedDeaf),
  );
  check(
    "a row with no theme at all does nothing, and installs nothing",
    (await deafService.apply({ ...catalogueRow, themes: [] }, "nope")).applied === false &&
      deafConfig.state.writes.length === 1,
    JSON.stringify(deafConfig.state.writes),
  );
  check(
    "the service reports the theme in force",
    installedService.current() === "Dracula Theme" &&
      api.createThemeService({
        installedExtensions: () => [],
        configuration: () => fakeConfiguration(undefined),
        install: async () => undefined,
        registryBase: "https://open-vsx.org/api",
      }).current() === undefined,
    String(installedService.current()),
  );

  /* --- the guard at the source ---------------------------------------------- */

  const source = fs.readFileSync(path.join(SOURCE_ROOT, "theme-service.ts"), "utf8");
  check(
    "the service's decisions import no editor module: the editor arrives as parameters",
    !/from\s+["']vscode["']/.test(source) && !/require\(\s*["']vscode["']\s*\)/.test(source),
    "an editor import was found in the module",
  );

  console.log("--- las filas instaladas, tal cual ---");
  for (const row of rows) {
    console.log(
      `${row.installed ? "[instalado]" : "[catálogo]"} ${row.id} · ${row.displayName} · ` +
        row.themes.map((theme) => `${theme.label} (${theme.uiTheme ?? "sin uiTheme"})`).join(" / "),
    );
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
