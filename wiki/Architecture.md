# Architecture

PiCode is built in layers, each independently replaceable. That is what keeps
a "modified VS Code" lightweight instead of a monolithic fork.

```text
┌────────────────────────────────────────────────────────────┐
│ 4. Experience   PiCode defaults, first-run wizard,         │
│                 curated settings, portable profile         │
├────────────────────────────────────────────────────────────┤
│ 3. Agent        @pi in the editor Chat, the agent host,    │
│                 the connector, the customization hub       │
├────────────────────────────────────────────────────────────┤
│ 2. Runtime      Pi (pinned), Gentle AI packages,           │
│                 built-in extensions, Open VSX gallery      │
├────────────────────────────────────────────────────────────┤
│ 1. Editor       VS Code at the pinned commit + VSCodium    │
│                 patches + PiCode patches + product delta   │
└────────────────────────────────────────────────────────────┘
```

## Layer 1 — the editor, compiled from pinned source

The chain (see [Building PiCode](Building-PiCode.md) for commands):

```text
VS Code commit (upstream/stable.json)
  → patches/vscodium/**    (vendored verbatim: removes Microsoft identity,
                            telemetry, Copilot hooks, cloud, updater)
  → patches/picode/**      (PiCode's own source changes, numbered)
  → distribution/product-delta.json   (brand, gallery, pruned keys)
  → npm ci + gulp          → PiCode-Win32-x64/ or PiCode-linux-x64/
```

Key properties, all deliberate:

- **Product keys can be deleted, not just overridden.** That is what makes the
  Copilot and telemetry removal real. The old user-level `product.json`
  overlay could only restate keys — abandoned in
  [ADR-011](Decisions-Log.md#adr-011).
- **Compiled core used to be untouchable** (a `checksums` map over the bundle
  guards the binary path). On the source path the limit is lifted: patches are
  TypeScript against real source, and checksums are computed over the result.
- **Two residual truths** survive on the binary path: a hardcoded `code-oss`
  default in minified core still names Copilot (`chat.disableAIFeatures` is
  the effective switch), and keys that core iterates without a guard must be
  empty rather than absent.

## Layer 2 — the runtime

Pi is **pinned and shipped by PiCode**, never resolved from the user's PATH
([ADR-010](Decisions-Log.md#adr-010)): reproducible behaviour and meaningful
verification require knowing which agent version ran. `picode.pi.executablePath`
remains as the user's escape hatch. The managed Pi (~410 MB installed) is
fetched on demand, not carried in the archive.

Gentle AI arrives as Pi packages (`gentle-pi`, `gentle-engram`) installed
through Pi's own mechanism.

## Layer 3 — the agent integration

The pivot of the project (2026-09-24): **the surfaces are the editor's**.
There is no PiCode-owned panel, tab or settings page. Concretely:

- `@pi` is the **default chat participant** of the editor's own Chat, with
  ask/agent/edit modes.
- Pi runs **inside the core**, split by a technical boundary:
  - `src/vs/platform/agentHost/node/pi/` — the agent host: opens a Pi session
    and translates what the agent says and does into what the editor
    understands. This is the core process that genuinely has Node, and the
    same slot VS Code uses for its other agents.
  - `picode-source/extensions/picode/` — the **connector**: provider catalog,
    models, keys, profile. A built-in extension compiled with the editor. It
    draws nothing; anything needing UI goes to the core.
- Integration speaks Pi two ways: **RPC** (`pi --mode rpc`, JSONL with strict
  LF-only framing — Node's `readline` is not protocol-compliant because U+2028/
  U+2029 are legal inside JSON strings; [ADR-005](Decisions-Log.md#adr-005)) for
  the session, and the **Pi CLI** for what the protocol does not expose
  (package management, Gentle AI status).
- Editor **MCP servers are bridged into Pi** as custom tools invoked through
  the editor, so editor permissions and confirmations apply. No second MCP UI.

The retired webview panel (`extensions/picode-pi-chat`) lives on only until its
migration into the core finishes; its material is archived in `legacy/`.

## Layer 4 — the experience

- **Portable profile**: `data/` beside the executable — user data, extensions,
  and the Pi profile. Disposable by design; the cloud-sync unit later.
- **Nothing is written outside the profile.** Reading an external Pi profile
  is an offered option, never automatic.
- **English product copy**, always; other languages are language packs keyed
  over the English source ([ADR-012](Decisions-Log.md#adr-012)).

## Non-goals

- A custom language server for Pi.
- Our own agent loop — Pi owns agent behaviour; PiCode owns the surface.
- Reimplementing OAuth, providers, skills or the orchestrator.
- Reimplementing what the editor gives for free (native pickers, keyboard
  handling, accessibility).

---
Next: [The Patch System](The-Patch-System.md) · [Decisions Log](Decisions-Log.md)
