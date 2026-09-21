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
    attachments: document.getElementById("attachments"),
    attach: document.getElementById("attach"),
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
  // What the panel does with the model's reasoning, pushed with the session
  // state: `collapsed` (one line that opens), `expanded`, or `hidden`.
  var reasoningMode = "collapsed";
  // Catalogue pushed by the host, and the reasoning levels of the current model.
  var models = [];
  var thinkingLevels = [];
  // Which dropdown is open, the visible options, and the highlighted one.
  var openDropdown = null;
  var filteredOptions = [];
  var highlightedIndex = 0;

  // The panel is Spanish. The states stay English internally because they come
  // from the protocol and from the host's own status messages.
  //
  // `idle` has no label on purpose. Nothing running is the absence of a badge, the
  // way the editor's own surfaces report it, so there is no word meaning "idle" to
  // translate — a label here only invited the question of what it meant. The two
  // details below are suffixes on a state that is already showing.
  var STATUS_LABELS = {
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
  // Prepared images the host has accepted, in the order they arrived. Only the
  // host holds their bytes: a chip carries the id it was given and the thumbnail
  // the host drew, and submitting sends those ids back rather than the image.
  var attachments = [];
  // The full-size image currently open, if any.
  var overlay = null;

  function send(message) {
    vscode.postMessage(message);
  }

  function setStatus(status, detail) {
    // Nothing running shows no badge at all: the absence is the signal, and a
    // state badge that reads "fine, nothing is happening" is noise in a sidebar.
    if (status === "idle") {
      elements.status.hidden = true;
      elements.abort.disabled = true;
      return;
    }

    var label = STATUS_LABELS[status] || status;
    if (detail) {
      label += " \u2014 " + (DETAIL_LABELS[detail] || String(detail).replace(/^retry /, "reintento "));
    }
    elements.status.hidden = false;
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
    block.appendChild(createElement("div", "block-text", text));
    container.appendChild(block);
    scrollToBottom();
    return block;
  }

  /** Keeps the reasoning disposition to the three the setting declares. */
  function normalizeReasoningMode(value) {
    return value === "expanded" || value === "hidden" ? value : "collapsed";
  }

  /**
   * Builds a reasoning block: a summary row the owner can click, and the trace.
   *
   * Reasoning is collapsed by default because a whole scratchpad in the middle of
   * the transcript buries the reply it was meant to produce. The summary carries a
   * live character count while the block is still being written, so a model that
   * has been thinking for a while does not look like a stalled panel.
   *
   * The open/closed choice lives on the block, not in a global flag: a block the
   * owner opens while it is still streaming stays open, and no delta rewrites it.
   * Returns null when the panel is set to hide reasoning, so nothing is created.
   */
  function appendThinking(container, text, streaming, expandedOverride) {
    if (reasoningMode === "hidden") {
      // `hidden` means no element at all: a block that clipped itself would still
      // receive every delta and would still be there to be found.
      return null;
    }
    var block = createElement("div", "block block-thinking");
    var expanded =
      typeof expandedOverride === "boolean" ? expandedOverride : reasoningMode === "expanded";

    var summary = createElement("button", "block-thinking-summary");
    summary.type = "button";
    var chevron = codicon(expanded ? "chevron-down" : "chevron-right");
    summary.appendChild(chevron);
    var label = createElement("span", "block-thinking-label");
    summary.appendChild(label);
    block.appendChild(summary);

    var body = createElement("div", "block-text", text || "");
    block.appendChild(body);

    block.__summary = summary;
    block.__chevron = chevron;
    block.__label = label;
    block.__body = body;
    block.__expanded = expanded;
    block.__streaming = streaming;
    updateThinkingSummary(block);

    summary.addEventListener("click", function () {
      block.__expanded = !block.__expanded;
      updateThinkingSummary(block);
    });

    container.appendChild(block);
    scrollToBottom();
    return block;
  }

  /**
   * Redraws one reasoning summary from that block's own remembered state.
   *
   * Only the label's count moves while streaming; `__expanded` belongs to the
   * owner, so nothing here reads it from the stream or writes it on a delta.
   */
  function updateThinkingSummary(block) {
    var expanded = Boolean(block.__expanded);
    block.classList.toggle("block-thinking-open", expanded);
    block.classList.toggle("block-thinking-collapsed", !expanded);
    block.__summary.setAttribute("aria-expanded", expanded ? "true" : "false");
    block.__chevron.className = "codicon codicon-" + (expanded ? "chevron-down" : "chevron-right");
    updateThinkingLabel(block);
  }

  /** The label, with the live count only while collapsed and still being written. */
  function updateThinkingLabel(block) {
    if (block.__streaming && !block.__expanded) {
      block.__label.textContent =
        "razonamiento \u00b7 " + formatCount(block.__body.textContent.length) + " caracteres";
      return;
    }
    block.__label.textContent = "razonamiento";
  }

  /**
   * Spanish digit grouping for the live count.
   *
   * Written out rather than taken from `toLocaleString`, because the webview's
   * locale is the editor's, not the panel's, and the panel is Spanish here.
   */
  function formatCount(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  /**
   * The open/closed choice the owner made for a reasoning block being rebuilt.
   *
   * `message_end` replaces the streamed body with the authoritative content, so
   * without this a block opened mid-stream would snap shut as the turn ends.
   */
  function streamedThinkingExpanded(index) {
    var block = stream && stream.blocks[String(index)];
    return block && typeof block.__expanded === "boolean" ? block.__expanded : undefined;
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
      }
      // An image block contributes no text at all: it is drawn as a figure, and a
      // message that is only an image must not also read "image" underneath it.
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

  /**
   * The source of one image block.
   *
   * The local echo already holds the data URL the host drew the thumbnail from;
   * pi's own message carries the bytes and their media type apart. Both forms end
   * up as the same URL, so the record looks the same whichever side drew it.
   */
  function imageSource(block) {
    if (typeof block.dataUrl === "string" && block.dataUrl) {
      return block.dataUrl;
    }
    return "data:" + block.mimeType + ";base64," + block.data;
  }

  function messageImage(block) {
    var figure = createElement("figure", "message-image");
    var image = createElement("img");
    image.src = imageSource(block);
    image.alt = "imagen adjunta";
    figure.appendChild(image);
    return figure;
  }

  /**
   * The echo's stand-in for an audio attachment.
   *
   * An audio attachment reaches pi as its transcript, so there are no bytes to
   * draw; the glyph and the file's name are the whole record of what was sent. The
   * figure is deliberately not `.message-image`: the one click handler that opens
   * the overlay keys on `.message-image img`, so staying out of that class is what
   * keeps this indicator from opening a view it has nothing to fill.
   */
  function messageAudio(block) {
    var figure = createElement("figure", "message-audio");
    figure.appendChild(codicon("music"));
    figure.appendChild(
      createElement("span", "message-audio-name", block.name || "audio adjunto"),
    );
    return figure;
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
        appendThinking(container, block.thinking || "", false, streamedThinkingExpanded(index));
      } else if (block.type === "toolCall") {
        appendBlock(container, "toolcall", formatToolCall(block));
      } else if (block.type === "image") {
        container.appendChild(messageImage(block));
      } else if (block.type === "audio") {
        container.appendChild(messageAudio(block));
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
    if (kind.kind === "thinking" && reasoningMode === "hidden") {
      return null;
    }
    var current = ensureStream();
    var key = String(kind.index);
    if (!current.blocks[key]) {
      current.blocks[key] =
        kind.kind === "thinking"
          ? appendThinking(current.view.body, kind.text || "", true)
          : appendBlock(current.view.body, kind.kind, kind.text || "");
    }
    var block = current.blocks[key];
    return block ? block.querySelector(".block-text") : null;
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
        renderContent(userEcho.body, message.content);
        userEcho = null;
      } else if (phase === "start") {
        var echo = addMessage("user");
        renderContent(echo.body, message.content);
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
      case "thinking_delta": {
        var reasoningBody = blockFor({ kind: "thinking", index: index });
        if (reasoningBody) {
          reasoningBody.textContent += delta.delta || "";
          // Only the count moves while streaming. The block's open/closed state
          // is the owner's, so a delta never touches `__expanded`.
          var deltaBlock = stream && stream.blocks[String(index)];
          if (deltaBlock) {
            updateThinkingLabel(deltaBlock);
          }
        }
        break;
      }
      case "thinking_end": {
        var reasoningEnded = blockFor({ kind: "thinking", index: index });
        if (reasoningEnded) {
          if (typeof delta.content === "string") {
            reasoningEnded.textContent = delta.content;
          }
          var endedBlock = stream && stream.blocks[String(index)];
          if (endedBlock) {
            endedBlock.__streaming = false;
            updateThinkingSummary(endedBlock);
          }
        }
        break;
      }
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
        reasoningMode = normalizeReasoningMode(message.reasoning);
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
      case "attachments": {
        var added = Array.isArray(message.added) ? message.added : [];
        for (var addedIndex = 0; addedIndex < added.length; addedIndex += 1) {
          attachments.push(added[addedIndex]);
        }
        renderAttachments();
        // One place reports trouble: a file the host would not take comes back as
        // a refusal, and the transcript is where a failure is already reported.
        var refused = Array.isArray(message.refused) ? message.refused : [];
        for (var refusedIndex = 0; refusedIndex < refused.length; refusedIndex += 1) {
          var refusal = refused[refusedIndex] || {};
          showError(
            (refusal.name ? refusal.name + ": " : "") +
              (refusal.reason || "No se pudo adjuntar la imagen."),
          );
        }
        break;
      }
      case "attachmentsCleared":
        attachments = [];
        renderAttachments();
        break;
      case "clear":
        elements.messages.textContent = "";
        elements.tools.textContent = "";
        elements.toolSection.hidden = true;
        toolItems.clear();
        stream = null;
        userEcho = null;
        attachments = [];
        renderAttachments();
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
      return;
    }

    var image = target.closest(".message-image img");
    if (image) {
      openImageOverlay(image.src);
    }
  }

  // --- attachments ---------------------------------------------------------
  //
  // The host owns the bytes: it is the side that can run pi's image tools, and an
  // id is all the webview needs to hand back. So the panel draws the thumbnail it
  // was given with the id beside it, and a prompt carries ids.

  function isImageFile(file) {
    return Boolean(file) && typeof file.type === "string" && file.type.indexOf("image/") === 0;
  }

  function hasImageFile(files) {
    if (!files || files.length === 0) {
      return false;
    }
    for (var index = 0; index < files.length; index += 1) {
      if (isImageFile(files[index])) {
        return true;
      }
    }
    return false;
  }

  /**
   * Reads one file into the two fields the host's protocol carries.
   *
   * A data URL is the only reader the webview has, and the protocol wants the
   * payload and its media type apart: the part after the comma is the data and the
   * part before the semicolon is the type. A payload with no type is dropped rather
   * than posted as a guess.
   */
  function readImageFile(file, callback) {
    var reader = new FileReader();
    reader.addEventListener("load", function () {
      var result = typeof reader.result === "string" ? reader.result : "";
      var comma = result.indexOf(",");
      var head = comma < 0 ? "" : result.slice(0, comma);
      var colon = head.indexOf(":");
      var semicolon = head.indexOf(";");
      if (colon < 0 || semicolon < colon) {
        callback(null);
        return;
      }
      callback({
        data: result.slice(comma + 1),
        mimeType: head.slice(colon + 1, semicolon),
        name: file.name || "imagen",
      });
    });
    reader.addEventListener("error", function () {
      callback(null);
    });
    reader.readAsDataURL(file);
  }

  /** Posts the bytes a paste or a drop carries, once every file has been read. */
  function postImageFiles(files) {
    if (!files || files.length === 0) {
      return;
    }

    var wanted = [];
    for (var index = 0; index < files.length; index += 1) {
      if (isImageFile(files[index])) {
        wanted.push(files[index]);
      }
    }
    if (wanted.length === 0) {
      return;
    }

    var images = [];
    var remaining = wanted.length;
    for (var position = 0; position < wanted.length; position += 1) {
      readImageFile(wanted[position], function (image) {
        if (image) {
          images.push(image);
        }
        remaining -= 1;
        // One message per interaction: the host answers a batch with a single
        // `attachments` record, so one post per file would draw several answers.
        if (remaining === 0 && images.length > 0) {
          send({ type: "attachBytes", images: images });
        }
      });
    }
  }

  /**
   * The composer keeps its text when a paste carries no file.
   *
   * `preventDefault` on ordinary text would stop it from ever arriving, so it is
   * only called once a file is known to be there. That is what keeps the pasted
   * image from also being inserted as text without breaking the composer.
   */
  function onPromptPaste(event) {
    var files = event.clipboardData ? event.clipboardData.files : null;
    if (!hasImageFile(files)) {
      return;
    }
    event.preventDefault();
    postImageFiles(files);
  }

  function onBodyDragOver(event) {
    event.preventDefault();
    document.body.classList.add("drop-active");
  }

  function onBodyDragLeave() {
    document.body.classList.remove("drop-active");
  }

  /**
   * A drop is taken anywhere in the panel.
   *
   * The default is always stopped: without it the webview navigates to the dropped
   * file, which would take the conversation with it. A drop that carries no image
   * simply attaches nothing.
   */
  function onBodyDrop(event) {
    event.preventDefault();
    document.body.classList.remove("drop-active");
    postImageFiles(event.dataTransfer ? event.dataTransfer.files : null);
  }

  /** `160\u00d7120`, and a word when the host had to shrink the image. */
  function describeAttachment(image) {
    return image.width + "\u00d7" + image.height + (image.resized ? " \u00b7 reducida" : "");
  }

  /**
   * One chip per attachment, drawn by kind.
   *
   * An image chip is the thumbnail the host drew plus the size line it always
   * carried. An audio chip stands for a finished transcript, so it has no bytes to
   * draw and no size to report: the glyph, the file's name and the host's own line
   * take the thumbnail's place. Nothing here reads `dataUrl` for audio, and the
   * modifier class is what keeps that chip from looking clickable.
   */
  function renderAttachments() {
    elements.attachments.textContent = "";
    elements.attachments.hidden = attachments.length === 0;

    for (var index = 0; index < attachments.length; index += 1) {
      var added = attachments[index];
      var isAudio = added.kind === "audio";
      var chip = createElement("figure", isAudio ? "attachment attachment-audio" : "attachment");

      if (isAudio) {
        chip.appendChild(codicon("music"));
        chip.appendChild(createElement("span", "attachment-name", added.name || "audio"));
        chip.appendChild(createElement("figcaption", null, added.detail || ""));
      } else {
        var preview = createElement("img");
        preview.src = added.dataUrl;
        preview.alt = "";
        chip.appendChild(preview);
        chip.appendChild(createElement("figcaption", null, describeAttachment(added)));
      }

      var remove = createElement("button", "attachment-remove codicon codicon-close");
      remove.type = "button";
      remove.title = "Quitar";
      remove.setAttribute("aria-label", "Quitar");
      // The id travels on the button so the one delegated listener can read it
      // back without a closure per chip.
      remove.setAttribute("data-attachment-id", added.id);
      chip.appendChild(remove);

      elements.attachments.appendChild(chip);
    }
  }

  /**
   * One listener for the whole row.
   *
   * The row is redrawn whenever the list changes, so a listener per chip would be
   * re-attached on every redraw; a listener on the container survives it.
   */
  function onAttachmentsClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") {
      return;
    }

    var remove = target.closest(".attachment-remove");
    if (remove) {
      send({ type: "detachAttachment", id: remove.getAttribute("data-attachment-id") });
      return;
    }

    // Only an image chip has a full-size view to open. An audio chip is never
    // sent down this path: the overlay without an image in it would be worse than
    // the click doing nothing at all.
    var chip = target.closest(".attachment");
    if (!chip || chip.classList.contains("attachment-audio")) {
      return;
    }

    var preview = target.closest(".attachment img");
    if (preview) {
      openImageOverlay(preview.src);
    }
  }

  // --- full-size image -----------------------------------------------------

  /**
   * Opens one image at full size, inside the panel.
   *
   * The overlay is built here and removed here: it never opens a window, never
   * navigates, and never asks the host for anything. It is fixed, so it covers the
   * panel whatever the transcript's scroll position is.
   */
  function openImageOverlay(source) {
    closeImageOverlay();

    var node = createElement("div", "image-overlay");

    var image = createElement("img");
    image.src = source;
    image.alt = "imagen adjunta";
    node.appendChild(image);

    var close = createElement("button", "image-overlay-close icon-button codicon codicon-close");
    close.type = "button";
    close.title = "Cerrar";
    close.setAttribute("aria-label", "Cerrar");
    node.appendChild(close);

    // One click handler on the overlay covers the image, the padding and the close
    // button, because the button's own click bubbles to it.
    node.addEventListener("click", closeImageOverlay);
    document.addEventListener("keydown", onOverlayKeydown);
    document.body.appendChild(node);
    overlay = node;
  }

  /** Closes the overlay and takes its Escape listener with it. */
  function closeImageOverlay() {
    if (!overlay) {
      return;
    }
    document.removeEventListener("keydown", onOverlayKeydown);
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    overlay = null;
  }

  function onOverlayKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeImageOverlay();
    }
  }

  /**
   * The block the echo and pi's own message share, drawn by kind.
   *
   * The webview holds the thumbnail's data URL rather than the bytes, so an image
   * echo carries the URL and the type; `imageSource` turns either shape into the
   * same source, which keeps the echo and the authoritative message identical. An
   * audio attachment has no `dataUrl` at all — the host sent its transcript, and
   * pi's own message carries that text rather than the file — so it must never
   * become an image block: the echoed bubble would ask the browser for
   * `data:audio/...;base64,undefined`, and since pi's authoritative message holds
   * no image, nothing would ever replace it. It becomes a name-only block that
   * `renderContent` draws as a non-image indicator instead.
   */
  function attachmentBlock(attachment) {
    if (attachment.kind === "audio") {
      return { type: "audio", name: attachment.name };
    }
    return { type: "image", mimeType: attachment.mimeType, dataUrl: attachment.dataUrl };
  }

  function submitPrompt() {
    var text = elements.prompt.value;
    if (!text.trim()) {
      return;
    }
    // Local echo; pi's own user message_start replaces this element. The images go
    // with the text, so the owner sees what they just sent before pi confirms it.
    var echo = addMessage("user");
    var content = [{ type: "text", text: text }];
    for (var index = 0; index < attachments.length; index += 1) {
      content.push(attachmentBlock(attachments[index]));
    }
    renderContent(echo.body, content);
    userEcho = echo;

    var ids = [];
    for (var position = 0; position < attachments.length; position += 1) {
      ids.push(attachments[position].id);
    }

    elements.prompt.value = "";
    setStatus("running");
    // The bytes stay with the host: a prompt carries the ids of what is attached.
    send({ type: "prompt", text: text, attachmentIds: ids });
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

    elements.prompt.addEventListener("paste", onPromptPaste);

    // The whole panel takes a drop, so the target the owner aims at does not have
    // to be the composer itself.
    document.body.addEventListener("dragover", onBodyDragOver);
    document.body.addEventListener("dragleave", onBodyDragLeave);
    document.body.addEventListener("drop", onBodyDrop);

    elements.attach.addEventListener("click", function () {
      send({ type: "pickImages" });
    });
    elements.attachments.addEventListener("click", onAttachmentsClick);

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
  renderAttachments();
  send({ type: "ready" });
  if (!elements.messages.firstChild) {
    renderEmptyState();
  }
})();
