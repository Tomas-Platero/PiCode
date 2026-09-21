/*
 * Exercises image preparation, the host half of the attachment flow.
 *
 * What an attachment becomes before it reaches a model is a contract: a wrong
 * `mimeType` arrives at a provider as a broken request and the owner sees an
 * error from the model instead of from here, and an oversized or unsupported
 * image must be refused with a reason rather than sent hopefully. The rules are
 * checked against a fake `ImageTools`, so nothing here needs a pi installation
 * and every refusal path is reachable.
 *
 * The fixtures are real files, not random bytes: a genuine PNG with a correct
 * IHDR chunk (and a real TIFF header for the refusal case), so a detector that
 * sniffs properly agrees with the test rather than the other way around.
 *
 * Run with: npm test
 */
const path = require("node:path");
const zlib = require("node:zlib");

const {
  ATTACHMENT_LIMITS,
  SUPPORTED_IMAGE_MIME_TYPES,
  formatAttachmentNote,
  prepareImage,
} = require(path.join(__dirname, "..", "out", "attachments.js"));

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** A real, fully formed PNG: signature, IHDR, a deflated IDAT and IEND. */
function makePng(width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor

  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3;
      raw[pixel] = 0xff;
      raw[pixel + 1] = 0x00;
      raw[pixel + 2] = 0x00;
    }
  }

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG = makePng(2, 2);
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9,
]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x2a, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
  Buffer.from("VP8 ", "ascii"),
  Buffer.alloc(18),
]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(10)]);
const BMP = Buffer.concat([Buffer.from("BM", "ascii"), Buffer.alloc(24)]);
/** A real TIFF header (little endian, empty IFD): valid, and not a format pi takes. */
const TIFF = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "ascii");

/**
 * The same sniffing pi does, so the fake agrees with real bytes.
 *
 * Mirrors `detectSupportedImageMimeType`: JPEG, PNG, GIF87a/89a, RIFF/WEBP and
 * BMP, and `null` for everything else.
 */
function sniff(buffer) {
  const bytes = Uint8Array.from(buffer);
  const ascii = (offset, text) =>
    text.split("").every((character, index) => bytes[offset + index] === character.charCodeAt(0));

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[3] !== 0xf7) {
    return "image/jpeg";
  }
  if (
    bytes[0] === 0x89 &&
    ascii(1, "PNG") &&
    bytes.length >= 16 &&
    ascii(12, "IHDR")
  ) {
    return "image/png";
  }
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) {
    return "image/gif";
  }
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) {
    return "image/webp";
  }
  if (ascii(0, "BM")) {
    return "image/bmp";
  }
  return null;
}

/**
 * A structural `ImageTools`, with its calls recorded.
 *
 * The counts are the point of several checks: "refused before the resize" is
 * only provable by the resizer never having been called.
 */
function createFakeTools(options = {}) {
  const calls = { detect: 0, resize: 0 };
  const tools = {
    detectSupportedImageMimeType(buffer) {
      calls.detect += 1;
      calls.detectedBytes = Uint8Array.from(buffer);
      if (options.detectError) {
        throw new Error(options.detectError);
      }
      return sniff(buffer);
    },
    async resizeImage(bytes, mimeType, limits) {
      calls.resize += 1;
      calls.mimeType = mimeType;
      calls.limits = limits;
      calls.bytes = Uint8Array.from(bytes);
      if (options.resizeError) {
        throw new Error(options.resizeError);
      }
      if (options.resizeImage) {
        return options.resizeImage({ bytes, mimeType, limits });
      }
      return {
        data: Buffer.from(bytes).toString("base64"),
        mimeType,
        width: 10,
        height: 5,
        originalWidth: 10,
        originalHeight: 5,
        wasResized: false,
      };
    },
  };
  return { tools, calls };
}

const SMALL_LIMITS = { maxCount: 1, maxBytes: 64, maxWidth: 16, maxHeight: 16 };
const BASE64_PNG = PNG.toString("base64");

async function outcomeOf(tools, input, limits) {
  try {
    return await prepareImage(tools, input, limits);
  } catch (error) {
    return { ok: "threw", reason: `threw: ${error.message}` };
  }
}

async function main() {
  /* ---------------------------------------------------------------- *
   * Formats
   * ---------------------------------------------------------------- */

  const formats = [
    ["PNG", PNG, "image/png"],
    ["JPEG", JPEG, "image/jpeg"],
    ["WebP", WEBP, "image/webp"],
    ["GIF", GIF, "image/gif"],
    ["BMP", BMP, "image/bmp"],
  ];

  for (const [name, bytes, mimeType] of formats) {
    const { tools, calls } = createFakeTools();
    const outcome = await outcomeOf(tools, { bytes, claimedMimeType: mimeType, name: name });
    check(
      `a real ${name} is accepted as ${mimeType}`,
      outcome.ok === true && outcome.image.mimeType === mimeType,
      JSON.stringify(outcome),
    );
    check(
      `the ${name} reaches the resizer as the detector's type`,
      calls.mimeType === mimeType,
      `resizer saw ${calls.mimeType}`,
    );
  }

  check(
    "the accepted list matches what pi's detector can return",
    SUPPORTED_IMAGE_MIME_TYPES.join(",") === formats.map(([, , mime]) => mime).join(","),
    SUPPORTED_IMAGE_MIME_TYPES.join(","),
  );

  /* ---------------------------------------------------------------- *
   * Refusals
   * ---------------------------------------------------------------- */

  {
    const { tools, calls } = createFakeTools();
    const outcome = await outcomeOf(tools, {
      bytes: PDF,
      claimedMimeType: "application/pdf",
      name: "informe.pdf",
    });
    check(
      "a PDF is refused by the format the owner claimed",
      outcome.ok === false &&
        outcome.reason.includes("application/pdf") &&
        outcome.reason.includes("informe.pdf"),
      outcome.reason,
    );
    check("a refused PDF never reaches the resizer", calls.resize === 0, `resize=${calls.resize}`);
  }

  {
    const { tools, calls } = createFakeTools();
    const outcome = await outcomeOf(tools, {
      bytes: TIFF,
      claimedMimeType: "image/tiff",
      name: "escaneo.tiff",
    });
    check(
      "a real TIFF is refused even though it claims to be an image",
      outcome.ok === false && outcome.reason.includes("image/tiff"),
      outcome.reason,
    );
    check("a refused TIFF never reaches the resizer", calls.resize === 0, `resize=${calls.resize}`);
  }

  {
    const { tools, calls } = createFakeTools();
    const outcome = await outcomeOf(tools, { bytes: new Uint8Array(0), name: "vacio.png" });
    check(
      "empty bytes are refused as empty",
      outcome.ok === false && outcome.reason.includes("vacía") && outcome.reason.includes("vacio.png"),
      outcome.reason,
    );
    check("empty bytes never reach the detector", calls.detect === 0, `detect=${calls.detect}`);
  }

  {
    const oversized = Buffer.concat([PNG, Buffer.alloc(SMALL_LIMITS.maxBytes)]);
    const { tools, calls } = createFakeTools();
    const outcome = await outcomeOf(tools, { bytes: oversized, name: "grande.png" }, SMALL_LIMITS);
    check(
      "bytes over the limit are refused with the size and the limit named",
      outcome.ok === false &&
        outcome.reason.includes(String(oversized.length)) &&
        outcome.reason.includes(String(SMALL_LIMITS.maxBytes)),
      outcome.reason,
    );
    check(
      "an oversized image is refused before the resize is attempted",
      calls.resize === 0,
      `resize=${calls.resize}`,
    );
  }

  {
    const { tools } = createFakeTools({ resizeImage: () => null });
    const outcome = await outcomeOf(tools, { bytes: PNG, name: "grande.png" }, SMALL_LIMITS);
    check(
      "a resizer that cannot fit the image is refused with the limit named",
      outcome.ok === false && outcome.reason.includes(`${SMALL_LIMITS.maxBytes} B`),
      outcome.reason,
    );
  }

  {
    const { tools } = createFakeTools({ detectError: "no reader" });
    const outcome = await outcomeOf(tools, { bytes: PNG });
    check(
      "a detector that throws becomes a refusal, not a thrown error",
      outcome.ok === false && outcome.reason.includes("no reader"),
      outcome.reason,
    );
  }

  /* ---------------------------------------------------------------- *
   * Preparation
   * ---------------------------------------------------------------- */

  {
    const resized = {
      data: "cmVkdWNpZGE=",
      mimeType: "image/jpeg",
      width: 1568,
      height: 882,
      originalWidth: 1920,
      originalHeight: 1080,
      wasResized: true,
    };
    const { tools, calls } = createFakeTools({ resizeImage: () => resized });
    const outcome = await outcomeOf(tools, { bytes: PNG, name: "foto.png" });
    check(
      "a resized image carries the resized bytes and type",
      outcome.ok === true &&
        outcome.image.data === resized.data &&
        outcome.image.mimeType === "image/jpeg",
      JSON.stringify(outcome),
    );
    check(
      "a resized image reports its ORIGINAL dimensions",
      outcome.ok === true && outcome.image.width === 1920 && outcome.image.height === 1080,
      JSON.stringify(outcome.ok ? outcome.image : outcome),
    );
    check(
      "a resized image says it was resized",
      outcome.ok === true && outcome.image.resized === true,
      JSON.stringify(outcome),
    );
    check(
      "the resizer is given the configured limits",
      calls.limits.maxWidth === ATTACHMENT_LIMITS.maxWidth &&
        calls.limits.maxHeight === ATTACHMENT_LIMITS.maxHeight &&
        calls.limits.maxBytes === ATTACHMENT_LIMITS.maxBytes,
      JSON.stringify(calls.limits),
    );
  }

  {
    const { tools } = createFakeTools();
    const outcome = await outcomeOf(tools, {
      bytes: PNG,
      claimedMimeType: "application/pdf",
      name: "mentiroso.pdf",
    });
    check(
      "a claimed type that disagrees with the detector is ignored",
      outcome.ok === true && outcome.image.mimeType === "image/png",
      JSON.stringify(outcome),
    );
  }

  {
    const { tools, calls } = createFakeTools();
    const outcome = await outcomeOf(tools, { base64: BASE64_PNG, name: "pegado.png" });
    check(
      "base64 from the webview is decoded before detection",
      outcome.ok === true && calls.detectedBytes.length === PNG.length,
      `detector saw ${calls.detectedBytes ? calls.detectedBytes.length : "nothing"} bytes`,
    );
  }

  /* ---------------------------------------------------------------- *
   * Nothing throws
   * ---------------------------------------------------------------- */

  const malformed = [
    ["no content at all", {}],
    ["base64 and bytes together", { base64: BASE64_PNG, bytes: PNG }],
    ["a non-string base64", { base64: 42 }],
    ["an empty base64 string", { base64: "" }],
    ["a zero-length byte array", { bytes: new Uint8Array(0) }],
    ["a plain array instead of bytes", { bytes: [] }],
    ["a null bytes field", { bytes: null }],
    ["a numeric bytes field", { bytes: 7 }],
  ];

  for (const [label, input] of malformed) {
    const { tools, calls } = createFakeTools();
    const outcome = await outcomeOf(tools, input);
    check(
      `${label} is refused, not thrown`,
      outcome.ok === false && typeof outcome.reason === "string" && outcome.reason.length > 0,
      JSON.stringify(outcome),
    );
    check(`${label} never reaches the resizer`, calls.resize === 0, `resize=${calls.resize}`);
  }

  /* ---------------------------------------------------------------- *
   * The note
   * ---------------------------------------------------------------- */

  check("no images means no note", formatAttachmentNote([]) === undefined, "");

  const plain = formatAttachmentNote([
    { data: "x", mimeType: "image/png", width: 800, height: 600, resized: false },
  ]);
  check(
    "one image is noted and uses the singular",
    typeof plain === "string" &&
      plain.includes("1 imagen adjunta") &&
      plain.includes("800×600") &&
      !plain.includes("reducida"),
    plain,
  );

  const mixed = formatAttachmentNote([
    { data: "x", mimeType: "image/png", width: 1920, height: 1080, resized: true },
    { data: "y", mimeType: "image/jpeg", width: 640, height: 480, resized: false },
  ]);
  check(
    "several images are listed with their original sizes",
    typeof mixed === "string" &&
      mixed.includes("2 imágenes adjuntas") &&
      mixed.includes("1. 1920×1080") &&
      mixed.includes("2. 640×480"),
    mixed,
  );
  check(
    "a downscaled image is declared as such in the note",
    typeof mixed === "string" && mixed.includes("reducida") && mixed.includes("originales"),
    mixed,
  );

  const unknown = formatAttachmentNote([{ data: "x", mimeType: "image/png", resized: false }]);
  check(
    "an image with unknown dimensions says so instead of printing undefined",
    typeof unknown === "string" && unknown.includes("tamaño desconocido") && !unknown.includes("undefined"),
    unknown,
  );

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
  console.error("attachments checks failed:", error);
  process.exit(2);
});
