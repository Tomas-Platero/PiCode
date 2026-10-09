# Las conversaciones del durable entran en el panel de Sessions

> «Quieres en los filtros añadir durable a la vez que Pi y Local no?» — dueño, 2026-10-09

## Qué era y qué pasa a ser

El panel **Sessions** tenía dos fuentes: *Local* (el índice del propio editor) y *pi* (las
transcripciones JSONL del perfil, tendidas por `sessions-provider.ts`). Las conversaciones del
agente durable solo se veían por el comando *Show Durable Conversations*: una lista en un
quick-pick y el texto en un canal de salida — un sitio de developer, no un sitio de dueño.

Hoy el durable es la **tercera fuente** del panel, registrada como tipo de sesión `durable` a
la misma altura que Local y pi: sale en el filtro con su casilla, sus filas se mezclan en la
misma línea de tiempo (TODAY, Yesterday…) y cada quien decide en el filtro cuáles ve.

## Por qué sale gratis (y dónde no)

El editor construye el filtro del panel con los **tipos de sesión registrados**
(`agentSessionsFilter.ts`: contribuciones declaradas + los registrados por código, que es
como `pi` llega). Registrar `durable` por la misma vía pone la casilla en el filtro sin tocar
nada del filtro. El esquema URI y el tipo son la misma cadena (`durable`), que es lo que hace
una fila abrible (`getChatSessionType` lee el esquema).

**No** se ha hecho el paso siguiente: registrar durable como *destino* de chat (el chip bajo
el input y el menú «Continue in», hoy vacío porque los motores de Copilot no existen en
PiCode). Eso es «el harness es durable» y es una decisión de producto aparte; el dueño lo sabe
y lo deja para más tarde.

## Cómo se lee una conversación durable

El daemon es el ÚNICO dueño de su SQLite (`data/durable/sessions.sqlite`); nada del editor
abre el fichero. Todo va por su tubo local, con los mismos dos métodos que ya usa el panel de
estado: `sessions` (la lista) y `subscribe`/`unsubscribe` (la transcripción).

| Dato de la fila | De dónde sale |
| --- | --- |
| Título | La **primera pregunta del usuario** en la transcripción (capada a 80); `Conversation N` si aún no tiene palabras de usuario |
| Fecha | Los `timestamp` de los **mensajes del modelo** (pi-ai los lleva); el daemon no guarda fechas propias |
| Estado | La presencia de `run` en el snapshot: *In Progress* / *Completed*; snapshot ilegible → sin estado (desconocido, no fingido) |
| Descripción | La nota del propio daemon: `subagent (task …)`, `fork of …` |
| Icono | `server-process` (verificado en `codiconsLibrary.ts`) — es un proceso daemon |

Al abrir una fila, la transcripción se reconstruye como historial de **solo lectura** (sin
`requestHandler`, igual que las de pi): turnos `pi.user` y `pi.assistant`; `pi.system`,
`pi.reset`, `pi.compaction` y `pi.tool-result` son fontanería y se quedan fuera.

## Las reglas que el código fija (y por qué)

1. **Un listado = una conexión.** El listado abre el tubo UNA vez y por ahí pregunta la lista
   y los snapshots que falten; no una conexión por conversación (el patrón de
   `readDurableStatus`).
2. **Cache por id + número de entradas.** Una transcripción se lee una vez por *cambio*, no
   por refresco; los ids del daemon no se reutilizan, así que la cache no puede quedarse
   vieja sin darse cuenta.
3. **Daemon caído → se queda lo último real.** Ni filas vacías ni panel limpio: un daemon
   parado no es «se han perdido tus conversaciones» (el almacenaje sobrevive al proceso).
   El evento de cambio tampoco se dispara al caer — solo al subir o al moverse la lista
   (digest canónico por id + nº de entradas; sondeo cada 15 s, más ligero que el del panel
   de estado, que hace lo mismo cada 5 s).
4. **Sin fechas inventadas.** Si la transcripción no lleva timestamps, la fila no lleva
   `timing` — el panel le pone «sin fecha» y no «57y ago». Las filas sin datos se ordenan
   por id (el daemon asigna en orden de creación) y quedan al final.
5. **Filas reusadas por referencia** (`reuseRows` de `sessions-provider.ts`): el puente del
   editor compara por referencia y republica la lista entera si cada refresco crea objetos
   nuevos — es el parpadeo que el dueño ya reportó en las sesiones de pi.
6. **Núcleo puro autocontenido.** `durable-sessions.ts` no importa ni `vscode` ni módulos
   relativos (regla de la casa para que `node --test` lo corra directo); `snapshotInFlight` y
   `DurableConversationRow` viven como gemelos locales con su atribución, y `textOf`/`entryText`
   como copias atribuidas de `picode-source/durable/lib/common.js`.

## Piezas

* `extensions/picode/src/durable-sessions.ts` — el mapeo puro: fila, orden, turns, digest.
* `extensions/picode/src/durable-sessions-register.ts` — el registro: tubo, cache, sondeo,
  proveedor de items + contenido, esquema `durable`.
* `extensions/picode/src/extension.ts` — el registro se engancha junto al de pi
  (`registerDurableSessionsProvider({ participant: piParticipant })`).
* `extensions/picode/test/durable-sessions.test.ts` — 11 tests del mapeo.

## Verificación

* `tsc -p tsconfig.json` (con emit a `out/`): exit 0; `out/durable-sessions.js` y
  `out/durable-sessions-register.js` presentes.
* Suite completa del conector: 40 ficheros, 0 fallos (los 11 nuevos incluidos).
* Pendiente de los ojos del dueño: ver el filtro y las filas en el editor. Requiere el pack
  con este emit — la misma build pendiente que ya esperaba el cierre del editor (tarjeta de
  cambios del chat + fix de paquetes van en la misma).

## Qué queda fuera (a propósito)

* **Destino de chat**: el chip «durable» bajo el input y «Continue in durable». Es el día en
  que el harness ES durable; se decide cuando el dueño diga.
* **Fechas reales de creación en el daemon**: hoy la fecha sale de los mensajes; si algún día
  el almacenaje guarda timestamps por entrada, la fila mejora sola (el mapeo ya prefiere el
  dato real).
