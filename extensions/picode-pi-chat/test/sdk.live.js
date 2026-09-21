/*
 * Live check of the embedded transport: PiCode loading the owner's own pi
 * inside this Node process through its SDK, instead of spawning `pi --mode rpc`.
 *
 * This is not part of `npm test`: it needs a working pi installation and it
 * sends a real prompt to a real model. What it proves is the part no hermetic
 * test can: that the SDK entry resolves on this machine, that the owner's
 * configuration and provider catalogue come back through it, and that a prompt
 * travels all the way to an assistant reply.
 *
 * The agent runs in a temporary working directory and is told not to use tools,
 * so nothing in the repository is touched; pi still writes its session file,
 * which is its normal behaviour.
 *
 * Run with: npm run test:sdk
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EXTENSION_ROOT = path.resolve(__dirname, "..");

// runtime.ts imports `vscode` for configuration, and resolveSdkEntry lives there.
// The stub keeps it usable outside an editor, exactly as the RPC live check does.
const Module = require("node:module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "vscode-stub.js");
  }
  return originalResolve.call(this, request, ...rest);
};

const { resolveSdkEntry } = require(path.join(EXTENSION_ROOT, "out", "runtime.js"));
const { PiSdkClient } = require(path.join(EXTENSION_ROOT, "out", "pi-sdk-client.js"));

/** A model turn can be slow; this is the whole budget for prompt -> reply. */
const REPLY_TIMEOUT_MS = 180_000;

const show = (value) => JSON.stringify(value);

/** Waits for the first assistant message that carries text, and returns it. */
function awaitAssistantReply(client, timeoutMs) {
  return new Promise((resolve, reject) => {
    let subscription;
    const timer = setTimeout(() => {
      subscription?.dispose();
      reject(new Error(`no assistant reply within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    subscription = client.onEvent((event) => {
      if (event.type !== "message_end" || event.message?.role !== "assistant") {
        return;
      }
      const text = assistantText(event.message);
      if (text.length === 0) {
        return;
      }
      clearTimeout(timer);
      subscription.dispose();
      resolve(text);
    });
  });
}

function assistantText(message) {
  const content = message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

async function main() {
  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

  /** Runs one check, turning a thrown error into a failed check instead of an abort. */
  const tryCheck = async (label, run) => {
    try {
      const outcome = await run();
      check(label, outcome.ok, outcome.detail);
      return outcome.value;
    } catch (error) {
      check(label, false, `threw: ${error.message}`);
      return undefined;
    }
  };

  const entry = resolveSdkEntry({ fsPath: EXTENSION_ROOT });
  if (!entry) {
    console.error(
      "No pi SDK entry was found on this machine. Install pi globally " +
        '(npm i -g @earendil-works/pi-coding-agent) or point "picode.pi.executablePath" at one.',
    );
    process.exit(2);
  }
  console.log(`pi SDK entry: ${entry}`);

  const outputLines = [];
  const output = {
    appendLine: (line) => {
      outputLines.push(line);
      console.log(line);
    },
  };

  // A scratch directory, so a model that ignores "no tools" cannot write anything
  // meaningful even if it runs one.
  const client = new PiSdkClient({ entry, cwd: os.tmpdir(), output });

  try {
    await tryCheck("start() brings the embedded session up", async () => {
      await client.start();
      return { ok: client.isRunning, detail: `isRunning=${client.isRunning}` };
    });

    await tryCheck("the loader reported what it read from the owner's configuration", async () => {
      const loaded = outputLines.find((line) => /\[pi-sdk\] Loaded \d+ extension/.test(line));
      return { ok: loaded !== undefined, detail: loaded ?? show(outputLines) };
    });

    const models = await tryCheck("getAvailableModels() returns more than 50 models", async () => {
      const list = await client.getAvailableModels();
      return { ok: list.length > 50, detail: `${list.length} models`, value: list };
    });

    await tryCheck("the owner's providers are present in the catalogue", async () => {
      const list = models ?? [];
      const providers = [...new Set(list.map((model) => model.provider).filter(Boolean))].sort();
      return {
        ok: providers.length > 0,
        detail: `${providers.length} providers: ${providers.slice(0, 15).join(", ")}`,
      };
    });

    await tryCheck("getAvailableThinkingLevels() is non-empty", async () => {
      const levels = await client.getAvailableThinkingLevels();
      return { ok: levels.length > 0, detail: show(levels) };
    });

    await tryCheck("getCommands() returns at least one entry", async () => {
      const commands = await client.getCommands();
      const names = commands.slice(0, 5).map((command) => `${command.source}:${command.name}`);
      return { ok: commands.length > 0, detail: `${commands.length} commands: ${names.join(", ")}` };
    });

    await tryCheck("getState() reports a session id", async () => {
      const state = await client.getState();
      return {
        ok: typeof state.sessionId === "string" && state.sessionId.length > 0,
        detail: `sessionId=${state.sessionId ?? "none"} model=${state.model?.provider ?? "?"}/${state.model?.id ?? "?"}`,
      };
    });

    await tryCheck("a one-line prompt comes back as a non-empty assistant reply", async () => {
      const reply = awaitAssistantReply(client, REPLY_TIMEOUT_MS);
      await client.prompt("Reply with the single word: pong. Do not use any tools.");
      const text = await reply;
      return { ok: text.length > 0, detail: text.replace(/\s+/g, " ").slice(0, 400) };
    });

    await tryCheck("the session recorded the exchange", async () => {
      const state = await client.getState();
      return {
        ok: typeof state.messageCount === "number" && state.messageCount > 0,
        detail: `${state.messageCount} messages`,
      };
    });
  } finally {
    client.stop();
    client.stop();
  }

  let failed = 0;
  for (const result of results) {
    // Unlike the hermetic suites, this one always prints the detail: the reply text
    // and the providers seen are the evidence the run exists to produce.
    console.log(`${result.ok ? "ok  " : "FAIL"} ${result.label}${result.detail ? ` -> ${result.detail}` : ""}`);
    if (!result.ok) {
      failed += 1;
    }
  }
  console.log(
    failed === 0
      ? `\nALL ${results.length} LIVE CHECKS PASS`
      : `\n${failed} of ${results.length} LIVE CHECKS FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

if (!fs.existsSync(path.join(EXTENSION_ROOT, "package.json"))) {
  console.error("Run this from the extension directory.");
  process.exit(2);
}

main().catch((error) => {
  console.error("live check failed:", error.message);
  process.exit(2);
});
