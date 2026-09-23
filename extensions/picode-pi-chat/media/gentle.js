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
    version: document.getElementById("version"),
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

  // The installed version against the published one, one line per package of the layer.
  // The wording is not written here: the three states — up to date, an update with its
  // version, or the check having failed — are phrased by the host, so the panel and the
  // popup describe the same situation the same way. A missing section is a webview from
  // a host that does not send it, and is left alone rather than filled with a guess.
  function renderVersion(version) {
    if (!elements.version) {
      return;
    }
    clear(elements.version);
    if (!version || typeof version !== "object") {
      return;
    }
    if (typeof version.headline === "string" && version.headline.length > 0) {
      elements.version.appendChild(
        createElement("p", "gentle-version-headline", version.headline),
      );
    }
    var lines = Array.isArray(version.lines) ? version.lines : [];
    for (var index = 0; index < lines.length; index += 1) {
      elements.version.appendChild(createElement("div", "gentle-line", String(lines[index])));
    }
  }

  // Not having commands is a state, not a failure: installed and loaded are two
  // different things, and the line says which of them the owner is looking at. It is
  // kept to one sentence because the fix travels with it as a button, drawn just below
  // by `renderCommands`.
  function commandsMessage(state) {
    if (state && state.installed && !state.active) {
      return "Esta sesión no cargó los comandos de Gentle AI.";
    }
    return "pi no informó de ningún comando de Gentle AI en esta sesión.";
  }

  // One action as a button, shared by the actions list and the restart drawn under the
  // line that asks for it: two buttons that run one id must look and behave the same.
  function actionButton(action) {
    var button = createElement(
      "button",
      action.primary ? "gentle-action primary" : "gentle-action secondary",
    );
    button.type = "button";
    button.appendChild(createElement("span", "gentle-action-label", action.label));
    if (action.detail) {
      button.appendChild(createElement("span", "gentle-action-detail", action.detail));
    }
    button.addEventListener("click", runAction(action.id));
    return button;
  }

  function restartAction(actions) {
    var list = Array.isArray(actions) ? actions : [];
    for (var index = 0; index < list.length; index += 1) {
      if (list[index] && list[index].id === "restart") {
        return list[index];
      }
    }
    return null;
  }

  function renderCommands(state, commands, actions) {
    clear(elements.commands);
    var list = Array.isArray(commands) ? commands : [];
    if (list.length === 0) {
      elements.commands.appendChild(createElement("p", "gentle-empty", commandsMessage(state)));
      // The instruction the empty line used to carry — "reinicia pi" — is a button, and
      // it sits next to the line it answers. Nothing is written here that the host did
      // not send: the label and the id are the action's own.
      var restart = restartAction(actions);
      if (restart) {
        elements.commands.appendChild(actionButton(restart));
      }
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
      // The restart is drawn under the missing-commands line it answers, so it is not
      // repeated here. It is only ever sent while the commands are missing, which is
      // exactly the state `renderCommands` draws it in.
      if (action && action.id === "restart") {
        continue;
      }
      elements.actions.appendChild(actionButton(action));
    }
  }

  function renderState(message) {
    var state = message.state && typeof message.state === "object" ? message.state : null;
    elements.summary.textContent =
      typeof message.summary === "string" && message.summary.length > 0
        ? message.summary
        : "leyendo…";
    renderLines(message.lines);
    renderVersion(message.version);
    renderCommands(state, message.commands, message.actions);
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
