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
