// PiCode chat webview renderer.
//
// Presentation only: the extension host owns the pi process and posts the
// protocol records here. Agent text is rendered through `PiCodeMarkdown`, which
// escapes before it formats, so model output reaches the DOM as markup only when
// the renderer wrote it. Reasoning and every other string stay textContent.
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
    restart: document.getElementById("restart"),
    menu: document.getElementById("menu"),
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
  // The icon that identifies each speaker, from the editor's own codicon set.
  var ROLE_ICONS = { user: "account", assistant: "hubot", system: "info", error: "error" };
  // How each tool outcome reads at a glance, and whether its glyph turns.
  var TOOL_OUTCOMES = {
    running: { glyph: "loading", spinning: true },
    end: { glyph: "check", spinning: false },
    error: { glyph: "error", spinning: false },
  };
  // The openers offered while the transcript is empty, in the panel's language.
  var SUGGESTIONS = [
    "Expl\u00edcame qu\u00e9 hace este proyecto",
    "Busca errores en el archivo abierto",
    "A\u00f1ade pruebas a lo \u00faltimo que cambi\u00e9",
  ];
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

  // The codicon class pair is written in one place so a rename cannot leave a
  // half-named glyph behind.
  function codicon(name) {
    return createElement("span", "codicon codicon-" + name);
  }

  function addMessage(role) {
    // The explanation of the panel is only true while there is nothing else here.
    var empty = elements.messages.querySelector(".empty");
    if (empty) {
      elements.messages.removeChild(empty);
    }

    var article = createElement("article", "message message-" + role);
    var header = createElement("header", "message-role");
    header.appendChild(codicon(ROLE_ICONS[role] || "comment-discussion"));
    header.appendChild(createElement("span", "message-role-name", ROLE_LABELS[role] || role));
    article.appendChild(header);
    var body = createElement("div", "message-body");
    article.appendChild(body);
    elements.messages.appendChild(article);
    scrollToBottom();
    return { article: article, body: body };
  }

  function appendBlock(container, kind, text) {
    var block = createElement("div", "block block-" + kind);
    if (kind === "thinking") {
      var label = createElement("div", "block-label");
      label.appendChild(codicon("lightbulb"));
      label.appendChild(createElement("span", null, "razonamiento"));
      block.appendChild(label);
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

  /**
   * Puts the renderer's output into a block.
   *
   * The string is parsed detached and its nodes are moved in, rather than assigned
   * to `innerHTML`. `renderMarkdown` escapes every character of the reply before
   * it writes a tag, so the fragment contains only markup this repository wrote;
   * parsing it detached means nothing can run on the way in either, which is what
   * the assignment form cannot promise to a reader.
   */
  function insertMarkdown(container, text) {
    var parsed = new DOMParser().parseFromString(
      globalThis.PiCodeMarkdown.renderMarkdown(text),
      "text/html",
    );
    container.textContent = "";
    while (parsed.body.firstChild) {
      container.appendChild(parsed.body.firstChild);
    }
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
        // Agent replies are markdown by convention, so the text block is filled by
        // the renderer. Reasoning stays plain text: it is not markdown, and
        // formatting it would misrepresent it.
        var textBlock = appendBlock(container, "text", block.text || "");
        insertMarkdown(textBlock.querySelector(".block-text"), block.text || "");
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

  /**
   * Gives a tool row the glyph of its outcome without hand-writing the class pair.
   *
   * The icon node is replaced rather than renamed, because the class pair is built
   * in one place (`codicon`) and a second place that writes it is a second place to
   * forget. Only a glyph change replaces the node, so an in-flight tool keeps the
   * same spinning icon instead of restarting its animation on every update.
   */
  function setToolStatus(item, name, spinning) {
    var icon = codicon(name);
    icon.classList.add("tool-status");
    if (spinning) {
      icon.classList.add("codicon-modifier-spin");
    }
    item.item.replaceChild(icon, item.status);
    item.status = icon;
    item.glyph = name;
  }

  function upsertTool(event, phase) {
    var item = toolItems.get(event.toolCallId);
    if (!item) {
      var listItem = createElement("li", "tool tool-running");
      var status = codicon("loading");
      status.classList.add("tool-status", "codicon-modifier-spin");
      listItem.appendChild(status);
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
      item = {
        item: listItem,
        status: status,
        glyph: "loading",
        output: createElement("pre", "tool-output", ""),
      };
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

    // The row says what happened in one glyph and one class: spinning while it
    // runs, a check when it finished, an error mark when it failed.
    var outcome = phase === "end" ? (event.isError ? "error" : "end") : "running";
    item.item.className = "tool tool-" + outcome;
    if (item.glyph !== TOOL_OUTCOMES[outcome].glyph) {
      setToolStatus(item, TOOL_OUTCOMES[outcome].glyph, TOOL_OUTCOMES[outcome].spinning);
    }
    scrollToBottom();
    return item;
  }

  /**
   * Fills an icon+text chip without disturbing the icon that shares the button.
   *
   * The label lives in its own span, so writing the button's textContent would
   * delete the codicon the markup put there.
   */
  function setChipText(button, text) {
    var label = button.querySelector(".chip-text");
    if (label) {
      label.textContent = text;
    }
  }

  /**
   * Explains the panel while the transcript has no messages.
   *
   * It is an ordinary element of the transcript, so `addMessage` removes it and
   * `clear` puts it back: a new session starts the way a fresh panel does. The
   * buttons fill the composer and stop there, because the owner should be able to
   * edit an opener before spending a turn on it.
   */
  function renderEmptyState() {
    var empty = createElement("article", "empty");
    empty.appendChild(codicon("hubot"));
    empty.appendChild(createElement("h2", null, "P\u00eddele algo a pi"));
    empty.appendChild(
      createElement(
        "p",
        null,
        "Escribe abajo y pi trabaja en este proyecto: lee archivos, ejecuta comandos y edita c\u00f3digo. Los botones solo rellenan el texto.",
      ),
    );

    for (var index = 0; index < SUGGESTIONS.length; index += 1) {
      var suggestion = SUGGESTIONS[index];
      var button = createElement("button", "suggestion", suggestion);
      button.type = "button";
      button.addEventListener("click", fillPrompt(suggestion));
      empty.appendChild(button);
    }

    elements.messages.appendChild(empty);
  }

  function fillPrompt(text) {
    return function () {
      elements.prompt.value = text;
      elements.prompt.focus();
    };
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
        renderEmptyState();
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
    setChipText(elements.model, "Modelo: " + (state.modelName || state.model || "sin modelo"));
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

    setChipText(elements.thinking, "razonamiento: " + (state.thinkingLevel || "no disponible"));
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

  /**
   * One click listener for the whole transcript.
   *
   * The blocks are created as replies stream in and are replaced on every
   * authoritative message, so a per-button listener would have to be re-attached
   * on each replacement. Delegating to the container survives that.
   */
  function onMessagesClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") {
      return;
    }

    var copyButton = target.closest(".code-block-copy");
    if (copyButton) {
      var block = copyButton.closest(".code-block");
      var pre = block ? block.querySelector(".code-block-body") : null;
      if (!pre || !navigator.clipboard) {
        return;
      }
      // The rejection handler is passed to `then` rather than left to a trailing
      // `catch`, so a denied clipboard permission can never surface as an
      // unhandled rejection in the host.
      navigator.clipboard.writeText(pre.textContent || "").then(
        function () {
          copyButton.className = "code-block-copy codicon codicon-check";
          window.setTimeout(function () {
            copyButton.className = "code-block-copy codicon codicon-copy";
          }, 1500);
        },
        function (error) {
          showError("No se pudo copiar el código: " + (error && error.message ? error.message : error));
        },
      );
      return;
    }

    var link = target.closest(".md-link");
    if (link) {
      event.preventDefault();
      var href = link.getAttribute("data-href");
      if (href) {
        send({ type: "openLink", href: href });
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

    elements.restart.addEventListener("click", function () {
      send({ type: "restart" });
    });

    elements.menu.addEventListener("click", function () {
      send({ type: "openMenu" });
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

    elements.messages.addEventListener("click", onMessagesClick);

    window.addEventListener("message", function (event) {
      handleHostMessage(event.data);
    });
  }

  registerEvents();
  setStatus("idle");
  send({ type: "ready" });
  if (!elements.messages.firstChild) {
    renderEmptyState();
  }
})();
