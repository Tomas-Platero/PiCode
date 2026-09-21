# Feature: PiCode panel configuration surface

## Goal

Everything pi exposes becomes reachable from PiCode's own surface: which runtime
runs, which model and thinking level are active, and which pi packages are
installed — including installing them from the catalog.

## Why

The owner asked for three things, in this order of emphasis:

1. "quiero poder elegir tmb si uso un pi nativo de este editor o uno externo que
   tenga yo instalado" — choose the runtime.
2. "quiero todo lo que tiene pi, configurar modelos, etc etc poder tmb elegirlos
   desde el panel; fijate en el que tiene vscode de agente" — model and
   configuration surface, following the shape of VS Code's agent chat.
3. "quiero poder configurar, o instalar extensiones de pi desde su repo" —
   package management from the catalog.

Today the extension runs whatever `pi` is on `PATH` (`picode.pi.executablePath`
defaults to `pi`), so the owner's globally installed pi is the only runtime. The
choice the owner asked for does not exist yet as an artifact.

## Verified facts that shaped this feature

Gathered 2026-09-21 against pi `0.86.1` and the installed distribution.

### The pi CLI is the only way to manage packages

`pi --help` documents a full package surface that the RPC protocol does **not**
expose: `pi install <source>`, `pi remove`, `pi update`, `pi list`, `pi config`,
`pi auth`. Sources are npm specs (`npm:pkg@1.2.3`), git refs
(`git:github.com/user/repo@v1`), or local paths. User scope writes
`~/.pi/agent/settings.json`; `-l` writes `.pi/settings.json`. Verified output of
`pi list` on this machine: ten user packages, each with its resolved path.

So package management is a **CLI integration**, not a protocol integration. This
is the first place where PiCode shells out to `pi` rather than driving it over
RPC.

### The catalog is queryable

- `https://pi.dev/packages` is the human gallery (5383 packages, tagged
  `pi-package`, with description, category, monthly downloads, npm and repo
  links, and the exact `pi install` command).
- The npm registry search API answers in JSON and needs no key:
  `https://registry.npmjs.org/-/v1/search?text=keywords:pi-package`.
  Verified: it returns the same packages with versions, descriptions,
  publishers, links and monthly download counts.

The registry API is the right backing for a package browser: it is machine
readable, stable, and does not require scraping HTML.

### The RPC surface is wider than the client implements

`docs/rpc.md` documents sections for Prompting, State, Model, Thinking, Queue
Modes, Compaction, Retry, Bash, Session and Commands. The extension's client
implements only `prompt`, `abort`, `new_session`, `get_state`,
`get_available_models`, `set_model` and `get_commands`.

Verified shapes for the Model and Thinking sections:

- `{"type":"set_model","provider":"…","modelId":"…"}` → the full Model object.
- `{"type":"cycle_model"}` → `{model, thinkingLevel, isScoped}`, `null` when only
  one model exists.
- `{"type":"get_available_models"}` → `{models: [...]}`.
- `{"type":"set_thinking_level","level":"…"}` — levels `off`, `minimal`, `low`,
  `medium`, `high`, `xhigh`, `max`; `xhigh` and `max` are exposed only when the
  selected model supports them.
- `{"type":"cycle_thinking_level"}` → `{level}`, `null` when the model has no
  reasoning support.
- `{"type":"get_available_thinking_levels"}` → `{levels: [...]}`, `["off"]` for a
  model without reasoning support.

### A bundled runtime cannot ship inside the archive

Measured on this machine:

| What | Size |
| --- | --- |
| `dist/` of the pi package (the bundled CLI) | 20 MB |
| `dist/bundle/chunks` | 8.2 MB |
| full installed package | 414 MB |
| of which `@esbuild/*` | 284 MB |
| a clean `--omit=dev` install | 410 MB |

The `dist`-only copy is **not** self-contained: running it without
`node_modules` fails with `Cannot find package '@earendil-works/chord'`. The
bundle also has optional bare requires for `@aws-sdk/signature-v4-crt`,
`bufferutil`, `utf-8-validate` and `supports-color`.

Rejected: copying `dist` alone into the distribution, because it does not run.
Rejected: shipping the full 410 MB inside the archive, because it doubles the
distribution for a runtime most users already have.

**Decision:** the managed runtime is installed on demand into the distribution's
own directory at a pinned version. It is PiCode-owned and reproducible, it is
isolated from the user's global install, and the archive does not carry a second
copy of Node's dependency tree.

### How the existing GUIs solve this

Researched at the owner's request. `pi-gui` (Electron, Codex-style), `Pi Desktop`
(pi-desktop.com, and three same-named repositories), `oh-my-pi-gui` (native
Windows), `pi-agent-desktop` and `pi-web-ui` converge on the same shape, and
`pi-gui`'s repository layout documents it most explicitly:

- a **model selector** in the composer, plus Settings sections for **Models**,
  **Providers**, **custom endpoints**, appearance and notifications;
- an **extensions view** and a **skills view** for managing what pi loads;
- a **session/thread** surface with archive, fork and tree modals;
- `@`-mentions and attachments in the composer;
- an inline diff viewer and an integrated terminal;
- pi's own JSONL session files as the source of truth, with the app as a UI shell
  around `@earendil-works/pi-coding-agent` rather than a second runtime.

The last point is a direct endorsement of ADR-003 and ADR-010: every serious pi
surface is a shell over upstream, never a reimplementation.

## Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Runtime selection | `picode.pi.runtime` with `path` (default), `managed`, `custom` | Keeps today's behaviour as the default, adds the choice the owner asked for, and leaves an escape hatch for an arbitrary binary |
| Managed runtime location | `<distribution root>/resources/pi-runtime`, pinned version | Inside the product, isolated from `~/.pi` and from the global npm prefix, removable by deleting one directory |
| Managed runtime delivery | Installed on demand from the panel, not shipped in the archive | 410 MB measured; the archive must not double |
| Model and thinking UI | Panel controls that open native VS Code quick picks | Matches VS Code's own agent chat, and reuses the editor's keyboard, filtering and accessibility instead of reimplementing them |
| Package catalogue | npm registry search API (`keywords:pi-package`) | Machine readable and keyless; the web gallery stays the human view |
| Package actions | Shell out to the `pi` CLI of the **active** runtime | The RPC protocol does not expose package management; using the active runtime keeps the pin meaningful |

## Task list

### C1. Runtime selection — DONE

- [x] `picode.pi.runtime` setting: `path` (default) | `managed` | `custom`
- [x] Host-side resolver reporting the active runtime, its path, its existence
      and its version
- [x] Panel control showing the active runtime and switching it in one action
- [x] One-action install of the pinned managed runtime, with streamed output
- [x] The agent spawns the selected runtime (verified: one process, correct binary)

Commit: `aea6da0`

**Verified end to end.** The extension activates with `onView:picode.piChat`, the
console log is clean, exactly one `pi --mode rpc` process tree exists, and the
PiCode output channel records `[pi] starting from path runtime: pi` — the
resolver reporting the mode the agent actually started from. The resolver itself
is covered by 11 checks (`npm test`), the first automated test in this
repository.

**The test earned its place immediately.** It caught the managed root being
derived three levels up instead of four: the extension sits at
`resources/app/extensions/<id>`, so the managed runtime would have installed
itself into `resources/resources/pi-runtime` and reported "not installed"
forever. That is invisible in review and only shows up when someone switches
runtime and the agent silently fails to start.

**Two decisions worth keeping.** The managed runtime is invoked as
`node <bundle>/cli.js` rather than through the npm `.cmd` shim, because Node
cannot execute a `.cmd` without a shell since the CVE-2024-27980 hardening and a
shell would make it depend on quoting for the distribution's location; that is
why the protocol client gained an argument prefix. And the installer quotes
arguments containing whitespace, because `spawn` concatenates instead of
escaping when it uses a shell.

Not yet exercised: the managed install itself, which downloads ~410 MB. Selecting
it shows a modal confirmation and streams npm output to the PiCode channel.

Commit: pending

### C2. Models and thinking — DONE

- [x] `set_thinking_level`, `cycle_thinking_level` and
      `get_available_thinking_levels` added to the RPC client (with `cycle_model`)
- [x] Model picker over `get_available_models`, grouped by provider, with a
      filter box because the catalogue runs to hundreds of entries
- [x] Reasoning-level picker over what the current model actually supports
- [x] Current model and reasoning level visible in the panel, each in its own
      control with its own dropdown
- [x] Switching a model updates the panel without restarting the process

Commit: `211717f`

**Two surfaces, one implementation.** The panel's controls open their own
dropdown inside the panel, in flow above the control so the panel's layout decides
the space; the palette commands keep the editor-wide quick pick, which is the
right surface when someone is typing rather than pointing. Both call the same
apply functions, so they log and report identically.

**The reasoning list comes from pi, not from the enum.** `set_thinking_level`
rejects a level the current model does not support, and `xhigh` / `max` exist only
for some models, so the picker offers `get_available_thinking_levels`. A live check
against the agent confirms `max` is accepted and sticks on this machine.

**Verified**: 18 checks pass (11 resolver, 7 markup); compile clean; a live agent
session answers all four commands; the editor starts with zero console errors; and
the output channel still reports the runtime the agent started from.

**Added beyond the plan**: `test/panel-dom.test.js`, which checks that every id the
panel script looks up exists in the markup. Renaming one in a single place gives a
null reference at load that turns the panel inert, and neither the compiler nor a
file-level review can see it because both files are individually valid.

**Spanish, by request.** All user-facing copy — panel, quick picks, notifications,
command titles and setting descriptions — is Spanish. Code, comments, commit
messages and the `[pi]` diagnostic log stay English, because the log is a
developer surface and mixing languages inside it would be worse than either
choice alone. The typos linter flags `comando` and `Argumentos` as misspellings of
English words; they are Spanish and correct.

Still open from the plan: usage (tokens and cost) in the panel, which is P3.

Commit: pending

### C3. Extensions

- [ ] Installed packages listed from `pi list` of the active runtime
- [ ] Catalog search over the npm registry (`keywords:pi-package`)
- [ ] Install, remove and update actions with streamed output
- [ ] Installed packages marked in the catalog results

Commit: pending

## Open questions

- Provider credentials: `pi auth` prints credentials and checks readiness but
  does not set them. Writing `~/.pi/agent/auth.json` from the panel is a real
  feature and a real secret-handling decision; it is deliberately not in C1-C3.
- Whether the model picker should also write `--models` cycling patterns, or only
  switch the session model.
- `pi config` is an interactive TUI, so per-resource enable/disable cannot be
  driven from the panel without parsing settings files directly.
