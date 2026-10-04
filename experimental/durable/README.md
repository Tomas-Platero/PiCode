# PiCode × pi-durable — experimental proofs

A self-contained program that runs `@earendil-works/pi-durable` (1.0.2) against the
owner's LAN gateway **OmniRoute** and proves, with real runs, the three promises that
justify replacing what `gentle-ai` provided:

1. **A conversation survives the process being killed and continues where it stopped.**
2. **A subagent is a background task that does not block the parent conversation.**
3. **Two clients can attach to the same live conversation at once.**

## The CLI (`cli.js`)

A headless agent over the same provider chain. The CLI uses **one shared database**
(`.data/sessions.sqlite`): every conversation lives there and is reused across
process invocations — that is what makes durability visible. (The proofs keep their
own one-database-per-proof behaviour; nothing above changes.) Conversation and entry
ids are session-assigned integers.

The answer (and `attach` stream) goes to **stdout**; conversation ids, tool activity,
guard blocks, and hints go to **stderr**, so `node cli.js run "..." > answer.txt`
captures just the answer. All commands run from `experimental/durable/`.

```bash
node cli.js run "<prompt>" [--agent <name>]        # NEW conversation, stream the answer
node cli.js sessions                               # list conversations in sessions.sqlite
node cli.js resume <id> "<prompt>" [--agent <name>] # continue an existing conversation
node cli.js fork <id> "<prompt>" [--agent <name>]   # fork at the newest entry, run the prompt on the fork
node cli.js attach <id>                            # follow a conversation's entries live, Ctrl+C to detach
node cli.js allow <id> "<exact command>"            # guard opt-in (see below)
```

### `run`

Creates a conversation (ownership `ownerless`, model `omni/auto` unless overridden by
`PI_AGENT_MODEL`), submits the prompt, streams the assistant text, and exits when the
run settles. The stderr epilogue prints the conversation id and the `resume` command
to continue it. Verified run:

```text
$ node cli.js run "Reply with exactly: CLI-OK"
[conversation] 24
CLI-OK
[run settled]

[hint] resume with: node cli.js resume 24 "<prompt>"
```

### `sessions`

Scans the shared database and prints one line per conversation: id, entry count,
newest entry (a proxy for last activity), and its relation (`fork of …` or subagent).
Continuity across invocations is visible here — the entries appended by later `run`
and `resume` calls all land in the same file:

```text
$ node cli.js sessions
3 conversation(s) in sessions.sqlite
id      entries last activity           note
2       3       entry 12 (pi.assistant)
13      3       entry 23 (pi.assistant)
24      3       entry 34 (pi.assistant)
```

### `resume`

Reopens an existing conversation and submits the prompt; the model sees the whole
prior transcript. Verified — conversation 24 was first asked to reply `CLI-OK`, then
in a separate process:

```text
$ node cli.js resume 24 "What exact string did I ask you to reply with in my previous message? Answer with just that string."
CLI-OK
[run settled]
```

### `fork`

Forks at the newest entry (the fork sees the parent's history up to that entry and
gets a fresh provider session identity) and runs the prompt on the fork:

```text
$ node cli.js fork 24 "What exact string did I ask you to reply with? Then add: (FROM-THE-FORK)"
[fork] 24 @entry 38 → 39
CLI-OK (FROM-THE-FORK)
[run settled]
```

### `attach`

A second client on a live conversation. NOTE: `watchEvents` cannot cross processes
(one process owns a storage; watches are fed by same-process commits), so `attach`
.polls the shared SQLite **read-only** once a second — replaying the committed
history, then printing each new committed entry (user, assistant + tool calls, tool
results) as it lands. Run a long `resume` in another terminal and attach to its id:

```text
$ node cli.js attach 24
[attach] 24 — streaming committed entries; Ctrl+C to detach.
[user] Reply with exactly: CLI-OK
[assistant] CLI-OK
[user] Call the slow_step tool once: step 9, seconds 5. Then reply ATTACH-FIFTH-RUN.
[assistant] tool calls: slow_step({"step":9,"seconds":5}) —
[tool result] step 9: 5s left...
...
[assistant] ATTACH-FIFTH-RUN
```

### The deterministic guard

`lib/guard.js` installs an extension whose `hook(ToolTask, { beforeTool })` blocks
destructive commands **in code, before the tool runs** — the model is never asked and
cannot talk its way past it. Blocked:

- recursive deletes: `rm -r/-rf/--recursive`, `del /f /s`, `rd /s`, `rmdir /s`,
  `Remove-Item -Recurse -Force`
- history/branch destruction: `git push --force` (and `-f`, `--force-with-lease`),
  `git reset --hard`, `git clean -f`
- disk operations: `format`, `mkfs*`, `dd of=/dev/…`, `diskpart`
- any `write`/`edit` tool call (or bash redirection / `tee` target) resolving
  **outside the working directory**

A block returns `{ block: "<reason>" }`, so the model sees the reason and the block
lands in the transcript as an error tool result:

```text
$ node cli.js run 'Run this exact bash command (exactly as written, nothing else): rm -rf old-build-backup …'
[conversation] 64
[tool result] <harness>
[error] Tool call blocked: Blocked by the deterministic guard: recursive `rm` (rm -r / -rf / --recursive) deletes whole trees. The user can allow this exact command for this conversation with: node cli.js allow <conversationId> "rm -rf old-build-backup"
</harness>
```

**Explicit opt-in** is per-conversation and lives in a conversation document
(`app.guard`) holding exact command strings. `allow` appends one (whitespace-
normalized); a blocked call whose command matches an entry passes through:

```text
$ node cli.js allow 64 "rm -rf old-build-backup"
[guard] allowed for 64:
  rm -rf old-build-backup
$ node cli.js resume 64 "The command is now allowed. Run this exact bash command again …"
[tool] bash {"command":"rm -rf old-build-backup"}
```

(the same command that produced an error result before the `allow` now executes —
visible in the transcript: the second `pi.tool-result` has `isError: false`).

### Skills and agents

The pi profile (`%LOCALAPPDATA%/Programs/PiCode/data/pi-agent`, read-only) used to get
its `skills/` registered by the gentle install; nothing registered it any more. The
CLI wires it back in:

- **Skills** (`lib/skills.js`): every `skills/<dir>/SKILL.md` is read once at startup
  (frontmatter `name`/`description` + body). They are exposed as a `<skills>` index
  section in the system prompt (name: description per skill) plus a `load_skill` tool
  that returns one skill's full body. Only `SKILL.md` is surfaced; reference/ and
  evals/ folders stay unread. The profile currently contains: `agent-md-refactor`,
  `copywriting`, `discord-bot`, `find-skills`, `picode-release`, `vitest`.
- **Agents** (`lib/agents.js`): `--agent <name>` looks up `agents/<name>.md` in the
  profile, reads its frontmatter + body, and runs the conversation with the body as
  the conversation's `instructions`. **The profile currently has no `agents/` folder**
  (verified), so the loader returns an empty list and `--agent` fails with a clear
  message until the folder exists — no code change will be needed when it does:

```text
$ node cli.js run "hello" --agent reviewer
error: No agent "reviewer" in C:\Users\tapla\AppData\Local\Programs\PiCode\data\pi-agent\agents. Available: (none)
```

The guard and skills extensions are installed only by the CLI (via
`openHarness({ extensions: [...] })`); the proofs' registry — and therefore their
golden transcript expectations — is untouched.

## Layout (original proofs)

| Path | Purpose |
|---|---|
| `cli.js` | Headless agent CLI (see above): `run` / `sessions` / `resume` / `fork` / `attach` / `allow` on the shared `sessions.sqlite`. |
| `lib/guard.js` | Deterministic destructive-command guard: a `ToolTask.beforeTool` hook plus the per-conversation `app.guard` allow document. |
| `lib/skills.js` | Profile `skills/` loader (read-only), the `<skills>` index section, and the `load_skill` tool. |
| `lib/agents.js` | Profile `agents/*.md` loader (read-only) backing `--agent`. |
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
