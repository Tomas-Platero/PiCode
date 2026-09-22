/*
 * End-to-end check of the package install path.
 *
 * The panel's "install from a source" rows call `pi install` through `runPiCli`, and the
 * unit tests only cover the rows that offer it. This exercises the rest: the CLI call,
 * the listing, whether the agent actually loads what was installed, and whether removing
 * it puts the owner's pi configuration back as it was.
 *
 * It is deliberately not part of `npm test`: it needs a real `pi` on PATH.
 *
 * **It must never write to the owner's pi configuration.** The first version of this test
 * did, and a single `pi install` followed by `pi remove` was enough to prune the peer
 * dependencies that other installed extensions were resolving against: `pi-ai` and
 * `pi-coding-agent` disappeared from `~/.pi/agent/npm` and web access stopped loading.
 * `PI_CODING_AGENT_DIR` exists precisely for this, so every call below runs against a
 * throwaway directory and the owner's tree is only read, never written.
 *
 * The probe package registers a prompt template instead of an extension, because a prompt
 * is loaded the same way and does not execute code.
 *
 * Run with: npm run test:install
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { spawn } = require("node:child_process");

const EXTENSION_ROOT = path.resolve(__dirname, "..");

// pi-cli.ts reaches runtime.ts, which imports `vscode`.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "vscode-stub.js");
  }
  return originalResolve.call(this, request, ...rest);
};

const { runPiCli, parseInstalledPackages } = require(path.join(EXTENSION_ROOT, "out", "pi-cli.js"));

/** The shape `runPiCli` reads: the pi on PATH, as the default mode resolves it. */
const RUNTIME = { mode: "path", executable: "pi", argsPrefix: [], display: "pi" };

const PACKAGE_NAME = "zz-picode-probe";
const COMMAND_NAME = "zz-probe";

function writeProbePackage(root) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "prompts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: PACKAGE_NAME,
        version: "0.0.1",
        keywords: ["pi-package"],
        pi: { prompts: ["./prompts"] },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(root, "prompts", `${COMMAND_NAME}.md`),
    "---\ndescription: Sonda temporal de PiCode\n---\nResponde solo con la palabra sonda.\n",
  );
}

/** What pi reports as installed, using the parser the panel itself uses. */
async function installedSources() {
  const result = await runPiCli(RUNTIME, ["list"], undefined, () => {});
  return parseInstalledPackages(result.text).map((entry) => entry.source);
}

/** The commands a live agent registers, which is how a loaded package is detected. */
function agentCommands(timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", ["--mode", "rpc"], {
      shell: process.platform === "win32",
      windowsHide: true,
    });

    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("the agent did not answer get_commands in time"));
    }, timeoutMs);

    const finish = (error, commands) => {
      clearTimeout(timer);
      child.kill();
      if (error) {
        reject(error);
      } else {
        resolve(commands);
      }
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim().length > 0) {
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            record = undefined;
          }
          if (record && record.type === "response" && record.command === "get_commands") {
            finish(null, record.data?.commands ?? []);
            return;
          }
        }
        newline = buffer.indexOf("\n");
      }
    });

    child.on("error", (error) => finish(error, undefined));
    child.stdin.write(`${JSON.stringify({ type: "get_commands", id: "probe" })}\n`, "utf8");
  });
}

async function main() {
  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

  // pi reads PI_CODING_AGENT_DIR for its configuration, and every child process this test
  // spawns inherits the environment, so pointing it here is what keeps the owner's package
  // tree out of reach.
  const isolatedConfig = fs.mkdtempSync(path.join(os.tmpdir(), "picode-install-check-"));
  process.env.PI_CODING_AGENT_DIR = isolatedConfig;

  const packageRoot = path.join(os.tmpdir(), PACKAGE_NAME);
  writeProbePackage(packageRoot);

  const before = await installedSources();
  // Empty is the expected answer in a fresh configuration, so this only asserts that the
  // command answers rather than that it has anything to say.
  check("pi list answers before installing", Array.isArray(before), `${before.length} paquetes`);

  let installed = false;
  try {
    const install = await runPiCli(RUNTIME, ["install", packageRoot], undefined, () => {});
    installed = install.ok;
    check(
      "pi install accepts a local path",
      install.ok,
      install.ok ? "" : `exit ${install.code}: ${install.text.trim().slice(0, 200)}`,
    );

    if (install.ok) {
      const after = await installedSources();
      check(
        "the package shows up in pi list",
        after.some((source) => source.includes(PACKAGE_NAME)),
        `${after.length} paquetes, ninguno es ${PACKAGE_NAME}`,
      );

      // The point of installing: a loaded package registers its commands. A listing
      // alone would not prove the agent ever sees it.
      let commands = [];
      try {
        commands = await agentCommands();
      } catch (error) {
        check("the agent answers get_commands", false, error.message);
      }

      if (commands.length > 0) {
        const probe = commands.find((command) =>
          String(command.name ?? "").includes(COMMAND_NAME),
        );
        check(
          "the agent loads what was installed: its command is registered",
          probe !== undefined,
          `${commands.length} comandos, ninguno es ${COMMAND_NAME}`,
        );
        check(
          "the command is attributed to the package prompt, not to something else",
          probe?.source === "prompt",
          JSON.stringify(probe),
        );
      }
    }
  } finally {
    if (installed) {
      const remove = await runPiCli(RUNTIME, ["remove", packageRoot], undefined, () => {});
      check(
        "pi remove accepts the same source",
        remove.ok,
        remove.ok ? "" : `exit ${remove.code}: ${remove.text.trim().slice(0, 200)}`,
      );

      const final = await installedSources();
      check(
        "the isolated configuration is left as it was found",
        final.length === before.length &&
          !final.some((source) => source.includes(PACKAGE_NAME)),
        `antes ${before.length}, después ${final.length}`,
      );
    }
    fs.rmSync(packageRoot, { recursive: true, force: true });
    fs.rmSync(isolatedConfig, { recursive: true, force: true });
  }

  let failed = 0;
  for (const result of results) {
    console.log(
      `${result.ok ? "ok  " : "FAIL"} ${result.label}${result.ok || !result.detail ? "" : ` -> ${result.detail}`}`,
    );
    if (!result.ok) {
      failed += 1;
    }
  }
  console.log(
    failed === 0
      ? `\nALL ${results.length} INSTALL CHECKS PASS`
      : `\n${failed} of ${results.length} INSTALL CHECKS FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("install check failed:", error.message);
  process.exit(2);
});
