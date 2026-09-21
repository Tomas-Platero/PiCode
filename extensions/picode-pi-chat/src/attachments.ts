import { pathToFileURL } from "node:url";

/**
 * Preparing an attachment for the wire.
 *
 * pi accepts exactly two kinds of user content — text and images — and nothing
 * else: no audio, no video. An attachment therefore only becomes sendable after
 * it is a base64 PNG, JPEG, WebP, GIF or BMP, which is what this module produces.
 *
 * pi ships the helpers that do the actual work (format detection and
 * Photon/WASM resizing), so hosting the flow is a supported use rather than an
 * improvisation. They cannot be imported for typing — pi is ESM-only and loaded
 * at runtime — so they enter this module as an injected {@link ImageTools},
 * exactly the way `pi-sdk-client.ts` injects its `SdkModule`. That is also what
 * makes the whole module testable against a fake.
 *
 * Nothing here reads the owner's disk: bytes and base64 both arrive from the
 * caller, and the only thing this module decides is whether they may travel.
 */

/** The image formats pi accepts, which is also the only gate that matters. */
export const SUPPORTED_IMAGE_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
];

export interface AttachmentLimits {
  maxCount: number;
  maxBytes: number;
  maxWidth: number;
  maxHeight: number;
}

/**
 * Deliberately modest: an attachment is a request, and the bill is the owner's.
 *
 * `maxBytes` is the raw size of one image, checked before anything is decoded, so
 * an oversized file is refused without work. The dimensions mirror what providers
 * accept on the long edge; pi's own resizer downscales whatever exceeds them.
 */
export const ATTACHMENT_LIMITS: AttachmentLimits = {
  maxCount: 4,
  maxBytes: 4 * 1024 * 1024,
  maxWidth: 1568,
  maxHeight: 1568,
};

/** What one prepared attachment looks like on its way to the wire. */
export interface PreparedImage {
  data: string;
  mimeType: string;
  /** Original pixel size, when pi reported it. */
  width?: number;
  height?: number;
  /** True when the bytes sent are not the bytes given. */
  resized: boolean;
}

export type PrepareOutcome =
  | { ok: true; image: PreparedImage }
  | { ok: false; reason: string };

/** What pi reports for one resized image, structurally narrowed to what is used. */
export interface ResizedImageLike {
  data: string;
  mimeType: string;
  width: number;
  height: number;
  /**
   * The original pixel size. pi reports it, and it is the size that matters: the
   * model reasons about the coordinates the owner sees, so the original has to be
   * what reaches it even when the bytes were downscaled.
   *
   * Optional only because the resizer's shape is declared here rather than
   * imported; a real pi always fills it in, and `width`/`height` are the fallback.
   */
  originalWidth?: number;
  originalHeight?: number;
  wasResized: boolean;
}

/** The pi helpers this module uses, injected so it can be tested with a fake. */
export interface ImageTools {
  detectSupportedImageMimeType(buffer: Uint8Array): string | null;
  resizeImage(
    bytes: Uint8Array,
    mimeType: string,
    options: { maxWidth: number; maxHeight: number; maxBytes: number },
  ): Promise<ResizedImageLike | null>;
}

export interface PrepareImageInput {
  /** Base64 as it arrives from the webview. */
  base64?: string;
  /** Raw bytes, as the host reads them from a file. */
  bytes?: Uint8Array;
  /** The type the caller claims; only trusted as far as the detector confirms it. */
  claimedMimeType?: string;
  /** For the refusal message, so it can name the file. */
  name?: string;
}

/**
 * Turns one attachment into something the wire accepts, or says why it cannot.
 *
 * The claimed type is never believed: pi's detector decides, because a wrong
 * `mimeType` reaches a provider as a broken request and the owner sees an error
 * from the model instead of from here.
 *
 * Bad input never throws: every failure is an outcome carrying a reason, because
 * this runs on a message that a webview supplied and a refusal is information the
 * owner needs rather than an exception the panel has to survive.
 */
export async function prepareImage(
  tools: ImageTools,
  input: PrepareImageInput,
  limits: AttachmentLimits = ATTACHMENT_LIMITS,
): Promise<PrepareOutcome> {
  const label =
    typeof input.name === "string" && input.name.length > 0 ? `${input.name}: ` : "";

  const hasBase64 = input.base64 !== undefined;
  const hasBytes = input.bytes !== undefined;
  if (hasBase64 && hasBytes) {
    return refuse(
      `${label}la imagen llegó como base64 y como bytes a la vez; se admite una sola forma.`,
    );
  }
  if (!hasBase64 && !hasBytes) {
    return refuse(`${label}no hay imagen que preparar: falta el contenido.`);
  }

  let bytes: Uint8Array;
  if (hasBase64) {
    if (typeof input.base64 !== "string") {
      return refuse(`${label}el contenido base64 no es una cadena.`);
    }
    if (input.base64.length === 0) {
      return refuse(`${label}la imagen llegó vacía.`);
    }
    try {
      bytes = Uint8Array.from(Buffer.from(input.base64, "base64"));
    } catch (error) {
      return refuse(`${label}el base64 no se pudo decodificar: ${asErrorMessage(error)}`);
    }
  } else {
    if (!(input.bytes instanceof Uint8Array)) {
      return refuse(`${label}el contenido de la imagen no son bytes.`);
    }
    bytes = input.bytes;
  }

  if (bytes.length === 0) {
    return refuse(`${label}la imagen llegó vacía.`);
  }
  // Checked before the detector and before any resize: an oversized file is
  // refused for what it is, and decoding it first would be work spent to fail.
  if (bytes.length > limits.maxBytes) {
    return refuse(
      `${label}pesa ${formatBytes(bytes.length)} y el límite por imagen es ` +
        `${formatBytes(limits.maxBytes)}. Redúcela antes de adjuntarla.`,
    );
  }

  let detected: string | null;
  try {
    detected = tools.detectSupportedImageMimeType(bytes);
  } catch (error) {
    return refuse(`${label}no se pudo leer el formato: ${asErrorMessage(error)}`);
  }
  if (!detected) {
    const claimed =
      typeof input.claimedMimeType === "string" && input.claimedMimeType.length > 0
        ? ` (dice ser ${input.claimedMimeType})`
        : "";
    return refuse(
      `${label}el formato no es uno de los que pi acepta${claimed}. ` +
        `Admitidos: ${SUPPORTED_IMAGE_MIME_TYPES.join(", ")}.`,
    );
  }

  let resized: ResizedImageLike | null;
  try {
    resized = await tools.resizeImage(bytes, detected, {
      maxWidth: limits.maxWidth,
      maxHeight: limits.maxHeight,
      maxBytes: limits.maxBytes,
    });
  } catch (error) {
    return refuse(`${label}pi no pudo prepararla: ${asErrorMessage(error)}`);
  }
  // `null` means pi could not fit it under the limit. Sending it anyway would put
  // the rejection in front of the model, where the owner cannot act on it.
  if (!resized) {
    return refuse(
      `${label}pi no pudo dejarla por debajo de ${formatBytes(limits.maxBytes)} ` +
        `ni de ${limits.maxWidth}×${limits.maxHeight} píxeles.`,
    );
  }

  const image: PreparedImage = {
    data: resized.data,
    mimeType: resized.mimeType,
    resized: resized.wasResized === true,
  };
  const width = resized.originalWidth ?? resized.width;
  const height = resized.originalHeight ?? resized.height;
  if (typeof width === "number") {
    image.width = width;
  }
  if (typeof height === "number") {
    image.height = height;
  }
  return { ok: true, image };
}

/**
 * One line that tells the model what was attached.
 *
 * It exists because an attachment the model is not told about is an attachment it
 * will not reason about. When one was downscaled the note says so next to that
 * image's measurements, because the model maps coordinates onto the original: a
 * silent reduction would make it place them in the wrong space.
 */
export function formatAttachmentNote(
  images: readonly PreparedImage[],
): string | undefined {
  if (images.length === 0) {
    return undefined;
  }

  const parts = images.map((image, index) => {
    const size =
      typeof image.width === "number" && typeof image.height === "number"
        ? `${image.width}×${image.height}`
        : "tamaño desconocido";
    const reduced = image.resized ? " (reducida al enviarla: las medidas son las originales)" : "";
    return `${index + 1}. ${size}${reduced}`;
  });

  const noun = images.length === 1 ? "imagen adjunta" : "imágenes adjuntas";
  return `[${images.length} ${noun}: ${parts.join(", ")}]`;
}

/**
 * Loads pi's own image helpers from the SDK entry.
 *
 * pi is ESM-only, so the entry is imported by absolute URL the way the embedded
 * backend does it. What is checked is what this module calls: a pi that cannot
 * prepare an image must fail loudly here rather than accept attachments it will
 * hand to a provider as a broken request.
 *
 * The buffer detector is looked for on the entry first, and then in the module the
 * entry re-exports it from. pi 0.87.0 publishes only
 * `detectSupportedImageMimeTypeFromFile` from its entry, and that one needs a path
 * on disk, which an in-memory attachment does not have; the sibling module is the
 * same code, so a pi too old to have either still throws below.
 */
export async function loadImageTools(entry: string): Promise<ImageTools> {
  const loaded = (await dynamicImport(pathToFileURL(entry).href)) as Record<string, unknown>;

  const detect =
    typeof loaded.detectSupportedImageMimeType === "function"
      ? loaded.detectSupportedImageMimeType
      : await loadSiblingDetector(entry);
  const resize = loaded.resizeImage;

  if (typeof detect !== "function" || typeof resize !== "function") {
    const missing = [
      typeof detect === "function" ? undefined : "detectSupportedImageMimeType",
      typeof resize === "function" ? undefined : "resizeImage",
    ].filter((name): name is string => name !== undefined);
    throw new Error(
      `The pi at ${entry} does not export ${missing.join(" and ")}, ` +
        "so PiCode cannot prepare image attachments. Update pi to a version that " +
        "ships them, or send the message without attachments.",
    );
  }

  return {
    detectSupportedImageMimeType: detect as ImageTools["detectSupportedImageMimeType"],
    resizeImage: resize as ImageTools["resizeImage"],
  };
}

/** The module the entry re-exports the buffer detector from, when the entry hides it. */
async function loadSiblingDetector(entry: string): Promise<unknown> {
  try {
    const sibling = new URL("./utils/mime.js", pathToFileURL(entry));
    const module = (await dynamicImport(sibling.href)) as Record<string, unknown>;
    return module.detectSupportedImageMimeType;
  } catch {
    // Absent or unreadable stays absent; the caller reports what is missing.
    return undefined;
  }
}

/**
 * `import()` that survives this project's CommonJS output.
 *
 * TypeScript rewrites a literal dynamic import to `require()` when the module
 * target is CommonJS, and pi publishes its entry as ESM that `require()` cannot
 * load. Building the import at runtime keeps it a genuine dynamic `import()`.
 */
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<unknown>;

function refuse(reason: string): PrepareOutcome {
  return { ok: false, reason: `No se pudo adjuntar la imagen. ${reason}` };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) {
    return `${Math.round(kilobytes)} KB`;
  }
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
