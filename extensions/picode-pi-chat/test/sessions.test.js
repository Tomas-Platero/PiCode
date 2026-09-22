/*
 * Exercises the session readers.
 *
 * The directory name is pi's own convention and getting it wrong means reporting an empty
 * list, which reads as "you have no sessions" rather than "PiCode looked in the wrong
 * place" — so the encoding is checked against names that actually exist on this machine,
 * not against names invented for the test.
 *
 * Run with: npm test
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const {
  encodeProjectDir,
  projectSessionsDir,
  sessionName,
  sessionTitle,
  sessionsRoot,
  formatBytes,
  listSessions,
  readSession,
  parseSession,
} = require("../out/sessions.js");

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

// --- the directory convention ---------------------------------------------

check(
  "a Windows path becomes the name pi uses",
  encodeProjectDir("D:\\repositorios\\PiCode") === "--D--repositorios-PiCode--",
  encodeProjectDir("D:\\repositorios\\PiCode"),
);
check(
  "a nested path keeps its shape",
  encodeProjectDir("C:\\Users\\tapla\\AppData\\Local\\Programs\\Microsoft VS Code") ===
    "--C--Users-tapla-AppData-Local-Programs-Microsoft VS Code--",
  encodeProjectDir("C:\\Users\\tapla\\AppData\\Local\\Programs\\Microsoft VS Code"),
);
check(
  "a leading separator is dropped, not doubled",
  encodeProjectDir("/home/me/project") === "--home-me-project--",
  encodeProjectDir("/home/me/project"),
);

// The real root of this machine, to prove the reader agrees with what is on disk.
const realRoot = sessionsRoot();
const realProject = projectSessionsDir("D:\\repositorios\\PiCode", realRoot);
check(
  "the sessions root is pi's default",
  realRoot.endsWith(path.join(".pi", "agent", "sessions")),
  realRoot,
);
check(
  "this project's directory is found on disk despite the drive letter's case",
  realProject !== undefined && fs.existsSync(realProject),
  realProject,
);

check(
  "--session-dir is honoured, both spellings",
  sessionsRoot(["--session-dir", "D:\\elsewhere"]) === "D:\\elsewhere" &&
    sessionsRoot(["--session-dir=D:\\other"]) === "D:\\other",
  `${sessionsRoot(["--session-dir", "D:\\elsewhere"])} / ${sessionsRoot(["--session-dir=D:\\other"])}`,
);
check(
  "an unrelated argument does not change the root",
  sessionsRoot(["--verbose", "--thinking", "high"]) === sessionsRoot([]),
  sessionsRoot(["--verbose", "--thinking", "high"]),
);
check(
  "a missing root is reported as undefined rather than guessed",
  projectSessionsDir("D:\\nothing", "D:\\no-such-directory") === undefined,
  "",
);

// --- titles ----------------------------------------------------------------

const header = JSON.stringify({ type: "header", version: 3, sessionId: "abc" });
check(
  "the first user message becomes the title",
  sessionTitle(`${header}\n${JSON.stringify({ message: { role: "user", content: "arregla el login" } })}\n`) ===
    "arregla el login",
  "",
);
check(
  "a header alone yields no title",
  sessionTitle(`${header}\n`) === undefined,
  "",
);
check(
  "structured content is flattened instead of dropped",
  sessionTitle(
    `${JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "mira" }, { type: "text", text: "esto" }] } })}\n`,
  ) === "mira esto",
  "",
);
check(
  "whitespace is collapsed and long titles are cut",
  sessionTitle(
    `${JSON.stringify({ message: { role: "user", content: "una linea\n\n  muy   larga" } })}\n`,
  ) === "una linea muy larga" &&
    sessionTitle(`${JSON.stringify({ message: { role: "user", content: "x".repeat(200) } })}\n`).length === 81,
  "",
);
check(
  "a half-written last line is skipped rather than crashing",
  sessionTitle(`${header}\n{"message":{"role":"user","content":"cort`) === undefined,
  "",
);
check(
  "an assistant message is not a title",
  sessionTitle(`${JSON.stringify({ message: { role: "assistant", content: "hola" } })}\n`) === undefined,
  "",
);

// --- the name pi gives a session -------------------------------------------

check(
  "pi's own name for a session is read",
  sessionName(
    `${header}\n${JSON.stringify({ type: "session_info", id: "x", name: "gentle-ai-worker#506cf9b0" })}\n`,
  ) === "gentle-ai-worker#506cf9b0",
  "",
);
check("a session pi did not name has no name", sessionName(header) === undefined, "");
check(
  "an empty name is treated as no name",
  sessionName(`${JSON.stringify({ type: "session_info", id: "x", name: "" })}\n`) === undefined,
  "",
);

// --- sizes -----------------------------------------------------------------

check(
  "sizes are readable",
  formatBytes(512) === "512 B" && formatBytes(2048) === "2,0 kB" && formatBytes(2_500_000) === "2,4 MB",
  `${formatBytes(512)} / ${formatBytes(2048)} / ${formatBytes(2_500_000)}`,
);

// --- the real listing ------------------------------------------------------

if (realProject && fs.existsSync(realProject)) {
  const sessions = listSessions(realProject);
  check("this project's sessions are listed", sessions.length > 0, `${sessions.length} sesiones`);
  check(
    "they come back newest first",
    sessions.every((session, index) => index === 0 || sessions[index - 1].modified >= session.modified),
    "",
  );
  check(
    "each one carries a path that exists and a stamp",
    sessions.every((session) => fs.existsSync(session.file) && session.stamp.length > 0),
    JSON.stringify(sessions[0]),
  );
  check(
    "a title was derived for the sessions that have a user message",
    sessions.some((session) => typeof session.title === "string" && session.title.length > 0),
    JSON.stringify(sessions.map((session) => session.title ?? null)),
  );
  check(
    "the sessions pi named come back named, which is how subagent runs are labelled",
    sessions.some((session) => typeof session.name === "string" && session.name.includes("#")),
    JSON.stringify(sessions.map((session) => session.name ?? null)),
  );
  check(
    "the full read returns the file it was given",
    readSession(sessions[0].file).length > 0,
    "",
  );
} else {
  check("this project's sessions are on disk", false, "no directory for this project");
}

check("a project with no sessions yields an empty list", listSessions(path.join(os.tmpdir(), "nope")).length === 0, "");

// --- replaying a session file ----------------------------------------------

const line = (value) => `${JSON.stringify(value)}\n`;

// A file with one entry of every kind the log carries. Only the three message roles
// are this module's business; the rest must fall through without taking the
// conversation with them.
const mixed = [
  { type: "session", id: "s0", timestamp: 0 },
  {
    type: "message",
    id: "m1",
    timestamp: 1,
    message: {
      role: "user",
      content: [
        { type: "text", text: "mira esto" },
        { type: "image", source: { type: "base64", mediaType: "image/png", data: "AAAA" } },
      ],
      timestamp: 1,
    },
  },
  { type: "custom", id: "c1", customType: "nota", data: { a: 1 } },
  {
    type: "message",
    id: "m2",
    timestamp: 2,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "pensando" },
        { type: "text", text: "listo" },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } },
      ],
      usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 5, reasoning: 3, cost: { total: 0.01 } },
      timestamp: 2,
    },
  },
  {
    type: "message",
    id: "m3",
    timestamp: 3,
    message: {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [{ type: "text", text: "contenido" }],
      isError: false,
      timestamp: 3,
    },
  },
  { type: "message", id: "m4", timestamp: 4, message: { role: "system", content: "instrucciones" } },
  { type: "model_change", id: "x1", model: "p/m" },
];

const replay = parseSession(mixed.map(line).join(""));
check(
  "only the three message roles come back, in order",
  JSON.stringify(replay.messages.map((message) => message.role)) === JSON.stringify(["user", "assistant", "toolResult"]),
  JSON.stringify(replay.messages.map((message) => message.role)),
);
check(
  "the content blocks come back identical to the file, untouched",
  JSON.stringify(replay.messages[1].content) === JSON.stringify(mixed[3].message.content) &&
    replay.messages[1].content[2].type === "toolCall" &&
    replay.messages[1].content[1].type === "text" &&
    replay.messages[1].content[0].type === "thinking",
  JSON.stringify(replay.messages[1].content),
);
check(
  "a tool result carries the id that matches it to its call",
  replay.messages[2].toolCallId === "t1" &&
    replay.messages[2].toolName === "read" &&
    replay.messages[2].isError === false,
  JSON.stringify(replay.messages[2]),
);
check(
  "the assistant's usage is kept for the panel",
  replay.messages[1].usage && replay.messages[1].usage.cost.total === 0.01,
  JSON.stringify(replay.messages[1].usage),
);

const withGarbage = [
  JSON.stringify({ type: "message", message: { role: "user", content: "uno" } }),
  "{ this is not json",
  JSON.stringify({ type: "message", message: { role: "assistant", content: "dos" } }),
  JSON.stringify({ type: "message", message: { role: "user", content: "tres" } }),
  "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"cua",
];
const survived = parseSession(`${withGarbage.join("\n")}\n`);
check(
  "a truncated tail and an unreadable line are skipped without losing the rest",
  survived.messages.length === 3 &&
    survived.messages[0].content === "uno" &&
    survived.messages[2].content === "tres",
  JSON.stringify(survived.messages.map((message) => message.content)),
);

const bare = parseSession(line({ role: "user", content: [{ type: "text", text: "sin envoltorio" }] }));
check(
  "a top-level {role, content} entry is accepted too",
  bare.messages.length === 1 &&
    bare.messages[0].role === "user" &&
    bare.messages[0].content[0].text === "sin envoltorio",
  JSON.stringify(bare.messages),
);

// Five assistant messages: one with no usage at all and one whose cost is not a
// number. Neither may poison the totals, and contextTokens is the LAST message's
// request size rather than the sum of every request.
const usageFile = [
  { type: "message", message: { role: "user", content: "pregunta" } },
  { type: "message", message: { role: "assistant", content: "a1", usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 5, reasoning: 3, cost: { total: 0.01 } } } },
  { type: "message", message: { role: "assistant", content: "a2" } },
  { type: "message", message: { role: "assistant", content: "a3", usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: { total: 0.02 } } } },
  { type: "message", message: { role: "assistant", content: "a4", usage: { input: 300, output: 30, cacheRead: 40, cacheWrite: 0, reasoning: 0, cost: { total: "gratis" } } } },
  { type: "message", message: { role: "assistant", content: "a5", usage: { input: 400, output: 40, cacheRead: 50, cacheWrite: 10, reasoning: 5, cost: { total: 0.04 } } } },
  { type: "message", message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: "r1" } },
];
const summed = parseSession(usageFile.map(line).join("")).totals;
check(
  "the totals add the five replies and shrug off the missing and unreadable fields",
  summed.input === 1000 &&
    summed.output === 100 &&
    summed.cacheRead === 110 &&
    summed.cacheWrite === 15 &&
    summed.reasoning === 8 &&
    Math.abs(summed.cost - 0.07) < 1e-9 &&
    summed.assistantMessages === 5 &&
    summed.toolCalls === 1,
  JSON.stringify(summed),
);
check(
  "contextTokens is the LAST request, not the sum of them (460, not 1125)",
  summed.contextTokens === 460,
  String(summed.contextTokens),
);

const many = Array.from({ length: 10 }, (_, index) =>
  line({ type: "message", message: { role: index % 2 === 0 ? "user" : "assistant", content: `m${index}` } }),
).join("");
const bounded = parseSession(many, 4);
check(
  "limit reports the messages to omit from the end, and how long the visible tail is",
  bounded.omitted === 6 &&
    bounded.messages.length === 10 &&
    bounded.messages.slice(bounded.omitted).length === 4 &&
    bounded.messages[bounded.omitted].content === "m6",
  JSON.stringify({ omitted: bounded.omitted, messages: bounded.messages.length }),
);
check(
  "a file shorter than the limit omits nothing",
  parseSession(many).omitted === 0 && parseSession(many, 99).omitted === 0,
  String(parseSession(many, 99).omitted),
);
check(
  "the default limit is 40",
  parseSession(Array.from({ length: 45 }, (_, index) =>
    line({ type: "message", message: { role: "user", content: `m${index}` } }),
  ).join("")).omitted === 5,
  "",
);

let emptyThrew = false;
let empty;
try {
  empty = parseSession("");
} catch {
  emptyThrew = true;
}
check(
  "an empty file is no messages, no totals and no throw",
  !emptyThrew &&
    empty.messages.length === 0 &&
    empty.omitted === 0 &&
    empty.totals.input === 0 &&
    empty.totals.cost === 0 &&
    empty.totals.assistantMessages === 0 &&
    empty.totals.contextTokens === 0,
  emptyThrew ? "threw" : JSON.stringify(empty),
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
