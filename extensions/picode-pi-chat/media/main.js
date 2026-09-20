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
  };

  // Live assistant message being assembled from deltas. `message_update` is
  // delta-only (no cumulative snapshot), so text is accumulated here and
  // `message_end` replaces it with the authoritative message.
  var stream = null;
  // Locally echoed user message, replaced by pi's own message_start if it comes.
  var userEcho = null;
  // toolCallId -> { item, output }
  var toolItems = new Map();

  function send(message) {
    vscode.postMessage(message);
  }

  function setStatus(status, detail) {
    elements.status.textContent = detail ? status + " — " + detail : status;
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
    article.appendChild(createElement("header", "message-role", role));
    var body = createElement("div", "message-body");
    article.appendChild(body);
    elements.messages.appendChild(article);
    scrollToBottom();
    return { article: article, body: body };
  }

  function appendBlock(container, kind, text) {
    var block = createElement("div", "block block-" + kind);
    if (kind === "thinking") {
      block.appendChild(createElement("div", "block-label", "thinking"));
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
    } catch (error) {
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
      listItem.appendChild(createElement("div", "tool-name", event.toolName || "tool"));
      var args = "";
      try {
        args = JSON.stringify(event.args || {});
      } catch (error) {
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

  function handleMessageEvent(message) {
    var role = message && typeof message.role === "string" ? message.role : "assistant";

    if (role === "user") {
      if (userEcho) {
        userEcho.body.textContent = textFromContent(message.content);
        userEcho = null;
      } else {
        var echo = addMessage("user");
        echo.body.textContent = textFromContent(message.content);
      }
      return;
    }

    if (role === "assistant") {
      var view = ensureStream().view;
      renderContent(view.body, message.content);
      endStream();
      return;
    }

    // Tool results and any other role: keep the raw text out of the way.
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
        handleMessageEvent(event.message);
        break;
      case "message_end":
        handleMessageEvent(event.message);
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
        showError("Extension error: " + event.error);
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
        renderState(message.state);
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
      default:
        break;
    }
  }

  function renderState(state) {
    if (!state || typeof state !== "object") {
      return;
    }
    var parts = [];
    if (state.model) {
      parts.push(state.model);
    }
    if (typeof state.messageCount === "number") {
      parts.push(state.messageCount + " messages");
    }
    if (state.thinkingLevel) {
      parts.push("thinking: " + state.thinkingLevel);
    }
    elements.session.textContent = parts.join(" · ");
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

    window.addEventListener("message", function (event) {
      handleHostMessage(event.data);
    });
  }

  registerEvents();
  setStatus("idle");
  send({ type: "ready" });
})();
