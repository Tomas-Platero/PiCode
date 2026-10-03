# Architecture

## The repository layout

Every top-level folder is one role, and the boundaries between them are what keeps
upstream merges cheap and the product layers replaceable:

| Path | Role |
| --- | --- |
| `picode-source/` | **Layer 1 — the editor.** PiCode's own source tree: the VS Code-derived editor with the PiCode changes and identity committed in its history. Upstream merges land here, and only here. |
| `distribution/` | **Layer 4 — the product as data.** The product delta (the single home of identity and version), first-run defaults, the pinned pi runtime and the brand assets. |
| `dev/` | The build engine: the five-phase build, staging, the update feed, the pi runtime installer. |
| `builder/` | The C#/WinUI 3 front-end that drives the same pipeline with one button. |
| `upstream/` | The pin file: the VS Code version the tree descends from. |
| `docs/` | Internal papers: this document, distribution, CI, decisions, the task board. |
| `odd/tasks/` | The ODD feature records — one per non-trivial change, with decisions, checks and defects. |
| `assets/` | Brand images of the repository itself. |

Nothing of ours lives inside `picode-source/` except code the editor itself runs. The
identity, defaults and release data stay outside the tree, applied onto it — that is why
bringing a newer VS Code is a merge against `picode-source/` and nothing else has to move.

## The layered model

```text
┌──────────────────────────────────────────────────────────────────┐
│ 4. Experience layer   the product delta, first-run defaults,     │
│                       the portable profile, the update feed      │
├──────────────────────────────────────────────────────────────────┤
│ 3. Agent layer        the native chat, modified in the core,     │
│                       speaking to pi (RPC + CLI)                 │
├──────────────────────────────────────────────────────────────────┤
│ 2. Extension layer    the agent runtime (pi, gentle-pi), the     │
│                       trimmed built-in extensions, Open VSX      │
├──────────────────────────────────────────────────────────────────┤
│ 1. Editor layer       the owned source tree in picode-source/    │
└──────────────────────────────────────────────────────────────────┘
```

### Layer 1 — Editor: the owned source tree

`picode-source/` is not a vendored archive: it is **PiCode's source**, versioned in this
repository. The packer collects every extension under `picode-source/extensions/`, the
identity is applied to `picode-source/product.json` before compilation, and the checksums
are computed over the result — so a behaviour change is written in TypeScript, in the
tree itself, never patched onto a minified bundle.

The build is `dev/build.sh` in five phases: prepare (identity, dependencies, the
connector), the connector, compile, pack, stage. `builder/` drives the same pipeline
through a GUI. CI (`.github/workflows/ci.yml`) builds on push; the release workflow reads
the version from `distribution/product-delta.json` before tagging.

**The lightweight cut (2026-09-29)** is a standing property of this layer, not a one-off:
the product ships what an agent-driven code editor needs, nothing else. Ten extension
folders were removed (the four test-only extensions, mermaid preview, the notebook
pair, Microsoft/GitHub authentication and the GitHub extension), ESLint was removed from
the toolchain, and regenerable artefacts stay out of the tree. The record, with the
degradations accepted, is `odd/tasks/lightweight-picode-source.md`. Removing a folder
under `extensions/` removes it from the product — the packer has no exclusion list.

Two properties of the layer shape everything above it:

- **Product keys can be deleted, not just overridden.** That is what makes the removal
  of Copilot and the telemetry endpoints real rather than cosmetic.
- **`resources/app/extensions/` is the built-in scan path.** Built-ins need no install
  step and no compiled-in extension list.

### Layer 2 — Extensions

- **The agent runtime**: `pi` is pinned in `distribution/runtime.json` and installed into
  the pack by `dev/pi-runtime.sh`; `gentle-pi` is a pi package the connector installs into
  the internal profile's npm project (its source of truth is npm, once the script gate is
  approved). Both are executables the agent layer talks to, decoupled from the editor so
  they update independently. Which one runs is the owner's choice (`picode.pi.runtime`).
- **The built-in extensions**: the trimmed set the source tree ships (language
  colorizers for every language, `git`, TypeScript, JSON/HTML/CSS language features,
  markdown preview without mermaid, `emmet`, themes, the `picode` connector).
- **Anything else** the owner installs comes from Open VSX — the Microsoft marketplace
  is not licensed for third-party builds.

### Layer 3 — Agent: in the core, not an extension

The first agent surface was a standalone extension (`extensions/picode-pi-chat`); it was
retired on 2026-09-27 and its replacement is **the native chat modified in the core**
(`src/vs/workbench/contrib/chat/**` carries the PiCode changes: the model selector, the
removal of the Copilot paywall, sessions). The multi-harness service
(`src/vs/platform/agentHost/`) provides the chat-addressed orchestration, and
`extensions/picode` — the connector, compiled by phase 2 — contributes the providers and
models surface. The bridge that binds a chat session to the pi runtime is the layer's
open work; the task board (`docs/TAREAS.md`) tracks it.

pi is spoken to two ways, and the contract below is the stable part of this layer:
**RPC** (`pi --mode rpc`, JSONL over stdin/stdout) for the session, and the **CLI** of
the *active runtime* for everything the protocol does not expose — package management
(`pi install`, `remove`, `update`, `list`) and Gentle AI's own surface (`review mode`,
`telemetry`, `doctor`).

**Framing (strict).** Records are delimited by LF (`\n`) **only**. Unicode line
separators (`U+2028`, `U+2029`) are legal inside JSON strings, so Node's `readline` is
*not* protocol-compliant and is not used: the client splits the byte stream itself.

**Commands** (host → agent): `prompt` (with `streamingBehavior` when busy), `abort`,
`new_session`, `get_state`, `get_commands`, `get_available_models`/`set_model`/
`cycle_model`, `set_thinking_level`/`cycle_thinking_level`/
`get_available_thinking_levels`. `set_model` needs both halves of the reference
(`provider` + `modelId`); a bare `model` field is rejected (ADR-007). The reasoning
picker offers what `get_available_thinking_levels` returns rather than the full enum.

**Events** (agent → host): `agent_start`, `agent_end`, `agent_settled`,
`turn_start`/`turn_end`, `message_start`/`message_end`, `message_update`,
`tool_execution_*`, `queue_update`, `compaction_*`, `auto_retry_*`, `extension_error`.

`message_update` is **delta-only**: the client assembles live text from `contentIndex` +
`delta` and treats `message_end` as the authoritative final state. **Usage is per
message, never a total**: tokens and cost arrive on each assistant message, the panel
sums them from `message_end` records, and the context size is the *last* turn's figure
rather than a sum, because a window's fullness is not cumulative.

### Layer 4 — Experience

`distribution/product-delta.json` carries the identity and version — one home, applied
by the build so the compiled editor and the released one cannot disagree.
`distribution/settings.json` are the first-run defaults, copied only when the user has
no settings of their own. The profile is portable and disposable. The updater reads the
static feed produced by `dev/update-feed.mjs` (layout in `updates/README.md`); the
in-product update URL of the upstream tree stays empty.

## Testing

The connector (`extensions/picode`) keeps hermetic suites for the parts that can be
wrong without an editor: the runtime resolver, the `pi list` parser, the usage
arithmetic, the context block. The editor's own behaviour is verified by reading what it
writes — the log directory it chose, the extension activation line, the output channel —
because a passing unit test says nothing about whether the editor loads the result.

## Language

All user-facing copy is **English**: the editor, the chat, notifications, command
titles, setting descriptions and the labels shown for pi's tools. Code, comments, commit
messages and diagnostic output stay English as well. The conversation with the owner is
**Spanish**, and so are the records that are his — `AGENTS.md` (his own words) and the
papers in `odd/tasks/`. Other languages are reached later through **language packs**, a
separate layer over the shipped text, never a translation of the sources in place
(ADR-012).

## Non-goals

- Patching a minified core: changes are made in the source tree and compiled.
- A custom language server for pi.
- Implementing our own agent loop: pi owns agent behaviour, PiCode owns the surface
  around it.
- Shipping weight without a user-facing reason: the lightweight cut is doctrine, and a
  folder under `extensions/` needs a justification to exist.
