# Pi Inside

Pi is the agent that executes — the **Host**. PiCode ships one inside the
editor, keeps its configuration in PiCode's own profile, and can (optionally)
connect to an external one.

## Internal and external Pi

| | Internal (default) | External (opt-in) |
| --- | --- | --- |
| Where it lives | installed by PiCode, pinned version, profile under `data/` | the `pi` already on your machine |
| Who updates it | the editor (settings panel installs and updates it) | you, outside PiCode |
| Reads/writes | only PiCode's profile | used where its data is; **PiCode never writes to it** |
| Importing | — | a one-shot copy of its profile into PiCode's (`credentials unchecked by default`, sessions excluded) |

The direction is the one absolute rule: **nothing is ever written to the
external Pi.** Connecting uses it where it lives; bringing its configuration
over is an offered option that *copies*. A guard refuses switching to an empty
internal profile.

Which runtime runs is `picode.pi.runtime` (`path` | `managed` | `custom`);
how it is spoken to is the separate axis `picode.pi.transport` (`rpc` child
process over JSONL | `embedded` in-process SDK). Defaults: pinned managed
runtime via RPC; the embedded mode loads the same installation, not another
copy.

## Providers and models: nothing was built, everything is shown

Measured against the real installation: **41 providers**, of which **8 connect
with a subscription** (Anthropic Claude Pro/Max, OpenAI Codex/ChatGPT,
GitHub Copilot, xAI, Meta, Kimi, OpenRouter, Radius) — 7 of those also accept
an API key; the rest (OpenAI, Google, DeepSeek, Mistral, Groq, …, Bedrock,
Vertex) are key-based.

PiCode's job was to *teach* that catalog inside editor surfaces:

- **`Settings → PiCode → Providers`**: one row per provider. Subscriptions come
  from Pi's own list (logged-in ones marked); the four-box form adds a custom
  OpenAI-compatible endpoint (name, baseUrl, dialect, key). Declarations
  project into Pi's `models.json` / `auth.json` — literal keys only in the
  credentials file.
- **OAuth is never reimplemented**: Pi's own `login()` runs; the editor shows
  Pi's dialogs (browser return, device code for Meta, GitHub Enterprise for
  Copilot).
- **Resolution order** (Pi's): `--api-key` → `auth.json` → env var → provider
  key in `models.json`.
- The chat's model selector really drives the running Pi (`set_model` hot),
  and the thinking-level picker offers only what the current model supports.

**Known gap:** Pi's own models are not yet surfaced in the *editor's* core
model window (the connector work in progress), which is why `@pi` can still
answer "Language model unavailable" in a fresh core build. Tracked in
[Roadmap and Known State](Roadmap-and-Known-State.md).

## What Pi brings that PiCode does not touch

Skills (`SKILL.md` files), subagents (`.md` in `agents/`), prompt templates
(`prompts/*.md`, filename becomes `/command`), and packages
(`pi install npm:…` / `git:…`, declaring `extensions`/`skills`/`prompts`/
`themes` in `package.json`). Pi itself ships **no MCP support** — which is why
the editor's MCP servers are bridged in, next.

## MCP, bridged with the editor's permissions

Editor MCP tools are handed to Pi as custom tools that Pi calls **through the
editor** (`lm.invokeTool`), so the editor's permission prompts and
confirmations apply to agent tool calls. The session is rebuilt when the
server set changes; `picode.mcp.enabled` is on by default; there is **no
second MCP UI** — one datum, once.

## Sessions and history

Pi stores sessions as files in its profile (`sessions/`). The chat can list,
resume and fork them; the recovery of that surface into the core chat is part
of the open migration.

---
Next: [Gentle AI and ODD](Gentle-AI-and-ODD.md)
