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
const os = require("node:os");
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
  check(
    "embedded availability follows the resolved entry",
    (described.embeddedAvailable === true) === (described.sdkEntry !== undefined),
    JSON.stringify({ embeddedAvailable: described.embeddedAvailable, sdkEntry: described.sdkEntry }),
  );

  // --- embedded entry --------------------------------------------------------

  // Two shapes are probed: an npm global prefix, where the shim sits beside
  // `node_modules`, and a path inside the package itself.
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "picode-sdk-prefix-"));
  const packageDir = path.join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
  fs.mkdirSync(path.join(packageDir, "dist", "bundle"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "dist", "index.js"), "");

  const fromPrefix = runtime.findSdkEntry(prefix);
  check(
    "the ESM entry is found from an npm prefix, beside node_modules",
    fromPrefix === path.join(packageDir, "dist", "index.js"),
    String(fromPrefix),
  );

  const fromInside = runtime.findSdkEntry(path.join(packageDir, "dist", "bundle"));
  check(
    "the ESM entry is found from inside the package's own bundle directory",
    fromInside === path.join(packageDir, "dist", "index.js"),
    String(fromInside),
  );

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "picode-sdk-empty-"));
  check(
    "a tree without the package reports no entry rather than guessing",
    runtime.findSdkEntry(empty) === undefined,
    String(runtime.findSdkEntry(empty)),
  );

  fs.rmSync(prefix, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });

  check(
    "the transport defaults to rpc",
    runtime.readTransport() === "rpc",
    runtime.readTransport(),
  );

  process.env.TEST_TRANSPORT = "embedded";
  check(
    "the configured transport is read back",
    runtime.readTransport() === "embedded",
    runtime.readTransport(),
  );
  process.env.TEST_TRANSPORT = "nonsense";
  check(
    "an unrecognised transport falls back to rpc",
    runtime.readTransport() === "rpc",
    runtime.readTransport(),
  );
  delete process.env.TEST_TRANSPORT;

  process.env.TEST_RUNTIME_MODE = "custom";
  process.env.TEST_EXECUTABLE_PATH = "definitely-not-installed-xyz";
  const noEntry = await runtime.describeRuntime(extensionUri);
  check(
    "a missing runtime offers no embedded entry",
    noEntry.embeddedAvailable === false && noEntry.sdkEntry === undefined,
    JSON.stringify({ embeddedAvailable: noEntry.embeddedAvailable, sdkEntry: noEntry.sdkEntry }),
  );
  delete process.env.TEST_EXECUTABLE_PATH;

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

  // --- backend choice --------------------------------------------------------

  // The environment is restored at the end of this section, so every TEST_* value
  // this one touches is put back as the sections above left it.
  process.env.TEST_RUNTIME_MODE = "path";
  delete process.env.TEST_EXECUTABLE_PATH;
  delete process.env.TEST_TRANSPORT;

  const defaultChoice = runtime.chooseBackend(extensionUri);
  check(
    "an unset transport chooses rpc and says nothing about the other backend",
    defaultChoice.transport === "rpc" &&
      defaultChoice.unavailable === undefined &&
      defaultChoice.sdkEntry === undefined,
    JSON.stringify(defaultChoice),
  );

  process.env.TEST_TRANSPORT = "embedded";
  process.env.TEST_RUNTIME_MODE = "custom";
  process.env.TEST_EXECUTABLE_PATH = "definitely-not-installed-xyz";
  const unimportable = runtime.chooseBackend(extensionUri);
  check(
    "an embedded request over a pi with no entry falls back to rpc and reports why",
    unimportable.transport === "rpc" &&
      unimportable.sdkEntry === undefined &&
      typeof unimportable.unavailable === "string" &&
      unimportable.unavailable.length > 0,
    JSON.stringify(unimportable),
  );

  process.env.TEST_RUNTIME_MODE = "path";
  delete process.env.TEST_EXECUTABLE_PATH;
  // Machine-dependent by design, like the --version probe above: whether a pi is
  // installed here is a fact about this disk, so the guard decides what is measurable
  // and the assertion only runs against a real entry.
  const realEntry = runtime.resolveSdkEntry(extensionUri);
  if (realEntry === undefined) {
    check(
      "the embedded transport is not measurable on this machine: no importable pi on PATH",
      true,
      "guard: resolveSdkEntry found nothing to import",
    );
  } else {
    const embedded = runtime.chooseBackend(extensionUri);
    check(
      "an embedded request hands over the active pi's entry, which exists on disk",
      embedded.transport === "embedded" &&
        embedded.sdkEntry === realEntry &&
        embedded.unavailable === undefined &&
        fs.existsSync(embedded.sdkEntry),
      JSON.stringify(embedded),
    );
  }

  process.env.TEST_TRANSPORT = "nonsense";
  const nonsense = runtime.chooseBackend(extensionUri);
  check(
    "an unrecognised transport chooses rpc without claiming the other one failed",
    nonsense.transport === "rpc" &&
      nonsense.unavailable === undefined &&
      nonsense.sdkEntry === undefined,
    JSON.stringify(nonsense),
  );

  delete process.env.TEST_TRANSPORT;
  process.env.TEST_RUNTIME_MODE = "managed";

  // --- the managed pi's version row ------------------------------------------

  check(
    "published versions are ordered numerically, not as text",
    runtime.compareVersions("0.87.1", "0.86.9") > 0 &&
      runtime.compareVersions("0.86.1", "0.86.1") === 0 &&
      runtime.compareVersions("0.86.1", "0.87.1") < 0 &&
      runtime.compareVersions("1.0.0", "0.99.99") > 0 &&
      runtime.compareVersions("0.86.1-rc.1", "0.86.1") === 0,
    JSON.stringify([
      runtime.compareVersions("0.87.1", "0.86.9"),
      runtime.compareVersions("0.86.1", "0.86.1"),
      runtime.compareVersions("1.0.0", "0.99.99"),
    ]),
  );
  check(
    "a version that is not x.y.z cannot be ordered",
    runtime.compareVersions("nonsense", "0.86.1") === undefined &&
      runtime.compareVersions("0.86.1", "") === undefined,
    String(runtime.compareVersions("nonsense", "0.86.1")),
  );

  const upToDate = runtime.buildPiUpdateReport({
    installed: "0.87.1",
    managedInstalled: true,
    latest: "0.87.1",
  });
  check(
    "a record that matches the registry says so and offers nothing to install",
    upToDate.state === "current" &&
      upToDate.updateAvailable === false &&
      upToDate.message === "Instalada la 0.87.1 · es la última publicada.",
    JSON.stringify(upToDate),
  );

  const pending = runtime.buildPiUpdateReport({
    installed: "0.86.1",
    managedInstalled: true,
    latest: "0.87.1",
  });
  check(
    "a newer published version is named next to the installed one",
    pending.state === "available" &&
      pending.updateAvailable === true &&
      pending.message === "Instalada la 0.86.1 · publicada la 0.87.1.",
    JSON.stringify(pending),
  );

  const unchecked = runtime.buildPiUpdateReport({
    installed: "0.86.1",
    managedInstalled: true,
    latest: undefined,
  });
  check(
    "a check that did not answer says so instead of claiming there is no update",
    unchecked.state === "unknown" &&
      unchecked.updateAvailable === false &&
      unchecked.latest === undefined &&
      unchecked.message === "Instalada la 0.86.1 · no se pudo comprobar la última publicada.",
    JSON.stringify(unchecked),
  );

  const absent = runtime.buildPiUpdateReport({
    installed: "0.86.1",
    managedInstalled: false,
    latest: "0.87.1",
  });
  check(
    "a record with nothing on disk reads as not installed",
    absent.state === "missing" &&
      absent.updateAvailable === true &&
      absent.message === "Sin instalar · publicada la 0.87.1.",
    JSON.stringify(absent),
  );
  check(
    "with nothing installed and no answer, the row admits it cannot tell",
    runtime.buildPiUpdateReport({ installed: "0.86.1", managedInstalled: false, latest: undefined })
      .message === "Sin instalar · no se pudo comprobar la última publicada.",
    runtime.buildPiUpdateReport({ installed: "0.86.1", managedInstalled: false, latest: undefined })
      .message,
  );

  const publishedOlder = runtime.buildPiUpdateReport({
    installed: "0.87.1",
    managedInstalled: true,
    latest: "0.86.1",
  });
  check(
    "a published version older than the installed one is named as older",
    publishedOlder.updateAvailable === true && /más antigua/.test(publishedOlder.message),
    publishedOlder.message,
  );

  // --- the record the install leaves behind ----------------------------------

  // A throwaway extension directory, never the staged one: this section writes
  // `runtime.json`, and a test must not touch the copy the editor runs from.
  const pinExtension = fs.mkdtempSync(path.join(os.tmpdir(), "picode-pin-"));
  const pinRoot = fs.mkdtempSync(path.join(os.tmpdir(), "picode-managed-"));
  const pinUri = { fsPath: pinExtension };
  fs.writeFileSync(
    path.join(pinExtension, "runtime.json"),
    `${JSON.stringify({ package: runtime.PI_PACKAGE, version: "0.86.1" }, null, 2)}\n`,
  );

  const nothingLanded = runtime.recordManagedInstall(
    pinUri,
    pinRoot,
    runtime.readPin(pinUri),
  );
  check(
    "an install that left no package on disk records nothing and says so",
    nothingLanded.ok === false &&
      nothingLanded.version === undefined &&
      runtime.readPin(pinUri).version === "0.86.1",
    JSON.stringify({ result: nothingLanded, record: runtime.readPin(pinUri) }),
  );

  // The manifest npm leaves behind: its version is the installed one, and it is read
  // back rather than assumed, so the record cannot name a version the disk lacks.
  const stagedPackage = path.join(
    pinRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  fs.mkdirSync(stagedPackage, { recursive: true });
  fs.writeFileSync(
    path.join(stagedPackage, "package.json"),
    JSON.stringify({ name: runtime.PI_PACKAGE, version: "0.87.1" }),
  );

  const recorded = runtime.recordManagedInstall(pinUri, pinRoot, runtime.readPin(pinUri));
  const writtenPin = JSON.parse(fs.readFileSync(path.join(pinExtension, "runtime.json"), "utf8"));
  check(
    "a finished install records the version the package on disk carries",
    recorded.ok === true &&
      recorded.version === "0.87.1" &&
      runtime.readPin(pinUri).version === "0.87.1" &&
      writtenPin.version === "0.87.1" &&
      writtenPin.package === runtime.PI_PACKAGE,
    JSON.stringify({ result: recorded, record: writtenPin }),
  );

  fs.rmSync(pinExtension, { recursive: true, force: true });
  fs.rmSync(pinRoot, { recursive: true, force: true });

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
