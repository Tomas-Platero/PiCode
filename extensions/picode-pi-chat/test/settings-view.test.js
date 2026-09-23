/*
 * Exercises the settings tab's wire contract: the serializable half of the
 * catalogue the webview renders.
 *
 * The tab posts `SettingWire` objects to the webview, never the descriptors'
 * closures, and every wire must survive a structured clone. This test checks that
 * `describeSettingWire` produces complete, function-free, JSON-serializable rows
 * and that every declared category in the catalogue has at least one setting or is
 * deliberately empty.
 *
 * Run with: npm test
 */
const fs = require("node:fs");
const path = require("node:path");

const {
  PI_SETTINGS_CATEGORIES,
  PI_SETTING_DESCRIPTORS,
  describeSettings,
  describeSettingWire,
} = require(path.join(__dirname, "..", "out", "pi-settings.js"));

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

const serialize = (value) => JSON.stringify(value);

function hasNoFunctions(value) {
  return !Object.values(value).some((entry) => typeof entry === "function");
}

function main() {
  const wires = PI_SETTING_DESCRIPTORS.map(describeSettingWire);

  check("every descriptor becomes a wire", wires.length === PI_SETTING_DESCRIPTORS.length, "");

  check(
    "every wire is JSON-serializable and carries no closures",
    wires.every(
      (wire) =>
        hasNoFunctions(wire) &&
        typeof wire.key === "string" &&
        typeof wire.label === "string" &&
        typeof wire.description === "string" &&
        serialize(wire) !== undefined,
    ),
    "",
  );

  check(
    "every wire declares its kind and scopes",
    wires.every(
      (wire) =>
        ["boolean", "select", "number", "text", "list", "packages", "skills", "action"].includes(
          wire.kind,
        ) &&
        Array.isArray(wire.scopes) &&
        wire.scopes.length > 0,
    ),
    "",
  );

  // An action row is the one wire that carries a command and nothing to render as a
  // value: the webview needs the command from the host, and a value would be a lie.
  const actionWires = wires.filter((wire) => wire.kind === "action");
  check(
    "an action wire carries its command and its label",
    actionWires.length > 0 &&
      actionWires.every(
        (wire) =>
          typeof wire.command === "string" &&
          wire.command.trim() !== "" &&
          wire.label.trim() !== "",
      ),
    JSON.stringify(actionWires.map((wire) => wire.key)),
  );

  const groups = describeSettings(PI_SETTING_DESCRIPTORS);
  check(
    "grouped categories all exist in the declared catalogue",
    groups.every((group) => PI_SETTINGS_CATEGORIES.some((c) => c.id === group.category.id)),
    "",
  );

  const groupedKeys = new Set(groups.flatMap((group) => group.settings.map((s) => s.key)));
  check(
    "no setting is lost between catalogue and groups",
    PI_SETTING_DESCRIPTORS.every((d) => groupedKeys.has(d.key)),
    "",
  );

  // The discovery row is the one wire drawn as a list of rows the host sends
  // beside the values: it carries the kind and nothing to run, unlike an action.
  const skillsWires = wires.filter((wire) => wire.kind === "skills");
  check(
    "the skills discovery row is wired as a list with no command",
    skillsWires.length === 1 &&
      skillsWires[0].key === "discoveredSkills" &&
      skillsWires[0].command === undefined,
    JSON.stringify(skillsWires.map((wire) => wire.key)),
  );

  /* ---------------------------------------------------------------- *
   * The retired duplicate
   * ---------------------------------------------------------------- */

  const manifest = fs.readFileSync(
    path.join(__dirname, "..", "package.json"),
    "utf8",
  );
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");

  const RETIRED = "picode.pi.defaultModel";

  check(
    "the duplicated default-model setting is gone from the manifest",
    !manifest.includes(`"${RETIRED}"`),
    "",
  );
  check(
    "no source reads the retired setting",
    !fs
      .readdirSync(path.join(__dirname, "..", "src"))
      .filter((name) => name.endsWith(".ts"))
      .some((name) =>
        fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8").includes(RETIRED),
      ),
    "",
  );
  check(
    "the README does not document the retired setting",
    !readme.includes(RETIRED),
    "",
  );

  const documented = [...readme.matchAll(/`(picode\.[a-zA-Z.]+)`/g)].map((match) => match[1]);
  const declared = new Set(
    Object.keys(JSON.parse(manifest).contributes.configuration.properties),
  );
  check(
    "every setting the README documents still exists in the manifest",
    documented.every((key) => declared.has(key)),
    documented.filter((key) => !declared.has(key)).join(", "),
  );

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
    failed === 0 ? `\nALL ${results.length} CHECKS PASS` : `\n${failed} of ${results.length} CHECKS FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();
