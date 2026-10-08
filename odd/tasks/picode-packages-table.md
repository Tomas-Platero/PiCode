# Feature: the packages table in pi's settings

## Goal

Replace the flat package list in the **Paquetes y recursos** category of the
settings tab with a paginated table that can be searched, filtered and sorted.

Product direction (locked by the product owner, 2026-09-22):

> "Modifica la sección «Paquetes y recursos» de los ajustes de pi. Actualmente los
> paquetes se muestran como una lista plana de filas con el formato
> `npm:nombre-paquete` o `git:github.com/usuario/paquete` seguido de un botón
> «Pausar». Sustitúyelo por una tabla paginada."

The owner rejected the current shape on purpose: a row that shows the raw spec and
one button per package does not answer "which of these is from git", "which are
paused" or "where is `pi-lens`" without reading all 18 lines. The table exists to
answer those three questions at a glance.

## What exists today

`extensions/picode-pi-chat/media/settings.js`, `case "packages"`, renders one
`div.package-row` per entry: the raw `source` string, a `Pausar` / `Reanudar`
button, a remove cross, and an add row below. It is the only control of its kind in
the tab and it is deliberately primitive.

The value comes from `src/pi-settings.ts`: `packages` is read per scope from pi's
own settings object and reduced to `PiPackageEntry[]` = `{ source, paused }`, and
written back through `manager.setPackages` / `setProjectPackages`. Writes go through
pi's typed setters, never through the settings file.

## Verified facts that shaped this design

Gathered 2026-09-22 against pi `0.86.1` and the owner's real
`~/.pi/agent/settings.json` (18 packages).

- **The stored datum is a source string and nothing else.** Real values in place:
  `"npm:pi-lens"`, `"npm:@tintinweb/pi-subagents"`,
  `"git:github.com/HazAT/pi-interactive-subagents"`. There is no version and no
  path in the value, so every column of the table except Estado is **derived**.
- **Only a pinned spec carries a version.** Exactly 1 of the owner's 18 entries
  does. The owner chose the cheap source on purpose
  when asked: *"Solo de la especificación guardada (Recomendado)"*. Reading the
  installed `package.json` (through `pi list` + a file read per package) is a
  deliberate, available follow-up, not part of this feature.
- **The same package can appear twice**: a package and its pinned spec resolve to
  the same directory. So a row is identified
  by its **position in the stored list**, never by its source string, and two rows
  may legitimately look identical in the Nombre column.
- **`pi list` knows the path, the settings value does not** — repeated here because
  it is the reason Versión is allowed to be almost always "—".
- **The tab re-renders from scratch after every write**:
  `settings-view.ts` re-reads all values and posts `state` again, and
  `media/settings.js` rebuilds the whole content pane. Any table state kept in the
  DOM would therefore be lost on every pause — which is exactly what the owner
  forbade ("sin resetear la página actual ni perder el estado de búsqueda/filtros").
- The vendored codicon subset has **no npm or git glyph** (`grep -o
  "codicon-[a-z0-9-]*" media/codicon.css`). The two origin icons are therefore
  authored inline SVG marks, which is also what keeps them independent of a font
  file.

## Decisions (locked)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Where the derivation lives | A new pure module, `media/package-rows.js`, published on `globalThis.PiCodePackageRows` | `docs/ARCHITECTURE.md`: `media/*` is "presentation only — does not compute anything", and "anything with arithmetic or wording that can be wrong is a pure function in its own module, so it can be asserted without an editor". `media/markdown.js` is the precedent: the file is required directly by its test |
| Where the table state lives | Module-level `state.packages` in `settings.js`: page, pageSize, query, origin, status, sort | The pane is rebuilt on every host `state` message; state kept in the DOM would reset the page on every pause |
| Row identity | The **index** in the stored list | Duplicate sources are real in the owner's file; `source` is not a key |
| Versión | Parsed from the stored spec only: the `@version` suffix of an npm spec, the `@ref` of a git spec, otherwise "—" | Owner's explicit decision. No host change, no I/O |
| Nombre | The base name, **scope removed** (`@tintinweb/pi-subagents` → `pi-subagents`) | The scope has its own column ("Autor/Scope — mostrar `@usuario` aquí"); keeping it in both would duplicate it |
| Origen | An icon, not text: authored npm and git SVG marks, `currentColor` only | Owner: "icono representando npm o git (no texto plano)"; no codicon glyph exists for either |
| Estado | The existing `.toggle` switch, reused as-is | Owner asked for a switch; the CSS already ships one and the visual language stays identical |
| Acción | Icon buttons: pause/resume and remove | Owner listed both the switch and an action button; both post the same write |
| Summary counts | Over the **rows the filters leave**, i.e. what the table is showing | The line must agree with the table under it; "de Z totales" is the table's own total |
| Pagination hidden | The whole footer (selector included) disappears when `total <= pageSize` | Owner's rule; a page selector with one page is noise |
| Search scope | The name, the author and the version — what the row shows | The Nombre cell has the scope stripped, so a name-only search could not find what the Autor/Scope column displays. The raw source is deliberately **not** searched: origin has its own filter, and the stored spec is reachable in the Nombre cell's `title` |
| Page size | Default **20**, and the selector is built from `PAGE_SIZES` alone | The owner asked for a 20-25 default and for exactly 20/50/100 in the selector. A default outside that list would force either a fourth option nobody asked for or a control reading a different number from the table. `test/package-rows.test.js` asserts the default is a member of the list instead of patching the mismatch at runtime |

## Design

### `media/package-rows.js` — the pure half

Browser script, no DOM, no `acquireVsCodeApi`, publishes `globalThis.PiCodePackageRows`
the way `media/markdown.js` publishes `PiCodeMarkdown`, so `test/package-rows.test.js`
can `require()` the very file the webview loads.

```text
PAGE_SIZES = [20, 50, 100]
DEFAULT_PAGE_SIZE = 20

parseSource(source) -> { source, origin, name, author, version }
    origin: "npm" | "git" | "other"
    name:   base name, scope stripped
    author: "@scope" for npm, the user/org for git, "" otherwise
    version: pinned version (npm) or ref (git), "" when the spec has none

parseSpecs?  -- no; only the two entry points below take a list
buildRows(entries) -> [{ index, entry, source, origin, name, author, version, paused }]
filterRows(rows, { query, origin, status }) -> rows
sortRows(rows, { key, direction }) -> rows
paginate(rows, { page, pageSize }) -> { page, pageCount, start, end, total, items, paged }
summarize(rows) -> { total, active, paused }
```

`parseSource` cases the test must pin (this is the parse table of the feature):

| input | origin | name | author | version |
| --- | --- | --- | --- | --- |
| `npm:pi-lens` | npm | `pi-lens` | `` | `` |
| `npm:@tintinweb/pi-subagents` | npm | `pi-subagents` | `@tintinweb` | `` |
| `npm:@gtrabanco/pi-nan-provider@2.0.0` | npm | `pi-nan-provider` | `@gtrabanco` | `2.0.0` |
| `git:github.com/HazAT/pi-interactive-subagents` | git | `pi-interactive-subagents` | `HazAT` | `` |
| `git:github.com/HazAT/pi-interactive-subagents@v1` | git | `pi-interactive-subagents` | `HazAT` | `v1` |
| `D:\ext\my-pkg` | other | `my-pkg` | `` | `` |
| `""` | other | `` | `` | `` |

The `@` that separates a version is the **last** one and only when it is not the
first character, so `@scope/name` keeps its scope and `@scope/name@1.0.0` splits.

`sortRows` keys: `name`, `status`, `version` (the three sortable headers the owner
named). Name and version compare with `localeCompare(b, undefined, { numeric: true })`
— numeric so `0.1.14` does not sort before `0.1.9`; empty versions sort last in
ascending order. Status compares `paused` (active first when ascending). Any other
key returns the rows untouched. `sortRows` and `filterRows` never mutate their input.

`paginate` clamps `page` into `1..pageCount` (a delete on the last page must land on
a real page, not on an empty one) and reports `paged = total > pageSize`.

### `media/settings.js` — the rendering half

- `state.packages` is added once next to the other module state: `{ page: 1,
  pageSize: DEFAULT_PAGE_SIZE, query: "", origin: "all", status: "all",
  sort: { key: "name", direction: "asc" } }`. Nothing in a re-render resets it.
- `case "packages"` becomes `renderPackages(setting, wrapper)`, which paints, in
  order: the summary line, the filter bar, the table, the pagination footer, and
  the existing add row.
- Only the pieces that changed are repainted: the table body and the footer live in
  their own containers, so typing in the table's search box or changing page does
  not rebuild the whole settings pane (and never touches another setting's row).
- Actions read the **current** stored array from `state.values[setting.key]`, change
  only the target index, and post `{ type: "write", scope, key, value }`. They render
  nothing locally: the host's `state` message comes back and repaints from
  `state.packages`, so the page and the filters survive.
- Changing page calls `scrollIntoView` on the table wrapper, which is the owner's
  "scroll automático a la parte superior de la tabla".
- Every user-facing string is Spanish, matching the tab: headers `Nombre`, `Origen`,
  `Autor/Scope`, `Versión`, `Estado`, `Acción`; summary `X activos · Y pausados de Z
  totales`; empty state `No se encontraron paquetes`; placeholders and button titles
  for the search, the two filters, the page size and the four navigation buttons.

### `media/settings.css`

- `.setting-row-wide`: the packages row stacks its text above the control and lifts
  the `max-width: 45%` the other controls have, because a six-column table cannot
  live in 45% of the pane.
- Table, filter bar, pagination, summary and empty state styles, reusing
  `.toggle`, `.setting-select`, `.settings-search-input`, `.settings-empty` and the
  existing `.package-pause` / `.package-remove` button styles so the table looks
  like it belongs to the tab.
- Only `--vscode-*` variables. No literal colour, checked with
  `grep -nE "#[0-9a-fA-F]{3,6}|[^-]rgba?\(" media/settings.css`.

### `src/settings-view.ts`

- `scripts: ["package-rows.js", "settings.js"]` — the pure module first, because
  `settings.js` reads `globalThis.PiCodePackageRows` at render time.
- `styles: ["codicon.css", "main.css", "settings.css"]` — `codicon.css` is added to
  this webview, not only to the chat panel. The Acción column is two icon-only
  buttons, and a `.codicon` class with no stylesheet behind it paints an empty
  square: a control that reads as broken rather than unstyled. The chat panel
  already loaded the same three-sheet order, and the font sits beside the sheet.

### Tests

- `test/package-rows.test.js`: the parse table above, plus `buildRows` identity,
  `filterRows` (query, origin, status, and their combination), `sortRows` (all three
  keys, both directions, no mutation, `0.1.9 < 0.1.14`), `paginate` (page count,
  clamping, `paged`) and `summarize`. It also pins the invariant that
  `DEFAULT_PAGE_SIZE` is one of `PAGE_SIZES`, which is what keeps the selector and
  the table from ever disagreeing. Same shape as `test/markdown.test.js`.
- `test/panel-dom.test.js` stays untouched: the table is built in JavaScript, so it
  introduces no new markup id.
- `package.json` gains the new suite in the `test` chain.

## Judgement calls made during implementation

Recorded because they were not in the original design and a reviewer should not have
to infer them from the diff.

1. **The search haystack is the visible row, not the stored source.** Search matches
   name, author and version. Searching `npm:` finds nothing, on purpose: origin has a
   filter, and a search that silently widens to the raw spec makes the filter
   redundant and the placeholder untrue.
2. **The stored spec stays reachable on hover.** The Nombre cell carries `title`
   with the exact stored source, because the owner's file can store the same package
   twice and two rows can be indistinguishable by name alone.
3. **The arrow shows only on the active header.** `paintSort` writes the direction
   into every sortable header; the CSS keeps the inactive indicators at
   `opacity: 0`, so the table never shows three arrows at once.
4. **The empty state replaces the table**, header included, rather than filling an
   empty `tbody` with a placeholder row: a header over nothing reads as a loading
   failure.
5. **The action glyphs are stop / play / cross** (`codicon-debug-stop`,
   `codicon-triangle-right`, `codicon-close`). The vendored subset has no pause icon,
   and inventing one would mean shipping a glyph the editor does not have.
6. **A drive-by fix in `media/settings.css`:** the `#ffffff` fallback on
   `--vscode-button-foreground` was removed, because the house rule for these
   stylesheets is `--vscode-*` variables only, with no literal colour even as a
   fallback, and the no-literal-colour grep is an acceptance check of this feature.
7. **Known limitation, inherited and not introduced here:** `src/pi-settings.ts`
   reduces a package to its source and its pause, so a package entry that carried
   pi's own resource-filter fields is written back without them. That is the host
   contract this surface already had.

## Out of scope (this feature)

Reading the installed version from `node_modules/*/package.json` (the owner picked
the stored-spec source on purpose), any host-side change to `pi-settings.ts`,
sticky table headers, and per-row details such as which resources a package
contributes.

## Evidence

- Work-unit commits on the feature branch.
- `npm test` green, with the new suite in the chain (16 suites).
- The pure half checked against the owner's real `~/.pi/agent/settings.json`: 18
  rows, the duplicated package rows kept apart, the pinned one the only row with a
  version, `git:github.com/HazAT/...` derived to `HazAT` / git.
- The no-literal-colour grep over `media/settings.css` returning nothing.
- The distribution stage (`distribution/apply-picode.ps1`) copies `media/` wholesale,
  so the new module reaches the running editor on the next `-Apply`.
