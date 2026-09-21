import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

/**
 * Turns an audio attachment into text.
 *
 * pi accepts text and images and nothing else — there is no audio content type
 * anywhere in its types — so an audio file cannot be sent, only transcribed. The
 * transcript then travels as text, and it travels **labelled**, because text the
 * owner did not type must never look like text the owner typed.
 *
 * The default backend is the NaN cluster's whisper, which needs no binary and
 * whose key is already in the owner's `auth.json`. That has a consequence the
 * setting states plainly rather than implying: **the audio leaves the machine.**
 * A local backend exists for the same reason and is not implemented yet, because
 * shipping a path that cannot be verified on any machine here would be a guess
 * dressed as a feature.
 */

/** The NaN cluster's OpenAI-compatible base URL. */
export const NAN_BASE_URL = "https://api.nan.builders/v1";

/** The model id NaN serves whisper under. */
export const NAN_WHISPER_MODEL = "whisper";

/** Which backend transcribes. */
export type TranscriptionBackend = "nan" | "local" | "off";

export interface TranscriptionLimits {
  /** The largest file NaN accepts in one request. */
  maxBytes: number;
  /**
   * Roughly where the cluster starts timing out. whisper runs on CPU at about
   * real time there, so a long recording is cut off by the proxy before it
   * finishes and comes back as a 524 rather than a transcript.
   */
  maxSeconds: number;
}

export const TRANSCRIPTION_LIMITS: TranscriptionLimits = {
  maxBytes: 25 * 1024 * 1024,
  maxSeconds: 120,
};

/** What a transcription produced. */
export interface TranscriptResult {
  text: string;
  language?: string;
  durationSeconds?: number;
}

export type TranscriptionOutcome =
  | { ok: true; result: TranscriptResult }
  | { ok: false; reason: string };

/** The parts of `fetch` this module uses. Injected so the tests make no request. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: unknown;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * The upload types, declared here rather than taken from `lib.dom`.
 *
 * The extension compiles against `lib: ["ES2022"]`, so `fetch`, `FormData` and
 * `Blob` have no types even though Node has provided them since v18. Declaring the
 * three members actually used keeps the compiler config alone instead of widening
 * it for the whole project.
 */
interface UploadRuntime {
  fetch: FetchLike;
  FormData: new () => {
    append(name: string, value: unknown, fileName?: string): void;
  };
  Blob: new (parts: readonly Uint8Array[], options?: { type?: string }) => unknown;
}

function uploadRuntime(): UploadRuntime {
  // SAFETY: Node provides `fetch`, `FormData` and `Blob` as globals, so `globalThis`
  // is where the three functions actually live at runtime. The double assertion is
  // unavoidable: nothing declares those members merged with `globalThis` under
  // `lib: ["ES2022"]`, so there is no single cast that proves `UploadRuntime`.
  // `hasUploadSupport()` checks all three with `typeof` before anything is
  // constructed, and every caller gates on it, which is what makes this safe rather
  // than merely convenient.
  return globalThis as unknown as UploadRuntime;
}

/** True when this process can upload at all, which is what a missing fetch would mean. */
export function hasUploadSupport(): boolean {
  const runtime = uploadRuntime();
  return (
    typeof runtime.fetch === "function" &&
    typeof runtime.FormData === "function" &&
    typeof runtime.Blob === "function"
  );
}

/**
 * Where pi keeps its configuration.
 *
 * Read from the environment rather than by loading pi: the env var is documented
 * and stable, while importing the SDK only to ask for a directory would pull a
 * whole agent into a path that just wants a file name.
 */
export function resolveAgentDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  return path.join(homedir(), ".pi", "agent");
}

/**
 * The NaN API key from the owner's `auth.json`, or undefined.
 *
 * Never throws: a missing or malformed credential is a reason the feature cannot
 * run, and the caller reports that in words. The key is returned to the caller and
 * appears in no message this module builds, including every failure below — a
 * credential in an error string ends up in a log.
 */
export function readNanApiKey(agentDir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(agentDir, "auth.json"), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const entry = (parsed as Record<string, unknown>).nan;
    if (typeof entry !== "object" || entry === null) {
      return undefined;
    }
    const record = entry as Record<string, unknown>;
    const key = record.key;
    return typeof key === "string" && key.trim().length > 0 ? key.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** What a caller hands to a transcribing backend. */
export interface AudioSource {
  bytes: Uint8Array;
  /** Used for the multipart filename, which is what the cluster sees. */
  name: string;
  mimeType: string;
}

/**
 * A readable reason for an HTTP status, without echoing anything secret.
 *
 * The statuses are named rather than numbered because each one sends the owner
 * somewhere different: a 401 is a key problem, a 413 is a file problem and a 524
 * is a duration problem, and "request failed" would send them nowhere.
 */
function describeStatus(status: number, body: string): string {
  const snippet = body.trim().slice(0, 200);
  const detail = snippet.length > 0 ? ` Respuesta: ${snippet}` : "";
  switch (status) {
    case 401:
    case 403:
      return (
        "el clúster rechazó la clave de NaN. Comprueba que siga siendo válida y que " +
        "tu plan incluya whisper." + detail
      );
    case 413:
      return `el archivo supera el máximo de ${Math.round(TRANSCRIPTION_LIMITS.maxBytes / (1024 * 1024))} MB.${detail}`;
    case 429:
      return `demasiadas peticiones seguidas; vuelve a intentarlo en un momento.${detail}`;
    case 524:
    case 504:
      return (
        "el clúster tardó demasiado. whisper corre a velocidad parecida al tiempo real, " +
        `así que un audio de más de ${TRANSCRIPTION_LIMITS.maxSeconds} s conviene partirlo.` + detail
      );
    default:
      return `el servicio respondió ${status}.${detail}`;
  }
}

/**
 * Transcribes one file with the NaN cluster's whisper.
 *
 * The limits are checked here rather than only in the UI because this is the
 * boundary that actually talks to the service, and a request that is known to fail
 * should not be sent: a 25 MB upload that comes back as a 413 has already cost the
 * owner the wait.
 */
export async function transcribeWithNan(
  fetchImpl: FetchLike,
  options: {
    key: string;
    source: AudioSource;
    language?: string;
    baseUrl?: string;
    signal?: AbortSignal;
    limits?: TranscriptionLimits;
  },
): Promise<TranscriptionOutcome> {
  const limits = options.limits ?? TRANSCRIPTION_LIMITS;
  if (options.source.bytes.length === 0) {
    return { ok: false, reason: "el archivo de audio está vacío." };
  }
  if (options.source.bytes.length > limits.maxBytes) {
    const mb = (options.source.bytes.length / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      reason: `el audio ocupa ${mb} MB y el máximo es ${Math.round(limits.maxBytes / (1024 * 1024))} MB.`,
    };
  }

  const runtime = uploadRuntime();
  if (!hasUploadSupport()) {
    return {
      ok: false,
      reason: "este entorno no tiene las funciones de subida necesarias para transcribir.",
    };
  }

  const form = new runtime.FormData();
  form.append("model", NAN_WHISPER_MODEL);
  form.append(
    "file",
    new runtime.Blob([options.source.bytes], { type: options.source.mimeType }),
    options.source.name,
  );
  // Without this the response is a bare `{"text": …}` and the language and duration
  // are lost, which the note uses to tell the owner what was heard.
  form.append("response_format", "verbose_json");
  if (options.language !== undefined && options.language.length > 0) {
    form.append("language", options.language);
  }

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(`${options.baseUrl ?? NAN_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.key}` },
      body: form,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `no se pudo contactar con el clúster de NaN: ${message}` };
  }

  const body = await response.text().catch(() => "");
  if (!response.ok) {
    return { ok: false, reason: describeStatus(response.status, body) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      ok: false,
      reason: `el servicio contestó algo que no es JSON. Respuesta: ${body.trim().slice(0, 200)}`,
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "el servicio contestó un JSON sin transcripción." };
  }
  const record = parsed as Record<string, unknown>;
  const text = record.text;
  if (typeof text !== "string") {
    return { ok: false, reason: "el servicio contestó un JSON sin el campo «text»." };
  }

  const result: TranscriptResult = { text };
  if (typeof record.language === "string" && record.language.length > 0) {
    result.language = record.language;
  }
  if (typeof record.duration === "number" && Number.isFinite(record.duration)) {
    result.durationSeconds = record.duration;
  }
  return { ok: true, result };
}

/** The seconds in `2,8 s`, or an empty string when the service did not say. */
function durationLabel(result: TranscriptResult): string {
  if (result.durationSeconds === undefined) {
    return "";
  }
  return `, ${result.durationSeconds.toFixed(1).replace(".", ",")} s`;
}

/**
 * The block that carries a transcript into a prompt.
 *
 * It is a labelled block rather than prose for one reason: the model must be able
 * to tell what the owner typed from what a machine heard, and so must anyone
 * reading the conversation later. A transcript that arrived as ordinary text would
 * be indistinguishable from an instruction.
 *
 * The transcript itself is never re-escaped or trimmed into shape: it is what was
 * heard, and editing it would be inventing.
 */
export function formatTranscriptBlock(source: AudioSource, result: TranscriptResult): string {
  const language = result.language === undefined ? "" : `, idioma detectado: ${result.language}`;
  return (
    `[Transcripción del audio adjunto: ${source.name}${durationLabel(result)}${language}. ` +
    "No lo escribió el usuario; es lo que se entendió de una grabación.]\n" +
    result.text
  );
}
