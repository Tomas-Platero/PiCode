/*
 * Exercises turning a video into stills.
 *
 * A video cannot be sent: pi takes text and images and nothing else, so what
 * travels is a handful of frames from ffmpeg plus one line that says they are
 * stills. Both halves are a contract. The model must be told what it received, or
 * it will describe motion it never saw; and the command line is the entire
 * interface with ffmpeg, so an argument that drifts changes what is extracted
 * without changing anything that would fail visibly here.
 *
 * ffmpeg is a dependency of the feature, not of its tests: every run below goes
 * through a fake `CommandRunner`, including the malformed frame and the file with
 * no video stream, so the suite is hermetic and no binary is needed.
 *
 * video.ts reaches `vscode` indirectly (through runtime.ts, for PATH resolution),
 * stubbed through a hook so the pure half can be checked here.
 *
 * Run with: npm test
 */
const path = require("node:path");
const { existsSync } = require("node:fs");
const Module = require("node:module");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "vscode-stub.js");
  }
  return originalResolve.call(this, request, ...rest);
};

const {
  extractFrames,
  formatVideoNote,
  frameTimestamps,
  isPng,
  parseProbe,
  probeVideo,
  resolveFfmpeg,
  VIDEO_LIMITS,
} = require("../out/video.js");
const { ATTACHMENT_LIMITS } = require("../out/attachments.js");
const { resolveOnPath } = require("../out/runtime.js");

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** What real ffmpeg printed for a 3-second, 320×240 clip. */
const DURATION_LINE = "  Duration: 00:00:03.00, start: 0.000000, bitrate: 38 kb/s";
const VIDEO_STREAM =
  "    Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), " +
  "yuv420p(progressive), 320x240 [SAR 1:1 DAR 4:3], 34 kb/s, 10 fps,";
const PROBE_TEXT = `${DURATION_LINE}\n${VIDEO_STREAM}`;

const AUDIO_ONLY = `${DURATION_LINE}\n    Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 96 kb/s`;
const NO_DURATION = `  Duration: N/A, start: 0.000000, bitrate: N/A\n${VIDEO_STREAM}`;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A minimal well-formed signature: all the frame gate looks at. */
const pngBytes = (marker = 0) => Uint8Array.from([...PNG_MAGIC, marker]);

/** Something ffmpeg could print where a frame was expected. */
const notPng = () => Uint8Array.from([0x41, 0x42, 0x43, 0x44]);

const VIDEO_FILE = "C:\\clips\\demo.mp4";
const PROBE = { duration: 3, width: 320, height: 240 };

const emptyBytes = () => new Uint8Array(0);

/**
 * A structural `CommandRunner` that spawns nothing.
 *
 * The handler sees the call and its 1-based number, which is how a per-frame
 * answer is expressed without any state outside the fake.
 */
function createFakeRunner(handler) {
  const calls = [];
  const runner = {
    async run(command, args, options) {
      const call = { command, args: [...args], options };
      calls.push(call);
      return handler(call, calls.length);
    },
  };
  return { runner, calls };
}

/**
 * The exact command line a still is taken with.
 *
 * Written out in full on purpose: the filter, the frame count and the PNG writer
 * are the contract with ffmpeg, and a change to any of them has to show up as a
 * failing check rather than as a silent difference in what a model receives.
 */
function frameArgs(at, file) {
  return [
    "-v",
    "error",
    "-ss",
    at,
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    "scale='min(1568,iw)':-1",
    "-f",
    "image2",
    "-c:v",
    "png",
    "pipe:1",
  ];
}

async function main() {
  /* ---------------------------------------------------------------- *
   * parseProbe
   * ---------------------------------------------------------------- */

  const probe = parseProbe(PROBE_TEXT);
  check(
    "a real ffmpeg probe reports its duration and its frame size",
    probe !== undefined && probe.duration === 3 && probe.width === 320 && probe.height === 240,
    JSON.stringify(probe),
  );
  check(
    "the size comes from the video stream, not from another stream's numbers",
    probe !== undefined && probe.width === 320 && probe.height === 240,
    JSON.stringify(probe),
  );

  const unreadable = [
    ["a duration ffmpeg could not read", NO_DURATION],
    ["an audio-only file", AUDIO_ONLY],
    ["empty input", ""],
  ];
  for (const [label, text] of unreadable) {
    const outcome = parseProbe(text);
    check(`parseProbe returns nothing for ${label}`, outcome === undefined, JSON.stringify(outcome));
  }

  const everyProbe = [probe, parseProbe(NO_DURATION), parseProbe(AUDIO_ONLY), parseProbe("")];
  check(
    "a probe never carries NaN in place of a number it could not read",
    everyProbe.every(
      (entry) =>
        entry === undefined ||
        (Number.isFinite(entry.duration) &&
          Number.isFinite(entry.width) &&
          Number.isFinite(entry.height)),
    ),
    JSON.stringify(everyProbe),
  );

  /* ---------------------------------------------------------------- *
   * probeVideo
   * ---------------------------------------------------------------- */

  {
    const { runner, calls } = createFakeRunner(() => ({
      code: 1,
      stdout: emptyBytes(),
      stderr: PROBE_TEXT,
    }));
    const outcome = await probeVideo(runner, "ffmpeg", VIDEO_FILE);
    check(
      "a non-zero exit that still printed a probe is a success",
      outcome.ok === true && outcome.probe.duration === 3 && outcome.probe.width === 320,
      JSON.stringify(outcome),
    );
    check(
      "the probe is one call that gives ffmpeg nothing to write",
      calls.length === 1 && calls[0].args.join(" ") === `-hide_banner -i ${VIDEO_FILE}`,
      JSON.stringify(calls[0] && calls[0].args),
    );
  }

  {
    const { runner } = createFakeRunner(() => ({
      code: 1,
      stdout: emptyBytes(),
      stderr: "",
    }));
    const outcome = await probeVideo(runner, "ffmpeg", VIDEO_FILE);
    check(
      "an empty answer is refused with a reason that names the file",
      outcome.ok === false &&
        typeof outcome.reason === "string" &&
        outcome.reason.includes("demo.mp4") &&
        !outcome.reason.includes("undefined"),
      JSON.stringify(outcome),
    );
  }

  {
    const { runner } = createFakeRunner(() => ({
      code: 1,
      stdout: emptyBytes(),
      stderr: AUDIO_ONLY,
    }));
    const outcome = await probeVideo(runner, "ffmpeg", VIDEO_FILE);
    check(
      "a file with no video stream is refused, not probed as something it is not",
      outcome.ok === false && typeof outcome.reason === "string" && outcome.reason.length > 0,
      JSON.stringify(outcome),
    );
  }

  /* ---------------------------------------------------------------- *
   * extractFrames
   * ---------------------------------------------------------------- */

  const twoFrames = { maxFrames: 2, maxBytes: VIDEO_LIMITS.maxBytes };

  {
    const { runner, calls } = createFakeRunner((_call, index) => ({
      code: 0,
      stdout: pngBytes(index),
      stderr: "",
    }));
    const frames = await extractFrames(runner, "ffmpeg", VIDEO_FILE, PROBE, twoFrames);

    check("two stills are extracted", frames.length === 2, `frames=${frames.length}`);
    check(
      "the first frame is taken with exactly the extraction command line",
      JSON.stringify(calls[0].args) === JSON.stringify(frameArgs("0.750", VIDEO_FILE)),
      JSON.stringify(calls[0].args),
    );
    check(
      "the filter scales to the attachment width, not to a number of its own",
      calls[0].args.includes(`scale='min(${ATTACHMENT_LIMITS.maxWidth},iw)':-1`),
      JSON.stringify(calls[0].args),
    );
    check(
      "the second frame is taken at the middle of the second half",
      JSON.stringify(calls[1].args) === JSON.stringify(frameArgs("2.250", VIDEO_FILE)),
      JSON.stringify(calls[1].args),
    );
    check(
      "the frame is read as binary, so the bytes are not mangled by a text stream",
      calls.every((call) => call.options !== undefined && call.options.binary === true),
      JSON.stringify(calls.map((call) => call.options)),
    );
    check(
      "each still carries the moment it was taken from and the bytes ffmpeg wrote",
      frames[0].at === 0.75 &&
        frames[1].at === 2.25 &&
        frames[0].bytes[8] === 1 &&
        frames[1].bytes[8] === 2,
      JSON.stringify(frames.map((frame) => frame.at)),
    );
  }

  {
    const { runner, calls } = createFakeRunner(() => ({
      code: 0,
      stdout: pngBytes(1),
      stderr: "",
    }));
    const frames = await extractFrames(runner, "ffmpeg", VIDEO_FILE, PROBE);
    check(
      "without limits the module's own cap decides how many stills are taken",
      calls.length === VIDEO_LIMITS.maxFrames && frames.length === VIDEO_LIMITS.maxFrames,
      `calls=${calls.length} frames=${frames.length}`,
    );
  }

  {
    const { runner } = createFakeRunner((_call, index) =>
      index === 2
        ? { code: 0, stdout: notPng(), stderr: "" }
        : { code: 0, stdout: pngBytes(index), stderr: "" },
    );
    const frames = await extractFrames(runner, "ffmpeg", VIDEO_FILE, PROBE, {
      maxFrames: 4,
      maxBytes: VIDEO_LIMITS.maxBytes,
    });
    check(
      "a frame whose bytes are not a PNG is skipped rather than kept",
      frames.length === 3 && !frames.some((frame) => frame.at === 1.125),
      JSON.stringify(frames.map((frame) => frame.at)),
    );
    check(
      "the stills that did come back keep their own moments",
      JSON.stringify(frames.map((frame) => frame.at)) === JSON.stringify([0.375, 1.875, 2.625]),
      JSON.stringify(frames.map((frame) => frame.at)),
    );
  }

  {
    const { runner } = createFakeRunner(() => ({
      code: 0,
      stdout: notPng(),
      stderr: "",
    }));
    let frames;
    let threw = false;
    try {
      frames = await extractFrames(runner, "ffmpeg", VIDEO_FILE, PROBE, twoFrames);
    } catch (error) {
      threw = true;
      frames = error;
    }
    check(
      "a run where every frame is malformed returns nothing instead of throwing",
      threw === false && Array.isArray(frames) && frames.length === 0,
      String(frames),
    );
  }

  {
    const events = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const { runner } = createFakeRunner(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      events.push("start");
      // A real macrotask, so a second extraction launched at the same time would
      // overlap here instead of hiding behind a resolved promise.
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      events.push("end");
      return { code: 0, stdout: pngBytes(1), stderr: "" };
    });
    const frames = await extractFrames(runner, "ffmpeg", VIDEO_FILE, PROBE, twoFrames);
    check(
      "stills are extracted one after another, never at once",
      maxInFlight === 1 && frames.length === 2,
      `maxInFlight=${maxInFlight} frames=${frames.length}`,
    );
    check(
      "the second extraction starts only after the first has finished",
      events.join(",") === "start,end,start,end",
      events.join(","),
    );
  }

  /* ---------------------------------------------------------------- *
   * Timestamps
   * ---------------------------------------------------------------- */

  {
    const timestamps = frameTimestamps(3, 4);
    check(
      "timestamps are the middles of the slices",
      JSON.stringify(timestamps) === JSON.stringify([0.375, 1.125, 1.875, 2.625]),
      JSON.stringify(timestamps),
    );
    check(
      "each timestamp is the middle of its own slice, not an edge",
      timestamps.every((at, index) => Math.abs(at - (3 * (index + 0.5)) / 4) < 1e-9),
      JSON.stringify(timestamps),
    );
    check(
      "timestamps are strictly increasing",
      timestamps.every((at, index) => index === 0 || at > timestamps[index - 1]),
      JSON.stringify(timestamps),
    );
    check(
      "no timestamp sits at or past the end of the video",
      timestamps.every((at) => at > 0 && at < 3),
      JSON.stringify(timestamps),
    );

    const long = frameTimestamps(3600, 4);
    check(
      "an hour-long video still never reaches its own end",
      long.length === 4 && long.every((at) => at > 0 && at < 3600),
      JSON.stringify(long),
    );
  }

  /* ---------------------------------------------------------------- *
   * isPng
   * ---------------------------------------------------------------- */

  check(
    "the PNG signature is what tells a frame apart from an error message",
    isPng(pngBytes(1)) === true && isPng(notPng()) === false && isPng(new Uint8Array(3)) === false,
    "",
  );

  /* ---------------------------------------------------------------- *
   * formatVideoNote
   * ---------------------------------------------------------------- */

  {
    const note = formatVideoNote(
      [
        { at: 0.5, bytes: pngBytes(1) },
        { at: 1.5, bytes: pngBytes(2) },
      ],
      PROBE,
      VIDEO_FILE,
    );
    check("the note names the file", note.includes("demo.mp4"), note);
    check("the note does not leak the path", !note.includes("C:\\clips"), note);
    check("the note carries the duration", note.includes("3,0 s"), note);
    check("the note carries the frame count", note.includes("2 fotogramas extraídos"), note);
    check(
      "the note carries every timestamp",
      note.includes("0:00.5") && note.includes("0:01.5"),
      note,
    );
    check("the note says the frames are stills", note.includes("imágenes fijas"), note);

    const single = formatVideoNote([{ at: 1.5, bytes: pngBytes(1) }], PROBE, "demo.mp4");
    check(
      "one frame is announced in the singular",
      single.includes("1 fotograma extraído") && !single.includes("fotogramas"),
      single,
    );
  }

  /* ---------------------------------------------------------------- *
   * resolveFfmpeg
   * ---------------------------------------------------------------- */

  {
    const onPath = resolveOnPath("ffmpeg");
    check(
      "an empty setting looks for ffmpeg on PATH",
      resolveFfmpeg("") === onPath,
      `"" -> ${resolveFfmpeg("")} ; PATH -> ${onPath}`,
    );
    check(
      "a configured bare name is resolved through PATH",
      resolveFfmpeg("ffmpeg") === onPath,
      `"ffmpeg" -> ${resolveFfmpeg("ffmpeg")} ; PATH -> ${onPath}`,
    );

    // The configured path is taken as given only when it exists. When it does not,
    // resolution does not fail: it yields nothing, so the caller reports "no ffmpeg
    // found" with the install command instead of handing `spawn` a path that will
    // fail for a reason the owner cannot see.
    const missing = "C:\\no-such-dir-picode\\ffmpeg.exe";
    let resolved;
    let threw = false;
    try {
      resolved = resolveFfmpeg(missing);
    } catch (error) {
      threw = true;
      resolved = error;
    }
    check(
      "a configured path that does not exist does not throw",
      threw === false,
      String(resolved),
    );
    check(
      "a configured path that does not exist is never handed back as if it were valid",
      threw === false && resolved !== missing && (resolved === undefined || existsSync(resolved)),
      `missing -> ${String(resolved)}`,
    );
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
  console.error("video checks failed:", error);
  process.exit(2);
});
