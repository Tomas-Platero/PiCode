/*
 * Exercises the pi step's profile part: when it appears, what it says, and which commands
 * its two doors run.
 *
 * The wizard carries one decision the rest of its panels do not: while PiCode's own pi is
 * selected and its profile cannot carry an instance yet, the step has to say that the editor
 * keeps using the owner's pi — and offer the two ways to end that. The decision is pure
 * (`describeProfilePart`), so the three states are exercised here without an editor, and the
 * renderer is left with nothing to decide.
 *
 * What is checked:
 *
 * - the part is hidden for the owner's pi (PiCode owns no profile there) and for PiCode's own
 *   pi once its profile is usable; it is visible, and only then, while that profile is unusable;
 * - it names what is missing with the settings row's own words (`pi-settings.ts`) and states
 *   the fallback with the import closing's own words (`CLOSING_TEXTS.withoutCredentials`), so
 *   two screens describing one situation cannot drift into two sentences;
 * - the two doors carry the real command ids, taken from the modules that implement them, and
 *   their labels are the palette titles the manifest declares;
 * - the renderer draws what the host decided and runs nothing itself, and the wizard's module
 *   never restates a command id nor reaches for either flow's own implementation.
 *
 * The `vscode` module is stubbed through a resolver hook, as the other suites do, so the
 * compiled module loads without an editor. The three texts are printed verbatim at the end.
 *
 * Run with: npm test
 */
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

const EXTENSION_ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = path.join(EXTENSION_ROOT, "src");

/**
 * The pi step's own way forward, the label the owner reads while the part has something to
 * say. It is Spanish and lives in the markup next to the two doors, because it is one of them
 * in substance: pressing it leaves the step without filling PiCode's profile.
 */
const CONTINUE_LABEL = "Continuar con el perfil de tu equipo";

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "vscode-stub.js");
  }
  return originalResolve.call(this, request, ...rest);
};

/**
 * The facts the settings row is built from, in one shape.
 *
 * `owned` is the resolver's guarded answer: the profile in use is PiCode's own, credentials
 * and all. The three states the wizard has to tell apart are combinations of `managed`,
 * `owned` and `internalExists`.
 */
function facts(overrides = {}) {
  return {
    owned: false,
    managed: true,
    internalExists: false,
    internalProviders: 0,
    ...overrides,
  };
}

/** The ids of every `id="…"` the markup template carries. */
function markupIds(source) {
  return new Set([...source.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
}

/** The ids the panel script looks up. */
function scriptIds(source) {
  return new Set([...source.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]));
}

/**
 * Runs the webview script once in a throwaway DOM and hands back what it wrote.
 *
 * The renderer is an IIFE that touches `document`, `window` and the VS Code API and exports
 * nothing, so the smallest honest way to observe what it does with a host message is to give
 * it those three and watch which step it leaves visible. Nothing here reimplements the script:
 * every node a script id looks up is a stub, and only `hidden` and the registered listeners
 * are read back. It is what makes "the step does not advance" an observation instead of a
 * regex over the source.
 */
function runRenderer(scriptSource) {
  const nodes = new Map();
  const makeNode = (id) => ({
    id,
    hidden: false,
    textContent: "",
    value: "",
    disabled: false,
    checked: false,
    type: "",
    name: "",
    className: "",
    children: [],
    listeners: {},
    classList: {
      classes: new Set(),
      toggle(name, on) {
        if (on) {
          this.classes.add(name);
        } else {
          this.classes.delete(name);
        }
      },
      add(name) {
        this.classes.add(name);
      },
      remove(name) {
        this.classes.delete(name);
      },
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
  });
  const documentStub = {
    activeElement: null,
    getElementById(id) {
      if (!nodes.has(id)) {
        nodes.set(id, makeNode(id));
      }
      return nodes.get(id);
    },
    createElement() {
      return makeNode(undefined);
    },
  };
  const posted = [];
  let onMessage = null;
  const windowStub = {
    addEventListener(type, handler) {
      if (type === "message") {
        onMessage = handler;
      }
    },
  };
  // eslint-disable-next-line no-new-func
  new Function("acquireVsCodeApi", "document", "window", scriptSource)(
    () => ({ postMessage: (message) => posted.push(message) }),
    documentStub,
    windowStub,
  );
  return {
    nodes,
    posted,
    send(data) {
      onMessage({ data });
    },
  };
}

/** The step the wizard is currently showing, read from the sections' own `hidden` flag. */
function shownStep(nodes) {
  if (nodes.get("step-gentle").hidden === false) {
    return "gentle";
  }
  if (nodes.get("step-summary").hidden === false) {
    return "summary";
  }
  return "pi";
}

async function main() {
  const onboardingPath = path.join(EXTENSION_ROOT, "out", "onboarding.js");
  const importPath = path.join(EXTENSION_ROOT, "out", "instance-import-command.js");
  const loginPath = path.join(EXTENSION_ROOT, "out", "pi-login-command.js");
  for (const file of [onboardingPath, importPath, loginPath]) {
    if (!fs.existsSync(file)) {
      console.error(`Missing ${file}. Run "npm run compile" first.`);
      process.exit(2);
    }
  }

  const onboarding = await import(pathToFileURL(onboardingPath).href);
  const importCommand = await import(pathToFileURL(importPath).href);
  const loginCommand = await import(pathToFileURL(loginPath).href);
  const api = onboarding.describeProfilePart ? onboarding : onboarding.default;

  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

  const source = (name) => fs.readFileSync(path.join(SOURCE_ROOT, name), "utf8");
  const onboardingSource = source("onboarding.ts");
  const extensionSource = source("extension.ts");
  const settingsSource = source("pi-settings.ts");
  const scriptSource = fs.readFileSync(path.join(EXTENSION_ROOT, "media", "onboarding.js"), "utf8");

  // --- the three states -------------------------------------------------------

  const ownerPath = api.describeProfilePart(facts({ managed: false }));
  const ownerCustomWithProfile = api.describeProfilePart(
    facts({ managed: false, internalExists: true, internalProviders: 3 }),
  );
  const withoutProfile = api.describeProfilePart(facts());
  const withoutCredentials = api.describeProfilePart(
    facts({ internalExists: true, internalProviders: 0 }),
  );
  const usable = api.describeProfilePart(
    facts({ owned: true, internalExists: true, internalProviders: 2 }),
  );

  check(
    "the owner's pi gets no profile part at all, in either mode",
    ownerPath.visible === false &&
      ownerPath.text === "" &&
      ownerPath.offers.length === 0 &&
      ownerCustomWithProfile.visible === false &&
      ownerCustomWithProfile.text === "" &&
      ownerCustomWithProfile.offers.length === 0,
    JSON.stringify({ ownerPath, ownerCustomWithProfile }),
  );
  check(
    "PiCode's own pi with a usable profile has nothing to say either",
    usable.visible === false && usable.text === "" && usable.offers.length === 0,
    JSON.stringify(usable),
  );
  check(
    "PiCode's own pi without a profile says so and offers the two doors",
    withoutProfile.visible === true &&
      withoutProfile.offers.length === 2 &&
      withoutProfile.text.includes(api.PROFILE_MISSING_WORDS.profile),
    JSON.stringify(withoutProfile),
  );
  check(
    "PiCode's own pi with a profile that has no credentials says that, not 'no profile'",
    withoutCredentials.visible === true &&
      withoutCredentials.text.includes(api.PROFILE_MISSING_WORDS.credentials) &&
      !withoutCredentials.text.includes(api.PROFILE_MISSING_WORDS.profile) &&
      withoutCredentials.text !== withoutProfile.text,
    JSON.stringify({
      withoutCredentials: withoutCredentials.text,
      withoutProfile: withoutProfile.text,
    }),
  );
  check(
    "the visible states keep the settings row's naming for what is missing",
    api.PROFILE_MISSING_WORDS.profile === "todavía no tiene perfil" &&
      api.PROFILE_MISSING_WORDS.credentials === "todavía no tiene credenciales" &&
      settingsSource.includes(api.PROFILE_MISSING_WORDS.profile) &&
      settingsSource.includes(api.PROFILE_MISSING_WORDS.credentials),
    JSON.stringify(api.PROFILE_MISSING_WORDS),
  );
  check(
    "the text and the doors exist exactly when the part does",
    [ownerPath, ownerCustomWithProfile, withoutProfile, withoutCredentials, usable].every(
      (part) =>
        Boolean(part.text.length > 0) === part.visible &&
        Boolean(part.offers.length > 0) === part.visible,
    ),
    JSON.stringify([ownerPath, withoutProfile, withoutCredentials, usable].map((part) => part.visible)),
  );

  // --- one fact, one wording --------------------------------------------------

  check(
    "the fallback is stated with the import closing's own clause, verbatim",
    importCommand.CLOSING_TEXTS.withoutCredentials.includes(api.PROFILE_FALLBACK_CLAUSE) &&
      withoutProfile.text.includes(api.PROFILE_FALLBACK_CLAUSE) &&
      withoutCredentials.text.includes(api.PROFILE_FALLBACK_CLAUSE),
    api.PROFILE_FALLBACK_CLAUSE,
  );
  check(
    "the sentence also names the condition that ends it",
    /hasta que el perfil propio de PiCode tenga credenciales\.$/.test(withoutProfile.text) &&
      /hasta que el perfil propio de PiCode tenga credenciales\.$/.test(withoutCredentials.text),
    JSON.stringify([withoutProfile.text, withoutCredentials.text]),
  );
  check(
    "the step points at no other row: the two doors are its own buttons",
    !withoutProfile.text.includes("«") && !withoutCredentials.text.includes("«"),
    JSON.stringify([withoutProfile.text, withoutCredentials.text]),
  );

  // --- the two doors ----------------------------------------------------------

  const offers = withoutProfile.offers;
  check(
    "the first door is the import and the second the login, in the safety rule's order",
    offers[0].command === importCommand.IMPORT_PROFILE_COMMAND &&
      offers[1].command === loginCommand.LOGIN_PROVIDER_COMMAND,
    JSON.stringify(offers),
  );
  check(
    "the two offers carry the real command ids and nothing invented",
    offers[0].command === "picode.piChat.importProfile" &&
      offers[1].command === "picode.piChat.loginProvider" &&
      new Set(offers.map((offer) => offer.command)).size === 2,
    JSON.stringify(offers.map((offer) => offer.command)),
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, "package.json"), "utf8"));
  const declaration = (command) =>
    (manifest.contributes.commands ?? []).find((entry) => entry.command === command);
  const paletteLabel = (command) => {
    const entry = declaration(command);
    return entry === undefined ? undefined : entry.title.replace(/^PiCode: /, "");
  };
  check(
    "each button is labelled with the palette title the manifest declares",
    offers.every((offer) => offer.label === paletteLabel(offer.command)),
    JSON.stringify(offers.map((offer) => `${offer.label} -> ${paletteLabel(offer.command)}`)),
  );
  check(
    "both commands are declared under the product's own prefix, so neither button can dangle",
    offers.every((offer) => {
      const entry = declaration(offer.command);
      return entry !== undefined && /^PiCode: /.test(entry.title);
    }),
    JSON.stringify(offers.map((offer) => declaration(offer.command))),
  );
  check(
    "the wizard names no command id of its own and implements neither flow",
    !onboardingSource.includes("picode.piChat") &&
      !onboardingSource.includes("executeCommand") &&
      !onboardingSource.includes("installSources(") &&
      !onboardingSource.includes("importProfile(") &&
      !onboardingSource.includes("loginProvider("),
    "onboarding.ts restates no command id and reaches for no flow's implementation",
  );
  check(
    "the wizard takes both ids from the modules that implement them",
    /import\s*\{[^}]*IMPORT_PROFILE_COMMAND[^}]*\}\s*from\s*"\.\/instance-import-command"/.test(
      onboardingSource,
    ) &&
      /import\s*\{[^}]*LOGIN_PROVIDER_COMMAND[^}]*\}\s*from\s*"\.\/pi-login-command"/.test(
        onboardingSource,
      ),
    "the ids are imported, not copied",
  );
  check(
    "the host runs the door through the palette's own entry point",
    /runOffer:/.test(extensionSource) &&
      /describeProfilePart\(instanceProfileState\(/.test(extensionSource) &&
      /vscode\.commands\.executeCommand\(command\)/.test(extensionSource),
    "extension.ts wires the host",
  );
  check(
    "the host decides from the same facts the settings row states",
    extensionSource.includes("setInstanceProfileStateSource(() => instanceProfileState(") &&
      /function instanceProfileState\(/.test(extensionSource),
    "one reading, two surfaces",
  );

  // --- the renderer -----------------------------------------------------------

  const needed = ["profile-part", "profile-part-text", "profile-part-offers"];
  const provided = markupIds(onboardingSource);
  const looked = scriptIds(scriptSource);
  check(
    "the markup provides the part, its text and its doors, and nothing more",
    needed.every((id) => provided.has(id)),
    needed.filter((id) => !provided.has(id)).join(", "),
  );
  check(
    "the renderer looks up those three ids",
    needed.every((id) => looked.has(id)),
    needed.filter((id) => !looked.has(id)).join(", "),
  );
  check(
    "the renderer toggles the part from the host's decision",
    /profilePart\.hidden\s*=\s*!visible/.test(scriptSource) && scriptSource.includes('case "instanceProfile"'),
    "hidden = !visible, from the instanceProfile message",
  );
  check(
    "a door is drawn from the offer and sends the offer's own command",
    scriptSource.includes('type: "runOffer"') && scriptSource.includes("command: offer.command"),
    "the script names the command, the host runs it",
  );
  check(
    "the renderer runs nothing itself: no command, no import, no login",
    !/executeCommand/.test(scriptSource) &&
      !/piChat\.importProfile|piChat\.loginProvider/.test(scriptSource),
    "media/onboarding.js stays a renderer",
  );
  check(
    "the part is inside the pi step, after the apply result, and is no fourth question",
    onboardingSource.includes('id="profile-part"') &&
      onboardingSource.indexOf('id="profile-part"') > onboardingSource.indexOf('id="runtime-result"') &&
      onboardingSource.indexOf('id="profile-part"') > onboardingSource.indexOf('id="step-pi"') &&
      onboardingSource.indexOf('id="profile-part"') < onboardingSource.indexOf('id="step-gentle"') &&
      !/<li id="step-tab-[^"]*">/.test(
        onboardingSource.slice(
          onboardingSource.indexOf('id="profile-part"'),
          onboardingSource.indexOf('id="step-gentle"'),
        ),
      ),
    "between #step-pi and #step-gentle",
  );

  // --- the step does not move on by itself, and does not trap him either ------

  // The behaviour, observed in a throwaway DOM instead of inferred from the source: the pi
  // step has something to say (the profile part is visible for the pi in force), a successful
  // apply must leave it where it is — and the step's own way forward must still take the owner
  // to the second question. With nothing to say, the automatic advance is exactly today's.

  const withSomethingToSay = runRenderer(scriptSource);
  withSomethingToSay.send({
    type: "instanceProfile",
    profile: { visible: true, text: withoutProfile.text, offers: [] },
  });
  withSomethingToSay.send({ type: "runtimeResult", ok: true, message: "Listo." });
  check(
    "with the part visible, a successful apply leaves the step on the pi question",
    shownStep(withSomethingToSay.nodes) === "pi" &&
      withSomethingToSay.nodes.get("step-gentle").hidden === true,
    `shown step: ${shownStep(withSomethingToSay.nodes)}`,
  );

  const continueButton = withSomethingToSay.nodes.get("profile-part-continue");
  const continueHandler = continueButton.listeners.click;
  if (typeof continueHandler === "function") {
    continueHandler();
  }
  check(
    "the step's own way forward still moves on to the second question",
    typeof continueHandler === "function" && shownStep(withSomethingToSay.nodes) === "gentle",
    `shown step after the way forward: ${shownStep(withSomethingToSay.nodes)}`,
  );
  check(
    "that way forward is inside the part, so the word and the way out share one state",
    onboardingSource.includes(`id="profile-part-continue"`) &&
      onboardingSource.indexOf('id="profile-part-continue"') >
        onboardingSource.indexOf('id="profile-part"') &&
      onboardingSource.indexOf('id="profile-part-continue"') <
        onboardingSource.indexOf('id="step-gentle"'),
    "#profile-part-continue lives between #profile-part and #step-gentle",
  );
  check(
    "its label is Spanish, next to the two doors that fill the profile",
    onboardingSource.includes(CONTINUE_LABEL) && scriptSource.includes("profile-part-continue"),
    CONTINUE_LABEL,
  );

  const nothingToSay = runRenderer(scriptSource);
  nothingToSay.send({
    type: "instanceProfile",
    profile: { visible: false, text: "", offers: [] },
  });
  nothingToSay.send({ type: "runtimeResult", ok: true, message: "Listo." });
  check(
    "with nothing to say, a successful apply advances as it does today",
    shownStep(nothingToSay.nodes) === "gentle",
    `shown step: ${shownStep(nothingToSay.nodes)}`,
  );

  check(
    "the renderer decides the advance from the host's own visible flag, not a second rule",
    /if \(message\.ok && !profilePartVisible\(\)\)/.test(scriptSource) &&
      /function profilePartVisible\(\)/.test(scriptSource),
    "message.ok && !profilePartVisible()",
  );

  // --- the exact text the owner reads -----------------------------------------

  console.log("--- the pi step's profile part ---");
  console.log(`[oculto] (el pi del dueño) ${ownerPath.text || "(sin texto)"}`);
  console.log(`[visible] ${withoutProfile.text}`);
  console.log(`  ${offers.map((offer) => `[${offer.label} -> ${offer.command}]`).join(" ")}`);
  console.log(`[visible] ${withoutCredentials.text}`);
  console.log(`  ${offers.map((offer) => `[${offer.label} -> ${offer.command}]`).join(" ")}`);
  console.log(`[oculto] (perfil propio ya utilizable) ${usable.text || "(sin texto)"}`);
  console.log("---");
  console.log("--- does the pi step move on by itself? ---");
  console.log(
    `[tiene algo que decir] runtimeResult ok -> el paso se queda en «pi»; ` +
      `la salida propia es «${CONTINUE_LABEL}» y lleva al paso 2`,
  );
  console.log("[nada que decir]      runtimeResult ok -> avanza al paso 2, como antes");
  console.log("---");

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

main().catch((error) => {
  console.error("harness error:", error);
  process.exit(2);
});
