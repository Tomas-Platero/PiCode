# durable-bridge — pi stays the driver, durable does the surviving

A pi extension (TypeScript, loaded by path — **nothing is installed into any pi**,
and no pi directory is written) that bridges the coding agent you use every day
to the headless durable daemon in [`picode-source/durable/`](../durable/).

The two runtimes still do not compose — one conversation runs on one engine, and
this does not change that. What the bridge adds is a **handoff**: pi can hand a
piece of work to the durable daemon, and the daemon owns it from then on. The
work runs **inside the daemon's process**; if pi is killed mid-work, the daemon
finishes the conversation and commits the answer to its SQLite. A later pi — the
same one or a brand-new process — can read the finished conversation back.

## 🧰 The three tools it registers

| Tool | What it does |
| --- | --- |
| `durable_send` | Hands a prompt to the durable daemon (`open` + `run` over the protocol) and returns the daemon's answer. The run settles in the daemon: killing pi does not stop it, and there is deliberately no cancel — durability is the point. `conversationId` continues an existing durable conversation. |
| `durable_list` | Lists the daemon's conversations (id, entries, last activity). |
| `durable_read` | Reads one durable conversation's transcript (subscribe snapshot → entry lines → unsubscribe). |

If the daemon is not running, every tool fails fast (bounded 3 s connect) with a
plain message naming the endpoint and the start command — it never hangs.

## 🖱️ How to run each piece by hand

Start the daemon (the single owner of `picode-source/durable/.data/sessions.sqlite`):

```bash
node picode-source/durable/cli.js serve          # or: serve --no-mcp (faster, offline)
```

Load the extension into **PiCode's internal pi** (the runtime in PiCode's
`resources/pi-runtime`, the profile in PiCode's `data/pi-agent` — the external
`~/.pi` install is never read or written; `PI_CODING_AGENT_DIR` points pi at the
internal profile and `PI_CODING_AGENT_SESSION_DIR` keeps session files here):

```bash
PI_CODING_AGENT_DIR="C:/Users/tapla/AppData/Local/Programs/PiCode/data/pi-agent" \
PI_CODING_AGENT_SESSION_DIR="picode-source/durable-bridge/.data/pi-sessions" \
node "C:/Users/tapla/AppData/Local/Programs/PiCode/resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" \
  --extension picode-source/durable-bridge/extension.ts
```

Then, in pi: *"Call durable_send with the prompt: run slow_step six times…"*,
*"list the durable conversations"*, *"read durable conversation 570"*.

The one-command proof (kill-and-survive, real `taskkill`):

```bash
node picode-source/durable-bridge/proof-kill-survive.mjs
```

It starts the daemon if none is up, starts pi with the extension, waits until
the durable run is in flight inside the daemon, kills pi's whole process tree
mid-work, waits for the daemon to finish, then starts a fresh pi that reads the
finished conversation with `durable_list`/`durable_read`. Prints
`PROOF-BRIDGE-OK` and exits 0 when every step held. Logs land in
`.data/` (gitignored).

## 🧠 Implementation notes

- **Wire format is reused, not reimplemented.** The extension imports
  `../durable/lib/client.js` and `lib/protocol.js` by relative path, and
  `describeEntry` from `lib/render.js` for transcript rendering. Because
  `protocol.js` shares the durable CLI's `DATA_DIR` through `lib/common.js`,
  importing them transitively loads the durable libraries into pi's process —
  load-only: nothing opens, connects, or writes at import time; connections are
  per tool call.
- The bridge directory has **no node_modules of its own** (nothing may be
  installed), so the one bare specifier it needs — `Type`, for tool parameter
  schemas — is imported deep from the durable checkout's own copy:
  `../durable/node_modules/@earendil-works/pi-ai/dist/index.js`. Same copy the
  daemon uses; no duplicate TypeBox.
- Language: **TypeScript** (pi runs extensions through jiti — no build step).
- Scratch: this directory's own `.data/` (gitignored), including pi session
  files. The durable conversations live in the **daemon's** database — the
  daemon is the only process that ever opens it; the bridge never touches it.

## ⚖️ What the hybrid gives — and what it does not

**Gives:**

- Work that must survive a crash can be **delegated** to an engine where the
  crash-safety is already proven (six `slow_step` steps, real kill, answer
  intact — see the proof output in the task report).
- pi keeps its role as the daily driver — its tools, its session, its UX — and
  gains a remote-control channel to the durable side, including the daemon's
  MCP servers and its guard, without pi loading any of that.
- Several pis (or editors, or CLIs) can hand work to and read from **one**
  durable owner at once; the daemon protocol already fans events out to every
  subscriber.

**Does not give:**

- **pi's own session is still not crash-proof.** If pi dies, its own
  conversation, its in-flight reasoning and its uncommitted context are gone.
  Only what it *delegated* survives. The bridge moves work, not pi's session.
- **No ACP.** The bridge speaks the durable daemon's own local NDJSON protocol;
  an editor that wanted to embed the agent properly would eventually speak ACP
  (that is future work in `picode-source/durable/`, not here).
- **One owner of the SQLite, always.** The daemon must be the only process
  opening `sessions.sqlite` — two writers corrupt ids (verified in the durable
  README). The bridge is a pure client and must stay one.
- **No cancellation.** Once handed off, a durable run cannot be cancelled from
  pi; the daemon has no cancel method. Kill-happy users: don't hand off work
  you might want back.
- The extension's import chain loads the durable libraries into pi's process
  (see above). Harmless, but it is not a zero-footprint link.
