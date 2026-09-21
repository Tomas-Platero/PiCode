/*
 * Checks that the panel's script and its markup agree.
 *
 * main.js looks elements up by id, and the markup is a template literal inside the
 * compiled chat-view.js. Renaming an id in one place and not the other produces a
 * null reference at load, which turns the whole panel inert — and that failure is
 * invisible to the compiler and to a file-level review, because both files are
 * individually valid.
 *
 * Run with: npm test
 */
const fs = require("node:fs");
const path = require("node:path");

const EXTENSION_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(EXTENSION_ROOT, "media", "main.js");
const MARKUP_SOURCE = path.join(EXTENSION_ROOT, "out", "chat-view.js");

function idsUsedByScript(source) {
  const ids = new Set();
  for (const match of source.matchAll(/getElementById\("([^"]+)"\)/g)) {
    ids.add(match[1]);
  }
  return ids;
}

function idsProvidedByMarkup(source) {
  const ids = new Set();
  // The markup lives in a template literal, so `id="x"` appears verbatim.
  for (const match of source.matchAll(/\bid="([^"]+)"/g)) {
    ids.add(match[1]);
  }
  return ids;
}

function main() {
  if (!fs.existsSync(MARKUP_SOURCE)) {
    console.error(`Missing ${MARKUP_SOURCE}. Run "npm run compile" first.`);
    process.exit(2);
  }

  const used = idsUsedByScript(fs.readFileSync(SCRIPT, "utf8"));
  const provided = idsProvidedByMarkup(fs.readFileSync(MARKUP_SOURCE, "utf8"));

  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

  check("the script looks up at least the controls the panel is built around", used.size >= 8, `${used.size} ids`);

  const missing = [...used].filter((id) => !provided.has(id));
  check(
    "every element the script looks up exists in the markup",
    missing.length === 0,
    missing.length === 0 ? "" : `missing: ${missing.join(", ")}`,
  );

  // The controls the owner asked for specifically, by name.
  for (const id of ["model", "thinking", "dropdown", "dropdown-filter", "runtime"]) {
    check(`the markup provides #${id}`, provided.has(id), "");
  }

  const unused = [...provided].filter((id) => !used.has(id));
  if (unused.length > 0) {
    console.log(`note: markup ids the script never looks up: ${unused.join(", ")}`);
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
      ? `\nALL ${results.length} CHECKS PASS`
      : `\n${failed} of ${results.length} CHECKS FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();
