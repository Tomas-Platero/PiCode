// PiCode extensions view.
//
// Presentation only: the extension host runs the pi CLI and posts results here.
// Every piece of package text is inserted with textContent, never innerHTML, so a
// package description cannot inject markup.
(function () {
  "use strict";

  var vscode = acquireVsCodeApi();

  var elements = {
    tabInstalled: document.getElementById("tab-installed"),
    tabCatalog: document.getElementById("tab-catalog"),
    refresh: document.getElementById("refresh"),
    busy: document.getElementById("busy"),
    panelInstalled: document.getElementById("panel-installed"),
    panelCatalog: document.getElementById("panel-catalog"),
    installed: document.getElementById("installed"),
    installedSummary: document.getElementById("installed-summary"),
    installedRaw: document.getElementById("installed-raw"),
    searchForm: document.getElementById("search-form"),
    searchInput: document.getElementById("search-input"),
    catalog: document.getElementById("catalog"),
    catalogSummary: document.getElementById("catalog-summary"),
    logSection: document.getElementById("log-section"),
    log: document.getElementById("log"),
    logClear: document.getElementById("log-clear"),
  };

  var installed = [];
  // Sources stripped of their `npm:` prefix, so a catalogue entry can tell
  // whether it is already installed.
  var installedNames = {};
  var busy = false;

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

  function setBusy(value, label) {
    busy = Boolean(value);
    elements.busy.textContent = label || (busy ? "trabajando…" : "listo");
    elements.busy.className = "runtime-chip" + (busy ? " runtime-chip-busy" : "");
    elements.refresh.disabled = busy;
  }

  function appendLog(line) {
    elements.logSection.hidden = false;
    var prefix = elements.log.textContent ? "\n" : "";
    elements.log.textContent += prefix + line;
    elements.log.scrollTop = elements.log.scrollHeight;
  }

  function showTab(which) {
    var installedActive = which === "installed";
    elements.panelInstalled.hidden = !installedActive;
    elements.panelCatalog.hidden = installedActive;
    elements.tabInstalled.className = "tab" + (installedActive ? " tab-active" : "");
    elements.tabCatalog.className = "tab" + (installedActive ? "" : " tab-active");
    if (!installedActive) {
      elements.searchInput.focus();
    }
  }

  function nameFromSource(source) {
    return source.indexOf("npm:") === 0 ? source.slice(4) : source;
  }

  function describePackage(name, description, meta) {
    var item = createElement("li", "package");
    var head = createElement("div", "package-head");
    head.appendChild(createElement("span", "package-name", name));
    if (meta) {
      head.appendChild(createElement("span", "package-meta", meta));
    }
    item.appendChild(head);
    if (description) {
      item.appendChild(createElement("p", "package-description", description));
    }
    return item;
  }

  function actionButton(label, message, className) {
    var button = createElement("button", className || "secondary", label);
    button.type = "button";
    button.addEventListener("click", function () {
      send(message);
    });
    return button;
  }

  function renderInstalled() {
    elements.installed.textContent = "";

    if (installed.length === 0) {
      elements.installedSummary.textContent = "pi no informa de ninguna extensión instalada.";
      return;
    }

    elements.installedSummary.textContent =
      installed.length === 1 ? "1 extensión instalada" : installed.length + " extensiones instaladas";

    for (var index = 0; index < installed.length; index += 1) {
      var entry = installed[index];
      var item = describePackage(entry.source, entry.path || "", entry.scope);
      var actions = createElement("div", "package-actions");
      actions.appendChild(
        actionButton("Quitar", { type: "remove", source: entry.source }, "secondary"),
      );
      item.appendChild(actions);
      elements.installed.appendChild(item);
    }
  }

  function renderCatalog() {
    elements.catalog.textContent = "";

    if (catalog === undefined) {
      elements.catalogSummary.textContent = "";
      return;
    }

    if (catalog.length === 0) {
      elements.catalogSummary.textContent = "Nada en el catálogo coincide con esa búsqueda.";
      return;
    }

    elements.catalogSummary.textContent =
      catalog.length === 1 ? "1 paquete" : catalog.length + " paquetes";

    for (var index = 0; index < catalog.length; index += 1) {
      var pkg = catalog[index];
      var meta = [];
      if (pkg.version) {
        meta.push(pkg.version);
      }
      if (pkg.monthlyDownloads) {
        meta.push(Math.round(pkg.monthlyDownloads / 1000) + "k/mes");
      }

      var isInstalled = Boolean(installedNames[pkg.name]);
      var item = describePackage(
        pkg.name + (isInstalled ? "  ·  instalado" : ""),
        pkg.description,
        meta.join(" · "),
      );
      item.className = "package" + (isInstalled ? " package-installed" : "");

      var actions = createElement("div", "package-actions");
      actions.appendChild(
        isInstalled
          ? actionButton("Quitar", { type: "remove", source: "npm:" + pkg.name }, "secondary")
          : actionButton("Instalar", { type: "install", name: pkg.name }, "primary"),
      );
      item.appendChild(actions);
      elements.catalog.appendChild(item);
    }
  }

  function reconcile(catalogPackages) {
    catalog = catalogPackages;
    installedNames = {};
    for (var index = 0; index < installed.length; index += 1) {
      installedNames[nameFromSource(installed[index].source)] = true;
    }
    renderCatalog();
  }

  function handleHostMessage(message) {
    if (!message || typeof message.type !== "string") {
      return;
    }

    switch (message.type) {
      case "installed":
        installed = Array.isArray(message.packages) ? message.packages : [];
        elements.installedRaw.hidden = true;
        elements.installedRaw.textContent = "";
        if (installed.length === 0 && typeof message.raw === "string" && message.raw.trim()) {
          // An unrecognised format shows what pi actually printed, rather than an
          // empty list that reads as "nothing is installed".
          elements.installedRaw.textContent = message.raw.trim();
          elements.installedRaw.hidden = false;
        }
        renderInstalled();
        reconcile(catalog);
        break;
      case "catalog":
        reconcile(Array.isArray(message.packages) ? message.packages : []);
        break;
      case "busy":
        setBusy(message.busy, message.label);
        break;
      case "log":
        appendLog(String(message.line));
        break;
      case "error":
        appendLog("ERROR: " + message.message);
        break;
      default:
        break;
    }
  }

  function registerEvents() {
    elements.tabInstalled.addEventListener("click", function () {
      showTab("installed");
    });
    elements.tabCatalog.addEventListener("click", function () {
      showTab("catalog");
    });
    elements.refresh.addEventListener("click", function () {
      send({ type: "readInstalled" });
    });
    elements.searchForm.addEventListener("submit", function (event) {
      event.preventDefault();
      send({ type: "search", query: elements.searchInput.value });
    });
    elements.logClear.addEventListener("click", function () {
      elements.log.textContent = "";
      elements.logSection.hidden = true;
    });
    window.addEventListener("message", function (event) {
      handleHostMessage(event.data);
    });
  }

  var catalog;
  registerEvents();
  setBusy(false);
  send({ type: "ready" });
})();
