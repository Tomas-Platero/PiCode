// PiCode's settings tab: the renderer half of the two-panel options surface.
//
// Presentation only. The catalogue and the values come from the host; this script
// turns them into the rail on the left and the rows on the right, filters them with
// the search box, and posts writes back. It never knows how a value is stored.
(function () {
  "use strict";

  var vscode = acquireVsCodeApi();

  // Loaded before this file by the settings panel's script list: the table takes
  // its default page size and every derived column from it.
  var packageRows = globalThis.PiCodePackageRows;

  var elements = {
    search: document.getElementById("settings-search"),
    rail: document.getElementById("settings-rail"),
    content: document.getElementById("settings-content"),
    scopeGlobal: document.getElementById("scope-global"),
    scopeProject: document.getElementById("scope-project"),
  };

  var state = {
    groups: [],
    values: {},
    scope: "global",
    selected: null,
    query: "",
    // The packages table keeps its page, its filters and its sort here, in module
    // state, and never in its own DOM: the host re-posts `state` after every write
    // and this script rebuilds the whole content pane, so anything remembered in
    // an element would reset the page and the filters on every pause.
    packages: {
      page: 1,
      // The default comes from the pure module, so the first page and the page-size
      // selector cannot disagree about how many rows a page holds.
      pageSize: packageRows.DEFAULT_PAGE_SIZE,
      query: "",
      origin: "all",
      status: "all",
      sort: { key: "name", direction: "asc" },
    },
  };

  function send(message) {
    vscode.postMessage(message);
  }

  function createElement(tag, className, text) {
    var element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    if (typeof text === "string") {
      element.textContent = text;
    }
    return element;
  }

  // --- values -------------------------------------------------------------

  function valueLabel(setting) {
    var value = state.values[setting.key];
    if (value === undefined || value === null) {
      return "sin definir";
    }
    if (setting.kind === "boolean") {
      return value ? "Activado" : "Desactivado";
    }
    if (setting.kind === "number") {
      return setting.unit ? String(value) + " " + setting.unit : String(value);
    }
    if (Array.isArray(value)) {
      return value.length === 0 ? "vacío" : value.join(", ");
    }
    return String(value);
  }

  // --- rail ---------------------------------------------------------------

  function selectCategory(id) {
    return function () {
      state.selected = id;
      state.query = "";
      elements.search.value = "";
      render();
    };
  }

  function renderRail() {
    elements.rail.textContent = "";
    for (var index = 0; index < state.groups.length; index += 1) {
      var group = state.groups[index];
      var button = createElement("button", "rail-item");
      button.type = "button";
      if (group.category.id === state.selected) {
        button.classList.add("active");
        button.setAttribute("aria-selected", "true");
      }
      button.appendChild(createElement("span", "rail-label", group.category.label));
      button.appendChild(createElement("span", "rail-count", String(group.settings.length)));
      button.addEventListener("click", selectCategory(group.category.id));
      elements.rail.appendChild(button);
    }
  }

  // --- rows ---------------------------------------------------------------

  function matches(setting, query) {
    var haystack = (setting.label + "\n" + setting.description + "\n" + setting.key).toLowerCase();
    return query
      .toLowerCase()
      .split(/\s+/)
      .every(function (term) {
        return term === "" || haystack.indexOf(term) !== -1;
      });
  }

  function renderSettingRow(setting) {
    // The packages row stacks its text above the control: a six-column table cannot
    // live in the 45% of the pane the other controls take.
    var row = createElement(
      "div",
      setting.kind === "packages" ? "setting-row setting-row-wide" : "setting-row",
    );
    var text = createElement("div", "setting-text");
    text.appendChild(createElement("div", "setting-title", setting.label));
    text.appendChild(createElement("div", "setting-description", setting.description));
    row.appendChild(text);
    row.appendChild(renderControl(setting));
    return row;
  }

  function renderControl(setting) {
    var wrapper = createElement("div", "setting-control");
    var value = state.values[setting.key];

    if (setting.readOnly) {
      wrapper.appendChild(createElement("span", "setting-readonly", valueLabel(setting)));
      wrapper.appendChild(createElement("span", "setting-note", "solo lectura"));
      return wrapper;
    }

    if (setting.scopes.indexOf(state.scope) === -1) {
      wrapper.appendChild(createElement("span", "setting-readonly", valueLabel(setting)));
      wrapper.appendChild(createElement("span", "setting-note", "solo global"));
      return wrapper;
    }

    switch (setting.kind) {
      case "boolean": {
        var label = createElement("label", "toggle");
        var checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = value === true;
        checkbox.addEventListener("change", function () {
          send({ type: "write", scope: state.scope, key: setting.key, value: checkbox.checked });
        });
        label.appendChild(checkbox);
        label.appendChild(createElement("span", "toggle-slider"));
        wrapper.appendChild(label);
        break;
      }
      case "select": {
        var options = setting.options || [];
        if (options.length === 0) {
          var fallback = document.createElement("input");
          fallback.type = "text";
          fallback.className = "setting-text-input";
          fallback.value = typeof value === "string" ? value : "";
          fallback.placeholder = "sin definir";
          fallback.addEventListener("change", function () {
            send({ type: "write", scope: state.scope, key: setting.key, value: fallback.value });
          });
          wrapper.appendChild(fallback);
          break;
        }

        var select = document.createElement("select");
        select.className = "setting-select";

        if (setting.allowEmpty) {
          var emptyOption = document.createElement("option");
          emptyOption.value = "";
          emptyOption.textContent = "vacío";
          if (value === undefined || value === null || value === "") {
            emptyOption.selected = true;
          }
          select.appendChild(emptyOption);
        }

        var currentMissing =
          typeof value === "string" &&
          value !== "" &&
          !options.some(function (option) { return option.value === value; });
        if (currentMissing) {
          var currentOption = document.createElement("option");
          currentOption.value = value;
          currentOption.textContent = value;
          currentOption.selected = true;
          select.appendChild(currentOption);
        }

        for (var oi = 0; oi < options.length; oi += 1) {
          var option = document.createElement("option");
          option.value = options[oi].value;
          option.textContent = options[oi].label;
          if (options[oi].value === value) {
            option.selected = true;
          }
          select.appendChild(option);
        }
        select.addEventListener("change", function () {
          send({ type: "write", scope: state.scope, key: setting.key, value: select.value });
        });
        wrapper.appendChild(select);
        break;
      }
      case "number": {
        var number = document.createElement("input");
        number.type = "number";
        number.className = "setting-number";
        if (typeof setting.minimum === "number") {
          number.min = String(setting.minimum);
        }
        if (typeof value === "number") {
          number.value = String(value);
        }
        number.addEventListener("change", function () {
          send({ type: "write", scope: state.scope, key: setting.key, value: number.value });
        });
        wrapper.appendChild(number);
        if (setting.unit) {
          wrapper.appendChild(createElement("span", "setting-unit", setting.unit));
        }
        break;
      }
      case "text": {
        var text = document.createElement("input");
        text.type = "text";
        text.className = "setting-text-input";
        text.value = typeof value === "string" ? value : "";
        text.placeholder = "sin definir";
        text.addEventListener("change", function () {
          send({ type: "write", scope: state.scope, key: setting.key, value: text.value });
        });
        wrapper.appendChild(text);
        break;
      }
      case "list": {
        var list = document.createElement("textarea");
        list.className = "setting-list";
        list.rows = 5;
        list.placeholder = "uno por línea";
        list.value = Array.isArray(value) ? value.join("\n") : "";
        list.addEventListener("change", function () {
          var entries = list.value
            .split(/\r?\n/)
            .map(function (line) { return line.trim(); })
            .filter(function (line) { return line !== ""; });
          send({ type: "write", scope: state.scope, key: setting.key, value: entries });
        });
        wrapper.appendChild(list);
        break;
      }
      case "packages":
        renderPackages(setting, wrapper);
        break;
    }

    if (setting.needsRestart) {
      wrapper.appendChild(createElement("span", "setting-note", "requiere reiniciar"));
    }

    return wrapper;
  }

  // --- the packages table -------------------------------------------------

  /*
   * The marks of the Origen column: npm, git and a neutral one for everything
   * else (a local path).
   *
   * The vendored codicon subset has no npm and no git glyph, so the two marks are
   * drawn inline instead of shipping an icon font of our own. They are frozen
   * literals: the cell they land in is set with innerHTML, and a stored package
   * source must never reach that string.
   */
  var ORIGIN_MARKS = {
    npm: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path fill="currentColor" d="M2 2h12v12h-3V5H8v9H2z"/></svg>',
    git: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4.6v6.8"/><path d="M4 8h6.4"/><circle cx="4" cy="3" r="1.6"/><circle cx="4" cy="13" r="1.6"/><circle cx="12" cy="8" r="1.6"/></g></svg>',
    other: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/></svg>',
  };

  var ORIGIN_LABELS = { npm: "npm", git: "git", other: "Otros" };

  var ORIGIN_FILTER_OPTIONS = [
    { value: "all", label: "Todos" },
    { value: "npm", label: "npm" },
    { value: "git", label: "git" },
    { value: "other", label: "Otros" },
  ];

  var STATUS_FILTER_OPTIONS = [
    { value: "all", label: "Todos" },
    { value: "active", label: "Activos" },
    { value: "paused", label: "Pausados" },
  ];

  function createSelect(className, options, value, onChange) {
    var select = document.createElement("select");
    select.className = className;
    for (var index = 0; index < options.length; index += 1) {
      var option = document.createElement("option");
      option.value = options[index].value;
      option.textContent = options[index].label;
      if (options[index].value === value) {
        option.selected = true;
      }
      select.appendChild(option);
    }
    select.addEventListener("change", function () {
      onChange(select.value);
    });
    return select;
  }

  /** A filter caption next to its control, wrapped so a click on the text focuses it. */
  function createLabel(text, control) {
    var label = createElement("label");
    label.appendChild(document.createTextNode(text));
    label.appendChild(control);
    return label;
  }

  /**
   * The stored list as it is at click time, not as it was when the row was painted.
   *
   * The host re-posts the whole state after every write, so anything captured at
   * paint time is stale by the second click of the same row.
   */
  function storedEntries(setting) {
    var value = state.values[setting.key];
    return Array.isArray(value) ? value.slice() : [];
  }

  function writeEntries(setting, entries) {
    // Post and stop: the host answers with a fresh `state` and the table repaints
    // from `state.packages`, so the page and the filters survive the write.
    send({ type: "write", scope: state.scope, key: setting.key, value: entries });
  }

  /**
   * Flips the pause of one row.
   *
   * The row is named by its index and never by its source: `npm:gentle-engram` and
   * `npm:gentle-engram@0.1.14` are two rows of the same package, and a source-based
   * match would flip both.
   */
  function setPaused(setting, index) {
    var entries = storedEntries(setting);
    if (index < 0 || index >= entries.length) {
      return;
    }
    var entry = entries[index] || {};
    entries[index] = {
      source: typeof entry.source === "string" ? entry.source : "",
      paused: !entry.paused,
    };
    writeEntries(setting, entries);
  }

  function removeEntry(setting, index) {
    var entries = storedEntries(setting);
    if (index < 0 || index >= entries.length) {
      return;
    }
    entries.splice(index, 1);
    writeEntries(setting, entries);
  }

  /**
   * The packages table: a summary line, a filter bar, the table itself, the
   * pagination footer and the add row.
   *
   * Only the summary, the table body and the footer repaint when the table changes
   * (the sort indicator in the header updates in place too), so typing in the
   * search box never rebuilds the settings pane and never touches another setting's
   * row.
   */
  function renderPackages(setting, wrapper) {
    var view = state.packages;

    var summary = createElement("div", "package-summary");

    var filters = createElement("div", "package-filters");
    var search = document.createElement("input");
    search.type = "text";
    search.className = "settings-search-input";
    search.placeholder = "Buscar paquetes";
    search.spellcheck = false;
    search.value = view.query;
    search.addEventListener("input", function () {
      view.query = search.value;
      // A different set of rows starts at its first page: staying on page 3 of the
      // previous search shows an empty table and reads as a broken pane.
      view.page = 1;
      paint();
    });
    var originSelect = createSelect(
      "setting-select",
      ORIGIN_FILTER_OPTIONS,
      view.origin,
      function (value) {
        view.origin = value;
        view.page = 1;
        paint();
      },
    );
    var statusSelect = createSelect(
      "setting-select",
      STATUS_FILTER_OPTIONS,
      view.status,
      function (value) {
        view.status = value;
        view.page = 1;
        paint();
      },
    );
    filters.appendChild(search);
    filters.appendChild(createLabel("Origen", originSelect));
    filters.appendChild(createLabel("Estado", statusSelect));

    var tableWrapper = createElement("div", "package-table-wrapper");
    var table = createElement("table", "package-table");
    var tableHead = document.createElement("thead");
    var headRow = document.createElement("tr");
    var sortCells = {};

    function addHeader(label, key) {
      var cell = document.createElement("th");
      if (key === null) {
        cell.textContent = label;
      } else {
        var button = createElement("button", "package-table-sort");
        button.type = "button";
        button.appendChild(document.createTextNode(label));
        var indicator = createElement("span", "package-table-sort-indicator", "▲");
        button.appendChild(indicator);
        button.addEventListener("click", function () {
          // A second click on the same header reverses it; another header starts
          // ascending, the order a freshly opened table is in.
          if (view.sort.key === key) {
            view.sort.direction = view.sort.direction === "asc" ? "desc" : "asc";
          } else {
            view.sort.key = key;
            view.sort.direction = "asc";
          }
          paint();
        });
        cell.appendChild(button);
        sortCells[key] = { cell: cell, indicator: indicator };
      }
      headRow.appendChild(cell);
    }

    addHeader("Nombre", "name");
    addHeader("Origen", null);
    addHeader("Autor/Scope", null);
    addHeader("Versión", "version");
    addHeader("Estado", "status");
    addHeader("Acción", null);

    tableHead.appendChild(headRow);
    table.appendChild(tableHead);
    var body = document.createElement("tbody");
    table.appendChild(body);
    tableWrapper.appendChild(table);

    var empty = createElement("p", "package-empty settings-empty", "No se encontraron paquetes");
    empty.hidden = true;

    var footer = createElement("div", "package-pagination");
    // The default page size is one of the sizes the module offers, so the selector
    // is built from the list alone and always shows the size the table is in use
    // with.
    var sizeOptions = packageRows.PAGE_SIZES.slice();
    var sizeSelect = createSelect(
      "setting-select",
      sizeOptions.map(function (size) {
        return { value: String(size), label: String(size) };
      }),
      String(view.pageSize),
      function (value) {
        view.pageSize = Number(value);
        // The rows per page changed, so the previous page number means nothing.
        view.page = 1;
        paint();
      },
    );

    var current = null;

    function createPageButton(glyph, title, onClick) {
      var button = createElement("button", null, glyph);
      button.type = "button";
      button.title = title;
      button.addEventListener("click", onClick);
      return button;
    }

    function goToPage(target) {
      view.page = target;
      paint();
      // Paging moves the table out of sight; it comes back into view at its top.
      tableWrapper.scrollIntoView({ block: "start" });
    }

    var pager = document.createElement("div");
    var indicator = createElement("span");
    indicator.title = "Página actual";
    var first = createPageButton("«", "Primera página", function () {
      goToPage(1);
    });
    var previous = createPageButton("‹", "Anterior", function () {
      goToPage(view.page - 1);
    });
    var next = createPageButton("›", "Siguiente", function () {
      goToPage(view.page + 1);
    });
    var lastButton = createPageButton("»", "Última página", function () {
      goToPage(current.pageCount);
    });
    pager.appendChild(first);
    pager.appendChild(previous);
    pager.appendChild(indicator);
    pager.appendChild(next);
    pager.appendChild(lastButton);
    footer.appendChild(createLabel("Por página", sizeSelect));
    footer.appendChild(pager);

    /** The rows the filters and the sort leave, in the order the table shows them. */
    function visibleRows() {
      var rows = packageRows.buildRows(storedEntries(setting));
      var visible = packageRows.filterRows(rows, {
        query: view.query,
        origin: view.origin,
        status: view.status,
      });
      return packageRows.sortRows(visible, { key: view.sort.key, direction: view.sort.direction });
    }

    function paintSummary(visible) {
      var counts = packageRows.summarize(visible);
      summary.textContent =
        counts.active + " activos · " + counts.paused + " pausados de " + counts.total + " totales";
    }

    /** Marks which header the table is sorted by, and in which direction. */
    function paintSort() {
      for (var key in sortCells) {
        var entry = sortCells[key];
        var active = view.sort.key === key;
        entry.cell.setAttribute(
          "aria-sort",
          active ? (view.sort.direction === "asc" ? "ascending" : "descending") : "none",
        );
        entry.cell.classList.toggle("active", active);
        entry.indicator.textContent = view.sort.direction === "asc" ? "▲" : "▼";
      }
    }

    function paintRows(page) {
      body.textContent = "";
      // No rows to show means no table: an empty table body with a header row looks
      // like a loading failure, so the table gives way to the empty-state line.
      var isEmpty = page.items.length === 0;
      tableWrapper.hidden = isEmpty;
      empty.hidden = !isEmpty;

      for (var index = 0; index < page.items.length; index += 1) {
        body.appendChild(renderTableRow(page.items[index]));
      }
    }

    function paintFooter(page) {
      // One page of rows needs no footer: the page-size selector goes with it,
      // because a single-page selector is noise.
      footer.hidden = !page.paged;
      indicator.textContent = "Página " + page.page + " de " + page.pageCount;
      first.disabled = page.page <= 1;
      previous.disabled = page.page <= 1;
      next.disabled = page.page >= page.pageCount;
      lastButton.disabled = page.page >= page.pageCount;
    }

    function paint() {
      var visible = visibleRows();
      current = packageRows.paginate(visible, { page: view.page, pageSize: view.pageSize });
      // paginate clamps: keeping the clamped page means removing the last package of
      // the last page lands on the last page that exists, not on an empty one.
      view.page = current.page;
      paintSummary(visible);
      paintSort();
      paintRows(current);
      paintFooter(current);
    }

    function renderTableRow(row) {
      var tableRow = document.createElement("tr");
      if (row.paused) {
        tableRow.classList.add("paused");
      }

      var name = document.createElement("td");
      name.textContent = row.name;
      // Two rows can carry the same name, because the owner's settings file stores
      // gentle-engram twice, so the exact stored spec stays reachable on hover.
      name.title = row.source;
      tableRow.appendChild(name);

      var origin = document.createElement("td");
      // Only the frozen mark reaches the markup string: the stored source is never
      // part of it, because a package name is not markup.
      // pi-lens-ignore: no-inner-html-js
      origin.innerHTML = ORIGIN_MARKS[row.origin] || ORIGIN_MARKS.other;
      var originLabel = ORIGIN_LABELS[row.origin] || ORIGIN_LABELS.other;
      origin.title = originLabel;
      origin.setAttribute("aria-label", originLabel);
      tableRow.appendChild(origin);

      var author = document.createElement("td");
      // An empty scope is nothing to show: the cell stays blank rather than
      // carrying a placeholder the table would have to explain.
      author.textContent = row.author;
      tableRow.appendChild(author);

      var version = document.createElement("td");
      // Only a pinned spec carries a version, so the em dash is the normal case.
      version.textContent = row.version === "" ? "—" : row.version;
      tableRow.appendChild(version);

      tableRow.appendChild(renderStatusCell(row));
      tableRow.appendChild(renderActionCell(row));
      return tableRow;
    }

    function renderStatusCell(row) {
      var cell = document.createElement("td");
      var toggle = createElement("label", "toggle");
      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      // On means loaded and off means paused, which is the way the switch reads.
      checkbox.checked = !row.paused;
      checkbox.setAttribute("aria-label", row.paused ? "Reanudar" : "Pausar");
      checkbox.addEventListener("change", function () {
        setPaused(setting, row.index);
      });
      toggle.appendChild(checkbox);
      toggle.appendChild(createElement("span", "toggle-slider"));
      cell.appendChild(toggle);
      return cell;
    }

    function renderActionCell(row) {
      var cell = document.createElement("td");
      // Pausing is the Estado toggle's job, so the only action left here is removing
      // the row; the trash glyph is the one the vendored codicon subset already has.
      var remove = createElement("button", "package-remove codicon codicon-trash");
      remove.type = "button";
      remove.title = "Eliminar";
      remove.addEventListener("click", function () {
        removeEntry(setting, row.index);
      });
      cell.appendChild(remove);
      return cell;
    }

    var addRow = createElement("div", "package-add");
    var addInput = document.createElement("input");
    addInput.type = "text";
    addInput.className = "setting-text-input";
    addInput.placeholder = "npm:paquete o git:github.com/usuario/repo";
    var addButton = createElement("button", "package-add-button", "Añadir");
    addButton.type = "button";
    addButton.addEventListener("click", function () {
      var source = addInput.value.trim();
      if (source === "") {
        return;
      }
      addInput.value = "";
      writeEntries(setting, storedEntries(setting).concat([{ source: source, paused: false }]));
    });
    addRow.appendChild(addInput);
    addRow.appendChild(addButton);

    wrapper.appendChild(summary);
    wrapper.appendChild(filters);
    wrapper.appendChild(tableWrapper);
    wrapper.appendChild(empty);
    wrapper.appendChild(footer);
    wrapper.appendChild(addRow);

    paint();
  }

  function renderContent() {
    elements.content.textContent = "";

    var query = state.query.trim();
    if (query !== "") {
      elements.content.appendChild(createElement("h1", "settings-title", "Resultados"));
      var count = 0;
      for (var g = 0; g < state.groups.length; g += 1) {
        var group = state.groups[g];
        for (var s = 0; s < group.settings.length; s += 1) {
          var setting = group.settings[s];
          if (matches(setting, query)) {
            elements.content.appendChild(renderSettingRow(setting));
            count += 1;
          }
        }
      }
      if (count === 0) {
        elements.content.appendChild(createElement("p", "settings-empty", "Sin resultados."));
      }
      return;
    }

    var selected = null;
    for (var i = 0; i < state.groups.length; i += 1) {
      if (state.groups[i].category.id === state.selected) {
        selected = state.groups[i];
        break;
      }
    }
    if (selected === null) {
      return;
    }

    elements.content.appendChild(createElement("h1", "settings-title", selected.category.label));
    elements.content.appendChild(
      createElement("p", "settings-category-description", selected.category.description),
    );

    for (var j = 0; j < selected.settings.length; j += 1) {
      elements.content.appendChild(renderSettingRow(selected.settings[j]));
    }
  }

  // --- scope tabs ---------------------------------------------------------

  function renderScope() {
    elements.scopeGlobal.classList.toggle("active", state.scope === "global");
    elements.scopeGlobal.setAttribute("aria-selected", String(state.scope === "global"));
    elements.scopeProject.classList.toggle("active", state.scope === "project");
    elements.scopeProject.setAttribute("aria-selected", String(state.scope === "project"));
  }

  function render() {
    renderRail();
    renderScope();
    renderContent();
  }

  function showBanner(message) {
    var banner = createElement("div", "settings-banner", message);
    elements.content.insertBefore(banner, elements.content.firstChild);
  }

  // --- host messages ------------------------------------------------------

  function handleHostMessage(message) {
    if (!message || typeof message.type !== "string") {
      return;
    }
    switch (message.type) {
      case "state":
        state.scope = message.scope === "project" ? "project" : "global";
        state.groups = Array.isArray(message.groups) ? message.groups : [];
        state.values =
          message.values && typeof message.values === "object" ? message.values : {};
        if (
          typeof message.startAt === "string" &&
          state.groups.some(function (group) { return group.category.id === message.startAt; })
        ) {
          state.selected = message.startAt;
        }
        if (state.selected === null && state.groups.length > 0) {
          state.selected = state.groups[0].category.id;
        }
        render();
        break;
      case "error":
        elements.content.textContent = "";
        elements.content.appendChild(createElement("p", "settings-error", message.message));
        break;
      case "writeError":
        showBanner(message.message);
        break;
      default:
        break;
    }
  }

  elements.scopeGlobal.addEventListener("click", function () {
    send({ type: "setScope", scope: "global" });
  });
  elements.scopeProject.addEventListener("click", function () {
    send({ type: "setScope", scope: "project" });
  });
  elements.search.addEventListener("input", function () {
    state.query = elements.search.value;
    renderContent();
  });

  window.addEventListener("message", function (event) {
    handleHostMessage(event.data);
  });

  send({ type: "ready" });
})();
