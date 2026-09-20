# Architecture

## Layered model

PiCode is built in four layers. Each layer is independently replaceable, which
is what keeps a "modified VS Code" lightweight instead of turning it into a
monolithic fork.

```text
┌──────────────────────────────────────────────────────────────┐
│ 4. Experience layer      PiCode defaults, keybindings,       │
│                          curated settings, welcome page      │
├──────────────────────────────────────────────────────────────┤
│ 3. Agent layer           picode-pi-chat extension            │
│                          (panel + RPC client to pi)          │
├──────────────────────────────────────────────────────────────┤
│ 2. Extension layer       pi CLI, gentle-pi, built-in         │
│                          extensions, Open VSX gallery        │
├──────────────────────────────────────────────────────────────┤
│ 1. Editor layer          VSCodium (MIT build of VS Code)     │
│                          + product.json branding             │
└──────────────────────────────────────────────────────────────┘
```

### Layer 1 — Editor (VSCodium + branding)

The editor is VSCodium, the community build of the MIT-licensed VS Code source.
Branding is applied through `product.json` fields (`nameShort`, `nameLong`,
`applicationName`, `dataFolderName`, `urlProtocol`) and visual assets.

We do **not** patch the editor core unless a requirement cannot be met any other
way. Every core patch is a permanent maintenance tax against upstream.

### Layer 2 — Extensions

Two categories:

- **Agent runtime**: the `pi` CLI and `gentle-ai` binary. These are not VS Code
  extensions; they are executables the agent layer talks to. They stay decoupled
  so they can be updated independently of the editor.
- **Editor extensions**: preinstalled extensions shipped in the distribution
  (language support, themes, Git tooling) sourced from Open VSX since the
  Microsoft marketplace is not licensed for third-party builds.

### Layer 3 — Agent layer (`picode-pi-chat`)

This is the differentiating layer. It is a normal VS Code extension, so it can
be developed and tested against stock VS Code long before the distribution
build exists — a deliberate de-risking choice.

```text
┌────────────────────┐        spawn          ┌──────────────────────┐
│  Chat webview      │                       │  pi --mode rpc       │
│  (renderer)        │◄── postMessage ──┐    │  (agent process)     │
└────────────────────┘                  │    │                      │
         ▲                              │    │  stdin  ◄── commands │
         │                              │    │  stdout ──► events   │
         │                        ┌─────┴──┐ └──────────────────────┘
         │                        │  Chat  │
         └──── events ────────────┤ Panel  │
                                  │ (host) │
                                  └────────┘
```

**Why a child process instead of the in-process SDK?** The SDK
(`createAgentSession`) is the right tool for a Node application that owns
pi's lifecycle. For an editor extension, a child process is the better fit:

- **Isolation**: an agent crash cannot take down the extension host.
- **Version independence**: the extension talks to whatever `pi` is on `PATH`
  or configured, so users are not locked to the version bundled at release.
- **Process model**: the agent already owns cwd, file writes and shell access;
  keeping it out of the extension host avoids two writers in one process.
- **Protocol parity**: the RPC surface is documented and stable, and the exact
  same protocol serves the CLI, the panel and future automation.

The in-process SDK remains a valid option for a future "embedded" mode and is
recorded as such in `docs/DECISIONS.md`.

### Layer 4 — Experience

Defaults that make PiCode feel like one product rather than VS Code with
add-ons: `settings.json` defaults, keybindings for agent commands, a PiCode
welcome page, and workspace trust defaults tuned for an agent-first editor.

## The RPC contract

`pi --mode rpc` speaks JSONL over stdin/stdout. The contract, as verified
against pi `0.86.1`:

**Framing (strict).** Records are delimited by LF (`\n`) **only**. A trailing
`\r` is stripped for compatibility. Unicode line separators (`U+2028`, `U+2029`)
are legal inside JSON strings, so Node's `readline` is *not* protocol-compliant
and must not be used. The client splits the byte stream on `\n` itself.

**Commands** (host → agent). Every command may carry an `id` for correlation:

| Command | Purpose |
| --- | --- |
| `prompt` | Send a user message; `streamingBehavior: "steer" \| "followUp"` when busy |
| `steer`, `follow_up` | Queue into a running agent |
| `abort` | Stop the current run |
| `new_session`, `switch_session`, `fork`, `clone` | Session lifecycle |
| `get_state`, `get_messages` | Read current state |
| `set_model`, `cycle_model`, `get_available_models` | Model control |
| `set_thinking_level`, `get_available_thinking_levels` | Thinking control |
| `compact`, `set_auto_compaction` | Context management |
| `bash`, `abort_bash` | Run a shell command outside the agent loop |
| `get_commands` | Discover extension commands and skills |

**Events** (agent → host), the subset the panel consumes:

| Event | Meaning |
| --- | --- |
| `agent_start` / `agent_end` / `agent_settled` | Run lifecycle; `agent_settled` means nothing will continue automatically |
| `turn_start` / `turn_end` | One assistant response plus its tool calls |
| `message_start` / `message_end` | Message boundaries; `message_end` carries the authoritative message |
| `message_update` | Streaming deltas: `text_delta`, `thinking_delta`, `toolcall_delta` |
| `tool_execution_start` / `_update` / `_end` | Tool progress for the activity timeline |
| `queue_update`, `compaction_*`, `auto_retry_*` | Context and resilience signals |
| `extension_error` | An extension threw |

`message_update` is **delta-only**: no cumulative snapshot and no `partial`
field. The client assembles live text from `contentIndex` + `delta` and treats
`message_end` as the authoritative final state. This keeps the stream linear
and cheap to render.

## Extension internals

```text
extensions/picode-pi-chat/src/
├── extension.ts        Activation, command registration, wiring
├── pi-rpc-client.ts    Process spawn, strict LF framing, request/response map
├── chat-panel.ts       Webview host: event routing, render-formatted messages
└── protocol.ts         Typed commands/events shared with the webview
media/
├── main.js             Webview renderer (streaming UI)
└── main.css            Panel styling using VS Code theme variables
```

The boundary between `chat-panel.ts` and `media/main.js` is intentionally thin:
the host owns the process and the truth, the webview owns presentation only.

## Non-goals (current phase)

- Patching the VS Code core.
- A custom language server for pi.
- Implementing our own agent loop; pi owns agent behaviour, PiCode owns the
  surface around it.
