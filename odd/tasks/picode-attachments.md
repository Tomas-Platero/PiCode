# Feature: attachments in the chat

## Goal

Let the owner send an image, a video or an audio clip from the composer. Today
none of the three is possible: `protocol.ts` declares `images?` on the `prompt`
command, and neither backend exposes it, so there is no path from the panel to a
model at all.

## What pi actually accepts (verified, 2026-09-21)

- `@earendil-works/pi-ai` declares user content as `TextContent | ImageContent`
  and nothing else. **There is no audio or video content type**, and a model
  configuration's `input` list only accepts `"text"` and `"image"`.
- Accepted image formats, from pi's own detector: **PNG, JPEG, WebP, GIF, BMP**.
- pi ships the helpers a host needs for exactly this, so hosting the flow is a
  supported use rather than an improvisation: `detectSupportedImageMimeType(buffer)`,
  `detectSupportedImageMimeTypeFromFile(path)`, `resizeImage(bytes, mimeType, options)`
  (Photon/WASM, tries PNG then JPEG, reduces quality and finally dimensions),
  `formatDimensionNote(result)` and `convertToPng(bytes)`.
- `ImageContent` on the wire is `{ type: "image", data: <base64>, mimeType }`, which
  is the same shape in the RPC protocol and in the SDK, so one encoder serves both.

Consequence, and the reason this feature has three phases: **images can be sent;
audio and video can only be converted.** Audio becomes text (pi has no audio input),
and video becomes a set of frames (images) plus a line saying which timestamp each
frame is.

## Decisions (locked by the product owner, 2026-09-21)

The owner chose all three, knowing the dependency each one adds.

| Decision | Choice | Rationale |
| --- | --- | --- |
| Phases | Images first, then video, then audio | Images need no dependency and are the only thing pi accepts natively; the other two are conversions and each brings a binary or a service |
| Entry points | Paste, drag and drop, and a picker button | All three are how the editor itself accepts a file; a picker alone would make paste feel broken |
| Preparation | In the host, through pi's own helpers | The webview cannot do WASM resizing reliably and should not be trusted with the file anyway |
| Video | Frames extracted with ffmpeg, attached as images | The only way in. Frames are capped and each carries its timestamp so the model is not guessing |
| Audio | Transcription, two backends: the NaN cluster, or a local whisper binary | pi has no audio input. NaN needs no binary and the owner already has a key, but the audio leaves the machine, so it is a setting with that stated plainly |
| Missing tools | Report which tool is missing and how to install it; never fail silently | ffmpeg is not bundled, and a feature that quietly does nothing is worse than one that says it cannot work |
| Limits | A cap on count and on total bytes, stated in the UI when it is hit | An unbounded attachment is an unbounded request, and the token cost lands on the owner's bill |

## Tasks

### Phase A — images

1. **Protocol and both backends.** `PiClient.prompt(text, options?)` where options
   carry `streamingBehavior` and `images`. `PiRpcClient` sends `images` on the
   `prompt` command (already declared) and `PiSdkClient` passes them to
   `session.prompt`. One `PanelImage` type shared by the webview, the host and both
   backends.
2. **Preparation in the host.** A module that takes a file path or raw bytes,
   detects the mime type, refuses anything outside the five formats, resizes when
   the image exceeds the limits, and returns the base64 the wire wants. Pure enough
   to test with a fixture.
3. **Composer.** An attach button, a paste handler on the textarea, a drop target
   over the panel, a chip row above the composer with a thumbnail per image and a
   remove control, and the caps enforced with a message rather than a silent drop.
4. **Transcript.** A user message renders its images as thumbnails and opens one
   full size on click. Today its content is text only, so an attached image would
   vanish from the record of what was sent.

### Phase B — video

1. **ffmpeg discovery.** `picode.media.ffmpegPath`, then PATH. When neither
   answers, the attach path says so and offers the install command for the platform
   instead of failing.
2. **Frame extraction.** A capped number of frames at even intervals, each
   timestamped and each pushed through the image pipeline, plus one text line that
   says how many frames there are and what each one is.

### Phase C — audio

1. **Transcription.** `picode.media.transcription` = `nan` | `local` | `off`,
   `nan` by default when the owner has a key. NaN posts to the OpenAI-compatible
   `/v1/audio/transcriptions` with the key from `auth.json`; `local` runs a whisper
   binary from `picode.media.whisperPath`. Either way the result becomes a text
   block that says it is a transcription, because text the owner did not type must
   never look like text the owner typed.

## Out of scope

Sending a file that is not media (the agent reads files itself), recording audio
from the microphone (that is dictation, a separate feature), and any editing of the
image before sending beyond the automatic resize.

## Evidence

- Work-unit commits per task; `npm test` green after each.
- A live check per phase that a real attachment reaches a model and comes back
  described, because the whole feature is worthless if the wire shape is wrong.
- The measured limits recorded in `docs/ARCHITECTURE.md` next to the ones already
  there for the runtime.
