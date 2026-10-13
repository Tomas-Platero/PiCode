# El durable como destino de chat (el paso gordo)

> «pues ponte con el paso gordo» — dueño, 2026-10-09, tras ver el durable en el panel

## Qué era y qué pasa a ser

Hasta hoy el chat del editor corría siempre en el pi interno (Local) y el durable solo
**recibía trabajo delegado** (`durable_send`) y se leía en el panel. El chip bajo el input
decía «Local» y el menú «Continue in» estaba vacío (sin Copilot CLI/Cloud/Codex/Claude no hay
nadie a quien entregar nada).

Hoy **durable es un destino de chat**: en el selector bajo el input aparece *Durable* al lado
de Local (y pi), se puede abrir una conversación nueva cuyo motor es el daemon, y el menú
«Continue in Durable» existe de verdad. La conversación vive en el SQLite del daemon, así que
sobrevive a cerrar la pestaña y a recargar la ventana.

## Las tres piezas

### 1. El manifest declara la contribución (`extensions/picode/package.json`)

```json
"chatSessions": [{ "type": "durable", "name": "durable", "displayName": "Durable",
  "icon": "server-process", "canDelegate": true, "supportsAutoModel": true,
  "welcomeTitle": "Durable", "welcomeMessage": "…" }]
```

Con ella el núcleo registra solo: el agente dinámico `@durable`, los comandos «New Durable
Session» (in-place / editor / sidebar), la entrada del chip (elige la contribución, usa su
`displayName` y su icono), y la entrada «Continue in Durable» (por `canDelegate`). Sin
`when`, la contribución está siempre disponible. `supportsAutoModel` es lo que evita que el
chip se grise por «sin modelos»: el modelo lo elige el daemon con sus propios ajustes, y el
selector enseña *Auto*.

### 2. El daemon acepta `cwd` por protocolo (`picode-source/durable/lib/daemon.js`)

Sin esto, las herramientas de una conversación durable correrían en **la carpeta del daemon**
(`resources/durable`), no en el proyecto — inútil para programar. Ahora `open`, `run` y `fork`
aceptan `params.cwd`: solo una ruta **absoluta** se acepta (una relativa significaría
«donde se arrancó el daemon»), y `run` puede reubicar una conversación existente
(`AgentChange.cwd` del propio pi-durable). `agentFor` está exportado y pinado por tests.

### 3. El chat interactivo (`durable-sessions-register.ts`)

`provideChatSessionContent` devuelve ahora `requestHandler` para **ambos** casos:

- **Sesión nueva** (`durable:/untitled-<uuid>`, la forma que `getResourceForNewChatSession`
  da a toda sesión nueva de un tipo contribuido): historial vacío + handler.
- **Sesión real** (`durable:/N`): historial reproducido del daemon + handler (el chat sigue).

El handler (`runDurableTurn`) por turno:

1. `cwd` = `resolveSessionCwd` (la primera carpeta del workspace que exista en disco, la de
   usuario si ninguna — la misma regla que las sesiones de pi, por el mismo motivo: una
   carpeta fantasma convertía cada comando en un ENOENT sin sentido).
2. Si es nueva: `open {cwd}` → la daemon crea la conversación.
3. `subscribe` **antes** de `run` — así no se pierde ni un delta de la respuesta; los
   eventos viajan por la misma conexión (el cliente ya reparte los push por
   `DaemonClient.onEvent`).
4. `run {conversationId, prompt, cwd}` y, mientras espera, los eventos se mapean con
   `DurableRunStreamMapper` (deltas → markdown; `message_end` de respuesta no transmitida →
   texto completo; herramientas → línea de progreso; fallo de tarea → aviso). Las reglas son
   las del propio renderer del CLI (`durable/lib/render.js` `makeRunRenderer`): **una
   respuesta ya transmitida por deltas no se reescribe al terminar**.
5. Cancelar = `cancel` al daemon; el `run` se resuelve como *unanswered* y el turno acaba.
6. Daemon caído → una frase honesta en el chat («no durable daemon is running…»), no un
   modal de error.
7. **El reenganche untitled→real ocurre DESPUÉS de que el run asiente**, nunca a mitad de
   respuesta: `onDidCommitChatSessionItem` con las dos URIs (solo las URIs cruzan el cable)
   y el núcleo migra la pestaña o el sidebar, transfiere el estado de edición y reenvía lo
   encolado (`mainThreadChatSessions.$onDidCommitChatSessionItem`).

## Limitaciones honestas (v1)

- **Adjuntos no reenviados**: el protocolo del daemon lleva un prompt de texto; las
  referencias/imágenes del request no viajan. El agente durable trabaja en la misma carpeta
  y puede abrir los ficheros si se le nombran. Es la línea donde crecer si el dueño lo pide.
- **Sin contexto del editor** (fichero abierto, selección): es un agente aparte en la misma
  carpeta, no un pi con el editor delante — eso es lo que «durable» significa.
- El menú «Continue in Durable» entrega el transcribir como prompt inline (camino de
  no-agent-host del núcleo), no como adjunto: para conversaciones largas el prompt es largo.

## Piezas y verificación

| Pieza | Qué |
| --- | --- |
| `durable/lib/daemon.js` | `agentFor` exportado + `cwd` en `open`/`run`/`fork` |
| `extensions/picode/package.json` | contribución `chatSessions` |
| `extensions/picode/src/durable-run-stream.ts` | mapeador puro del stream (7 tests) |
| `extensions/picode/src/durable-sessions-register.ts` | handler + reenganche |
| `extensions/picode/test/durable-daemon-agent.test.ts` | 4 tests del `cwd` |

* Verificado: `tsc` 0 + emit (`out/durable-run-stream.js`, `out/durable-sessions-register.js`),
  suite completa del conector **441 tests, 0 fallos**, sintaxis del daemon y JSON del manifest.
* Pendiente de los ojos del dueño: elegir *Durable* en el chip, enviar un prompt, ver el
  streaming y la supervivencia al recargar. Mismo pack pendiente de siempre (el editor en
  marcha bloquea la build).

## Qué queda fuera (a propósito)

Nada nuevo: el panel, el filtro y el «Continue in» quedaron de la fase anterior; este paso
añade el destino. Lo siguiente sería, si el dueño quiere, reenviar adjuntos por el protocolo.

## Coda: el defecto ya es durable (mismo día, petición del dueño)

> «haz que por defecto sea siemper durable, no local.»

Una pieza más, en el núcleo: `chat/common/constants.ts` — `getComputedDefaultSessionType`
prefiere **durable** en cuanto su contribución está registrada, antes del fallback a Local.
Por ahí pasan TODAS las puertas de chat nuevo (botón +, Ctrl+N, la vista de chat, el editor,
el selector bajo el input — `getDefaultNewChatSessionType`/`getComputedDefaultSessionResource`).

Las reglas que se conservan:

- **La elección del dueño manda sobre el defecto**: `recordUserSelectedSessionType` compara
  contra el defecto computado — elegir Durable ahora LIMPIA la memoria (ya es el defecto) y
  elegir Local la guarda (los chats nuevos siguen siendo Local hasta volver a elegir Durable).
- **Virtual workspace → Local**: sin carpeta en disco, las herramientas del durable no tienen
  donde ejecutarse; el guard upstream lo resuelve antes de llegar a la preferencia.
- **Instante de arranque**: hasta que el conector activa, la contribución no existe y el
  defecto es Local; el chip y el welcome re-resuelven cuando aterriza (`onDidChangeAvailability`).

Verificado: LSP clean en `constants.ts` (los avisos «configurationService never read» son de
funciones upstream Copilot, preexistentes); diff exactamente la constante + la preferencia.
La build completa del núcleo viaja en el pack pendiente de siempre.

## Coda II: durable «sí o si» — Local se retira del selector (mismo día)

> «elige el agente de durable siempre, es que es por defecto si o si… A ver lo que quiero es
> que el "orquestador" siempre sea durable. Y que el agente que lleva las sesiones sea durable.»

El dueño vio que el selector seguía ofreciendo Local y lo cerró: durable no es "el defecto
que se puede cambiar", es EL chat. Dos reglas nuevas en el mismo `constants.ts`:

1. **`getComputedDefaultSessionType`**: la preferencia durable va AHORA ANTES del guard de
   workspaces virtuales — en todas las ventanas, con carpeta o sin ella. Las herramientas
   corren donde la regla de directorio de sesión las pone (primera carpeta existente, la de
   usuario si no hay), así que una ventana virtual también recibe una respuesta honesta.
2. **`isVisibleEditorChatSessionType(local)`**: mientras la contribución durable exista,
   **Local se retira de los selectores** (el chip bajo el input, el selector del Agents
   window) y una elección recordada de «local» deja de ser utilizable — un dueño que eligió
   Local una vez vuelve a durable en el siguiente chat nuevo. Queda el salvavidas upstream:
   si NO existiera ningún tipo no-local (conector ausente o desactivado), Local vuelve a
   ofrecerse, porque algo tiene que responder.

Lo que NO cambia a propósito:

- **El filtro del panel de Sessions sigue teniendo Local y pi**: son el historial que ya
  existía, y retirarlo sería borrar el pasado, no cambiar el futuro.
- Las conversaciones Local ya abiertas siguen abiertas; solo dejan de ofrecerse como nuevo
  destino.
- Los tests upstream (`chat/test/common/constants.test.ts`) no registran ninguna contribución
  durable, así que el mock los deja intactos.

Verificado: LSP sin errores tras el cambio; la compilación del núcleo es la fase 3/5 de la
build que lo empaqueta. Build lanzada con el canal de la rama: `PICODE_CHANNEL=experimental
PICODE_PACK_SUFFIX="-experimental"` (carpeta `PiCode-Win32-x64-experimental`, la del perfil
del dueño; la build anterior sin canal fue a `PiCode-Win32-x64` a secas — lección: la build
SIEMPRE con el canal de la rama en la que se está).

## Coda III: el harness se llama PiCode y durable manda incluso sin carpeta (mismo día)

> «En el chat no quiero usar el harness de local más, quiero usar el de durable como
> default, siempre será durable. … Aunque no pongas durable ni nada así en el harness
> porque estéticamente será PiCode.»

Detrás de la petición hay un malentendido que ya estaba resuelto: el defecto durable y la
retirada de Local del selector viven en `chat/common/constants.ts` desde la Coda II, y el
dueño seguía viendo Local **porque la app en marcha era anterior a esos cambios** (la carpeta
`PiCode-Win32-x64` sin canal, del 9-10, no llevaba la Coda II; la del perfil,
`PiCode-Win32-x64-experimental`, sí). El núcleo de la app instalada tenía `mKt` con la
retirada; el ejecutable viejo no. Lección: **la build SIEMPRE con el canal de la rama**, y
antes de «no funciona» comprobar qué binario está corriendo.

Lo que sí faltaba de verdad, y se ha hecho:

1. **El harness se presenta como PiCode.** En `extensions/picode/package.json`, la
   contribución `chatSessions`/`durable` pasa de `displayName: "Durable"` a **`"PiCode"`**,
   con `welcomeTitle: "PiCode"` y textos que ya no invocan al «durable agent» como nombre
   visible. El `type` y el `name` internos siguen siendo `durable` (es la clave de la
   contribución y del `@` dinámico; renombrar el `type` rompería sesiones y memoria). Lo que
   ve el dueño —chip bajo el input, selector, welcome— dice PiCode.

2. **`getDefaultNewChatSessionType` y `resolveDefaultNewChatSessionType` alineados con el
   cómputo.** La Coda II puso durable por delante del guard de workspaces virtuales en
   `getComputedDefaultSessionType`, pero las dos puertas que resuelven el chat nuevo seguían
   devolviendo Local para una ventana sin carpeta antes de consultar nada. Ahora el guard
   virtual solo devuelve Local **si no existe la contribución durable**
   (`isVirtualWorkspace(workspace) && !getChatSessionContribution('durable')`), de modo que
   «siempre durable» es literal en todas las ventanas. Sin carpeta, las herramientas corren
   donde manda la regla de directorio de sesión (primera carpeta existente, la de usuario si
   no hay), que es lo que la Coda II ya documentó.

3. **Un test lo fija.** `chat/test/common/constants.test.ts` gana «durable retires local and
   stays the default, virtual window included»: con la contribución `durable` registrada, el
   defecto computado y el resuelto son `durable` en workspace normal y virtual, `Local` no
   aparece en el selector y una elección recordada de Local deja de ser utilizable. Los tests
   upstream siguen pasando porque su mock no registra ningún tipo `durable`.

4. **La elección recordada de Local tampoco gana.** Al escribir el test anterior salió un
   agujero real de la Coda II: `isNewChatSessionTypeUsable(local)` devolvía
   `isEditorLocalAgentEnabled(...)` sin mirar nunca si el chat durable existía. La retirada de
   Local en `isVisibleEditorChatSessionType` lo escondía del selector, pero un perfil con
   «local» recordado de antes seguía abriendo chats Local — justo lo que el dueño no quiere.
   Ahora esa rama, cuando la contribución durable está registrada, responde con la misma regla
   que el selector (`getVisibleNonLocalEditorChatSessionTypes(...).length === 0`), de modo que
   la memoria de Local deja de ser utilizable y el siguiente chat nuevo es durable. Sin
   contribución durable el comportamiento upstream queda intacto.

Lo que NO cambia: el filtro del panel de Sessions mantiene Local y pi (es el historial); las
conversaciones Local ya abiertas siguen abiertas; el nombre «Durable agent» permanece en la
página de Status y en los ajustes, como manda `AGENTS.md` — lo que se renombra es la
presentación del harness en el chat, no la pieza.

## Coda IV: el chat que se quedaba en Local por la carrera de arranque (mismo día)

> «por defecto las sesiones salen como local… Hasta que no eligo "PiCode" en el desplegable
> … en local nada.»

Con la build ya con el nombre PiCode en la mano, el dueño reprodujo el síntoma que la Coda II
creía cerrado: el chat abría en **Local** y había que elegir PiCode a mano. El forense:

- El perfil no guardaba **ninguna** preferencia de tipo de sesión (`chat.userSelectedSessionType`
  no existía en ningún `state.vscdb`), así que no era la memoria del dueño.
- El memento de la vista (`memento/interactive-session-view-copilot`) ya decía `durable` — pero
  eso era **después** de que el dueño eligiera PiCode a mano.
- `workbench.desktop.main.js` del pack era **idéntico** al `out-vscode-min` recién compilado, y el
  source map contenía el arreglo: la build estaba bien. El problema no era la compilación.

La causa es una **carrera de arranque**, no la resolución del tipo:

1. La contribución `chatSessions` de `picode` se registra por el *extension point* cuando el
   renderer ya conoce las extensiones; en ese primer instante todavía no está.
2. La vista de chat resuelve su sesión (Coda II y III) antes, así que el defecto computado es
   **Local**, y `shouldSkipRestoredLocalSession` no descarta la sesión Local vacía.
3. Cuando la contribución aterriza, `onDidChangeAgents` sí se dispara — pero el cuerpo upstream
   solo mira `if (!this._widget?.viewModel && !this.restoringSession)`. Como ya hay un chat en el
   widget, **no hace nada**: el Local se queda para siempre y el dueño lo cambia a mano.

Arreglo, en `chat/browser/widgetHosts/viewPane/chatViewPane.ts`:

- `onDidChangeAgents()` llama a **`scheduleHarnessCheck()`**, que encola una comprobación **después**
  de cualquier restauración en vuelo (`this.restoringSession ?? Promise.resolve()`) para no
  competir con ella, y se serializa con un flag (`harnessCheck`) para que las varias llegadas de
  agentes no disparen una estampida.
- `switchEmptyLocalSessionToDefault()` reutiliza la regla que ya existía
  (`shouldSkipRestoredLocalSession`: Local + sin peticiones + defecto no-Local) y, si se cumple,
  pide el defecto con `showModel(None, undefined, true, true)`. Una sesión Local **con** peticiones
  se deja intacta: esa conversación es del dueño, no un defecto transitorio.

Con esto el chat de un arranque en frío abre ya en PiCode, sin tocar el desplegable. Lo que sigue
sin poder retirarse es un Local que el dueño ya tenía abierto **con** contenido.

Verificado: `tsc` del proyecto entero, exit 0. Build del canal experimental relanzada.
