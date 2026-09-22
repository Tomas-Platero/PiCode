# Feature: the PiCode UI program

## Goal

The owner's nine-area request, run as one program in four phases. Every phase is its
own reviewable work unit; this document is the program's record: the decisions that
were locked, the verified facts behind them, the per-phase task lists, and the
evidence.

## Decisions locked by the owner (2026-09-22, via questionnaire)

| Question | Answer |
| --- | --- |
| Where to start | **Fase 1**, then all four phases in order, without further questions |
| The interactive UI bridge | **Build `extension_ui_request` handling** — pi's designed way to ask the host for select/input/confirm, which is what logins and OAuth ride on |
| Skills on/off | **Only package-provided skills**, written through pi's own resource filters. No PiCode-owned enable list |
| MCP config target | **A scope selector**: global in the agent dir and project in `.mcp.json` |

Two interpretations recorded here because the owner is not available to confirm them:

- **`Acción` in the packages table** loses Pausar/Reanudar and keeps **Eliminar**
  (the request says "en vez de la acción actual"); pausing stays on the Estado
  toggle, which was always the switch for it.
- **The merged category is labelled "Analítica"** exactly as asked, with a
  description that spells out what it holds (thinking level, compaction, retries)
  so the label does not have to carry that meaning alone. The objection that those
  three are not analytics is on the record in the report.

## Verified facts that shape the program

Gathered read-only on 2026-09-22, against pi 0.86.1 and the installed packages.

1. **The category deep links are a bug, not missing work.** `media/ajustes.js`
   posts `openSettings(category)` → `ajustes-view.ts` → `extension.ts:148` →
   `SettingsView.show(startAt)` → `state.selected` in `media/settings.js`. The
   plumbing is complete; the **ids disagree**: the sidebar uses
   `src/menu.ts`'s `PiCategoryId` (`modelo | extensiones | runtime | proveedores |
   gentle | sesion`) while the settings rail uses `src/pi-settings.ts`'s ids
   (`estado | picode | modelo | razonamiento | compactacion | reintentos | red |
   herramientas | paquetes | skills | apariencia | sesion`). Four of six land on
   nothing, which is why the tab "just opens" and the owner has to search.
2. **`extension_ui_request` is declared and never handled.** Its only occurrence in
   the extension is `src/protocol.ts:352`. That is pi's UI-neutral bridge for
   select/input/confirm, used by `/login`, provider selection and MCP OAuth.
3. **pi has no per-skill enable/disable.** `settings-manager.d.ts` offers
   `skills?: string[]` (paths), `enableSkillCommands`, and per-package resource
   filters: `PackageSource = string | { source, autoload?, extensions?, skills?,
   prompts?, themes? }`. `pi config` is the TUI for exactly that.
4. **MCP configuration has six candidate paths**; pi core has no MCP at all and the
   `pi-mcp-adapter` package owns the format: `mcpServers` entries of
   `{ command, args, env }` or `{ url, headers, auth, oauth }`. `env` values are
   plaintext — the owner's real `~/.pi/agent/mcp.json` holds live tokens.
5. **pi.dev/packages** lists 5652 packages, 50 per page, with a "Recently
   published" section, type tags (`extension`, `skill`, `prompt`, `theme`,
   combined, fallback `package`), monthly downloads, age, npm/repo links and the
   install command. Our `src/pi-cli.ts searchCatalog()` (npm registry, keyword
   `pi-package`) returns name/version/description/downloads/repository but **no
   type tag**, which is the catalog's one open question.
6. **Custom models** live in `~/.pi/agent/models.json` (providers → `baseUrl`,
   `api`, `auth`, `models[]` with `cost`, `contextWindow`, `compat`), and
   credentials in `~/.pi/agent/auth.json`. `pi auth` only *inspects*; the login is
   the interactive `/login`.
7. **Hot reload cannot be total**: packages, transport, runtime and cache warming
   need a pi restart, which the settings rows already declare as `needsRestart`.
8. **There is no first-run notion today.** Nothing records "the owner has already
   chosen", and no wizard exists. The pieces the wizard needs do exist separately:
   `picode.pi.runtime` (`path | managed | custom`) plus `picode.pi.executablePath`,
   `runtime.json` (the version pin for the managed pi), and `installSource()` in
   `src/menu.ts`, which runs `pi install` after a modal that names the exact command
   — required, because pi's docs say packages run with full system access. Gentle AI
   is two npm packages on this machine, `gentle-pi` (the orchestrator: ODD, SDD
   skills) and `gentle-engram` (the memory provider), and the installed
   `gentle-pi/assets/gentle-logo-only.png` is the only brand mark shipped today.

## Phases and tasks

### Fase 1 — identity, navigation, cleanup, sessions

| Task | Where |
| --- | --- |
| 1a. The chat's empty state shows the PiCode mark instead of a generic glyph | `media/main.js`, `media/main.css`, `src/chat-view.ts` |
| 1b. A Gentle AI entry in the activity bar with **its own** settings panel | `package.json`, `src/gentle-view.ts` (new), `media/gentle.{js,css}` (new), `src/extension.ts`, `media/ajustes.js` |
| 2. The six sidebar categories become deep links into the settings tab | `src/menu.ts`, `src/ajustes-view.ts`, `src/extension.ts` |
| 3.3. Paquetes y recursos keeps only the packages table | `src/pi-settings.ts`, `media/settings.js` |
| 5. Compactación + Razonamiento + Reintentos become one "Analítica" category | `src/pi-settings.ts` |
| 6. "Cargando sesión…" while a previous session loads, and a way back to the list | `media/main.js`, `media/main.css`, `src/chat-view.ts` |
| 10. The initial-setup wizard: pi runtime and Gentle AI, both linked natively, and repeatable later | new `src/onboarding.ts`, new `media/onboarding.{js,css}` (new webview), `src/extension.ts`, `package.json`, `src/pi-settings.ts` |

Task 10 in detail, because it is the one that must leave the editor in a working
state and not half-configured:

- **When it runs.** On activation, when there is no previous configuration:
  a `globalState` marker for "the wizard already ran", plus a check that no pi can
  be resolved. Never on top of a working setup.
- **Question 1 — which pi**: the system `path` pi, PiCode's own `managed` pi, or a
  `custom` path/version. It writes `picode.pi.runtime` and, when needed,
  `picode.pi.executablePath` — the three modes `src/runtime.ts` already resolves.
- **Question 2 — Gentle AI**: yes installs the layer (`pi install npm:gentle-pi` and
  `npm:gentle-engram`) through the existing consent modal that names the exact
  command; no leaves the option available later from the settings row without any
  reinstall.
- **The end state is linked, not merely chosen**: the resolved pi is the one the
  chat and the settings tab use, the skills the layer brought are visible in the
  Skills category, and the Gentle AI panel from task 1b shows its state. That is the
  difference this task has to deliver — the owner's words: "integradas de forma
  nativa dentro del editor desde ese momento, no como algo que haya que configurar
  aparte después".
- **Repeatable.** A settings row ("Repetir configuración inicial") and the palette
  command open the same wizard at any time, so changing the pi runtime or turning
  Gentle AI on later needs no reinstall.

The deep-link mapping the fix must implement:

| Sidebar id | Destination |
| --- | --- |
| `modelo` | settings rail `modelo` |
| `extensiones` | settings rail `paquetes` |
| `runtime` | settings rail `picode` |
| `proveedores` | settings rail `modelo` until Fase 4 gives credentials their own section |
| `gentle` | the new Gentle AI panel (task 1b), not the settings tab |
| `sesion` | settings rail `sesion` |

### Fase 2 — skills and hot reload

| Task | Where |
| --- | --- |
| 3.1. Skills as a table (name, description, origin, on/off) with automatic origins only | `src/pi-settings.ts`, new `media/skill-rows.js`, `media/settings.js`, `media/settings.css` |
| 3.2. A live `/` dropdown in the chat composer with the available skills | `media/main.js`, `media/main.css`, `src/chat-view.ts`, `src/protocol.ts` |
| 7. Settings changes apply immediately wherever pi allows it, and say so where it does not | `src/settings-view.ts`, `src/pi-settings.ts`, `media/settings.js` |

### Fase 3 — catalog and MCP

| Task | Where |
| --- | --- |
| 3.4. A Catalog tab replicating pi.dev/packages: search, type filter, downloads sort, "Recently published", paginated cards, install | `src/pi-cli.ts`, `src/settings-view.ts`, new `media/catalog.js`, `media/settings.js`, `media/settings.css` |
| 9. An MCP section: a table like the packages one, plus a manual add form, with a global/project scope selector | new `src/mcp-config.ts`, `src/settings-view.ts`, `media/settings.js`, `media/settings.css` |

### Fase 4 — the UI bridge, models, auth and import

| Task | Where |
| --- | --- |
| 4.0. Handle `extension_ui_request`: select, input, confirm, progress, cancel | `src/protocol.ts`, `src/pi-rpc-client.ts`, `src/chat-view.ts`, `media/main.js`, `media/main.css` |
| 4.1. Custom providers and models written to `models.json` | new `src/models-config.ts`, `src/settings-view.ts`, `media/*` |
| 4.2. Provider login: OAuth through the bridge, and API-key entry | new `src/auth-config.ts`, `src/settings-view.ts`, `media/*` |
| 8. Update the bundled pi/SDK, and import an existing pi installation | `src/runtime.ts`, `src/extensions-view.ts` or the settings tab, `src/pi-cli.ts` |

## Out of scope (this program)

Pushing, pull requests and releases. Rewriting pi's own TUI surfaces. Any change to
pi's credential *format*: PiCode reads and writes the files pi already owns, through
pi's own APIs where they exist.

## Evidence

- Work-unit commits on the feature branch, one per phase task group, starting with a
  salvage commit for the pre-existing uncommitted options-surface work this program
  builds on.
- `npm test` green after every work unit, with the per-suite counts recorded.
