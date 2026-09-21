// PiCode's sidebar panel: the live state, and the way into the popup.
//
// Presentation only. The category rows come from the host, built by the same
// function the popup uses, so this panel and the popup cannot disagree about a
// label or a value.
(function () {
  "use strict";

  var vscode = acquireVsCodeApi();

  var elements = {
    runtime: document.getElementById("card-runtime"),
    model: document.getElementById("card-model"),
    thinking: document.getElementById("card-thinking"),
    extensions: document.getElementById("card-extensions"),
    menu: document.getElementById("menu"),
    categories: document.getElementById("categories"),
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

  function renderCard(snapshot) {
    if (!snapshot || typeof snapshot !== "object") {
      return;
    }
    elements.runtime.textContent =
      snapshot.runtime + (snapshot.runtimeAvailable ? "" : " (no encontrado)");
    elements.model.textContent = snapshot.model || "sin modelo";
    elements.thinking.textContent = snapshot.reasoning || "no disponible";
    elements.extensions.textContent =
      typeof snapshot.installedCount === "number"
        ? String(snapshot.installedCount)
        : "contando…";
  }

  function openCategory(id) {
    return function () {
      send({ type: "openMenu", category: id });
    };
  }

  function renderCategories(rows) {
    elements.categories.textContent = "";
    for (var index = 0; index < rows.length; index += 1) {
      var row = rows[index];
      var button = createElement("button", "category");
      button.type = "button";
      button.appendChild(createElement("span", "category-label", row.label));
      if (row.description) {
        button.appendChild(createElement("span", "category-value", row.description));
      }
      button.addEventListener("click", openCategory(row.id));
      elements.categories.appendChild(button);
    }
  }

  function handleHostMessage(message) {
    if (!message || typeof message.type !== "string") {
      return;
    }
    switch (message.type) {
      case "state":
        renderCard(message.snapshot);
        renderCategories(Array.isArray(message.categories) ? message.categories : []);
        break;
      case "error":
        elements.runtime.textContent = message.message;
        break;
      default:
        break;
    }
  }

  elements.menu.addEventListener("click", function () {
    send({ type: "openMenu" });
  });
  window.addEventListener("message", function (event) {
    handleHostMessage(event.data);
  });

  send({ type: "ready" });
})();
