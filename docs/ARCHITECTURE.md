# Architecture

## The layered model

PiCode is built in four layers. Each is independently replaceable, which is what keeps
a "modified VS Code" lightweight instead of a monolithic fork.

```text
┌──────────────────────────────────────────────────────────────────┐
│ 4. Experience layer   PiCode defaults, curated settings,         │
│                       first-run profile                          │
├──────────────────────────────────────────────────────────────────┤
│ 3. Agent layer        the panel family (chat view, launcher,     │
│                       categorized popup) over pi                 │
├──────────────────────────────────────────────────────────────────┤
│ 2. Extension layer    the agent runtime (pi, gentle-pi),         │
│                       built-in extensions, Open VSX gallery      │
├──────────────────────────────────────────────────────────────────┤
│ 1. Editor layer       the VSCodium tree, owned here, plus the    │
│                       product delta applied to it                │
└──────────────────────────────────────────────────────────────────┘
```

### Layer 1 — Editor: the VSCodium tree, owned

PiCode owns its editor tree. The VSCodium archive is extracted at the repository root,
and `distribution/apply-picode.ps1` applies a product delta to it. See
`docs/DISTRIBUTION.md` for the mechanism and its limits, and ADR-011 for why the
overlay path was abandoned.

Two properties of this layer shape everything above it:

- **Product keys can be deleted.** That is what makes the removal of Copilot and the
  telemetry endpoints real rather than cosmetic.
- **`resources/app/extensions/` is the built-in scan path.** The panel needs no install
  step and no compiled-in extension list.

We still do **not** patch minified core: `product.json` carries a `checksums` map over
the bundle, so a core change is a fork, not a patch.

### Layer 2 — Extensions

Two categories:

- **Agent runtime**: `pi` and the `gentle-pi` package with its bundled `gentle-ai`
  binary. These are executables the agent layer talks to, kept decoupled so they can be
  updated independently of the editor. Which one runs is the owner's choice
  (`picode.pi.runtime`).
- **Editor extensions**: the built-in extensions the archive ships, plus anything the
  owner installs from Open VSX, since the Microsoft marketplace is not licensed for
  third-party builds.

### Layer 3 — The agent layer

The differentiating layer. It is a normal VS Code extension, developed and tested
against the built-in install, and it speaks to pi two ways: **RPC** for the session, and
the **CLI** for what RPC does not expose.

#### Surfaces

| Surface | Where | Why there |
| --- | --- | --- |
| Chat view | secondary side bar (right) | the working surface; the owner asked for it on the right |
| Launcher | activity bar (left) | the icon the owner asked for; showing it opens the popup |
| Categorized popup | native quick picks | the configuration surface, following the Settings editor's shape |
| Status bar item | bottom left | one click to the same popup |
| View title button | chat view header | the same popup, in place |

A view container can only open a sidebar — the editor decides that, not the extension —
so "the icon opens the popup" is implemented as: showing the launcher panel triggers the
popup, with one resolve per session skipped because a restored panel at startup is not a
click.

#### Modules and their boundaries

| Module | Owns | Does not |
| --- | --- | --- |
| `pi-rpc-client` | the child process, LF framing, id correlation, one spawn per start, the running usage total | know about the editor UI |
| `chat-view` | the chat webview, the event stream, composing a message with its context | format anything the renderer could |
| `ajustes-view` | the launcher panel: live state and one button per category | decide what a category contains |
| `menu` | the popup's two levels, and the actions behind them | read state itself; it is given a snapshot |
| `runtime` | which `pi` runs, and installing PiCode's own | know about the session |
| `pi-cli` | running any external tool and collecting output; the `pi list` parser; the catalog search | know which tool |
| `gentle` | reading Gentle AI's state from its own words | act on anything except the two switches |
| `usage` | the arithmetic and formatting of tokens and cost | know where the numbers came from |
| `context` | the editor-context block prefixed to a message | know about the protocol |
| `webview-html` | the document, CSP and nonce both webviews share | know what the views show |
| `media/*` | presentation only | compute anything |

Two rules hold across the table. The **host owns the truth** and the webviews render
it; and **anything with arithmetic or wording that can be wrong is a pure function in
its own module**, so it can be asserted without an editor.

### Layer 4 — Experience

Defaults that make PiCode feel like one product: `distribution/settings.json`,
deliberate first-run defaults, and a portable profile that is disposable.

## The RPC contract

`pi --mode rpc` speaks JSONL over stdin/stdout. The contract, as verified against pi
`0.86.1`:

**Framing (strict).** Records are delimited by LF (`\n`) **only**. A trailing `\r` is
stripped for compatibility. Unicode line separators (`U+2028`, `U+2029`) are legal
inside JSON strings, so Node's `readline` is *not* protocol-compliant and is not used:
the client splits the byte stream itself.

**Commands** (host → agent), the subset the panel uses:

| Command | Purpose |
| --- | --- |
| `prompt` | a user message; `streamingBehavior: "steer" \| "followUp"` when busy |
| `abort` | stop the current run |
| `new_session`, `get_state`, `get_commands` | session lifecycle and discovery |
| `get_available_models`, `set_model`, `cycle_model` | model control |
| `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels` | reasoning control |

`set_model` needs both halves of the reference (`provider` + `modelId`); a bare `model`
field is rejected (ADR-007). The reasoning picker offers what
`get_available_thinking_levels` returns rather than the full enum, because pi rejects a
level the current model does not support.

**Events** (agent → host), the subset the panel consumes: `agent_start`, `agent_end`,
`agent_settled`, `turn_start`/`turn_end`, `message_start`/`message_end`,
`message_update`, `tool_execution_*`, `queue_update`, `compaction_*`, `auto_retry_*`
and `extension_error`.

`message_update` is **delta-only**: no cumulative snapshot and no `partial` field. The
client assembles live text from `contentIndex` + `delta` and treats `message_end` as the
authoritative final state.

**Usage is per message, never as a total.** `get_state` carries the session and the
model; the tokens and the cost arrive on each assistant message. The panel therefore
sums them from the authoritative `message_end` records, and treats the context size as
the *last* turn's figure rather than a sum, because a window's fullness is not
cumulative.

**The CLI is the second integration.** Package management (`pi install`, `remove`,
`update`, `list`) and Gentle AI's own surface (`review mode`, `telemetry`, `sdd-status`,
`doctor`) are not in the protocol, so they run as the **active runtime's** CLI: a package
must be managed by the pi that will load it.

## Testing

Seven hermetic suites (`npm test`) cover the parts that can be wrong without an editor:
the runtime resolver, the webview/markup agreement, the `pi list` parser, the popup's
two levels, the Gentle AI readers, the usage arithmetic, and the context block. A live
suite (`npm run test:live`) drives a real `pi` and a real `gentle-ai` for the protocol
and CLI surfaces.

Two habits are worth keeping. Percentages of the total (cost, token counts) are checked
rather than eyeballed. And the editor's own behaviour is verified by reading what it
writes — the log directory it chose, the extension activation line, the output channel —
because a passing unit test says nothing about whether the editor loads the result.

## Language

All user-facing copy is Spanish: the panel, the popup, notifications, command titles and
setting descriptions. Code, comments, commit messages and the diagnostic output channel
stay English, because the channel is a developer surface and mixing languages inside one
log is worse than either choice alone.

## Non-goals

- Patching the VS Code core (the checksums map makes it unavailable on this path).
- A custom language server for pi.
- Implementing our own agent loop: pi owns agent behaviour, PiCode owns the surface
  around it.
- Reimplementing what the editor already provides: filtering, keyboard handling and
  accessibility come from native quick picks rather than from a webview.
