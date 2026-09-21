/*
 * Exercises the compiled runtime resolver in plain Node.
 *
 * The resolver decides which `pi` PiCode runs, and a mistake there is invisible
 * until someone switches runtime and the agent silently fails to start — which
 * is exactly what happened: the managed root was derived three levels up instead
 * of four, so the managed runtime would have installed itself into
 * `resources/resources/pi-runtime` and always reported "not installed".
 *
 * The `vscode` module is stubbed through a resolver hook rather than a fake
 * node_modules directory, so nothing here depends on the machine's layout beyond
 * the repository itself.
 *
 * Run with: npm test
 */
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

const EXTENSION_ROOT = path.resolve(__dirname, "..");
const REPOSITORY_ROOT = path.resolve(EXTENSION_ROOT, "..", "..");
const STAGED_EXTENSION = path.join(
  REPOSITORY_ROOT,
  "resources",
  "app",
  "extensions",
  "picode-pi-chat",
);

// The resolver reads configuration through `vscode.workspace`, driven here by
// environment variables so each case can be exercised without an editor.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "vscode-stub.js");
  }
  return originalResolve.call(this, request, ...rest);
};

async function main() {
  const compiled = path.join(EXTENSION_ROOT, "out", "runtime.js");
  if (!fs.existsSync(compiled)) {
    console.error(`Missing ${compiled}. Run "npm run compile" first.`);
    process.exit(2);
  }
  const module = await import(pathToFileURL(compiled).href);
  const runtime = module.managedRoot ? module : module.default;

  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

  const extensionUri = { fsPath: STAGED_EXTENSION };

  // --- paths -----------------------------------------------------------------

  const root = runtime.managedRoot(extensionUri);
  check(
    "managedRoot sits under <distribution>/resources/pi-runtime",
    root.endsWith(path.join("resources", "pi-runtime")),
    root,
  );

const distributionRoot = path.dirname(path.dirname(root));
// Name-agnostic on purpose: Step 5 renames the executable, so asserting a particular name
// makes this a statement about one machine's state rather than about the derivation.
const executables = ["PiCode.exe", "VSCodium.exe"];
check(
    "the derived root is the distribution itself (the editor is there)",
    executables.some((name) => fs.existsSync(path.join(distributionRoot, name))),
    distributionRoot,
);

  const pin = runtime.readPin(extensionUri);
  check(
    "the pinned version ships with the extension as data",
    pin.package === "@earendil-works/pi-coding-agent" && /^\d+\.\d+\.\d+$/.test(pin.version),
    JSON.stringify(pin),
  );

  // --- resolution per mode ---------------------------------------------------

  process.env.TEST_RUNTIME_MODE = "path";
  const pathRuntime = runtime.resolveRuntime(extensionUri);
  check(
    "path mode hands the client the configured name verbatim",
    pathRuntime.executable === "pi" && pathRuntime.argsPrefix.length === 0,
    JSON.stringify(pathRuntime),
  );

  process.env.TEST_RUNTIME_MODE = "managed";
  const managedRuntime = runtime.resolveRuntime(extensionUri);
  const bundle = managedRuntime.argsPrefix[0];
  check(
    "managed mode runs node on the pinned bundle instead of the npm shim",
    managedRuntime.executable === "node" &&
      managedRuntime.argsPrefix.length === 1 &&
      bundle.endsWith(
        path.join("@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
      ),
    `${managedRuntime.executable} ${bundle}`,
  );
  check("the managed bundle lives inside the distribution", bundle.startsWith(root), bundle);

  // --- availability ----------------------------------------------------------

  process.env.TEST_RUNTIME_MODE = "custom";
  process.env.TEST_EXECUTABLE_PATH = "definitely-not-installed-xyz";
  const missing = await runtime.describeRuntime(extensionUri);
  check(
    "a custom executable that is absent is reported as unavailable",
    missing.available === false && missing.version === undefined,
    JSON.stringify(missing),
  );

  delete process.env.TEST_EXECUTABLE_PATH;
  process.env.TEST_RUNTIME_MODE = "path";

  const resolvedOnPath = runtime.resolveOnPath("pi");
  check(
    "a bare name is resolved through PATHEXT, which spawn does not do",
    Boolean(resolvedOnPath) && /pi\.(cmd|exe)$/i.test(resolvedOnPath),
    resolvedOnPath,
  );

  const version = await runtime.probeVersion(resolvedOnPath);
  check("the resolved pi answers --version", /^\d+\.\d+\.\d+$/.test(version ?? ""), version);

  const described = await runtime.describeRuntime(extensionUri);
  check(
    "describing path mode reports the active version",
    described.mode === "path" &&
      described.available === true &&
      /^\d+\.\d+\.\d+$/.test(described.version ?? ""),
    JSON.stringify(described),
  );

process.env.TEST_RUNTIME_MODE = "managed";
const managedDescriptor = await runtime.describeRuntime(extensionUri);
// Deliberately not asserting a particular machine state: whether PiCode's own pi is
// installed here is a fact about this disk, not about the code. What must hold either
// way is that the report is internally consistent, and that a version appears exactly
// when the runtime is installed.
check(
    "describing managed mode is consistent with whether it is installed",
    managedDescriptor.mode === "managed" &&
      managedDescriptor.available === managedDescriptor.managedInstalled &&
      (managedDescriptor.managedInstalled
            ? /^\d+\.\d+\.\d+$/.test(managedDescriptor.version ?? "")
            : managedDescriptor.version === undefined),
    JSON.stringify({
      installed: managedDescriptor.managedInstalled,
      available: managedDescriptor.available,
      version: managedDescriptor.version,
    }),
);

  // --- report ----------------------------------------------------------------

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
