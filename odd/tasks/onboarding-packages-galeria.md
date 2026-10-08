# Onboarding: paso de packages, galería y fin permanente

**Petición del dueño (2026-09-29):**

1. Un paso **antes** del paso de temas en el asistente de primer arranque, para añadir
   **packages de pi** si el usuario quiere.
2. Una **galería de packages** para añadirlos (al estilo de la galería de temas).
3. En la pantalla final, junto a «Review the setup», un botón **«End the setup»** que cierre
   el asistente **para siempre**: que la página de welcome/onboarding no vuelva a mostrarse.
4. Corregir el texto final: dice «Settings > Chat» y debe decir «Settings > PiCode».

## Arquitectura (exploración hecha)

- **Asistente**: `picode-source/src/vs/workbench/contrib/welcomeGettingStarted/browser/picodeSetup.ts`
  (1416 líneas, código propio de PiCode). Máquina de estados manual: `step: 0|1|2`
  (0=pi runtime, 1=Provider & model, 2=Theme), dispatch en ~235-241, etiquetas
  en ~255, `advanceFrom` ~335, guardas `step < 2` / `step === 2` en el pie.
- **Las claves `onboardingThemes`/`onboardingKeymaps` de product.json son datos muertos**:
  tipos en `src/vs/base/common/product.ts` pero nada las lee.
- **Galería de temas (patrón a imitar)**: `renderThemeCard()` (~882) + `renderGalleryInto`
  (~1000): pestañas, búsqueda con debounce, paginación de 24, tarjetas; comandos del
  conector `picode.setup.gallerySearch/galleryThumb/galleryInstall`.
- **Packages de pi**: los comandos del conector YA existen (`extensions/picode/src/`):
  - `picode.setup.packages` (lista de instalados) — `packages-data.ts`
  - `picode.packages.search` (catálogo: registro npm, keywords:pi-package, caché 5 min) —
    `packages-registry.ts`
  - `picode.packages.install/.uninstall/.enable/.disable` — CLI `pi install` con
    `ELECTRON_RUN_AS_NODE`, cola serializada, timeout 3 min
  - UI existente: `pluginListWidget.ts` (sección Packages de Agent Customizations).

## Plan de implementación

1. **Paso nuevo** (índice 3, temas pasa a 4): tarjeta de packages con dos pestañas
   (instalados / galería), reutilizando `picode.setup.packages` + `picode.packages.search`
   + `picode.packages.install`. Opcional: el pie ofrece «Skip» natural (el asistente ya
   permite avanzar sin acción). Guardas `step < 3` → `step < 4`, etc.
2. **Pantalla final**: botón «End the setup» junto a «Review the setup». Efecto: marca
   el asistente como cerrado permanentemente (clave de almacenamiento propia) y desactiva
   la página de welcome en el arranque (`workbench.startupEditor: none`). «Review the
   setup» sigue disponible desde Settings > PiCode.
3. **Texto final**: «Settings > Chat» → «Settings > PiCode».

## Implementación (2026-09-29, commit `df54efe4`)

- **Paso Packages** (nuevo índice 3; temas pasa a 4): pestaña «Installed» sobre
  `picode.setup.packages` y pestaña «Gallery» sobre `picode.packages.search` (búsqueda con
  debounce, 24 por página con «Show more», botón Install con una instalación a la vez,
  refresco de la pestaña instalada al acabar). Guardas `step < 4` / `=== 4` actualizadas.
- **End the setup**: segundo botón en la pantalla final; ejecuta `picode.setup.endForGood`
  (nuevo comando del conector: `markDone()` + `workbench.startupEditor: none` a nivel de
  usuario) → la página de welcome no vuelve a abrirse al arrancar; «Review the setup»
  permite volver a ejecutarlo.
- **Texto final**: «Settings > Chat» → «Settings > PiCode».

## Verificación

`dev/build-run.sh` completo + arranque del producto no es posible sin sesión gráfica; la
compilación y el typecheck son la verificación de esta sesión, y el dueño prueba la
experiencia en el producto empaquetado.

### Verificado

- Conector: `build-connector.sh` exit 0.
- Typecheck del núcleo (`tsc --noEmit -p src/tsconfig.json`): 0 errores.
- Build completo tras la feature: ver resultado del job `build post-onboarding`.

## Defecto encontrado probando el producto: el import no llegaba a Settings

**Síntoma (dueño, con captura):** tras importar el perfil del pi externo (nan, omni…),
los proveedores no aparecen en Settings > PiCode > Providers, ni los servidores MCP en
Settings > MCP.

**Causa:** el import (`profile-import.ts`) copia `models.json` y `mcp.json` directamente
al perfil interno — el runtime los ve, pero las páginas de Settings leen dos settings del
ero (`picode.providers`, `picode.mcp.servers`) que el import no tocaba.

**Arreglo (commit `530fcb66`):** tras la copia, el flujo de import proyecta lo que llegó
de vuelta a esas filas (módulo nuevo `import-project.ts`, puro): claves interpoladas
(`$NAME`/`!command`) viajan como clave de fila; credenciales literales se quedan en los
ficheros de pi (nunca en settings); las filas que el dueño ya tenía nunca se pisan; y
`mergeModelsFile` preserva la credencial (`apiKey`/`authHeader`) de una entrada existente
cuando la fila no la nombra, para que la proyección posterior no la borre.


## Defecto posterior: las sesiones importadas parpadeaban (commit `c0fe9034`)

**Síntoma:** las sesiones importadas aparecían y desaparecían del panel de Sesiones.

**Causa doble:** (1) `provideChatSessionItems` devolvía `[]` al estar cancelado el token,
y el puente extension-host hace diff por referencia — una refresco cancelado daba de baja
todas las sesiones pi hasta el siguiente refresco completo; (2) `listSessionFiles` leía
enteros los ~195 JSONL en cada refresco, haciéndolos lentos y propensos a solaparse.

**Arreglo:** la cancelación devuelve la última lista aceptada (mismas referencias, cero
deltas) y el listado lleva caché por fichero clave `mtime` (solo se releen nuevos o
cambiados).

**Verificado:** build completo (`dev/build-run.sh`) exit 0 tras el arreglo.
