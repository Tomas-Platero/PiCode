/*
 * Exercises the theme preview: the colours of the editor frame and the painted sample.
 *
 * The module this covers is pure, and almost everything here is a pure check — no editor,
 * no network, no files. Three things are asserted beyond the obvious because they are the
 * reasons the module exists at all:
 *
 * - **translucency is composited, not dropped**: a theme's `#ffffff1a` selection over a
 *   `#101010` editor has to come out as the grey the eye actually sees, and a status bar's
 *   foreground has to be composited over the *status bar*, not over the editor;
 * - **the sample is the artefact**: it is printed verbatim at the end, so the thing the
 *   owner will look at in the panel is readable from the test output alone;
 * - **the TextMate approximation is pinned in the direction that matters**: the specific
 *   rule beats the general one, a later rule beats an earlier one at the same depth, and a
 *   negative selector takes its rule out of the running.
 *
 * The compiled output is loaded in plain Node: the module imports no editor API and no I/O,
 * so no stub is installed here.
 *
 * Run with: npm test
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const EXTENSION_ROOT = path.resolve(__dirname, "..");

async function main() {
  const compiled = path.join(EXTENSION_ROOT, "out", "theme-preview.js");
  if (!fs.existsSync(compiled)) {
    console.error(`Missing ${compiled}. Run "npm run compile" first.`);
    process.exit(2);
  }
  const loaded = await import(pathToFileURL(compiled).href);
  const api = loaded.previewFromTheme ? loaded : loaded.default;

  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

  /* --- dark or light -------------------------------------------------------- */

  check(
    "the theme's own type decides, and dark is the answer when nothing says otherwise",
    api.isDarkTheme({ type: "dark" }) === true &&
      api.isDarkTheme({ type: "light" }) === false &&
      api.isDarkTheme({ type: "hc" }) === true &&
      api.isDarkTheme({ type: "hc-black" }) === true &&
      api.isDarkTheme({ type: "hc-light" }) === false &&
      // The editor's default theme is a dark one, which is what an empty theme file means.
      api.isDarkTheme({}) === true,
    JSON.stringify([
      api.isDarkTheme({ type: "dark" }),
      api.isDarkTheme({ type: "light" }),
      api.isDarkTheme({}),
    ]),
  );
  check(
    "the manifest's uiTheme is consulted when the theme file says nothing, and type wins over it",
    api.isDarkTheme({}, "vs-dark") === true &&
      api.isDarkTheme({}, "hc-black") === true &&
      api.isDarkTheme({}, "vs") === false &&
      api.isDarkTheme({}, "hc-light") === false &&
      api.isDarkTheme({}, "VS-DARK") === true &&
      api.isDarkTheme({ type: "light" }, "vs-dark") === false &&
      api.isDarkTheme({ type: "dark" }, "vs") === true,
    JSON.stringify([
      api.isDarkTheme({}, "vs"),
      api.isDarkTheme({ type: "light" }, "vs-dark"),
    ]),
  );

  /* --- the frame ----------------------------------------------------------- */

  const empty = api.previewFromTheme({});
  const frameTokens = [
    "editorBackground",
    "editorForeground",
    "lineNumber",
    "tabActiveBackground",
    "tabActiveForeground",
    "tabInactiveBackground",
    "sideBarBackground",
    "sideBarForeground",
    "statusBarBackground",
    "statusBarForeground",
    "titleBarBackground",
    "activityBarBackground",
    "border",
    "selection",
  ];
  check(
    "a theme that declares nothing still has every colour of the frame",
    frameTokens.every(
      (token) => typeof empty.frame[token] === "string" && /^#[0-9a-f]{6}$/.test(empty.frame[token]),
    ),
    JSON.stringify(empty.frame),
  );
  check(
    "the empty frame is the editor's own dark default, not an invented palette",
    empty.frame.editorBackground === "#1e1e1e" && empty.frame.editorForeground === "#d4d4d4",
    JSON.stringify([empty.frame.editorBackground, empty.frame.editorForeground]),
  );
  check(
    "an empty theme is a dark preview",
    empty.dark === true,
    String(empty.dark),
  );

  const light = api.previewFromTheme({ type: "light" });
  check(
    "a light theme gets the light defaults",
    light.dark === false &&
      light.frame.editorBackground === "#ffffff" &&
      light.frame.editorForeground === "#000000",
    JSON.stringify([light.dark, light.frame.editorBackground, light.frame.editorForeground]),
  );

  /* --- colour arithmetic --------------------------------------------------- */

  const alpha = api.previewFromTheme({
    type: "dark",
    colors: {
      "editor.background": "#101010",
      // 0x1a over the editor's background is the grey the eye sees, not the literal colour.
      "editor.selectionBackground": "#ffffff1a",
    },
  });
  check(
    "a translucent selection is composited over the editor's background",
    alpha.frame.selection === "#282828",
    alpha.frame.selection,
  );

  const shorthand = api.previewFromTheme({
    type: "dark",
    colors: { "editor.background": "#123", "editor.foreground": "#f0f" },
  });
  check(
    "the three-digit form is expanded channel by channel",
    shorthand.frame.editorBackground === "#112233" && shorthand.frame.editorForeground === "#ff00ff",
    JSON.stringify([shorthand.frame.editorBackground, shorthand.frame.editorForeground]),
  );

  const translucentBackground = api.previewFromTheme({
    type: "dark",
    colors: { "editor.background": "#ffffff20" },
  });
  check(
    "a translucent background is composited over the default it replaces",
    translucentBackground.frame.editorBackground === "#3a3a3a",
    translucentBackground.frame.editorBackground,
  );

  /*
   * The surface matters: the same `#ffffff80` is one grey over black and another over white.
   * A status bar's foreground belongs to the status bar, and getting this wrong is the
   * difference between a readable preview and a washed-out one.
   */
  const statusBar = api.previewFromTheme({
    type: "dark",
    colors: {
      "statusBar.background": "#000000",
      "statusBar.foreground": "#ffffff80",
    },
  });
  check(
    "a status bar's foreground is composited over the status bar, not over the editor",
    statusBar.frame.statusBarForeground === "#808080" &&
      statusBar.frame.statusBarBackground === "#000000",
    JSON.stringify([statusBar.frame.statusBarBackground, statusBar.frame.statusBarForeground]),
  );

  check(
    "a theme that declares a text colour and nothing else means that colour everywhere",
    (() => {
      const onlyText = api.previewFromTheme({
        type: "dark",
        colors: { "editor.background": "#101014", "editor.foreground": "#e0d0c0" },
      });
      return (
        onlyText.frame.tabActiveForeground === "#e0d0c0" &&
        onlyText.frame.sideBarForeground === "#e0d0c0" &&
        onlyText.frame.statusBarForeground === "#e0d0c0"
      );
    })(),
    JSON.stringify(
      api.previewFromTheme({
        type: "dark",
        colors: { "editor.background": "#101014", "editor.foreground": "#e0d0c0" },
      }).frame,
    ),
  );

  const malformed = api.previewFromTheme({
    type: "dark",
    colors: {
      "editor.background": "var(--surprise)",
      "editor.foreground": "red",
      "sideBar.background": "#12345",
      "statusBar.background": "",
    },
  });
  check(
    "a colour that is not one falls back instead of throwing or being guessed at",
    malformed.frame.editorBackground === "#1e1e1e" &&
      malformed.frame.editorForeground === "#d4d4d4" &&
      /^#[0-9a-f]{6}$/.test(malformed.frame.sideBarBackground) &&
      /^#[0-9a-f]{6}$/.test(malformed.frame.statusBarBackground),
    JSON.stringify(malformed.frame),
  );

  const partial = api.previewFromTheme({
    type: "dark",
    colors: { "editor.background": "#000000", "sideBar.background": "#202020" },
  });
  check(
    "a theme that declares two colours keeps both and derives the rest from them",
    partial.frame.editorBackground === "#000000" &&
      partial.frame.sideBarBackground === "#202020" &&
      partial.frame.statusBarBackground !== "#000000" &&
      partial.frame.statusBarBackground !== partial.frame.sideBarBackground,
    JSON.stringify([partial.frame.editorBackground, partial.frame.sideBarBackground, partial.frame.statusBarBackground]),
  );

  /* --- the sample ---------------------------------------------------------- */

  const sample = api.previewSample();
  check(
    "the sample has the shape a narrow panel needs",
    sample.length >= 10 &&
      sample.length <= 16 &&
      // Blank lines are part of it: real code breathes, and a wall of colour reads worse.
      sample.every((line) => line.reduce((width, token) => width + token.text.length, 0) <= 44) &&
      sample.filter((line) => line.length === 0).length >= 2,
    JSON.stringify(sample.map((line) => line.reduce((width, token) => width + token.text.length, 0))),
  );
  check(
    "every piece of the sample that is not a separator carries scopes",
    sample.every((line) =>
      line.every((token) => token.text.trim() === "" || token.scopes.length > 0),
    ),
    JSON.stringify(
      sample
        .flat()
        .filter((token) => token.text.trim() !== "" && token.scopes.length === 0)
        .map((token) => token.text),
    ),
  );
  check(
    "the sample shows a comment, a string, a number, a keyword, a type and a function",
    (() => {
      const scopes = new Set(sample.flat().flatMap((token) => token.scopes));
      return (
        [...scopes].some((scope) => scope.startsWith("comment")) &&
        [...scopes].some((scope) => scope.startsWith("string")) &&
        [...scopes].some((scope) => scope.startsWith("constant.numeric")) &&
        [...scopes].some((scope) => scope.startsWith("keyword")) &&
        [...scopes].some((scope) => scope.startsWith("entity.name.function")) &&
        [...scopes].some((scope) => scope.startsWith("support.type"))
      );
    })(),
    JSON.stringify([...new Set(sample.flat().flatMap((token) => token.scopes))].sort().join(",")),
  );

  const painted = api.previewFromTheme({ type: "dark" });
  check(
    "the preview paints one token per piece of the sample, in order",
    painted.lines.length === sample.length &&
      painted.lines.every((line, index) => line.length === sample[index].length) &&
      painted.lines[0][0].text === "// the theme decides, not the sample" &&
      painted.lines.every((line) => line.every((token) => /^#[0-9a-f]{6}$/.test(token.color))),
    JSON.stringify(painted.lines[0][0]),
  );
  check(
    "with no rules at all every token takes the editor's foreground",
    painted.lines.every((line) =>
      line.every((token) => token.color === painted.frame.editorForeground),
    ),
    JSON.stringify(painted.lines[0][0]),
  );

  /* --- matching the theme's rules ------------------------------------------ */

  const tokenAt = (preview, lineIndex, tokenIndex) => {
    const line = preview.lines[lineIndex];
    return line[tokenIndex];
  };
  const withRule = (rule) =>
    api.previewFromTheme({ type: "dark", tokenColors: [rule] });

  // Line 1 is `import { readFile } from "node:fs";` and its tokens are known: index 0 is
  // the `import` keyword.
  const exact = withRule({ scope: "keyword.control.import", settings: { foreground: "#ff0000" } });
  check(
    "a rule paints the token whose scope it names",
    tokenAt(exact, 1, 0).color === "#ff0000",
    tokenAt(exact, 1, 0).color,
  );
  check(
    "a rule that names another scope paints nothing",
    withRule({ scope: "entity.name.function", settings: { foreground: "#ff0000" } })
      .lines[1][0].color === "#d4d4d4",
    withRule({ scope: "entity.name.function", settings: { foreground: "#ff0000" } }).lines[1][0]
      .color,
  );

  const general = withRule({ scope: "keyword", settings: { foreground: "#00ff00" } });
  check(
    "a prefix selector reaches a longer scope",
    tokenAt(general, 1, 0).color === "#00ff00",
    tokenAt(general, 1, 0).color,
  );

  const specific = withRule({ scope: "keyword", settings: { foreground: "#00ff00" } });
  const specificTwo = api.previewFromTheme({
    type: "dark",
    tokenColors: [
      { scope: "keyword", settings: { foreground: "#00ff00" } },
      { scope: "keyword.control.import", settings: { foreground: "#0000ff" } },
    ],
  });
  check(
    "the specific rule wins over the general one, wherever it sits in the file",
    tokenAt(specific, 1, 0).color === "#00ff00" && tokenAt(specificTwo, 1, 0).color === "#0000ff",
    JSON.stringify([tokenAt(specific, 1, 0).color, tokenAt(specificTwo, 1, 0).color]),
  );

  const tie = api.previewFromTheme({
    type: "dark",
    tokenColors: [
      { scope: "keyword.control.import", settings: { foreground: "#111111" } },
      { scope: "keyword.control.import", settings: { foreground: "#222222" } },
    ],
  });
  check(
    "at the same depth the later rule wins, which is what refining a theme looks like",
    tokenAt(tie, 1, 0).color === "#222222",
    tokenAt(tie, 1, 0).color,
  );

  const negative = api.previewFromTheme({
    type: "dark",
    tokenColors: [
      { scope: ["-comment", "keyword.control.import"], settings: { foreground: "#123456" } },
    ],
  });
  check(
    "a negative selector takes its rule out of the running for the token it excludes",
    tokenAt(negative, 1, 0).color === "#123456" &&
      tokenAt(negative, 0, 0).color === "#d4d4d4",
    JSON.stringify([tokenAt(negative, 1, 0).color, tokenAt(negative, 0, 0).color]),
  );

  const commentRule = api.previewFromTheme({
    type: "dark",
    tokenColors: [
      { scope: "comment", settings: { foreground: "#ff0000" } },
      { scope: "comment.line.double-slash", settings: { foreground: "#00ff00" } },
    ],
  });
  check(
    "a comma-separated and an array selector both paint",
    api.previewFromTheme({
      type: "dark",
      tokenColors: [{ scope: "comment, string", settings: { foreground: "#abcdef" } }],
    }).lines[0][0].color === "#abcdef" &&
      api.previewFromTheme({
        type: "dark",
        tokenColors: [{ scope: ["comment"], settings: { foreground: "#abcdef" } }],
      }).lines[0][0].color === "#abcdef",
    tokenAt(commentRule, 0, 0).color,
  );

  const styles = api.previewFromTheme({
    type: "dark",
    tokenColors: [
      { scope: "comment", settings: { foreground: "#ff0000", fontStyle: "italic" } },
      { scope: "keyword.control.import", settings: { fontStyle: "bold italic" } },
      { scope: "string", settings: { fontStyle: "underline" } },
    ],
  });
  check(
    "the font style travels with the colour, and a style nobody draws is ignored",
    tokenAt(styles, 0, 0).italic === true &&
      tokenAt(styles, 0, 0).bold === undefined &&
      tokenAt(styles, 1, 0).bold === true &&
      tokenAt(styles, 1, 0).italic === true &&
      tokenAt(styles, 1, 2).bold === undefined,
    JSON.stringify([tokenAt(styles, 0, 0), tokenAt(styles, 1, 0), tokenAt(styles, 1, 2)]),
  );
  check(
    "a rule that sets only a font style still wins, and the colour falls back",
    tokenAt(styles, 1, 0).color === styles.frame.editorForeground &&
      tokenAt(styles, 1, 0).bold === true,
    JSON.stringify(tokenAt(styles, 1, 0)),
  );
  check(
    "a translucent token colour is composited over the editor background",
    api.previewFromTheme({
      type: "dark",
      colors: { "editor.background": "#101010" },
      tokenColors: [{ scope: "comment", settings: { foreground: "#ffffff1a" } }],
    }).lines[0][0].color === "#282828",
    api.previewFromTheme({
      type: "dark",
      colors: { "editor.background": "#101010" },
      tokenColors: [{ scope: "comment", settings: { foreground: "#ffffff1a" } }],
    }).lines[0][0].color,
  );
  check(
    "a rule with no settings block is skipped instead of throwing",
    api.previewFromTheme({ type: "dark", tokenColors: [{ scope: "comment" }] }).lines[0][0].color ===
      "#d4d4d4",
    api.previewFromTheme({ type: "dark", tokenColors: [{ scope: "comment" }] }).lines[0][0].color,
  );
  check(
    "junk in tokenColors does not throw",
    (() => {
      try {
        api.previewFromTheme({ type: "dark", tokenColors: [null, 7, {}, { scope: 5 }] });
        return true;
      } catch {
        return false;
      }
    })(),
    "a malformed rule threw",
  );

  /* --- determinism --------------------------------------------------------- */

  const big = {
    type: "dark",
    colors: { "editor.background": "#0b0e14", "editor.foreground": "#bfbdb6" },
    tokenColors: [
      { scope: "comment", settings: { foreground: "#5c6773", fontStyle: "italic" } },
      { scope: "keyword", settings: { foreground: "#ff8f40" } },
      { scope: ["string"], settings: { foreground: "#aad94c" } },
      { scope: "constant.numeric", settings: { foreground: "#d2a6ff" } },
      { scope: "entity.name.function", settings: { foreground: "#ffb454" } },
      { scope: "support.type", settings: { foreground: "#59c2ff" } },
      { scope: "variable.other.property", settings: { foreground: "#e6b673" } },
    ],
  };
  check(
    "the same theme yields the same preview twice",
    JSON.stringify(api.previewFromTheme(big)) === JSON.stringify(api.previewFromTheme(big)),
    "the two previews differ",
  );

  /* --- what the owner will see, verbatim ----------------------------------- */

  console.log("--- la vista previa, con los colores del tema ---");
  const theme = api.previewFromTheme(big);
  for (const line of theme.lines) {
    console.log(line.map((token) => `${token.text}${token.color}`).join(" "));
  }
  console.log(`--- fondo ${theme.frame.editorBackground}, texto ${theme.frame.editorForeground} ---`);
  console.log(JSON.stringify(theme.frame, null, 2));
  console.log("---");

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
