/*
 * Exercises the compiled profile import in plain Node, against temporary directories
 * only. No check here — and no code path in the module under test — may touch the real
 * profile on this machine.
 *
 * The suite mirrors the feature's acceptance criteria: an empty target, an occupied
 * one, a half-written source, credentials declined, repeatability, and the promise that
 * the source is read and never written (the whole source tree is snapshotted and
 * compared). The import module pulls in no editor API, so unlike instance.test.js it
 * needs no `vscode` stub.
 *
 * Run with: npm test
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const EXTENSION_ROOT = path.resolve(__dirname, "..");

/** Writes a file, creating its parent directories. */
function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A fresh temporary directory the caller must clean up. */
function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Every file under a directory as a sorted list of `relative-path\0contents`.
 *
 * Sorting keeps the comparison independent of the order the filesystem lists entries
 * in, so the check is about the source not changing, not about readdir order.
 */
function snapshot(dir) {
  const rows = [];
  const walk = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const child = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(absolute, child);
      } else if (entry.isFile()) {
        rows.push(`${child}\u0000${fs.readFileSync(absolute, "utf8")}`);
      }
    }
  };
  walk(dir, "");
  rows.sort();
  return rows.join("\n");
}

/** A source profile holding one of everything the import knows. */
function sourceProfile() {
  const dir = tempDir("picode-import-source-");
  writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify({ packages: ["npm:pi-lens", { source: "git:github.com/x/y" }] }),
  );
  writeFile(path.join(dir, "models.json"), JSON.stringify({ providers: { omni: { models: [] } } }));
  writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { local: { command: "x" } } }));
  writeFile(path.join(dir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "S" } }));
  writeFile(path.join(dir, "skills", "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
  writeFile(path.join(dir, "skills", "beta", "SKILL.md"), "---\nname: beta\n---\n");
  writeFile(path.join(dir, "memory", "one.md"), "remembered\n");
  return dir;
}

async function main() {
  const compiled = path.join(EXTENSION_ROOT, "out", "instance-import.js");
  if (!fs.existsSync(compiled)) {
    console.error(`Missing ${compiled}. Run "npm run compile" first.`);
    process.exit(2);
  }
  const module = await import(pathToFileURL(compiled).href);
  const api = module.importProfile ? module : module.default;

  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });
  const cleanups = [];
  const cleanup = (dir) => cleanups.push(dir);
  const itemOf = (report, name) => report.items.find((entry) => entry.item === name);

  // --- an empty target -------------------------------------------------------

  const fullSource = sourceProfile();
  cleanup(fullSource);
  const emptyTarget = tempDir("picode-import-target-empty-");
  cleanup(emptyTarget);

  const emptyReport = await api.importProfile({
    from: fullSource,
    to: emptyTarget,
    selection: {
      settings: true,
      models: true,
      mcp: true,
      skills: true,
      memory: true,
      credentials: false,
    },
  });

  check(
    "an empty target receives every chosen item as copied",
    ["settings", "models", "mcp", "skills", "memory"].every(
      (name) => itemOf(emptyReport, name).status === "copied",
    ),
    JSON.stringify(emptyReport),
  );
  check(
    "a directory item reports how many files it moved",
    itemOf(emptyReport, "skills").files === 2 && itemOf(emptyReport, "memory").files === 1,
    JSON.stringify(emptyReport),
  );
  check(
    "the counts add up to the number of items",
    emptyReport.counts.copied === 5 &&
      emptyReport.counts.declined === 1 &&
      emptyReport.counts.absent === 0 &&
      emptyReport.counts.failed === 0,
    JSON.stringify(emptyReport.counts),
  );

  // --- credentials are a separate decision -----------------------------------

  check(
    "a declined credential is reported as declined, not as absent",
    itemOf(emptyReport, "credentials").status === "declined" &&
      itemOf(emptyReport, "credentials").path === path.join(emptyTarget, "auth.json"),
    JSON.stringify(itemOf(emptyReport, "credentials")),
  );
  check(
    "a declined credential is never written to the target",
    !fs.existsSync(path.join(emptyTarget, "auth.json")),
    fs.readdirSync(emptyTarget).join(","),
  );

  // --- an occupied target ----------------------------------------------------

  const occupiedTarget = tempDir("picode-import-target-occupied-");
  cleanup(occupiedTarget);
  writeFile(path.join(occupiedTarget, "settings.json"), JSON.stringify({ packages: ["old"] }));
  writeFile(path.join(occupiedTarget, "skills", "keep", "SKILL.md"), "---\nname: keep\n---\n");

  const occupiedReport = await api.importProfile({
    from: fullSource,
    to: occupiedTarget,
    selection: { settings: true, skills: true, credentials: true },
  });

  check(
    "an item that lands on existing content is reported as overwritten",
    itemOf(occupiedReport, "settings").status === "overwritten" &&
      itemOf(occupiedReport, "skills").status === "overwritten",
    JSON.stringify(occupiedReport),
  );
  check(
    "the copy replaces the named item and leaves the rest of the target alone",
    JSON.parse(fs.readFileSync(path.join(occupiedTarget, "settings.json"), "utf8")).packages[0] ===
      "npm:pi-lens" &&
      fs.existsSync(path.join(occupiedTarget, "skills", "keep", "SKILL.md")) &&
      fs.existsSync(path.join(occupiedTarget, "skills", "alpha", "SKILL.md")),
    snapshot(occupiedTarget),
  );
  check(
    "credentials copied when asked are copied once, not declined",
    itemOf(occupiedReport, "credentials").status === "copied" &&
      fs.existsSync(path.join(occupiedTarget, "auth.json")),
    JSON.stringify(itemOf(occupiedReport, "credentials")),
  );
  check(
    "an unselected item is still reported, as declined",
    itemOf(occupiedReport, "mcp").status === "declined" &&
      !fs.existsSync(path.join(occupiedTarget, "mcp.json")),
    JSON.stringify(itemOf(occupiedReport, "mcp")),
  );

  // --- a half-written source -------------------------------------------------

  const brokenSource = tempDir("picode-import-source-broken-");
  cleanup(brokenSource);
  writeFile(path.join(brokenSource, "settings.json"), '{ "packages": ["npm:pi-lens"');
  writeFile(path.join(brokenSource, "models.json"), JSON.stringify({ providers: {} }));
  writeFile(path.join(brokenSource, "skills", "only", "SKILL.md"), "---\nname: only\n---\n");
  const brokenTarget = tempDir("picode-import-target-broken-");
  cleanup(brokenTarget);

  const brokenReport = await api.importProfile({
    from: brokenSource,
    to: brokenTarget,
    selection: { settings: true, models: true, skills: true, memory: true },
  });

  check(
    "a malformed source file is reported as failed, not thrown",
    itemOf(brokenReport, "settings").status === "failed" &&
      typeof itemOf(brokenReport, "settings").reason === "string",
    JSON.stringify(itemOf(brokenReport, "settings")),
  );
  check(
    "the rest of the import continues past a failed item",
    itemOf(brokenReport, "models").status === "copied" &&
      itemOf(brokenReport, "skills").status === "copied" &&
      fs.existsSync(path.join(brokenTarget, "models.json")) &&
      fs.existsSync(path.join(brokenTarget, "skills", "only", "SKILL.md")),
    JSON.stringify(brokenReport),
  );
  check(
    "a chosen item the source does not have is absent, not thrown",
    itemOf(brokenReport, "memory").status === "absent" &&
      !fs.existsSync(path.join(brokenTarget, "memory")),
    JSON.stringify(itemOf(brokenReport, "memory")),
  );

  // --- repeatability ---------------------------------------------------------

  const repeatSource = sourceProfile();
  cleanup(repeatSource);
  const repeatTarget = tempDir("picode-import-target-repeat-");
  cleanup(repeatTarget);
  const selection = { settings: true, models: true, skills: true, credentials: false };

  const progress = [];
  const first = await api.importProfile({
    from: repeatSource,
    to: repeatTarget,
    selection,
    onProgress: (item) => progress.push(item.item),
  });
  const second = await api.importProfile({ from: repeatSource, to: repeatTarget, selection });

  check(
    "a second import reports the same shape with overwritten where content matched",
    second.items.map((entry) => entry.item).join(",") ===
      first.items.map((entry) => entry.item).join(",") &&
      ["settings", "models", "skills"].every(
        (name) => itemOf(second, name).status === "overwritten",
      ),
    JSON.stringify(second),
  );
  check(
    "progress is reported once per item in the report's order",
    progress.length === first.items.length &&
      progress.join(",") === first.items.map((entry) => entry.item).join(","),
    progress.join(","),
  );

  // --- the source is read and never written ----------------------------------

  const sourceBefore = snapshot(fullSource);
  const guardTarget = tempDir("picode-import-target-guard-");
  cleanup(guardTarget);
  await api.importProfile({
    from: fullSource,
    to: guardTarget,
    selection: {
      settings: true,
      models: true,
      mcp: true,
      skills: true,
      memory: true,
      credentials: true,
    },
  });
  check(
    "nothing under the source tree changes: same files, same contents",
    snapshot(fullSource) === sourceBefore,
    sourceBefore,
  );

  await api
    .importProfile({ from: fullSource, to: fullSource, selection: { settings: true } })
    .then(() => check("importing a profile into itself is refused", false, "resolved instead of throwing"))
    .catch((error) =>
      check(
        "importing a profile into itself is refused",
        error instanceof Error,
        String(error),
      ),
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
