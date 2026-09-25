/*
 * Exercises `@pi` as the editor's Chat Participant and its Language Model Tools, in
 * plain Node.
 *
 * What is worth pinning here is the mapping and the lifecycle, because both are wrong in
 * ways that look fine until a real turn runs: pi spends a turn streaming `text_delta`
 * events and only ends at `agent_settled`, so a forwarder that settles on `agent_end`
 * would cut a retrying turn in half, and one that forwards `message_end` too would print
 * the answer twice.
 *
 * `vscode` is replaced by a stub that records the participant and the tools it is given.
 * That is deliberate: the wiring — the participant's id, the tools' names — is exactly
 * what has to match the manifest, and a stub that discarded its arguments could not say.
 *
 * Run with: npm test
 */
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const EXTENSION_ROOT = path.resolve(__dirname, "..");
const CHAT_STUB = path.join(__dirname, "vscode-chat-stub.js");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    return CHAT_STUB;
  }
  return originalResolve.call(this, request, ...rest);
};

const stub = require(CHAT_STUB);
const chatTurn = require(path.join(EXTENSION_ROOT, "out", "chat-turn.js"));
const piTools = require(path.join(EXTENSION_ROOT, "out", "pi-tools.js"));
const chatParticipant = require(path.join(EXTENSION_ROOT, "out", "chat-participant.js"));
const mcpNative = require(path.join(EXTENSION_ROOT, "out", "mcp-native.js"));
const mcpCommand = require(path.join(EXTENSION_ROOT, "out", "mcp-command.js"));

const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, "package.json"), "utf8"));

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** A cancellation token shaped like the editor's, which does nothing on its own. */
const noCancellation = { onCancellationRequested: () => ({ dispose() {} }) };

/** A stream that records what was pushed to it. */
function recordingStream() {
  const markdown = [];
  const progress = [];
  return {
    markdown: (text) => markdown.push(text),
    progress: (text) => progress.push(text),
    markdownText: () => markdown.join(""),
    progressText: () => progress.join(" | "),
  };
}

/**
 * A client that answers a prompt by emitting a turn.
 *
 * The events are emitted inside `prompt`, which is what makes the test exercise the real
 * ordering: the handler subscribes before prompting, so the turn arrives while `prompt`
 * is still resolving.
 */
function fakeClient(events) {
  const listeners = new Set();
  const client = {
    isRunning: true,
    prompts: [],
    aborts: 0,
    onEvent(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    emit(event) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    async prompt(text) {
      client.prompts.push(text);
      for (const event of events) {
        client.emit(event);
      }
    },
    async abort() {
      client.aborts += 1;
    },
  };
  return client;
}

/** A fake extension context, scoped to one check so nothing leaks between them. */
function fakeContext() {
  return { extensionUri: { fsPath: "C:/picode" }, subscriptions: [] };
}

/* ------------------------------------------------------------------ *
 * The suite
 * ------------------------------------------------------------------ */

async function main() {
  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

  // --- the progress line ------------------------------------------------------

  check(
    "a known tool is named in Spanish and carries its target",
    chatTurn.describeToolCall("edit", { path: "src/extension.ts" }) ===
      "Editando: src/extension.ts",
    chatTurn.describeToolCall("edit", { path: "src/extension.ts" }),
  );
  check(
    "an unknown tool is printed as it came, not hidden",
    chatTurn.describeToolCall("brand_new_tool", { path: "a.ts" }) === "brand_new_tool: a.ts",
    chatTurn.describeToolCall("brand_new_tool", { path: "a.ts" }),
  );
  check(
    "a tool with no usable target is just its label",
    chatTurn.describeToolCall("read") === "Leyendo",
    chatTurn.describeToolCall("read"),
  );
  check(
    "a long target is shortened to one line",
    chatTurn.describeToolCall("bash", { command: "x".repeat(200) }).endsWith("…") &&
      chatTurn.describeToolCall("bash", { command: "x".repeat(200) }).length < 200,
    chatTurn.describeToolCall("bash", { command: "x".repeat(200) }),
  );

  // --- the turn forwarder -----------------------------------------------------

  {
    const sink = new chatTurn.CollectingSink();
    const forwarder = new chatTurn.PiTurnForwarder(sink);
    forwarder.handle({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hola " },
    });
    forwarder.handle({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "mundo" },
    });
    forwarder.handle({ type: "agent_settled" });
    const outcome = await forwarder.settled;
    check(
      "streamed text deltas are joined in order and settle at agent_settled",
      sink.text === "Hola mundo" && outcome.ok === true,
      JSON.stringify({ text: sink.text, outcome }),
    );
  }

  {
    const sink = new chatTurn.CollectingSink();
    const forwarder = new chatTurn.PiTurnForwarder(sink);
    // `agent_end` with a retry is not the end of the turn; the forwarder must not settle.
    forwarder.handle({ type: "agent_end", willRetry: true });
    let settled = false;
    void forwarder.settled.then(() => {
      settled = true;
    });
    await Promise.resolve();
    check("a retrying agent_end does not settle the turn", settled === false, `settled=${settled}`);
    forwarder.handle({ type: "agent_settled" });
    await forwarder.settled;
  }

  {
    const stream = recordingStream();
    const visible = new chatTurn.PiTurnForwarder(stream);
    visible.handle({
      type: "tool_execution_start",
      toolCallId: "1",
      toolName: "grep",
      args: { pattern: "foo" },
    });
    visible.handle({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10 });
    visible.handle({ type: "agent_settled" });
    await visible.settled;
    check(
      "a tool start and a retry reach the progress line, not the transcript",
      stream.progressText().includes("Buscando en el código: foo") &&
        stream.progressText().includes("Reintentando (1/3)") &&
        stream.markdownText() === "",
      stream.progressText(),
    );
  }

  {
    const sink = new chatTurn.CollectingSink();
    const forwarder = new chatTurn.PiTurnForwarder(sink);
    forwarder.handle({ type: "agent_settled" });
    await forwarder.settled;
    // A late delta after the turn settled must not reach the reader of a later turn.
    forwarder.handle({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "late" },
    });
    check("events after the turn settled are ignored", sink.text === "", sink.text);
  }

  {
    const sink = new chatTurn.CollectingSink();
    const forwarder = new chatTurn.PiTurnForwarder(sink);
    forwarder.handle({
      type: "message_end",
      message: { role: "assistant", content: [], errorMessage: "sin cuota" },
    });
    forwarder.handle({ type: "agent_settled" });
    await forwarder.settled;
    check(
      "an assistant error ends up in the transcript",
      sink.text.includes("sin cuota"),
      sink.text,
    );
  }

  // --- askPi ------------------------------------------------------------------

  {
    const client = fakeClient([
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "respuesta" },
      },
      { type: "agent_settled" },
    ]);
    const text = await piTools.askPi(client, "¿qué hay aquí?", noCancellation);
    check(
      "askPi returns the turn's text and sends the prompt verbatim",
      text === "respuesta" && client.prompts[0] === "¿qué hay aquí?",
      JSON.stringify({ text, prompts: client.prompts }),
    );
  }

  {
    const client = fakeClient([]);
    const token = {
      onCancellationRequested: (listener) => {
        listener();
        return { dispose() {} };
      },
    };
    // The turn never settles on its own, so the test closes it the way a real backend
    // eventually would; what matters is that cancelling reached `abort`.
    const pending = piTools.askPi(client, "largo", token);
    client.emit({ type: "agent_settled" });
    await pending;
    check("cancelling a turn aborts at pi", client.aborts >= 1, `aborts=${client.aborts}`);
  }

  // --- the status text --------------------------------------------------------

  check(
    "the status text names the instance, the profile and the model",
    piTools.formatStatus({
      mode: "managed",
      display: "el pi propio de PiCode",
      profile: "el perfil propio de PiCode",
      model: "deepseek-v4-pro",
    }).includes("Instancia de pi: managed") &&
      piTools.formatStatus({
        mode: "managed",
        display: "el pi propio de PiCode",
        profile: "el perfil propio de PiCode",
        model: "deepseek-v4-pro",
      }).includes("deepseek-v4-pro"),
    piTools.formatStatus({
      mode: "managed",
      display: "el pi propio de PiCode",
      profile: "el perfil propio de PiCode",
    }),
  );
  check(
    "a session with no model says so instead of naming one",
    piTools
      .formatStatus({
        mode: "path",
        display: "el pi del PATH",
        profile: "el perfil del pi del PATH",
      })
      .includes("sin sesión activa"),
    piTools.formatStatus({
      mode: "path",
      display: "el pi del PATH",
      profile: "el perfil del pi del PATH",
    }),
  );

  // --- the participant handler ------------------------------------------------

  {
    const client = fakeClient([
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hola" },
      },
      { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "a.ts" } },
      { type: "agent_settled" },
    ]);
    const handler = chatParticipant.createPiRequestHandler({
      ensureClient: async () => client,
      log: () => {},
    });
    const stream = recordingStream();
    const value = await handler(
      { prompt: "hola", command: undefined },
      {},
      stream,
      noCancellation,
    );
    check(
      "the handler forwards the turn and returns an empty result",
      stream.markdownText() === "hola" &&
        stream.progressText().includes("Leyendo: a.ts") &&
        typeof value === "object",
      JSON.stringify({ markdown: stream.markdownText(), progress: stream.progressText(), value }),
    );
  }

  {
    const handler = chatParticipant.createPiRequestHandler({
      ensureClient: async () => undefined,
      log: () => {},
    });
    const stream = recordingStream();
    await handler({ prompt: "hola", command: undefined }, {}, stream, noCancellation);
    check(
      "a chat with no pi says so instead of failing silently",
      stream.markdownText().includes("No se pudo arrancar pi"),
      stream.markdownText(),
    );
  }

  {
    const client = fakeClient([{ type: "agent_settled" }]);
    const handler = chatParticipant.createPiRequestHandler({
      ensureClient: async () => client,
      log: () => {},
    });
    await handler({ prompt: "x", command: "compact" }, {}, recordingStream(), noCancellation);
    check(
      "a contributed slash command is joined back into the prompt pi reads",
      client.prompts[0] === "/compact x",
      client.prompts[0],
    );
  }

  // --- registration matches the manifest --------------------------------------

  {
    stub.chat.participants.length = 0;
    const context = fakeContext();
    const participant = chatParticipant.registerPiChatParticipant(context, {
      ensureClient: async () => undefined,
      log: () => {},
    });
    const declared = (MANIFEST.contributes.chatParticipants || []).find(
      (entry) => entry.id === participant.id,
    );
    check(
      "the registered participant is the one the manifest declares as default",
      participant.id === "picode.pi" &&
        declared !== undefined &&
        declared.isDefault === true &&
        context.subscriptions.includes(participant),
      JSON.stringify({ id: participant.id, declared }),
    );
    check(
      "the participant is activated by its own activation event",
      (MANIFEST.activationEvents || []).includes("onChatParticipant:picode.pi"),
      JSON.stringify(MANIFEST.activationEvents),
    );
  }

  {
    stub.lm.registered.length = 0;
    const context = fakeContext();
    piTools.registerPiTools(context, {
      ensureClient: async () => fakeClient([{ type: "agent_settled" }]),
      status: async () => ({
        mode: "managed",
        display: "el pi propio de PiCode",
        profile: "el perfil propio de PiCode",
        model: "m",
      }),
      log: () => {},
    });
    const names = stub.lm.registered.map((handle) => handle.name).sort();
    const declared = (MANIFEST.contributes.languageModelTools || []).map((tool) => tool.name).sort();
    check(
      "the tools registered are exactly the ones the manifest declares",
      names.join(",") === piTools.PI_ASK_TOOL + "," + piTools.PI_STATUS_TOOL &&
        names.join(",") === declared.join(","),
      JSON.stringify({ names, declared }),
    );

    const statusHandle = stub.lm.registered.find((handle) => handle.name === piTools.PI_STATUS_TOOL);
    const statusResult = await statusHandle.tool.invoke({ input: {} }, noCancellation);
    check(
      "the status tool answers with the instance text",
      statusResult.content[0].value.includes("el perfil propio de PiCode"),
      JSON.stringify(statusResult.content),
    );

    const askHandle = stub.lm.registered.find((handle) => handle.name === piTools.PI_ASK_TOOL);
    const askResult = await askHandle.tool.invoke({ input: { prompt: "hola" } }, noCancellation);
    check(
      "the ask tool answers with the turn's text",
      typeof askResult.content[0].value === "string",
      JSON.stringify(askResult.content),
    );
    check(
      "both tools are disposed with the extension",
      context.subscriptions.length >= 2,
      String(context.subscriptions.length),
    );
  }

  // --- the MCP translation ----------------------------------------------------

  {
    const migration = mcpNative.toNativeMcp({
      mcpServers: {
        local: { command: "node", args: ["server.js"], env: { A: "1" } },
        remote: { url: "https://example.test/mcp" },
        broken: { nothing: true },
      },
    });
    check(
      "a command becomes a stdio server and a url an http server",
      migration.config.servers.local.type === "stdio" &&
        migration.config.servers.local.command === "node" &&
        migration.config.servers.local.args[0] === "server.js" &&
        migration.config.servers.remote.type === "http",
      JSON.stringify(migration.config),
    );
    check(
      "a server with neither command nor url is reported, not dropped",
      migration.skipped.length === 1 && migration.skipped[0].name === "broken",
      JSON.stringify(migration.skipped),
    );
  }
  check(
    "a command wins when an entry declares both",
    mcpNative.toNativeMcp({ mcpServers: { s: { command: "x", url: "https://y" } } }).config.servers.s
      .type === "stdio",
    JSON.stringify(mcpNative.toNativeMcp({ mcpServers: { s: { command: "x", url: "https://y" } } })),
  );
  check(
    "an absent or non-object document yields an empty configuration",
    mcpNative.toNativeMcp(undefined).config.servers &&
      Object.keys(mcpNative.toNativeMcp(undefined).config.servers).length === 0 &&
      Object.keys(mcpNative.toNativeMcp("nope").config.servers).length === 0,
    JSON.stringify(mcpNative.toNativeMcp(undefined)),
  );
  check(
    "the written file ends with a newline and parses back",
    (() => {
      const text = mcpNative.mcpJsonText(
        mcpNative.toNativeMcp({ mcpServers: { s: { command: "x" } } }),
      );
      return text.endsWith("\n") && JSON.parse(text).servers.s.command === "x";
    })(),
    mcpNative.mcpJsonText(mcpNative.toNativeMcp({ mcpServers: { s: { command: "x" } } })),
  );

  // --- the migration command's decision, over text ----------------------------

  check(
    "a missing or empty mcp.json is 'nothing to migrate', not an error",
    "empty" in mcpCommand.migrationFromText(undefined) &&
      "empty" in mcpCommand.migrationFromText('{"mcpServers":{}}') &&
      "empty" in mcpCommand.migrationFromText("not json"),
    JSON.stringify(mcpCommand.migrationFromText(undefined)),
  );
  check(
    "a profile with servers yields the migration and its skipped list",
    (() => {
      const decided = mcpCommand.migrationFromText(
        '{"mcpServers":{"s":{"command":"x"},"bad":{}}}',
      );
      return (
        !("empty" in decided) &&
        Object.keys(decided.migration.config.servers).join(",") === "s" &&
        decided.migration.skipped.length === 1
      );
    })(),
    JSON.stringify(mcpCommand.migrationFromText('{"mcpServers":{"s":{"command":"x"}}}')),
  );
  check(
    "the migration command is declared in the manifest with a Spanish title",
    (MANIFEST.contributes.commands || []).some(
      (entry) =>
        entry.command === mcpCommand.MIGRATE_MCP_COMMAND &&
        typeof entry.title === "string" &&
        entry.title.startsWith("PiCode:"),
    ),
    JSON.stringify((MANIFEST.contributes.commands || []).map((entry) => entry.command)),
  );

  // --- report -----------------------------------------------------------------

  let failed = 0;
  for (const result of results) {
    console.log(
      `${result.ok ? "ok  " : "FAIL"} ${result.label}${result.ok ? "" : ` -> ${result.detail}`}`,
    );
    if (!result.ok) {
      failed += 1;
    }
  }
  console.log(
    failed === 0
      ? `\nALL ${results.length} CHECKS PASS`
      : `\n${failed} of ${results.length} CHECKS FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("harness error:", error);
  process.exit(2);
});
