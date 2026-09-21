import { ATTACHMENT_LIMITS } from "./attachments";
import { resolveOnPath } from "./runtime";

/**
 * Turns a video into something a model can actually receive.
 *
 * pi accepts text and images and nothing else, so a video cannot be sent: it can
 * only be sampled. What travels is a handful of stills plus a line that says they
 * are stills, because a model handed four frames and no explanation will describe
 * motion it never saw.
 *
 * The whole module is built around one property of ffmpeg that removes every
 * temporary file from the design: a frame can be written to **stdout**, and the
 * probe costs a single call because `ffmpeg -i` prints the duration and the frame
 * size on stderr. Nothing here writes to disk, so nothing here has to clean up.
 *
 * ffmpeg is not bundled with PiCode, so the module also answers "is it here?" and
 * says how to install it when it is not. A feature that quietly does nothing is
 * worse than one that says it cannot work.
 */

/** How a video becomes something a model can receive. */
export interface VideoLimits {
  /**
   * Stills extracted at most. Each one is a separate image on the wire and a
   * separate line on the bill, so this stays small.
   */
  maxFrames: number;
  /** The size refused before anything reads the file. */
  maxBytes: number;
}

export const VIDEO_LIMITS: VideoLimits = {
  // Four frames is enough to describe a screen recording, a short clip or a bug
  // reproduction, and it stays inside the per-message attachment cap, so a video
  // never silently truncates against the image limit.
  maxFrames: 4,
  maxBytes: 64 * 1024 * 1024,
};

/** What ffmpeg reported about a file. */
export interface VideoProbe {
  /** Seconds. */
  duration: number;
  width: number;
  height: number;
}

export type ProbeOutcome = { ok: true; probe: VideoProbe } | { ok: false; reason: string };

/** One still taken from the video, with the moment it was taken from. */
export interface VideoFrame {
  /** Seconds into the video. */
  at: number;
  /** PNG bytes, ready for the image pipeline. */
  bytes: Uint8Array;
}

/** Runs a command and collects its output. Injected so this module needs no ffmpeg to be tested. */
export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: { binary?: boolean },
  ): Promise<{ code: number | null; stdout: Uint8Array; stderr: string }>;
}

/** The PNG signature, which is how a frame is told apart from an error message. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** How to install ffmpeg on each platform, quoted when it is missing. */
export function ffmpegInstallHint(platform: string = process.platform): string {
  if (platform === "win32") {
    return "winget install Gyan.FFmpeg";
  }
  if (platform === "darwin") {
    return "brew install ffmpeg";
  }
  return "instalaciónelo con el gestor de paquetes de tu distribución (apt install ffmpeg, dnf install ffmpeg, pacman -S ffmpeg)";
}

/** Locates ffmpeg: a configured path first, then PATH. */
export function resolveFfmpeg(configured: string): string | undefined {
  const trimmed = configured.trim();
  if (trimmed.length > 0) {
    // A configured path is taken as given when it exists; when it does not, the
    // search falls through to PATH rather than failing, because a stale setting
    // should not be worse than having no setting.
    return resolveOnPath(trimmed) ?? undefined;
  }
  return resolveOnPath("ffmpeg");
}

/** Reads the version, or undefined when the command does not answer with one. */
export async function probeFfmpegVersion(
  runner: CommandRunner,
  ffmpeg: string,
): Promise<string | undefined> {
  // `-version` answers on stdout, unlike `-i`, which reports on stderr. Both are
  // read because a build that answers on the other stream is still answering.
  const result = await runner.run(ffmpeg, ["-version"]);
  const text = `${new TextDecoder().decode(result.stdout)}\n${result.stderr}`;
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
  return line?.trim();
}

/** Parses the seconds out of `Duration: 00:00:03.00`. */
function parseDuration(stderr: string): number | undefined {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (match === null) {
    return undefined;
  }
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** Parses the pixel size out of the first video stream line. */
function parseSize(stderr: string): { width: number; height: number } | undefined {
  for (const line of stderr.split(/\r?\n/)) {
    if (!/\bVideo:\s/.test(line)) {
      continue;
    }
    // `…, 320x240 [SAR 1:1 DAR 4:3], …` — the size sits among comma-separated
    // fields, so it is anchored on the `WxH` shape rather than on a field index.
    const match = /\b(\d{2,5})x(\d{2,5})\b/.exec(line);
    if (match !== null) {
      return { width: Number(match[1]), height: Number(match[2]) };
    }
  }
  return undefined;
}

/**
 * Parses what `ffmpeg -i` prints.
 *
 * Exported because this parsing is the part most likely to break: it reads another
 * program's human-facing output, so it is tested against real ffmpeg text rather
 * than only through the functions that call it.
 */
export function parseProbe(stderr: string): VideoProbe | undefined {
  const duration = parseDuration(stderr);
  const size = parseSize(stderr);
  if (duration === undefined || size === undefined) {
    return undefined;
  }
  return { duration, width: size.width, height: size.height };
}

/** Reads a file's duration and frame size. */
export async function probeVideo(
  runner: CommandRunner,
  ffmpeg: string,
  file: string,
): Promise<ProbeOutcome> {
  // No output file is given on purpose: ffmpeg has nothing to write, so it reports
  // what it found and exits non-zero. That exit code is the expected outcome here,
  // which is why it is not checked.
  const result = await runner.run(ffmpeg, ["-hide_banner", "-i", file]);
  const probe = parseProbe(result.stderr);
  if (probe === undefined) {
    return {
      ok: false,
      reason:
        `ffmpeg no reconoció ${file} como un vídeo con imagen. ` +
        "Comprueba que el archivo no esté dañado y que sea un formato que ffmpeg lea.",
    };
  }
  return { ok: true, probe };
}

/** True when the bytes begin with the PNG signature. */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) {
    return false;
  }
  for (let index = 0; index < PNG_MAGIC.length; index += 1) {
    if (bytes[index] !== PNG_MAGIC[index]) {
      return false;
    }
  }
  return true;
}

/** The moments a video of `duration` seconds is sampled at, given a frame count. */
export function frameTimestamps(duration: number, count: number): number[] {
  const timestamps: number[] = [];
  for (let index = 0; index < count; index += 1) {
    // The middle of each slice, not its edge: the first and last frames of a real
    // video are frequently uniform — a title card, a fade — and would tell a model
    // nothing about what the video shows.
    const at = (duration * (index + 0.5)) / count;
    timestamps.push(Math.min(Math.max(at, 0), Math.max(duration - 0.05, 0)));
  }
  return timestamps;
}

/**
 * Extracts at most `limits.maxFrames` stills, evenly spaced across the video.
 *
 * Sequential on purpose: ffmpeg saturates every core it is given, and a sidebar
 * extraction that runs four of them at once makes the editor stutter for as long
 * as it lasts. Four frames one after another is imperceptible; four at once is not.
 */
export async function extractFrames(
  runner: CommandRunner,
  ffmpeg: string,
  file: string,
  probe: VideoProbe,
  limits: VideoLimits = VIDEO_LIMITS,
): Promise<VideoFrame[]> {
  const count = Math.max(1, Math.min(limits.maxFrames, Math.floor(limits.maxFrames)));
  const frames: VideoFrame[] = [];

  for (const at of frameTimestamps(probe.duration, count)) {
    const result = await runner.run(
      ffmpeg,
      [
        "-v",
        "error",
        "-ss",
        at.toFixed(3),
        "-i",
        file,
        "-frames:v",
        "1",
        "-vf",
        `scale='min(${ATTACHMENT_LIMITS.maxWidth},iw)':-1`,
        "-f",
        "image2",
        "-c:v",
        "png",
        "pipe:1",
      ],
      { binary: true },
    );

    // A frame that did not come back as an image is skipped rather than failing the
    // video: one unreadable moment is not a reason to refuse the other three. This
    // is also what catches an ffmpeg that printed a warning where an image belonged.
    if (isPng(result.stdout)) {
      frames.push({ at, bytes: result.stdout });
    }
  }

  return frames;
}

/** Formats a timestamp the way the note reads it: `0:01.1`. */
function formatTimestamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

/**
 * One line telling the model what it received.
 *
 * It says the frames are stills because that is the single fact a model cannot
 * infer from them: four images in a message look like four photos, and a reply
 * that describes what happens between them would be invented.
 */
export function formatVideoNote(
  frames: readonly VideoFrame[],
  probe: VideoProbe,
  file: string,
): string {
  const name = file.split(/[\\/]/).pop() ?? file;
  const when = frames.map((frame) => formatTimestamp(frame.at)).join(", ");
  const many = frames.length === 1 ? "1 fotograma extraído" : `${frames.length} fotogramas extraídos`;
  return (
    `[Vídeo adjunto: ${name}, ${probe.duration.toFixed(1).replace(".", ",")} s, ` +
    `${many} en ${when}. Son imágenes fijas, no el vídeo.]`
  );
}
