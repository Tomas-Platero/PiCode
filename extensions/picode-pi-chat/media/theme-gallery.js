// The theme gallery: the one renderer both the theme panel and the wizard's theme step use.
//
// Presentation only, and deliberately the same component in both surfaces: a theme has to
// look the same wherever it is chosen, and two renderers is how one of them starts showing a
// colour the other does not. The host owns everything else — which themes exist, what one
// looks like once painted, what applying it does — and this file only draws what it is sent
// and posts what the owner asks for.
//
// It builds its own DOM inside the element it is mounted into, because the two hosts provide
// nothing but a container: the panel has `#theme-root` and the wizard `#wizard-theme-root`,
// and neither knows what the gallery puts in it.
//
// Two constraints from the hosts shape the drawing:
//
// - **the colours travel as CSS custom properties** set with `style.setProperty`. The panels'
//   CSP is `style-src <cspSource>` with no `unsafe-inline`, so a `style` attribute or an
//   inline `<style>` block would be blocked; CSSOM writes are not. The stylesheet owns how a
//   variable is used, so this file knows no colour names.
// - **no remote images**: the CSP allows local resources and `data:` only, so an extension's
//   icon from the registry would render as an empty box. The row shows its name instead.
(function () {
  "use strict";

  var FRAME_VARIABLES = [
    ["editorBackground", "--pv-editor-background"],
    ["editorForeground", "--pv-editor-foreground"],
    ["lineNumber", "--pv-line-number"],
    ["tabActiveBackground", "--pv-tab-active-background"],
    ["tabActiveForeground", "--pv-tab-active-foreground"],
    ["tabInactiveBackground", "--pv-tab-inactive-background"],
    ["sideBarBackground", "--pv-side-bar-background"],
    ["sideBarForeground", "--pv-side-bar-foreground"],
    ["statusBarBackground", "--pv-status-bar-background"],
    ["statusBarForeground", "--pv-status-bar-foreground"],
    ["titleBarBackground", "--pv-title-bar-background"],
    ["activityBarBackground", "--pv-activity-bar-background"],
    ["border", "--pv-border"],
    ["selection", "--pv-selection"],
  ];

  var SIDEBAR_FILES = ["src", "index.ts", "package.json", "README.md"];
  var MAX_COMPACT_ROWS = 6;

  var state = {
    rows: [],
    query: "",
    current: null,
    selectedRowId: null,
    selectedThemeId: null,
    // Only the newest answer is painted: the owner clicks faster than a VSIX downloads.
    requestId: 0,
    latestRequestId: 0,
    /** The theme the mock is currently showing, so the badge can follow the one in force. */
    paintedThemeId: null,
    waiting: false,
    compact: false,
  };

  var elements = {};
  var post = function () {};

  function create(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  /** The element the preview paints into, built once and reused for every theme. */
  function buildPreview(compact) {
    var preview = create("div", "theme-preview");
    var head = create("div", "theme-preview-head");
    var title = create("span", "theme-preview-title", "Elige un tema");
    var current = create("span", "theme-preview-current", "En uso");
    current.hidden = true;
    head.appendChild(title);
    head.appendChild(current);

    var mock = create("div", "theme-mock");
    var titleBar = create("div", "theme-mock-titlebar", compact ? "" : "archivo.ts — PiCode");
    var body = create("div", "theme-mock-body");
    var activity = create("div", "theme-mock-activity");
    var sidebar = create("div", "theme-mock-sidebar");
    for (var index = 0; index < SIDEBAR_FILES.length; index += 1) {
      sidebar.appendChild(create("div", "theme-mock-file", SIDEBAR_FILES[index]));
    }
    var main = create("div", "theme-mock-main");
    var tabs = create("div", "theme-mock-tabs");
    tabs.appendChild(create("span", "theme-mock-tab active", compact ? "archivo" : "archivo.ts"));
    tabs.appendChild(create("span", "theme-mock-tab", "otros.ts"));
    var code = create("div", "theme-mock-code");
    main.appendChild(tabs);
    main.appendChild(code);
    body.appendChild(activity);
    body.appendChild(sidebar);
    body.appendChild(main);
    var status = create("div", "theme-mock-status", compact ? "" : "main · 0 errores");
    mock.appendChild(titleBar);
    mock.appendChild(body);
    mock.appendChild(status);

    var note = create("p", "theme-preview-note");
    var actions = create("div", "theme-actions");
    var apply = create("button", "theme-button primary", "Aplicar");
    apply.type = "button";
    var gallery = create("button", "theme-button", "Ver en vscodethemes.com");
    gallery.type = "button";
    actions.appendChild(apply);
    actions.appendChild(gallery);

    preview.appendChild(head);
    preview.appendChild(mock);
    preview.appendChild(note);
    preview.appendChild(actions);
    return {
      root: preview,
      title: title,
      current: current,
      code: code,
      note: note,
      apply: apply,
      gallery: gallery,
      actions: actions,
    };
  }

  function mount(rootElement, options) {
    if (!rootElement) {
      return;
    }
    var settings = options || {};
    post = typeof settings.post === "function" ? settings.post : function () {};
    state.compact = settings.compact === true;

    rootElement.className = "theme-gallery" + (state.compact ? " compact" : "");
    while (rootElement.firstChild) {
      rootElement.removeChild(rootElement.firstChild);
    }

    var search = create("input", "theme-search");
    search.type = "text";
    search.placeholder = "Buscar temas";
    search.spellcheck = false;
    search.hidden = state.compact;
    search.addEventListener("input", function () {
      state.query = search.value;
      post({ type: "search", query: state.query });
    });

    var list = create("div", "theme-list");
    var preview = buildPreview(state.compact);

    preview.apply.addEventListener("click", function () {
      if (state.selectedRowId === null || state.selectedThemeId === null) {
        return;
      }
      preview.note.textContent = "Aplicando…";
      post({ type: "apply", rowId: state.selectedRowId, themeId: state.selectedThemeId });
    });
    preview.gallery.addEventListener("click", function () {
      var row = rowOf(state.selectedRowId);
      if (row) {
        post({ type: "openGallery", url: row.galleryUrl });
      }
    });

    rootElement.appendChild(search);
    rootElement.appendChild(list);
    rootElement.appendChild(preview.root);
    elements = { root: rootElement, search: search, list: list, preview: preview };
    renderRows();
  }

  function rowOf(rowId) {
    for (var index = 0; index < state.rows.length; index += 1) {
      if (state.rows[index].id === rowId) {
        return state.rows[index];
      }
    }
    return null;
  }

  function variantOf(row, themeId) {
    if (!row) {
      return null;
    }
    for (var index = 0; index < row.themes.length; index += 1) {
      if (row.themes[index].id === themeId) {
        return row.themes[index];
      }
    }
    return row.themes.length > 0 ? row.themes[0] : null;
  }

  function select(rowId, themeId) {
    var row = rowOf(rowId);
    var variant = variantOf(row, themeId);
    if (!row || !variant) {
      return;
    }
    state.selectedRowId = row.id;
    state.selectedThemeId = variant.id;
    state.requestId += 1;
    state.latestRequestId = state.requestId;
    state.waiting = true;
    renderRows();
    elements.preview.apply.textContent = row.installed ? "Aplicar" : "Instalar y aplicar";
    elements.preview.note.textContent = "Leyendo el tema…";
    post({ type: "preview", requestId: state.requestId, rowId: row.id, themeId: variant.id });
  }

  function renderRows() {
    if (!elements.list) {
      return;
    }
    while (elements.list.firstChild) {
      elements.list.removeChild(elements.list.firstChild);
    }
    var rows = state.rows;
    if (state.compact && rows.length > MAX_COMPACT_ROWS) {
      rows = rows.slice(0, MAX_COMPACT_ROWS);
    }
    if (rows.length === 0) {
      elements.list.appendChild(create("p", "theme-empty", "Ningún tema que coincida."));
      return;
    }
    for (var index = 0; index < rows.length; index += 1) {
      var row = rows[index];
      var item = create("div", "theme-row" + (row.installed ? " is-installed" : ""));
      var text = create("div", "theme-row-text");
      text.appendChild(create("div", "theme-row-name", row.displayName));
      if (!state.compact && row.description) {
        text.appendChild(create("div", "theme-row-desc", row.description));
      }
      item.appendChild(text);

      var chips = create("div", "theme-row-chips");
      if (row.installed) {
        chips.appendChild(create("span", "theme-tag", "Instalado"));
      }
      for (var variantIndex = 0; variantIndex < row.themes.length; variantIndex += 1) {
        var variant = row.themes[variantIndex];
        var chip = create(
          "button",
          "theme-chip" +
            (row.id === state.selectedRowId && variant.id === state.selectedThemeId
              ? " is-selected"
              : "") +
            (variant.id === state.current ? " is-current" : ""),
          variant.label,
        );
        chip.type = "button";
        chip.dataset.rowId = row.id;
        chip.dataset.themeId = variant.id;
        chip.addEventListener("click", function (event) {
          var target = event.currentTarget;
          select(target.dataset.rowId, target.dataset.themeId);
        });
        chips.appendChild(chip);
      }
      item.appendChild(chips);
      elements.list.appendChild(item);
    }
  }

  /** The mock, painted with the theme's own colours through the stylesheet's variables. */
  function renderPreview(message) {
    var preview = elements.preview;
    var frame = message.preview.frame || {};
    for (var index = 0; index < FRAME_VARIABLES.length; index += 1) {
      var value = frame[FRAME_VARIABLES[index][0]];
      if (typeof value === "string") {
        preview.root.style.setProperty(FRAME_VARIABLES[index][1], value);
      }
    }
    preview.root.className =
      "theme-preview " + (message.preview.dark ? "theme-preview-dark" : "theme-preview-light");
    preview.title.textContent = message.variant && message.variant.label ? message.variant.label : "Tema";
    state.paintedThemeId = message.variant ? message.variant.id : null;
    preview.current.hidden = !(message.variant && message.variant.id === state.current);

    while (preview.code.firstChild) {
      preview.code.removeChild(preview.code.firstChild);
    }
    var lines = message.preview.lines || [];
    for (var lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      // One line carries the selection band: it is the colour a theme most often gets wrong for
      // a translucent value, so showing it is showing what the theme really looks like.
      var line = create(
        "div",
        lineIndex === 1 ? "theme-mock-line theme-mock-line-selected" : "theme-mock-line",
      );
      // The number is drawn, not faked with CSS `content`: it has to be a real element to take
      // the theme's own line-number colour, and a theme is allowed to leave that undefined.
      line.appendChild(create("span", "theme-mock-line-number", String(lineIndex + 1)));
      var tokens = lines[lineIndex];
      for (var tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
        var token = tokens[tokenIndex];
        var span = create("span", "theme-mock-token", token.text);
        if (typeof token.color === "string") {
          span.style.color = token.color;
        }
        if (token.bold) {
          span.style.fontWeight = "700";
        }
        if (token.italic) {
          span.style.fontStyle = "italic";
        }
        line.appendChild(span);
      }
      preview.code.appendChild(line);
    }
    preview.note.textContent = "";
  }

  function feed(message) {
    if (!message || typeof message.type !== "string") {
      return;
    }
    switch (message.type) {
      case "themes":
        state.rows = Array.isArray(message.rows) ? message.rows : [];
        if (Array.isArray(message.rows) && message.rows.length > 0) {
          // The first theme is not chosen for the owner: a preview is asked for when he picks
          // one, and the panel would otherwise open by downloading a package he never asked
          // about.
          state.current = typeof message.current === "string" ? message.current : state.current;
        }
        if (typeof message.current === "string") {
          state.current = message.current;
        }
        if (!state.compact && typeof message.query === "string" && elements.search) {
          elements.search.value = message.query;
        }
        if (typeof message.error === "string" && elements.preview) {
          elements.preview.note.textContent = message.error;
        }
        renderRows();
        break;
      case "preview":
        if (message.requestId !== state.latestRequestId) {
          // A stale answer: the owner has already picked another theme.
          break;
        }
        state.waiting = false;
        if (message.ok) {
          renderPreview(message);
        } else if (elements.preview) {
          // The last preview stays: one unreadable theme is not a reason to throw away what
          // the owner was looking at.
          elements.preview.note.textContent = message.reason || "No se pudo leer ese tema.";
        }
        break;
      case "applied":
        if (elements.preview) {
          elements.preview.note.textContent = message.message || "";
        }
        if (message.result && message.result.current) {
          setCurrent(message.result.current);
        }
        if (message.result && message.result.needsReload) {
          offerReload();
        }
        renderRows();
        break;
      default:
        break;
    }
  }

  /**
   * The reload button, added only when the host said it changes something.
   *
   * A theme that was already installed is applied at once; one that had to be installed can
   * reach the theme registry a moment too late. The host decides which of the two happened,
   * and this only draws the button it was told to draw — a button that reloaded onto the same
   * theme would be the kind of lie this whole surface tries not to tell.
   */
  function offerReload() {
    if (elements.reload) {
      return;
    }
    var button = create("button", "theme-button", "Recargar la ventana");
    button.type = "button";
    button.addEventListener("click", function () {
      post({ type: "reload" });
    });
    elements.reload = button;
    elements.preview.actions.appendChild(button);
  }

  function setCurrent(themeId) {
    state.current = typeof themeId === "string" ? themeId : null;
    // The badge above the mock follows too: applying the theme being previewed is the moment
    // the owner expects to read "en uso" over the thing he is looking at.
    if (elements.preview) {
      elements.preview.current.hidden = !(state.current !== null && state.current === state.paintedThemeId);
    }
    renderRows();
  }

  globalThis.PiCodeThemeGallery = {
    mount: mount,
    feed: feed,
    setCurrent: setCurrent,
  };
})();
