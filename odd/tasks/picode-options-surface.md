# Feature: PiCode options surface

## Goal

Replace the chain of quick picks that today stands in for settings with a real
options surface: an editor tab laid out like the editor's own Settings, with a
search box, a category rail, and one row per setting carrying its own control.

Product direction (locked by the product owner, 2026-09-21):

> "me gustaría que, como cuando abres las opciones de vscode, se abra las opciones
> de pi en un nuevo modal o popup con las opciones categorizadas y mejor vista,
> ahora parece todo un desplegable."

Decoded:

1. **An editor tab**, not a floating dialog and not the sidebar: the owner picked
   the editor tab when asked, which is what VS Code's Settings does.
2. **Categorized, with room to breathe.** A rail of categories on the left, the
   rows of the selected category on the right, search at the top.
3. **It manages pi's settings, not only PiCode's.** The owner chose the widest
   scope when asked, so pi's own settings are part of it.

## What exists today

`menu.ts` walks the owner through `showQuickPick` levels: categories, then the
settings inside one, then a value picker. It also lists things that are not
settings at all — installed extensions, providers, the Gentle AI state, usage and
the session list — because a quick pick was the only surface available.

`ajustes-view.ts` is a sidebar card that renders the same category rows.

Both stay useful as a *shortcut* (the sidebar card, the palette command), but
neither is where the owner configures anything.

## What pi actually gives us (verified)

`SettingsManager` is exported by the pi SDK and is the same API pi's own
interface uses to read and write settings. It is not a JSON file we would be
editing by hand:

- `SettingsManager.create(cwd, agentDir?)`, `reload()`, `flush()`, `drainErrors()`.
- `getGlobalSettings()` / `getProjectSettings()` — a real **two-scope** model,
  which is why this surface gets a Global / Proyecto selector mirroring the
  editor's User / Workspace tabs.
- Typed getters and setters for every setting: default provider and model,
  default thinking level, per-model thinking levels, transport, compaction
  (enabled, reserve, keep-recent), branch summary, retries, HTTP and WebSocket
  timeouts, cache warming, provider retries, hidden thinking, shell path and
  command prefix, npm command, external editor, quiet startup, project trust,
  packages, extension / skill / prompt-template / theme paths, theme, steering and
  follow-up modes, telemetry and analytics, changelog collapse.
- Only some settings have a project variant (`setProjectPackages`,
  `setProjectExtensionPaths`, `setProjectSkillPaths`,
  `setProjectPromptTemplatePaths`, and the theme equivalent). A setting with no
  project setter is global-only, and the surface must say so rather than offer a
  control that cannot work.

**Writes go through the typed setters, never through the file.** The settings file
is shared with the pi CLI, so a hand-written patch would be this extension
inventing a format it does not own, and the setters already serialize correctly
against a running pi (`withLock`).

## Decisions (locked)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Surface | A `WebviewPanel` editor tab | What the editor does for Settings; keeps the chat panel free, and has the width a settings UI needs |
| Layout | Search bar, category rail on the left, rows on the right | The owner asked for VS Code's own arrangement |
| Scope | A Global / Proyecto selector, with unavailable scopes stated | pi's model is two-scoped; showing only the scope that exists is the honest version |
| Writes | `SettingsManager` setters only | The file belongs to pi; the typed API is pi's own write path |
| Styling | Only `--vscode-*` variables, the codicon set already vendored | Same rule as the chat panel: any theme works, no palette of our own |
| Entry points | `picode.piChat.menu`, the sidebar card, and the panel's gear button all open the tab | One destination; the old quick picks stop being a parallel universe |
| Health | Read-only "Estado" category keeps what the quick pick showed (version, runtime, transport, providers, packages, sessions, usage, Gentle AI) | Those are facts, not settings, and losing them would be a regression |
| Actions | Rows with a button, in the same list as the settings they relate to | Installing an extension belongs next to the extension paths, not in a separate menu |

## Tasks

1. **`src/pi-settings.ts` — the catalogue.** Load the active pi's SDK the way
   `PiSdkClient` does (through `resolveSdkEntry`), build a `SettingsManager`, and
   expose a declared catalogue: key, category, label, description in Spanish, kind
   (boolean / select / number / text / list / action), the scopes it supports, and
   its current value per scope. Reading and writing go through the typed getters
   and setters. Pure description data, so the row builder is testable without an
   editor.
2. **`src/settings-view.ts` — the tab.** A `WebviewPanel`, one per session,
   revealed rather than duplicated when already open. Markup and chrome in
   `media/settings.{js,css}`: search box, category rail, rows, scope selector.
   Rows render from the catalogue; a write posts the new value and re-reads.
3. **Actions and state.** Every action the quick pick offered becomes a row
   button in the category it belongs to, and the read-only Estado category keeps
   the version, paths, providers, package count, sessions and usage the owner
   already had.
4. **Retire the parallel universe.** `picode.piChat.menu`, `AjustesView.openMenu`
   and the chat panel's gear button open the tab; `menu.ts`'s quick-pick walk is
   deleted with the tests that pinned it, and `menu-rows.ts` survives only if the
   sidebar card still needs the category rows.
5. **Tests and docs.** `pi-settings` catalogue coverage (hermetic, fake settings
   manager), markdown-free row rendering, a `panel-dom`-style id check for the new
   view, and a section in `docs/ARCHITECTURE.md`.

## Out of scope (this feature)

Editing pi's `models.json` or `auth.json` (credentials and model definitions are
their own surface), editing the raw settings file, and per-project settings for
keys that have no project setter.

## Evidence

- Work-unit commits on the feature branch, one per task.
- `npm test` green after every task; the tab's ids covered the way the chat panel's are.
- A live check that a written value survives a `reload()` through the SDK.
