# PiCode × pi-durable — experimental proofs

A self-contained program that runs `@earendil-works/pi-durable` (1.0.2) against the
owner's LAN gateway **OmniRoute** and proves, with real runs, the three promises that
justify replacing what `gentle-ai` provided:

1. **A conversation survives the process being killed and continues where it stopped.**
2. **A subagent is a background task that does not block the parent conversation.**
3. **Two clients can attach to the same live conversation at once.**

## Layout

| Path | Purpose |
|---|---|
| `lib/profile.js` | Reads the pi agent profile **read-only** (`%LOCALAPPDATA%/Programs/PiCode/data/pi-agent/models.json`) and builds a pi-ai provider for the `omni` provider found there (OpenAI-Responses API, `baseUrl http://192.168.1.65:20128/v1`). If the profile ever contains a key for the provider (in its `auth.json`), it is used **at runtime, never copied**. The gateway is keyless (`auth: "none"`); pi-ai's `openai-responses` API refuses a request with no key at all, so a clearly non-secret placeholder is sent — the gateway accepts any bearer on the chat endpoint. |
| `lib/common.js` | Harness setup: models, registry (`CodingTools` + proof extensions), SQLite storage under `.data/`, per-conversation `NodeExecutionEnv`. Also `resetDatabase()`. |
| `lib/extensions.js` | `slow_step` tool (a deterministic 2 s tool, `replay: "safe"`) and the background subagent: a `subagent` tool that spawns a **background anchor task** owning a child conversation, drives it, and reports its answer back to the parent as a follow-up input. |
| `proof1-kill.js` / `proof1-resume.js` | Proof 1, phases A and B. |
| `proof2-subagent.js` | Proof 2. |
| `proof3-two-clients.js` | Proof 3. |
| `smoke.js` | One-question sanity check of the gateway chain. |

Language: **plain ESM JavaScript**, run directly by Node (v24) — no build step, no
type-stripping edge cases. Everything the program writes goes to `.data/` (gitignored).

**One database per proof** (`proof1.sqlite`, `proof2.sqlite`, `proof3.sqlite`); each
proof deletes its own file (+ `-shm`/`-wal`) when it starts, so a retry always begins
from a clean slate.

The provider profile is only ever **read**; the harness writes its SQLite under
`experimental/durable/.data/`.

## Running the proofs

From `experimental/durable/` (Node ≥ 24; developed on Node 24.19.0, Windows + Git Bash):

```bash
npm install   # once: @earendil-works/pi-durable, pi-ai, chord
```

### Proof 1 — crash survival (`harness.resume()`)

Phase A starts a six-step durable run (six `slow_step` tool calls, ~40 s of work) and
prints the real PID to kill. Kill it **forcibly mid-run** (Windows equivalent of
`kill -9`):

```bash
node proof1-kill.js > .data/proof1-kill.log 2>&1 &
sleep 10
WINPID=$(node -e "console.log(require('./.data/proof1.json').pid)")
taskkill //F //PID $WINPID
cat .data/proof1-kill.log
```

Phase B reopens the same SQLite file and resumes:

```bash
node proof1-resume.js
```

Expected: phase A shows 2 of 6 tool rounds committed, then the forced kill; phase B
lists the surviving entries, calls `harness.resume()`, and the same submission settles
with `FINAL ANSWER: RUN-COMPLETED-AFTER-RESUME` and all 16 transcript entries.

### Proof 2 — subagent as a background task

```bash
node proof2-subagent.js
```

Expected: the parent spawns the subagent through the real model/tool path (run settles
in a few seconds — the spawn tool returns immediately), the task graph shows
`proof.subagent-run … background` owning a child conversation (`pi.generation … owner=conversation 14`),
the parent answers a second input (`PARENT-NOT-BLOCKED`) in ~1.5 s **while the child is
still working**, and the child's answer later arrives as `Background subagent report:
SUBAGENT-WORK-DONE`, which the parent acknowledges.

### Proof 3 — two clients, one live conversation

```bash
node proof3-two-clients.js
```

Expected: client A attaches before the run (snapshot `entries=0`), client B joins
mid-run (snapshot shows the in-flight run), and both receive the live event stream to
the end (A ≈ 56 events, B ≈ 40 — B joined later). Note: one process owns a storage at
a time, so "two clients" is two `watchEvents` attachments on one harness — the
supported shape for two UI panels; a multi-process variant would need a relay.

## Environment overrides

- `PI_AGENT_PROFILE` — profile directory (default: the portable PiCode profile).
- `PI_AGENT_PROVIDER` / `PI_AGENT_MODEL` — provider id / model id from the profile
  (defaults: `omni` / `auto`).
