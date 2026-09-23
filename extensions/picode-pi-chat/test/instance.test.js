/*
 * Exercises the compiled instance resolver and profile scan in plain Node.
 *
 * Two things are asserted here, and nothing else in the product is wired to them
 * yet: which profile a runtime mode maps to, and what a read-only pass over a
 * profile reports. The scan is the part that matters for privacy — the inventory is
 * metadata, and one check below proves a credential's value cannot reach it.
 *
 * The `vscode` module is stubbed through a resolver hook rather than a fake
 * node_modules directory, exactly like runtime.test.js does, because the resolver
 * derives the distribution root through `managedRoot`.
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

// The resolver reads no configuration, but it imports `managedRoot` from runtime.ts,
// which imports `vscode`; the stub is what lets the module load without an editor.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "vscode-stub.js");
  }
  return originalResolve.call(this, request, ...rest);
};

const SECRET = "SUPER-SECRET-TOKEN-9f3a";
const OTHER_SECRET = "ANOTHER-SECRET-111";

/** Writes a file, creating its parent directories. */
function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A profile holding one of everything, so every section of the inventory is non-empty. */
function completeProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picode-profile-"));
  writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify({
      packages: ["npm:pi-lens", { source: "git:github.com/x/y", autoload: false }],
    }),
  );
  writeFile(
    path.join(dir, "auth.json"),
    JSON.stringify({
      anthropic: { type: "api_key", key: SECRET },
      nan: { type: "api_key", key: OTHER_SECRET },
    }),
  );
  writeFile(
    path.join(dir, "models.json"),
    JSON.stringify({
      providers: {
        omni: { models: [{ id: "auto" }, { id: "auto/best" }] },
        other: { models: [{ id: "m" }] },
      },
    }),
  );
  writeFile(
    path.join(dir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        local: { command: "node", args: [] },
        remote: { url: "https://example.test/mcp" },
      },
    }),
  );
  writeFile(path.join(dir, "skills", "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
  writeFile(path.join(dir, "skills", "beta", "SKILL.md"), "---\nname: beta\n---\n");
  // Neither of these is a skill pi loads: a hidden directory and node_modules.
  writeFile(path.join(dir, "skills", ".hidden", "SKILL.md"), "---\nname: hidden\n---\n");
  writeFile(path.join(dir, "skills", "node_modules", "x", "SKILL.md"), "---\nname: x\n---\n");
  writeFile(path.join(dir, "skills", "notes.txt"), "not a skill\n");
  writeFile(path.join(dir, "memory", "one.md"), "a\n");
  writeFile(path.join(dir, "memory", "two.md"), "b\n");
  writeFile(path.join(dir, "sessions", "one.jsonl"), "{}\n");
  return dir;
}

async function main() {
  const compiled = path.join(EXTENSION_ROOT, "out", "instance.js");
  if (!fs.existsSync(compiled)) {
    console.error(`Missing ${compiled}. Run "npm run compile" first.`);
    process.exit(2);
  }
  const module = await import(pathToFileURL(compiled).href);
  const instance = module.instanceAgentDir ? module : module.default;

  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });
  const cleanups = [];
  const cleanup = (dir) => cleanups.push(dir);

  const extensionUri = { fsPath: STAGED_EXTENSION };

  // --- the resolver per mode -------------------------------------------------

  const distributionRoot = path.resolve(STAGED_EXTENSION, "..", "..", "..", "..");
  const expectedProfile = path.join(distributionRoot, "data", "pi-agent");

  const managed = instance.instanceAgentDir(extensionUri, "managed");
  check(
    "the managed instance's profile is pinned to <distribution>/data/pi-agent",
    managed === expectedProfile,
    `${managed} (expected ${expectedProfile})`,
  );
  check(
    "the managed profile sits inside the distribution, not one level out",
    managed.startsWith(distributionRoot + path.sep) &&
      path.basename(managed) === "pi-agent" &&
      path.basename(path.dirname(managed)) === "data",
    managed,
  );

  check(
    "the path instance asks pi to resolve its own default",
    instance.instanceAgentDir(extensionUri, "path") === undefined,
    String(instance.instanceAgentDir(extensionUri, "path")),
  );
  check(
    "the custom instance asks pi to resolve its own default",
    instance.instanceAgentDir(extensionUri, "custom") === undefined,
    String(instance.instanceAgentDir(extensionUri, "custom")),
  );

  // --- the pure parsers ------------------------------------------------------

  const credentialsWithValues = instance.parseCredentials({
    anthropic: { type: "api_key", key: SECRET },
  });
  check(
    "the credential parser returns names, never values",
    credentialsWithValues.count === 1 &&
      credentialsWithValues.providers[0] === "anthropic" &&
      !JSON.stringify(credentialsWithValues).includes(SECRET),
    JSON.stringify(credentialsWithValues),
  );
  check(
    "a value that is not a JSON object has no credentials to report",
    instance.parseCredentials(undefined).count === 0 &&
      instance.parseCredentials("nope").count === 0 &&
      instance.parseCredentials(["anthropic"]).count === 0,
    JSON.stringify(instance.parseCredentials(["anthropic"])),
  );

  const packagesFromStrings = instance.parsePackages({
    packages: ["npm:a", { source: "npm:b" }, { nope: true }, "npm:c"],
  });
  check(
    "package entries are read from both of pi's stored shapes",
    packagesFromStrings.count === 3 &&
      packagesFromStrings.sources.join(",") === "npm:a,npm:b,npm:c",
    JSON.stringify(packagesFromStrings),
  );
  check(
    "a settings object without a packages array holds no packages",
    instance.parsePackages({}).count === 0 && instance.parsePackages({ packages: "x" }).count === 0,
    JSON.stringify(instance.parsePackages({ packages: "x" })),
  );

  const parsedModels = instance.parseModels({
    providers: { a: { models: [{ id: "1" }, { id: "2" }] }, b: {} },
  });
  check(
    "models are counted per provider, with the provider ids",
    parsedModels.providerCount === 2 &&
      parsedModels.modelCount === 2 &&
      parsedModels.providerIds.join(",") === "a,b",
    JSON.stringify(parsedModels),
  );

  const parsedMcp = instance.parseMcpServers({
    mcpServers: { a: { command: "node" }, b: { url: "https://x" }, c: {} },
  });
  check(
    "MCP servers are named and classified by command, URL or neither",
    parsedMcp.count === 3 &&
      parsedMcp.servers[0].kind === "command" &&
      parsedMcp.servers[1].kind === "url" &&
      parsedMcp.servers[2].kind === "unknown",
    JSON.stringify(parsedMcp),
  );

  // --- a complete inventory from fixtures ------------------------------------

  const complete = completeProfile();
  cleanup(complete);
  const inventory = instance.scanProfile(complete);
  check(
    "a complete fixture reports every section",
    inventory.agentDir === complete &&
      inventory.packages.count === 2 &&
      inventory.packages.sources.join(",") === "npm:pi-lens,git:github.com/x/y" &&
      inventory.credentials.count === 2 &&
      inventory.credentials.providers.join(",") === "anthropic,nan" &&
      inventory.models.providerCount === 2 &&
      inventory.models.modelCount === 3 &&
      inventory.models.providerIds.join(",") === "omni,other" &&
      inventory.mcp.count === 2 &&
      inventory.mcp.servers[0].name === "local" &&
      inventory.mcp.servers[0].kind === "command" &&
      inventory.mcp.servers[1].name === "remote" &&
      inventory.mcp.servers[1].kind === "url" &&
      inventory.skills === 2 &&
      inventory.memory.exists === true &&
      inventory.memory.count === 2 &&
      inventory.sessions.exists === true &&
      inventory.sessions.count === 1,
    JSON.stringify(inventory),
  );

  // --- the redaction check ---------------------------------------------------

  const serialized = JSON.stringify(inventory);
  check(
    "no credential value can appear anywhere in the inventory",
    !serialized.includes(SECRET) &&
      !serialized.includes(OTHER_SECRET) &&
      !serialized.includes('"key"') &&
      !serialized.includes('"type"'),
    serialized.replace(SECRET, "<redacted>").replace(OTHER_SECRET, "<redacted>"),
  );

  // --- a directory that holds nothing ----------------------------------------

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "picode-profile-empty-"));
  cleanup(empty);
  const emptyInventory = instance.scanProfile(empty);
  check(
    "a profile that holds nothing reports empty sections instead of failing",
    emptyInventory.packages.count === 0 &&
      emptyInventory.packages.sources.length === 0 &&
      emptyInventory.credentials.count === 0 &&
      emptyInventory.models.providerCount === 0 &&
      emptyInventory.models.modelCount === 0 &&
      emptyInventory.mcp.count === 0 &&
      emptyInventory.skills === 0 &&
      emptyInventory.memory.exists === false &&
      emptyInventory.memory.count === undefined &&
      emptyInventory.sessions.exists === false,
    JSON.stringify(emptyInventory),
  );

  // --- an unreadable file among readable ones --------------------------------

  const broken = fs.mkdtempSync(path.join(os.tmpdir(), "picode-profile-broken-"));
  cleanup(broken);
  writeFile(
    path.join(broken, "settings.json"),
    JSON.stringify({ packages: ["npm:pi-lens", "git:github.com/x/y"] }),
  );
  // One file is a directory, so reading it fails as a file; another is not JSON.
  fs.mkdirSync(path.join(broken, "auth.json"), { recursive: true });
  writeFile(path.join(broken, "models.json"), "{ this is not json");
  const brokenInventory = instance.scanProfile(broken);
  check(
    "an unreadable file leaves its section empty without touching the readable ones",
    brokenInventory.packages.count === 2 &&
      brokenInventory.credentials.count === 0 &&
      brokenInventory.credentials.providers.length === 0 &&
      brokenInventory.models.providerCount === 0 &&
      brokenInventory.models.modelCount === 0,
    JSON.stringify(brokenInventory),
  );

  // --- a missing profile altogether ------------------------------------------

  const absent = path.join(os.tmpdir(), "picode-profile-does-not-exist-xyz");
  fs.rmSync(absent, { recursive: true, force: true });
  const absentInventory = instance.scanProfile(absent);
  check(
    "an absent profile is an empty inventory, not an exception",
    absentInventory.credentials.count === 0 &&
      absentInventory.packages.count === 0 &&
      absentInventory.memory.exists === false &&
      absentInventory.sessions.exists === false,
    JSON.stringify(absentInventory),
  );

  // --- report ----------------------------------------------------------------

  for (const dir of cleanups) {
    fs.rmSync(dir, { recursive: true, force: true });
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
