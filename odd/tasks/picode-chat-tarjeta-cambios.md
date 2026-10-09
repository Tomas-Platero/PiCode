# Chat: tarjeta de cambios por fichero (+N / −M)

**Estado:** hecha, falta verla en el editor empaquetado · **Abierto:** 2026-10-09

## Intención del dueño

«Quiero ver en el chat qué ha editado o creado el agente, con el diff de − y + y el número de
líneas, como lo haces tú.» Las capturas que enseñó: una respuesta del chat con avisos de una
línea y una vista de diff con líneas rojas/verdes numeradas y sus recuentos.

## Diagnóstico (medido en el árbol, 09-10)

- El chat es el nativo, con participante `picode` y el puente pi↔chat en
  `extensions/picode/src/agent.ts`. Cada aviso de herramienta es una línea de progreso
  (`tool_execution_start` → `stream.progress`); lo que la herramienta **hizo** no tiene
  representación.
- pi entrega las mutaciones **estructuradas**: `edit` llega con `{ path, edits[] }` y acaba con
  `details: { diff, patch, firstChangedLine }`; `write` con `{ path, content }`. Bash y compañía
  no llevan nombre de fichero, así que lo que un comando cambie no es contable — y se dice.
- El renderer del chat **ya sabe pintar** la tarjeta: `ChatResponseMultiDiffPart`
  (`chatParticipantAdditions`) renderiza cabecera «Changed N files», una fila por fichero con
  `+N/−M` y el botón que abre todos los diffs (`chatMultiDiffContentPart.ts`). La extensión ya
  habilita la propuesta en su `package.json`. No había que tocar el workbench: solo alimentarla.

## Decisiones

| # | Decisión | Por qué |
| --- | --- | --- |
| 1 | Instantánea **en `tool_execution_start`** (no en el resultado): leer el fichero cuando la herramienta acaba sería leer el «después» dos veces | el «antes» solo existe en ese momento; al llegar el resultado ya está escrito |
| 2 | Recuento de líneas por **LCS de líneas** propio (`chat-edits.ts`), no parseo del `patch` de pi | la tarjeta necesita dos números, no el parche; contar `+`/`-` del patch falla con contexto y cabeceras |
| 3 | Diff real vía **`TextDocumentContentProvider`** en el esquema `picode-before`: el lado original del diff es la instantánea de este turno | el multi-diff editor abre dos documentos; el fichero real ya cambió, así que «fichero vs fichero» no vale. Así el diff es el de verdad, sin ficheros temporales |
| 4 | Una tarjeta **por turno, al final** (`agent_settled`), no una por herramienta | es «qué cambió esta respuesta», como la vista que el dueño enseñó; las filas van en el orden en que cada fichero cambió la primera vez |
| 5 | Solo `edit` y `write` entran en la tarjeta | son las únicas herramientas cuyos argumentos nombran el fichero; lo demás es invisible por estructura y la tarjeta no inventa |
| 6 | La edición fallida no entra (ni el fichero nuevo sin «antes»): si la herramienta dijo error, no se cuenta | la tarjeta es un registro de lo cambiado, no de lo intentado |
| 7 | Almacén de instantáneas **acotado a 64 ficheros** por turno; el más viejo suelta su «antes» (la fila y su recuento se quedan siempre) | memoria acotada; con más de 64 ficheros en un turno los últimos son los que puede abrir el diff, y el número no miente |
| 8 | Degrada en silencio: si la parte propuesta desaparece de la API, el turno sigue y se apunta en el log | la misma postura que las tarjetas de delegación y background |

## Implementación

- `extensions/picode/src/chat-edits.ts` (nuevo, sin `vscode`): el libro — instantánea, relectura,
  recuento LCS con tope de tabla, orden de primera mutación, y las ayudas puras del esquema
  `picode-before` (`beforeUriPathOf` / `absolutePathOfBeforeUriPath`).
- `extensions/picode/src/agent.ts`: en `tool_execution_start` de `edit`/`write` se snapshottea; en
  `tool_execution_end` (solo si no hubo error) se relee y se cierra la entrada; en `agent_settled`
  se espera a que todas las lecturas aterricen y se empuja la tarjeta con
  `stream.push(new ChatResponseMultiDiffPart(...))`. El `cwd` del turno viaja como parámetro
  (`runTurn(..., cwd)`) — `sessionFolder` vive dentro de `registerPiAgent` y no es compartible.
- `extensions/picode/src/extension.ts`: el proveedor de contenido del esquema `picode-before`
  sirve el «antes» de la instantánea cuando el diff lo abre.
- `extensions/picode/test/chat-edits.test.ts` (nuevo): 11 pruebas, todas verdes
  (`node --test`).

## Verificación

- `node --test extensions/picode/test/chat-edits.test.ts` → **11/11**.
- `tsc --project extensions/picode/tsconfig.json --noEmit` → **exit 0**; emit real → exit 0 y
  `out/chat-edits.js` presente, con la tarjeta y el proveedor dentro de `out/agent.js` y
  `out/extension.js` (la extensión se empaqueta desde `out/`).
- Pendiente: verlo con los ojos del dueño en el editor empaquetado (una edición, un fichero
  creado, y un turno con bash que toca ficheros para confirmar que solo salen edit/write).
- 2026-10-09 21:28 · **El conector compilado, metido en el paquete que está en marcha**, para no
  esperar a un build completo con el editor abierto (el build reescribe la carpeta desde la que
  corre el editor, así que con PiCode abierto se niega — ver `dev/data-hold.sh`). El `out/`
  recién compilado (20:33) se copió a
  `PiCode-win32-x64-experimental/resources/app/extensions/picode/out/`, borrando antes los
  ficheros que el compilador ya no produce; el paquete quedó **idéntico** al `out/` de la fuente
  (`diff -rq` limpio) y agente y extensión llevan la tarjeta y el esquema `picode-before`. La
  copia anterior está a salvo en `.scratch/pack-connector-backup-20261009-212804/`. Hace falta
  **recargar la ventana** para que el host de extensiones cargue el conector nuevo. El núcleo que
  pinta la tarjeta (`chatMultiDiffContentPart.ts`) no cambió desde el build de las 17:45, así que
  no hace falta reconstruirlo para esta prueba.
