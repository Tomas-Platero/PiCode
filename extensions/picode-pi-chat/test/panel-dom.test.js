/*
 * Checks that each panel script and its markup agree.
 *
 * The scripts look elements up by id, and the markup lives in template literals
 * inside the compiled view modules. Renaming an id in one place and not the other
 * produces a null reference at load, which turns that whole view inert — and the
 * failure is invisible to the compiler and to a file-level review, because both
 * files are individually valid.
 *
 * Run with: npm test
 */
const fs = require("node:fs");
const path = require("node:path");

const EXTENSION_ROOT = path.resolve(__dirname, "..");

const PAIRS = [
  {
    name: "chat",
    script: "media/main.js",
    markup: "out/chat-view.js",
    // The controls the panel is built around, by name.
    required: [
      "model",
      "thinking",
      "dropdown",
      "dropdown-filter",
      "send",
      "prompt",
      "restart",
      "attach",
      "attachments",
      "stats-strip",
      "back-to-sessions",
    ],
  },
  {
    name: "ajustes",
    script: "media/ajustes.js",
    markup: "out/ajustes-view.js",
    required: [
      "card-runtime",
      "card-model",
      "card-thinking",
      "card-extensions",
      "settings",
      "categories",
    ],
  },
  {
    name: "settings",
    script: "media/settings.js",
    markup: "out/settings-view.js",
    required: [
      "settings-search",
      "scope-global",
      "scope-project",
      "settings-rail",
      "settings-content",
    ],
  },
  {
    name: "gentle",
    script: "media/gentle.js",
    markup: "out/gentle-view.js",
    // The mark, the line under the name, the place a failure is reported, and the
    // three lists the host fills in.
    required: ["logo", "summary", "notice", "lines", "commands", "actions"],
  },
  {
    name: "onboarding",
    script: "media/onboarding.js",
    markup: "out/onboarding.js",
    // The wizard's questions and their in-place outcome lines, plus the step tabs and
    // the closing summary's readings and ways out.
    required: [
      "notice",
      "step-tab-pi",
      "step-tab-gentle",
      "step-tab-summary",
      "step-pi",
      "step-gentle",
      "step-summary",
      "runtime-current",
      "runtime-choices",
      "runtime-custom",
      "runtime-path",
      "runtime-apply",
      "runtime-result",
      "gentle-current",
      "gentle-install",
      "gentle-skip",
      "gentle-result",
      "summary-runtime",
      "summary-gentle",
      "open-chat",
      "open-settings",
      "open-gentle",
      "finish",
    ],
  },
];

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
  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

  for (const pair of PAIRS) {
    const scriptPath = path.join(EXTENSION_ROOT, pair.script);
    const markupPath = path.join(EXTENSION_ROOT, pair.markup);

    if (!fs.existsSync(markupPath) || !fs.existsSync(scriptPath)) {
      check(`${pair.name}: both files exist`, false, `${pair.script} / ${pair.markup}`);
      continue;
    }

    const used = idsUsedByScript(fs.readFileSync(scriptPath, "utf8"));
    const provided = idsProvidedByMarkup(fs.readFileSync(markupPath, "utf8"));

    check(
      `${pair.name}: the script looks up its controls`,
      used.size >= 5,
      `${used.size} ids`,
    );

    const missing = [...used].filter((id) => !provided.has(id));
    check(
      `${pair.name}: every element the script looks up exists in the markup`,
      missing.length === 0,
      missing.length === 0 ? "" : `missing: ${missing.join(", ")}`,
    );

    for (const id of pair.required) {
      check(`${pair.name}: the markup provides #${id}`, provided.has(id), "");
    }

    // A markup id the script never looks up is dead weight; a script id with no
    // markup is a broken view. Only the second is a failure.
    const unused = [...provided].filter((id) => !used.has(id));
    if (unused.length > 0) {
      console.log(`note: ${pair.name}: markup ids the script never looks up: ${unused.join(", ")}`);
    }
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
