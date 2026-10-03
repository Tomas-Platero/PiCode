# Changelog

All notable changes to PiCode are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are built locally with `dev/build.sh` and published by hand: there is no CI workflow
(the owner removed them; the process lives in `docs/CI.md`).

## [Unreleased]

### Added
- **El chat hospeda la UI interactiva de las extensiones de pi.** El conector enlazaba las
  extensiones **sin** contexto de UI (`mode` por defecto `"print"`, `ctx.hasUI === false`), así que
  una extensión que necesita preguntar —el guard de comandos destructivos de gentle-ai, su tool
  `ask_user_question`, sus paneles— o bloqueaba con una frase que el modelo solo podía repetir, o
  respondía «unavailable». Ahora se enlazan con `mode: "rpc"` y un `uiContext` que traduce
  `ctx.ui.confirm/select/input` al carrusel de preguntas del chat y `ctx.ui.notify` a una línea en
  él; lo de terminal (`custom`, `setWidget`, `setFooter`, `theme`…) queda inerte. Se marca además el
  proceso con `GENTLE_SHELL_INTERACTIVE_HOST=1`, el contrato de host interactivo que gentle-pi lee
  (`lib/rpc-host.ts`). Detalle en `odd/tasks/picode-gentle-chat.md`.

## [0.1.1-beta] — 2026-10-03

### Changed
- **El actualizador muestra la versión de PiCode, no la del editor.** El diálogo de actualización
  leía `productService.version` (el número de VS Code, `1.135.x`) en «Current Version» y en «Latest».
  Ahora ambos leen `picodeVersion` (`0.1.1-beta`), que es lo que el dueño nombra y reconoce; la
  comparación de verdad sigue con el número del editor, que es el que las extensiones validan. El
  feed lleva los dos (`productVersion` y `picodeVersion`) y `dev/update-feed.mjs` acepta
  `--picode-version`.
- **El tema por defecto de una instalación nueva es Abyss.** El conector declara
  `workbench.colorTheme: "Abyss"` como valor por defecto (la extensión `theme-abyss` ya viaja
  incorporada) y el perfil portable de primera ejecución lo repite en `distribution/settings.json`.
- **Los comandos de solo lectura del chat dejan de pedir permiso.** `bash`/`powershell` se
  inspeccionan antes de preguntar: si **todos** los tramos de la cadena (`&&`, `||`, `;`, `|`) son de
  lectura —inspección de ficheros, `git` de lectura (`status`/`log`/`diff`/`show`/…), etc.— la llamada
  corre sin la rueda de Allow/Deny. Cualquier redirección, sustitución de comando o binario fuera de
  la lista blanca vuelve a preguntar. Detalle en `picode-source/extensions/picode/src/permissions.ts`.
- **pi sube a `1.0.1` en el pin del editor.** `distribution/runtime.json` pasa de `1.0.0` a `1.0.1` y
  el runtime del pack se refresca con el paso real del build. Antes de subir se midió el salto contra
  el paquete publicado: las **7 entradas del SDK** que resuelve el conector están
  (`createAgentSessionServices`, `createAgentSessionFromServices`, `createMcpExtension`,
  `createCodemodeExtension`, `createToolSearchExtension`, `SessionManager`, `main`), `dist/cli.js`
  sigue donde el conector lo busca, el **validador de MCP de 1.0.1 acepta los 12 escritores** de
  PiCode y sigue rechazando las dos grafías heredadas que el check usa como control, y los **176
  tests** y el typecheck del conector pasan. **El conector no cambia de contrato**: el único cambio
  que obliga la versión nueva es el ajuste de MCP por proyecto (en *Fixed*). Dos cosas que conviene
  saber: la 1.0.1 **retira `npm-shrinkwrap.json`** del paquete, así que sus transitivas se resuelven
  al instalar (la versión directa va fijada por el pin, y ahora también literal en el `package.json`
  del runtime con `--save-exact`), y trae la corrección de seguridad de `brace-expansion`. Detalle
  en `odd/tasks/picode-pi-101.md`.
- **Gentle AI sube a `gentle-pi` 4.0.0 en el perfil interno.** El paquete que el propio
  producto instala pasa de 3.7.0 a 4.0.0 (el salto mayor del que se tenía registro). Antes de
  subir se comprobó el acoplamiento del conector con los contratos de gentle que espeja:
  `lib/agents-config.ts`, `lib/agent-home.ts` y `lib/orchestrator-presence.ts` son
  **idénticos** entre 3.7.0 y 4.0.0, y la clave `gentleTodo` (`{tasks, nextId}`) no cambia, así
  que **el conector no necesita tocar código**. Lo que sí cambia para el usuario: la v4 saca
  del paquete los **13 agentes del ciclo SDD** y la extensión `sdd-init`, sube las extensiones
  de 13 a 18 y deja de traer `@earendil-works/pi-tui` (lo aporta el host).
- **esbuild is back on — at upstream's factory value.** VSCodium had flipped
  `useEsbuildTranspile` to `false` without recording a reason anywhere; PiCode restored it to
  `true` (2026-09-27) and closed the one real gap the route has: the product chain no longer
  type-checks by itself, so a headless `tsgo --noEmit` step (`picode-typecheck`) now runs at
  the front of `vscode-min-prepack`, same as `core-ci` does. Measured steady-state: compile
  41s (was 5m05s), pack 2m23s including the bundle (was 36s), **full build 3m34s** (was
  about 6 min), editor starts. The development loop exists again: `npm run transpile-client`
  turns 7,559 source files into a runnable `out/` in 7s, and `npm run watch` is no longer a
  no-op.
- **`picode-source/` is the product source now, versioned in this repository.** One clone has
  everything: the editor's code, the PiCode changes and the identity. The tree that used to be
  rebuilt on every build by fetching VS Code and applying 92 patches was committed and
  imported (13,125 files; base recorded in `upstream/stable.json`, VS Code 1.135.0). Product
  work means editing code, not writing patches.
- **The patch machinery was deleted by the owner's decision**: `patches/**`,
  `dev/get_repo.sh`, `dev/prepare_vscode.sh`, `dev/patch.sh`, `dev/update_patches.sh`,
  `dev/version.sh`, `dev/utils.sh`, `dev/vscodium-product.json`, `upstream/vscodium.json`,
  `dev/ci/pin-check.sh`. Provenance lives in the pin, in the public VS Code commit it names,
  and (locally) in a git bundle of the pre-import history.
- **The build has five phases instead of eight**: prepare (tree + identity + dependencies in
  one), connector, compile, pack, stage. `npm ci` runs only when the recorded dependency state
  no longer matches the tree; `-f` refuses instead of deleting the source; `-o` checks the
  source and identity in seconds.
- **`jq` is gone as a dependency** — nothing needs it any more.

### Fixed
- **El importador del pi externo vuelve a aparecer en el asistente.** La tarjeta «Choose your pi»
  construía el contenedor donde aterriza la oferta de importar (`.picode-import-area`) pero **no lo
  añadía a la tarjeta**, así que `querySelector` no lo encontraba y la oferta nunca se pintaba. El
  nodo ya existe en la tarjeta.
- **«Switching pi…» deja de quedarse pegado.** `applyRuntime` pintaba la frase antes del cambio y no
  la borraba al terminar, así que sobrevivía al repintado y parecía que el cambio no acababa nunca.
  Ahora se limpia en cuanto la operación responde (como ya hacía el instalador de Gentle).
- **La galería de temas deja de ofrecer herramientas con apariencia de tema.** El filtro de Open VSX
  `category=themes` devuelve PowerShell —que sí declara `contributes.themes` («PowerShell ISE»)—, así
  que la comprobación de manifiesto lo dejaba pasar y elegirlo instalaba un depurador y levantaba el
  aviso de confianza del editor. Ahora se descartan los manifiestos que además contribuyen
  `debuggers`, `languages`, `notebooks` o un `extensionPack`; los temas reales (One Dark Pro,
  Catppuccin, Dracula…) no traen ninguno. Con prueba.
- **El actualizador deja de responder «Server returned 404».** El editor instalado con el `.exe` de
  Inno no tiene `target` en su `product.json`, así que el updater resuelve el destino a `system` y
  pide `updates/stable/win32/x64/system/latest.json`; la release solo escribía el feed `archive` (el
  del zip portable). Ahora se generan y publican ambos: `archive` apunta al zip y `system` al
  `-setup.exe`.
- **El instalador de Windows ya arranca: «Bitmap image is not valid» eran dos defectos en las
  imágenes del asistente.** Inno Setup **6.4.1** —la versión que trae el build— **no lee PNG** en
  `WizardImageFile`/`WizardSmallImageFile`: un PNG compila sin queja y luego mata el asistente al
  abrirlo, porque `Setup` busca la firma PNG, no la encuentra, cae al lector de mapas de bits y este
  responde —con razón— que un PNG no es un BMP. Y los BMP que se habían generado a mano llevaban la
  cabecera **dos bytes corrida** (`biPlanes=0`, `biBitCount=1`, `biCompression=24`), así que tampoco
  valían. `dev/make-inno-images.mjs` ahora escribe **BMP de 24 bits con la cabecera campo a campo** y
  el `.iss` nombra `inno-big-*.bmp` e `inno-small.bmp`, con el cuadrado de la esquina hecho del mismo
  dibujo que el panel. Verificado arrancando un instalador compilado con la configuración real y
  leyendo el título de su ventana. Detalle en `odd/tasks/picode-instalador-windows.md`.
- **Un ajuste de MCP de un proyecto deja de leerse como un error.** pi 1.0.1 permite que el
  `.pi/mcp.json` de un proyecto lleve una entrada **sin `command` y sin `url`** cuyo único trabajo es
  encender, apagar o cambiar la exposición del servidor de usuario del mismo nombre. El lector del
  conector (`mcp-provider.ts`) la daba por mala y la reportaba en el log. Ahora la reconoce:
  `enabled: false` **quita ese servidor de la lista** —si se ofreciera al editor, el cliente del
  editor lo arrancaría igual y sus herramientas llegarían a pi por el puente, así que «apagado» no
  apagaría nada— y `exposure` y `toolExposure` deciden cómo expone pi las herramientas al modelo, que
  no es cosa de esta lista. Con prueba.
- **El sync deja de agotarse solo, y el perfil de Pi deja de perder ficheros.** El error `Too many
  requests. Only 100 requests allowed in 5 minutes` no lo lanzaba el servidor: es el freno del
  cliente y saltaba porque el motor hacía ~14 syncs completos en cuatro minutos. Dos disparadores: el
  hub de customizaciones guardaba la sección activa como estado **sincronizado** (cada clic
  despertaba un sync) y el recurso `piProfile` leía el perfil **externo** `~/.pi/agent`, cuyo
  `models.json` reescribe el pi del PATH sin parar. Ahora la sección activa es estado local y
  `piProfile` sincroniza el perfil propio de PiCode (`<dist>/data/pi-agent`), nunca `~/.pi`
  (AGENTS.md §4). Además `piProfile` **aplanaba las rutas**: su `getKey` comparaba un URI `file://`
  con uno `userDataSync://`, `relativePath` devolvía `undefined` y caía al `basename`, así que
  `memory/MEMORY.md` viajaba como `MEMORY.md` y los ficheros con el mismo nombre se pisaban (de 6
  `SKILL.md` solo sobrevivía uno). Ahora conserva la ruta completa. Detalle en
  `odd/tasks/picode-cloud-sync.md`.

### Removed
- **Los ajustes de sandbox del agente salen de Settings.** Se retiran del registro
  `chat.agent.sandbox.enabled`, `...enabledWindows`, `...allowNetwork`,
  `...allowUnsandboxedCommands`, `...retryWithAllowNetworkRequests`, `...allowAutoApprove`,
  `...fileSystem.linux|mac|windows`, `...advanced.windows.schemaVersion` y `...advanced.runtime`
  (el bloque que el dueño vio como «Chat › Agent › Sandbox: Enabled Windows»). El motor sigue en el
  árbol pero ya no es alcanzable desde la interfaz ni desde un ajuste por defecto.
- **Autopilot y Assisted, fuera de Settings.** El picker del chat ya ofrecía solo dos posiciones
  (Ask y Allow all) desde el 27‑09, pero los ajustes seguían ahí. Se retiran
  `chat.autopilot.advanced.enabled` y `chat.assistedPermissions.enabled` del registro, y el ajuste
  `chat.defaultConfiguration` deja de ofrecer `autopilot` en `mode` y `assisted` en `approvals`.
  Con ellos se va el código que solo existía para esos ajustes: el *risk gate* de Autopilot en la
  confirmación de herramientas, el *goal banner* de Advanced Autopilot y su servicio. El vocabulario
  interno `ChatPermissionLevel.Assisted`/`.Autopilot` se conserva: lo comparten otros proveedores de
  sesiones. Detalle en `odd/tasks/permisos-pi-chat.md`.
- **17 ajustes experimentales fuera del registro, restos de Copilot o de otros proveedores.**
  Auditoría de los 62 ajustes con etiqueta `experimental`: se retiran sus bloques de registro los que
  no sirven a PiCode — sync de sesiones Copilot (`chat.sessionSync.*`), migración de sesiones Copilot
  CLI, sesiones de agentes ajenos (`chat.agentSessions.showExternal`), Codex
  (`chat.editor.codex.preferAgentHost`), puente y tool-search del Copilot SDK, semantic search de
  Copilot, sandbox del SDK en macOS/Linux y Windows, `chat.modeFilesLocations` (deprecado, sin lector),
  instrucciones por la extensión GitHub Copilot Chat, la migración prompt→skill, y los tres ajustes de
  Voice Mode (`agents.voice.*`, atados a un entitlement Pro de Copilot). Ya no aparecen en Settings.
  Los 42 restantes configuran el chat de pi y se quedan. Detalle en
  `odd/tasks/picode-settings-experimentales.md`.
- **Más ajustes de Copilot/empresa, fuera de Settings.** Tras revisarlos uno por uno con el dueño:
  hooks (`chat.useHooks`, `chat.hookFilesLocations`, `chat.useClaudeHooks`), marketplaces de plugins,
  gobernanza empresarial de plugins y de MCP, `chat.experimental.permissionsSandboxToggle.enabled`,
  la migración de customizations, `chat.agentHost.cloudSandbox.enabled`, el entitlement/selectores de
  Copilot (`defaultToCopilotHarness`, `preferCopilotHarness`, `localAgent.enabled`,
  `growthNotification.enabled`, `allowAnonymousAccess`, `approvedAccountOrganizations`,
  `extensionUnification.enabled`) y `chat.defaultConfiguration` (las sesiones nuevas del agent host
  toman ahora modo de `chat.newSession.defaultMode` y permisos de `chat.permissions.default`).
  `chat.tools.riskAssessment.model` pasa a default vacío (usa el modelo utility de pi, no
  `copilot-utility-small`) y `chat.agentHost.allowSignedOutWhenUsable` a `true`. Detalle en
  `odd/tasks/picode-auditoria-de-ajustes.md`.

### Measured
- A full steady-state Windows build on a 16-core machine, with the esbuild route restored
  (2026-09-27): **3 min 34 s** — compile 41 s (the headless type check inside), pack 2 min
  23 s (bundling the 24 shipped outputs from source costs ~100 s of it), stage 17 s. The
  dev loop too: 7,559 files transpiled to a runnable `out/` in 6.8 s. The rebuilt editor
  starts (eight processes, window up) and restores the portable profile (138 files).
- The same tree on the classic gulp-tsb route, earlier the same day: about six minutes —
  compile 5m05s, pack 36s, stage 17s. The former up-to-210-minute cost belonged to the old
  chain (dependency reinstalls, native rebuilds, CI runners), not to compiling.

## [0.1.2] — 2026-09-27

### Added
- **Installers join the portables**: Windows setup (`Inno Setup`) plus `.deb` and `.rpm` for
  Linux, with `SHA256SUMS.txt` across every release asset.
- **First-run setup as a three-step wizard** you can watch: choose the Pi runtime, connect a
  provider, install Gentle AI — with the buttons that actually look like buttons.
- **A Gentle install you can watch**, and a chat that reloads it when it finishes.

### Fixed
- The chat follows the Pi instance that is in force, models included.
- The runtime choice writes the key it registered; Copilot leaves the status bar.
- Gentle AI installs one package at a time, with npm 11's script gate satisfied in the
  metadata stage.
- The npm project is created before npm runs against it (setup path).
- The Linux build heap comes down to 5632 MB; the minifier gets a bigger heap on Windows;
  the heap is sized per system and gulp runs without npm's hardcoded ceiling.
- Patches 19/20 restored after a pathspec slip during regeneration.

### CI
- Full builds run on **Windows and Linux** with tag-driven releases; hard time ceilings sized
  to a healthy build (Windows grows to 210 minutes); a new build cancels the one in progress;
  the nightly only runs when something relevant changed.
- No `node_modules` cache — the fast-install path trusted a half-built tree. The cache
  question stays open; tarball and git-object caches remain.
- GitHub assets are fetched authenticated; the `deb`/`rpm` pairs build sequentially; the
  collect steps read where each packager actually leaves its artifact; Linux compiles move to
  a larger runner and stop `systemd-oomd` first; the Windows build finds Visual Studio
  through `vswhere`.

## [0.1.1] — 2026-09-23

### Fixed
- Theme gallery: what independent verification found, including a panel that was never one.

### Changed
- Docs: the binary is a release, not a commit — the 1 GB payload is not versioned; the ZIP
  path and the source path are documented as separate routes with separate audiences.

## [0.1.0] — 2026-09-23

First tagged release. Distribution layer plus the agent panel, built on a VSCodium tree that
PiCode owns:

### Added
- **Source build**: clone the pinned VS Code, apply the vendored VSCodium patch set and
  PiCode's own patches, apply the product delta, compile `PiCode.exe` — reproducible by any
  collaborator (ADR-011 path, `dev/build.sh`).
- **Two pins** (`upstream/stable.json`, `upstream/vscodium.json`) and the CI guards around
  them: `pin-check` on every push/PR (Linux + Windows), weekly `pin-watch` that opens
  security-labelled update PRs, nightly full build.
- **Product delta as data** (`distribution/product-delta.json`): branding, Open VSX gallery,
  portable profile (`data/`), and real deletion of Copilot and telemetry keys — not cosmetic
  overrides.
- **Agent panel** (`extensions/picode-pi-chat`, since retired in favour of core integration):
  chat with streaming, tools, reasoning, sessions and slash commands; settings surface;
  provider connection (OAuth and key, via Pi's own login flows); package management;
  dual runtime (Pi on `PATH`, managed install, or custom) over RPC or embedded SDK.
- **Theme gallery** with a preview rendered from each theme's own colours, reachable from the
  palette, the panel and the first-run wizard.
- **First-run wizard**: runtime choice, Gentle AI switch, theme choice.
- Pi and Gentle AI pinned and installed through their own mechanisms (ADR-010), with
  `picode.pi.executablePath` as the escape hatch.

### Known at release
- Windows binaries unsigned (SmartScreen warning on first run).
- Interactive surfaces verified by hand; the decisions around them are covered by hermetic
  suites.
- macOS not wired (the build refuses with a message that says so).

## Unreleased

Nothing tagged since 0.1.2.
