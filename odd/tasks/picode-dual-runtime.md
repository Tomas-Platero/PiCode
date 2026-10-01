# Feature: PiCode dual runtime (RPC + embedded SDK)

## Goal
Let the owner choose how PiCode runs pi:
- `path` / `managed` / `custom` — the existing `pi --mode rpc` process (JSONL RPC).
- `embedded` — NEW: run pi in-process via the `@earendil-works/pi-coding-agent`
  SDK (`createAgentSession`), loading the owner's global pi config so it imports
  everything the installed pi brings (extensions, skills, prompts, themes,
  models.json, auth.json).

Both backends expose one `PiClient` interface; the chat view, menu and sessions
stay backend-agnostic.

## Product direction (locked, 2026-09-21)
- The owner chooses between RPC and the embedded SDK; both must work.
- The embedded SDK must import everything the installed pi brings via RPC.
- **Built-in providers**: PiCode ships its own default providers in the embedded
  SDK, independent of the owner's global config. The first one is **NaN**
  (`https://api.nan.builders/v1`, `api: openai-completions`, models from
  https://nan.builders/docs/pi). The key is read from the owner's `auth.json`
  (`nan`) when present. This must NOT be written into the owner's `~/.pi/agent`.

## Verified facts
- `@earendil-works/pi-coding-agent` (local 0.87.0) exports
  `createAgentSession({ cwd, agentDir })` → `{ session, extensionsResult }`.
  `agentDir` defaults to `~/.pi/agent`; the `DefaultResourceLoader` loads
  extensions, skills, prompts, themes, context files and the system prompt from it;
  the default `modelRuntime` reads `agentDir/models.json` and `agentDir/auth.json`.
- `AgentSession` API: `prompt`, `abort`, `setModel`, `cycleModel`,
  `cycleThinkingLevel`, `getAvailableThinkingLevels`, `dispose`,
  `subscribe(listener: (event: AgentSessionEvent) => void)`.
- `AgentSessionEvent` is the same union the RPC serialises, so the SDK client can
  translate it to our `PiEvent` almost one-to-one.
- The package is ESM-only (`exports["."].import`), so the CommonJS extension loads
  it with dynamic `import()`.

## Decisions (locked)
- Default stays `path` (RPC). `embedded` is opt-in until proven on this machine.
- **Transport is a separate axis from the runtime.** `picode.pi.runtime` keeps
  choosing *which* pi (`path`/`managed`/`custom`); the new `picode.pi.transport`
  chooses *how* PiCode talks to it (`rpc`/`embedded`). That is what makes the
  embedded backend load the owner's own pi rather than a second copy.
- **No built-in provider overlay.** NaN turned out to be a native pi provider,
  served from pi's own catalogue and cached in `~/.pi/agent/models-store.json`
  next to `deepseek`, `openai-codex` and `opencode`. Verified live: both
  transports already list 12 `nan` entries (`deepseek-v4-flash`, `glm5.3-flash`,
  `qwen3.8-flash`, `mimo-v2.5`, `gemma4`, `qwen3.6`, plus embedding, whisper,
  rerank, kokoro, flux and minimax), and a prompt through
  `nan/deepseek-v4-flash` answered using the owner's existing `auth.json` key.
  An inline `pi.registerProvider("nan", ...)` is therefore dead code whose model
  list the native definition overrides, and it would hide whatever upstream
  publishes next. Nothing is written to the owner's config.
- The embedded backend composes through `createAgentSessionServices` +
  `createAgentSessionFromServices`, not `createAgentSession`: only the services
  step applies the providers the owner's extensions register, without which the
  session cannot resolve its configured default model.

## Tasks
1. **PiClient interface** — DONE (`3caaabc`). `src/pi-client.ts` declares the
   contract and `PiSubscription`; `PiRpcClient implements PiClient`; the view, the
   menu and every session helper are typed against the interface.
2. **Embedded transport resolution** — DONE (`feb609d`). `PiTransport`,
   `picode.pi.transport`, `findSdkEntry`/`resolveSdkEntry`, and
   `embeddedAvailable` on the runtime descriptor.
3. **`PiSdkClient`** — DONE (`1d2295c`). Dynamic `import()` of the SDK entry;
   services composition with the owner's agentDir; `AgentSessionEvent` translated
   to `PiEvent` by a pure module whose test pins it to `PANEL_EVENT_TYPES`;
   every `PiClient` method implemented; no provider overlay (see above).
4. **Host wiring** — `extension.ts` constructs SDK vs RPC from the transport
   setting; make model/thinking/commands/state/session flows backend-agnostic.
5. **Runtime picker UI** — the picker shows which pi runs and how PiCode talks to
   it; the embedded choice is offered only when `embeddedAvailable`.
6. **Tests** — DONE for 1–3 (hermetic: `runtime` 19, `pi-sdk-protocol` 30; live:
   `test:sdk` 9). Wiring and picker coverage lands with 4–5.

## Out of scope (this feature)
Rich output (Mermaid, diffs), sessions as editor tabs, SCM commit/PR generation,
notifications, dictation, and the VS Code-native redesign. Each becomes its own
feature after the runtime foundation lands.

## Evidence
- Work-unit commits on `feat/picode-distribution` (or a new branch off it), one per task.
- `npm test` green after every task.
