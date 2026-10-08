# PiCode × pi-durable — experimental proofs

A self-contained program that runs `@earendil-works/pi-durable` (1.0.2) against the
owner's LAN gateway **OmniRoute** and proves, with real runs, the three promises that
justify replacing what came before it:

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
node cli.js serve [--no-mcp] [--no-guard]      # become the ONE owner of sessions.sqlite; serve local clients
node cli.js run "<prompt>" [--agent <name>] [--model provider/model] [--no-mcp] [--no-guard]   # NEW conversation, owned by THIS process
node cli.js sessions                               # list conversations (through the daemon when it is up)
node cli.js resume <id> "<prompt>" [--agent <name>] [--model provider/model] [--no-mcp] [--no-guard] # continue an existing conversation
node cli.js fork <id> "<prompt>" [--agent <name>] [--model provider/model] [--no-mcp] [--no-guard]   # fork at the newest entry, run the prompt on the fork
node cli.js send [id] "<prompt>" [--agent <name>] [--model provider/model]   # run a prompt THROUGH the daemon
node cli.js attach <id>                            # follow a conversation's LIVE events, Ctrl+C to detach
node cli.js allow <id> "<exact command>"            # guard opt-in (see below)
node cli.js acp                                    # speak ACP (the Agent Client Protocol) over stdio
node cli.js stop                                   # ask the daemon to shut down gracefully
```

### PiCode settings (`picode.durable.*`)

The agent's options live in **PiCode's own settings** (Settings > PiCode > Durable agent
(experimental), declared in `picode-source/src/vs/workbench/contrib/picode/browser/picodeConfiguration.ts`),
not only as CLI flags — a flag that is the only way to set an option is a setting that does
not exist. `lib/settings.js` reads the editor's user settings file
(`%APPDATA%/PiCode/User/settings.json`, override with `PICODE_USER_SETTINGS`)
**read-only** and picks out the `picode.durable.*` keys; reading the file directly is
deliberate, because this program is not inside the editor yet.

| Setting | Type | Default | What it does to the agent |
| --- | --- | --- | --- |
| `picode.durable.mcp` | boolean | `true` | The MCP bridge (off is today's `--no-mcp`). |
| `picode.durable.guard` | boolean | `true` | The deterministic guard (off is the new `--no-guard`; until this setting existed the guard was always on). |
| `picode.durable.model` | string | `omni/auto` | The model, as `provider/model` (today's `PI_AGENT_MODEL`/`PI_AGENT_PROVIDER`). |
| `picode.durable.agent` | string | *(empty)* | The profile agent name (today's `--agent`). |

**Precedence: command-line flag > setting > built-in default.** For the model only,
`PI_AGENT_MODEL`/`PI_AGENT_PROVIDER` sit between the setting and the default
(flag > setting > env > default), because the environment variables are the override the
experiment has always had.

Where every effective option came from is printed on stderr, one line per option, so
nobody has to guess why the agent behaved as it did:

```text
[settings] mcp=off (picode.durable.mcp)
[settings] guard=on (default)
[settings] model=omni/auto (--model)
[settings] agent=reviewer (--agent)
```

A missing settings file, unreadable JSON, or a key of the wrong type falls back to the
default **and says so** on its own `[settings]` line — it never crashes and never
silently ignores a typo'd setting:

```text
[settings] no PiCode settings file at C:\...\PiCode\User\settings.json — defaults in effect
[settings] picode.durable.model: expected string, got number — ignored, default in effect
```

### `run`

Creates a conversation (ownership `ownerless`, model `omni/auto` unless overridden by
`picode.durable.model`, `--model`, or `PI_AGENT_MODEL`), submits the prompt, streams the
assistant text, and exits when the run settles. The stderr epilogue prints the conversation
id and the `resume` command to continue it. Verified run:

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

### The daemon: one owner, many clients

pi-durable's spec allows **one process to own a storage at a time**, and its watches are
fed by same-process commits only. Measured on this version (1.0.2): a second process can
still open the same SQLite and read AND write it — the invariant is not machine-enforced —
but doing so is undefined behaviour, and it is real: two writers independently allocated
the same conversation id (`ID 368 already belongs to conversation`), after which the
daemon's session refused every operation (`Session is poisoned by a failed commit after
storage admission; reopen it`) until it was restarted. So the CLI makes the rule explicit
instead of waiting for SQLite to care:

- **`node cli.js serve`** opens the ONE shared `sessions.sqlite` and becomes its single
  owner (the guard, skills and MCP bridge are set up once, at daemon startup — the
  `[settings]`/`[mcp]` lines print there). It listens on a **local-only** endpoint:
  a Windows named pipe (`\\.\pipe\picode-durable-agent`) or a Unix domain socket
  (`.data/durable.sock`) — never a TCP port, because a process that runs the owner's
  tools must not be reachable off the machine.
- **Clients never open the database.** `attach`, `send`, `sessions` and `allow` talk to
  the daemon. Several client processes can be attached at once — that is the point.
- A direct `run`/`resume`/`fork` while a daemon owns the storage is refused with a
  sentence that says what to do instead (no raw SQLite error), and a second `serve`
  fails cleanly (`another daemon already owns sessions.sqlite …`).
- `sessions` goes **through the daemon when it is up** (a second harness would violate
  the one-owner rule) and **opens the database directly when it is not** (nothing owns
  it then, and the listing must work even with no daemon). It prints which way it went.
- `allow` follows the same daemon-first rule (a write must go through the owner).
- **The daemon's life is its spawner's life.** It is spawned ATTACHED (never `detached`,
  never a background service), and a spawner that means it holds the daemon's stdin open
  without ever writing to it and passes `PICODE_PARENT_PIPE=1`: when that pipe reads EOF —
  the spawner died in any way, hooks or no hooks — the daemon stops ITSELF through the same
  graceful path as the `shutdown` method. Nothing is polled and no pid is checked, so a
  reused pid cannot keep a dead spawner's daemon alive; on Windows libuv's per-child job
  object additionally terminates the child with the parent (the behaviour `detached: true`
  used to escape). What survives is the state, never the process — see
  `node proof-editor-lifecycle.js`.

Verified in one script — `bash proof-daemon.sh` (see "Proving the daemon" below).

### The protocol

NDJSON over the local endpoint: every message is one JSON object on one line.
A client sends requests; the daemon answers them and, for subscriptions, pushes events
without being asked. The event payloads are durable's own `AgentEvent`s, relayed
unchanged — the protocol is a thin transport, not a second API.

```text
client → daemon request:  {"id": <number>, "method": "<name>", "params": {…}}
daemon → client response: {"id": <number>, "ok": true, "result": {…}}
                       or {"id": <number>, "ok": false, "error": "<reason>"}
daemon → client event (no id, pushed):
                          {"event": "events", "conversationId": <id>, "events": [……]}
```

Methods:

| Method | Params | Result |
| --- | --- | --- |
| `ping` | — | `{protocol, pid, uptimeMs, streams}` — liveness. |
| `sessions` | — | `{conversations: [{id, entries, newest, note}]}` — the same rows as the CLI table. |
| `open` | `{conversationId?, model?, agent?}` | `{conversationId}` — resolves an existing conversation or creates one (ownerless; model per params or the daemon's resolved default; MCP deferral armed). |
| `run` | `{conversationId, prompt, model?, agent?}` | `{conversationId, status, answer}` — submits the prompt and settles; all subscribers of that conversation receive the events live. |
| `fork` | `{conversationId, prompt, model?, agent?}` | `{conversationId, forkedFrom, status, answer}` — forks at the newest entry, runs the prompt on the fork. |
| `allow` | `{conversationId, command}` | `{conversationId, allowed: [..]}` — guard opt-in; the same list `node cli.js allow` shows. |
| `subscribe` | `{conversationId}` | `{conversationId, snapshot}` — the response carries the conversation's snapshot; every later commit is pushed to this client as an `events` line until it disconnects or unsubscribes. |
| `unsubscribe` | `{conversationId}` | `{conversationId, unsubscribed: true}`. |
| `shutdown` | — | `{stopping: true}` — the daemon closes its streams, checkpoints the storage, stops the MCP bridge and exits (exposed as `node cli.js stop`). |

Events (pushed to subscribers only):

| Event | Payload | Meaning |
| --- | --- | --- |
| `events` | `{events: [AgentEvent…]}` | one durable `AgentEvent` batch per commit: `snapshot`, `run_start`/`run_end`, `turn_start`/`turn_end`, `message_start`/`message_update` (text deltas)/`message_end`, `tool_execution_start`/`_update`/`_end`, `entry_appended`, `inbox_update`, `submission`, `auto_retry_start`/`auto_retry_end`, `deferred_poll`, `agent_changed`, `usage_changed`, `task_failed`, `compaction_start`/`compaction_end`. |

The snapshot itself travels in the `subscribe` response (`result.snapshot`), not as an
event.

This protocol is deliberately small and local; an editor panel that wanted to embed the
agent would eventually speak ACP rather than this one — that is future work, not this
experiment. One client is already shaped like a panel: `send` subscribes to its own
conversation before submitting, so the client that starts a run sees it live.

When no daemon is running, a client says so plainly and does not hang — the connect is
bounded (3 s) and the message names the endpoint and the command that starts the daemon:

```text
$ node cli.js attach 403
error: no durable daemon is running at \\.\pipe\picode-durable-agent — start it with: node cli.js serve
```

### `send` — a prompt through the daemon

`node cli.js send [id] "<prompt>"` subscribes to the conversation (new if no id), then
asks the daemon to run the prompt. Output is shaped exactly like `run`: the answer on
stdout, tool activity on stderr. The `--model`/`--agent` flags travel with the request;
`--no-mcp`/`--no-guard` are daemon-level choices (`node cli.js serve --no-mcp`) — the
daemon decides them once at startup and every client runs what it offers.

```text
$ node cli.js send "Reply with exactly: DAEMON-OK"
[send] through the daemon at \\.\pipe\picode-durable-agent
[conversation] 403
DAEMON-OK

[run settled]
[hint] continue through the daemon with: node cli.js send 403 "<prompt>"
```

### `attach` — live, not polled

`attach` used to poll the shared SQLite once a second, because watches do not cross
processes. With the daemon owning the storage, `attach` is a client: it subscribes,
replays the snapshot, then prints each committed entry (`[user]`, `[assistant]` with its
tool calls, `[tool result]`) **as the commit lands**, from any number of processes at
once. Two separate attach processes watching the same run mid-flight were verified by
`bash proof-daemon.sh`.

### ACP: the editor protocol

`node cli.js acp` turns this agent into a standard **ACP (Agent Client Protocol) agent** over
stdio — the protocol Zed and JetBrains speak — so an editor panel drives the durable agent
with a protocol that has a spec instead of the local NDJSON one. It is implemented in
`lib/acp.js` with the authoritative typed definitions from `@agentclientprotocol/sdk` (the
endpoint is a daemon CLIENT, like `send` and `attach`; it never opens the storage), and
proven by `experimental/acp-client/` with `bash proof-acp.sh` (ends `PROOF-ACP-OK`).

**v1, not the v2 draft.** v1 is what existing clients speak, and the SDK itself marks v2 as
an unstable draft whose wire protocol "may change incompatibly in any SDK release". The
parts of the v2 lifecycle that matter are already in v1.7: streaming flows through
`session/update` while the turn is in flight (the `session/prompt` response only carries
`stopReason`), and `session/load` folds resume into session setup.

| ACP (v1) | Where it lands in the durable agent |
| --- | --- |
| `initialize` | The endpoint's capabilities (`loadSession`, `sessionCapabilities.list`; no image/audio/embeddedContext). |
| `session/new` | daemon `open` — a new ownerless conversation — plus `subscribe` and `permissions.listen`. The conversation id IS the session id. |
| `session/load` | daemon `open <id>` + `subscribe`; the snapshot is replayed to the client as `session/update` notifications (user/assistant text, tool calls with their results). |
| `session/list` | daemon `sessions` — the same rows as `node cli.js sessions`. |
| `session/prompt` | daemon `run`; while the run is in flight, durable's live agent events are mapped to `session/update` (`text_delta` → `agent_message_chunk`, `thinking_delta` → `agent_thought_chunk`, tool execution → `tool_call`/`tool_call_update`). The settle status maps to the response's `stopReason` (`done` → `end_turn`). |
| `session/cancel` | daemon `cancel` — `Conversation.abort()`; the waiting run settles and the endpoint answers `stopReason: "cancelled"`. |
| `session/request_permission` | The guard's destructive-command verdicts are **offered to the client for a decision instead of being silently blocked**: the daemon pushes a `permission` event (`permissions.listen` / `permissions.decide` are its two halves), the endpoint turns it into a real ACP permission round-trip, `allow_always` adds the exact command to the conversation's allow list (the same list `node cli.js allow` maintains). With no listener registered the guard blocks deterministically, exactly as before. |
| `authenticate`, `session/set_mode`, `session/fork`, `fs/*`, `terminal/*` | Not implemented and not advertised (no `authMethods`, no mode/fork capabilities; tools run inside the daemon, so client-side fs/terminal are never requested). |

A client's `cwd` in `session/new` is recorded but tools execute in the **daemon's** working
directory — the one the daemon process was started in — because the execution environment is
the daemon's, not the endpoint's.

### Proving the daemon

`bash proof-daemon.sh` (from `experimental/durable/`) runs the whole story with real
processes and prints the evidence: it starts its own daemon, is refused a direct `run`,
creates a conversation through the daemon, attaches TWO separate client processes, runs a
second prompt through the daemon while both watch (both logs show the live tool calls and
the final `DAEMON-LIVE`), stops the daemon through the protocol, and shows a client
started with no daemon up failing fast with the plain message. Raw logs land in
`.data/daemon-proof/` (gitignored). It ends with `PROOF-DAEMON-OK` when every step held.

### The deterministic guard

The guard can be turned off with `--no-guard` or `picode.durable.guard: false` (the flag
wins) — then `makeGuardExtension({ enabled: false })` installs no hook and the agent's
system prompt carries no guard section. Off means off: nothing blocks a destructive
command but you.

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
its `skills/` registered; nothing registered it any more. The
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

### MCP: the servers the owner already has

Durable ships no MCP client, and pi gets most of its reach from MCP, so this was the widest
gap. `lib/mcp.js` reads the profile's `mcp.json` (**read-only**) and connects with **pi's own
MCP library** (`@earendil-works/pi-mcp@1.0.2`), so the transports are the ones the owner
already lives with. Every server tool becomes a durable tool named `mcp__<server>__<tool>`
(anything that is not a letter, a digit or `_` becomes `_`, as pi does it).

What it found on this machine — **11 configured, 8 connected, 174 tools**:

| Server | Tools | Note |
| --- | --- | --- |
| aikido | 10 | stdio |
| codegraph | 1 | stdio |
| engram | 19 | stdio |
| firebase | 62 | stdio |
| github | 46 | streamable HTTP, authenticates through its configured `Authorization` header |
| repomix | 6 | stdio |
| sequential-thinking | 1 | stdio |
| supabase-mcp-server | 29 | stdio |
| atlassian-rovo-mcp | — | `no stored sign-in` (see below) |
| sentry | — | `no stored sign-in` (see below) |
| vercel | — | `no stored sign-in` (see below) |

**PiCode's own profile is the only place credentials are read from.** The three that need
OAuth look for a sign-in in the profile in force — `data/pi-agent/mcp-auth.json`, next to the
`mcp.json` this bridge already reads — and say plainly when there is none:

```text
[mcp] sentry: NOT CONNECTED (no stored sign-in — PiCode's own profile needs a sign-in for "sentry", and nothing signs in there yet)
```

The external pi's directory is **neither read nor written**: the rule is that `~/.pi` is never
touched, for storing or for reading, so a sign-in that only exists there does not exist here.
That rule has a visible cost — `sentry` connected with 14 tools while a token from the external
pi was still being borrowed, and it does not any more — and that cost is the point.

**Credentials are used READ-ONLY and never refreshed**, which is also deliberate. OAuth servers
commonly ROTATE refresh tokens on use, so a refresh would invalidate the grant the profile holds
whether or not the new tokens were kept. A token is sent only while it is still valid; the
store's `save()` throws, so the OAuth flow is unreachable by design and a future attempt to
persist fails loudly instead of quietly. Nothing signs into that profile yet, and the failure
line says so rather than pointing at a command that would sign into some other pi.

A server that is down is reported rather than quietly dropped from the list, and `firebase`
shows why that matters: it timed out on one run and connected with 62 tools on the next.
The connection is flaky; the bridge is not.

#### The size problem, solved by not declaring them

Those 174 tools declared would be **≈ 238.7 KiB of schemas in every single request**. So they
are not declared. Durable has the mechanism for exactly this (spec 7.3): a conversation may
carry a `tools` **filter**, and a tool result may ask for names through `control.addTools`,
which the generation's tools phase adds to that filter — offered from the next preparation
on, with no prompt-cache invalidation.

The conversation therefore starts with every MCP tool filtered out and `mcp_tools` in its
place, and prints both numbers every time:

```text
[mcp] 11 server(s) configured (profile mcp.json)
[mcp] oauth credentials: READ-ONLY from C:\Users\tapla\AppData\Local\Programs\PiCode\data\pi-agent\mcp-auth.json (never written, never refreshed)
[mcp] aikido: connected, 10 tools
[mcp] codegraph: connected, 1 tools
[mcp] firebase: connected, 62 tools
[mcp] github: connected, 46 tools
[mcp] sentry: NOT CONNECTED (no stored sign-in — PiCode's own profile needs a sign-in for "sentry", and nothing signs in there yet)
[mcp] prompt cost: all 174 tool(s) declared ≈ 238.7 KiB; deferred ≈ 1.1 KiB
```

That is the whole argument for the deferral, measured rather than asserted: **238.7 KiB → 1.1
KiB**, in one request you are not paying, and the number is printed every run instead of
being quoted from a plan.

And end to end, the model using one of them — note that nothing in the prompt named
`mcp__codegraph__codegraph_explore` until the search put it there:

```text
[conversation] 269

[tool] mcp_tools {"query":"codegraph"}
[tool result] codegraph (connected):
  mcp__codegraph__codegraph_explore — PRIMARY TOOL — call FIRST for almost any question …

[tool] mcp__codegraph__codegraph_explore {"query":"number of symbols"}
[tool result] **Exploration: number of symbols** — Found 57 symbols across 5 files. …
```

That run answered `57` on stdout. The tool it called was not offered, and could not have
been: it was taken out of the conversation's filter at creation and put back by the search.

The OAuth path itself was proven end to end **before** the internal-only rule, while a token
from the external pi was still being borrowed: the model searched, called
`mcp__sentry__find_organizations`, and answered with the owner's real organization. That run
is not reproducible on this machine any more, and saying so is the honest price of not reading
`~/.pi`: it will reproduce as soon as PiCode's own profile has a sign-in, which nothing does
yet.

**Replay.** Durable's `replay` policy decides what happens to a call that a crash
interrupted: `"safe"` reruns it, the default (`"unsafe"`) does not and the model is told
the call was interrupted. A read-only MCP tool is safe to rerun; anything else must not be
executed twice behind the owner's back. So it follows the server's own `readOnlyHint`
annotation, and **only a positive one** — a server that does not annotate its tools gets the
cautious treatment. `lib/mcp.js` says which way each tool went rather than relying on the
default, so it reads without knowing the spec. (The daemon connects all of this **once**
at startup — every `send` through the daemon reuses the same bridge instead of
reconnecting 11 servers per run.)

**Opt out** with `--no-mcp` or `picode.durable.mcp: false` (the flag wins).

**Limits, said plainly:** `${VAR}` in `env`/`headers` is expanded as pi expands it; a
`!command` value is **not** run — building a credential by shelling out is not something
this experiment should do unasked. The guard's `beforeTool` hook runs for MCP tool calls
like any other, but its rules today name `bash` and the file tools, so an MCP call passes
unless a rule names it.

## Layout (original proofs)

| Path | Purpose |
| --- | --- |
| `cli.js` | Headless agent CLI (see above): `serve` / `run` / `sessions` / `resume` / `fork` / `send` / `attach` / `allow` / `stop` on the shared `sessions.sqlite`. |
| `lib/guard.js` | Deterministic destructive-command guard: a `ToolTask.beforeTool` hook plus the per-conversation `app.guard` allow document. |
| `lib/skills.js` | Profile `skills/` loader (read-only), the `<skills>` index section, and the `load_skill` tool. |
| `lib/agents.js` | Profile `agents/*.md` loader (read-only) backing `--agent`. |
| `lib/profile.js` | Reads the pi agent profile **read-only** (`%LOCALAPPDATA%/Programs/PiCode/data/pi-agent/models.json`) and builds a pi-ai provider for the `omni` provider found there (OpenAI-Responses API, `baseUrl http://192.168.1.65:20128/v1`). If the profile ever contains a key for the provider (in its `auth.json`), it is used **at runtime, never copied**. The gateway is keyless (`auth: "none"`); pi-ai's `openai-responses` API refuses a request with no key at all, so a clearly non-secret placeholder is sent — the gateway accepts any bearer on the chat endpoint. |
| `lib/settings.js` | PiCode's settings, read-only (`%APPDATA%/PiCode/User/settings.json`, override with `PICODE_USER_SETTINGS`): picks the `picode.durable.*` keys, applies flag > setting > default, reports every effective option and every fallback on stderr. |
| `lib/common.js` | Harness setup: models, registry (`CodingTools` + proof extensions), SQLite storage under `.data/`, per-conversation `NodeExecutionEnv`. Also `SHARED_DB` and `listConversations()` (the `sessions` rows, used by the daemon and the direct fallback). Also `resetDatabase()`. |
| `lib/daemon.js` | The daemon: owns `sessions.sqlite`, serves the protocol on the local endpoint, one `watchEvents` per conversation fanned out to every subscriber, runs `open`/`run`/`fork`/`allow`/`cancel`/`permissions.*` inside the owner process. |
| `lib/protocol.js` | The wire format: the local endpoint (named pipe / UDS), NDJSON framing (`LineStream`), endpoint liveness probe. |
| `lib/client.js` | The client side: bounded connect (`DaemonUnavailableError` when no daemon — plain message, no hang), request/response matching, pushed-event listeners. |
| `lib/render.js` | Agent events and transcript entries → CLI output, shared by the in-process `runPrompt` and the daemon clients (`send`, `attach`). |
| `lib/acp.js` | The ACP entry point: the Agent Client Protocol (v1) over stdio, mapped onto the daemon (see "ACP: the editor protocol"). |
| `proof-daemon.sh` | Reproducible multi-process evidence for the daemon (see "Proving the daemon"). |
| `proof-acp.sh` | Reproducible evidence for the ACP endpoint via `experimental/acp-client/` (see "ACP: the editor protocol"). |
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
supported shape for two UI panels; the multi-process variant now exists — the daemon
(see "The daemon: one owner, many clients") is that relay, with proof3's single-process
watch pair unchanged as the minimal shape.

## Environment overrides

- `PI_AGENT_PROFILE` — profile directory (default: the portable PiCode profile).
- `PI_AGENT_PROVIDER` / `PI_AGENT_MODEL` — provider id / model id from the profile.
  For the model these sit **below** the `picode.durable.model` setting (flag > setting >
  env > default); they are still the way to override one run without touching settings.
