# Feature: el panel de la izquierda — métricas siempre, todo, tareas y gráficos

## Goal

> «También me gustaría que revisaras las métricas bien de la extensión en la izquierda, haz que
> siempre salgan bien y añade todo, incluida las tareas que se van a ejecutar.»
> «También me gustaría graficos y eso si es posible.»

## Lo medido (con fichero y línea)

**Las filas de hoy, en orden** (`status-view.ts`):

| Fila | Línea | Cuándo falta |
| --- | --- | --- |
| Which pi | 227 | siempre |
| Version (de pi) | 228 | siempre |
| Providers | 229 | siempre |
| MCP servers (+ hijo por servidor) | 232-241 | siempre; datos de `status-data.ts:87-100` |
| Model / Thinking | 243 / 246 | solo si hay valor |
| Session: Context / Cost | 270 / 276 | **solo si `ctxTokens` existe** |
| «No turns yet» | 278 | ← esto es lo de «las métricas no siempre salen» |
| Usage | 283 | solo con proveedor NaN y credencial (`status-data.ts:216-241`) |
| Tokens in/out · Cache | 287 / 290 | solo con sesión y valores |
| Tareas del `todo` | 299-304 | solo si el plan tiene entradas |
| Project: Branch / Changes | 309 / 310 | «—» sin repositorio |
| Error | 314 | solo si lo hay |

**La causa principal de que salga a medias**: `getSessionUsage()` devuelve `undefined` cuando no hay
sesión o cuando esa sesión no ha reportado uso (`agent.ts:983-1030`), y las filas de contexto, coste,
tokens y caché están condicionadas a eso: sin sesión **no se pintan**, así que el panel parece
incompleto en vez de decir «todavía no hay nada que medir».

**Datos que ya existen y no se enseñan**:

- número de sesiones y transcripciones (`sessions-provider.ts:192`);
- paquetes instalados (`extension.ts:762`, comando de paquetes);
- estado de los updates (globalState `picode.updates.lastCheck`, `extension.ts:1595`);
- detalle de cada servidor MCP — comando, url, transporte — (`extension.ts:470`);
- agentes descubiertos (`customizations.ts:236`);
- el directorio de trabajo de la sesión (`sessionFolder`, hoy privado, `agent.ts:940`);
- actividad de subagentes (`subagents.ts:184`).

**«Las tareas que se van a ejecutar»** — cuatro fuentes, y solo una está en uso:

1. el plan del agente (el snapshot del `todo` en la sesión viva): **ya se lee**
   (`session-tasks.ts:57-76`, `agent.ts:995`) y ya se pinta (`status-view.ts:299-304`);
2. **subagentes en curso**: existen como presencia en disco (`subagents.ts:48-64`) pero solo se
   sondean durante un turno (`agent.ts:365`) — el panel no los ve;
3. tareas terminadas (`subagents.ts:352`): solo se ofrecen en un quick-pick (`extension.ts:1687`);
4. los ficheros `odd/tasks/*.md`: **nadie los lee** (alcanzables por fs desde las carpetas).

**Gráficos**: la Tree API solo admite por fila un icono (imagen o codicon), una descripción y una
etiqueta (`status-view.ts:146-163`). No hay barras ni lienzo. Un gráfico dentro del árbol solo se
puede lograr como **imagen e icono de fila** (un SVG dibujado por nosotros: el techo alcanzable). Y
**no hay ningún webview registrado** en el conector, así que una superficie gráfica de verdad habría
que crearla desde cero.

## Decisión

- **Siempre salen**: ninguna fila dependiente de la sesión desaparece. Sin datos, dice lo que pasa
  («no turns yet», «—») en lugar de dejar el panel a medias.
- **Todo lo que ya sabemos**, añadido: sesiones, paquetes, updates, detalle de cada servidor MCP,
  agentes, y el directorio de trabajo de la sesión.
- **Las tareas**, las tres que se pueden leer: el plan del agente (ya está), los **subagentes en
  curso** (presencia en disco) y las **tareas pendientes de `odd/tasks/*.md`** (los `- [ ]`).
- **Gráficos**: se empieza por lo que el árbol permite —un SVG de barras como icono de fila, para las
  filas que son cantidades (tokens, caché, coste, sesiones)—. Un webview queda para después y solo si
  lo pides: es una superficie nueva, con su propio coste.

## Tareas

- [ ] **1. Filas que nunca faltan**: quitar las condiciones de `status-view.ts:268-292` y pintar el
      estado honesto cuando no hay medida.
- [ ] **2. Fuentes nuevas** en `status-data.ts`: sesiones, paquetes, updates, agentes, directorio de
      trabajo, y el detalle de cada servidor MCP.
- [ ] **3. Las tareas**: subagentes en curso (leer la presencia sin depender de un turno) y las
      pendientes de `odd/tasks/*.md`.
- [ ] **4. El gráfico**: un SVG de barras por fila para las cantidades (`status-view.ts:146-163` es
      donde vive el icono).
- [ ] **5. Verificar**: tipos, tests, y una build para verlo.

## Fuera de alcance

- Un webview (una superficie gráfica nueva) salvo que lo pidas después de ver el SVG.
