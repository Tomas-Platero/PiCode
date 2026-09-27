# Chat PiCode y Status vivo

**Estado:** en curso · **Rama:** `feat/source-in-repo` · **Abierto:** 2026-09-27

## Intención del dueño

El chat nativo ya funciona con pi (captura: respuesta correcta del agente). Quedan dos
cosas: **«que el chat el nombre del agente no sea "pi" sino "PiCode". Y su logo no el de la
imagen esa del bubble»** y **«lo que no funciona es el PICODE Status a la izq»** (panel vacío,
solo un guion).

## Diagnóstico (medido en el árbol, 27-09)

- Participante: `extensions/picode/package.json` → `chatParticipants[0]` con `name: "pi"`,
  `fullName: "pi"`. El icono de la cabecera de respuesta lo decide
  `chatListRenderer.getAgentIcon` desde `metadata.icon`, que sale de
  `participant.icon` (API `ChatParticipant.icon`) — el conector **nunca lo pone**, y cae en
  el avatar por defecto. El manifiesto de `chatParticipants` NO admite `iconPath`
  (`additionalProperties: false`, verificado en `chatParticipant.contribution.ts:87`).
- Status: tres fallos sumados. (a) `package.json` declara la vista `"type": "webview"` pero
  `status-view.ts` registra un **TreeDataProvider** (su propio comentario dice «tree,
  deliberately, not a webview») → panel vacío. (b) `registerStatusTreeView()` no está
  llamado desde `activate` (grep: cero llamadas). (c) El comando de datos
  `picode.setup.status` está referenciado pero **no implementado** en ningún fichero.
- Título duplicado: contenedor `title: "PiCode"` + vista `name: "PiCode Status"` → la cabecera
  sale «PICODE: PICODE STATUS». Con `name: "Status"` queda «PiCode: Status».

## Tareas

| # | Tarea | Estado |
| --- | --- | --- |
| S1 | Participante `PiCode`: `name: "picode"`, `fullName: "PiCode"`, e icono `media/picode.svg` (el dibujo de trazos de marca, copiado del núcleo) vía `participant.icon` | 🔄 delegado (writer) |
| S2 | Status vivo: vista a `type: "tree"`, llamada a `registerStatusTreeView()` en activate, y comando `picode.setup.status` implementado con datos reales de los módulos que ya existen (runtime, versión, proveedores, modelo por defecto, MCP, sesión, git); sin dato honesto, fila con `—`, nunca inventado | 🔄 delegado (writer) |
| S3 | Reconstruir (build completo ~3,5 min) y comprobar en el editor empaquetado | ⏳ |
| S4 | Documentar y cerrar | ⏳ |

## Superficie de edición autorizada

`picode-source/extensions/picode/`: `package.json`, `src/extension.ts`, `src/agent.ts`,
`src/status-view.ts`, `src/status-data.ts` (nuevo), `media/picode.svg` (nuevo, copia).

## Registro

- 2026-09-27 · abierto tras la captura del dueño; diagnóstico completo arriba; writer
  delegado con S1+S2.
