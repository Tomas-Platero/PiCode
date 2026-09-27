# Permisos del chat gobernando pi

**Abierta**: 2026-09-27 · **Rama**: `feat/source-in-repo` · **Estado**: exploración delegada

## Intención del dueño (27-09, tras la verificación del puente MCP)

> "Pues cámbialo para que ese control sea de pi"

El aviso **Default permissions** del chat (Ask / Allow all / Autopilot) hoy solo gobierna el
puente de MCP del editor (`lm.invokeTool` con `toolInvocationToken`). Las herramientas
**nativas de pi** (bash, edit, write…) ni lo miran: se ejecutan dentro de pi sin preguntar.
El dueño quiere lo contrario: ese mando debe regir a pi.

## Diseño objetivo

| Posición del mando | Comportamiento de pi |
| --- | --- |
| Ask (por defecto) | pi pregunta en el chat antes de ejecutar herramientas que modifican (bash/powershell/edit/write); las de solo lectura (read/grep/ls…) no molestan |
| Allow all | pi ejecuta sin preguntar (equivalente a hoy) |
| Autopilot (preview) | decidir con el mapa; si no hay equivalente, seguir Ask y anotarlo |

**Invariantes**: mismo comportamiento en pi interno y externo; sin segundo camino de
ejecución de herramientas; sin colgar el turno si el dueño cancela (cancelar = rechazar).

## Tareas

| # | Tarea | Estado |
| --- | --- | --- |
| P0 | Mapa delegado (a949166b): ajuste `chat.permissions.default` (enum `default/assisted/autoApprove/autopilot`, se estampa por petición en `request.modeInfo.permissionLevel`); API `stream.questionCarousel` (awaitable EN el mismo turno, Escape→undefined); interceptación via extensión inline `resourceLoaderOptions.extensionFactories` + `pi.on("tool_call")` con `{block, reason}` — el bucle de pi ESPERA al handler (agent-session.js:227-245) | ✅ |
| P1 | Implementar el puente de permisos según el mapa: propuestas `chatParticipantAdditions` + `chatParticipantPrivate`; holder de turno (patrón `toolToken`); extensión inline `picode-permissions` interceptando bash/powershell/edit/write; `autoApprove`/`autopilot` → libre (hoy); `default`/`assisted` → questionCarousel Permir/Denegar; denegar o cancelar → `{block:true, reason}` | ✅ obrero 27-09 |
| P2 | Tests del puente puro (decisión preguntar/no-preguntar por tool y modo del mando) | ✅ 13 tests, `node --test` en verde |
| P3 | Build + pack + editor relanzado | pendiente |
| P4 | Documentar, commit, cierre | pendiente |

## Notas del código ya verificado (27-09)

- `picode.mcp.enabled` (por defecto **true**) es el ajuste que cede las tools MCP del editor a
  pi; esas SÍ pasan por el mando del chat hoy (`mcp.ts:70` con `toolInvocationToken`).
- El SDK de pi en modo embebido responde diálogos de extensión con `noOpUIContext`
  (`confirm → false`): las confirmaciones de extensiones de pi hoy se **deniegan en silencio**
  en el chat — gap relacionado, anotado como seguimiento, no en el alcance de esta ficha.

## Registro

- 2026-09-27 · abierta por petición del dueño; explorador en vuelo (P0).
- 2026-09-27 · P0 entregado. Ruta elegida (sanctioned surface): `stream.questionCarousel`
  (no `stream.confirmation`: esa exige un request de seguimiento) + extensión inline vía
  `extensionFactories` (no envoltura de tools: cambia identidad y colisiona). El receptor del
  nivel: `request.permissionLevel` con fallback al ajuste. tsconfig del conector suma los dos
  d.ts de propuestas (patrón chatProvider). Nota: el widget es genérico, no el de "Always
  allow" por tool — follow-up sobre el mismo hook si el dueño lo pide.
- 2026-09-27 · **Decisión del dueño en vuelo**: el picker queda en DOS posiciones — Ask
  (Default) y Allow all; Autopilot y Assisted salen de `DEFAULT_PERMISSION_LEVELS` y del enum
  del ajuste. El puente conserva el mapeo a cuatro nombres (`autoApprove`/`autopilot` →
  libre; `default`/`assisted` → preguntar) SOLO como robustez ante valores obsoletos del
  ajuste `chat.permissions.default`. La pregunta por llamada usa Allow / Deny, coherente con
  el modelo de dos posiciones.
- 2026-09-27 · P1+P2 implementados. `permissions.ts` puro (13 tests: matriz shouldAsk 4
  niveles × mutante/solo-lectura, decisionFromAnswer con undefined/allow/deny/desconocido,
  permissionLevelOf con precedencia y basura). `agent.ts`: holder `turnContext` (stream +
  nivel resuelto por `permissionLevelOf(request.permissionLevel, ajuste)`), extensión inline
  `picode-permissions` (hidden) con `pi.on("tool_call")`: no-preguntar → `undefined`
  (continúa); preguntar → `questionCarousel` con detalle del comando/ruta (truncate 160) y
  decisión por `decisionFromAnswer`. Postura de fallo: fail-OPEN solo en rotura propia del
  puente (sin stream, carousel que lanza — se registra en el log); Escape/cancel/deny SIEMPRE
  bloquea. La sesión se reconstruye por carpeta/tools/perfil, y la factory se re-registra en
  cada rebuild leyendo el holder en tiempo de llamada — el nivel es siempre el del turno en
  curso. Typecheck 0 errores (tsc nativo, propuestas resueltas); out/ emitido; 74/74 tests
  del directorio (61 existentes + 13 nuevas).
