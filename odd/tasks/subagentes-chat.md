# Subagentes de pi visibles en el chat

**Estado:** abierta (v1 implementada, falta verla en el editor) · **Rama:** `feat/source-in-repo` · **Abierta:** 2026-09-27

## Intención del dueño

> «Esto es una cosa que me gustaría que salieran, los Subagentes si hay de pi en el chat para ver que están haciendo, entrar al contexto y pdoer verlo.»

## Diseño

### Lo que ya existía (verificado antes de escribir)

- El runtime registra **una tool por agente**; el prefijo se movió entre versiones: hoy
  usa `subagent_<name>`, y el brief
  decía `agent_<name>`. El conector acepta **ambos** (`/^(?:agent|subagent)_/`).
- `tool_execution_end` trae `result` con `details.agents = { taskId, agent, status,
  mode, cwd }`; los eventos del SDK
  (`pi-agent-core/dist/types.d.ts:415-431`) son `tool_execution_start {toolCallId, toolName,
  args}` y `tool_execution_end {toolCallId, toolName, result, isError}`.
- La API del editor ya está habilitada (`chatParticipantAdditions` en el manifiesto y en el
  tsconfig): `ChatToolInvocationPart { toolSpecificData, enablePartialUpdate, isComplete,
  isError }` y `ChatSubagentToolInvocationData { agentName, prompt, result, modelName }`
  (`vscode.proposed.chatParticipantAdditions.d.ts:322-360`). El renderer en árbol
  (`chatSubagentContentPart.ts`) agrupa y actualiza la tarjeta por `toolCallId` — cero
  cambios de núcleo.
- Presencia viva entre procesos: `<paquete>/presence/<sha256(sessionId)>.<encarnación>.activity.json`
  (escritura atómica, ~400 ms, heartbeat 5 s) con `{schema, sessionHash, incarnation,
  generation, activity: {tasks: [{summary, thread: {items}}]}}`; los ítems son
  `{kind:'tool', name, output, running, isError}` o `{kind:'text'|'thinking'|'note', text}`
  (`lib/orchestrator-presence.ts:43-47`). Las tareas terminadas quedan en
  `<paquete>/tasks/<taskId>.json` con `task.sessionPath` — la fuente del transcript.

### v1 (esta ficha)

| Pieza | Qué hace | Dónde |
| --- | --- | --- |
| Lector puro | Rutas de presencia (sha256 del sessionId), lectura tolerante (fichero ausente/roto/a-medias → «sin lectura»), selección de la encarnación más nueva, líneas de actividad, `sessionPath` de una tarea, listado de tareas mtime-desc, tiempo relativo y renderer de transcript a markdown | `src/subagents.ts` (nuevo, sin `vscode`, fs/lecturas inyectables) |
| Tarjetas | En `tool_execution_start` de una tool agente empuja `ChatToolInvocationPart` + `ChatSubagentToolInvocationData` (nombre del agente con guiones bajos→espacios, prompt truncado a 200); en `tool_execution_end` re-empuja con resultado (truncado a 2000), `isComplete`, `isError` y `modelName` desde `details.agents`. Todo en try/catch: si la API propuesta se mueve, el turno no muere (se reporta por `report()`) | `src/agent.ts` |
| Progreso vivo | **Una sola** línea `stream.progress('Running subagents', task)` por turno, arrancada solo si arranca una tool agente; sondeo cada 1,5 s leyendo **un** fichero de presencia (encarnación cacheada; tras fallo, back-off de 10 s antes de re-escanear). Reporta líneas de actividad solo cuando cambian (partes de aviso — lo único que `task.report` admite) y resuelve cuando todas las tools lanzadas volvieron (modo tarea: la tool vuelve cuando el subagente terminó) o al asentarse el turno | `src/agent.ts` |
| Transcript | Comando `picode.openSubagentTranscript` (opcional `taskId`): con id abre el `sessionPath` renderizado con `sessionToMarkdown` en documento **sin título** markdown (el perfil nunca se escribe); sin id, quick-pick de `tasks/*.json` mtime-desc con `agente — etiqueta · hace 5m`. Cada camino de fallo es un mensaje, nunca un throw al vacío | `src/extension.ts` |
| Pruebas | 13 tests del módulo puro: hash vectorial conocido, tolerancia a ausente/roto/a-medias, selección de encarnación, tope y marcas de `activityLines`, renderer (roles, colapso de tool results, entradas desconocidas saltadas, `expandTools`), resolución de `sessionPath` (+ taskId con traversal rechazado), listado ordenado, tiempos relativos | `test/subagents.test.ts` (nuevo) |

**Fallback si la presencia nunca aparece** (p. ej. sin el paquete en el perfil): las tarjetas de
inicio/fin no dependen de presencia (vienen de los eventos del turno) y la línea de progreso
resuelve en «Subagents: N/N finished» al terminar el turno. Verificado en el SDK: el
conector crea la sesión **sin** `noExtensions`, así que el resource-loader carga las
extensiones del perfil en fuerza — con el paquete instalado, la presencia
se escribe; sin él, solo cuesta un scan fallido cada 10 s.

### v2 (aplazado)

- Verificación del **digest** de presencia (`header.digest` sha256 de los bytes de la
  actividad): v1 lee tolerante sin verificar.
- Sección **Status** del chat y un `chatSessionsProvider` que liste los subagentes.
- Botón «abrir transcript» dentro de la tarjeta (hoy el camino es el comando).

## Superficie de edición autorizada

`picode-source/extensions/picode/`: `src/subagents.ts` (nuevo), `src/agent.ts`,
`src/extension.ts`, `test/subagents.test.ts` (nuevo), y esta ficha. **Fuera de alcance:**
`status-view.ts`/`status-data.ts` (obrero paralelo) y todo el núcleo. El comando
quedó registrado solo por código (sin contribución en `package.json`, que no era superficie
autorizada): invocable por API y listo para cablearse desde el Status o la tarjeta en v2.

## Tareas

| # | Tarea | Estado |
| --- | --- | --- |
| S1 | Módulo puro `subagents.ts` (presencia, tareas, transcript markdown) con fs inyectable | ✅ |
| S2 | TDD: 13 tests primero (RED observado: `ERR_MODULE_NOT_FOUND`), luego verde | ✅ 13/13 |
| S3 | Tarjetas de subagente en `agent.ts` (inicio + fin con resultado), prefijos `agent_`/`subagent_`, try/catch con report | ✅ |
| S4 | Progreso vivo: una línea por turno, sondeo de presencia 1,5 s con encarnación cacheada y back-off 10 s, reporte solo si cambió, resolución al volver todas las tools o al asentarse el turno (limpieza en `finally`) | ✅ |
| S5 | Comando `picode.openSubagentTranscript` en `extension.ts` (id directa o quick-pick; documento sin título; nunca lanza) | ✅ |
| S6 | Validación: tsgo `--noEmit` → 0; emit real → 0 y `out/agent.js` referencia `ChatToolInvocationPart`/`ChatSubagentToolInvocationData`/`enablePartialUpdate`; `node --test` del directorio completo → 112/112 (99 previos + 13 nuevos) | ✅ |
| S7 | Ver en el editor empaquetado con un turno real y cerrar (visto bueno del dueño) | ⏳ |

## Registro

- 2026-09-27 · abierta y delegada la implementación de v1. Corrección al mapa heredado: el
  prefijo real de las tools es `subagent_`, se aceptan ambos. El estado
  `counts.finished` de la cabecera de presencia no hizo falta: la resolución temprana sale
  de las propias tools (en modo tarea vuelven cuando el subagente terminó). Nota del árbol:
  el LSP (tsserver) marca falsos positivos preexistentes en `agent.ts` (permisos, líneas
  ~297-333) y en núcleo (`aiCustomizationManagementEditor.ts`) porque no carga los d.ts
  propuestos del tsconfig; el compilador del proyecto (tsgo) sale 0 y esos ficheros están
  intactos en el árbol — verificados con `git status`/`git log`.
- 2026-09-27 · subagentes v1 commitada (obrero d76b457e): tarjeta nativa por subagente
  (prefijos agent_/subagent_), progreso vivo vía presencia, transcripción abrible
  (picode.openSubagentTranscript, markdown en documento sin título, perfil jamás escrito).
  Corrección del mapa por el obrero: TOOL_PREFIX real es subagent_. 117/117 tests.
