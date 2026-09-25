# Feature: PiCode agent panel — **SUPERADO**

> **Cerrada como superada el 2026-09-24, por decisión del dueño.**
>
> Esta feature pedía **construir un panel propio** —«un chat nuevo, no el mismo que el de VS
> Code»— con la extensión como dueña de la superficie. El dueño ha decidido lo contrario:
> **pi es el host de agentes del core** y la extensión se retira (ver
> `picode-pi-agent-host.md`). Construir este panel sería hacer justo lo que hay que
desmontar.
>
> **Lo que NO se pierde, porque no era de la superficie sino del producto.** Los requisitos
> de abajo siguen queriéndose; cambia **dónde** viven:
>
> | Requisito de esta feature | Dónde va ahora |
> | --- | --- |
> | Contexto del editor (proyecto, fichero abierto, selección, problemas, diff) | El chat del core |
> | Estadísticas de pi (modelo, tokens, coste, presión de contexto) | El chat del core |
> | Comandos de pi y de gentle-pi como acciones | El chat del core |
> | Sesiones: listar, retomar, bifurcar, compactar | El chat del core |
> | La interfaz de referencia con estimación de coste y quitables | El chat del core |
>
> Las tareas sin marcar de abajo **no se hacen aquí**: se trasladan. Quedan sin marcar a
> propósito, para que se lea que nunca se hicieron *como panel*, no para que alguien las
> retome en la extensión.
>
> Y una nota de precisión sobre la dirección vieja: decía que el chat del editor «este
> producto lo vacía». Eso ya no es cierto — el chat nativo **es** pi. Es exactamente la
> suposición que esta decisión invierte.

## Goal

Build the agent surface PiCode owns: a new chat panel, not a copy of the VS Code
chat, that can be extended over time. It must give pi the editor context the
agent needs to be useful, and give the user pi's runtime statistics.

## Product direction (locked by the product owner, 2026-09-21)

> "Quiero evolucionar la extensión, quiero un chat integrado como el de VS Code
> de agentes y tal, no quiero el mismo, quiero uno nuevo y que podamos mejorarlo,
> para añadir estadísticas de pi y obtener contexto del editor, todo lo posible,
> como el área de trabajo o el proyecto o un archivo abierto para poder referirnos
> a él."

Decoded into requirements:

1. **A new panel we own.** Not the native VS Code chat surface, not a visual copy
   of it. A surface designed for pi, that PiCode can extend.
2. **Editor context as first-class input.** The workspace/project, an open file,
   a selection, diagnostics and the current diff must be referenceable from the
   composer, the way Antigravity and the Codex/opencode/T3-family clients let a
   user attach context.
3. **pi runtime statistics.** Model, tokens, cost, context-window pressure, turn
   and tool counts, latency.

This is the differentiating layer of PiCode: layers 1-2 are plumbing, this is the
product.

## Inherited state

`extensions/picode-pi-chat` already implements the hard part of the plumbing:

- `pi-rpc-client.ts` — spawns `pi --mode rpc`, strict LF-only JSONL framing
  (ADR-005), request/response correlation by `id`, idempotent shutdown.
- `protocol.ts` — typed commands and events shared with the webview.
- `chat-panel.ts` + `media/` — a working panel that renders text and thinking
  deltas and tool execution.

What it does **not** have yet: editor context, runtime statistics, a
slash-command surface, session management, and a layout designed for the agent
rather than for a demonstration.

## Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Surface | A panel we own (webview), driven by `pi --mode rpc` | ADR-003: process isolation, version independence, a stable protocol boundary |
| Surface location | A native view in the **secondary side bar** (right), declared with `contributes.viewsContainers.secondarySidebar` | The product owner asked for the pi chat to live natively in the right sidebar. VSCodium 1.135 supports the location declaratively: its `viewsContainers` schema accepts `activitybar`, `panel` and `secondarySidebar`, and the registry assigns each a distinct container location. Declaring it beats asking the user to drag a container across, which would depend on per-workspace UI state and would not survive a fresh profile |
| Host type | `WebviewViewProvider`, not the editor-tab `WebviewPanel` the first implementation used | A tab panel is not a sidebar view. The provider is resolved by the editor when the container becomes visible, which also keeps activation opt-in (ADR-009) |
| Context model | Explicit references the user attaches, not implicit injection | Predictability, and it keeps the token budget visible before sending |
| Statistics source | The RPC state and event stream only | No new integration surface, no invented protocol (ADR-006) |

## Task list

### 1. Move the panel into the secondary side bar — DONE

The first implementation opened a `WebviewPanel` in an editor tab. It is now a
`WebviewViewProvider` in a container declared in `secondarySidebar`, and the
message protocol is unchanged, so the renderer needed no edit at all.

- [x] Manifest declares a `secondarySidebar` container and a `webview` view in it
- [x] `ChatView` implements `WebviewViewProvider`, with context retained while hidden
- [x] The view starts pi only when the view resolves, so nothing starts at startup
- [x] The `open` command reveals the view (`<viewId>.focus`, with the container
      command as a fallback)
- [x] Styling adapted to a narrow sidebar and to the sidebar background variable
- [x] Session commands still reach the view when it is not visible
- [x] Compiled, staged into the built-in extension, and started with no console error

Commits: `9c707ce` (the view), `556b41f` (start exactly once)

**The location is declarative, and that was verified before relying on it.**
`viewsContainers` accepts `activitybar`, `panel` and `secondarySidebar`, and the
registry assigns each a distinct container location, so the container is born in
the right sidebar instead of depending on a user dragging it there, which would
depend on per-workspace UI state.

**Verified end to end, without asking the owner to click anything.** The editor
has no command-line way to open a view, and `onView` activation means nothing
observable happens until one is shown, so a temporary built-in extension focused
the view on startup and logged the result outside the extension host log. With
that helper:

- `ExtensionService#_doActivateExtension picode.picode-pi-chat, startup: false,
  activationEvent: 'onView:picode.piChat'` — the view resolved, it activated the
  extension, and nothing activated it at startup.
- exactly one `pi --mode rpc` process tree, using the shim path the client
documents: `cmd.exe /d /s /c "pi --mode rpc"` wrapping
  `node …\pi-coding-agent\dist\bundle\cli.js --mode rpc`.
- zero `Uncaught` and zero `TypeError` in the console log, and an empty
  `window1/views.log`.

The helper was then removed, and a normal launch still activated the view from
the restored layout, which is the state the editor is left in for the owner.

**Defect found by running it: two agents per open.** The first run spawned two
`pi --mode rpc` process trees. Two causes, both fixed in `556b41f`: `getClient()`
re-entered `bindClient()` through `view.rebind()`, and `start()` was a
check-then-act that two concurrent callers both passed because the started flag
is only set after an await. The second is the interesting one: it predates this
task and would have fired for any concurrent caller, and two agents in one
workspace means two processes writing files.

**A note for future process cleanup.** A script that matches pi processes by the
package name alone also matches the interactive pi session that is running it —
which killed the session mid-command during this task. Filter on `--mode rpc`.

Commit: pending

### 2. Editor context providers

Providers for the workspace/project, the active file, the current selection, open
editors, diagnostics, and the working-tree diff, each attachable to the composer
as a reference with a token estimate.

- [ ] Provider interface defined, with one provider implemented end to end
- [ ] Workspace/project and active-file providers implemented
- [ ] Selection, diagnostics and working-tree-diff providers implemented
- [ ] References render in the composer with a token estimate and are removable

Commit: pending

### 3. pi runtime statistics

Model, tokens (in/out/cached), cost, context-window pressure, turn and tool
counts, and latency, derived from `get_state` plus the event stream.

- [ ] Statistics derived from `get_state` and the event stream
- [ ] Statistics surface implemented and documented

Commit: pending

### 4. Command and session surface

The `get_commands` catalogue (pi and gentle-pi slash commands) as first-class
actions, plus session list/resume/fork/compact.

- [ ] `get_commands` catalogue exposed as first-class actions
- [ ] Session list, resume, fork and compact wired to the RPC commands

Commit: pending

### 5. Verification and documentation

- [ ] Panel exercised inside the built-in install, not only in an Extension
      Development Host, with recorded evidence
- [ ] Surface documented

Commit: pending

## Open questions

- How much of the transcript should be persisted in the webview versus replayed
  from `get_messages` on reopen?
- Which context providers need a token estimate before pi can report one?
- Resolved: the chat lives in its own container (`picode`) in the secondary side
  bar, not in the VSCodium chat container, which this product empties.
- The view has no title-bar actions yet. The toolbar inside the webview carries
  New and Stop, so a `view/title` menu is a refinement rather than a gap.
