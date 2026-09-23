// PiCode's settings tab: the renderer half of the two-panel options surface.
//
// Presentation only. The catalogue and the values come from the host; this script
// turns them into the rail on the left and the rows on the right, filters them with
// the search box, and posts writes back. It never knows how a value is stored.
(function () {
  "use strict";

  var vscode = acquireVsCodeApi();

  // Loaded before this file by the settings panel's script list: the tables take
  // their default page size and every derived column from them.
  var packageRows = globalThis.PiCodePackageRows;
  var skillRows = globalThis.PiCodeSkillRows;

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
    // The discovered skills the host computed for the current scope, plus the
    // problems the discovery reported beside them. Never derived here: the host is
    // the only side that knows whether a package skill is on in that scope.
    skills: [],
    skillProblems: [],
    // The manifest facts of the installed packages, as the host read them. Never
    // derived here: the source string alone cannot tell a version or an author, so
    // the table merges what the host supplies over what the spec already gives.
    packageFacts: [],
    // Which of the Packages section's two tabs is showing. Kept here, in module
    // state, so a repaint after a host write does not throw the owner back to the
    // packages table.
    packagesTab: "packages",
    // The catalogue the Catálogo tab shows: the window the host loaded, the
    // registry's total and the page the footer is on. Everything the renderer
    // needs survives a repaint here, never in the table's own DOM.
    catalog: {
      query: "",
      requested: false,
      loading: false,
      error: "",
      rows: [],
      total: 0,
      page: 1,
      pageSize: packageRows.DEFAULT_PAGE_SIZE,
      // The type filter and the order the loaded window is shown in. They live here,
      // in module state, so a repaint keeps them; the registry offers neither, so
      // both run over the window the host loaded and over nothing else.
      type: "all",
      order: "relevance",
    },
    // The skills table keeps its page, its filters and its sort here, in module
    // state, and never in its own DOM: flipping a switch makes the host re-post
    // `state`, this script rebuilds the whole content pane, and anything remembered
    // in an element would lose the page, the query and the filters on that flip.
    skillTable: {
      page: 1,
      // The default comes from the pure module, so the first page and the page-size
      // selector cannot disagree about how many rows a page holds.
      pageSize: skillRows.DEFAULT_PAGE_SIZE,
      query: "",
      origin: "all",
      state: "all",
      sort: { key: "name", direction: "asc" },
    },
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
    // An action is normally a button and nothing else: the host sends no value for the
    // wizard row, so it shows no line rather than the "sin definir" the other valueless
    // rows use. The version row is the exception — its value is the fact the owner reads
    // before pressing it — so a value the host did send is shown instead of swallowed.
    if (setting.kind === "action") {
      return value === undefined || value === null ? "" : String(value);
    }
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
    // The packages and skills rows stack their text above the control: a six-column
    // table and a list of rows cannot live in the 45% of the pane the other controls
    // take.
    var row = createElement(
      "div",
      setting.kind === "packages" || setting.kind === "skills"
        ? "setting-row setting-row-wide"
        : "setting-row",
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

    // An action row is a button, and this branch comes first so the read-only row
    // below can never paint its "solo lectura" note over a row that has no value.
    if (setting.kind === "action") {
      // The row's own title names the thing, so the button says what pressing it does
      // instead of repeating the title next to itself; a row that states a fact before
      // the owner decides puts that fact here, in front of the button.
      var actionState = valueLabel(setting);
      if (actionState !== "") {
        var stateLine = createElement("span", "setting-readonly", actionState);
        // The line can outgrow the control's half of the pane and be trimmed, so the
        // whole of it stays reachable on hover.
        stateLine.title = actionState;
        wrapper.appendChild(stateLine);
      }
      var action = createElement(
        "button",
        "setting-action-button",
        setting.actionLabel || "Abrir el asistente",
      );
      action.type = "button";
      action.addEventListener("click", function () {
        // Only the row's key travels: the host owns the command the row runs.
        send({ type: "action", key: setting.key });
      });
      wrapper.appendChild(action);
      return wrapper;
    }

    // The skills row is a list, not a value. Like the action above, it is handled
    // before the read-only branch so its own row shape is what gets drawn.
    if (setting.kind === "skills") {
      renderSkills(wrapper);
      return wrapper;
    }

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

  // --- the skills table ---------------------------------------------------

  /*
   * The skills table: a summary line, a filter bar, the table itself and the
   * pagination footer, over the rows `skill-rows.js` derives.
   *
   * It is a painter of its own and not the packages one on purpose: refactoring the
   * working packages table inside the same change was the risk that sank two earlier
   * attempts, so the migration onto one shared painter stays its own unit. The shape
   * it copies is still the packages table's, down to the rule that only the summary,
   * the body and the footer repaint: the host re-posts `state` after every write and
   * this script rebuilds the whole pane, so the page and the filters have to survive
   * in `state.skillTable` and never in the table's own DOM.
   */

  // The filter values are the routes `skill-rows.js` puts in `row.origin`, so a
  // filter compares equal to the column it filters and never needs a translation
  // table the two sides could drift apart on.
  var SKILL_ORIGIN_FILTER_OPTIONS = [
    { value: "all", label: "Todos" },
    { value: "pi", label: "pi" },
    { value: "package", label: "Paquetes" },
    { value: "project", label: "Proyecto" },
  ];

  var SKILL_STATE_FILTER_OPTIONS = [
    { value: "all", label: "Todos" },
    { value: "on", label: "Activadas" },
    { value: "off", label: "Desactivadas" },
  ];

  /** Why a skill that cannot be switched is not switched, in one short line. */
  function skillReason(row) {
    if (row.origin === "pi") {
      return "Viene con pi; no se puede desactivar.";
    }
    if (row.origin === "project") {
      return "Es del proyecto; no se puede desactivar.";
    }
    return "Esta skill no se puede activar ni desactivar.";
  }

  function renderSkills(wrapper) {
    var view = state.skillTable;

    var summary = createElement("div", "skill-summary");

    var filters = createElement("div", "skill-filters");
    var search = document.createElement("input");
    search.type = "text";
    search.className = "settings-search-input";
    search.placeholder = "Buscar skills";
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
      SKILL_ORIGIN_FILTER_OPTIONS,
      view.origin,
      function (value) {
        view.origin = value;
        view.page = 1;
        paint();
      },
    );
    var stateSelect = createSelect(
      "setting-select",
      SKILL_STATE_FILTER_OPTIONS,
      view.state,
      function (value) {
        view.state = value;
        view.page = 1;
        paint();
      },
    );
    filters.appendChild(search);
    filters.appendChild(createLabel("Origen", originSelect));
    filters.appendChild(createLabel("Estado", stateSelect));

    var tableWrapper = createElement("div", "skill-table-wrapper");
    var table = createElement("table", "skill-table");
    var tableHead = document.createElement("thead");
    var headRow = document.createElement("tr");
    var sortCells = {};

    function addHeader(label, key) {
      var cell = document.createElement("th");
      if (key === null) {
        cell.textContent = label;
      } else {
        var button = createElement("button", "skill-table-sort");
        button.type = "button";
        button.appendChild(document.createTextNode(label));
        var sortIndicator = createElement("span", "skill-table-sort-indicator", "▲");
        button.appendChild(sortIndicator);
        button.addEventListener("click", function () {
          // A second click on the same header reverses it; another header starts
          // ascending, the order a freshly opened table is in.
          if (view.sort.key === key) {
            view.sort.direction = view.sort.direction === "asc" ? "desc" : "asc";
          } else {
            view.sort.key = key;
            view.sort.direction = "asc";
          }
          // The rows are reordered, so the old page number means nothing.
          view.page = 1;
          paint();
        });
        cell.appendChild(button);
        sortCells[key] = { cell: cell, indicator: sortIndicator };
      }
      headRow.appendChild(cell);
    }

    addHeader("Nombre", "name");
    addHeader("Descripción", null);
    addHeader("Origen", "origin");
    addHeader("Estado", "state");

    tableHead.appendChild(headRow);
    table.appendChild(tableHead);
    var body = document.createElement("tbody");
    table.appendChild(body);
    tableWrapper.appendChild(table);

    var empty = createElement("p", "skill-empty settings-empty", "No se encontraron skills.");
    empty.hidden = true;

    var footer = createElement("div", "skill-pagination");
    // The default page size is one of the sizes the module offers, so the selector
    // is built from the list alone and always shows the size the table is in use
    // with.
    var sizeOptions = skillRows.PAGE_SIZES.slice();
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
      var rows = skillRows.buildRows(state.skills);
      var visible = skillRows.filterRows(rows, {
        query: view.query,
        origin: view.origin,
        state: view.state,
      });
      return skillRows.sortRows(visible, { key: view.sort.key, direction: view.sort.direction });
    }

    function paintSummary(visible) {
      var counts = skillRows.summarize(visible);
      summary.textContent =
        counts.on + " activadas · " + counts.off + " desactivadas de " + counts.total + " totales";
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
        body.appendChild(renderSkillRow(page.items[index]));
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
      current = skillRows.paginate(visible, { page: view.page, pageSize: view.pageSize });
      // paginate clamps: keeping the clamped page means a filter that shrinks the
      // table lands on the last page that exists, not on an empty one.
      view.page = current.page;
      paintSummary(visible);
      paintSort();
      paintRows(current);
      paintFooter(current);
    }

    function renderSkillRow(row) {
      var tableRow = document.createElement("tr");
      // A skill that is off is dimmed the way a paused package row is: the two tables
      // describe the same kind of thing, so "off" should read the same in both.
      if (!row.enabled) {
        tableRow.classList.add("skill-row-off");
      }

      var name = document.createElement("td");
      name.textContent = row.name;
      tableRow.appendChild(name);

      var description = document.createElement("td");
      description.textContent = row.description;
      tableRow.appendChild(description);

      var origin = document.createElement("td");
      // The label comes from `skill-rows.js`, never from the raw route: a package
      // with no reported name has to read as the spec a human can match to the
      // packages table, and that fallback lives in the pure module alone.
      origin.textContent = row.originLabel;
      tableRow.appendChild(origin);

      tableRow.appendChild(renderStateCell(row));
      return tableRow;
    }

    function renderStateCell(row) {
      var cell = document.createElement("td");
      if (row.canToggle) {
        var toggle = createElement("label", "toggle");
        var checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = row.enabled;
        checkbox.setAttribute("aria-label", row.enabled ? "Desactivar" : "Activar");
        checkbox.addEventListener("change", function () {
          // The message names the skill by its filter pattern and its package, never by
          // its index: the host rebuilds that package's entry from what pi stores, so
          // the webview never recomputes a filter and never has to know the package's
          // other patterns. The page, the query and the filters stay in module state,
          // so the repaint this write triggers shows the same rows as before.
          send({
            type: "toggleSkill",
            scope: state.scope,
            pattern: row.pattern,
            packageSource: row.skill.packageSource,
            enabled: checkbox.checked,
          });
        });
        toggle.appendChild(checkbox);
        toggle.appendChild(createElement("span", "toggle-slider"));
        cell.appendChild(toggle);
      } else {
        // A skill pi cannot switch still shows its state, plus the reason in Spanish
        // instead of a control that would do nothing.
        cell.appendChild(
          createElement("span", "setting-readonly", row.enabled ? "Activada" : "Desactivada"),
        );
        cell.appendChild(createElement("span", "setting-note", skillReason(row)));
      }
      return cell;
    }

    wrapper.appendChild(summary);
    wrapper.appendChild(filters);
    wrapper.appendChild(tableWrapper);
    wrapper.appendChild(empty);
    wrapper.appendChild(footer);

    // A partial listing still shows what was found; the problems go beside it, the
    // way the discovery was designed to report them, instead of blanking the table.
    if (state.skillProblems.length > 0) {
      var problems = createElement("div", "skill-problems");
      for (var p = 0; p < state.skillProblems.length; p += 1) {
        problems.appendChild(createElement("p", "settings-error", state.skillProblems[p].message));
      }
      wrapper.appendChild(problems);
    }

    paint();
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
      var rows = packageRows.buildRows(storedEntries(setting), state.packageFacts);
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

  // --- the Packages section's two tabs ------------------------------------

  /*
   * The Packages section has two surfaces now: the installed table it always had
   * and the registry's catalogue. The tabs are module state and not DOM state for
   * the same reason the tables are: the host re-posts `state` after every write and
   * this script rebuilds the whole pane, so a tab remembered in an element would
   * flip back to Paquetes on the first repaint.
   */
  function renderPackagesTabs() {
    var tabs = createElement("div", "category-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.appendChild(createPackagesTab("packages", "Paquetes"));
    tabs.appendChild(createPackagesTab("catalog", "Catálogo"));
    elements.content.appendChild(tabs);
  }

  function createPackagesTab(id, label) {
    var button = createElement("button", "category-tab", label);
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(state.packagesTab === id));
    if (state.packagesTab === id) {
      button.classList.add("active");
    }
    button.addEventListener("click", function () {
      if (state.packagesTab === id) {
        return;
      }
      state.packagesTab = id;
      // The catalogue is fetched the first time its tab is opened, not on every
      // repaint: the lookup costs a registry search and one type document per row.
      if (id === "catalog" && !state.catalog.requested) {
        requestCatalogSearch();
      } else {
        renderContent();
      }
    });
    return button;
  }

  // --- the catalogue ------------------------------------------------------

  /*
   * The Catálogo tab: the window the host searched, the page the footer is on, and
   * one row per package.
   *
   * The host owns the registry search and the type resolution; this only draws what
   * it sent. Install state is decided here, against the packages the settings state
   * already carries, so the host does not have to send the installed list twice.
   */

  /*
   * The four types pi derives from a manifest, plus the choice that filters nothing.
   * The plain "package" tag pi falls back to is left out on purpose: it means "no
   * type was declared", so those rows show under Todos alone.
   */
  var CATALOG_TYPE_FILTER_OPTIONS = [
    { value: "all", label: "Todos" },
    { value: "extension", label: "extension" },
    { value: "skill", label: "skill" },
    { value: "prompt", label: "prompt" },
    { value: "theme", label: "theme" },
  ];

  var CATALOG_ORDER_OPTIONS = [
    { value: "relevance", label: "Relevancia del registro" },
    { value: "downloads", label: "Descargas mensuales" },
    { value: "published", label: "Publicación más reciente" },
    { value: "name", label: "Nombre (A-Z)" },
  ];

  /** Sends the current query and paints the loading line until the host answers. */
  function requestCatalogSearch() {
    state.catalog.requested = true;
    state.catalog.loading = true;
    state.catalog.error = "";
    // A different query starts a different set of rows, so the old page means
    // nothing and would show an empty table if it were kept.
    state.catalog.page = 1;
    renderContent();
    send({ type: "catalogSearch", query: state.catalog.query });
  }

  /**
   * How long ago a catalogue row was published, in Spanish.
   *
   * The registry reports `publishedAt` as an ISO string; a missing or unparseable
   * one is "sin fecha", because a plausible wrong age is worse than admitting the
   * date is not there. A future date clamps to "ahora mismo" so clock skew cannot
   * print a negative age.
   */
  function publishedAgo(value) {
    if (typeof value !== "string" || value === "") {
      return "sin fecha";
    }
    var then = Date.parse(value);
    if (isNaN(then)) {
      return "sin fecha";
    }
    var seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 60) {
      return "ahora mismo";
    }
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return "hace " + minutes + (minutes === 1 ? " minuto" : " minutos");
    }
    var hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return "hace " + hours + (hours === 1 ? " hora" : " horas");
    }
    var days = Math.floor(hours / 24);
    if (days < 30) {
      return "hace " + days + (days === 1 ? " día" : " días");
    }
    var months = Math.floor(days / 30);
    if (months < 12) {
      return "hace " + months + (months === 1 ? " mes" : " meses");
    }
    var years = Math.floor(months / 12);
    return "hace " + years + (years === 1 ? " año" : " años");
  }

  /** The monthly figure with Spanish thousands, so a large number stays readable. */
  function formatDownloads(value) {
    var downloads = typeof value === "number" && isFinite(value) ? value : 0;
    return downloads.toLocaleString("es-ES") + " /mes";
  }

  /** The monthly figure as a number, so a missing or unusable one counts as zero. */
  function monthlyDownloadsOf(row) {
    var value = row ? row.monthlyDownloads : undefined;
    return typeof value === "number" && isFinite(value) ? value : 0;
  }

  /** When a row was published, or NaN when it carries no usable date. */
  function publishedTimeOf(row) {
    var value = row ? row.publishedAt : undefined;
    return typeof value === "string" && value !== "" ? Date.parse(value) : NaN;
  }

  /**
   * The loaded window after the type filter and the order selector.
   *
   * Both run over `state.catalog.rows` alone: the registry answers with one
   * relevance-ordered window and offers no filter or sort of its own, so a control
   * that reached past the rows already in hand would promise what this side cannot
   * deliver.
   */
  function visibleCatalogRows() {
    var view = state.catalog;
    var rows = view.rows.slice();

    if (view.type !== "all") {
      rows = rows.filter(function (row) {
        return Array.isArray(row.tags) && row.tags.indexOf(view.type) !== -1;
      });
    }

    if (view.order === "downloads") {
      rows.sort(function (left, right) {
        return monthlyDownloadsOf(right) - monthlyDownloadsOf(left);
      });
    } else if (view.order === "published") {
      rows.sort(function (left, right) {
        var a = publishedTimeOf(left);
        var b = publishedTimeOf(right);
        // A row with no usable date is not "oldest": it goes last instead of
        // sorting as though it had been published at the beginning of time.
        if (isNaN(a) || isNaN(b)) {
          return isNaN(a) && isNaN(b) ? 0 : isNaN(a) ? 1 : -1;
        }
        return b - a;
      });
    } else if (view.order === "name") {
      rows.sort(function (left, right) {
        return String(left.name).localeCompare(String(right.name), undefined, { numeric: true });
      });
    }
    // "relevance" is the registry's own order: those rows stay as they arrived.

    return rows;
  }

  /**
   * The installed packages keyed by their bare name.
   *
   * The settings hold a spec — `npm:name`, `npm:name@version`, or a git/local source —
   * and the catalogue lists the bare npm name, so the comparison is between the
   * parsed name and the row's. `package-rows.js` already knows how to split the
   * prefix and the pin off, so neither side strips them by hand.
   */
  function installedNames() {
    var entries = Array.isArray(state.values.packages) ? state.values.packages : [];
    var names = {};
    for (var index = 0; index < entries.length; index += 1) {
      var entry = entries[index];
      if (!entry || typeof entry.source !== "string") {
        continue;
      }
      var parsed = packageRows.parseSource(entry.source);
      if (parsed.name !== "") {
        names[parsed.name] = true;
      }
    }
    return names;
  }

  function renderCatalogRow(row, installed) {
    var tableRow = document.createElement("tr");

    var name = document.createElement("td");
    name.textContent = row.name;
    if (typeof row.version === "string" && row.version !== "") {
      name.title = row.name + "@" + row.version;
    }
    tableRow.appendChild(name);

    var description = document.createElement("td");
    description.textContent = typeof row.description === "string" ? row.description : "";
    tableRow.appendChild(description);

    var types = document.createElement("td");
    var tags = Array.isArray(row.tags) ? row.tags : [];
    for (var index = 0; index < tags.length; index += 1) {
      types.appendChild(createElement("span", "catalog-tag", String(tags[index])));
    }
    tableRow.appendChild(types);

    var downloads = document.createElement("td");
    downloads.textContent = formatDownloads(monthlyDownloadsOf(row));
    tableRow.appendChild(downloads);

    var published = document.createElement("td");
    published.textContent = publishedAgo(row.publishedAt);
    tableRow.appendChild(published);

    var repository = document.createElement("td");
    if (typeof row.repository === "string" && row.repository !== "") {
      var link = createElement("a", "catalog-link", "Repositorio");
      // The webview cannot navigate, so the target travels as data and the host
      // opens it: a stored URL must never become the anchor's own navigation.
      link.href = "#";
      link.setAttribute("data-href", row.repository);
      link.addEventListener("click", function (event) {
        event.preventDefault();
        send({ type: "openLink", href: row.repository });
      });
      repository.appendChild(link);
    } else {
      repository.textContent = "—";
    }
    tableRow.appendChild(repository);

    var action = document.createElement("td");
    if (installed[row.name] === true) {
      // An installed package is named as such and offers no button: installing it
      // again would be a no-op that looks like a working action.
      action.appendChild(createElement("span", "catalog-installed", "Ya instalado"));
    } else {
      var install = createElement("button", "catalog-install", "Instalar");
      install.type = "button";
      install.addEventListener("click", function () {
        send({ type: "catalogInstall", name: row.name });
      });
      action.appendChild(install);
    }
    tableRow.appendChild(action);
    return tableRow;
  }

  function renderCatalog() {
    var view = state.catalog;
    var pane = createElement("div", "catalog-pane");

    var search = createElement("div", "catalog-search");
    var input = document.createElement("input");
    input.type = "text";
    input.className = "settings-search-input";
    input.placeholder = "Buscar en el catálogo de pi";
    input.spellcheck = false;
    input.value = view.query;
    input.addEventListener("input", function () {
      // Only the draft is updated here: the search is explicit, so typing does not
      // fire a registry lookup per keystroke.
      view.query = input.value;
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        requestCatalogSearch();
      }
    });
    var searchButton = createElement("button", "catalog-search-button", "Buscar");
    searchButton.type = "button";
    searchButton.addEventListener("click", function () {
      requestCatalogSearch();
    });
    search.appendChild(input);
    search.appendChild(searchButton);
    pane.appendChild(search);

    // The loading line, the error line and the table are mutually exclusive: an
    // empty table under a failure the owner cannot see reads as a broken pane.
    if (view.loading) {
      pane.appendChild(createElement("p", "catalog-status", "Consultando el catálogo…"));
      elements.content.appendChild(pane);
      return;
    }
    if (view.error !== "") {
      pane.appendChild(createElement("p", "settings-error", view.error));
      elements.content.appendChild(pane);
      return;
    }

    // The filter and the order sit above the list, under the explicit search, and
    // the line under them states what they can and cannot reach.
    var controls = createElement("div", "catalog-controls");
    var typeSelect = createSelect(
      "setting-select",
      CATALOG_TYPE_FILTER_OPTIONS,
      view.type,
      function (value) {
        view.type = value;
        // The visible set changes, so the old page number means nothing.
        view.page = 1;
        paint();
      },
    );
    var orderSelect = createSelect(
      "setting-select",
      CATALOG_ORDER_OPTIONS,
      view.order,
      function (value) {
        view.order = value;
        // The rows are reordered, so the old page number means nothing.
        view.page = 1;
        paint();
      },
    );
    controls.appendChild(createLabel("Tipo", typeSelect));
    controls.appendChild(createLabel("Orden", orderSelect));
    pane.appendChild(controls);
    pane.appendChild(
      createElement(
        "p",
        "catalog-window-note",
        "Filtro y orden se aplican sobre los resultados ya cargados: el registro no ofrece filtro ni orden propios.",
      ),
    );

    var summary = createElement("div", "catalog-summary");
    pane.appendChild(summary);

    var tableWrapper = createElement("div", "catalog-table-wrapper");
    var table = createElement("table", "catalog-table");
    var tableHead = document.createElement("thead");
    var headRow = document.createElement("tr");
    var headers = ["Nombre", "Descripción", "Tipos", "Descargas", "Publicado", "Repositorio", "Acción"];
    for (var h = 0; h < headers.length; h += 1) {
      var header = document.createElement("th");
      header.textContent = headers[h];
      headRow.appendChild(header);
    }
    tableHead.appendChild(headRow);
    table.appendChild(tableHead);
    var body = document.createElement("tbody");
    table.appendChild(body);
    tableWrapper.appendChild(table);
    pane.appendChild(tableWrapper);

    var empty = createElement("p", "catalog-empty settings-empty", "No se encontraron paquetes.");
    empty.hidden = true;
    pane.appendChild(empty);

    var footer = createElement("div", "catalog-pagination");
    // The page-size list is the packages table's, so the two footers offer the same
    // sizes and the default is one of them.
    var sizeOptions = packageRows.PAGE_SIZES.slice();
    var sizeSelect = createSelect(
      "setting-select",
      sizeOptions.map(function (size) {
        return { value: String(size), label: String(size) };
      }),
      String(view.pageSize),
      function (value) {
        view.pageSize = Number(value);
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
    pane.appendChild(footer);

    function paintRows(page) {
      body.textContent = "";
      // No rows means no table: an empty body with a header row looks like a loading
      // failure, so the table gives way to the empty-state line.
      var isEmpty = page.items.length === 0;
      tableWrapper.hidden = isEmpty;
      empty.hidden = !isEmpty;

      var installed = installedNames();
      for (var index = 0; index < page.items.length; index += 1) {
        body.appendChild(renderCatalogRow(page.items[index], installed));
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
      var visible = visibleCatalogRows();
      current = packageRows.paginate(visible, { page: view.page, pageSize: view.pageSize });
      // paginate clamps: keeping the clamped page means a filter that leaves fewer
      // rows lands on the last page that exists instead of on an empty one.
      view.page = current.page;
      summary.textContent =
        view.rows.length + " resultados cargados de " + view.total + " en el registro";
      paintRows(current);
      paintFooter(current);
    }

    paint();
    elements.content.appendChild(pane);
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

    // Only the Packages section carries the second surface. Every other section
    // renders exactly the rows it always did, with no tab bar above them.
    if (selected.category.id === "paquetes") {
      renderPackagesTabs();
      if (state.packagesTab === "catalog") {
        renderCatalog();
        return;
      }
    }

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
        state.skills = Array.isArray(message.skills) ? message.skills : [];
        state.skillProblems = Array.isArray(message.skillProblems) ? message.skillProblems : [];
        state.packageFacts = Array.isArray(message.packageFacts) ? message.packageFacts : [];
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
      case "catalogState":
        state.catalog.loading = false;
        state.catalog.error = "";
        state.catalog.requested = true;
        state.catalog.rows = Array.isArray(message.rows) ? message.rows : [];
        state.catalog.total =
          typeof message.total === "number" ? message.total : state.catalog.rows.length;
        // A new result set starts at its first page.
        state.catalog.page = 1;
        renderContent();
        break;
      case "catalogError":
        state.catalog.loading = false;
        state.catalog.error =
          typeof message.message === "string" && message.message !== ""
            ? message.message
            : "No se pudo consultar el catálogo.";
        state.catalog.rows = [];
        state.catalog.total = 0;
        state.catalog.page = 1;
        renderContent();
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
