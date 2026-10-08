# Feature: elegir el tema del editor, desde el catálogo, con vista previa

## Goal

Power to choose an editor color theme — the kind
[`vscodethemes.com`](https://vscodethemes.com) previews — with a real preview of the
theme's own colours, **both in the first run** (the onboarding wizard) and **at any
time** (palette, the PiCode popup and the settings panel). Applying a theme installs it
if it is missing and writes `workbench.colorTheme`.

## Why

The owner's words (2026-09-23):

> "Vamos a ver, necesito integrar los temas de https://vscodethemes.com para que tanto
> en la primera instalación como en cualquier momento puedan elegirse uno de esos temas."

## What is already true (verified 2026-09-23, not assumed)

- **`vscodethemes.com` is a viewer, not a source.** Its own repository says it "scans the
  Visual Studio Marketplace and maintains a searchable database of themes", and that a
  theme shows up only if its extension declares a description and ships a `.json` theme
  (`vscodethemes/web` README; 1.9k stars, Remix + a private database). It exposes **no
  public API** and it does not host theme files: the bytes live in the extension's VSIX.
  Its per-theme page is `/e/<publisher>.<extension>/<slug>`, and a search is
  `/?q=<text>`; a page answers 200 for any slug, so a per-theme link cannot be built
  reliably from outside — the search link can.
- **PiCode installs from Open VSX.** `distribution/product-delta.json` sets
  `extensionsGallery.serviceUrl` to `https://open-vsx.org/vscode/gallery`, and the built
  workbench carries `workbench.extensions.installExtension` (26 occurrences in
  `resources/app/out/vs/workbench/workbench.desktop.main.js`). The Microsoft Marketplace
  is not usable from a non-Microsoft editor. So a theme that exists only on
  vscodethemes.com (i.e. only in that marketplace) **cannot be installed here**, and the
  honest thing is to say so rather than to show a button that fails.
- **The Open VSX registry is enough to build the catalogue**, verified by hand against
  the live API:
  - search: `/-/search?category=themes&sortBy=downloadCount&sortOrder=desc` — the
    `category` filter is **loose** (it returns PowerShell), so it cannot be trusted;
  - metadata: `/api/<namespace>/<extension>/latest` → `categories`, `displayName`,
    `description`, `downloadCount`, `version`, `files.icon`, `files.download`,
    `files.manifest`;
  - `files.manifest` is the extension's own `package.json`, served **without** the VSIX
    (`.../file/package.json`, 302 → the bytes). That is where
    `contributes.themes[].{label, uiTheme, path}` lives, so *filtering real themes* is one
    cheap request per candidate.
  - `/file/<path>` serves only the whitelisted artifacts (README, LICENSE, manifest,
    icon, changelog…): `theme/dracula.json` answers 404. **A theme's own JSON cannot be
    fetched from the registry**; it has to come out of the VSIX.
- **The VSIX is small enough to download for a preview**: Dracula 483 KB, Catppuccin
  132 KB, One Dark Pro 342 KB (`Content-Length` of `files.download`).
- **Installed themes need no network at all**: `vscode.extensions.all` gives every
  extension's `packageJSON`, and an installed theme's JSON is a file on disk.
- **Nothing in PiCode touches editor themes today**: no `workbench.colorTheme` anywhere,
  no `configurationDefaults`, and `distribution/settings.json` (the first-run defaults)
  sets no theme. The settings panel governs pi's settings and PiCode's own; the onboarding
  wizard has two steps (pi, summary) and no theme step.

## Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Catalogue source | **Open VSX**, the gallery that PiCode installs from | vscodethemes.com indexes the Microsoft Marketplace, which this editor cannot install from; a catalogue that shows themes it cannot install would be a list of dead ends. The site stays one click away, as a search link per theme |
| Catalogue filtering | Fetch each candidate's **manifest** (`files.manifest`) and keep the extensions that really declare `contributes.themes` | The registry's `category=themes` filter returns PowerShell; `categories` is not trustworthy either. The manifest is the only honest answer, and it is a small request |
| Preview | **Rendered by PiCode from the theme's own JSON** — never a screenshot of someone else's page | The site's images are third-party content with no licence to redistribute; the theme's colours are the theme, and rendering them makes the preview work offline and stay true when the theme updates |
| Where a preview's colours come from | Installed theme → its file on disk. Catalogue theme → **the VSIX, read in memory** (a minimal ZIP reader, no dependency), cached under the extension's global storage, keyed by `id@version` | The registry does not serve theme files, and installing a theme just to look at it is not a preview. One download per theme, then it is local and instant |
| Which profile's storage holds the cache | `context.globalStorageUri`, i.e. inside PiCode's own portable profile | The same rule as everything else: nothing of PiCode's is written outside the product |
| Applying | `workbench.colorTheme` through the configuration API, and `workbench.extensions.installExtension` only when the theme is not installed | Both are the editor's own paths; writing the settings file by hand would fight the running window |
| The reload | Offered **only when the extension was just installed** | A theme that is already installed applies immediately; after an install the theme registry may not have the new theme yet, and a reload is the honest fix |
| Surfaces | Palette command, the PiCode popup menu, a row in the settings panel (new **Aspecto** category), and a step in the first-run wizard | "En cualquier momento" is the palette and the panel; "en la primera instalación" is the wizard. One picker behind all four |
| How the theme's colours reach the DOM | CSS custom properties on the gallery's root, set through CSSOM (`el.style.setProperty("--pv-bg", …)`) | The panels' CSP is `style-src <cspSource>` with no `unsafe-inline`, so a `style` attribute or an inline block would be blocked: CSSOM writes are not. The variables keep the mapping in `theme.css` and the renderer knows no colour names, which is also why a second surface (the wizard) can reuse the same stylesheet |

## Tasks

A task is checked only when its outcome and its checks were observed; every task closes
with one work-unit commit on the feature branch, recorded here as evidence.

- [x] **T1 — El catálogo y la lectura de un tema.**
  `src/theme-catalog.ts`, sin `vscode`: buscar en Open VSX (con el filtro del manifiesto),
  leer el manifiesto, descargar el VSIX, extraer de él los ficheros que un tema necesita
  (lector ZIP mínimo, sin dependencias), resolver la cadena `include` y devolver un tema
  con sus variantes y sus colores. Caché en disco por `id@version`. Las partes puras
  (parseo, fusión de la cadena, lector ZIP) se prueban sin red.
- [x] **T2 — La vista previa.**
  `src/theme-preview.ts`: del JSON del tema a un modelo de vista previa —los colores del
  marco del editor, ya resueltos con respaldo cuando el tema no los declara— y una muestra
  de código con cada token coloreado según las `tokenColors` del tema. Puro y comprobable.
- [x] **T3 — La galería, y la mitad del host.**
  `src/theme-service.ts` (filas, vista previa, aplicar e instalar, y la decisión del
  reinicio), `src/theme-view.ts` (el panel, el enrutado y la lista blanca de URL),
  `media/theme-gallery.js` + `media/theme.js` + `media/theme.css` (un solo renderizador).
- [x] **T4 — Aplicar, instalar y llegar.**
  Comando `picode.piChat.selectTheme`, la categoría **Aspecto** en el panel de ajustes con
  el tema en vigor y la fila que abre la galería, y la declaración en `package.json`.
- [x] **T5 — El paso del asistente.**
  Un paso «Tema» antes del resumen, con la galería compacta montada desde el
  mismo componente y **dos** salidas honestas: aplicar, o quedarse con el que venga.
- **T6 — Cierre.** Verificación independiente, `npm test` verde (35 suites), distribución
  re-stageada y el informe.
  **Corrección de una promesa mía**: el commit de las tres puertas decía que el menú de
  PiCode abría la galería y no era cierto — la categoría **Aspecto** del menú se había
  registrado en la decisión pero no se implementó. Lo dice el commit `7ed12c3`: la
  categoría existe (el tema en vigor en la línea de detalle, y un segundo nivel con la
  entrada que abre la galería), no se borró la promesa del documento.

## Open questions

- Un tema que solo esté en el Marketplace de Microsoft no se puede instalar aquí: la fila
  lo dice y enlaza a la búsqueda en vscodethemes.com, en vez de ofrecer un botón que falla.
- Los temas de **iconos** (`.icon-theme.json`) son otra clave (`workbench.iconTheme`) y
  otra familia de extensiones: fuera de esta feature.
- El tema de la propia **TUI de pi** (terminal) es otra cosa y ya existe en pi; no se toca.

## Independent verification

Read-only pass over the theme feature, on the commits that were already
pushed. It found **four reachable defects**, all fixed in `a10968`, plus two dead pieces:

1. **The gallery opened a new tab on every invocation.** `selectTheme` built a fresh view on
   each call, so the guard that was supposed to reveal the open panel never held: the palette,
   the popup entry and the Aspecto row each opened another "Temas". It is one panel again,
   released when its tab closes — and it is checked through a stub editor with real panels,
   because every line was correct on its own and no reading of the source would have caught it.
2. **A message could apply a theme it had not named.** The lookup fell back to the row's first
   theme, so an arbitrary id applied that theme while the sentence described the one asked for.
   Exact match now, and `applied` is a comparison against what the editor reports rather than an
   assumption — a theme fixed at a nearer scope no longer reads as applied.
3. **A preview could hang on "Leyendo el tema…" for ever.** A failing network rejected out of
   the reader and nobody above it caught it, and a package whose theme could not be read was
   **cached before validation**, so that theme failed identically for good. The reader answers
   `undefined` now, both surfaces answer with a reason, and the cache is written only once the
   theme has actually been read.
4. **The panel queried the gallery before drawing anything**, so a slow connection showed an
   empty list for rows it was already holding. The installed rows go out first, and the
   gallery's replace them when they arrive.

Dead things removed with them: an `if`/`else` whose branches were identical, and a
pass-through wrapper. What the same pass checked and found **sound**: the URL allow-list
(23 hostile forms, no bypass), the ZIP reader's error paths, the cache staying inside
`globalStorage/themes`, the single settings write, and the renderer's use of `textContent`
with colours arriving already normalised.

## Evidence

- Work-unit commits, `npm test` green with per-suite counts on each.
- `npm test`: **35 suites, 1306 checks, no failure**. The five suites this feature added or
  extended: `theme-catalog` (42, including the ZIP reader against an archive the test builds
  byte by byte), `theme-preview` (31), `theme-service` (16, the install-then-apply decision
  among them), `theme-view` (20), `theme-gallery` (29, in a throwaway DOM), plus
  `onboarding` (29 → 34, the new step) and `pi-settings` (85, the Aspecto rows).
- The distribution carries it: `apply-picode.ps1 -Apply` staged
  `out/theme-*.js` and `media/theme-{gallery,}.js`/`media/theme.css` into
  `resources/app/extensions/picode-pi-chat`, which is what the editor loads at startup.
- **Delegation, and what it cost.** Three delegated writers were tried for the pure modules
  and the renderer and none of them produced code: two spent their budget reasoning and
  died on a transport limit, one was compacted and stopped to ask for its edit surfaces.
  The work was then written directly, which is why the five commits above are mine and the
  feature landed in one session; the two failed attempts cost roughly 40 minutes of wall
  clock and are recorded here rather than hidden.
