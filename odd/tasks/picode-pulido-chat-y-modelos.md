# Tarea: ronda de pulido — asistente, carga de modelos, packages, dominios de confianza y chat

> Segunda ronda del 2026-09-28, peticiones del dueño sobre el editor ya construido.
> La ronda anterior vive en `picode-management-round.md`.

## Puntos pedidos

1. **Asistente de primer arranque**: «The pi on this machine» pasa a «External Pi», con
   texto más claro; el probe del PATH no debe dejar al dueño sin respuesta.
2. **Lista de modelos (Language Models)**: mientras carga (~30 s con pi externo) no dice
   nada. Pon un estado de carga dentro de la tabla.
3. **Packages**: cambia el icono de Disable (el ⊘ no dice nada) y mejora los textos para
   que digan qué hacen; las filas sin origen quedan sin acciones y sin explicación.
4. **Dominios de confianza**: los dominios que abre el producto (mcp.directory, skills.sh,
   pi.dev) van en la lista de confianza por defecto — el aviso «Do you want PiCode to open
   the external website?» no debe salir para ellos.
5. **MCP**: «Browse Marketplace» pasa a «Browse MCP's».
6. **Chat**: fuera el selector de modo («Ask» / «Configure Custom Agents...») del input.
7. **Chat**: junto al modelo, un selector de **nivel de thinking** (off…max) — escribe
   `pi.thinkingLevel` y el conector lo aplica en el siguiente turno.
8. **Chat vacío**: «Ask about your code» pasa a un saludo del producto («Hello, I'm
   PiCode…») y el icono del chat por la marca de PiCode (el dibujo de trazos).

## Terreno verificado

- **1** · `picodeSetup.ts:373-377` — label/detail/meta del pi externo; `:416/:447` el
  «not found». El probe corre mientras la tarjeta ya está pintada (meta «Looking for it
  on the PATH…»), así que el retraso es del probe (8 s de tope); el texto nuevo debe
  explicar qué pasa mientras tanto.
- **2** · `chatModelsWidget.ts:1190-1191` — el progreso va al título del editor
  (`editorProgressService.showWhile`), invisible en la práctica. La tabla se pinta en
  `render()` (:1717); falta una fila de estado «Loading models…» con animación mientras
  el viewModel no ha resuelto.
- **3** · `pluginListWidget.ts:305-308` — Enable usa `Codicon.check`, Disable
  `Codicon.circleSlash`; tooltips en :306/:307. Filas huérfanas (instaladas en disco sin
  declaración): sin acciones ni explicación hoy.
- **4** · `src/vs/workbench/contrib/url/browser/trustedDomains.ts` — el ajuste
  `http.trustedDomains`; añadir los dominios del producto como valores por defecto.
- **5** · `mcpListWidget.ts` — `localize('browseMarketplace', "Browse Marketplace")`.
- **6** · `chatInputPart.ts` — el `ModePickerActionItem` se crea para
  `OpenModePickerAction.ID` (~:3421); el móvil usa `MobileChatInputCombinedPickerActionItem`
  (~:3403) con modeDelegate. No tocar el resto: el modelo y los demás pickers se quedan.
- **7** · El nivel vive en el ajuste **`pi.thinkingLevel`**
  (`extensions/picode/src/piConfig.ts:26/:56`, niveles en `THINKING_LEVELS`); el agente lo
  aplica en cada turno (`agent.ts:771/:790-791`). El chip del input escribe ese ajuste
  (Global) y se repinta con el valor en fuerza.
- **8** · `chatWidget.ts:1623` — título de la vista de bienvenida; el icono es un codicon
  del proveedor/contribución (~:1603-1630). La marca del producto está en
  `src/vs/workbench/contrib/picode/browser/media/picode.svg` (trazos, la misma del editor
  vacío). Cómo se referencia media desde el núcleo: ver cómo el editor vacío importa
  `picode.svg`.

## Unidades

| # | Puntos | Quién |
| --- | --- | --- |
| V1 | 6+7+8 (chatInputPart + welcome: mismo fichero) | worker |
| V2 | 5 (etiqueta Browse MCP's) | inline |
| V3 | 4 (dominios de confianza por defecto) | inline |
| V4 | 1 (External Pi + textos) | inline |
| V5 | 3 (icono y textos de Packages) | inline |
| V6 | 2 (carga en la lista de modelos) | inline |

## Cierre (2026-09-28, tarde)

| Commit | Punto |
| --- | --- |
| `d4448626` | 2, 3, 4, 5 y 1 — Browse MCP's, dominios de confianza, External Pi, packages (pausa/play + estados), fila de carga en modelos |
| `f43edfea` | resto del 6 de la ronda anterior — test alineado con la firma del banner quitado |
| `c8813c50` | 6, 7 y 8 — sin chip de modo, chip de thinking junto al modelo, saludo «Hello, I'm PiCode» con la marca |

Verificación: typecheck del núcleo en 0 tras cada unidad; build completa al cierre.

Decisiones tomadas en esta ronda:

- D1 · P7: el chip escribe el ajuste **`picode.pi.thinkingLevel`** (el del núcleo, el
  mismo que lee el conector vía `getConfiguration('picode').get('pi.thinkingLevel')`),
  a nivel de usuario; «Default» lo limpia. Niveles: off · minimal · low · medium · high ·
  xhigh · max. El cambio vale para el siguiente turno.
- D2 · P6: el comando del selector de modo y su atajo siguen registrados (los usa el
  comando de barra `/agents`), pero el chip no se pinta: en escritorio `/agents` y
  Ctrl+Periodo quedan sin efecto visible — apuntado por si el dueño quiere redirigirlos.
- D3 · P8: el saludo es «Hello, I'm PiCode» con la marca de trazos (máscara CSS, tinta del
  tema); el aviso de exactitud se queda; el enlace «Generate Agent Instructions» y su
  maquinaria, fuera del bloque de bienvenida.
- D4 · P4: dominios de confianza por defecto en `product.json`
  (`linkProtectionTrustedDomains`): open-vsx (ya estaba), mcp.directory, skills.sh,
  www.skills.sh y pi.dev.
- D5 · P3: el estado de una fila sin declaración es «Not declared» (pi no la carga), con
  explicación en el sitio de las acciones; los botones hablan de lo que pasa
  («Pi stops loading this package. Its files stay on disk.»).
- D6 · P2: la fila de carga vive en la tabla y desaparece cuando la primera lista
  resuelve; el progreso del editor se queda también, por si acaso.

## Añadido posterior: import real del perfil externo (`b1c0c0a3`)

Lo que el dueño pidió: al detectar pi externo y elegir «pi interno» en la página de pi,
importar TODO (skills, proveedores, packages…). El hueco real no era la oferta (ya existía
desde el primer árbol): era que el import **no traía nada ejecutable de los packages** —
copiaba las declaraciones del `settings.json` pero los ficheros seguían en el npm del pi
externo — y **los proveedores no se nombraban** en la oferta.

Arreglo:
- El panel de importación se abre **expandido** al elegir interno con pi externo detectado.
- La oferta cuenta **Providers** (tabla `providers` de models.json) además de packages,
  MCP, skills y sesiones.
- Tras la copia, cada package declarado se **instala de verdad** en el perfil interno con
  el CLI de pi (el mismo instalador en cola de la página de Packages), y el resultado dice
  cuántos entraron y cuántos fallaron.
- La regla de siempre se mantiene: el perfil externo solo se lee; en el interno se fusiona,
  nada se borra; las credenciales (`auth.json`) siguen detrás de la casilla explicita.

## Añadido posterior: el asistente habla como la gente (`fe219a17`)

La captura del import funcionando delató el tono: «profile», «PATH», «in force»,
«auth.json», «copied/overwritten» — y hasta la ruta absoluta del pi externo pintada.
Todo el texto de la página de pi pasa a responder lo que el dueño está decidiendo:

- Externo: «Found on your computer — ready to use» (con versión; **la ruta absoluta
  sale de la interfaz para siempre**, regla del dueño).
- Cabecera: «Using the pi inside PiCode» / «Using your machine's pi».
- Import: «AI connections» (proveedores), «Conversations» (sesiones), la casilla de
  logins sin nombre de fichero, y la nota: «Everything is copied into PiCode. Nothing
  is deleted — your external pi keeps working exactly as it is.»
- Resultado: «Ready: X items brought over, Y updated. N packages installed, M failed.»

## Añadido posterior: el import se ejecuta solo (`25fb8864`)

Lo que el dueño vio al probarlo: el pi interno no parecía seleccionado por defecto, el
Next se habilitaba «sin poder marcarlo», la importación pedía tres clics más y no se veía
progreso, y al acabar no se sabía si proveedores y modelos habían entrado.

Arreglo:
- El pi interno aparece **marcado desde el principio** (es el default; antes la marca
  dependía del valor exacto del ajuste).
- La oferta aparece cuando el perfil de la máquina tiene algo que traer (proveedores
  incluidos en el cálculo) y **el import arranca solo**, sin segundo botón.
- **Barra de progreso real**: el conector cuenta un paso por la copia, uno por cada
  package y uno por el refresco; la página lo consulta cada 500 ms y mueve la barra con
  la línea que va («Installing package 3 of 20: npm:pi-lens…»). Mismo patrón que el
  instalador de Gentle. Un import cada vez, forzado.
- Sin casilla de credenciales a mitad de flujo: el import automático lo trae todo menos
  los logins, y al terminar ofrece una vez «Sign in with my saved logins» (copia solo
  auth.json).
- Al terminar, el conector suelta las cachés de modelos y repinta el selector: los
  proveedores y modelos importados aparecen **sin reiniciar**.
