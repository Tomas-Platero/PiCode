# Feature: bienvenida de verdad y primeros pasos (logo, pi, Gentle AI, tema)

## Goal

Que la pantalla de bienvenida de PiCode sea **una bienvenida del producto**, no la pantalla
heredada de VS Code:

- El **logo de PiCode** encima del nombre «PiCode — Agentic Code Editor».
- Fuera **Start** y **Recent** (y los elementos heredados que vinieran con ellos:
  walkthroughs de extensiones y el bloque de anuncios de VSCodium).
- En su lugar, una bienvenida con las acciones del primer arranque:
  1. **Qué pi se ejecuta** — interno (el de PiCode) o externo (el de la máquina).
  2. **Gentle AI sí o no** — con salida honesta para usar pi básico sin Gentle AI, sus
     agentes, skills ni memoria.
  3. **El tema del editor** — desde la galería de temas (Open VSX, ver
     `picode-themes.md`).
  4. Un **resumen** de lo elegido, y la marca de «ya configurado».

Frases del dueño (2026-09-25):

> "necesito que aquí también esté el logo de Picode arriba del nombre de PiCode - Agentic
> code editor"
>
> "Esta es la pantalla de bienvenida, quiero quitar todo lo de start y recent y añadir una
> bienvenida de verdad y configurar ciertas cosas por primera vez, como el pi que vamos a
> usar (si interno o externo), si vamos a usar gentle-ai (aunque lo vamos a incluir, me
> gustaría que pudiera desactivarse todo de gentle-ai y usar Pi básico sin gentle-ai y sus
> extensiones, agentes, skills, etc). Y luego elegir el tema de la galería que te pasé."

## Dónde vive cada cosa (regla del núcleo)

La regla es que no hay extensión propia y que todo va al núcleo. El conector vive en
`extensions/picode/` (que **es** núcleo: se compila con el editor y viaja en el binario),
y las superficies en `src/vs/`:

| Pieza | Sitio | Cómo llega |
| --- | --- | --- |
| Bienvenida (logo, textos, acciones) | `src/vs/workbench/contrib/welcomeGettingStarted/` | parche `19-picode-welcome.patch` |
| Elección de pi (`picode.pi.runtime`), resolución del pi externo | `extensions/picode/src/` (conector) + registro del ajuste en `contrib/picode/browser/picodeConfiguration.ts` | parche `20-picode-setup.patch` |
| Asistente de primeros pasos (QuickInput, 4 pasos) | `extensions/picode/src/onboarding.ts` (conector: es flujo, no superficie) | el mismo parche 20 |
| Marca de «ya configurado» | `context.globalState` del conector (`picode.onboarding.done`) | ídem |

El asistente es **nativo** (QuickPick/QuickInput del editor), no un webview: la superficie
es la del editor. El paso de tema **no rehace la galería**: usa los dos caminos que el
editor ya trae — su selector de temas nativo (vista previa viva al recorrer) y la galería
de extensiones para instalar temas nuevos. La galería completa de la extensión retirada
(`theme-view.ts` + webview) sigue siendo el trabajo M del programa de migración.

## Decisiones

| Decisión | Elección | Razón |
| --- | --- | --- |
| Logo en la bienvenida | El **dibujo de trazos** (`distribution/picode.svg`), inline en el DOM con `currentColor` | La regla del marcador de agua: a ese tamaño la placa se ve como un bloque; `currentColor` lo pinta del color del tema (claro u oscuro) sin SVGs duplicados |
| El asistente, ¿webview, QuickInput o en la página? | **Dentro de la propia página de bienvenida** (corrección del dueño: "El setup no puede ser interactivo en la misma ventana? sin tener que abrir popups o modals?") | La página renderiza las opciones y llama por comandos al conector; sin quick inputs ni modales. La primera versión con QuickInput se retiró con esta corrección |
| Gentle AI y el pi externo | **No se pregunta**: con el pi externo elegido, la fila de Gentle AI no aparece (corrección del dueño: "el gentle-ai que se instala deberá ser para el pi interno solamente y solo se lo preguntas para él") | Gentle AI vive en el perfil interno; el perfil externo no es del editor |
| Rediseño visual (ronda 3, 2026-09-25) | **Tarjetas con jerarquía**, iconografía de estado, hover y foco visibles, apilado responsive; selector de pi con metadatos en vivo (versión, ruta, aviso si no hay pi en el PATH); CTA de importación desde el perfil externo con recuentos antes de confirmar; Gentle AI de tres estados (no instalado / instalando inline / instalado con versión, actualizar y quitar); galería de temas en cuadrícula con miniaturas reales, buscador, filtro Dark/Light/High-contrast, badge «Current», vista previa en vivo al pasar el ratón (apply con target `preview` y restauración al salir) y paginación «Show more» | Petición explícita del dueño en cuatro frentes; las miniaturas salen de los datos del propio tema (cargados de su fichero en disco, de forma diferida por página), no de capturas ajenas |
| Wizard de 3 pasos (ronda 4, 2026-09-25) | Las mismas tres tarjetas, **una por pantalla**: puntos y «1 of 3 — pi» arriba; Back / Next / Skip iguales abajo; «Not now» a la derecha en cualquier paso. El Next del paso 1 queda deshabilitado hasta pulsar una opción (pulsar la ya en fuerza también cuenta, para no secuestrar un setup acabado); el paso 3 no tiene Skip y su Next es «Done», que marca el setup como hecho y ofrece revisarlo. La tarjeta del tema llega preseleccionada con el tema en fuerza y la galería gana el ancho que antes compartía | «Esto es solo cambiar cómo se presenta, no rehacer nada de lo ya construido»: lógica de datos, importación, Gentle AI y galería intactas |
| Importación de credenciales | Casilla **desmarcada** dentro de la confirmación de importación | La regla del AGENTS: copiar credenciales es siempre decisión del dueño |
| Elección de pi | Ajuste nuevo `picode.pi.runtime`: `internal` (por defecto) \| `external` | Son las palabras del dueño («si interno o externo»); el conector del core hoy resuelve solo el interno, y el externo necesita un resolvedor propio |
| Qué significa «externo» | El pi del PATH **y su perfil** (`~/.pi/agent`, que pi resuelve solo): PiCode lo **lee**, nunca escribe | La regla del AGENTS: nada sale de PiCode hacia fuera; la instancia externa es de solo lectura |
| Gentle AI | Estado = los paquetes instalados o no en el perfil **interno** (`pi install` / `pi remove npm:gentle-pi npm:gentle-engram`); con pi externo el paso explica y no toca nada | El perfil externo es de solo lectura; los paquetes viven en el perfil, no en el editor |
| Paso de tema | Lista de temas instalados dentro de la propia sección (se aplica al pulsar) + «Browse more themes…» que abre la galería de extensiones | Reusar las superficies del editor en la misma página; la galería con miniaturas es la feature M pendiente |
| Cuándo se abre solo | Primer arranque: sin marca `picode.onboarding.done` **y** sin proveedores configurados **y** perfil interno sin credenciales. Nunca encima de una configuración que funciona | La regla ya escrita en `picode-ui-program.md` (tarea 10) |
| Repetible | Sí: comando `PiCode: Set up PiCode` y el botón de la bienvenida, siempre | El dueño pidió poder cambiar de pi / Gentle AI / tema después |

## Hechos verificados (2026-09-25, no supuestos)

- `workbench.startupEditor` ya tiene por defecto `'welcomePage'`
  (`gettingStarted.contribution.ts`), así que la bienvenida abre sola en el primer
  arranque sin tocar `distribution/settings.json`.
- Los parches heredados de VSCodium **ya tocan** `gettingStarted.ts`
  (`00-community-add-announcements.patch` añade el bloque de anuncios), así que el parche
  nuevo se autoría contra el árbol preparado completo y se compone con eso.
- `pi` 0.86.1 trae `install` y `remove`/`uninstall` de fuentes de extensión: el paso de
  Gentle AI no inventa comandos.
- El conector del core carga el SDK siempre de `resources/pi-runtime`
  (`piSdk.ts`); no existe hoy elección de pi en el core — la tenía solo la extensión
  retirada (`runtime.ts`), con `resolveOnPath` + `findSdkEntry` listos para portar.
- `createAgentSessionServices` ya acepta `agentDir` como parámetro (`agent.ts`), así que la
  elección interna/externo viaja por el camino existente.
- El `index` de `picode-source` está en el fuente pino (upstream), no en el árbol
  preparado: un `git diff` suelto mezclaría los parches heredados con los cambios nuevos.
  Por eso cada parche nuevo se genera con el pase acumulativo
  (reset → preparar → `git add -A` → restaurar el snapshot → `git diff`), igual que hace
  `dev/update_patches.sh`.

## Tasks

- [x] **T1 — La bienvenida.** Logo encima del nombre, fuera Start/Recent/walkthroughs/
      anuncios, columna de bienvenida con «Set up PiCode», «Open Folder…», la casilla de
      «mostrar al arrancar», y su CSS. Parche `19-picode-welcome.patch`.
- [x] **T2 — Elegir el pi.** `picode.pi.runtime` (`internal`/`external`) registrado en el
      core; resolvedor del pi externo (PATH + `findSdkEntry`) en el conector; `piSdk.ts` y
      las llamadas con `agentDir` pasan por él. El interno sigue siendo el de por defecto.
- [x] **T3 — El asistente.** `onboarding.ts` con los cuatro pasos (pi, Gentle AI, tema,
      resumen), la marca de primer arranque y el comando `picode.setup` (declarado en el
      manifiesto del conector). Autoapertura solo en la primera configuración real.
- [x] **T4 — Gentle AI sí/no.** Instalar o quitar los dos paquetes en el perfil interno con
      el CLI de pi; explicación honesta cuando el pi elegido es el externo.
- [x] **T5 — Tema.** El paso del asistente con el selector nativo y la galería de
      extensiones; avanzar cuando el tema cambia.
- [ ] **T6 — Verificación.** Compilación del conector y del workbench; comprobación de los
      módulos puros; el build completo cuando toque.
- [ ] **T7 — Cierre.** Commits de unidad de trabajo, informe.

## Evidence
- **Ronda 6 (2026-09-26): hallazgo mayor — el descubrimiento de personalizaciones está
  huérfano.** El dueño pidió: skills de Gentle en el chat como `/gentle:…`, los agentes de
  Gentle en el selector de agentes del chat, y la vista de estado con el logo en la barra
  lateral. Diagnóstico con el fuente en la mano:
  - El popup de `/` del chat lista los skills del perfil de la **máquina** (`/winui-app`
    etc. vienen de `~/.pi/agent/skills` vía el sistema de personalizaciones del fork).
  - Gentle vive en el **perfil interno** (`data/pi-agent`), que ese sistema no mira — y el
    paquete de gentle-pi además guarda sus skills y agentes **dentro de su npm package**
    (`npm/node_modules/gentle-pi/{skills,assets/agents}`), doblemente fuera.
  - La clase que parecía el gancho (`SessionCustomizationDiscovery`,
    `platform/agentHost/node/copilot/`) está **preparada pero sin cablear**: nadie la
    importa, el bundler la poda (verificado: recompilación completa con el estado
    incremental borrado y la extensión sigue ausente de `agentHostMain.js`).
  - Parche 23 creado con la extensión de la tabla de descubrimiento (perfil de PiCode +
    `gentle-pi/{assets/agents,skills}`) — queda como base de la ronda de cableado, que es
    la pieza M que falta: **conectar el descubrimiento al camino vivo** de
    personalizaciones del fork (quién publica el snapshot que las sesiones leen).
  - **Corrección posterior (verificación en el binario)**: la tabla de descubrimiento
    entera — incluidas las entradas `~/.pi/agent` del parche 07 — **no llega al bundle
    compilado** (`agentHostMain.js` sin rastro de `~/.pi/agent` ni de la tabla; recompilación
    completa con el estado incremental borrado, mismo resultado). La clase es código muerto
    en el build actual: su único importador (`sessionPluginBundler.ts`) solo la usa por
    tipos. Consecuencia: extenderla no basta — la ronda de cableado debe encontrar el
    servicio VIVO que lista `/winui-app` (candidatos: `aiCustomizationWorkspaceService.ts`,
    `agentCustomizationItemProvider.ts`, el sistema de plugins del chat) y enchufar ahí el
    escaneo de los perfiles de pi (máquina + interno) y del paquete de gentle-pi.
  - **Verificado en el build final (00:05 → 01:16)**: la clase de descubrimiento sigue
    fuera del bundle incluso con recompilación completa (`out/tsbuildinfo` borrado) —
    confirmación definitiva de que está **sin cablear** (nada la importa; el tree-shaking
    la poda). El parche 23 queda en disco inerte hasta la ronda de cableado. Lo que SÍ
    viaja en el build: el espejo de skills/agentes de Gentle al perfil + su registro en
    `chat.agentSkillsLocations` / `chat.agentFilesLocations` — el escáner del chat
    (`findAgentSkills`) que acepta rutas absolutas tras relajar el patrón del core.
    **Pendiente de prueba del dueño**: los skills de Gentle en el popup `/` y sus agentes
    en el selector.
  - La vista de estado (icono en la barra lateral) también queda para esa ronda: el SDK de
    pi expone lo necesario (entradas de sesión con `usage`) — investigación hecha.
  El resto del wizard (pasos 1-2, proveedor/modelo, Gentle con agentes) verificado en el
  build de las 00:05 y anterior. Sin commitear (CI/CD del dueño en curso).
- **Ronda 5 (2026-09-26): el wizard se convierte en flujo completo de puesta a punto.**
  Cuatro pasos: pi → **proveedor y modelo** (solo con el interno; suscripción OAuth vía
  `picode.connectProvider` o proveedor a mano — proyectado al perfil con el mismo
  `projectDeclaration` de la fila de ajustes — y la lista de modelos **traída del
  proveedor**, con una elegida como `default_model` del perfil) → **Gentle AI** (siempre
  la última versión — npm sin versión fija — y tras instalar, los **23 agentes de
  gentle-pi** con modelo elegible por agente, escrito en `subagents.json`
  `model_profiles`, el formato que `agents-config.ts` de gentle-pi parsea) → temas.
  Con el pi externo: paso de proveedor sustituido por una tarjeta explicativa y Gentle
  atenuado. Puente nuevo: `wizard-models.ts` (providerAddManual, modelsList, modelDefault,
  gentleAgents, gentleAgentModels). Sin commitear: el dueño está en el CI/CD.
- **Defecto del dueño, encontrado en su máquina (2026-09-25): la clave del runtime.**
  "Unable to write to User Settings because picode:picode.pi.runtime is not a registered
  configuration". La causa era mía: la escritura (y la lectura) usaban la clave **completa**
  (`picode.pi.runtime`) sobre una configuración **de sección** (`picode`), así que la clave
  real era `picode.picode.pi.runtime` — no registrada. Corregido en el puente: la clave
  completa sobre la configuración raíz, en lectura y escritura.
- **Barra de estado (2026-09-25): fuera «Copilot Status».** La contribución
  `ChatStatusBarEntry` aparecía porque el propio agente de PiCode mantiene el chat vivo;
  anunciaba Copilot, que este producto retiró. Registro e import eliminados (parche 22).

- **T1–T5 (código).** Escritos y compilando: el conector pasa su `tsc` propio estricto
  (`extensions/picode/tsconfig.json`, `--noEmit`, 0 errores) con todo dentro —
  `piLocate.ts`, `runtime.ts`, `onboarding.ts` (hoy puente de comandos del setup), y los
  cambios en `piSdk.ts`, `agent.ts`, `login.ts`, `extension.ts`. El chequeo de tipos del
  workbench completo (`src/tsconfig.json`) cubre la bienvenida, la sección de setup y el
  registro del ajuste: **0 errores**.
- **Defecto latente arreglado de paso:** las llamadas al CLI de pi desde el host de
  extensiones no ponían `ELECTRON_RUN_AS_NODE=1` — `process.execPath` es el ejecutable de
  Electron y sin la bandera intenta abrir una app en vez de ejecutar el script. Estaba así
  en la instalación del adaptador MCP del conector; corregido en ambos sitios.
- **Corrección 1 (dueño, 2026-09-25): los ojos del logo.** El fallo era mío: los círculos
  del SVG fuente llevan `stroke="none"`, y yo quitaba el atributo en vez de ponerlo, así
  que heredaban el trazo de 84 unidades del grupo y salían como manchas (los ojos ocupaban
  la cara entera). Corregido: `stroke="none"` explícito, igual que en el SVG fuente.
- **Corrección 2 (dueño, 2026-09-25): el setup dentro de la página.** La primera versión
  usaba QuickInput (popups). Rehecha: la página de bienvenida renderiza las secciones (pi,
  Gentle AI, tema) y llama a comandos del conector (`picode.setup.getState`,
  `applyRuntime`, `applyGentle`, `complete`); cada acción re-renderiza con el estado que el
  comando responde. Sin popups ni modales.
- **Corrección 3 (dueño, 2026-09-25): Gentle AI solo para el pi interno.** Con el pi
  externo elegido, la fila de Gentle AI no se renderiza; el puente tampoco permite
  instalarla ahí (la acción responde con la explicación si alguien la llama).
- **T6 — Verificación.**
  - `extensions/picode/tsconfig.json` (`--noEmit`, estricto): **0 errores** con todo el
    conector nuevo dentro.
  - `src/tsconfig.json` completo (el núcleo entero, `--noEmit`): **0 errores** con la
    bienvenida y el ajuste nuevo.
  - Los parches se generaron con el pase acumulativo (reset → baseline → aceptar en el
    índice → diff), el mismo mecanismo de `dev/update_patches.sh`. **Defecto del proceso,
    encontrado y corregido:** regenerar un parche que ya está en la carpeta hace que la fase
    de baseline lo aplique, y el resultado sale como un delta que no puede aplicarse solo.
    La regeneración correcta saca los parches en edición de la carpeta antes del baseline
    (hecho en la segunda regeneración; los parches quedaron verificados como diff completo
    contra el estado de los parches 01–18).
  - Compilación y empaquetado completos (`dev/build.sh -s`): en marcha al cerrar esta
    sesión; el resultado queda en `PiCode-win32-x64/`.
- **Commits.** `81a160b` (T1, parche 19 v1) y `a6859d9` (T2–T5, parche 20 v1); tras las
  correcciones del dueño, `b07fdb9` (ojos del logo + regeneración del parche 19 sobre línea
  base limpia) y `d5c97c1` (setup dentro de la página + Gentle AI solo para el interno +
  regeneración del parche 20). Todos sobre `Master`, como el resto del historial.
## La galería de temas del paso 6 salía vacía (2026-10-01, noche)

**Síntoma que reportó el dueño:** en «Set up PiCode», paso *6 of 6 — Theme*, la pestaña
**Gallery** contestaba «Nothing in the gallery for that search.» y nada más.

**Causa raíz, medida.** El **conector empaquetado** no registraba los comandos de la galería.
`extensions/picode/src/extension.ts` llama a `registerThemeGalleryCommands(context)` y la
propia fuente lo avisa por escrito («Without this registration they do not exist, and the
gallery answers an empty list as if the search had found nothing»), pero el `out/extension.js`
que llevaba el editor **no requería `./theme-gallery`**: cero menciones a «theme» en todo el
fichero. Los tres comandos viajan del núcleo al conector (`picode.setup.gallerySearch`,
`galleryThumb`, `galleryInstall`), así que la página pedía un comando que **no existía**,
`executeCommand` rechazaba la llamada, y el `catch` de la página pintaba la lista vacía.

Lo que se descartó antes de acusar al conector, para no volver a mirarlo:
- El catálogo está sano: el módulo compilado del propio conector (`theme-catalog.js`) devuelve
  **40 candidaturas y 233 temas** contra Open VSX en vivo, con `manifestUrl` derivado del
  `downloadUrl` (la búsqueda no trae `files.manifest` en ninguna fila: 0 de 40).
- La base del registro se deriva bien de `product.json` → `https://open-vsx.org/api`.
- No hay proxy en los ajustes del perfil, y el editor **sí** está activado (`picode.picode`,
  `activationEvent: 'onChatParticipant:picode.pi'` en `exthost.log`).
- El núcleo **sí** trae el paso de temas: el bundle empaquetado contiene `picode-theme-grid`,
  `picode.setup.galleryThumb` y `picode-theme-show-more`.

**Por qué nadie lo vio en pantalla.** El paso de temas no podía decir nada: la nota de error se
creaba dentro de la tarjeta del paso *Provider* (`renderNote`) y `setNote` escribía en ese nodo,
que ya no está en el documento al cambiar de paso. **Un error en el paso 6 era invisible.** El
defecto real no era un fallo silencioso: era un fallo **mudo**.

**Arreglos (núcleo, `picodeSetup.ts`).**
1. `galleryError`, separado de la lista vacía: la rejilla dice ahora *«The gallery could not be
   read: …»* con el motivo, en vez de afirmar que la galería no tiene nada.
2. Una respuesta ausente del conector cuenta como error explícito, no como lista vacía.
3. `paintGalleryGrid` pinta solo la rejilla: al llegar una respuesta ya no se vuelve a montar la
   tarjeta entera (antes añadía **una segunda caja de búsqueda** por cada respuesta).
4. `noteLine` ya no secuestra `this.note`; la nota viva la crea `renderWizard` en cada paso, así
   que `setNote` siempre tiene dónde escribir (afecta también a los fallos al aplicar un tema).
5. El conector se recompila antes de empaquetar (`dev/build-connector.sh`, fase 2 de
   `dev/build.sh`): el paquete que llevaba el editor era anterior al registro de los comandos.

6. `installFromGallery` aplicaba el tema con el destino `undefined`, que **no escribe nada**
   (`themeConfiguration.writeConfiguration` sale antes de tocar los ajustes: `undefined` y
   `'preview'` son «no guardar»). Elegir un tema en la galería cambiaba la ventana y no quedaba
   en `workbench.colorTheme`: al reiniciar, el tema era otro. La rejilla de instalados ya usaba
   `'auto'` desde una corrección anterior; la galería se había quedado atrás. Ahora usa `'auto'`.
7. La instalación daba por hecho lo que no había comprobado: `workbench.extensions.installExtension`
   resuelve **cuando el paquete está en disco**, no cuando el registro de temas lo conoce, así que
   pedir la lista en la línea siguiente podía volver sin el tema recién instalado y el paso decía
   «installed and applied» sobre una ventana que no había cambiado. Ahora espera al registro
   (`waitForInstalledTheme`, 10 intentos de 300 ms) y, si no aparece, lo dice en vez de afirmarlo.
8. De paso: `startImport` recibía un `result` que no leía (usaba `this.importResult`).

**Evidencia.** `dev/build-run.sh` completo, estado **0**: `picode-typecheck-min` sin errores
(10,7 s), paquete reconstruido y perfil restaurado (71.475 ficheros). El conector se recompila en
la fase 2, que es lo que faltaba para que los comandos existan.

**Pendiente tras esta anotación:** prueba del dueño en el editor reconstruido (galería con temas y
tema aplicado y guardado al elegirlo).
