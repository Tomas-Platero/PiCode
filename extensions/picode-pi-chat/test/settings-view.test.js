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

/**
 * Loads the settings renderer once with the smallest DOM it touches, so the profile
 * line's decision is observed instead of inferred.
 *
 * The renderer is an IIFE that exports nothing and reads `document`, `window` and the
 * VS Code API, which is why `onboarding.test.js` loads its script the same way: the
 * two pure row modules are required first because the script reads them while it
 * initialises, and every node it looks up by id is a stub whose children and text can
 * be read back.
 */
function runSettingsRenderer() {
  const nodes = new Map();
  const makeNode = () => {
    const node = {
      value: "",
      className: "",
      title: "",
      type: "",
      checked: false,
      hidden: false,
      disabled: false,
      children: [],
      listeners: {},
      classList: {
        classes: new Set(),
        add(name) {
          this.classes.add(name);
        },
        remove(name) {
          this.classes.delete(name);
        },
        toggle(name, on) {
          if (on) {
            this.classes.add(name);
          } else {
            this.classes.delete(name);
          }
        },
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      addEventListener(type, handler) {
        this.listeners[type] = handler;
      },
      setAttribute() {},
    };
    // A text assignment in the real DOM replaces the node's children, and the content
    // pane relies on that to start every repaint from an empty frame.
    let text = "";
    Object.defineProperty(node, "textContent", {
      get: () => text,
      set: (value) => {
        text = value;
        node.children = [];
      },
    });
    return node;
  };
  const documentStub = {
    getElementById(id) {
      if (!nodes.has(id)) {
        nodes.set(id, makeNode());
      }
      return nodes.get(id);
    },
    createElement() {
      return makeNode();
    },
  };
  const windowStub = {
    addEventListener(type, handler) {
      if (type === "message") {
        onMessage = handler;
      }
    },
  };
  let onMessage = null;

  require(path.join(__dirname, "..", "media", "package-rows.js"));
  require(path.join(__dirname, "..", "media", "skill-rows.js"));
  globalThis.document = documentStub;
  globalThis.window = windowStub;
  globalThis.acquireVsCodeApi = () => ({ postMessage() {} });
  require(path.join(__dirname, "..", "media", "settings.js"));

  const content = documentStub.getElementById("settings-content");
  const search = documentStub.getElementById("settings-search");
  return {
    send(data) {
      onMessage({ data });
    },
    typeSearch(value) {
      search.value = value;
      search.listeners.input();
    },
    /** The text of the profile line in the pane, or undefined when it was not drawn. */
    noticeText() {
      const line = content.children.find(
        (child) =>
          typeof child.className === "string" &&
          child.className.split(" ").indexOf("settings-profile-notice") !== -1,
      );
      return line === undefined ? undefined : line.textContent;
    },
  };
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

  /* ---------------------------------------------------------------- *
   * The profile line
   * ---------------------------------------------------------------- */

  const settingsScript = fs.readFileSync(
    path.join(__dirname, "..", "media", "settings.js"),
    "utf8",
  );
  const settingsHost = fs.readFileSync(
    path.join(__dirname, "..", "src", "settings-view.ts"),
    "utf8",
  );

  // The panel is a renderer for what the host pushes, never a reader of the profile.
  // Whether PiCode's own profile can carry an instance is the resolver's answer, handed
  // to the profile row and to this line from one registered reading; a webview that
  // looked at `auth.json` or at the selected profile would be a second, disagreeing
  // answer — and the webview cannot reach either anyway.
  check(
    "the panel draws the profile line the host pushes and reads no profile of its own",
    settingsScript.includes("message.profileNotice") &&
      settingsScript.includes("state.profileNotice") &&
      !/instanceProfile|readInstanceProfileState|selectedAgentDir|PI_CODING_AGENT_DIR|auth\.json|agentDir/.test(
        settingsScript,
      ),
    "settings.js only renders the pushed line",
  );

  // The line lives outside the categories: it is drawn into the content frame before
  // the query branch and before any category's title or rows, so it is read whichever
  // category is open and whichever scope is selected.
  check(
    "the profile line is drawn before any category's rows",
    /elements\.content\.textContent = "";\s*renderProfileNotice\(\);/.test(settingsScript) &&
      settingsScript.includes("settings-profile-notice"),
    "renderContent clears the pane, draws the line, then the category",
  );

  // The line goes through the one decision that knows both facts — whether the host
  // sent a notice and which category is open — instead of an ad-hoc comparison inside
  // the renderer, so the two directions below are the function's, not the DOM's.
  check(
    "the line is drawn through the shared decision, not an inline comparison",
    settingsScript.includes("profileNoticeForCategory(state.profileNotice") &&
      settingsScript.includes('PROFILE_NOTICE_OWN_CATEGORY = "picode"'),
    "renderProfileNotice applies the pure decision",
  );

  // The host takes the line from the same registered reading the profile row uses. It
  // never resolves the instance profile (or reads one) for this line, which is what keeps
  // the row and the line from disagreeing about the same profile.
  check(
    "the host takes the profile line from the shared reading, not from the resolver",
    settingsHost.includes("instanceProfileNotice(") &&
      !settingsHost.includes("instanceProfile(") &&
      !settingsHost.includes("readInstanceProfileState"),
    "settings-view.ts asks for the notice, it does not resolve a profile",
  );

  /* ---------------------------------------------------------------- *
   * The line is not repeated where it is already stated
   * ---------------------------------------------------------------- */

  // The renderer is driven with the real categories and no rows: the decision is about
  // which category is open, and an empty category still draws its title with the line
  // above it. The sentence is the profile row's own, so the two are the same text.
  const NOTICE =
    "El perfil de tu pi, porque el pi propio de PiCode todavía no tiene perfil. " +
    "Usa «Importar el perfil de tu pi» para encenderlo.";
  const renderer = runSettingsRenderer();
  const categoryGroups = groups.map((group) => ({
    category: {
      id: group.category.id,
      label: group.category.label,
      description: group.category.description,
    },
    settings: [],
  }));
  const stateFor = (startAt, profileNotice) => ({
    type: "state",
    scope: "global",
    groups: categoryGroups,
    values: {},
    profileNotice,
    startAt,
  });

  // The PiCode category's own `Perfil en uso` row states the sentence immediately below,
  // so the line above it would be the same words twice on one screen.
  renderer.send(stateFor("picode", NOTICE));
  check(
    "the PiCode category draws no line: its own Perfil en uso row states the sentence",
    renderer.noticeText() === undefined,
    String(renderer.noticeText()),
  );

  // Every other category keeps the line, which is the reason it was written at all: the
  // owner has to read that the profile in use is not the chosen one wherever he is.
  const withoutLine = categoryGroups
    .map((group) => group.category.id)
    .filter((id) => id !== "picode")
    .filter((id) => {
      renderer.send(stateFor(id, NOTICE));
      return renderer.noticeText() !== NOTICE;
    });
  check(
    "every other category keeps the line",
    withoutLine.length === 0,
    withoutLine.join(", "),
  );

  // Nothing to say draws no element at all, rather than a permanent banner.
  renderer.send(stateFor("modelo", ""));
  check(
    "the line is absent, not lying, when there is nothing to say",
    renderer.noticeText() === undefined,
    String(renderer.noticeText()),
  );

  // The search view replaces every category's rows, so no row is on screen to state the
  // sentence: the line stays even while the redundant category would be the open one.
  renderer.send(stateFor("picode", NOTICE));
  renderer.typeSearch("perfil");
  check(
    "the search results keep the line, where no category's rows are on screen",
    renderer.noticeText() === NOTICE,
    String(renderer.noticeText()),
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
