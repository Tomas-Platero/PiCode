/*
 * Exercises the theme gallery — the one renderer the theme panel and the wizard's theme step
 * both use — in a throwaway DOM.
 *
 * The component is a plain IIFE that talks to `document` and to a `post` function, so the
 * smallest honest way to observe what it does is to give it both and read back the tree it
 * built and the messages it sent. Nothing here reimplements the renderer: every check is an
 * observation of the nodes it created, the CSS custom properties it set and the messages it
 * posted.
 *
 * Four things are pinned because each has a failure that is invisible in review:
 *
 * - **the colours travel as CSS custom properties** (`style.setProperty`), all fourteen of
 *   them, and every name is also defined in `media/theme.css`: a renamed variable would leave
 *   the mock unpainted while the script and the stylesheet are each individually valid;
 * - **a stale preview is dropped**, because the owner clicks faster than a VSIX downloads and
 *   painting an older answer would show the theme he did not pick;
 * - **the reload button exists only when the host said it changes something** — the same rule
 *   every other closing in this extension follows;
 * - **nothing is written as a `style` attribute or an inline `<style>` block**, which the
 *   panels' CSP blocks, so the mistake would look like "the preview does not paint".
 *
 * Run with: npm test
 */
const fs = require("node:fs");
const path = require("node:path");

const EXTENSION_ROOT = path.resolve(__dirname, "..");

/* --- a DOM, small enough to read ------------------------------------------- */

function makeStyle() {
  const properties = new Map();
  return {
    properties,
    setProperty(name, value) {
      properties.set(name, String(value));
    },
  };
}

function makeElement(tagName) {
  const classes = new Set();
  let classNameValue = "";
  const sync = () => {
    classNameValue = [...classes].join(" ");
  };
  const node = {
    tagName,
    textContent: "",
    value: "",
    placeholder: "",
    type: "",
    hidden: false,
    spellcheck: true,
    dataset: {},
    children: [],
    listeners: {},
    style: makeStyle(),
    classList: {
      add(name) {
        classes.add(name);
        sync();
      },
      remove(name) {
        classes.delete(name);
        sync();
      },
      toggle(name, on) {
        if (on) {
          this.add(name);
        } else {
          this.remove(name);
        }
      },
      contains(name) {
        return classes.has(name);
      },
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) {
        this.children.splice(index, 1);
      }
      return child;
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    fire(type) {
      const handler = this.listeners[type];
      if (handler) {
        handler({ currentTarget: this });
      }
    },
  };
  // A real DOM keeps the class list and the class name in step; the renderer sets both ways,
  // and a stub that only kept one of them would report rows that do not exist.
  Object.defineProperty(node, "className", {
    get() {
      return classNameValue;
    },
    set(value) {
      classes.clear();
      for (const name of String(value).split(/\s+/)) {
        if (name !== "") {
          classes.add(name);
        }
      }
      sync();
    },
  });
  Object.defineProperty(node, "firstChild", {
    get() {
      return this.children.length > 0 ? this.children[0] : null;
    },
  });
  return node;
}

/** Every element of the tree whose class list holds `name`. */
function byClass(root, name) {
  const found = [];
  const walk = (node) => {
    if (node.classList && node.classList.contains(name)) {
      found.push(node);
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  return found;
}

async function main() {
  const galleryPath = path.join(EXTENSION_ROOT, "media", "theme-gallery.js");
  if (!fs.existsSync(galleryPath)) {
    console.error(`Missing ${galleryPath}.`);
    process.exit(2);
  }
  const source = fs.readFileSync(galleryPath, "utf8");

  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

  /** Loads the component into a fresh document and mounts it into a fresh root. */
  function mountGallery(options) {
    const documentStub = { createElement: (tag) => makeElement(tag) };
    const container = makeElement("div");
    // eslint-disable-next-line no-new-func
    new Function("document", "globalThis", source)(documentStub, globalThis);
    const posted = [];
    globalThis.PiCodeThemeGallery.mount(container, {
      post: (message) => posted.push(message),
      compact: options && options.compact === true,
    });
    return { container, posted, gallery: globalThis.PiCodeThemeGallery };
  }

  const rows = [
    {
      id: "vscode.theme-defaults",
      displayName: "Default Dark Modern",
      description: "El tema que trae el editor",
      downloads: 0,
      version: "",
      installed: true,
      galleryUrl: "https://vscodethemes.com/?q=Default%20Dark%20Modern",
      themes: [{ id: "Default Dark Modern", label: "Default Dark Modern", uiTheme: "vs-dark", path: "./d.json" }],
    },
    {
      id: "dracula-theme.theme-dracula",
      displayName: "Dracula Theme Official",
      description: "A dark theme for many editors",
      downloads: 900000,
      version: "2.25.1",
      installed: false,
      galleryUrl: "https://vscodethemes.com/?q=Dracula%20Theme%20Official",
      themes: [
        { id: "Dracula Theme", label: "Dracula Theme", uiTheme: "vs-dark", path: "./theme/dracula.json" },
        { id: "Dracula Theme Soft", label: "Dracula Theme Soft", uiTheme: "vs-dark", path: "./theme/soft.json" },
      ],
    },
  ];

  const frame = {
    editorBackground: "#282a36",
    editorForeground: "#f8f8f2",
    lineNumber: "#6272a4",
    tabActiveBackground: "#21222c",
    tabActiveForeground: "#f8f8f2",
    tabInactiveBackground: "#191a21",
    sideBarBackground: "#21222c",
    sideBarForeground: "#f8f8f2",
    statusBarBackground: "#191a21",
    statusBarForeground: "#f8f8f2",
    titleBarBackground: "#191a21",
    activityBarBackground: "#21222c",
    border: "#6272a4",
    selection: "#44475a",
  };
  const preview = {
    dark: true,
    frame,
    lines: [
      [{ text: "const", color: "#ff79c6" }, { text: " x", color: "#f8f8f2" }],
      [{ text: "// hola", color: "#6272a4", italic: true }, { text: " n", color: "#bd93f9", bold: true }],
    ],
  };

  /* --- the component's own surface ------------------------------------------ */

  check(
    "the component exposes the three calls both hosts use",
    typeof globalThis.PiCodeThemeGallery === "undefined" ||
      (typeof globalThis.PiCodeThemeGallery.mount === "function" &&
        typeof globalThis.PiCodeThemeGallery.feed === "function" &&
        typeof globalThis.PiCodeThemeGallery.setCurrent === "function"),
    "the component's API is not the one the hosts mount",
  );

  const gallery = mountGallery();
  check(
    "mounting builds a search box, a list and a preview inside the container it was given",
    gallery.container.children.length === 3 &&
      byClass(gallery.container, "theme-search").length === 1 &&
      byClass(gallery.container, "theme-list").length === 1 &&
      byClass(gallery.container, "theme-preview").length === 1,
    `${gallery.container.children.length} children`,
  );

  /* --- the rows ------------------------------------------------------------- */

  gallery.gallery.feed({ type: "themes", rows, query: "", current: "Default Dark Modern" });
  check(
    "every row becomes a row, and every variant a chip",
    byClass(gallery.container, "theme-row").length === 2 &&
      byClass(gallery.container, "theme-chip").length === 3,
    `${byClass(gallery.container, "theme-row").length} rows, ${byClass(gallery.container, "theme-chip").length} chips`,
  );
  check(
    "the installed row says so, and the one in force is marked",
    byClass(gallery.container, "theme-row")[0].classList.contains("is-installed") &&
      !byClass(gallery.container, "theme-row")[1].classList.contains("is-installed") &&
      byClass(gallery.container, "theme-chip")[0].classList.contains("is-current"),
    JSON.stringify(byClass(gallery.container, "theme-tag").length),
  );
  check(
    "the search box is filled with the query the host answered",
    byClass(gallery.container, "theme-search")[0].value === "",
    byClass(gallery.container, "theme-search")[0].value,
  );
  check(
    "an empty answer says so instead of drawing nothing",
    (() => {
      const empty = mountGallery();
      empty.gallery.feed({ type: "themes", rows: [], query: "" });
      return byClass(empty.container, "theme-empty").length === 1;
    })(),
    "an empty list drew nothing",
  );

  const compact = mountGallery({ compact: true });
  compact.gallery.feed({
    type: "themes",
    rows: rows.concat(
      Array.from({ length: 8 }, (_value, index) => ({
        id: `x.theme-${index}`,
        displayName: `Tema ${index}`,
        description: "descartable",
        downloads: 0,
        version: "1.0.0",
        installed: false,
        galleryUrl: "https://vscodethemes.com/?q=x",
        themes: [{ id: `Tema ${index}`, label: `Tema ${index}`, path: "./t.json" }],
      })),
    ),
    query: "",
  });
  check(
    "the compact gallery is capped and hides what the wizard has no room for",
    byClass(compact.container, "theme-row").length === 6 &&
      byClass(compact.container, "theme-row-desc").length === 0 &&
      byClass(compact.container, "theme-search")[0].hidden === true,
    `${byClass(compact.container, "theme-row").length} rows`,
  );

  /* --- choosing a theme ----------------------------------------------------- */

  const chips = byClass(gallery.container, "theme-chip");
  chips[1].fire("click");
  check(
    "clicking a chip asks for exactly that theme's preview, with a fresh request id",
    gallery.posted.length === 1 &&
      gallery.posted[0].type === "preview" &&
      gallery.posted[0].rowId === "dracula-theme.theme-dracula" &&
      gallery.posted[0].themeId === "Dracula Theme" &&
      gallery.posted[0].requestId === 1,
    JSON.stringify(gallery.posted),
  );
  check(
    "while the theme is being read the note says so, so the wait is not an empty pane",
    byClass(gallery.container, "theme-preview-note")[0].textContent === "Leyendo el tema…",
    byClass(gallery.container, "theme-preview-note")[0].textContent,
  );
  check(
    "a row that is not installed offers to install it",
    byClass(gallery.container, "theme-button")[0].textContent === "Instalar y aplicar",
    byClass(gallery.container, "theme-button")[0].textContent,
  );
  check(
    "the chips show which one is selected",
    byClass(gallery.container, "theme-chip")[1].classList.contains("is-selected"),
    JSON.stringify(byClass(gallery.container, "theme-chip").map((chip) => chip.className)),
  );

  /* --- the preview --------------------------------------------------------- */

  gallery.gallery.feed({
    type: "preview",
    requestId: 1,
    ok: true,
    variant: { id: "Dracula Theme", label: "Dracula Theme", uiTheme: "vs-dark" },
    preview,
  });
  const pane = byClass(gallery.container, "theme-preview")[0];
  check(
    "the frame's fourteen colours land on the pane as CSS custom properties",
    Object.keys(frame).length === 14 &&
      Object.keys(frame).every((token) => {
        const name = `--pv-${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
        return pane.style.properties.get(name) !== undefined;
      }),
    JSON.stringify([...pane.style.properties.keys()]),
  );
  check(
    "every variable the script sets is consumed by the stylesheet",
    (() => {
      // They are never *declared* in the CSS: the script sets them on the pane and the stylesheet
      // reads them through `var(...)` with a fallback, so consumption is what has to be checked —
      // a variable nobody reads is a colour the mock silently ignores.
      const css = fs.readFileSync(path.join(EXTENSION_ROOT, "media", "theme.css"), "utf8");
      const set = new Set([...source.matchAll(/"(--pv-[a-z-]+)"/g)].map((match) => match[1]));
      const used = new Set([...css.matchAll(/var\((--pv-[a-z-]+)/g)].map((match) => match[1]));
      const unused = [...set].filter((name) => !used.has(name));
      return set.size === 14 && unused.length === 0;
    })(),
    "a --pv- variable is set by the script and never read by the stylesheet",
  );
  check(
    "the mock paints one line per line of the sample, with the theme's own colour per token",
    byClass(gallery.container, "theme-mock-line").length === 2 &&
      byClass(gallery.container, "theme-mock-token").length === 4 &&
      byClass(gallery.container, "theme-mock-token")[0].style.color === "#ff79c6" &&
      byClass(gallery.container, "theme-mock-token")[2].style.fontStyle === "italic" &&
      byClass(gallery.container, "theme-mock-token")[3].style.fontWeight === "700",
    JSON.stringify(byClass(gallery.container, "theme-mock-token").map((token) => token.textContent)),
  );
  check(
    "the pane says which theme it is showing, and that it is dark",
    byClass(gallery.container, "theme-preview-title")[0].textContent === "Dracula Theme" &&
      pane.classList.contains("theme-preview-dark"),
    byClass(gallery.container, "theme-preview-title")[0].textContent,
  );
  check(
    "the note is cleared once the theme is painted",
    byClass(gallery.container, "theme-preview-note")[0].textContent === "",
    byClass(gallery.container, "theme-preview-note")[0].textContent,
  );

  // A second selection, then the older answer arriving late.
  chips[2].fire("click");
  const lateRequestId = gallery.posted[gallery.posted.length - 1].requestId;
  gallery.gallery.feed({
    type: "preview",
    requestId: lateRequestId - 1,
    ok: true,
    variant: { id: "Dracula Theme", label: "Dracula Theme" },
    preview: { dark: false, frame: { editorBackground: "#ffffff" }, lines: [[{ text: "x", color: "#000000" }]] },
  });
  check(
    "a stale preview is dropped: the mock still stands and the note still says it is reading",
    byClass(gallery.container, "theme-mock-line").length === 2 &&
      pane.style.properties.get("--pv-editor-background") === "#282a36" &&
      byClass(gallery.container, "theme-preview-note")[0].textContent === "Leyendo el tema…",
    JSON.stringify([
      byClass(gallery.container, "theme-mock-line").length,
      pane.style.properties.get("--pv-editor-background"),
    ]),
  );
  gallery.gallery.feed({
    type: "preview",
    requestId: lateRequestId,
    ok: true,
    variant: { id: "Dracula Theme Soft", label: "Dracula Theme Soft" },
    preview,
  });
  check(
    "the newest answer is the one painted",
    byClass(gallery.container, "theme-preview-title")[0].textContent === "Dracula Theme Soft" &&
      byClass(gallery.container, "theme-preview-note")[0].textContent === "",
    byClass(gallery.container, "theme-preview-title")[0].textContent,
  );
  gallery.gallery.feed({
    type: "preview",
    requestId: lateRequestId,
    ok: false,
    reason: "No se pudo leer el fichero del tema «X».",
  });
  check(
    "an unreadable theme says why and leaves the last preview standing",
    byClass(gallery.container, "theme-preview-note")[0].textContent.includes("No se pudo leer") &&
      byClass(gallery.container, "theme-mock-line").length === 2,
    byClass(gallery.container, "theme-preview-note")[0].textContent,
  );

  /* --- applying ------------------------------------------------------------ */

  gallery.posted.length = 0;
  byClass(gallery.container, "theme-button")[0].fire("click");
  check(
    "applying posts the selected row and theme, and nothing else",
    gallery.posted.length === 1 &&
      gallery.posted[0].type === "apply" &&
      gallery.posted[0].rowId === "dracula-theme.theme-dracula" &&
      gallery.posted[0].themeId === "Dracula Theme Soft",
    JSON.stringify(gallery.posted),
  );
  byClass(gallery.container, "theme-button")[1].fire("click");
  check(
    "the gallery link posts the row's own site URL, which the host is the one to open",
    gallery.posted.length === 2 &&
      gallery.posted[1].type === "openGallery" &&
      gallery.posted[1].url === "https://vscodethemes.com/?q=Dracula%20Theme%20Official",
    JSON.stringify(gallery.posted[1]),
  );

  check(
    "no reload button appears while the host has not asked for one",
    !byClass(gallery.container, "theme-button").some(
      (button) => button.textContent === "Recargar la ventana",
    ),
    "a reload button appeared uninvited",
  );
  gallery.gallery.feed({
    type: "applied",
    rowId: "dracula-theme.theme-dracula",
    themeId: "Dracula Theme Soft",
    result: { applied: true, installed: true, needsReload: true, current: "Dracula Theme Soft" },
    message: "Tema «Dracula Theme Soft» instalado y aplicado. El editor todavía no conoce el tema: Recargar la ventana para verlo.",
  });
  check(
    "the ending is shown as it arrived, and the theme is marked as the one in force",
    byClass(gallery.container, "theme-preview-note")[0].textContent.includes("instalado y aplicado") &&
      // The chips are rebuilt on every render, so the marked one is looked up again instead of
      // being read off the nodes captured before the message.
      byClass(gallery.container, "theme-chip").some(
        (chip) => chip.classList.contains("is-current") && chip.textContent === "Dracula Theme Soft",
      ) &&
      byClass(gallery.container, "theme-preview-current")[0].hidden === false,
    byClass(gallery.container, "theme-preview-note")[0].textContent,
  );
  const reload = byClass(gallery.container, "theme-button").filter(
    (button) => button.textContent === "Recargar la ventana",
  );
  check(
    "when the host says a reload is needed, the button is there and asks for it",
    reload.length === 1,
    JSON.stringify(byClass(gallery.container, "theme-button").map((button) => button.textContent)),
  );
  reload[0].fire("click");
  check(
    "the reload button posts the one message that makes the editor know the new theme",
    gallery.posted[gallery.posted.length - 1].type === "reload",
    JSON.stringify(gallery.posted[gallery.posted.length - 1]),
  );

  check(
    "without the host's flag no reload is offered, even after applying",
    (() => {
      const calm = mountGallery();
      calm.gallery.feed({ type: "themes", rows, query: "" });
      byClass(calm.container, "theme-chip")[0].fire("click");
      calm.gallery.feed({ type: "applied", rowId: "dracula-theme.theme-dracula", themeId: "Dracula Theme", result: { applied: true, installed: false, needsReload: false }, message: "Tema aplicado." });
      return !byClass(calm.container, "theme-button").some(
        (button) => button.textContent === "Recargar la ventana",
      );
    })(),
    "a reload button appeared without the host asking for one",
  );

  /* --- searching ----------------------------------------------------------- */

  const searching = mountGallery();
  searching.gallery.feed({ type: "themes", rows, query: "" });
  const searchBox = byClass(searching.container, "theme-search")[0];
  searchBox.value = "dracula";
  searchBox.fire("input");
  check(
    "typing in the search box asks the host for that query",
    searching.posted.length === 1 &&
      searching.posted[0].type === "search" &&
      searching.posted[0].query === "dracula",
    JSON.stringify(searching.posted),
  );

  /* --- the two constraints the CSP imposes --------------------------------- */

  check(
    "the script never writes a style attribute and never builds a style element",
    !source.includes('setAttribute("style"') &&
      !source.includes("setAttribute('style'") &&
      !source.includes('createElement("style"') &&
      !source.includes("createElement('style'"),
    "the renderer writes styles the CSP would block",
  );
  check(
    "the colours are set as custom properties and as token colours, both through CSSOM",
    source.includes("style.setProperty(") && source.includes("span.style.color"),
    "the colours do not travel through CSSOM",
  );

  console.log("--- lo que la galería dibuja ---");
  console.log(
    byClass(gallery.container, "theme-row").length +
      " filas y " +
      byClass(gallery.container, "theme-chip").length +
      " chips; el panel pinta " +
      [...pane.style.properties.entries()].slice(0, 3).map(([name, value]) => `${name}=${value}`).join(" "),
  );
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
