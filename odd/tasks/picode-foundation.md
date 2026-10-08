# Feature: PiCode foundation

## Goal

Establish the foundation of PiCode: a lightweight, rebranded VS Code distribution
(based on VSCodium) for Windows that ships with the pi coding agent integrated as a
first-class built-in experience.

## Decisions (locked)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Distribution approach | Distribution layered on top of VS Code/VSCodium, not a full `microsoft/vscode` fork | A full fork is a multi-GB, yarn + native-modules + Electron build with a slow cycle; it contradicts the "lightweight" objective |
| Upstream base | VSCodium | MIT-licensed community build, no telemetry or Microsoft branding; redistributable under our own "PiCode" brand |
| pi integration (MVP) | A PiCode extension with a pi panel that drives the pi CLI | This is the differentiating core; `pi --mode rpc` already exposes an IDE-embedding protocol |
| Platform (MVP) | Windows | Matches the development machine; allows local iteration and validation before multi-OS CI |
| Distribution depth | Layer on VSCodium **without compiling** (ADR-008) | A fork build needs Python 3.11, rustup, jq and MSVC Build Tools — none present — plus ~40-60 GB and 30-90 min builds and patch rebasing per upstream release. The fork path is deferred, not rejected |
| Panel behaviour | Opt-in, never auto-opened (ADR-009) | Predictability and non-intrusiveness; an agent-first editor still has to be a good editor |
| pi version | Pin and ship pi (ADR-010) | Reproducibility across users, with a setting to override |

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

- [x] `docs/DISTRIBUTION.md`: branding via `product.json`, built-in extensions,
      Open VSX gallery, licensing constraints, and the Windows build pipeline
- [x] `distribution/` scaffold: branding overlay, default settings, idempotent
      preview-by-default bootstrap script, operator runbook

Commit: `2f8b856`

Two measurement corrections came out of this task, both to the parent's own
earlier claims: the VSCodium user data path derives from `nameShort` (not
`dataFolderName`), and the MSVC Build Tools are **absent** on this machine — the
`2022` directories are empty, there is no `vswhere.exe`, no `cl` and no Windows
SDK. The parent had inferred their presence from directory names alone.

### 5. Compile and verify the extension

- [x] `npm install` + TypeScript compile clean (`tsc -p ./` exit 0, zero errors)
- [x] Extension packaging verified (`vsce package` or equivalent)

Packaging was executed with `npx --yes @vscode/vsce package`, producing
`extensions/picode-pi-chat/picode-pi-chat-0.1.0.vsix`. The first run exposed a
real defect — the VSIX was shipping `.atl/`, an internal tooling cache unrelated
to the extension, plus `.gitignore` and `package-lock.json`. After fixing
`.vscodeignore` and adding the repository field and a package-level MIT LICENSE,
the archive was inspected independently and now holds 11 entries with none of
those files. Both `vsce` warnings are gone.

### 6. Install VSCodium and apply the PiCode branding (runtime verification)

Executed on this machine, 2026-09-20. The evidence is runtime observation, so no
commit is attributed to this task.

- [x] VSCodium installed via winget, exit 0: `winget install -e --id
      VSCodium.VSCodium --accept-package-agreements --accept-source-agreements
      --disable-interactivity` → version `1.126.04524`, installed at
      `%LOCALAPPDATA%\Programs\VSCodium` (CLI at `bin\codium.cmd`)
- [x] `distribution/bootstrap.ps1` preview run → exit 0, created nothing
- [x] `distribution/bootstrap.ps1 -Apply` → exit 0; created `%APPDATA%\VSCodium`
      (it did not exist before) and wrote the branding overlay to
      `%APPDATA%\VSCodium\product.json`
- [x] Extension installed from `extensions/picode-pi-chat/picode-pi-chat-0.1.0.vsix`
      (codium: "Extension 'picode-pi-chat-0.1.0.vsix' was successfully
      installed."); `codium --list-extensions` returns exactly
      `picode.picode-pi-chat`
- [x] Default settings written to `%APPDATA%\VSCodium\User\settings.json`
- [x] pi `0.86.1` reported as already installed and skipped
- [x] **Branding confirmed at runtime:** `codium --help` prints
      `PiCode — Agentic Code Editor 1.126.04524` as its first line, which is the
      overlay's `nameLong`; the same output's usage line still reads
      `Usage: codium.exe [options] [paths...]`, so the executable name is
      unchanged.

### 7. Work-unit commits

- [x] One Conventional Commit per task, on `feat/picode-foundation`

## Verified fact map (pi)

Produced by a read-only reconnaissance pass over the installed packages. These
facts were verified against files on this machine and constrain the design.

### pi (`@earendil-works/pi-coding-agent` 0.86.1)

- `engines.node >= 22.19.0`. PiCode's own requirement should match, not the
  looser 20+ currently stated in the root README.
- `exports`: `.`, `./rpc-entry`, `./client`, `./experimental/plugin`.
- A typed `RpcClient` is **exported** from the package, alongside `runRpcMode`.
  The extension deliberately hand-rolls its own client to stay dependency-free
  (an extension cannot cheaply depend on pi's own modules); the exported client
  is the reference implementation to compare against if the framing ever drifts.
- Confirmed **absent**: ACP / agent-client-protocol, a built-in MCP server, and
  any LSP server in the core. `docs/usage.md` states pi intentionally ships no
  built-in MCP. This confirms that RPC is the only editor-integration surface,
  which validates ADR-003.
- Confirmed **absent**: any existing pi extension that integrates an editor, and
  any `vscode` reference in the pi sources. PiCode would be first.
- Flag parser: `dist/cli/args.js`; extensions may register additional flags.

**Implication for the panel**: the RPC `get_commands` call already returned 118
commands in live testing, which includes slash commands from installed packages.
The panel can offer them as first-class actions without learning anything about
any specific package — the discovery path is generic.

## Open questions

Resolved by the human in this session: the panel is opt-in; pi is pinned and
shipped; the distribution layers on VSCodium without compiling.

Resolved by measurement (2026-09-20, task 6): the branding overlay **was**
observed at runtime against VSCodium `1.126.04524` — `codium --help` prints
`PiCode — Agentic Code Editor 1.126.04524` as its first line — so the overlay
path and the deep-merge are no longer derived-only. The same pass installed the
extension from the VSIX, so the deferred-install route is proven as far as
installation goes.

Still open:

- Which pi provider/model should PiCode default to on first run? The bootstrap
  wrote `picode.pi.defaultModel` empty, so the default is still undecided.
- Not yet verified at runtime: the webview layer (CSP, panel singleton, disposal)
  was not exercised in an Extension Development Host, only compiled and reviewed.
  The panel UI has never been opened in the editor.
- `picode://` is not registered. `reg query` for `HKCU\Software\Classes\picode`,
  `HKCU\Software\Classes\vscodium` and `HKCU\Software\Classes\codium` all
  return "not found". This is inconclusive rather than a failure, because VSCodium
  has never been launched and protocol registration plausibly happens on first
  run. Re-check after the first launch.
- The bootstrap script's `-Apply` path has now been executed once successfully on
  this machine (overlay written, VSIX installed, default settings copied). It has
  not been re-run, so idempotency against an already-configured machine is still
  unexercised.
- The Open VSX gallery override has not been queried from the Extensions view.
