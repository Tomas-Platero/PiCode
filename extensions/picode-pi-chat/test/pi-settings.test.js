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

const {
  PI_SETTINGS_CATEGORIES,
  PI_SETTING_DESCRIPTORS,
  describeSettings,
  coerceSettingValue,
  PiSettingsService,
} = require(path.join(__dirname, "..", "out", "pi-settings.js"));

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
 * in-memory record: the global values plus the five per-scope resource lists, which
 * are the only settings pi can write in a project.
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
    theme: "dark",
    collapseChangelog: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    sessionDir: undefined,
    packages: [],
    extensions: ["/global/ext"],
    skills: [],
    prompts: [],
    themes: [],
  };
  const project = {
    packages: undefined,
    extensions: undefined,
    skills: undefined,
    prompts: undefined,
    themes: undefined,
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

    getThemeSetting: () => global.theme,
    setTheme: (theme) => {
      global.theme = theme;
    },
    getThemePaths: () => [...global.themes],
    setThemePaths: (paths) => {
      global.themes = [...paths];
    },
    setProjectThemePaths: (paths) => {
      project.themes = [...paths];
    },
    getCollapseChangelog: () => global.collapseChangelog,
    setCollapseChangelog: (collapse) => {
      global.collapseChangelog = collapse;
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
    "the project scope is offered by the packages table, the skills list and the theme paths",
    same(
      PI_SETTING_DESCRIPTORS.filter((descriptor) => descriptor.scopes.includes("project")).map(
        (descriptor) => descriptor.key,
      ),
      ["packages", "discoveredSkills", "themes"],
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
      describeSettings([setting("steeringMode"), setting("theme")]).map(
        (group) => group.category.id,
      ),
      ["apariencia", "sesion"],
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
    "the picode category carries the runtime, the transport and the repeatable setup row",
    same(
      groups
        .filter((group) => group.category.id === "picode")
        .flatMap((group) => group.settings.map((descriptor) => descriptor.key)),
      ["picode.runtime", "picode.transport", "picode.onboarding"],
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
    "the only action row is the repeatable initial setup, pointed at the wizard command",
    same(
      PI_SETTING_DESCRIPTORS.filter((descriptor) => descriptor.kind === "action").map(
        (descriptor) => descriptor.key,
      ),
      ["picode.onboarding"],
    ) &&
      setting("picode.onboarding").command === "picode.piChat.onboarding" &&
      setting("picode.onboarding").read === undefined &&
      setting("picode.onboarding").write === undefined,
    JSON.stringify({
      command: setting("picode.onboarding").command,
      read: setting("picode.onboarding").read,
      write: setting("picode.onboarding").write,
    }),
  );

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
    same(coerceSettingValue(setting("themes"), ["/a", "/b"]), ["/a", "/b"]) &&
      coerceSettingValue(setting("themes"), ["/a", 3]) === undefined &&
      coerceSettingValue(setting("themes"), ["/a", ""]) === undefined &&
      coerceSettingValue(setting("themes"), "/a") === undefined,
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

    await service.write("project", "themes", ["/proyecto/temas"]);
    const projectValues = await service.readAll("project");
    const globalValues = await service.readAll("global");
    check(
      "a project write lands in the project scope",
      same(projectValues.themes, ["/proyecto/temas"]),
      JSON.stringify(projectValues.themes),
    );
    check(
      "the global scope is untouched by a project write",
      same(globalValues.themes, []),
      JSON.stringify(globalValues.themes),
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
