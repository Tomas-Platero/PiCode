/*
 * Exercises the session's usage arithmetic and its formatting.
 *
 * This is the one place in the panel that talks about money, so the numbers and the
 * way they are written are checked rather than eyeballed: a cost that rounds to zero
 * or a context figure that sums instead of taking the last turn would both be
 * confidently wrong.
 *
 * Run with: npm test
 */
const { addMessageUsage, emptyUsage, formatTokens, formatCost, formatCount, contextPressure, summarizeUsage, describeUsage, countToolCalls } =
  require("../out/usage.js");

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

const usageOf = (input, output, cacheRead, cost, totalTokens) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

// --- accumulation ----------------------------------------------------------

let totals = emptyUsage();
check("a session starts at zero", totals.assistantMessages === 0 && totals.cost === 0, "");

totals = addMessageUsage(totals, usageOf(1000, 200, 500, 0.0123, 1700), [
  { type: "text", text: "hola" },
  { type: "toolCall", id: "1", name: "read", arguments: {} },
]);
check(
  "a message adds its tokens, its cost and its tool call",
  totals.input === 1000 &&
    totals.output === 200 &&
    totals.cacheRead === 500 &&
    Math.abs(totals.cost - 0.0123) < 1e-9 &&
    totals.toolCalls === 1 &&
    totals.assistantMessages === 1,
  JSON.stringify(totals),
);

totals = addMessageUsage(totals, usageOf(2000, 400, 0, 0.01, 2400), [{ type: "text", text: "mas" }]);
check(
  "a second message accumulates onto the first",
  totals.input === 3000 && totals.assistantMessages === 2 && totals.toolCalls === 1,
  JSON.stringify({ input: totals.input, messages: totals.assistantMessages }),
);
check(
  "the context figure is the last turn, not a sum",
  totals.contextTokens === 2400,
  String(totals.contextTokens),
);

const withoutUsage = addMessageUsage(totals, undefined, [{ type: "text", text: "sin uso" }]);
check(
  "a message with no usage still counts as a reply and changes no total",
  withoutUsage.assistantMessages === 3 && withoutUsage.input === 3000 && withoutUsage.cost === totals.cost,
  JSON.stringify({ messages: withoutUsage.assistantMessages, input: withoutUsage.input }),
);

check(
  "tool calls are counted from the content block",
  countToolCalls([
    { type: "toolCall", id: "a", name: "x", arguments: {} },
    { type: "thinking", thinking: "..." },
    { type: "toolCall", id: "b", name: "y", arguments: {} },
  ]) === 2,
  "",
);
check("absent content counts nothing", countToolCalls(undefined) === 0, "");

// --- formatting ------------------------------------------------------------

check("small token counts stay exact", formatTokens(842) === "842", formatTokens(842));
check("thousands are abbreviated", formatTokens(12345) === "12,3k", formatTokens(12345));
check("hundreds of thousands lose the decimal", formatTokens(123456) === "123k", formatTokens(123456));
check("millions are abbreviated too", formatTokens(2_400_000) === "2,40M", formatTokens(2_400_000));
check("nothing is zero", formatTokens(0) === "0", formatTokens(0));

check("a fraction of a cent is not rounded to zero", formatCost(0.0042) === "0,0042 $", formatCost(0.0042));
check("a real amount uses two decimals", formatCost(1.2345) === "1,23 $", formatCost(1.2345));
check("no cost reads as zero", formatCost(0) === "0 $", formatCost(0));

check(
  "context pressure is a percentage of the window",
  contextPressure(totals, 200_000) === "1% de 200k",
  contextPressure(totals, 200_000),
);
check("without a window there is no pressure figure", contextPressure(totals, undefined) === undefined, "");

// --- the two renderings ----------------------------------------------------

check("an unused session has no line", summarizeUsage(emptyUsage(), 200_000) === "", "");
check(
  "the panel line carries tokens, cache, cost and pressure",
  summarizeUsage(totals, 200_000) === "3,6k tokens · 500 en caché · 0,0223 $ · contexto 1% de 200k",
  summarizeUsage(totals, 200_000),
);
check(
  "a report with no replies says so instead of showing zeros",
  describeUsage(emptyUsage(), 200_000)[0].includes("Todavía no hay ninguna respuesta"),
  describeUsage(emptyUsage(), 200_000)[0],
);
check(
  "the report breaks the totals down",
  describeUsage(totals, 200_000).some((line) => line.startsWith("respuestas: 2")) &&
    describeUsage(totals, 200_000).some((line) => line.startsWith("tokens de entrada: 3.000")) &&
    describeUsage(totals, 200_000).some((line) => line.startsWith("coste acumulado: 0,0223 $")),
  JSON.stringify(describeUsage(totals, 200_000)),
);
check(
  "counts are grouped the same way regardless of the ICU build",
  formatCount(3000) === "3.000" && formatCount(200000) === "200.000" && formatCount(600) === "600",
  `${formatCount(3000)} / ${formatCount(200000)}`,
);
check(
  "an unknown window is admitted rather than guessed",
  describeUsage(totals, undefined).some((line) => line.includes("ventana desconocida")),
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
