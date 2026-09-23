/*
 * Exercises the settings catalogue and the service that reads and writes pi's own
 * settings.
 *
 * The catalogue is the contract for what the options tab will render: if a key
 * disappears, moves to another category or stops matching the shape of the value
 * pi stores, the tab renders something untrue. The coercion checks are also a
 * boundary check — the values arrive from a webview and end up in the owner's
 * settings file, so a number that arrives as "abc" has to be refused here.
 *
 * The service is exercised against a fake `SettingsManager` injected through
 * `load`, so nothing here reads or writes the owner's real `~/.pi`, and the real
 * pi does not have to be installed. The fake is built from the same structural
 * interface the production code declares; a method renamed in `pi-settings.ts`
 * shows up as a missing method here.
 *
 * Run with: npm test
 */
const path = require("node:path");
const fs = require("node:fs");

const {
  PI_SETTINGS_CATEGORIES,
  PI_SETTING_DESCRIPTORS,
  describeSettings,
  describeSettingWire,
  coerceSettingValue,
  setPiVersionStateSource,
  setInstanceProfileStateSource,
  describeProfileNotice,
  instanceProfileNotice,
  PiSettingsService,
} = require(path.join(__dirname, "..", "out", "pi-settings.js"));

/*
 * The import row's command id is not restated here: it is taken from the module that
 * owns it, so a rename on either side fails this check instead of quietly leaving the
 * row pointed at a command that no longer exists. That module imports `vscode`, so the
 * same resolver hook `instance-import-command.test.js` uses is installed before it is
 * loaded; nothing in this suite calls the editor.
 */
const Module = require("node:module");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "vscode-stub.js");
  }
  return originalResolveFilename.call(this, request, ...rest);
};
const { IMPORT_PROFILE_COMMAND } = require(
  path.join(__dirname, "..", "out", "instance-import-command.js"),
);

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

const setting = (key) => {
  const descriptor = PI_SETTING_DESCRIPTORS.find((entry) => entry.key === key);
  if (!descriptor) {
    throw new Error(`The catalogue has no "${key}" descriptor.`);
  }
  return descriptor;
};

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function rejectionOf(promise) {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

/* ------------------------------------------------------------------ *
 * The fake settings manager
 * ------------------------------------------------------------------ */

/**
 * A `SettingsManager` with the same structural shape as the real one, backed by an
 * in-memory record: the global values plus the per-scope resource lists, which are
 * the only settings pi can write in a project.
 */
function createFakeManager() {
  const global = {
    defaultProvider: "deepseek",
    defaultModel: "deepseek-v4-pro",
    defaultThinkingLevel: "medium",
    modelThinkingLevels: { "deepseek/deepseek-v4-pro": "high" },
    hideThinkingBlock: false,
    showCacheMissNotices: false,
    compactionEnabled: true,
    compactionReserveTokens: 65536,
    compactionKeepRecentTokens: 20000,
    branchSummaryReserveTokens: 16384,
    branchSummarySkipPrompt: false,
    retryEnabled: true,
    retryMaxRetries: 3,
    retryBaseDelayMs: 2000,
    retryMaxAgentDelayMs: 60000,
    httpIdleTimeoutMs: 600000,
    providerRetryTimeoutMs: undefined,
    providerRetryMaxRetries: undefined,
    providerRetryMaxDelayMs: 60000,
    websocketConnectTimeoutMs: undefined,
    cacheWarming: "streaming",
    transport: "auto",
    shellPath: undefined,
    shellCommandPrefix: undefined,
    npmCommand: undefined,
    externalEditor: "notepad",
    quietStartup: false,
    defaultProjectTrust: "ask",
    installTelemetry: true,
    analytics: false,
    skillCommands: true,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    sessionDir: undefined,
    packages: [],
    extensions: ["/global/ext"],
    skills: [],
    prompts: [],
  };
  const project = {
    packages: undefined,
    extensions: undefined,
    skills: undefined,
    prompts: undefined,
  };

  const fake = {
    /** How many times pi was asked to persist, so a write can prove it flushed. */
    flushCount: 0,
    reloadCount: 0,

    async reload() {
      fake.reloadCount += 1;
    },
    async flush() {
      fake.flushCount += 1;
    },
    drainErrors() {
      return [];
    },

    getGlobalSettings: () => ({ ...global }),
    getProjectSettings: () => ({ ...project }),

    getDefaultProvider: () => global.defaultProvider,
    setDefaultProvider: (provider) => {
      global.defaultProvider = provider;
    },
    getDefaultModel: () => global.defaultModel,
    setDefaultModel: (modelId) => {
      global.defaultModel = modelId;
    },
    setDefaultModelAndProvider: (provider, modelId) => {
      global.defaultProvider = provider;
      global.defaultModel = modelId;
    },

    getDefaultThinkingLevel: () => global.defaultThinkingLevel,
    setDefaultThinkingLevel: (level) => {
      global.defaultThinkingLevel = level;
    },
    getAllModelThinkingLevels: () => ({ ...global.modelThinkingLevels }),
    setModelThinkingLevel: (provider, modelId, level) => {
      global.modelThinkingLevels[`${provider}/${modelId}`] = level;
    },
    removeModelThinkingLevel: (provider, modelId) => {
      delete global.modelThinkingLevels[`${provider}/${modelId}`];
    },
    getHideThinkingBlock: () => global.hideThinkingBlock,
    setHideThinkingBlock: (hide) => {
      global.hideThinkingBlock = hide;
    },
    getShowCacheMissNotices: () => global.showCacheMissNotices,
    setShowCacheMissNotices: (show) => {
      global.showCacheMissNotices = show;
    },

    getCompactionEnabled: () => global.compactionEnabled,
    setCompactionEnabled: (enabled) => {
      global.compactionEnabled = enabled;
    },
    getCompactionReserveTokens: () => global.compactionReserveTokens,
    getCompactionKeepRecentTokens: () => global.compactionKeepRecentTokens,
    getBranchSummarySettings: () => ({
      reserveTokens: global.branchSummaryReserveTokens,
      skipPrompt: global.branchSummarySkipPrompt,
    }),

    getRetryEnabled: () => global.retryEnabled,
    setRetryEnabled: (enabled) => {
      global.retryEnabled = enabled;
    },
    getRetrySettings: () => ({
      enabled: global.retryEnabled,
      maxRetries: global.retryMaxRetries,
      baseDelayMs: global.retryBaseDelayMs,
      maxAgentDelayMs: global.retryMaxAgentDelayMs,
    }),

    getHttpIdleTimeoutMs: () => global.httpIdleTimeoutMs,
    setHttpIdleTimeoutMs: (timeoutMs) => {
      global.httpIdleTimeoutMs = timeoutMs;
    },
    getProviderRetrySettings: () => ({
      timeoutMs: global.providerRetryTimeoutMs,
      maxRetries: global.providerRetryMaxRetries,
      maxRetryDelayMs: global.providerRetryMaxDelayMs,
    }),
    getWebSocketConnectTimeoutMs: () => global.websocketConnectTimeoutMs,
    getCacheWarmingMode: () => global.cacheWarming,
    setCacheWarmingMode: (mode) => {
      global.cacheWarming = mode;
    },
    getTransport: () => global.transport,
    setTransport: (transport) => {
      global.transport = transport;
    },

    getShellPath: () => global.shellPath,
    setShellPath: (shellPath) => {
      global.shellPath = shellPath;
    },
    getShellCommandPrefix: () => global.shellCommandPrefix,
    setShellCommandPrefix: (prefix) => {
      global.shellCommandPrefix = prefix;
    },
    getNpmCommand: () => global.npmCommand,
    setNpmCommand: (command) => {
      global.npmCommand = command;
    },
    getExternalEditorCommand: () => global.externalEditor,
    getQuietStartup: () => global.quietStartup,
    setQuietStartup: (quiet) => {
      global.quietStartup = quiet;
    },
    getDefaultProjectTrust: () => global.defaultProjectTrust,
    setDefaultProjectTrust: (value) => {
      global.defaultProjectTrust = value;
    },

    getPackages: () => [...global.packages],
    setPackages: (packages) => {
      global.packages = [...packages];
    },
    setProjectPackages: (packages) => {
      project.packages = [...packages];
    },
    getExtensionPaths: () => [...global.extensions],
    setExtensionPaths: (paths) => {
      global.extensions = [...paths];
    },
    setProjectExtensionPaths: (paths) => {
      project.extensions = [...paths];
    },
    getSkillPaths: () => [...global.skills],
    setSkillPaths: (paths) => {
      global.skills = [...paths];
    },
    setProjectSkillPaths: (paths) => {
      project.skills = [...paths];
    },
    getPromptTemplatePaths: () => [...global.prompts],
    setPromptTemplatePaths: (paths) => {
      global.prompts = [...paths];
    },
    setProjectPromptTemplatePaths: (paths) => {
      project.prompts = [...paths];
    },
    getEnableInstallTelemetry: () => global.installTelemetry,
    setEnableInstallTelemetry: (enabled) => {
      global.installTelemetry = enabled;
    },
    getEnableAnalytics: () => global.analytics,
    setEnableAnalytics: (enabled) => {
      global.analytics = enabled;
    },
    getEnableSkillCommands: () => global.skillCommands,
    setEnableSkillCommands: (enabled) => {
      global.skillCommands = enabled;
    },

    getSteeringMode: () => global.steeringMode,
    setSteeringMode: (mode) => {
      global.steeringMode = mode;
    },
    getFollowUpMode: () => global.followUpMode,
    setFollowUpMode: (mode) => {
      global.followUpMode = mode;
    },
    getSessionDir: () => global.sessionDir,

    /** Makes one getter throw the way pi's do over a stored value they cannot use. */
    breakGetter(name) {
      fake[name] = () => {
        throw new Error(`${name} cannot be read`);
      };
    },
  };

  return fake;
}

/** Builds the service over the fake, recording what the SDK was constructed with. */
async function createService(fake, picode) {
  const created = {};
  const service = await PiSettingsService.create({
    // Only reachable when `load` is absent: the entry proves the injected loader is
    // the path under test, and that nothing resolves a real pi here.
    entry: path.join(__dirname, "no-existe", "dist", "index.js"),
    cwd: "C:/trabajo",
    ...(picode === undefined ? {} : { picode }),
    load: async () => ({
      SettingsManager: {
        create: (cwd, agentDir) => {
          created.cwd = cwd;
          created.agentDir = agentDir;
          return fake;
        },
      },
      getAgentDir: () => "C:/pi-agent",
    }),
  });
  return { service, created };
}

/**
 * The body of the `function <name>(…) { … }` declaration, by matching its braces.
 *
 * It exists so a check can assert what a function does without pinning how its call
 * sites are spelled. Finding the declaration by name and reading its body keeps the
 * argument list free to change, which is exactly what a check on a call's literal text
 * forbade. `undefined` means there is no such declaration; `undefined` fields are the
 * caller's business to reject.
 */
function functionBody(source, name) {
  const declaration = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(source);
  if (declaration === null) {
    return undefined;
  }
  let depth = 0;
  let index = source.indexOf("(", declaration.index);
  for (; index < source.length; index += 1) {
    if (source[index] === "(") {
      depth += 1;
    } else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
  }
  const bodyStart = source.indexOf("{", index);
  if (bodyStart === -1) {
    return undefined;
  }
  let braces = 0;
  for (let cursor = bodyStart; cursor < source.length; cursor += 1) {
    if (source[cursor] === "{") {
      braces += 1;
    } else if (source[cursor] === "}") {
      braces -= 1;
      if (braces === 0) {
        return source.slice(bodyStart, cursor + 1);
      }
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * The catalogue
 * ------------------------------------------------------------------ */

async function main() {
  const keys = PI_SETTING_DESCRIPTORS.map((descriptor) => descriptor.key);

  check(
    "no two descriptors share a key",
    new Set(keys).size === keys.length,
    keys.filter((key, index) => keys.indexOf(key) !== index).join(", "),
  );

  const categoryIds = new Set(PI_SETTINGS_CATEGORIES.map((category) => category.id));
  const orphans = PI_SETTING_DESCRIPTORS.filter((descriptor) => !categoryIds.has(descriptor.category));
  check(
    "every descriptor belongs to a declared category",
    orphans.length === 0,
    orphans.map((descriptor) => `${descriptor.key} -> ${descriptor.category}`).join(", "),
  );

  check(
    "every category carries a Spanish label and description",
    PI_SETTINGS_CATEGORIES.every(
      (category) => category.label.trim() !== "" && category.description.trim() !== "",
    ),
    "",
  );

  check(
    "every descriptor carries a Spanish label and description",
    PI_SETTING_DESCRIPTORS.every(
      (descriptor) => descriptor.label.trim() !== "" && descriptor.description.trim() !== "",
    ),
    PI_SETTING_DESCRIPTORS.filter((descriptor) => descriptor.description.trim() === "")
      .map((descriptor) => descriptor.key)
      .join(", "),
  );

  check(
    "readOnly is exactly the set of descriptors with no write",
    PI_SETTING_DESCRIPTORS.every(
      (descriptor) =>
        descriptor.readOnly ===
        (descriptor.write === undefined && descriptor.picodeKey === undefined),
    ),
    PI_SETTING_DESCRIPTORS.filter((descriptor) => descriptor.readOnly !== (descriptor.write === undefined))
      .map((descriptor) => descriptor.key)
      .join(", "),
  );

  check(
    "a read-only row still declares a scope to be shown in",
    PI_SETTING_DESCRIPTORS.every((descriptor) => descriptor.scopes.length > 0),
    "",
  );

  check(
    "every select declares options, and its option values are unique",
    PI_SETTING_DESCRIPTORS.every((descriptor) => {
      if (descriptor.kind !== "select") {
        return true;
      }
      const options = descriptor.options;
      // Dynamic selects (provider and model) carry no static options: the host
      // injects them from the live session. A static select must declare them.
      return (
        options === undefined ||
        (options.length > 0 &&
          new Set(options.map((option) => option.value)).size === options.length)
      );
    }),
    PI_SETTING_DESCRIPTORS.filter((descriptor) => descriptor.kind === "select")
      .map((descriptor) => descriptor.key)
      .join(", "),
  );

  check(
    "the provider and model are the dynamic selects, and both are clearable",
    same(
      PI_SETTING_DESCRIPTORS.filter(
        (descriptor) => descriptor.kind === "select" && descriptor.options === undefined,
      ).map((descriptor) => descriptor.key),
      ["defaultProvider", "defaultModel"],
    ) &&
      PI_SETTING_DESCRIPTORS.filter(
        (descriptor) => descriptor.key === "defaultProvider" || descriptor.key === "defaultModel",
      ).every((descriptor) => descriptor.allowEmpty === true),
    "",
  );

  check(
    "the model id is bare, and only the thinking-level key is composited",
    setting("defaultModel").label.startsWith("Modelo") &&
      setting("modelThinkingLevels").kind === "list" &&
      setting("defaultModel").kind === "select",
    "",
  );

  check(
    "every number declares the minimum its control accepts",
    PI_SETTING_DESCRIPTORS.every(
      (descriptor) => descriptor.kind !== "number" || typeof descriptor.minimum === "number",
    ),
    "",
  );

  check(
    "the project scope is offered by the packages table and the skills list",
    same(
      PI_SETTING_DESCRIPTORS.filter((descriptor) => descriptor.scopes.includes("project")).map(
        (descriptor) => descriptor.key,
      ),
      ["packages", "discoveredSkills"],
    ),
    PI_SETTING_DESCRIPTORS.filter((descriptor) => descriptor.scopes.includes("project"))
      .map((descriptor) => descriptor.key)
      .join(", "),
  );

  /* ---------------------------------------------------------------- *
   * describeSettings
   * ---------------------------------------------------------------- */

  const groups = describeSettings(PI_SETTING_DESCRIPTORS);

  check(
    "an empty category is skipped rather than rendered",
    groups.every((group) => group.settings.length > 0) &&
      !groups.some((group) => group.category.id === "estado"),
    groups.map((group) => group.category.id).join(", "),
  );

  const declaredOrder = PI_SETTINGS_CATEGORIES.map((category) => category.id).filter((id) =>
    groups.some((group) => group.category.id === id),
  );
  check(
    "the groups follow the declared category order",
    same(
      groups.map((group) => group.category.id),
      declaredOrder,
    ),
    groups.map((group) => group.category.id).join(", "),
  );

  const grouped = groups.flatMap((group) => group.settings.map((descriptor) => descriptor.key));
  check(
    "every descriptor is grouped exactly once",
    grouped.length === keys.length && new Set(grouped).size === keys.length,
    `${grouped.length} grouped, ${keys.length} declared`,
  );

  check(
    "a subset is ordered by the rail, not by the order it arrives in",
    same(
      describeSettings([setting("steeringMode"), setting("quietStartup")]).map(
        (group) => group.category.id,
      ),
      ["herramientas", "sesion"],
    ),
    "",
  );

  check("no descriptors means no groups", describeSettings([]).length === 0, "");

  check(
    "the skills category carries the discovery row and the command switch",
    same(
      groups
        .filter((group) => group.category.id === "skills")
        .flatMap((group) => group.settings.map((descriptor) => descriptor.key)),
      ["discoveredSkills", "enableSkillCommands"],
    ) &&
      groups.find((group) => group.category.id === "skills").settings[0].kind === "skills" &&
      groups.find((group) => group.category.id === "skills").settings[1].kind === "boolean",
    "",
  );

  check(
    "the manual skills path list is gone from the catalogue",
    !PI_SETTING_DESCRIPTORS.some((descriptor) => descriptor.key === "skills"),
    PI_SETTING_DESCRIPTORS.map((descriptor) => descriptor.key).join(", "),
  );

  check(
    "the discovery row carries no value of its own and no setter",
    setting("discoveredSkills").kind === "skills" &&
      setting("discoveredSkills").readOnly === true &&
      setting("discoveredSkills").read === undefined &&
      setting("discoveredSkills").write === undefined,
    JSON.stringify({
      kind: setting("discoveredSkills").kind,
      readOnly: setting("discoveredSkills").readOnly,
    }),
  );

  check(
    "the merged Analítica category carries thinking, compaction and retries",
    same(
      groups
        .filter((group) => group.category.id === "analitica")
        .flatMap((group) => group.settings.map((descriptor) => descriptor.key)),
      [
        "defaultThinkingLevel",
        "modelThinkingLevels",
        "hideThinkingBlock",
        "showCacheMissNotices",
        "compaction.enabled",
        "compaction.reserveTokens",
        "compaction.keepRecentTokens",
        "branchSummary.reserveTokens",
        "branchSummary.skipPrompt",
        "retry.enabled",
        "retry.maxRetries",
        "retry.baseDelayMs",
        "retry.maxAgentDelayMs",
      ],
    ),
    groups
      .filter((group) => group.category.id === "analitica")
      .flatMap((group) => group.settings.map((descriptor) => descriptor.key))
      .join(", "),
  );

  check(
    "the paquetes category keeps only the packages table",
    same(
      groups
        .filter((group) => group.category.id === "paquetes")
        .flatMap((group) => group.settings.map((descriptor) => descriptor.key)),
      ["packages"],
    ),
    "",
  );

  check(
    "the provider retry settings stay in red, not in the merged category",
    PI_SETTING_DESCRIPTORS.filter((descriptor) => descriptor.key.indexOf("retry.provider.") === 0).every(
      (descriptor) => descriptor.category === "red",
    ),
    PI_SETTING_DESCRIPTORS.filter((descriptor) => descriptor.key.indexOf("retry.provider.") === 0)
      .map((descriptor) => `${descriptor.key} -> ${descriptor.category}`)
      .join(", "),
  );

  check(
    "the picode category carries the runtime, the transport, the profile row, the version row, the repeatable setup row and the import row",
    same(
      groups
        .filter((group) => group.category.id === "picode")
        .flatMap((group) => group.settings.map((descriptor) => descriptor.key)),
      [
        "picode.runtime",
        "picode.transport",
        "picode.instanceProfile",
        "picode.piVersion",
        "picode.onboarding",
        "picode.importProfile",
      ],
    ),
    groups.map((group) => group.category.id).join(", "),
  );

  check(
    "the picode value rows are the restart-marked ones, both backed by the PiCode store",
    ["picode.runtime", "picode.transport"].every((key) => {
      const descriptor = setting(key);
      return (
        descriptor.category === "picode" &&
        descriptor.needsRestart === true &&
        descriptor.picodeKey !== undefined
      );
    }),
    "",
  );

  check(
    "the three action rows are the repeatable initial setup, the pi update and the profile import, each with its own command",
    same(
      PI_SETTING_DESCRIPTORS.filter((descriptor) => descriptor.kind === "action").map(
        (descriptor) => descriptor.key,
      ),
      ["picode.piVersion", "picode.onboarding", "picode.importProfile"],
    ) &&
      setting("picode.onboarding").command === "picode.piChat.onboarding" &&
      setting("picode.onboarding").read === undefined &&
      setting("picode.onboarding").write === undefined &&
      setting("picode.piVersion").command === "picode.piChat.updatePi" &&
      setting("picode.piVersion").write === undefined &&
      // The id is the one `instance-import-command.ts` exports, not a copy of it.
      setting("picode.importProfile").command === IMPORT_PROFILE_COMMAND &&
      setting("picode.importProfile").read === undefined &&
      setting("picode.importProfile").write === undefined,
    JSON.stringify({
      commands: PI_SETTING_DESCRIPTORS.filter(
        (descriptor) => descriptor.kind === "action",
      ).map((descriptor) => `${descriptor.key}=${descriptor.command}`),
    }),
  );

  {
    const importRow = setting("picode.importProfile");
    check(
      "the import row is an action in the PiCode category, drawing its button from its own caption",
      importRow.category === "picode" &&
        importRow.kind === "action" &&
        importRow.scopes.includes("global") &&
        // The button is drawn from its own caption: the wizard default ("Abrir el
        // asistente") would name the wrong action on this row.
        importRow.actionLabel !== undefined &&
        importRow.actionLabel.trim() !== "",
      JSON.stringify({
        category: importRow.category,
        kind: importRow.kind,
        actionLabel: describeSettingWire(importRow).actionLabel,
      }),
    );
    // The label and the description are read from the product, never restated here.
    // Neither may name a path or a bare count: the owner decides from the copy landing
    // in PiCode's own profile and from the original staying untouched, not from where
    // the files live.
    const ownerText = [importRow.label, importRow.description, importRow.actionLabel];
    check(
      "the import row text carries no path and no raw count",
      ownerText.every(
        (text) =>
          typeof text === "string" &&
          text.trim() !== "" &&
          !/\d/.test(text) &&
          !/[/\\~]/.test(text),
      ),
      JSON.stringify({ label: importRow.label, description: importRow.description }),
    );
  }

  check(
    "the pi update row draws its button from its own caption, and the wizard row keeps the default",
    setting("picode.piVersion").actionLabel === "Instalar la última publicada" &&
      setting("picode.piVersion").label.trim() !== "" &&
      setting("picode.piVersion").description.trim() !== "" &&
      setting("picode.onboarding").actionLabel === undefined,
    JSON.stringify({
      update: describeSettingWire(setting("picode.piVersion")).actionLabel,
      wizard: describeSettingWire(setting("picode.onboarding")).actionLabel,
    }),
  );

  check(
    "the pi update row reads the host's reading, and has none before the host registers one",
    setting("picode.piVersion").read() === undefined,
    String(setting("picode.piVersion").read()),
  );

  setPiVersionStateSource(() => "Instalada la 0.86.1 · publicada la 0.87.1.");
  check(
    "the host's reading is what the row hands the tab",
    setting("picode.piVersion").read() === "Instalada la 0.86.1 · publicada la 0.87.1.",
    String(setting("picode.piVersion").read()),
  );
  setPiVersionStateSource(undefined);
  check(
    "unregistering the reading leaves the row with nothing rather than a stale line",
    setting("picode.piVersion").read() === undefined,
    String(setting("picode.piVersion").read()),
  );

  {
    const profileRow = setting("picode.instanceProfile");
    check(
      "the profile row is a fact in the PiCode category: a read-only line with nothing to write",
      profileRow.category === "picode" &&
        profileRow.kind === "text" &&
        profileRow.readOnly === true &&
        profileRow.write === undefined &&
        profileRow.picodeKey === undefined &&
        profileRow.scopes.includes("global"),
      JSON.stringify({
        category: profileRow.category,
        kind: profileRow.kind,
        readOnly: profileRow.readOnly,
      }),
    );

    // Same rule as the import row: the owner decides by reading which profile is in
    // use, not by where the files live.
    check(
      "the profile row's own text carries no path and no raw count",
      [profileRow.label, profileRow.description].every(
        (text) => text.trim() !== "" && !/\d/.test(text) && !/[/\\~]/.test(text),
      ),
      JSON.stringify({ label: profileRow.label, description: profileRow.description }),
    );

    check(
      "the profile row has no reading before the host registers one",
      profileRow.read() === undefined,
      String(profileRow.read()),
    );

    // The three answers the resolver can give. The facts come from the resolver, so
    // the row only words them: it never reads a profile of its own.
    const words = (state) => {
      setInstanceProfileStateSource(() => state);
      return profileRow.read();
    };
    const internal = words({
      owned: true,
      managed: true,
      internalExists: true,
      internalProviders: 2,
    });
    const owner = words({
      owned: false,
      managed: false,
      internalExists: true,
      internalProviders: 2,
    });
    const noProfile = words({
      owned: false,
      managed: true,
      internalExists: false,
      internalProviders: 0,
    });
    const noCredentials = words({
      owned: false,
      managed: true,
      internalExists: true,
      internalProviders: 0,
    });

    check(
      "the row names PiCode's own profile when that is what pi is using",
      internal === "El perfil propio de PiCode.",
      String(internal),
    );
    check(
      "the row names the owner's profile when that is what pi is using",
      owner === "El perfil de tu pi.",
      String(owner),
    );
    check(
      "when the internal profile is selected but not usable, the row says why and points at the import row",
      noProfile.includes("no tiene perfil") &&
        noCredentials.includes("no tiene credenciales") &&
        noProfile.includes("Importar el perfil de tu pi") &&
        noCredentials.includes("Importar el perfil de tu pi") &&
        !/\d/.test(noProfile) &&
        !/\d/.test(noCredentials) &&
        !/[/\\~]/.test(noProfile) &&
        !/[/\\~]/.test(noCredentials),
      JSON.stringify({ noProfile, noCredentials }),
    );

    setInstanceProfileStateSource(undefined);
    check(
      "unregistering the reading leaves the profile row with nothing rather than a stale line",
      profileRow.read() === undefined,
      String(profileRow.read()),
    );

    // Feeding the row is a separate fact from the row's wording: with a reading
    // registered, the tab has to receive four real lines and never the "sin definir"
    // placeholder the renderer falls back to for an unset value.
    check(
      "with the host's reading registered the row is fed: four real lines, never «sin definir»",
      [internal, owner, noProfile, noCredentials].every(
        (text) => typeof text === "string" && text.trim() !== "" && text !== "sin definir",
      ),
      JSON.stringify({ internal, owner, noProfile, noCredentials }),
    );

    // The line the panel shows above every category. It is the row's own sentence,
    // reused and not reworded, and it appears only while the profile in use is not
    // the one that was chosen: PiCode's own pi selected with a profile that cannot
    // carry an instance yet. With the owner's pi, or with PiCode's own profile
    // usable, there is nothing to say and no line at all.
    const notices = {
      noProfile: describeProfileNotice({
        owned: false,
        managed: true,
        internalExists: false,
        internalProviders: 0,
      }),
      noCredentials: describeProfileNotice({
        owned: false,
        managed: true,
        internalExists: true,
        internalProviders: 0,
      }),
      internal: describeProfileNotice({
        owned: true,
        managed: true,
        internalExists: true,
        internalProviders: 2,
      }),
      owner: describeProfileNotice({
        owned: false,
        managed: false,
        internalExists: true,
        internalProviders: 2,
      }),
    };
    check(
      "the panel's notice is the profile row's own sentence, not a fourth wording",
      notices.noProfile === noProfile &&
        notices.noCredentials === noCredentials &&
        notices.noProfile.includes("Importar el perfil de tu pi"),
      JSON.stringify(notices),
    );
    check(
      "the notice is silent when the profile in use is the chosen one",
      notices.internal === undefined && notices.owner === undefined,
      JSON.stringify(notices),
    );

    // The notice reads the same registered facts the row does, so the two surfaces
    // cannot disagree — and the settings host never resolves a profile of its own.
    setInstanceProfileStateSource(() => ({
      owned: false,
      managed: true,
      internalExists: true,
      internalProviders: 0,
    }));
    check(
      "the notice is read from the same host reading as the profile row",
      instanceProfileNotice() === profileRow.read(),
      JSON.stringify({ notice: instanceProfileNotice(), row: profileRow.read() }),
    );
    setInstanceProfileStateSource(() => ({
      owned: true,
      managed: true,
      internalExists: true,
      internalProviders: 2,
    }));
    check(
      "and with a usable chosen profile there is no notice while the row still reads",
      instanceProfileNotice() === undefined && typeof profileRow.read() === "string",
      JSON.stringify({ notice: instanceProfileNotice(), row: profileRow.read() }),
    );
    setInstanceProfileStateSource(undefined);

    // The registration itself lives in `extension.ts`, which owns the extension's
    // location and the selected runtime. It is pinned here, next to the same reading
    // the version row relies on, so a registration that later falls is a failing check
    // and not a row that quietly renders nothing. Only the source text is read.
    //
    // What is asserted is the fact, not the spelling: the host registers a reading,
    // and that registered reading goes through the shared resolver. The call's literal
    // shape — `instanceProfile(context.extensionUri, runtime.mode)` — is deliberately
    // not required, because pinning it forced the argument list of the shared helper
    // during an unrelated refactor. The reading is found by name and its body is read.
    const extensionSource = fs.readFileSync(
      path.join(__dirname, "..", "src", "extension.ts"),
      "utf8",
    );
    const registration = /setInstanceProfileStateSource\(\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)\s*\(/.exec(
      extensionSource,
    );
    const readingName = registration === null ? undefined : registration[1];
    const readingBody =
      readingName === undefined ? undefined : functionBody(extensionSource, readingName);
    check(
      "the host registers the profile reading next to the version reading, and that reading goes through the shared resolver",
      extensionSource.includes("setPiVersionStateSource(") &&
        readingName !== undefined &&
        readingBody !== undefined &&
        readingBody.includes("instanceProfile("),
      readingName === undefined
        ? "no setInstanceProfileStateSource reading found"
        : `${readingName} goes through the shared resolver: ${readingBody?.includes("instanceProfile(") === true}`,
    );
  }

  /* ---------------------------------------------------------------- *
   * Coercion — the webview boundary
   * ---------------------------------------------------------------- */

  check(
    "a boolean accepts only a boolean",
    coerceSettingValue(setting("quietStartup"), true) === true &&
      coerceSettingValue(setting("quietStartup"), "true") === undefined &&
      coerceSettingValue(setting("quietStartup"), 1) === undefined,
    "",
  );

  check(
    "a number accepts a finite number or a numeric string",
    coerceSettingValue(setting("httpIdleTimeoutMs"), 9000) === 9000 &&
      coerceSettingValue(setting("httpIdleTimeoutMs"), "9000") === 9000,
    "",
  );

  check(
    "a number refuses anything that is not one",
    coerceSettingValue(setting("httpIdleTimeoutMs"), "abc") === undefined &&
      coerceSettingValue(setting("httpIdleTimeoutMs"), "") === undefined &&
      coerceSettingValue(setting("httpIdleTimeoutMs"), Number.NaN) === undefined &&
      coerceSettingValue(setting("httpIdleTimeoutMs"), {}) === undefined,
    "",
  );

  check(
    "a number below its minimum is clamped",
    coerceSettingValue(setting("compaction.reserveTokens"), -5) === 0 &&
      coerceSettingValue(setting("compaction.reserveTokens"), "-5") === 0,
    String(coerceSettingValue(setting("compaction.reserveTokens"), -5)),
  );

  check(
    "a select accepts only one of its own options",
    coerceSettingValue(setting("steeringMode"), "all") === "all" &&
      coerceSettingValue(setting("steeringMode"), "everyone") === undefined &&
      coerceSettingValue(setting("cacheWarming"), "streaming") === "streaming" &&
      coerceSettingValue(setting("cacheWarming"), "always") === undefined,
    "",
  );

  check(
    "a dynamic select accepts any non-empty string and treats whitespace as unset",
    coerceSettingValue(setting("defaultModel"), "omni/gpt-5") === "omni/gpt-5" &&
      coerceSettingValue(setting("defaultModel"), "   ") === undefined &&
      coerceSettingValue(setting("defaultModel"), 42) === undefined,
    "",
  );

  check(
    "text accepts a string and turns whitespace into unset",
    coerceSettingValue(setting("shellPath"), "bash") === "bash" &&
      coerceSettingValue(setting("shellPath"), "   ") === undefined &&
      coerceSettingValue(setting("shellPath"), 42) === undefined,
    "",
  );

  check(
    "a list accepts only non-empty strings",
    same(coerceSettingValue(setting("npmCommand"), ["pnpm", "install"]), ["pnpm", "install"]) &&
      coerceSettingValue(setting("npmCommand"), ["pnpm", 3]) === undefined &&
      coerceSettingValue(setting("npmCommand"), ["pnpm", ""]) === undefined &&
      coerceSettingValue(setting("npmCommand"), "pnpm") === undefined,
    "",
  );

  check(
    "a package list accepts rows with a source and coerces paused to boolean",
    same(coerceSettingValue(setting("packages"), [
      { source: "npm:pi-web-access", paused: false },
      { source: "npm:pi-lens", paused: true },
    ]), [
      { source: "npm:pi-web-access", paused: false },
      { source: "npm:pi-lens", paused: true },
    ]) &&
      coerceSettingValue(setting("packages"), "npm:pi-lens") === undefined &&
      coerceSettingValue(setting("packages"), [{ paused: true }]) === undefined &&
      coerceSettingValue(setting("packages"), [{ source: "  " }]) === undefined,
    "",
  );

  /* ---------------------------------------------------------------- *
   * The service, over the fake
   * ---------------------------------------------------------------- */

  {
    const fake = createFakeManager();
    const { service, created } = await createService(fake);

    check(
      "the manager is built for the given cwd and pi's own agent directory",
      created.cwd === "C:/trabajo" && created.agentDir === "C:/pi-agent",
      JSON.stringify(created),
    );

    const readOnlyError = await rejectionOf(service.write("global", "retry.maxRetries", 5));
    check(
      "writing a read-only setting is refused, naming the key",
      readOnlyError !== undefined &&
        readOnlyError.message.includes("retry.maxRetries") &&
        readOnlyError.message.includes("read-only"),
      readOnlyError && readOnlyError.message,
    );

    // An action row declares no read closure, and that absence must read as
    // undefined rather than as a broken setting the owner has to fix.
    const actionValues = await service.readAll("global");
    check(
      "an action row reads as undefined without a read error",
      "picode.onboarding" in actionValues &&
        actionValues["picode.onboarding"] === undefined &&
        !service
          .diagnostics()
          .some(
            (diagnostic) =>
              diagnostic.type === "read_error" &&
              diagnostic.message.includes("picode.onboarding"),
          ),
      JSON.stringify(service.diagnostics()),
    );

    const actionError = await rejectionOf(service.write("global", "picode.onboarding", true));
    check(
      "writing an action row is refused, naming the key and the reason",
      actionError !== undefined &&
        actionError.message.includes("picode.onboarding") &&
        actionError.message.includes("action") &&
        actionError.message.includes("no value"),
      actionError && actionError.message,
    );

    // The version row is the one action whose reading is a fact the host owns: the tab
    // paints it from the values `readAll` returns, so that reading has to arrive there.
    setPiVersionStateSource(() => "Instalada la 0.86.1 · publicada la 0.87.1.");
    const versionValues = await service.readAll("global");
    check(
      "the tab receives the version row's reading, with no read error beside it",
      versionValues["picode.piVersion"] === "Instalada la 0.86.1 · publicada la 0.87.1." &&
        !service
          .diagnostics()
          .some((diagnostic) => diagnostic.message.includes("picode.piVersion")),
      JSON.stringify(versionValues["picode.piVersion"]),
    );
    const versionWrite = await rejectionOf(
      service.write("global", "picode.piVersion", "0.87.1"),
    );
    check(
      "the version row has no value to write: pressing it runs the update command",
      versionWrite !== undefined && versionWrite.message.includes("picode.piVersion"),
      versionWrite && versionWrite.message,
    );
    setPiVersionStateSource(undefined);

    const unknownError = await rejectionOf(service.write("global", "not.a.setting", 1));
    check(
      "writing an unknown key is refused",
      unknownError !== undefined &&
        unknownError.message.includes("Unknown setting") &&
        unknownError.message.includes("not.a.setting"),
      unknownError && unknownError.message,
    );

    const scopeError = await rejectionOf(service.write("project", "quietStartup", true));
    check(
      "writing in a scope the setting does not support is refused",
      scopeError !== undefined &&
        scopeError.message.includes("quietStartup") &&
        scopeError.message.includes("project"),
      scopeError && scopeError.message,
    );

    const garbageError = await rejectionOf(service.write("global", "quietStartup", "true"));
    check(
      "a value that cannot be expressed as its kind is refused before pi sees it",
      garbageError !== undefined &&
        garbageError.message.includes("quietStartup") &&
        garbageError.message.includes("boolean"),
      garbageError && garbageError.message,
    );

    await service.write("global", "quietStartup", true);
    const afterBoolean = await service.readAll("global");
    check(
      "a valid write changes what readAll returns afterwards",
      afterBoolean.quietStartup === true,
      String(afterBoolean.quietStartup),
    );
    check("the write was flushed through pi", fake.flushCount === 1, String(fake.flushCount));

    await service.write("global", "httpIdleTimeoutMs", "9000");
    check(
      "the service coerces before calling pi's setter",
      (await service.readAll("global")).httpIdleTimeoutMs === 9000,
      String((await service.readAll("global")).httpIdleTimeoutMs),
    );

    await service.write("global", "defaultModel", "deepseek-v4-pro");
    const paired = fake.getGlobalSettings();
    check(
      "choosing a default model writes the bare id next to its provider",
      paired.defaultModel === "deepseek-v4-pro" && paired.defaultProvider === "deepseek",
      JSON.stringify({ provider: paired.defaultProvider, model: paired.defaultModel }),
    );

    const stored = await service.write("global", "httpIdleTimeoutMs", "12345");
    check(
      "write returns the value pi stored, not the raw post",
      stored === 12345,
      String(stored),
    );

    await service.write("global", "shellPath", "   ");
    check(
      "a whitespace-only text clears the setting instead of writing it",
      (await service.readAll("global")).shellPath === undefined,
      String((await service.readAll("global")).shellPath),
    );

    await service.write("global", "modelThinkingLevels", ["deepseek/deepseek-v4-pro=max"]);
    check(
      "the per-model overrides survive a round trip through their own setter",
      same((await service.readAll("global")).modelThinkingLevels, [
        "deepseek/deepseek-v4-pro=max",
      ]),
      JSON.stringify((await service.readAll("global")).modelThinkingLevels),
    );

    const malformedOverride = await rejectionOf(
      service.write("global", "modelThinkingLevels", ["sin-formato"]),
    );
    check(
      "a malformed per-model override is refused",
      malformedOverride !== undefined && malformedOverride.message.includes("modelThinkingLevels"),
      malformedOverride && malformedOverride.message,
    );

    await service.write("global", "packages", [
      { source: "npm:pi-web-access", paused: false },
      { source: "npm:pi-lens", paused: true },
    ]);
    check(
      "a paused package survives a round trip as autoload=false, an active one as a string",
      same(fake.getGlobalSettings().packages, [
        "npm:pi-web-access",
        { source: "npm:pi-lens", autoload: false },
      ]) &&
        same((await service.readAll("global")).packages, [
          { source: "npm:pi-web-access", paused: false },
          { source: "npm:pi-lens", paused: true },
        ]),
      JSON.stringify(fake.getGlobalSettings().packages),
    );

    await service.write("project", "packages", [
      { source: "npm:pi-web-access", paused: false },
    ]);
    const projectValues = await service.readAll("project");
    const globalValues = await service.readAll("global");
    check(
      "a project write lands in the project scope",
      same(projectValues.packages, [{ source: "npm:pi-web-access", paused: false }]),
      JSON.stringify(projectValues.packages),
    );
    check(
      "the global scope is untouched by a project write",
      same(globalValues.packages, [
        { source: "npm:pi-web-access", paused: false },
        { source: "npm:pi-lens", paused: true },
      ]),
      JSON.stringify(globalValues.packages),
    );

    await service.reload();
    check("reload asks pi to re-read its files", fake.reloadCount === 1, String(fake.reloadCount));
    check(
      "a clean fake reports no diagnostics",
      service.diagnostics().length === 0,
      JSON.stringify(service.diagnostics()),
    );
  }

  {
    const fake = createFakeManager();
    const store = {
      values: {},
      sets: [],
      get: (key) => store.values[key],
      set: async (key, value) => {
        store.sets.push([key, value]);
        store.values[key] = value;
      },
    };
    const { service } = await createService(fake, store);

    store.values.runtime = "path";
    store.values.transport = "rpc";
    const values = await service.readAll("global");
    check(
      "a PiCode row reads from the injected store, not from pi's settings",
      values["picode.runtime"] === "path" && values["picode.transport"] === "rpc",
      JSON.stringify({ runtime: values["picode.runtime"], transport: values["picode.transport"] }),
    );

    await service.write("global", "picode.transport", "embedded");
    check(
      "writing a PiCode row goes through the store's setter",
      same(store.sets, [["transport", "embedded"]]),
      JSON.stringify(store.sets),
    );

    const storedPicode = await service.write("global", "picode.transport", "rpc");
    check(
      "a PiCode write also returns the coerced value",
      storedPicode === "rpc",
      String(storedPicode),
    );

    const refused = await rejectionOf(service.write("global", "picode.runtime", "inventado"));
    check(
      "a PiCode row refuses a value outside its declared options",
      refused !== undefined && refused.message.includes("picode.runtime"),
      refused && refused.message,
    );

    const scopeRefused = await rejectionOf(service.write("project", "picode.runtime", "path"));
    check(
      "a PiCode row cannot be written in the project scope",
      scopeRefused !== undefined && scopeRefused.message.includes("project"),
      scopeRefused && scopeRefused.message,
    );

    check(
      "pi's own transport setting is a different row from PiCode's",
      setting("transport").category === "red" &&
        setting("picode.transport").picodeKey === "transport",
      "",
    );
  }

  {
    const fake = createFakeManager();
    fake.breakGetter("getShowCacheMissNotices");
    const { service } = await createService(fake);
    const values = await service.readAll("global");

    check(
      "a getter that throws contributes undefined for its own key",
      "showCacheMissNotices" in values && values.showCacheMissNotices === undefined,
      JSON.stringify(values.showCacheMissNotices),
    );
    check(
      "the failure is reported as a diagnostic naming the key",
      service
        .diagnostics()
        .some(
          (diagnostic) =>
            diagnostic.type === "read_error" && diagnostic.message.includes("showCacheMissNotices"),
        ),
      JSON.stringify(service.diagnostics()),
    );
    check(
      "every other setting still reads",
      values.quietStartup === false &&
        values.defaultProvider === "deepseek" &&
        values["compaction.keepRecentTokens"] === 20000,
      JSON.stringify({
        quietStartup: values.quietStartup,
        defaultProvider: values.defaultProvider,
      }),
    );
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
    failed === 0 ? `\nALL ${results.length} CHECKS PASS` : `\n${failed} of ${results.length} CHECKS FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
