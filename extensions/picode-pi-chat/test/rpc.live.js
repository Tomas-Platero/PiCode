/*
 * Live check of the pi surface PiCode depends on: the RPC commands the panel's
 * model and reasoning controls use, and the CLI that manages packages.
 *
 * This is not part of `npm test`: it needs a working `pi` on PATH and it talks to
 * a real agent process. It exists because the panel's commands are only as good
 * as pi's protocol, and because three of the four commands used here — the
 * reasoning ones and `cycle_model` — were added on the strength of the protocol
 * documentation, not of an existing implementation in this client.
 *
 * Run with: npm run test:live
 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const EXTENSION_ROOT = path.resolve(__dirname, "..");

// pi-cli.ts reaches runtime.ts, which imports `vscode`. The stub keeps the CLI
// parser usable outside an editor.
const Module = require("node:module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "vscode-stub.js");
  }
  return originalResolve.call(this, request, ...rest);
};

const { parseInstalledPackages } = require(path.join(EXTENSION_ROOT, "out", "pi-cli.js"));

/** Runs the pi CLI, which is not its RPC mode, and collects what it printed. */
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn("pi", args, {
      shell: process.platform === "win32",
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" },
    });
    let text = "";
    const collect = (chunk) => {
      text += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", () => resolve({ ok: false, code: null, text }));
    child.on("close", (code) => resolve({ ok: code === 0, code, text }));
  });
}

function startAgent() {
  // The Windows npm shim is a `.cmd`, which Node refuses to execute without a
  // shell. This mirrors what the RPC client does for a bare name.
  const child = spawn("pi", ["--mode", "rpc"], {
    shell: process.platform === "win32",
    windowsHide: true,
  });

  const pending = new Map();
  let buffer = "";
  let sequence = 0;

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      // Strict framing: LF is the only delimiter. A trailing CR is stripped.
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.trim().length > 0) {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          record = undefined;
        }
        if (record && record.type === "response" && pending.has(record.id)) {
          pending.get(record.id)(record);
          pending.delete(record.id);
        }
      }
      newline = buffer.indexOf("\n");
    }
  });

  const send = (command) =>
    new Promise((resolve, reject) => {
      const id = `t${(sequence += 1)}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no response to ${command.type} within 20s`));
      }, 20_000);
      pending.set(id, (record) => {
        clearTimeout(timer);
        resolve(record);
      });
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, "utf8");
    });

  return { child, send };
}

async function main() {
  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

  const { child, send } = startAgent();
  try {
    const state = await send({ type: "get_state" });
    check(
      "get_state reports the live model with provider and name",
      state.success === true &&
        typeof state.data?.model?.id === "string" &&
        typeof state.data?.model?.provider === "string",
      JSON.stringify(state.data?.model),
    );

    const models = await send({ type: "get_available_models" });
    const list = models.data?.models ?? [];
    check(
      "get_available_models returns the catalogue the picker searches",
      models.success === true && Array.isArray(list) && list.length > 50,
      `${list.length} models`,
    );

    const levels = await send({ type: "get_available_thinking_levels" });
    const available = levels.data?.levels ?? [];
    check(
      "get_available_thinking_levels reports what the current model supports",
      levels.success === true && Array.isArray(available) && available.length > 0,
      JSON.stringify(available),
    );

    // The picker only offers these, so a level outside this list must never be sent.
    const supported = available[available.length - 1];
    const applied = await send({ type: "set_thinking_level", level: supported });
    const after = await send({ type: "get_state" });
    check(
      `set_thinking_level accepts "${supported}" and it sticks`,
      applied.success === true && after.data?.thinkingLevel === supported,
      `thinkingLevel is now ${after.data?.thinkingLevel}`,
    );

    const cycled = await send({ type: "cycle_model" });
    check(
      "cycle_model answers with a model or null, never an error",
      cycled.success === true && (cycled.data === null || typeof cycled.data?.model?.id === "string"),
      JSON.stringify(cycled.data === null ? null : cycled.data?.model?.id),
    );

    const cycledThinking = await send({ type: "cycle_thinking_level" });
    check(
      "cycle_thinking_level answers with a level or null",
      cycledThinking.success === true &&
        (cycledThinking.data === null || typeof cycledThinking.data?.level === "string"),
      JSON.stringify(cycledThinking.data),
    );

    // The one surface that is not RPC: package management goes through the CLI.
    const cliList = await runCli(["list"]);
    const packages = parseInstalledPackages(cliList.text);
    check(
      "pi list runs and parses into packages the view can render",
      cliList.ok === true && packages.length > 0 && packages.every((entry) => entry.source.length > 0),
      `${packages.length} paquetes, primero: ${packages[0]?.source ?? "ninguno"}`,
    );
  } finally {
    child.kill();
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
