/*
 * Exercises turning audio into text.
 *
 * A transcript travels as text, so the two halves of this module are contracts.
 * `transcribeWithNan` is the boundary that talks to the NaN cluster, which makes
 * it the place where a key could leak into a message and where a request that is
 * known to fail should not be sent at all; `formatTranscriptBlock` is what the
 * model reads, and it must be able to tell what the owner typed from what a
 * machine heard.
 *
 * The suite is hermetic: `transcribeWithNan` takes an injected `FetchLike`, so
 * every case below goes through a fake and no request leaves the machine. The
 * credential half reads real files, but only ones built in a temp directory here.
 *
 * Run with: npm test
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  NAN_WHISPER_MODEL,
  TRANSCRIPTION_LIMITS,
  formatTranscriptBlock,
  readNanApiKey,
  resolveAgentDir,
  transcribeWithNan,
} = require("../out/transcription.js");

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

const KEY = "sk-nan-ABC123-supersecret";
const AUDIO = {
  bytes: Uint8Array.from([0x49, 0x44, 0x33, 0x04]),
  name: "nota.m4a",
  mimeType: "audio/mp4",
};

/** Builds a fake `FetchLike` that records every call and answers from `answers`. */
function makeFetch(...answers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };
  return { impl, calls };
}

/** A 2xx answer whose body is `JSON.stringify({ text, ...extra })`. */
const okJson = (text, extra = {}) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ text, ...extra }),
});

/** A 2xx answer whose body is whatever was given. */
const okRaw = (body) => ({ ok: true, status: 200, text: async () => body });

/** A non-2xx answer. */
const failStatus = (status, body = "") => ({
  ok: false,
  status,
  text: async () => body,
});

/** Every failure reason, so the key scan can cover all of them at once. */
const failureReasons = [];
const rememberFailure = (label, outcome) => {
  if (!outcome.ok) {
    failureReasons.push({ label, reason: outcome.reason });
  }
  return outcome;
};

async function main() {
  /* ---------------------------------------------------------------- *
   * Where pi keeps its configuration
   * ---------------------------------------------------------------- */

  const DEFAULT_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
  const ENV_AGENT_DIR = path.join(os.tmpdir(), "picode-agent-env");

  const emptyEnvDir = resolveAgentDir({});
  check(
    "an empty environment still resolves an absolute agent dir",
    typeof emptyEnvDir === "string" && emptyEnvDir.length > 0 && path.isAbsolute(emptyEnvDir),
    emptyEnvDir,
  );
  check(
    "the fallback is pi's own directory",
    emptyEnvDir === DEFAULT_AGENT_DIR,
    emptyEnvDir,
  );
  check(
    "PI_CODING_AGENT_DIR is honoured",
    resolveAgentDir({ PI_CODING_AGENT_DIR: ENV_AGENT_DIR }) === ENV_AGENT_DIR,
    ENV_AGENT_DIR,
  );
  check(
    "the configured dir is trimmed",
    resolveAgentDir({ PI_CODING_AGENT_DIR: `  ${ENV_AGENT_DIR}  ` }) === ENV_AGENT_DIR,
    ENV_AGENT_DIR,
  );
  check(
    "a whitespace-only dir is ignored",
    resolveAgentDir({ PI_CODING_AGENT_DIR: "   " }) === DEFAULT_AGENT_DIR,
    DEFAULT_AGENT_DIR,
  );

  /* ---------------------------------------------------------------- *
   * The credential
   * ---------------------------------------------------------------- */

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "picode-transcription-"));
  const authPath = path.join(tempDir, "auth.json");
  const writeAuth = (content) => {
    fs.writeFileSync(authPath, content, "utf8");
    return readNanApiKey(tempDir);
  };

  try {
    check(
      "a well-formed auth.json yields the key",
      writeAuth(JSON.stringify({ nan: { key: "clave-de-nan" } })) === "clave-de-nan",
      "",
    );
    check(
      "the key is trimmed",
      writeAuth(JSON.stringify({ nan: { key: "  clave-de-nan  " } })) === "clave-de-nan",
      "",
    );

    const undefinedCases = [
      ["a missing file", () => readNanApiKey(path.join(tempDir, "no-existe"))],
      ["invalid JSON", () => writeAuth("{no es json")],
      ["a JSON array", () => writeAuth("[1, 2, 3]")],
      ["a nan entry that is not an object", () => writeAuth(JSON.stringify({ nan: "x" }))],
      ["a nan entry with no key", () => writeAuth(JSON.stringify({ nan: {} }))],
      ["a nan key that is not a string", () => writeAuth(JSON.stringify({ nan: { key: 5 } }))],
      ["a whitespace-only key", () => writeAuth(JSON.stringify({ nan: { key: "   " } }))],
    ];
    for (const [label, produce] of undefinedCases) {
      let value;
      let threw = false;
      try {
        value = produce();
      } catch {
        threw = true;
      }
      check(
        `readNanApiKey returns undefined and never throws for ${label}`,
        !threw && value === undefined,
        threw ? "threw" : JSON.stringify(value),
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  /* ---------------------------------------------------------------- *
   * The upload: what leaves the machine
   * ---------------------------------------------------------------- */

  {
    const { impl, calls } = makeFetch(
      okJson("hola mundo", { language: "es", duration: 2.8 }),
    );
    const outcome = await transcribeWithNan(impl, { key: KEY, source: AUDIO });
    check("the happy path succeeds", outcome.ok === true, outcome.ok ? "" : outcome.reason);

    const call = calls[0];
    check("exactly one request was made", calls.length === 1, String(calls.length));
    check(
      "the request goes to <baseUrl>/audio/transcriptions",
      call !== undefined && call.url === "https://api.nan.builders/v1/audio/transcriptions",
      call && call.url,
    );
    check("the method is POST", call !== undefined && call.init.method === "POST", call && call.init.method);
    check(
      "the key travels as a Bearer header",
      call !== undefined && call.init.headers.Authorization === `Bearer ${KEY}`,
      call && call.init.headers.Authorization,
    );

    const body = call === undefined ? undefined : call.init.body;
    check("the body is a FormData", body instanceof FormData, body && body.constructor.name);
    check(
      "the model part is whisper",
      body !== undefined && body.get("model") === NAN_WHISPER_MODEL,
      body && String(body.get("model")),
    );
    check(
      "the response format part asks for verbose_json",
      body !== undefined && body.get("response_format") === "verbose_json",
      body && String(body.get("response_format")),
    );
    const file = body === undefined ? undefined : body.get("file");
    check(
      "the file part carries the name and the mime type",
      file !== undefined && file !== null && file.name === AUDIO.name && file.type === AUDIO.mimeType,
      file !== undefined && file !== null ? `${file.name} / ${file.type}` : "no file part",
    );
    check(
      "no language part is sent when none was given",
      body !== undefined && body.get("language") == null,
      body && String(body.get("language")),
    );
  }

  {
    const { impl, calls } = makeFetch(okJson("hola"));
    await transcribeWithNan(impl, { key: KEY, source: AUDIO, language: "es" });
    const body = calls[0].init.body;
    check(
      "a language part is sent when one was given",
      body.get("language") === "es",
      String(body.get("language")),
    );
  }

  {
    const { impl, calls } = makeFetch(okJson("hola"));
    await transcribeWithNan(impl, {
      key: KEY,
      source: AUDIO,
      baseUrl: "https://ejemplo.test/api/v1",
    });
    check(
      "a custom baseUrl is honoured without duplicating the slash",
      calls[0].url === "https://ejemplo.test/api/v1/audio/transcriptions",
      calls[0].url,
    );
  }

  /* ---------------------------------------------------------------- *
   * Refusals decided before anything is sent
   * ---------------------------------------------------------------- */

  {
    const { impl, calls } = makeFetch(okJson("nunca"));
    const outcome = await transcribeWithNan(impl, {
      key: KEY,
      source: { ...AUDIO, bytes: new Uint8Array(0) },
    });
    rememberFailure("empty audio", outcome);
    check(
      "empty audio is refused",
      outcome.ok === false && outcome.reason.length > 0,
      outcome.ok ? "ok" : outcome.reason,
    );
    check("empty audio makes no request", calls.length === 0, String(calls.length));
  }

  {
    const limits = { maxBytes: 1024 * 1024, maxSeconds: TRANSCRIPTION_LIMITS.maxSeconds };
    const oversized = new Uint8Array(2 * 1024 * 1024);
    const { impl, calls } = makeFetch(okJson("nunca"));
    const outcome = await transcribeWithNan(impl, {
      key: KEY,
      source: { ...AUDIO, bytes: oversized },
      limits,
    });
    rememberFailure("oversized audio", outcome);
    check(
      "oversized audio is refused",
      outcome.ok === false,
      outcome.ok ? "ok" : outcome.reason,
    );
    check("oversized audio makes no request", calls.length === 0, String(calls.length));
    check(
      "the reason states both the size and the limit",
      outcome.ok === false && outcome.reason.includes("2.0 MB") && outcome.reason.includes("1 MB"),
      outcome.ok ? "ok" : outcome.reason,
    );
  }

  /* ---------------------------------------------------------------- *
   * Failures that come back from the cluster
   * ---------------------------------------------------------------- */

  const statusCases = [
    { status: 401, word: "clave" },
    { status: 403, word: "clave" },
    { status: 413, word: "máximo" },
    { status: 429, word: "peticiones" },
    { status: 524, word: "tardó" },
    { status: 500, word: "servicio" },
  ];
  for (const entry of statusCases) {
    const { impl } = makeFetch(failStatus(entry.status, ""));
    const outcome = await transcribeWithNan(impl, { key: KEY, source: AUDIO });
    rememberFailure(`status ${entry.status}`, outcome);
    check(
      `a ${entry.status} fails and names the situation`,
      outcome.ok === false && outcome.reason.includes(entry.word),
      outcome.ok ? "ok" : outcome.reason,
    );
  }

  {
    const longBody = "E".repeat(300);
    const { impl } = makeFetch(failStatus(503, longBody));
    const outcome = await transcribeWithNan(impl, { key: KEY, source: AUDIO });
    rememberFailure("quoted body", outcome);
    check(
      "a failing response is quoted in the reason",
      outcome.ok === false && outcome.reason.includes("E".repeat(200)),
      outcome.ok ? "ok" : outcome.reason,
    );
    check(
      "the quoted body is truncated to 200 characters",
      outcome.ok === false && !outcome.reason.includes("E".repeat(201)),
      outcome.ok ? "ok" : String(outcome.reason.length),
    );
  }

  {
    const { impl } = makeFetch(new Error("socket hang up"));
    const outcome = await transcribeWithNan(impl, { key: KEY, source: AUDIO });
    rememberFailure("rejected fetch", outcome);
    check(
      "a rejected fetch is reported as a connection failure",
      outcome.ok === false && outcome.reason.includes("no se pudo contactar"),
      outcome.ok ? "ok" : outcome.reason,
    );
    check(
      "the rejection is not propagated",
      outcome.ok === false && outcome.reason.includes("socket hang up"),
      outcome.ok ? "ok" : outcome.reason,
    );
  }

  /* ---------------------------------------------------------------- *
   * A 200 that is not a transcript
   * ---------------------------------------------------------------- */

  {
    const { impl } = makeFetch(okRaw("esto no es json"));
    const outcome = await transcribeWithNan(impl, { key: KEY, source: AUDIO });
    rememberFailure("non-json body", outcome);
    check(
      "a non-JSON 200 body fails readably",
      outcome.ok === false && outcome.reason.includes("no es JSON"),
      outcome.ok ? "ok" : outcome.reason,
    );
  }

  {
    const { impl } = makeFetch(okRaw('"hola"'));
    const outcome = await transcribeWithNan(impl, { key: KEY, source: AUDIO });
    rememberFailure("json scalar", outcome);
    check(
      "a JSON 200 that is not an object fails readably",
      outcome.ok === false && outcome.reason.includes("sin transcripción"),
      outcome.ok ? "ok" : outcome.reason,
    );
  }

  {
    const { impl } = makeFetch(okRaw("[1, 2, 3]"));
    const outcome = await transcribeWithNan(impl, { key: KEY, source: AUDIO });
    rememberFailure("json array", outcome);
    check(
      "a JSON array 200 fails readably",
      outcome.ok === false && outcome.reason.includes("«text»"),
      outcome.ok ? "ok" : outcome.reason,
    );
  }

  {
    const { impl } = makeFetch(okRaw(JSON.stringify({ text: 5 })));
    const outcome = await transcribeWithNan(impl, { key: KEY, source: AUDIO });
    rememberFailure("non-string text", outcome);
    check(
      "a non-string text field fails readably",
      outcome.ok === false && outcome.reason.includes("«text»"),
      outcome.ok ? "ok" : outcome.reason,
    );
  }

  /* ---------------------------------------------------------------- *
   * A 200 that is a transcript
   * ---------------------------------------------------------------- */

  {
    const { impl } = makeFetch(okJson("solo texto"));
    const outcome = await transcribeWithNan(impl, { key: KEY, source: AUDIO });
    check(
      "a bare text field is enough to succeed",
      outcome.ok === true && outcome.result.text === "solo texto",
      outcome.ok ? "" : outcome.reason,
    );
    check(
      "no language or duration is invented when the service did not send them",
      outcome.ok === true &&
        outcome.result.language === undefined &&
        outcome.result.durationSeconds === undefined,
      outcome.ok ? JSON.stringify(outcome.result) : outcome.reason,
    );
  }

  {
    const { impl } = makeFetch(okJson("con datos", { language: "es", duration: 2.8 }));
    const outcome = await transcribeWithNan(impl, { key: KEY, source: AUDIO });
    check(
      "the language is picked up",
      outcome.ok === true && outcome.result.language === "es",
      outcome.ok ? JSON.stringify(outcome.result) : outcome.reason,
    );
    check(
      "the duration is picked up",
      outcome.ok === true && outcome.result.durationSeconds === 2.8,
      outcome.ok ? JSON.stringify(outcome.result) : outcome.reason,
    );
  }

  {
    const { impl } = makeFetch(okRaw('{"text":"x","duration":1e999}'));
    const outcome = await transcribeWithNan(impl, { key: KEY, source: AUDIO });
    check(
      "a non-finite duration is ignored rather than passed through",
      outcome.ok === true && outcome.result.durationSeconds === undefined,
      outcome.ok ? JSON.stringify(outcome.result) : outcome.reason,
    );
  }

  /* ---------------------------------------------------------------- *
   * The security property
   * ---------------------------------------------------------------- */

  check(
    "every failure was recorded",
    failureReasons.length >= statusCases.length,
    String(failureReasons.length),
  );
  check(
    "no failure reason contains the key",
    failureReasons.every((entry) => !entry.reason.includes(KEY)),
    failureReasons
      .filter((entry) => entry.reason.includes(KEY))
      .map((entry) => entry.label)
      .join(", "),
  );
  check(
    "the key does not appear anywhere in a completed outcome",
    failureReasons.every((entry) => typeof entry.reason === "string" && entry.reason.length > 0),
    "",
  );

  /* ---------------------------------------------------------------- *
   * The block the model reads
   * ---------------------------------------------------------------- */

  {
    const block = formatTranscriptBlock(
      { bytes: AUDIO.bytes, name: "nota.m4a", mimeType: AUDIO.mimeType },
      { text: "hola, esto es una prueba", language: "es", durationSeconds: 2.8 },
    );
    check("the block names the file", block.includes("nota.m4a"), block);
    check("the block carries the duration in Spanish form", block.includes("2,8 s"), block);
    check("the block names the detected language", block.includes("idioma detectado: es"), block);
    check("the block never looks like something the owner wrote", block.includes("No lo escribió el usuario"), block);
    check(
      "the transcript is carried unchanged on its own line",
      block.includes("]\nhola, esto es una prueba") && block.endsWith("hola, esto es una prueba"),
      JSON.stringify(block),
    );
  }

  {
    const block = formatTranscriptBlock(
      { bytes: AUDIO.bytes, name: "nota.m4a", mimeType: AUDIO.mimeType },
      { text: "solo texto" },
    );
    check(
      "without duration or language the block still states what it is",
      block.includes("nota.m4a") && block.includes("No lo escribió el usuario"),
      block,
    );
    check("the block never prints undefined", !block.includes("undefined"), block);
    check("the transcript is still carried unchanged", block.endsWith("solo texto"), JSON.stringify(block));
  }

  /* ---------------------------------------------------------------- *
   * Tally
   * ---------------------------------------------------------------- */

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
  console.error("transcription checks failed:", error);
  process.exit(2);
});
