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
| El asistente, ¿webview o QuickInput? | **QuickInput nativo** | No crea superficie nueva (la regla del núcleo), es lo que el editor ya usa para sus propios flujos, y el paso de tema necesita cerrar y reabrir el foco de todas formas |
| Elección de pi | Ajuste nuevo `picode.pi.runtime`: `internal` (por defecto) \| `external` | Son las palabras del dueño («si interno o externo»); el conector del core hoy resuelve solo el interno, y el externo necesita un resolvedor propio |
| Qué significa «externo» | El pi del PATH **y su perfil** (`~/.pi/agent`, que pi resuelve solo): PiCode lo **lee**, nunca escribe | La regla del AGENTS: nada sale de PiCode hacia fuera; la instancia externa es de solo lectura |
| Gentle AI | Estado = los paquetes instalados o no en el perfil **interno** (`pi install` / `pi remove npm:gentle-pi npm:gentle-engram`); con pi externo el paso explica y no toca nada | El perfil externo es de solo lectura; los paquetes viven en el perfil, no en el editor |
| Paso de tema | El selector nativo (`workbench.action.selectTheme`, vista previa viva) + «instalar más temas» que abre la galería de extensiones (`@category:themes`); el asistente avanza cuando `workbench.colorTheme` cambia | Reusar la superficie del editor en vez de portar la galería webview; la galería completa es la feature M pendiente |
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

- **T1–T5 (código).** Escritos y compilando: el conector pasa su `tsc` propio estricto
  (`extensions/picode/tsconfig.json`, `--noEmit`, 0 errores) con todo dentro —
  `piLocate.ts`, `runtime.ts`, `onboarding.ts`, y los cambios en `piSdk.ts`, `agent.ts`,
  `login.ts`, `extension.ts`. El chequeo de tipos del workbench completo (`src/tsconfig.json`)
  cubre la bienvenida y el registro del ajuste.
- **Defecto latente arreglado de paso:** las llamadas al CLI de pi desde el host de
  extensiones no ponían `ELECTRON_RUN_AS_NODE=1` — `process.execPath` es el ejecutable de
  Electron y sin la bandera intenta abrir una app en vez de ejecutar el script. Estaba así
  en la instalación del adaptador MCP del conector; corregido en ambos sitios.
- **T6 — Verificación.**
  - `extensions/picode/tsconfig.json` (`--noEmit`, estricto): **0 errores** con todo el
    conector nuevo dentro.
  - `src/tsconfig.json` completo (el núcleo entero, `--noEmit`): **0 errores** con la
    bienvenida y el ajuste nuevo.
  - Los parches se generaron con el pase acumulativo (reset → baseline → aceptar en el
    índice → diff), el mismo mecanismo de `dev/update_patches.sh`: el parche 19 nace del
    estado tras el parche 18, y el 20 del estado tras el 19. Por construcción aplican
    limpios en el siguiente build.
  - Compilación y empaquetado completos (`dev/build.sh -s`): en marcha al cerrar esta
    sesión; el resultado queda en `PiCode-win32-x64/`.
- **Commits.** `81a160b` (T1, parche 19) y `a6859d9` (T2–T5, parche 20), sobre `Master`
  como el resto del historial del repositorio.
