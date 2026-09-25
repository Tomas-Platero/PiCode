/*
 * Pins the set of files that call `resolveAgentDir(` directly.
 *
 * This is the guard against the shared profile creeping back in. `resolveAgentDir()`
 * answers with the *machine's* own profile — `PI_CODING_AGENT_DIR` when the owner set
 * it, `~/.pi/agent` otherwise — and PiCode now has two instances with two profiles.
 * An instance-bound reader that keeps calling it reads and writes the machine's
 * profile while believing it is using the selected one, which is silent by
 * construction: both profiles are valid directories, so nothing fails.
 *
 * The list below is therefore the *whole* allowed set, written down instead of
 * implied. It has shrunk to two entries, and that shorter list **is** the
 * demonstration that the isolation is complete: `instance.ts` is where the single
 * fallback from PiCode's own profile to the machine's is composed, and
 * `instance-import-command.ts` deliberately reads the machine's profile as the
 * import's source. Every other reader asks `selectedAgentDir()`, which follows the
 * guard. An entry that comes back is the regression this check exists to catch.
 *
 * A new entry means one of two things, and both are worth stopping for:
 *
 * - a new reader (or writer) of a profile that should have gone through
 *   `selectedAgentDir()` / `instanceProfileEnv()` instead, which is the bug this
 *   feature exists to remove; or
 * - a deliberate decision that the machine's profile is the right one here, which is
 *   allowed — but it has to be added to this list with its reason, so the decision is
 *   reviewed rather than inferred from a diff.
 *
 * The scan is comment-aware and line-based, and both matter: several files *mention*
 * `resolveAgentDir()` in a comment, and `transcription.ts` declares it. Counting
 * either as a call would make the guard fire on prose and force the list to grow for
 * no reason.
 *
 * Run with: npm test
 */
const path = require("node:path");
const fs = require("node:fs");

const EXTENSION_ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = path.join(EXTENSION_ROOT, "src");

/**
 * Every file allowed to call `resolveAgentDir(`, with the reason it is allowed.
 *
 * The list shrank to **one** entry, and that is the change worth recording: `instance.ts`
 * used to hold the single fallback from PiCode's own profile to the machine's, and the owner
 * removed the fallback — pi lives inside PiCode, and nothing is read from or written to the
 * machine's pi. What is left is the one act that is genuinely *about* that profile.
 *
 * Deliberately not sorted by hand: the check sorts both sides, so the list stays a
 * list of reasons rather than an ordering puzzle.
 */
const PINNED = [
  {
    file: "instance-import-command.ts",
    why: "the import's origin: reading the machine's profile on purpose, as the one-shot source of the copy. NOTE: this flow is now superseded — see AGENTS.md, «del pi del PATH no se añade NADA» — so this entry goes when the import surfaces do",
  },
];

/** A comment-only line: prose, not a call, however it names the resolver. */
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;
/** The declaration itself, which is not a call to itself. */
const DECLARATION = /^\s*(?:export\s+)?(?:async\s+)?function\s+resolveAgentDir\b/;
/** A call, or any other mention the two filters above did not take out. */
const CALL = /resolveAgentDir\s*\(/;

/**
 * The 1-based lines of `source` that call the resolver.
 *
 * Pure, so the two filters above can be checked against a snippet instead of trusted:
 * the day someone writes `resolveAgentDir` at the start of a line comment and the
 * regex stops matching, the checks below fail instead of the guard going quiet.
 */
function callsIn(source) {
  const hits = [];
  source.split(/\r?\n/).forEach((line, index) => {
    if (COMMENT_LINE.test(line) || DECLARATION.test(line)) {
      return;
    }
    if (CALL.test(line)) {
      hits.push(index + 1);
    }
  });
  return hits;
}

/**
 * Every TypeScript source under `directory`, recursively and repository-relative.
 *
 * Recursive on purpose: a flat listing would stop seeing a call the moment someone
 * moved a reader into `src/instance/…`, which is exactly the kind of quiet change
 * this guard is for.
 */
function sourcesUnder(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourcesUnder(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found.sort();
}

/** The repository-relative names of the sources whose text contains a call. */
function callersUnder(directory) {
  const callers = [];
  for (const full of sourcesUnder(directory)) {
    if (callsIn(fs.readFileSync(full, "utf8")).length > 0) {
      callers.push(path.relative(directory, full).split(path.sep).join("/"));
    }
  }
  return callers.sort();
}

function main() {
  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

  // --- the scan itself, on snippets -------------------------------------------

  check(
    "a comment that names resolveAgentDir() is not a call",
    callsIn(
      [
        "// resolveAgentDir() answers with the machine's profile",
        "/* resolveAgentDir() */",
        " * resolveAgentDir() in a block comment",
        "  /** `resolveAgentDir()` in a doc comment */",
      ].join("\n"),
    ).length === 0,
    JSON.stringify(callsIn("// resolveAgentDir()")),
  );

  check(
    "the declaration of resolveAgentDir is not one of its callers",
    callsIn("export function resolveAgentDir(env = process.env) {\n  return env.X;\n}").length === 0,
    JSON.stringify(callsIn("export function resolveAgentDir(env = process.env) {}")),
  );

  const snippetCalls = callsIn(
    ["const a = 1;", "const key = readNanApiKey(resolveAgentDir());", "\tconst to = instanceAgentDir(uri, runtime);"].join(
      "\n",
    ),
  );
  check(
    "a real call is found, with the line it is on",
    snippetCalls.length === 1 && snippetCalls[0] === 2,
    JSON.stringify(snippetCalls),
  );

  // --- the pinned set ---------------------------------------------------------

  const sources = sourcesUnder(SOURCE_ROOT);
  const callers = callersUnder(SOURCE_ROOT);
  const expected = PINNED.map((entry) => entry.file).sort();
  const inspected = sources.map((full) => path.relative(SOURCE_ROOT, full).split(path.sep).join("/"));

  check(
    `the scan inspects every TypeScript source under src/ (${sources.length} files)`,
    sources.length >= PINNED.length + 1 && inspected.every((name) => name.endsWith(".ts")),
    `${sources.length} files, first ${inspected[0] ?? "(none)"}`,
  );

  check(
    "every pinned file exists in src/ and says why it is allowed",
    PINNED.every(
      (entry) => inspected.includes(entry.file) && typeof entry.why === "string" && entry.why.trim().length > 0,
    ),
    PINNED.map((entry) => `${entry.file}: ${entry.why ? "reason" : "NO REASON"}`).join(" | "),
  );

  check(
    "resolveAgentDir( is called from exactly the pinned files",
    callers.join(",") === expected.join(","),
    `found ${callers.join(", ") || "(none)"} — pinned ${expected.join(", ")}`,
  );

  check(
    "the resolver's own module is not reported as one of its callers",
    !callers.includes("transcription.ts") && sources.some((full) => path.basename(full) === "transcription.ts"),
    callers.join(", ") || "(none)",
  );

  // --- report ----------------------------------------------------------------

  let failed = 0;
  for (const result of results) {
    console.log(
      `${result.ok ? "ok  " : "FAIL"} ${result.label}${result.ok || !result.detail ? "" : ` -> ${result.detail}`}`,
    );
    if (!result.ok) {
      failed += 1;
    }
  }
  console.log(`\ncallers of resolveAgentDir(: ${callers.join(", ") || "(none)"}`);
  console.log(
    failed === 0
      ? `\nALL ${results.length} CHECKS PASS`
      : `\n${failed} of ${results.length} CHECKS FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();
