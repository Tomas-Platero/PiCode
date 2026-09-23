/*
 * The bridge that answers pi's `extension_ui_request` records.
 *
 * What is tested here is the part that can be tested without an editor: the wire
 * contract the bridge produces, the rule that correlates a response with the
 * request it settles, and the rule that this side schedules no timer of its own.
 * The dialog interactions themselves — quick pick, modal, input box, the
 * `notify` notification — are deliberately **not** unit-tested, because there is
 * no editor in this suite and a fake one would only assert that the fake was
 * called. The `vscode` stand-in below throws if any dialog is ever touched, so
 * the untested part is load-bearing in exactly one direction: the module must be
 * importable and the four terminal-configuring methods must not reach for it.
 *
 * The exact JSON printed at the end is what the client writes to pi's stdin.
 *
 * Run with: npm test
 */
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

const EXTENSION_ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = path.join(EXTENSION_ROOT, "src");

// The bridge imports `vscode`. Nothing tested here may call it, so every dialog
// throws: a test that reaches the editor would fail loudly rather than pass
// against a permissive stub.
const editorAbsent = () => {
  throw new Error("the editor is not available in this suite");
};
const fakeVscode = {
  window: {
    showQuickPick: editorAbsent,
    showInputBox: editorAbsent,
    showWarningMessage: editorAbsent,
    showInformationMessage: editorAbsent,
    showErrorMessage: editorAbsent,
  },
};

const originalLoad = Module._load;
Module._load = function load(request) {
  if (request === "vscode") {
    return fakeVscode;
  }
  return originalLoad.apply(this, arguments);
};

async function main() {
  const protocolPath = path.join(EXTENSION_ROOT, "out", "protocol.js");
  const bridgePath = path.join(EXTENSION_ROOT, "out", "pi-ui-bridge.js");
  for (const compiled of [protocolPath, bridgePath]) {
    if (!fs.existsSync(compiled)) {
      console.error(`Missing ${compiled}. Run "npm run compile" first.`);
      process.exit(2);
    }
  }

  const protocol = await import(pathToFileURL(protocolPath).href);
  const bridge = await import(pathToFileURL(bridgePath).href);

  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });
  const throws = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  // --- one response per family, as the exact JSON on the wire ---------------

  // The three records pi accepts, printed verbatim below. Anything else — a
  // missing `id`, an extra field, two decisions in one record — is not an answer
  // pi can read.
  const shapes = [
    {
      label: "value — select / input / editor",
      answer: { value: "Allow" },
      keys: ["id", "type", "value"],
      json: '{"type":"extension_ui_response","id":"req-1","value":"Allow"}',
    },
    {
      label: "confirmed — confirm",
      answer: { confirmed: true },
      keys: ["confirmed", "id", "type"],
      json: '{"type":"extension_ui_response","id":"req-1","confirmed":true}',
    },
    {
      label: "cancelled — any dialog",
      answer: { cancelled: true },
      keys: ["cancelled", "id", "type"],
      json: '{"type":"extension_ui_response","id":"req-1","cancelled":true}',
    },
  ];

  for (const shape of shapes) {
    const response = protocol.extensionUiResponse("req-1", shape.answer);
    const wire = JSON.stringify(response);
    const keys = Object.keys(response).sort();
    check(`"${shape.label}" is exactly ${shape.json}`, wire === shape.json, wire);
    check(
      `"${shape.label}" carries exactly type, id and one decision`,
      JSON.stringify(keys) === JSON.stringify(shape.keys),
      JSON.stringify(keys),
    );
  }

  // A `confirm` can never be answered with text and a `select` never with a
  // boolean: the decision shape chooses the record, not the caller.
  check(
    "a value decision cannot produce a confirm record",
    !("confirmed" in protocol.extensionUiResponse("req-1", { value: "yes" })),
  );
  check(
    "a confirmed decision cannot produce a value record",
    !("value" in protocol.extensionUiResponse("req-1", { confirmed: true })),
  );

  // --- correlation is by id, and the id is the request's --------------------

  for (const shape of shapes) {
    const response = protocol.extensionUiResponse("req-42", shape.answer);
    check(`"${shape.label}" answers the id it was given`, response.id === "req-42", response.id);
  }
  check(
    "a cancelled answer for one request cannot name another",
    JSON.stringify(protocol.extensionUiResponse("dialog-7", { cancelled: true })) ===
      '{"type":"extension_ui_response","id":"dialog-7","cancelled":true}',
  );

  // The client is where the id is attached, so the source is checked for it: the
  // request's id is the only id that may reach the builder.
  const clientSource = fs.readFileSync(path.join(SOURCE_ROOT, "pi-rpc-client.ts"), "utf8");
  const idUses = clientSource.match(/extensionUiResponse\(([^,]+),/g) ?? [];
  check(
    "the client builds every response from the request's id",
    idUses.length >= 2 && idUses.every((use) => use.includes("request.id")),
    JSON.stringify(idUses),
  );

  // --- no host-side timeout -------------------------------------------------

  const bridgeSource = fs.readFileSync(path.join(SOURCE_ROOT, "pi-ui-bridge.ts"), "utf8");
  for (const [file, source] of [
    ["pi-rpc-client.ts", clientSource],
    ["pi-ui-bridge.ts", bridgeSource],
  ]) {
    check(
      `${file} schedules no timer of its own`,
      !source.includes("setTimeout(") && !source.includes("setInterval("),
    );
  }
  check(
    "a response record never carries a timeout",
    shapes.every(
      (shape) => !("timeout" in protocol.extensionUiResponse("req-1", shape.answer)),
    ),
  );
  check(
    "the bridge never reads the request's timeout",
    !bridgeSource.includes("request.timeout"),
  );

  // --- import purity and the terminal-configuring methods -------------------

  check("the bridge exports the handler the client is given", typeof bridge.handleExtensionUiRequest === "function");

  for (const method of ["setStatus", "setWidget", "setTitle", "set_editor_text"]) {
    const request = {
      type: "extension_ui_request",
      id: `req-${method}`,
      method,
      statusKey: "k",
      statusText: "v",
      widgetKey: "k",
      widgetLines: ["l"],
      title: "t",
      text: "x",
    };
    const answer = await bridge.handleExtensionUiRequest(request);
    check(
      `"${method}" configures the terminal, so it has no answer`,
      answer === undefined,
      JSON.stringify(answer),
    );
  }

  // --- the provider-login interaction, built from the same dialogs ---------

  check(
    "the bridge exports the login interaction factory",
    typeof bridge.createAuthInteraction === "function",
  );
  check(
    "the bridge exports the pure prompt mapping",
    typeof bridge.authPromptToDialog === "function",
  );
  check(
    "the bridge exports the pure answer mapping",
    typeof bridge.authDialogAnswer === "function",
  );
  check(
    "the bridge exports the pure notice mapping",
    typeof bridge.authEventToNotice === "function",
  );

  // Text and manual codes are one line; a secret must be masked. These are the
  // shapes the shared input helper is called with, asserted without an editor.
  const inputCases = [
    {
      prompt: { type: "text", message: "Pega tu clave", placeholder: "sk-..." },
      password: false,
      placeholder: "sk-...",
    },
    { prompt: { type: "secret", message: "Pega tu clave" }, password: true },
    { prompt: { type: "manual_code", message: "Pega el código" }, password: false },
  ];
  for (const testCase of inputCases) {
    const dialog = bridge.authPromptToDialog(testCase.prompt);
    check(
      `"${testCase.prompt.type}" is a single-line input (password: ${testCase.password})`,
      dialog.kind === "input" &&
        dialog.password === testCase.password &&
        dialog.title === testCase.prompt.message,
      JSON.stringify(dialog),
    );
    check(
      `"${testCase.prompt.type}" keeps the placeholder ${testCase.placeholder ?? "(none)"}`,
      dialog.placeholder === testCase.placeholder,
      JSON.stringify(dialog),
    );
  }

  // A select must carry both what the owner reads and the id pi gets back.
  const selectPrompt = {
    type: "select",
    message: "¿Cómo quieres entrar?",
    options: [
      { id: "api_key", label: "Clave de API" },
      { id: "oauth", label: "Suscripción", description: "ChatGPT Plus" },
    ],
  };
  const selectDialog = bridge.authPromptToDialog(selectPrompt);
  check(
    "a select keeps each option's id, label and description",
    selectDialog.kind === "choose" &&
      JSON.stringify(selectDialog.options) === JSON.stringify(selectPrompt.options),
    JSON.stringify(selectDialog),
  );

  // The answer the login expects: the id for a select, the raw text for an
  // input, and a thrown cancellation -- never a silent empty string.
  check(
    "an input answer is the typed text",
    bridge.authDialogAnswer({ kind: "input", title: "t", password: false }, "sk-123") ===
      "sk-123",
  );
  check(
    "a select answer is the option id, not its label",
    bridge.authDialogAnswer(selectDialog, "oauth") === "oauth",
  );
  check(
    "a select answer that is not one of the offered ids is refused",
    throws(() => bridge.authDialogAnswer(selectDialog, "Suscripción")),
  );
  check(
    "a dismissed prompt throws instead of submitting an empty answer",
    throws(() => bridge.authDialogAnswer(selectDialog, undefined)) &&
      throws(() =>
        bridge.authDialogAnswer({ kind: "input", title: "t", password: false }, undefined),
      ),
  );

  // Notifications: the URL and the device code must survive into what is shown.
  const urlNotice = bridge.authEventToNotice({
    type: "auth_url",
    url: "https://example.test/login",
    instructions: "Abre esto",
  });
  check(
    "an auth_url notice carries its url for the browser",
    urlNotice.url === "https://example.test/login" &&
      urlNotice.message.includes("https://example.test/login"),
    JSON.stringify(urlNotice),
  );
  const deviceNotice = bridge.authEventToNotice({
    type: "device_code",
    userCode: "ABCD-1234",
    verificationUri: "https://example.test/device",
  });
  check(
    "a device_code notice carries the code and the uri",
    deviceNotice.url === "https://example.test/device" &&
      deviceNotice.message.includes("ABCD-1234") &&
      deviceNotice.message.includes("https://example.test/device"),
    JSON.stringify(deviceNotice),
  );
  check(
    "a plain info notice is its message",
    bridge.authEventToNotice({ type: "info", message: "Paso 1" }).message === "Paso 1",
  );

  const interaction = bridge.createAuthInteraction();
  check(
    "the login interaction has the prompt/notify shape pi asks for",
    typeof interaction.prompt === "function" && typeof interaction.notify === "function",
  );

  // --- the SDK login call, checked at the source ---------------------------

  // The login cannot be run here (no editor, no provider), so what is proved is
  // the call's shape and that it goes through the runtime that owns auth.json.
  const sdkSource = fs.readFileSync(path.join(SOURCE_ROOT, "pi-sdk-client.ts"), "utf8");
  check(
    "the embedded client logs in through the session's model runtime",
    /runtime\.login\(/.test(sdkSource) && /requireSession\(\)\.modelRuntime/.test(sdkSource),
    "no runtime.login( call anchored to the session model runtime",
  );
  check(
    "the login call passes provider id, auth type and the interaction",
    /runtime\.login\(\s*providerId\s*,\s*type\s*,\s*interaction\s*\)/.test(sdkSource),
    "login call shape not found",
  );
  check(
    "the client does not persist credentials through the non-persistent override",
    !/\.setRuntimeApiKey\s*\(/.test(sdkSource),
  );
  check(
    "the client passes its own agentDir to the SDK services that own auth.json",
    /createAgentSessionServices\(\{\s*cwd\s*,\s*agentDir\s*\}\)/.test(sdkSource),
    "createAgentSessionServices({ cwd, agentDir }) not found",
  );

  console.log("\nthe three response shapes, as written to pi's stdin:");
  for (const shape of shapes) {
    console.log(`  ${shape.label}: ${JSON.stringify(protocol.extensionUiResponse("req-1", shape.answer))}`);
  }

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
