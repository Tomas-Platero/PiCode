// PiCode chat webview renderer.
//
// Presentation only: the extension host owns the pi process and posts the
// protocol records here. Every piece of agent or user text is inserted with
// textContent, never innerHTML, so model output cannot inject markup.
(function () {
  "use strict";

  var vscode = acquireVsCodeApi();

  var elements = {
    status: document.getElementById("status"),
    session: document.getElementById("session"),
    messages: document.getElementById("messages"),
    toolSection: document.getElementById("tool-section"),
    tools: document.getElementById("tools"),
    form: document.getElementById("composer"),
    prompt: document.getElementById("prompt"),
    send: document.getElementById("send"),
    abort: document.getElementById("abort"),
    newSession: document.getElementById("new-session"),
    model: document.getElementById("model"),
    thinking: document.getElementById("thinking"),
    dropdown: document.getElementById("dropdown"),
    dropdownFilter: document.getElementById("dropdown-filter"),
    dropdownOptions: document.getElementById("dropdown-options"),
  };

  // Live assistant message being assembled from deltas. `message_update` is
  // delta-only (no cumulative snapshot), so text is accumulated here and
  // `message_end` replaces it with the authoritative message.
  var stream = null;
  // Locally echoed user message, replaced by pi's own message_start if it comes.
  var userEcho = null;
  // Last session state the host pushed, used to mark the current model and level.
  var lastState = null;
  // Catalogue pushed by the host, and the reasoning levels of the current model.
  var models = [];
  var thinkingLevels = [];
  // Which dropdown is open, the visible options, and the highlighted one.
  var openDropdown = null;
  var filteredOptions = [];
  var highlightedIndex = 0;

  // The panel is Spanish. The states stay English internally because they come
  // from the protocol and from the host's own status messages.
  var STATUS_LABELS = {
    idle: "en reposo",
    running: "trabajando",
    settled: "listo",
    error: "error",
  };
  var DETAIL_LABELS = { queued: "en cola", compacting: "compactando" };
  var ROLE_LABELS = { user: "tú", assistant: "pi", system: "sistema", error: "error" };
  // toolCallId -> { item, output }
  var toolItems = new Map();

  function send(message) {
    vscode.postMessage(message);
  }

  function setStatus(status, detail) {
    var label = STATUS_LABELS[status] || status;
    if (detail) {
      label += " \u2014 " + (DETAIL_LABELS[detail] || String(detail).replace(/^retry /, "reintento "));
    }
    elements.status.textContent = label;
    elements.status.className = "status status-" + status;
    elements.abort.disabled = status !== "running";
  }

  function scrollToBottom() {
    elements.messages.scrollTop = elements.messages.scrollHeight;
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

  function addMessage(role) {
    var article = createElement("article", "message message-" + role);
    article.appendChild(createElement("header", "message-role", ROLE_LABELS[role] || role));
    var body = createElement("div", "message-body");
    article.appendChild(body);
    elements.messages.appendChild(article);
    scrollToBottom();
    return { article: article, body: body };
  }

  function appendBlock(container, kind, text) {
    var block = createElement("div", "block block-" + kind);
    if (kind === "thinking") {
      block.appendChild(createElement("div", "block-label", "razonamiento"));
    }
    block.appendChild(createElement("div", "block-text", text));
    container.appendChild(block);
    scrollToBottom();
    return block;
  }

  function textFromContent(content) {
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }
    var parts = [];
    for (var index = 0; index < content.length; index += 1) {
      var part = content[index];
      if (part && part.type === "text" && typeof part.text === "string") {
        parts.push(part.text);
      } else if (part && part.type === "image") {
        parts.push("[image]");
      }
    }
    return parts.join("\n");
  }

  function formatToolCall(toolCall) {
    if (!toolCall || typeof toolCall !== "object") {
      return "";
    }
    var name = typeof toolCall.name === "string" ? toolCall.name : "tool";
    var args = "";
    try {
      args = JSON.stringify(toolCall.arguments || {});
    } catch {
      // Tool arguments are shown for context, so a value that cannot be
      // serialised is reported as empty rather than failing the render.
      args = "";
    }
    return name + " " + args;
  }

  function renderContent(container, content) {
    container.textContent = "";
    if (!Array.isArray(content)) {
      container.textContent = textFromContent(content);
      return;
    }
    for (var index = 0; index < content.length; index += 1) {
      var block = content[index];
      if (!block || typeof block !== "object") {
        continue;
      }
      if (block.type === "text") {
        appendBlock(container, "text", block.text || "");
      } else if (block.type === "thinking") {
        appendBlock(container, "thinking", block.thinking || "");
      } else if (block.type === "toolCall") {
        appendBlock(container, "toolcall", formatToolCall(block));
      }
    }
  }

  function ensureStream() {
    if (!stream) {
      stream = { view: addMessage("assistant"), blocks: {} };
    }
    return stream;
  }

  function blockFor(kind) {
    var current = ensureStream();
    var key = String(kind.index);
    if (!current.blocks[key]) {
      current.blocks[key] = appendBlock(current.view.body, kind.kind, kind.text || "");
    }
    return current.blocks[key].querySelector(".block-text");
  }

  function endStream() {
    stream = null;
  }

  function toolTextFromResult(result) {
    if (!result || typeof result !== "object") {
      return "";
    }
    var content = result.content;
    if (!Array.isArray(content)) {
      return "";
    }
    var parts = [];
    for (var index = 0; index < content.length; index += 1) {
      var item = content[index];
      if (item && typeof item.text === "string") {
        parts.push(item.text);
      }
    }
    return parts.join("\n");
  }

  function upsertTool(event, phase) {
    var item = toolItems.get(event.toolCallId);
    if (!item) {
      var listItem = createElement("li", "tool tool-running");
      listItem.appendChild(createElement("div", "tool-name", event.toolName || "herramienta"));
      var args = "";
      try {
        args = JSON.stringify(event.args || {});
      } catch {
        // Same reasoning as formatToolCall: never let display serialisation
        // take down the tool timeline.
        args = "";
      }
      listItem.appendChild(createElement("div", "tool-args", args));
      item = { item: listItem, output: createElement("pre", "tool-output", "") };
      listItem.appendChild(item.output);
      elements.tools.appendChild(listItem);
      toolItems.set(event.toolCallId, item);
      elements.toolSection.hidden = false;
    }

    if (phase !== "start") {
      var text = toolTextFromResult(event.partialResult || event.result);
      if (text) {
        item.output.textContent = text;
      }
    }

    item.item.className = "tool tool-" + (phase === "end" && event.isError ? "error" : phase);
    scrollToBottom();
    return item;
  }

  function showError(message) {
    setStatus("error");
    var view = addMessage("error");
    view.body.textContent = message;
  }

  function handleMessageEvent(message, phase) {
    var role = message && typeof message.role === "string" ? message.role : "assistant";

    if (role === "user") {
      // The user's message is echoed locally. `message_start` replaces the echo
      // with what was actually sent, and `message_end` describes that same
      // message again, so it must not add a second bubble.
      if (userEcho) {
        userEcho.body.textContent = textFromContent(message.content);
        userEcho = null;
      } else if (phase === "start") {
        var echo = addMessage("user");
        echo.body.textContent = textFromContent(message.content);
      }
      return;
    }

    if (role === "assistant") {
      // `message_start` opens the live stream; the deltas fill it and
      // `message_end` replaces it with the authoritative content. Closing the
      // stream here would leave an empty bubble behind and make every delta
      // open a second one.
      if (phase === "start") {
        ensureStream();
        return;
      }
      var view = ensureStream().view;
      renderContent(view.body, message.content);
      endStream();
      return;
    }

    // pi opens every turn with an empty internal `system` message; it is not
    // user-facing, so it is never rendered. The host's own session notes are a
    // separate path and stay. Any other role (toolResult, ...) arrives as a
    // start/end pair and renders once, on the authoritative end.
    if (phase === "start" || role === "system") {
      return;
    }
    var other = addMessage(role);
    other.body.textContent = textFromContent(message.content);
  }

  // --- delta types (payload of message_update) ------------------------------

  function applyDelta(delta) {
    if (!delta || typeof delta.type !== "string") {
      return;
    }
    var index = typeof delta.contentIndex === "number" ? delta.contentIndex : 0;
    switch (delta.type) {
      case "text_start":
        blockFor({ kind: "text", index: index });
        break;
      case "text_delta":
        blockFor({ kind: "text", index: index }).textContent += delta.delta || "";
        break;
      case "text_end":
        if (typeof delta.content === "string") {
          blockFor({ kind: "text", index: index }).textContent = delta.content;
        }
        break;
      case "thinking_start":
        blockFor({ kind: "thinking", index: index });
        break;
      case "thinking_delta":
        blockFor({ kind: "thinking", index: index }).textContent += delta.delta || "";
        break;
      case "thinking_end":
        if (typeof delta.content === "string") {
          blockFor({ kind: "thinking", index: index }).textContent = delta.content;
        }
        break;
      case "toolcall_start":
        blockFor({ kind: "toolcall", index: index, text: (delta.toolName || "tool") + " " });
        break;
      case "toolcall_delta":
        blockFor({ kind: "toolcall", index: index }).textContent += delta.delta || "";
        break;
      case "toolcall_end":
        if (delta.toolCall) {
          blockFor({ kind: "toolcall", index: index }).textContent = formatToolCall(delta.toolCall);
        }
        break;
      default:
        break;
    }
    scrollToBottom();
  }

  function handlePiEvent(event) {
    if (!event || typeof event.type !== "string") {
      return;
    }
    switch (event.type) {
      case "agent_start":
        setStatus("running");
        break;
      case "agent_settled":
        endStream();
        setStatus("settled");
        break;
      case "turn_start":
        setStatus("running");
        break;
      case "message_start":
        handleMessageEvent(event.message, "start");
        break;
      case "message_end":
        handleMessageEvent(event.message, "end");
        break;
      case "message_update":
        applyDelta(event.assistantMessageEvent);
        break;
      case "tool_execution_start":
        upsertTool(event, "start");
        break;
      case "tool_execution_update":
        upsertTool(event, "update");
        break;
      case "tool_execution_end":
        upsertTool(event, "end");
        break;
      case "queue_update":
        setStatus("running", "queued");
        break;
      case "compaction_start":
        setStatus("running", "compacting");
        break;
      case "auto_retry_start":
        setStatus("running", "retry " + event.attempt + "/" + event.maxAttempts);
        break;
      case "auto_retry_end":
        if (!event.success) {
          showError(event.finalError || "Automatic retry failed.");
        }
        break;
      case "extension_error":
        showError("Error de una extensión de pi: " + event.error);
        break;
      default:
        break;
    }
  }

  function handleHostMessage(message) {
    if (!message || typeof message.type !== "string") {
      return;
    }
    switch (message.type) {
      case "piEvent":
        handlePiEvent(message.event);
        break;
      case "status":
        setStatus(message.status);
        break;
      case "state":
        renderState(message.state, message.usage);
        break;
      case "models":
        models = Array.isArray(message.models) ? message.models : [];
        if (openDropdown === "model") {
          renderOptions();
        }
        break;
      case "thinkingLevels":
        thinkingLevels = Array.isArray(message.levels) ? message.levels : [];
        if (openDropdown === "thinking") {
          renderOptions();
        }
        break;
      case "error":
        showError(message.message);
        break;
      case "clear":
        elements.messages.textContent = "";
        elements.tools.textContent = "";
        elements.toolSection.hidden = true;
        toolItems.clear();
        stream = null;
        userEcho = null;
        setStatus("idle");
        break;
      case "note": {
        // A line from PiCode itself, not from the agent, so it is labelled as such.
        var note = addMessage("system");
        note.body.textContent = String(message.text ?? "");
        break;
      }
      default:
        break;
    }
  }

  function renderState(state, usageLine) {
    if (!state || typeof state !== "object") {
      return;
    }
    lastState = state;

    // The model and the reasoning level get their own chips, so the session line
    // carries only what those chips cannot say.
    elements.model.textContent = "Modelo: " + (state.modelName || state.model || "sin modelo");
    var modelDetail = [];
    if (state.model) {
      modelDetail.push(state.model);
    }
    if (state.provider) {
      modelDetail.push("proveedor: " + state.provider);
    }
    modelDetail.push("");
    modelDetail.push("Pulsa para elegir el modelo.");
    elements.model.title = modelDetail.join("\n");

    elements.thinking.textContent = "razonamiento: " + (state.thinkingLevel || "no disponible");
    elements.thinking.title =
      "Nivel de razonamiento del modelo actual.\nPulsa para cambiarlo; algunos niveles solo existen para algunos modelos.";

    var parts = [];
    if (typeof state.messageCount === "number") {
      parts.push(state.messageCount + " mensajes");
    }
    if (typeof state.pendingMessageCount === "number" && state.pendingMessageCount > 0) {
      parts.push(state.pendingMessageCount + " en cola");
    }
    if (state.sessionName) {
      parts.push(state.sessionName);
    }
    // The cost line is formatted by the host, which owns the totals.
    if (usageLine) {
      parts.push(usageLine);
    }

    elements.session.textContent = parts.join(" · ");
  }

  // --- model and reasoning dropdowns --------------------------------------
  //
  // These two controls belong to the panel, so each gets its own dropdown
  // instead of the editor-wide quick pick the palette commands use: the session
  // settings live next to the composer, and a popup at the top of the window
  // separates the list from the control that opened it.
  //
  // The model list runs to hundreds of entries, so it carries a filter box. The
  // reasoning list is seven items, where a filter would be noise.

  function closeDropdown() {
    if (!openDropdown) {
      return;
    }
    var previous = elements[openDropdown];
    openDropdown = null;
    elements.dropdown.hidden = true;
    elements.dropdownFilter.value = "";
    elements.dropdownOptions.textContent = "";
    if (previous) {
      previous.classList.remove("dropdown-open");
    }
  }

  function buildOptions() {
    var options = [];
    if (openDropdown === "model") {
      for (var index = 0; index < models.length; index += 1) {
        var model = models[index];
        var traits = [];
        if (model.provider) {
          traits.push(model.provider);
        }
        if (model.reasoning) {
          traits.push("razonamiento");
        }
        options.push({
          label: model.name || model.id,
          hint: model.id + (traits.length ? "  " + traits.join(" " + String.fromCharCode(183) + " ") : ""),
          current: Boolean(lastState && model.id === lastState.model),
          message: { type: "setModel", modelId: model.id, provider: model.provider },
        });
      }
      return options;
    }

    if (openDropdown === "thinking") {
      for (var level = 0; level < thinkingLevels.length; level += 1) {
        var value = thinkingLevels[level];
        options.push({
          label: value,
          hint: lastState && value === lastState.thinkingLevel ? "actual" : "",
          current: Boolean(lastState && value === lastState.thinkingLevel),
          message: { type: "setThinkingLevel", level: value },
        });
      }
    }
    return options;
  }

  function visibleOptions() {
    var all = buildOptions();
    var needle = elements.dropdownFilter.value.trim().toLowerCase();
    if (!needle) {
      return all;
    }
    var matches = [];
    for (var index = 0; index < all.length; index += 1) {
      var haystack = (all[index].label + " " + all[index].hint).toLowerCase();
      if (haystack.indexOf(needle) >= 0) {
        matches.push(all[index]);
      }
    }
    return matches;
  }

  function renderOptions() {
    var options = visibleOptions();
    filteredOptions = options;
    if (highlightedIndex >= options.length) {
      highlightedIndex = 0;
    }

    elements.dropdownOptions.textContent = "";
    if (options.length === 0) {
      elements.dropdownOptions.appendChild(
        createElement("li", "dropdown-empty", 'nada coincide con "' + elements.dropdownFilter.value + '"'),
      );
      return;
    }

    for (var index = 0; index < options.length; index += 1) {
      var option = options[index];
      var className = "dropdown-option";
      if (index === highlightedIndex) {
        className += " highlighted";
      }
      if (option.current) {
        className += " current";
      }

      var item = createElement("li", className);
      item.appendChild(createElement("span", "dropdown-option-label", option.label));
      if (option.hint) {
        item.appendChild(createElement("span", "dropdown-option-hint", option.hint));
      }
      item.addEventListener("click", chooseOptionFor(option));
      elements.dropdownOptions.appendChild(item);
    }

    var highlighted = elements.dropdownOptions.children[highlightedIndex];
    if (highlighted && highlighted.scrollIntoView) {
      highlighted.scrollIntoView({ block: "nearest" });
    }
  }

  function chooseOptionFor(option) {
    return function () {
      send(option.message);
      closeDropdown();
    };
  }

  function openDropdownFor(kind) {
    if (openDropdown === kind) {
      closeDropdown();
      return;
    }
    closeDropdown();

    openDropdown = kind;
    highlightedIndex = 0;
    elements.dropdownFilter.hidden = kind !== "model";
    elements.dropdown.hidden = false;
    elements[kind].classList.add("dropdown-open");
    renderOptions();

    if (kind === "model") {
      elements.dropdownFilter.focus();
    } else {
      elements.dropdownOptions.focus();
    }
  }

  function moveHighlight(delta) {
    if (!openDropdown || filteredOptions.length === 0) {
      return;
    }
    highlightedIndex =
      (highlightedIndex + delta + filteredOptions.length) % filteredOptions.length;
    renderOptions();
  }

  function onDropdownKeydown(event) {
    if (!openDropdown) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeDropdown();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (filteredOptions[highlightedIndex]) {
        chooseOptionFor(filteredOptions[highlightedIndex])();
      }
    }
  }

  function submitPrompt() {
    var text = elements.prompt.value;
    if (!text.trim()) {
      return;
    }
    // Local echo; pi's own user message_start replaces this element.
    var echo = addMessage("user");
    echo.body.textContent = text;
    userEcho = echo;

    elements.prompt.value = "";
    setStatus("running");
    send({ type: "prompt", text: text });
  }

  function registerEvents() {
    elements.form.addEventListener("submit", function (event) {
      event.preventDefault();
      submitPrompt();
    });

    elements.prompt.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitPrompt();
      }
    });

    elements.abort.addEventListener("click", function () {
      send({ type: "abort" });
    });

    elements.newSession.addEventListener("click", function () {
      send({ type: "newSession" });
    });

    elements.model.addEventListener("click", function () {
      openDropdownFor("model");
    });

    elements.thinking.addEventListener("click", function () {
      openDropdownFor("thinking");
    });

    elements.dropdownFilter.addEventListener("input", function () {
      highlightedIndex = 0;
      renderOptions();
    });
    elements.dropdownFilter.addEventListener("keydown", onDropdownKeydown);
    elements.dropdownOptions.addEventListener("keydown", onDropdownKeydown);

    window.addEventListener("message", function (event) {
      handleHostMessage(event.data);
    });
  }

  registerEvents();
  setStatus("idle");
  send({ type: "ready" });
})();
