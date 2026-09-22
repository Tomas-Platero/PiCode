// PiCode's Gentle AI panel.
//
// Presentation only. The state, the lines it reads, the commands this session
// registered and the actions that can be run all come from the host, which builds
// them with the same functions the popup's Gentle AI category uses, so this panel
// and the popup cannot disagree about a value. Pressing a button asks the host to
// run it; the answer is a refreshed state or a line saying what failed.
(function () {
  "use strict";

  var vscode = acquireVsCodeApi();

  var elements = {
    logo: document.getElementById("logo"),
    summary: document.getElementById("summary"),
    notice: document.getElementById("notice"),
    lines: document.getElementById("lines"),
    commands: document.getElementById("commands"),
    actions: document.getElementById("actions"),
  };

  // The mark's address is host work: a webview cannot spell a URL into the
  // extension's own media directory, so it travels in the markup and is read back
  // out of it here.
  var logoUri = elements.logo ? elements.logo.getAttribute("data-gentle-logo") || "" : "";
  if (logoUri) {
    elements.logo.src = logoUri;
  }

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

  function clear(element) {
    element.textContent = "";
  }

  function showNotice(text) {
    elements.notice.textContent = typeof text === "string" ? text : "";
    elements.notice.hidden = elements.notice.textContent.length === 0;
  }

  function renderLines(lines) {
    clear(elements.lines);
    var list = Array.isArray(lines) ? lines : [];
    for (var index = 0; index < list.length; index += 1) {
      elements.lines.appendChild(createElement("div", "gentle-line", String(list[index])));
    }
  }

  // Not having commands is a state, not a failure: installed and loaded are two
  // different things, and the line says which of them the owner is looking at.
  function commandsMessage(state) {
    if (state && state.installed && !state.active) {
      return "gentle-pi está instalado, pero esta sesión no cargó sus comandos: reinicia pi.";
    }
    return "pi no informó de ningún comando de Gentle AI en esta sesión.";
  }

  function renderCommands(state, commands) {
    clear(elements.commands);
    var list = Array.isArray(commands) ? commands : [];
    if (list.length === 0) {
      elements.commands.appendChild(createElement("p", "gentle-empty", commandsMessage(state)));
      return;
    }
    for (var index = 0; index < list.length; index += 1) {
      var command = String(list[index]);
      var button = createElement("button", "gentle-command", command);
      button.type = "button";
      button.title = "Enviar " + command + " al agente como mensaje";
      button.addEventListener("click", runCommand(command));
      elements.commands.appendChild(button);
    }
  }

  function runCommand(command) {
    return function () {
      send({ type: "run", action: "command", command: command });
    };
  }

  function runAction(id) {
    return function () {
      send({ type: "run", action: id });
    };
  }

  function renderActions(actions) {
    clear(elements.actions);
    var list = Array.isArray(actions) ? actions : [];
    for (var index = 0; index < list.length; index += 1) {
      var action = list[index];
      var button = createElement("button", action.primary ? "gentle-action primary" : "gentle-action secondary");
      button.type = "button";
      button.appendChild(createElement("span", "gentle-action-label", action.label));
      if (action.detail) {
        button.appendChild(createElement("span", "gentle-action-detail", action.detail));
      }
      button.addEventListener("click", runAction(action.id));
      elements.actions.appendChild(button);
    }
  }

  function renderState(message) {
    var state = message.state && typeof message.state === "object" ? message.state : null;
    elements.summary.textContent =
      typeof message.summary === "string" && message.summary.length > 0
        ? message.summary
        : "leyendo…";
    renderLines(message.lines);
    renderCommands(state, message.commands);
    renderActions(message.actions);
    showNotice("");
  }

  function handleHostMessage(message) {
    if (!message || typeof message.type !== "string") {
      return;
    }
    switch (message.type) {
      case "state":
        renderState(message);
        break;
      case "error":
        showNotice(message.message);
        break;
      default:
        break;
    }
  }

  window.addEventListener("message", function (event) {
    handleHostMessage(event.data);
  });

  send({ type: "ready" });
})();
