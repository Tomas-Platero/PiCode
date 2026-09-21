/*
 * Exercises the figures the stats column and the stats strip show.
 *
 * These values are what the two panels claim about money, tokens and where the agent
 * runs, so they are checked against fixtures rather than eyeballed: a cache share
 * that counted writes instead of reads, or a detached HEAD rendered as a branch name,
 * would both be confidently wrong. Everything here is plain objects and fixture text
 * — no filesystem and no git.
 *
 * Run with: npm test
 */
const {
  cacheHitPercent,
  countMcpServers,
  parseBranch,
  describeLiveStats,
  describeEnvironment,
} = require("../out/stats.js");
const { contextPercent, contextPressure } = require("../out/usage.js");

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

const totalsOf = (over = {}) => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  contextTokens: 0,
  cost: 0,
  assistantMessages: 0,
  toolCalls: 0,
  ...over,
});

// --- cacheHitPercent -------------------------------------------------------

check(
  "a real mix is the cache share of what was read",
  cacheHitPercent(totalsOf({ cacheRead: 750, input: 250 })) === 75,
  String(cacheHitPercent(totalsOf({ cacheRead: 750, input: 250 }))),
);
check(
  "with no cache reads the share is zero",
  cacheHitPercent(totalsOf({ cacheRead: 0, input: 1000 })) === 0,
  String(cacheHitPercent(totalsOf({ cacheRead: 0, input: 1000 }))),
);
check(
  "with nothing read there is no share",
  cacheHitPercent(totalsOf({ cacheRead: 0, input: 0 })) === undefined,
  String(cacheHitPercent(totalsOf({ cacheRead: 0, input: 0 }))),
);
check(
  "rounding matters and lands on the nearest point",
  cacheHitPercent(totalsOf({ cacheRead: 2, input: 1 })) === 67 &&
    cacheHitPercent(totalsOf({ cacheRead: 1, input: 2 })) === 33,
  `${cacheHitPercent(totalsOf({ cacheRead: 2, input: 1 }))} / ${cacheHitPercent(totalsOf({ cacheRead: 1, input: 2 }))}`,
);
check(
  "cache writes are not counted as reads",
  cacheHitPercent(totalsOf({ cacheRead: 0, cacheWrite: 900, input: 100 })) === 0,
  String(cacheHitPercent(totalsOf({ cacheRead: 0, cacheWrite: 900, input: 100 }))),
);

// --- countMcpServers -------------------------------------------------------

const realMcpConfig = JSON.stringify({
  mcpServers: {
    "pi-web-access": { command: "node", args: ["web.js"] },
    "pi-lens": { command: "node", args: ["lens.js"] },
    "pi-mcp-adapter": { command: "node", args: ["adapter.js"] },
    memory: { command: "node", args: ["memory.js"] },
    intercom: { command: "node", args: ["intercom.js"] },
    btw: { command: "node", args: ["btw.js"] },
  },
  settings: { transport: "stdio" },
});

check(
  "the owner's real config has six servers",
  countMcpServers(realMcpConfig) === 6,
  String(countMcpServers(realMcpConfig)),
);
check(
  "servers switched off do not count",
  countMcpServers(
    JSON.stringify({
      mcpServers: {
        a: {},
        b: {},
        c: {},
        d: {},
        off: { enabled: false },
        alsoOff: { disabled: true },
      },
    }),
  ) === 4,
  String(
    countMcpServers(
      JSON.stringify({
        mcpServers: { a: {}, b: {}, c: {}, d: {}, off: { enabled: false }, alsoOff: { disabled: true } },
      }),
    ),
  ),
);
check(
  "an array of servers is not the shape we read",
  countMcpServers(JSON.stringify({ mcpServers: [{}, {}] })) === undefined,
  String(countMcpServers(JSON.stringify({ mcpServers: [{}, {}] }))),
);
check(
  "text that is not JSON yields nothing",
  countMcpServers("not json at all") === undefined &&
    countMcpServers("{ broken") === undefined,
  "",
);
check("a config with no mcpServers yields nothing", countMcpServers("{}") === undefined, "");
check(
  "a config where every server is off yields nothing",
  countMcpServers(JSON.stringify({ mcpServers: { a: { enabled: false }, b: { disabled: true } } })) === undefined,
  String(countMcpServers(JSON.stringify({ mcpServers: { a: { enabled: false }, b: { disabled: true } } }))),
);

// --- parseBranch -----------------------------------------------------------

check("a branch name is trimmed and kept", parseBranch("feat/x\n") === "feat/x", String(parseBranch("feat/x\n")));
check("a detached HEAD is not a branch", parseBranch("HEAD\n") === undefined, String(parseBranch("HEAD\n")));
check("empty output is no branch", parseBranch("") === undefined, String(parseBranch("")));
check("whitespace only is no branch", parseBranch("   \n") === undefined, String(parseBranch("   \n")));
check(
  "a branch name with slashes is kept whole",
  parseBranch("feat/picode-distribution\n") === "feat/picode-distribution",
  String(parseBranch("feat/picode-distribution\n")),
);

// --- describeLiveStats -----------------------------------------------------

const liveAll = describeLiveStats(
  totalsOf({ input: 250, output: 1250, cacheRead: 750, contextTokens: 124000, cost: 1.2345 }),
  200_000,
);
check(
  "every live figure is present when it can be computed",
  liveAll.context === "62 %" &&
    liveAll.cost === "1,23 $" &&
    liveAll.tokens === "1,5k" &&
    liveAll.cache === "75 %",
  JSON.stringify(liveAll),
);
check(
  "an empty session has no live figures",
  Object.keys(describeLiveStats(totalsOf(), 200_000)).length === 0 &&
    Object.keys(describeLiveStats(totalsOf())).length === 0,
  JSON.stringify(describeLiveStats(totalsOf(), 200_000)),
);
check(
  "no context size leaves context out",
  describeLiveStats(totalsOf({ input: 100, cost: 0.5 }), 200_000).context === undefined,
  JSON.stringify(describeLiveStats(totalsOf({ input: 100, cost: 0.5 }), 200_000)),
);
check(
  "a window of zero leaves context out",
  describeLiveStats(totalsOf({ input: 100, contextTokens: 5000 }), 0).context === undefined,
  JSON.stringify(describeLiveStats(totalsOf({ input: 100, contextTokens: 5000 }), 0)),
);
check(
  "a cost of exactly zero is omitted rather than shown as zero",
  describeLiveStats(totalsOf({ input: 100, cost: 0 }), 200_000).cost === undefined,
  JSON.stringify(describeLiveStats(totalsOf({ input: 100, cost: 0 }), 200_000)),
);
check(
  "with nothing read there is no cache figure",
  describeLiveStats(totalsOf({ cost: 1 }), 200_000).cache === undefined,
  JSON.stringify(describeLiveStats(totalsOf({ cost: 1 }), 200_000)),
);
check(
  "with no tokens there is no token figure",
  describeLiveStats(totalsOf({ cost: 1, cacheRead: 10 }), 200_000).tokens === undefined,
  JSON.stringify(describeLiveStats(totalsOf({ cost: 1, cacheRead: 10 }), 200_000)),
);
check(
  "the live percentages carry the unit with a space before it",
  describeLiveStats(totalsOf({ input: 250, cacheRead: 750, contextTokens: 100000 }), 200_000).context === "50 %" &&
    describeLiveStats(totalsOf({ input: 250, cacheRead: 750 }), 200_000).cache === "75 %",
  JSON.stringify(describeLiveStats(totalsOf({ input: 250, cacheRead: 750, contextTokens: 100000 }), 200_000)),
);

// --- describeEnvironment ---------------------------------------------------

check(
  "every environment figure is present when it was given",
  JSON.stringify(
    describeEnvironment({ mcps: 6, sessions: 12, project: "PiCode", branch: "feat/picode-distribution" }),
  ) === JSON.stringify({ mcps: "6", sessions: "12", project: "PiCode", branch: "feat/picode-distribution" }),
  JSON.stringify(
    describeEnvironment({ mcps: 6, sessions: 12, project: "PiCode", branch: "feat/picode-distribution" }),
  ),
);
check(
  "each missing environment figure is omitted",
  Object.keys(describeEnvironment({})).length === 0,
  JSON.stringify(describeEnvironment({})),
);
check(
  "a lone count is rendered as a plain decimal string",
  describeEnvironment({ mcps: 10 }).mcps === "10" && describeEnvironment({ sessions: 3 }).sessions === "3",
  JSON.stringify(describeEnvironment({ mcps: 10 })),
);
check(
  "the word undefined never reaches the output",
  !JSON.stringify(describeEnvironment({ project: "PiCode" })).includes("undefined") &&
    Object.values(describeEnvironment({ project: "PiCode" })).every((value) => value !== "undefined"),
  JSON.stringify(describeEnvironment({ project: "PiCode" })),
);
check(
  "names are taken exactly as they come",
  describeEnvironment({ project: "PiCode", branch: "feat/x" }).project === "PiCode",
  JSON.stringify(describeEnvironment({ project: "PiCode", branch: "feat/x" })),
);

// --- the extraction cannot drift -------------------------------------------

const driftTotals = totalsOf({ contextTokens: 124000 });
check(
  "contextPercent agrees with the percentage inside contextPressure",
  contextPressure(driftTotals, 200_000) === `${contextPercent(driftTotals, 200_000)}% de 200k`,
  `${contextPercent(driftTotals, 200_000)} vs ${contextPressure(driftTotals, 200_000)}`,
);
check(
  "and both go quiet together without a window",
  contextPercent(driftTotals, undefined) === undefined && contextPressure(driftTotals, undefined) === undefined,
  "",
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
