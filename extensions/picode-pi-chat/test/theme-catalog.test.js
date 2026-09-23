/*
 * Exercises the theme catalogue and the ZIP reader it owns, without a network.
 *
 * Three things here are asserted because they are the reasons the module exists at all, and
 * each one has a failure that is invisible in review:
 *
 * - **the ZIP reader, against a ZIP this test builds byte by byte.** The registry does not
 *   serve a theme's own file (only the whitelisted artifacts), so a theme that is not
 *   installed has to be read out of the VSIX. Building the archive in the test — local
 *   headers, central directory, end record, CRC32 — is what makes "it reads a real ZIP"
 *   a checked fact instead of a hope, and it is the only way to prove the two compression
 *   methods and the truncation cases;
 * - **the manifest is the filter**, because the registry's `category=themes` returns
 *   PowerShell: an extension that declares no theme must not reach the picker, and a
 *   manifest that fails to load must be dropped rather than empty the gallery;
 * - **the `include` chain is resolved**, because real themes are written as a delta over
 *   another file, and a preview of an unresolved chain would show an almost empty theme.
 *
 * `fetch` is injected everywhere, so this suite never touches the network; the real file
 * I/O runs under `os.tmpdir()`.
 *
 * Run with: npm test
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { pathToFileURL } = require("node:url");

const EXTENSION_ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = path.join(EXTENSION_ROOT, "src");

/* --- a ZIP, built by hand -------------------------------------------------- */

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A ZIP with the given entries: `[name, text, method]`.
 *
 * Deliberately hand-written rather than produced by a library: the reader under test has to
 * work on what a real VSIX looks like — `extension/` prefixed names, deflated and stored
 * entries, sizes only in the central directory — so the fixture is the specification.
 */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, text, method = 8] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.from(text, "utf8");
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    // A streaming writer leaves the local sizes at zero; the reader must not trust them.
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuffer, end]);
}

/** A `fetch` that answers from a table and counts what it was asked for. */
function fakeFetch(table, options = {}) {
  const calls = [];
  const state = { inFlight: 0, peak: 0 };
  const fetchLike = async (url) => {
    calls.push(String(url));
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    try {
      if (options.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      const answer = table[String(url)];
      if (answer === undefined) {
        return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
      }
      if (typeof answer === "function") {
        return answer(url, calls.filter((call) => call === String(url)).length);
      }
      // Two shapes are accepted: a JSON body, which the fake wraps in a response, and a
      // response itself, for the endpoints that answer with bytes rather than JSON.
      if (
        typeof answer === "object" &&
        answer !== null &&
        (typeof answer.json === "function" || typeof answer.arrayBuffer === "function")
      ) {
        return answer;
      }
      return {
        ok: true,
        status: 200,
        json: async () => answer,
        arrayBuffer: async () => answer,
      };
    } finally {
      state.inFlight -= 1;
    }
  };
  fetchLike.calls = calls;
  fetchLike.state = state;
  return fetchLike;
}

async function main() {
  const compiled = path.join(EXTENSION_ROOT, "out", "theme-catalog.js");
  if (!fs.existsSync(compiled)) {
    console.error(`Missing ${compiled}. Run "npm run compile" first.`);
    process.exit(2);
  }
  const loaded = await import(pathToFileURL(compiled).href);
  const api = loaded.searchThemes ? loaded : loaded.default;

  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });
  const cleanups = [];
  const tempDir = (prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(dir);
    return dir;
  };

  /* --- the registry base ---------------------------------------------------- */

  check(
    "the gallery's own service URL maps to its registry API",
    api.registryApiBase("https://open-vsx.org/vscode/gallery") === "https://open-vsx.org/api" &&
      api.registryApiBase("https://open-vsx.org/vscode/gallery/") === "https://open-vsx.org/api" &&
      api.registryApiBase("https://open-vsx.org/gallery") === "https://open-vsx.org/api" &&
      api.registryApiBase("https://open-vsx.org/vscode") === "https://open-vsx.org/api" &&
      api.registryApiBase("https://example.test") === "https://example.test/api",
    JSON.stringify([
      api.registryApiBase("https://open-vsx.org/vscode/gallery"),
      api.registryApiBase("https://example.test"),
    ]),
  );
  check(
    "something that is not a URL is refused instead of guessed at",
    api.registryApiBase("") === undefined &&
      api.registryApiBase("   ") === undefined &&
      api.registryApiBase("not a url") === undefined &&
      api.registryApiBase("open-vsx.org/api") === undefined,
    JSON.stringify([api.registryApiBase(""), api.registryApiBase("not a url")]),
  );
  check(
    "the default registry is Open VSX, the gallery PiCode ships",
    api.DEFAULT_REGISTRY_BASE === "https://open-vsx.org/api",
    api.DEFAULT_REGISTRY_BASE,
  );

  /* --- what a manifest declares --------------------------------------------- */

  const manifest = {
    name: "theme-dracula",
    contributes: {
      themes: [
        { label: "Dracula Theme", uiTheme: "vs-dark", path: "./theme/dracula.json" },
        { id: "soft", label: "Dracula Soft", uiTheme: "vs-dark", path: "./theme/soft.json" },
        { label: "no path" },
        { path: "./theme/no-label.json" },
        null,
        "junk",
      ],
    },
  };
  const declared = api.declaredThemes(manifest);
  check(
    "each declared theme becomes an id, a label and a path, in order",
    declared.length === 2 &&
      declared[0].id === "Dracula Theme" &&
      declared[0].label === "Dracula Theme" &&
      declared[0].uiTheme === "vs-dark" &&
      declared[0].path === "./theme/dracula.json" &&
      declared[1].id === "soft" &&
      declared[1].label === "Dracula Soft",
    JSON.stringify(declared),
  );
  check(
    "the manifest's own id wins over the label, and junk is skipped",
    !declared.some((theme) => theme.label === "no path") &&
      !declared.some((theme) => theme.label === "no-label"),
    JSON.stringify(declared.map((theme) => theme.label)),
  );
  check(
    "a manifest that declares nothing usable yields nothing",
    api.declaredThemes({}).length === 0 &&
      api.declaredThemes({ contributes: {} }).length === 0 &&
      api.declaredThemes({ contributes: { themes: "x" } }).length === 0 &&
      api.declaredThemes(null).length === 0 &&
      api.declaredThemes("nope").length === 0,
    JSON.stringify([api.declaredThemes({}).length, api.declaredThemes(null).length]),
  );

  /* --- the ZIP reader ------------------------------------------------------- */

  const zip = buildZip([
    ["extension/theme/child.json", '{"name":"child"}', 8],
    ["extension/theme/stored.json", '{"name":"stored"}', 0],
    ["extension/package.json", '{"name":"x"}', 8],
  ]);
  const archive = api.openVsix(zip);
  check(
    "the archive lists its entries",
    archive.entries.length === 3 && archive.entries.includes("extension/theme/child.json"),
    JSON.stringify(archive.entries),
  );
  check(
    "a deflated entry is inflated back to its text",
    archive.read("extension/theme/child.json").toString("utf8") === '{"name":"child"}',
    String(archive.read("extension/theme/child.json")),
  );
  check(
    "a stored entry is read as it is",
    archive.read("extension/theme/stored.json").toString("utf8") === '{"name":"stored"}',
    String(archive.read("extension/theme/stored.json")),
  );
  check(
    "a leading ./ is normalised, and an entry that is not there is undefined",
    archive.read("./extension/package.json").toString("utf8") === '{"name":"x"}' &&
      archive.read("extension/nope.json") === undefined,
    String(archive.read("extension/nope.json")),
  );
  check(
    "a buffer that is not a ZIP throws instead of returning nothing",
    (() => {
      try {
        api.openVsix(Buffer.from("not a zip at all"));
        return false;
      } catch (error) {
        return /ZIP/i.test(String(error.message));
      }
    })(),
    "a bogus buffer was accepted",
  );
  check(
    "a truncated archive throws instead of returning a fragment",
    (() => {
      try {
        api.openVsix(zip.subarray(0, zip.length - 40));
        return false;
      } catch (error) {
        return /ZIP/i.test(String(error.message));
      }
    })(),
    "a truncated buffer was accepted",
  );
  check(
    "an unsupported compression method throws rather than returning garbage",
    (() => {
      const exotic = buildZip([["extension/theme/x.json", '{"name":"x"}', 8]]);
      // Method 12 (bzip2) is not one a VSIX may use, and the reader must say so.
      exotic.writeUInt16LE(12, 8);
      // The central directory's copy decides, so patch that one too.
      const central = exotic.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      exotic.writeUInt16LE(12, central + 10);
      try {
        api.openVsix(exotic).read("extension/theme/x.json");
        return false;
      } catch (error) {
        return /compression/i.test(String(error.message));
      }
    })(),
    "an exotic method was accepted",
  );

  /* --- reading theme files -------------------------------------------------- */

  const files = api.vsixFiles(archive);
  check(
    "a manifest path resolves inside the archive's extension/ prefix",
    files.read("theme/child.json") === '{"name":"child"}' &&
      files.read("./theme/child.json") === '{"name":"child"}' &&
      files.read("theme/nope.json") === undefined,
    String(files.read("theme/child.json")),
  );

  const installedRoot = tempDir("picode-theme-installed-");
  fs.mkdirSync(path.join(installedRoot, "themes"), { recursive: true });
  fs.writeFileSync(
    path.join(installedRoot, "themes", "x.json"),
    JSON.stringify({ name: "X", colors: { "editor.background": "#010203" } }),
  );
  fs.writeFileSync(path.join(installedRoot, "secret.json"), '{"name":"secret"}');
  const onDisk = api.installedFiles(installedRoot);
  check(
    "an installed extension is read from disk, relative to its own root",
    onDisk.read("themes/x.json").includes("#010203"),
    String(onDisk.read("themes/x.json")),
  );
  check(
    "a path that walks out of the extension is refused",
    api.installedFiles(path.join(installedRoot, "themes")).read("../secret.json") === undefined &&
      onDisk.read("../../secret.json") === undefined,
    String(api.installedFiles(path.join(installedRoot, "themes")).read("../secret.json")),
  );
  check(
    "a file that is not there reads as absent rather than throwing",
    onDisk.read("themes/none.json") === undefined,
    String(onDisk.read("themes/none.json")),
  );

  /* --- the include chain ---------------------------------------------------- */

  const chainReader = (entries) => ({
    read: (themePath) => entries[themePath.replace(/^\.\//, "")],
  });
  const childTheme = JSON.stringify({
    name: "Child",
    type: "dark",
    include: "./base.json",
    colors: { "editor.background": "#111111", "sideBar.background": "#222222" },
    tokenColors: [{ scope: "comment", settings: { foreground: "#aaaaaa" } }],
  });
  const baseTheme = JSON.stringify({
    name: "Base",
    colors: { "editor.background": "#000000", "editor.foreground": "#eeeeee" },
    tokenColors: [{ scope: "keyword", settings: { foreground: "#ff0000" } }],
  });
  const resolved = api.resolveThemeChain(
    chainReader({ "theme/child.json": childTheme, "theme/base.json": baseTheme }),
    "theme/child.json",
  );
  check(
    "the chain's colours merge with the child winning per key",
    resolved.colors["editor.background"] === "#111111" &&
      resolved.colors["sideBar.background"] === "#222222" &&
      resolved.colors["editor.foreground"] === "#eeeeee",
    JSON.stringify(resolved.colors),
  );
  check(
    "the token rules arrive base first, so a child's rule wins a tie",
    resolved.tokenColors.length === 2 &&
      resolved.tokenColors[0].scope === "keyword" &&
      resolved.tokenColors[1].scope === "comment",
    JSON.stringify(resolved.tokenColors),
  );
  check(
    "the resolved theme keeps the child's own name and type, and drops the resolved include",
    resolved.name === "Child" && resolved.type === "dark" && resolved.include === undefined,
    JSON.stringify({ name: resolved.name, type: resolved.type, include: resolved.include }),
  );

  check(
    "a theme with no include comes back as it is",
    (() => {
      const alone = api.resolveThemeChain(
        chainReader({ "t.json": JSON.stringify({ name: "Alone", colors: { a: "#000000" } }) }),
        "t.json",
      );
      return alone.name === "Alone" && alone.colors.a === "#000000";
    })(),
    "a lone theme was not resolved",
  );
  check(
    "an include the editor owns ('vscode') is not followed, and the theme's own colours survive",
    (() => {
      const preset = api.resolveThemeChain(
        chainReader({ "t.json": JSON.stringify({ include: "vscode", colors: { a: "#123456" } }) }),
        "t.json",
      );
      return preset.colors.a === "#123456" && preset.include === undefined;
    })(),
    "the vscode preset was treated as a file",
  );
  check(
    "a missing base is not fatal: the theme previews with what it has",
    (() => {
      const broken = api.resolveThemeChain(
        chainReader({ "t.json": JSON.stringify({ include: "./nope.json", colors: { a: "#654321" } }) }),
        "t.json",
      );
      return broken.colors.a === "#654321";
    })(),
    "a missing base broke the theme",
  );
  check(
    "a cycle terminates instead of spinning",
    (() => {
      const cyclic = api.resolveThemeChain(
        chainReader({
          "a.json": JSON.stringify({ include: "./b.json", colors: { a: "#000001" } }),
          "b.json": JSON.stringify({ include: "./a.json", colors: { b: "#000002" } }),
        }),
        "a.json",
      );
      return cyclic.colors.a === "#000001" && cyclic.colors.b === "#000002";
    })(),
    "a cyclic chain did not terminate",
  );
  check(
    "a chain deeper than the cap stops at the cap",
    (() => {
      const entries = {};
      for (let index = 0; index < 8; index += 1) {
        entries[`l${index}.json`] = JSON.stringify({
          include: `./l${index + 1}.json`,
          colors: { [`key${index}`]: "#000000" },
        });
      }
      entries["l8.json"] = JSON.stringify({ colors: { deepest: "#ffffff" } });
      const deep = api.resolveThemeChain(chainReader(entries), "l0.json");
      return deep.colors.deepest === undefined && deep.colors.key0 === "#000000";
    })(),
    "the depth cap did not stop the chain",
  );
  const sharedRelative = (() => {
    const shared = api.resolveThemeChain(
      chainReader({
        "themes/child.json": JSON.stringify({ include: "../shared/base.json" }),
        "shared/base.json": JSON.stringify({ colors: { shared: "#abcdef" } }),
      }),
      "themes/child.json",
    );
    return shared.colors.shared;
  })();
  check(
    "a relative include that climbs one directory is followed",
    sharedRelative === "#abcdef",
    String(sharedRelative),
  );

  /* --- the search ----------------------------------------------------------- */

  const searchUrl =
    "https://open-vsx.org/api/-/search?category=themes&sortBy=downloadCount&sortOrder=desc&size=40";
  const rows = {
    extensions: [
      {
        namespace: "dracula-theme",
        name: "theme-dracula",
        displayName: "Dracula",
        description: "The official Dracula Theme",
        downloadCount: 900000,
        version: "2.25.1",
        files: {
          icon: "https://icon/dracula.png",
          download: "https://vsix/dracula.vsix",
          manifest: "https://manifest/dracula",
        },
      },
      {
        namespace: "ms-vscode",
        name: "powershell",
        displayName: "PowerShell",
        downloadCount: 2429765,
        version: "2025.4.0",
        files: { manifest: "https://manifest/powershell" },
      },
      { namespace: "gone", name: "deprecated", deprecated: true, files: { manifest: "https://manifest/gone" } },
      { namespace: "no", name: "manifest", files: {} },
    ],
  };
  const draculaManifest = {
    name: "theme-dracula",
    contributes: {
      themes: [{ label: "Dracula Theme", uiTheme: "vs-dark", path: "./theme/dracula.json" }],
    },
  };
  const table = {
    [searchUrl]: rows,
    "https://manifest/dracula": draculaManifest,
    "https://manifest/powershell": { name: "powershell", contributes: {} },
  };
  const fetchLike = fakeFetch(table);
  const found = await api.searchThemes({ limit: 20, fetchLike });
  check(
    "the loose category results are filtered by the manifest, so PowerShell is not a theme",
    found.length === 1 && found[0].id === "dracula-theme.theme-dracula",
    JSON.stringify(found.map((candidate) => candidate.id)),
  );
  check(
    "a candidate carries what the gallery row shows",
    found[0].displayName === "Dracula" &&
      found[0].description === "The official Dracula Theme" &&
      found[0].downloads === 900000 &&
      found[0].version === "2.25.1" &&
      found[0].iconUrl === "https://icon/dracula.png" &&
      found[0].declared.length === 1 &&
      found[0].declared[0].path === "./theme/dracula.json",
    JSON.stringify(found[0]),
  );
  check(
    "a deprecated extension is not offered, and one with no manifest is skipped",
    !found.some((candidate) => candidate.id.startsWith("gone.")) &&
      !found.some((candidate) => candidate.id === "no.manifest"),
    JSON.stringify(found.map((candidate) => candidate.id)),
  );

  // The cache: the same query answers without touching the registry again.
  const before = fetchLike.calls.length;
  const again = await api.searchThemes({ limit: 20, fetchLike });
  check(
    "a second search for the same query is answered from the cache",
    fetchLike.calls.length === before && again.length === found.length,
    `${before} → ${fetchLike.calls.length}`,
  );
  api.clearThemeSearchCache();
  const afterClear = fetchLike.calls.length;
  await api.searchThemes({ limit: 20, fetchLike });
  check(
    "forgetting the cache makes it ask again",
    fetchLike.calls.length > afterClear,
    `${afterClear} → ${fetchLike.calls.length}`,
  );

  const slow = fakeFetch(table, { delayMs: 15 });
  api.clearThemeSearchCache();
  await api.searchThemes({ limit: 20, concurrency: 2, fetchLike: slow });
  check(
    "the manifest requests respect the concurrency cap",
    slow.state.peak <= 2 && slow.calls.length >= 2,
    `peak ${slow.state.peak} over ${slow.calls.length} requests`,
  );

  const flaky = fakeFetch({
    [searchUrl]: rows,
    "https://manifest/dracula": (_url, attempt) =>
      attempt >= 3
        ? { ok: true, status: 200, json: async () => draculaManifest, arrayBuffer: async () => new ArrayBuffer(0) }
        : { ok: false, status: 429, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) },
  });
  api.clearThemeSearchCache();
  const retried = await api.searchThemes({ limit: 20, fetchLike: flaky });
  check(
    "a throttled manifest is retried and the theme still arrives",
    retried.length === 1 && retried[0].id === "dracula-theme.theme-dracula",
    JSON.stringify(retried.map((candidate) => candidate.id)),
  );
  /*
   * A manifest that cannot be read at all is the last case: every row drops, so the search
   * comes back empty rather than throwing. That is the direction the picker needs — an
   * empty gallery says "nothing found", where an exception would show as a broken panel.
   */
  api.clearThemeSearchCache();
  const unreadable = await api.searchThemes({
    limit: 20,
    fetchLike: fakeFetch({
      [searchUrl]: rows,
      "https://manifest/powershell": { name: "powershell", contributes: {} },
    }),
  });
  check(
    "a manifest that never loads is dropped without failing the search",
    unreadable.length === 0,
    JSON.stringify(unreadable.map((candidate) => candidate.id)),
  );

  /* --- loading one theme ---------------------------------------------------- */

  const installRoot = tempDir("picode-theme-root-");
  fs.mkdirSync(path.join(installRoot, "themes"), { recursive: true });
  fs.writeFileSync(
    path.join(installRoot, "themes", "dracula.json"),
    JSON.stringify({ name: "Dracula", colors: { "editor.background": "#282a36" } }),
  );
  const fromDisk = await api.loadVariant({
    extensionId: "dracula-theme.theme-dracula",
    version: "2.25.1",
    declared: { id: "Dracula Theme", label: "Dracula Theme", uiTheme: "vs-dark", path: "./themes/dracula.json" },
    installedRoot: installRoot,
  });
  check(
    "an installed theme is read from disk and carries its identity",
    fromDisk !== undefined &&
      fromDisk.id === "Dracula Theme" &&
      fromDisk.label === "Dracula Theme" &&
      fromDisk.uiTheme === "vs-dark" &&
      fromDisk.theme.colors["editor.background"] === "#282a36",
    JSON.stringify(fromDisk),
  );

  const cacheDir = tempDir("picode-theme-cache-");
  const vsixBytes = buildZip([
    ["extension/themes/cached.json", JSON.stringify({ name: "Cached", colors: { "editor.background": "#0f0f0f" } }), 8],
  ]);
  fs.writeFileSync(path.join(cacheDir, "catppuccin.catppuccin-vsc@1.0.0.vsix"), vsixBytes);
  const neverFetches = fakeFetch({});
  const fromCache = await api.loadVariant({
    extensionId: "catppuccin.catppuccin-vsc",
    version: "1.0.0",
    declared: { id: "Catppuccin Mocha", label: "Catppuccin Mocha", path: "./themes/cached.json" },
    downloadUrl: "https://vsix/should-not-be-asked.vsix",
    cacheDir,
    fetchLike: neverFetches,
  });
  check(
    "a VSIX already in the cache is read without asking the network",
    fromCache !== undefined &&
      fromCache.theme.colors["editor.background"] === "#0f0f0f" &&
      neverFetches.calls.length === 0,
    `${JSON.stringify(fromCache === undefined ? {} : fromCache.theme.colors)} / ${neverFetches.calls.length} requests`,
  );

  const downloads = fakeFetch({
    "https://vsix/download.vsix": { ok: true, status: 200, arrayBuffer: async () => vsixBytes, json: async () => ({}) },
  });
  const downloaded = await api.loadVariant({
    extensionId: "catppuccin.catppuccin-vsc",
    version: "2.0.0",
    declared: { id: "Catppuccin Mocha", label: "Catppuccin Mocha", path: "./themes/cached.json" },
    downloadUrl: "https://vsix/download.vsix",
    cacheDir,
    fetchLike: downloads,
  });
  check(
    "a VSIX that is not cached is downloaded once and kept",
    downloaded !== undefined &&
      downloaded.theme.colors["editor.background"] === "#0f0f0f" &&
      fs.existsSync(path.join(cacheDir, "catppuccin.catppuccin-vsc@2.0.0.vsix")),
    `${JSON.stringify(downloaded === undefined ? {} : downloaded.theme.colors)} / ${fs.readdirSync(cacheDir).join(",")}`,
  );
  const second = await api.loadVariant({
    extensionId: "catppuccin.catppuccin-vsc",
    version: "2.0.0",
    declared: { id: "Catppuccin Mocha", label: "Catppuccin Mocha", path: "./themes/cached.json" },
    downloadUrl: "https://vsix/download.vsix",
    cacheDir,
    fetchLike: downloads,
  });
  check(
    "the second look is local: the download happened once",
    second !== undefined && downloads.calls.length === 1,
    `${downloads.calls.length} requests`,
  );

  const nothing = await api.loadVariant({
    extensionId: "none.none",
    version: "1.0.0",
    declared: { id: "None", label: "None", path: "./t.json" },
    cacheDir,
    fetchLike: fakeFetch({}),
  });
  check(
    "a theme that cannot be read anywhere is undefined, not an empty theme",
    nothing === undefined,
    JSON.stringify(nothing),
  );

  const bogusCache = tempDir("picode-theme-bogus-");
  fs.writeFileSync(path.join(bogusCache, "broken.broken@1.0.0.vsix"), "not a zip");
  check(
    "a corrupt VSIX in the cache is reported as unreadable, not as a theme",
    (await api.loadVariant({
      extensionId: "broken.broken",
      version: "1.0.0",
      declared: { id: "Broken", label: "Broken", path: "./t.json" },
      downloadUrl: "https://vsix/none.vsix",
      cacheDir: bogusCache,
      fetchLike: fakeFetch({}),
    })) === undefined,
    "a corrupt VSIX produced a theme",
  );

  /* --- the guards at the source --------------------------------------------- */

  const source = fs.readFileSync(path.join(SOURCE_ROOT, "theme-catalog.ts"), "utf8");
  check(
    "the catalogue imports no editor module",
    !/from\s+["']vscode["']/.test(source) && !/require\(\s*["']vscode["']\s*\)/.test(source),
    "an editor import was found in the module",
  );
  check(
    "the catalogue never touches the credential file",
    !source.includes("auth.json"),
    "the credential file is named in the module",
  );

  /* --- what the gallery will show, verbatim --------------------------------- */

  console.log("--- el catálogo, tal cual ---");
  for (const candidate of found) {
    console.log(
      `${candidate.id}  ·  ${candidate.displayName}  ·  ${candidate.downloads} descargas  ·  ` +
        candidate.declared.map((theme) => theme.label).join(" / "),
    );
  }
  console.log("--- un tema resuelto ---");
  console.log(JSON.stringify(resolved, null, 2));
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
