/*
 * Exercises the SDK -> wire translation.
 *
 * The embedded transport hands the panel objects that come straight from a live
 * pi session, and the panel trusts them. Two things have to hold or the panel
 * breaks quietly: an event with no renderer must be dropped here rather than
 * forwarded to be ignored, and the set of events that survives translation must
 * be exactly the set the panel declares. The second one is why this file keeps
 * its own copy of the SDK's event union: if the panel list loses a type, the
 * failure shows up here instead of as a panel that silently stops updating.
 *
 * pi-sdk-protocol.ts imports neither `vscode` nor the SDK, so no stub is needed.
 *
 * Run with: npm test
 */
const { toPiCommands, toPiEvent, toPiModel, toPiSessionState } = require("../out/pi-sdk-protocol.js");
const { PANEL_EVENT_TYPES } = require("../out/protocol.js");

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

/** Structural comparison with stable key order, so it compares shapes not spelling. */
const canonical = (value) =>
  JSON.stringify(value, (key, nested) => {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return Object.keys(nested)
        .sort()
        .reduce((sorted, name) => {
          sorted[name] = nested[name];
          return sorted;
        }, {});
    }
    return nested;
  });
const same = (actual, expected) => canonical(actual) === canonical(expected);
const show = (value) => JSON.stringify(value);

/*
 * The `AgentSessionEvent` union of the installed pi
 * (dist/core/agent-session.d.ts, around line 41): the core AgentEvent members
 * plus the session-level ones. Kept here as data on purpose — this list is the
 * record the coupling check below compares against.
 */
const SDK_EVENT_TYPES = [
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "agent_settled",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "bash_execution_update",
];

/*
 * The SDK event types the panel has no renderer for: persistence bookkeeping
 * (`entry_appended`), session metadata, thinking-level bookkeeping, the
 * summarization retry trio and raw bash output. If one of these starts being
 * forwarded, the panel receives an event it cannot draw.
 */
const NOT_RENDERED_BY_PANEL = [
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "bash_execution_update",
];

// --- toPiEvent: forwarding -------------------------------------------------

for (const type of ["agent_start", "agent_settled", "message_update", "tool_execution_end"]) {
  const event = { type, marker: `kept-${type}` };
  check(`toPiEvent forwards "${type}" unchanged`, toPiEvent(event) === event, "");
}

// --- toPiEvent: dropping ---------------------------------------------------

for (const type of ["entry_appended", "thinking_level_changed", "bash_execution_update"]) {
  check(`toPiEvent drops "${type}"`, toPiEvent({ type }) === undefined, "");
}
check("toPiEvent drops null", toPiEvent(null) === undefined, "");
check("toPiEvent drops a non-object", toPiEvent("agent_start") === undefined, "");
check("toPiEvent drops an event without a type", toPiEvent({}) === undefined, "");
check("toPiEvent drops an event whose type is not a string", toPiEvent({ type: 7 }) === undefined, "");

// Extension errors are not part of the SDK event union: they reach the client
// through bindings and are forwarded as a panel event, so the gate must let the
// panel's own type through.
check(
  "toPiEvent forwards extension_error, which the panel does render",
  toPiEvent({ type: "extension_error", error: "boom" })?.type === "extension_error",
  "",
);

// --- the coupling check ----------------------------------------------------

const panelTypes = new Set(PANEL_EVENT_TYPES);
const forwarded = SDK_EVENT_TYPES.filter((type) => toPiEvent({ type }) !== undefined);

check(
  "every event type the panel declares is forwarded",
  PANEL_EVENT_TYPES.every((type) => toPiEvent({ type }) !== undefined),
  show(PANEL_EVENT_TYPES.filter((type) => toPiEvent({ type }) === undefined)),
);
check(
  "every SDK event type that is forwarded is declared by the panel",
  forwarded.every((type) => panelTypes.has(type)),
  show(forwarded.filter((type) => !panelTypes.has(type))),
);
check(
  "the panel renders every SDK session event except the session-level extras",
  same(
    [...forwarded].sort(),
    SDK_EVENT_TYPES.filter((type) => !NOT_RENDERED_BY_PANEL.includes(type)).sort(),
  ),
  `${show([...forwarded].sort())} forwarded vs ` +
    `${show(SDK_EVENT_TYPES.filter((type) => !NOT_RENDERED_BY_PANEL.includes(type)).sort())} expected`,
);

// --- toPiModel -------------------------------------------------------------

check("toPiModel drops a model without an id", toPiModel({ name: "no id" }) === undefined, "");
check("toPiModel drops an empty id", toPiModel({ id: "" }) === undefined, "");
check("toPiModel drops null", toPiModel(null) === undefined, "");

check(
  "toPiModel keeps the fields the picker shows",
  same(toPiModel({ id: "gpt-5", name: "GPT-5", provider: "openai", reasoning: true }), {
    id: "gpt-5",
    name: "GPT-5",
    provider: "openai",
    reasoning: true,
  }),
  show(toPiModel({ id: "gpt-5", name: "GPT-5", provider: "openai", reasoning: true })),
);

const mistyped = toPiModel({
  id: "m",
  name: 3,
  api: null,
  baseUrl: {},
  reasoning: "yes",
  contextWindow: "128000",
  maxTokens: NaN,
});
check(
  "toPiModel omits fields of the wrong type instead of coercing them",
  same(mistyped, { id: "m" }),
  show(mistyped),
);

// --- toPiSessionState ------------------------------------------------------

check("an empty snapshot yields an empty state", same(toPiSessionState({}), {}), "");

const state = toPiSessionState({
  model: { id: "gpt-5", provider: "openai" },
  thinkingLevel: "high",
  isStreaming: true,
  isCompacting: false,
  sessionFile: "C:/sessions/one.jsonl",
  sessionId: "s-1",
  sessionName: "uno",
  messageCount: 3,
  pendingMessageCount: Number.NaN,
  autoCompactionEnabled: true,
  steeringMode: "one-at-a-time",
  followUpMode: "all",
});
check(
  "toPiSessionState copies the strings, booleans and counts it is given",
  same(state, {
    model: { id: "gpt-5", provider: "openai" },
    thinkingLevel: "high",
    isStreaming: true,
    isCompacting: false,
    sessionFile: "C:/sessions/one.jsonl",
    sessionId: "s-1",
    sessionName: "uno",
    messageCount: 3,
    autoCompactionEnabled: true,
    steeringMode: "one-at-a-time",
    followUpMode: "all",
  }),
  show(state),
);

const partial = toPiSessionState({
  model: { name: "no id" },
  thinkingLevel: 2,
  isStreaming: "yes",
  sessionId: 42,
  messageCount: "3",
  steeringMode: "sometimes",
});
check(
  "toPiSessionState omits the fields it cannot narrow, including a model without an id",
  same(partial, {}),
  show(partial),
);

// --- toPiCommands ----------------------------------------------------------

const commands = toPiCommands({
  commands: [
    { name: "internal-name", invocationName: "typed-name", description: "extension one" },
    { name: "both", invocationName: "typed-both" },
    { name: "", description: "no name" },
    { name: "no-description", description: 7 },
  ],
  skills: [
    { name: "typed-both", description: "skill with a name an extension already took" },
    { name: "skill-one", description: "skill one" },
  ],
  prompts: [
    { name: "prompt-one", description: "prompt one" },
    { name: "skill-one", description: "prompt with a name a skill already took" },
  ],
});

check(
  "an extension command prefers invocationName over name",
  commands[0]?.name === "typed-name",
  show(commands[0]),
);
check(
  "the three sources are labelled extension, skill and prompt, in that order",
  same(
    commands.map((command) => `${command.source}:${command.name}`),
    [
      "extension:typed-name",
      "extension:typed-both",
      "extension:no-description",
      "skill:skill-one",
      "prompt:prompt-one",
    ],
  ),
  show(commands.map((command) => `${command.source}:${command.name}`)),
);
check(
  "an entry whose name is empty is skipped",
  !commands.some((command) => command.name.length === 0),
  show(commands.map((command) => command.name)),
);
check(
  "a name seen twice is kept once, and the first source wins",
  commands.filter((command) => command.name === "typed-both" || command.name === "skill-one")
    .length === 2,
  show(commands.filter((command) => command.name === "typed-both" || command.name === "skill-one")),
);
check(
  "a non-string description is omitted, not carried and not coerced",
  same(commands.find((command) => command.name === "no-description"), {
    name: "no-description",
    source: "extension",
  }),
  show(commands.find((command) => command.name === "no-description")),
);
check(
  "an extension command without invocationName falls back to name",
  commands.some((command) => command.name === "no-description" && command.source === "extension"),
  "",
);
check(
  "an event-shaped entry (no name) is skipped instead of throwing",
  same(toPiCommands({ commands: [null, 5, { description: "only a description" }] }), []),
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
