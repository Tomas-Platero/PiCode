# Feature: PiCode foundation

## Goal

Establish the foundation of PiCode: a lightweight, rebranded VS Code distribution
(based on VSCodium) for Windows that ships with the pi coding agent and gentle-pi
(Gentle AI) integrated as first-class built-in experiences.

## Decisions (locked)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Distribution approach | Distribution layered on top of VS Code/VSCodium, not a full `microsoft/vscode` fork | A full fork is a multi-GB, yarn + native-modules + Electron build with a slow cycle; it contradicts the "lightweight" objective |
| Upstream base | VSCodium | MIT-licensed community build, no telemetry or Microsoft branding; redistributable under our own "PiCode" brand |
| pi integration (MVP) | A PiCode extension with a pi panel that drives the pi CLI | This is the differentiating core; `pi --mode rpc` already exposes an IDE-embedding protocol |
| Platform (MVP) | Windows | Matches the development machine; allows local iteration and validation before multi-OS CI |

## Verified integration surface

These facts were verified directly against the local installation
(`pi --version` = `0.86.1`), not assumed:

- `pi --mode rpc` — JSONL protocol over stdin/stdout, documented in `docs/rpc.md`
  as "useful for embedding the agent in other applications, IDEs, or custom UIs".
- `pi --mode json` — one-shot JSON event stream to stdout (`docs/json.md`).
- `pi --print` / `-p` — non-interactive single-shot execution.
- `pi --session-dir <dir>`, `--no-session`, `--session-id`, `-c/--continue`,
  `-r/--resume` — session control usable by an editor client.
- SDK: `createAgentSession`, `ModelRuntime`, `SessionManager`, `AgentSession.subscribe`
  from `@earendil-works/pi-coding-agent` (`docs/sdk.md`).
- Package entrypoints: `bin.pi = dist/bundle/cli.js`, plus `./rpc-entry` and `./client` exports.
- gentle-pi is a native Go binary (`C:\Users\tapla\go\bin\gentle-ai`), invoked with
  subcommands such as `gentle-ai review mode status`.

## Tasks

### 1. Create ODD document and repository skeleton

- [x] ODD feature document created at `odd/tasks/picode-foundation.md`
- [x] Feature branch `feat/picode-foundation` created (default branch is `Master`)
- [x] Root `README.md`, `docs/`, `extensions/` skeleton

Commit: `993faab`

### 2. Define architecture and decisions

- [x] `docs/ARCHITECTURE.md` with the layered model, the RPC contract and rationale
- [x] `docs/DECISIONS.md` recording the seven decisions (ADR-001..ADR-007) and their trade-offs

Commit: `7d7df23`

### 3. Implement extension `picode-pi-chat` (pi RPC client)

- [x] Extension manifest, TypeScript config and build script
- [x] `PiRpcClient`: spawns `pi --mode rpc`, strict LF-only JSONL framing
- [x] Chat webview panel streaming text/thinking deltas and tool execution
- [x] Session control commands wired to the RPC commands

Commit: `6a73d71`

Verification (independent, against pi 0.86.1): `get_state` returned the live model
(`deepseek/deepseek-v4-pro`), 163 available models, 118 commands, concurrent id
correlation correct, invalid model rejected by the agent, bare model id rejected
client-side, `stop()` idempotent and post-stop sends rejected.

### 4. Document the VSCodium distribution strategy

- [ ] `docs/DISTRIBUTION.md`: branding via `product.json`, built-in extensions,
      Open VSX gallery, licensing constraints, and the Windows build pipeline

Commit: _pending_

### 5. Compile and verify the extension

- [x] `npm install` + TypeScript compile clean (`tsc -p ./` exit 0, zero errors)
- [ ] Extension packaging verified (`vsce package` or equivalent)

### 6. Work-unit commits

- [x] One Conventional Commit per task, on `feat/picode-foundation`

## Open questions

- Which pi provider/model should PiCode default to on first run?
- Should the pi panel ship enabled by default, or opt-in on first launch?
- Distribution: build from VSCodium source in CI, or maintain a patched-fork repo?
- Not yet verified at runtime: the webview layer (CSP, panel singleton, disposal)
  was not exercised in an Extension Development Host, only compiled and reviewed.
