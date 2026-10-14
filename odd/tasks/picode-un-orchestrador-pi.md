# Un solo orquestador: Pi. Sesiones siempre duraderas. Sin filtro.

> «Quiero que elijas al que sea el mejor orquestador del chat, en este caso creo que es Pi.
> Siempre. Ni local, ni durable. Luego que las sesiones las lleve siempre durable ¿No?, y que
> dejemos de filtrar por durable, pi o local. Esto es lo que hace este pi en concreto no?»
> — dueño, 2026-10-13, tras la build 0.2.3-experimental

## La respuesta a su pregunta: sí

El pi que le habla (el runtime pi) funciona exactamente así: hay **un solo orquestador** — pi,
siempre — y las conversaciones viven **duraderas** (se guardan y sobreviven a cualquier cierre).
No existe «elegir motor» ni «filtrar por tipo»: una lista de sesiones y punto. PiCode debe tener
esa misma forma.

## Qué era y qué pasa a ser

Hasta hoy el chat tenía **tres motores conviviendo**: el harness local de la ventana (que ya era
pi en proceso, pero se llamaba «Local»), el durable como destino de chat (ADR-018, vuelto a
aplicar en la 0.2.3) y el lector de transcríptos `pi`. El panel de sesiones filtraba entre tres
grupos con un conmutador de «una lista a la vez». Eso es el desgaste que el dueño ha retirado:

1. **El chat lo lleva Pi, siempre.** Los bloques de núcleo que hacían de durable el motor por
   defecto (`constants.ts`: `DURABLE_CHAT_SESSION_TYPE` y sus dos lecturas) se eliminan. El
   motor de todo chat nuevo es el agente pi del núcleo (`agent.ts`, el participante `@pi`).
   Durable vuelve a ser **solo backend**: las herramientas que pi lanza (`durable_send`,
   sesiones, memoria, subagentes) — la forma ADR-020. Su contribución `chatSessions` sigue
   declarada pero apagada (`"when": "false"`, `canDelegate: false`): es la declaración del tipo,
   no un motor.
2. **Una sola lista, sin filtro.** El panel de sesiones muestra **la una lista**: los
   transcríptos duraderos de pi (los que el chat ya escribe en el perfil). El filtro de
   proveedores desaparece del menú (queda como opt-in para un consumidor que de verdad tenga
   varios proveedores propios) y los dos proveedores retirados — `Local`, el registro duplicado
   del editor, y `durable`, ya sin motor — quedan **excluidos de siempre**, incluso contra un
   estado guardado por una instalación anterior (`normalizedExcludes`). La etiqueta del motor
   local pasa de «Local» a **«Pi»**: nombrar el motor, no la fontanería.
3. **Sesiones siempre duraderas y continuable.** Abrir una conversación del panel la **continúa
   de verdad** (`sessions-resume.ts`): el transcrípto se abre con `SessionManager.open` en una
   sesión pi en proceso propia, con su puerta de permisos, sus tools del editor y su cola de
   turnos — y el siguiente mensaje **se añade al mismo fichero**. Lo que el durable tenía y la
   lista de pi no (seguir hablando) ya no es una razón para tener tres motores.

## Ficheros

| Fichero | Cambio |
| --- | --- |
| `src/vs/workbench/contrib/chat/common/constants.ts` | Fuera `DURABLE_CHAT_SESSION_TYPE`; el defecto vuelve al orden upstream (harness de pi). |
| `src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsFilter.ts` | `normalizedExcludes` + `RETIRED_SESSION_PROVIDERS`; el menú sin toggles de proveedor salvo opt-in; estado guardado normalizado, nunca confiado. |
| `src/vs/workbench/contrib/chat/browser/agentSessions/agentSessions.ts` | `getAgentSessionProviderName(Local)` → `'Pi'`. |
| `src/vs/workbench/contrib/chat/test/browser/agentSessions/agentSessionsOneList.test.ts` | Reescrito: fija la una lista, la imposibilidad de esconder `pi` y la preservación del estado propio del dueño. |
| `extensions/picode/src/sessions-resume.ts` (nuevo) | La sesión de continuación: una pi en proceso por transcrípto, cola por sesión, contexto de permisos y token de MCP propios (nunca comparte estado con el chat vivo). |
| `extensions/picode/src/agent.ts` | Exporta `loadSdk`, `runTurn`, `bindSessionExtensions`, `pinAgentDir` y los tipos estructurales de pi; `PiSdk.SessionManager` declara `open(path, sessionDir?, cwdOverride?)`. Sin cambios de conducta en el chat vivo. |
| `extensions/picode/src/extension.ts` | El proveedor `pi` devuelve `requestHandler` al resolver un transcrípto; las sesiones de continuación se sueltan al apagarse. |

## Decisiones tomadas (y por qué)

- **El grupo `Local` del editor se retira del panel, no se fusiona.** El editor graba las mismas
  conversaciones dos veces; mostrar las dos es la redundancia que el dueño ya prohibió («un dato
  aparece una sola vez»). El transcrípto de pi es el registro honesto y duradero: ese es el que
  se lista y el que se continúa.
- **Las conversaciones durable antiguas quedan fuera de la lista.** Siguen existiendo en el
  almacenamiento del daemon; ya no hay camino de UI hacia ellas porque ya no hay filtro. Si el
  dueño pide rescatarlas, es un paso aparte (migración de historial), nunca un filtro nuevo.
- **El registro `durable` del panel sigue registrado.** Retirarlo toca la suite del puente y no
  cambia nada visible (sus filas quedan excluidas); se retira en un paso propio si el dueño lo
  quiere.

## Verificado

- `tsc -p tsconfig.test.json --noEmit` del conector → 0 errores.
- `tsc -p src/tsconfig.json --noEmit` del núcleo → sin errores en los ficheros tocados.
- `gulp compile-extension:picode` → en verde.
- Sin restos de `DURABLE_CHAT_SESSION_TYPE`, `ONE_LIST_SESSION_PROVIDERS` ni
  `excludesAfterToggle` en el árbol.
- Ninguna comparación de runtime contra la etiqueta `'Local'` (el renombre es seguro).

## No medido

- **La prueba real es del dueño**: abrir el chat (debe decir Pi, responder pi), mirar el panel
  (una lista, sin filtro de proveedores) y abrir una conversación antigua para escribir en ella
  (debe continuar y el transcrípto crecer).
- Sin build del pack experimental en esta pasada.

---

## Corrección 2026-10-13 (tarde): el dueño revisa el reparto y manda

> «Entonces las sesiones no deberían llevarla siempre durable? O sea el chat habla con pi y pi
> crea una sesión durable?»

Sí: la sesión vive **en durable**, no en un fichero suelto. El reparto queda: **pi piensa,
durable recuerda y sobrevive, el editor es la sala**. Cada turno lo ejecuta pi (en proceso, con
el modelo y los permisos del editor) y **apunta la pregunta y la respuesta en durable** — así la
conversación sobrevive a todo, se ve en cualquier ventana y continúa desde donde quedó. Los
transcríptos de fichero quedan solo para lo que viene de fuera (una importación, el pi de
terminal). Los subagentes no cambian: son obreros del taller de durable, con su lista de tareas
propia, y su resultado lo cuenta pi.

### Hecho hoy

- **Fase 0 — reorientado lo de la mañana**: retirados la conversión durable→fichero
  (`durable-transcripts.ts`, su prueba y su cableado) y su mapper; el "continuar leyendo el
  fichero" (`sessions-resume.ts`) se mantiene **solo durante la transición** y se retira en la
  fase 3. El resto de la mañana (chat = pi, una lista sin filtro, etiqueta "Pi") se queda.
- **Fase 1 — el daemon sabe recibir**: nueva orden `record` en `lib/daemon.js` — apunta una
  ronda terminada (mensajes `pi.user`/`pi.assistant`) en una conversación **sin ejecutar nada**,
  con validación en la frontera y rechazo con frase. Además: `PICODE_DURABLE_ENDPOINT` mueve el
  par completo (daemon + clientes) para pruebas aisladas. **`proof-record.js` en verde** (PROOF
  OK): graba, se lee igual que una ronda ejecutada, crece en orden y rechaza formas malas.

### Pendiente (por fase)

- Fase 2: el chat del editor abre su conversación en durable al primer turno y registra cada
  ronda (el rebind de borrador→real ya existe).
- Fase 3: la lista del panel = conversaciones de durable, continuable ejecutando **pi** (nunca
  el daemon conversando); retirar `sessions-resume.ts`.
- Fase 4: las importaciones convierten los transcríptos a durable en el momento de importar.
- Fase 5: reglas del agente para delegar a durable a tiempo; marca "te toca" en las cortadas.
- Fase 6: limpieza final, suites completas, ADR-021 corregido en `docs/DECISIONS.md`.

Verificado ahora: conector 0 errores, 451 pruebas en verde; `proof-record.js` PROOF OK con daemon
aislado (sin tocar el almacén real). No medido: la prueba real del dueño (pendiente a fase 3).

### Fase 2 — empezada, a medias (contexto agotado 2026-10-13)

- Hecho: `runTurn` (agent.ts) devuelve ahora el **texto de la respuesta** tal como se stream-eó
  (antes no devolvía nada) — la mitad que el registro necesita. Conector compila, 0 errores.
- Falta: el módulo que abre/reescribe la conversación en durable por turno (open + record por
  `DaemonClient`, cacheada por clave de scope) y su cableado en el handler tras `runTurn`.
  Un intento de escribirlo llegó CORRUPTO al árbol (contenido que no era el mío) y fue borrado
  sin compilar nada con él. Escribirlo de cero en la siguiente sesión.

### Fase 2 — terminada (2026-10-13, sesión de la tarde)

- Nuevo `chat-record.ts`: una conversación durable por chat de ventana (cacheada por clave de
  scope; un cambio de proyecto abre conversación nueva), escrita por el protocolo del daemon
  (`open` + `record`). El daemon caído es un no-op silencioso — el turno ya lo vio la sala y el
  transcrípto lo guarda; el siguiente turno reintenta. Un fallo de registro se loguea, nunca
  rompe la respuesta.
- Cableado en `agent.ts`: tras `runTurn`, la ronda (prompt enmarcado + texto de la respuesta)
  se registra sin bloquear (`void recordChatTurn(...)`). Una ronda sin respuesta se apunta como
  pendiente ("te toca"), que es lo que el panel ya sabe leer.
- Verificado: conector 0 errores; suite 451 en verde, 0 fallos. Los avisos del linter sobre
  `unknown` en agent.ts son plumbing preexistente, no de esta pasada.
- **No medido**: escribir en el chat y ver la conversación aparecer en durable (`sessions` del
  daemon) — la prueba real es del dueño cuando la fase 3 la muestre en el panel.
- Siguiente: **fase 3** — la lista del panel = conversaciones de durable, continuable
  ejecutando pi (nunca el daemon conversando); retirar `sessions-resume.ts`.

### Fase 3 — a medias (contexto agotado 2026-10-13, II)

- Hecho: **el filtro ya apunta a durable como LA lista** (`agentSessionsFilter.ts`):
  `DURABLE_SESSION_PROVIDER` es lo que el panel muestra y nunca se esconde; `Local` y los
  transcríptos `pi` son los retirados (los `pi` siguen alcanzables por el visor de agentes).
  Prueba del filtro actualizada al nuevo reparto.
- Hecho: `chat-record.ts` expone `recordTurnInto(conversationId, turn, log)` — registrar en una
  conversación CONCRETA, que es como continúan las del panel. Conector compila, 0 errores.
- **Falta (el siguiente paso exacto)**: en `sessions-resume.ts`, un handler de continuación
  durable — `piDurableResumeHandler(conversationId, deps)` que siembre una sesión pi en proceso
  con la historia de la conversación (`SessionManager.create` + `appendMessage` por turno del
  snapshot, el mismo camino de la migración descartada, pero al revés), ejecute el turno con
  `runTurn` y grabe con `recordTurnInto`. Luego `durable-sessions-register.ts` deja de enviar
  el turno al daemon (`run`) y usa ese handler; `registerDurableSessionsProvider` necesita el
  `deps` (distributionRoot, log) desde extension.ts. La prueba del filtro del núcleo no corre
  con `node --test` (resolución de `.js` del empaquetador) — verificará tsc + infraestructura.

### Fase 3 — terminada (2026-10-13, noche)

- **El filtro ya manda**: la lista del panel es durable (`DURABLE_SESSION_PROVIDER`, nunca
  escondida); `Local` y los transcríptos `pi` retirados (los `pi` siguen por el visor de
  agentes). Prueba del filtro actualizada.
- **`piDurableResumeHandler`** (sessions-resume.ts): abrir una conversación de durable siembra
  una sesión pi en proceso con SU historia (leída por el protocolo del daemon, nunca su
  SQLite), ejecuta el turno con pi y graba de vuelta en la MISMA conversación
  (`recordTurnInto`). Sesión sembrada una vez por conversación y ventana; soltada al apagarse.
- **El panel ya no conversa con el daemon**: fuera `runDurableTurn` (enviar el turno al daemon
  era la doble cabeza) y sus imports muertos. El rebind de borrador→real queda por eliminar en
  la fase 6 (ya no hay chats durable "untitled").
- Verificado: conector 0 errores, 451 pruebas en verde. Los avisos del linter sobre `unknown`
  son la frontera del protocolo del daemon, igual que el resto del fichero.
- **No medido**: abrir una conversación de durable en el panel y seguir hablando — la prueba
  real es del dueño.
- Siguiente: **fase 4** — las importaciones convierten transcríptos a durable al importar.

### Fase 4 — terminada (2026-10-13, noche)

- Nuevo `sessions-import.ts`: los transcríptos que aterriza una importación (perfil externo o
  solo sesiones) se **convierten a durable en el momento de importar** — se leen con el mismo
  parser del replay (`sessionTurns`) y se graban por el protocolo del daemon (`open` + `record`
  con todas las rondas). Techo de 500 transcríptos por pasada; el daemon caído es un no-op (los
  ficheros están importados igualmente y una pasada posterior alcanza); un transcrípto ilegible
  se salta con línea de log, nunca rompe.
- Cableado en `onboarding.ts` en los DOS puntos: la importación completa y la de solo
  conversaciones (`IMPORT_SESSIONS_COMMAND`), ambas fire-and-forget con `logImport`.
- Verificado: conector 0 errores, suite 451 en verde. Los ficheros siguen en disco — siguen
  siendo el transcrípto de referencia para replays y copia de seguridad; la copia durable es
  como la conversación aparece y continúa.
- Siguiente: **fase 5** — reglas del agente para delegar a durable lo largo, y la marca
  "te toca" en conversaciones cortadas.

### Fase 5 — terminada (2026-10-13, noche)

- **Delegar a tiempo**: la descripción de `durable_send` (lo que el modelo lee al decidir) lleva
  ahora la regla DELEGATE ON TIME — lo que se espere largo (builds, investigaciones largas,
  tareas paralelas) va a durable ANTES de empezar, no después de que se cortara. El puentecillo
  es nuestro; el modelo lo lee en cada decisión.
- **"Te toca"**: `lastModelEntryIsUser(snapshot)` (puro, en durable-sessions.ts) — la última
  entrada del modelo es el prompt del dueño sin respuesta = conversación cortada a medias. El
  panel la marca `NeedsInput` (en curso si hay run; completada solo si de verdad lo está).
- Verificado: conector 0 errores, 451 pruebas en verde.
- Siguiente: **fase 6** — limpieza final (rebind de borrador→real ya innecesario, restos),
  suites completas (conector + daemon + proof-record) y el ADR-021 corregido en DECISIONS.md.

### Fase 6 — terminada (2026-10-13, noche) — TRABAJO COMPLETO

- Limpieza: comentario obsoleto del rebind (ya no hay chats durable "untitled"); el resto del
  árbol revisado, sin restos de los caminos retirados.
- **ADR-021 corregido en `docs/DECISIONS.md`** con la forma final: la sesión vive en durable,
  los transcríptos son el registro de referencia de lo externo, continuar = pi, delegar a
  tiempo, "te toca" en el panel. La primera versión del ADR queda marcada como reemplazada en
  sus piezas.
- Verificación final: conector 0 errores y **451 pruebas en verde**; `proof-record.js` **PROOF
  OK** (record lee, crece y rechaza formas malas); núcleo sin errores en los ficheros tocados.

## No medido (la prueba real es del dueño)

1. Escribir en el chat, cerrar el editor por completo, volver y **seguir la conversación**.
2. La lista del panel mostrando las conversaciones de durable, sin filtros ni duplicados.
3. Importar sesiones de otro pi y verlas aparecer (y continuar) en la lista.
4. Pedir algo largo y ver que pi lo encarga a durable antes de empezar.

## Límite conocido

El almacén durable de OTRO pi (su caja interna) no se convierte: solo su propio daemon puede
abrirlo. Lo que viaja son los transcríptos (y esos se convierten al importar). Si algún día
hace falta, sería una exportación del propio daemon — un proyecto aparte.

### Colateral del pi externo — contemplado (2026-10-13, cierre)

El dueño lo puso sobre la mesa: **un pi externo puede no tener durable** — puede traer otra cosa
(gentle-ai) o nada más que pi. El diseño ya lo aguanta a medias y así se termina:

- **Todo el lado del conector ya es opcional**: `chat-record`, `sessions-import` y la
  continuación hacen no-op silencioso si `durableFolder()` no resuelve — la conversación sigue
  en su transcrípto y nada rompe. El puente `durable_send` es igual de opcional (es pi quien
  decide lanzarlo, y solo existe si el puente cargó).
- **Aislamiento aplicado**: el editor tiene SU endpoint (`picode-durable-editor`) y su daemon
  nace anclado a él (`PICODE_DURABLE_ENDPOINT` en durable.ts) — antes compartía el nombre por
  defecto con el pi externo y el primero que arrancaba servía los chats del otro.
- **Lo que falta (paso siguiente exacto)**: el filtro del núcleo fija durable como LA lista sin
  mirar si existe. Con un pi externo SIN durable la lista quedaría vacía teniendo transcríptos.
  El arreglo: la lista activa es durable **si está registrado**; si no, la de los transcríptos
  `pi` (`normalizedExcludes` gana un parámetro con los proveedores registrados; el filtro ya
  tiene el `chatSessionsService`). Con gentle-ai o nada: sin durable no hay lista de durable y
  no se inventa — los transcríptos son lo que hay, y la decisión de dar listado a otro backend
  es un proyecto aparte por backend.
- Decisión de producto pendiente de escribir cuando aplique: en runtime externo CON durable,
  ¿con qué durable habla el editor (el interno aislado — decidido hoy — o el del externo)? Hoy:
  el interno, siempre.

### Contemplación completada — durable opcional (2026-10-13, cierre II)

- **El filtro ya mira si durable existe**: `normalizedExcludes` acepta el snapshot de proveedores
  registrados; la lista activa es durable **si está registrado**, y si no, la de los
  transcríptos `pi` (durable pasa a retirado al no poder mostrarse). Aplica al estado guardado Y
  al defecto (la rama sin estado también normaliza con el registro). Con gentle-ai o sin nada:
  transcríptos — no se inventan listas.
- **Aislamiento verificado en prueba**: `durable-client.test.ts` fija ahora la tubería propia del
  editor (`picode-durable-editor`), no la del pi externo.
- Verificado: conector 0 errores; núcleo sin errores en el filtro; endpoint propio aplicado
  (pipe + `PICODE_DURABLE_ENDPOINT` en el arranque del daemon interno).

### Bugs abiertos (panel de estado, 2026-10-13 — siguiente sesión)

1. **Actualizar no se queda hecho** (pi-web-access 0.37.0 → 0.40.0 dice hecho y sigue saliendo).
   Diagnóstico avanzado: `packages-updates.ts` actualiza con `npm install --save name@latest` sobre
   el perfil en fuerza; el listado del panel lee el snapshot de `updates-check.ts`
   (UPDATES_STATE_KEY, en globalState). Hipótesis por orden: (a) la declaración del perfil queda
   pineada (`npm:name@0.37.0`) — el módulo dice que una pineada no se puede tomar (pi la
   re-fija), y la fila debería decir "cambia el pin" en vez de ofrecer Update; (b) el check
   compara declaración vs registry en vez de instalado vs registry; (c) el snapshot de
   updates-check no se invalida al actualizar (caché de 10 min + globalState).
2. **Badge 8 ≠ lo que muestra el bloque** (el bloque muestra 1 fila, el badge cuenta 8). El badge
   de 'updates' cuenta `updates.targets.length` del snapshot (`status-view.ts` sectionBadge); el
   bloque muestra menos filas. El dueño quiere: badge solo si hay actualizaciones, y el número
   = las actualizaciones reales (host pi + extensiones). Comparar qué mete el snapshot en
   targets (¿incluye host/pineadas/no-comprobables?) contra lo que el bloque dibuja, y hacer
   que badge y bloque cuenten lo mismo — filas actualizables reales.

### Arreglados — panel de estado (2026-10-13, cierre III): actualizar y badge

1. **"Actualizó y sigue saliendo"** — raíz: el panel lee el snapshot GUARDADO
   (`UPDATES_STATE_KEY` en globalState), y actualizar un paquete no lo recalculaba: la fila
   seguía diciendo 0.37.0 → 0.40.0 hasta la comprobación de las seis horas. Arreglo: tras una
   actualización con éxito, el check re-corre **sobre el perfil que se acaba de tocar** y el
   panel repinta su respuesta (`runUpdateCheck` ahora corre sobre globalState, así el comando de
   actualizar puede llamarla).
2. **El badge 8 del icono** — no eran actualizaciones: era el contador de otra bloque (tareas
   durable). El dueño fijó su significado: **el badge del icono = las actualizaciones
   pendientes (el pi y los paquetes), nada si no hay**. Los demás contadores viven en sus filas
   del panel, no en el icono (`status-view.ts`).
- Verificado: conector 0 errores, 451 pruebas en verde. Build local relanzada para probarlo.

### Bug abierto tras importar (2026-10-13, noche): la lista parpadea

Síntoma del dueño: tras importar ~100 conversaciones, las filas del panel "aparecen y
desaparecen" (flash de ~0,1 s), como si un filtro se quitara y pusiera. HOST dice
"Conversations 100".

Análisis para la próxima sesión:
- El proveedor durable re-publica la lista entera cuando el poll (15 s) ve digest nuevo, y
  `reuseRows` reusa filas SOLO si label/description/status/timing no cambiaron: con el import
  grabando 100 conversaciones una a una (fire-and-forget, minutos), cada grabación cambia el
  digest → re-list → las filas cuyo label acaba de resolverse ("Conversation N" → título real)
  se reconstruyen → el puente las borra y re-añade → parpadeo continuo durante la importación.
- Además `provideChatSessionItems` es async y puede llamarse concurrente (poll + fire del
  import + refresh): `lastItems` compartido se muta entre llamadas — publicaciones
  intercaladas de arrays distintos.
- Arreglo probable: (1) el import no debe disparar re-list por conversación — un solo
  `fireChanged` al terminar (ya se hace) PERO el poll de 15 s sigue viendo digest nuevo 100
  veces; silenciar el poll durante la conversión o hacer el digest estable; (2) serializar
  `provideChatSessionItems` (una cadena, como `turnChain`) para que nunca haya publicaciones
  intercaladas; (3) al importar, grabar primero TODO y resolver labels después, o pasarle al
  record los labels ya leídos (el conversor ya lee los títulos — grabarlos con la entrada).

### Arreglado — el parpadeo de la lista tras importar (2026-10-13, noche II)

Dos causas, dos arreglos (durable-sessions-register.ts + sessions-import.ts):
1. **Publicaciones intercaladas**: `provideChatSessionItems` es async y podía correr dos veces
   a la vez (poll + refresh), publicando arrays de momentos distintos — el puente, que compara
   por referencia, lo leía como filas que aparecen y desaparecen. Ahora corre **en una cadena**:
   un listado cada vez, siempre el último publicado.
2. **El poll durante la importación**: la conversión graba ~100 conversaciones una a una y el
   poll de 15 s veía digest nuevo cada vez → re-list constante, con los labels resolviéndose
   tarde ("Conversation N" → título) reconstruyendo filas. Ahora el poll **se calla mientras la
   importación corre** (`DURABLE_IMPORT_PAUSE`) y la lista se publica una vez al terminar.
- Verificado: conector 0 errores. Pendiente de rebuild para que el dueño lo pruebe (el síntoma
  era con la build experimental de las 17:0x).

### Blindaje del listado durable (2026-10-13, noche III)

- **Un snapshot que no se mapee ya no vacía la lista**: `buildListing` salta la conversación
  conflictiva con línea de log (`options.deps.log`) en vez de lanzar y publicar vacío — el
  "aparecen y desaparecen" era exactamente eso: un intento que publicaba lista vacía, el
  siguiente que publicaba bien.
- El filtro (sesión anterior) renormaliza cuando los proveedores se registran y el Reset
  normaliza con el registro actual.
- Verificado: conector 0 errores. Build experimental relanzada para prueba del dueño.
- **Si el parpadeo persiste**, debug pedido al dueño: (1) Ayuda → Alternar herramientas de
  desarrollo → Console, y decir si hay errores rojos repetidos mientras parpadea (buscar
  "durable listing"); (2) ¿el parpadeo es cada ~15 s (cadencia del poll) o continuo?
