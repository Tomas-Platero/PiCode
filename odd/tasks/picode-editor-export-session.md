# Feature: exportar una sesión durable desde el editor (click derecho)

Fecha: 2026-10-15 · Origen: «¿hay algo que podamos usar del front/editor que hagamos por ejemplo
click derecho y exportar sesión? o algo así?»

## Goal

Llevar la mudanza de conversaciones durables (ver `picode-durable-pi-130.md` §Mudanza) a la
superficie natural: el panel de sesiones del editor, con click derecho → exportar.

## Dónde encaja (comprobado en la fuente)

- El panel de sesiones es `src/vs/workbench/contrib/chat/browser/agentSessions/`, y su menú
  contextual por fila es `MenuId.AgentSessionsContext` (se construye en `agentSessionsControl.ts`,
  `showAgentSessionContextMenu`, con args reenviados `IMarshalledAgentSessionContext`).
- Ese menú **ya era contribuible desde extensiones**: el punto de extensión
  `src/vs/workbench/services/actions/common/menusExtensionPoint.ts` lo declara con la clave
  **`chat/chatSessions`** (proposed `chatSessionsProvider` — capability que
  `extensions/picode/package.json` ya declara). No hizo falta tocar el núcleo.
- La clave de contexto por fila es `chatSessionType` (`ChatContextKeys.agentSessionType`), que el
  control rellena con el `providerType` de la sesión — para las filas del conector durable es
  `durable` (`DURABLE_SESSION_SCHEME`).
- El transcript se lee como siempre: `subscribe`/`unsubscribe` sobre el pipe del daemon del editor
  (`\\.\pipe\picode-durable-editor`), que da el snapshot completo en la suscripción.

## Lo implementado (solo extensión)

- **`durableSessionMarkdown(snapshot, meta)`** en `extensions/picode/src/durable-sessions.ts`:
  generador puro (sin `vscode`) del documento — cabecera con título (primer prompt del usuario),
  id, nº de turnos, fechas (de los timestamps reales de los mensajes, nunca inventados) y export;
  luego los turnos `### 👤 User` / `### 🤖 Assistant` en orden de transcripción.
- **Comando `picode.durable.exportConversation`** en `extensions/picode/src/durable.ts`:
  - Desde el menú: recibe el item de sesión y saca el id del resource `durable:/<id>`.
  - Desde la paleta (sin arg): quick pick de conversaciones.
  - Lee el snapshot, genera el Markdown y pregunta **dónde guardarlo** (`showSaveDialog`, por
    defecto al workspace, `durable-conversation-<id>-<stamp>.md`); aviso con botón «Reveal File».
  - Errores del daemon con la misma frase honesta del resto de comandos.
- **package.json**: comando nuevo + entrada en `chat/chatSessions` con
  `when: chatSessionType == durable` (solo aparece en filas durables), grupo `4_export`.

## Verificación

- `node --test test/durable-sessions.test.ts test/durable-client.test.ts test/durable-tasks.test.ts`
  → **28/28** (2 tests nuevos: documento completo con fechas reales, y conversación ilegible que
  exporta con su nombre y cero turnos, sin transcript inventado).
- `tsc -p extensions/picode/tsconfig.test.json` → 0 errores.
- `package.json` validado (6 comandos durable, menús `chat/chatSessions` + `view/title` +
  `commandPalette`).

## Nota de despliegue

El cambio vive en la fuente de la extensión; el editor en marcha no lo tiene hasta la próxima
compilación (`gulp compile-extension:picode` o build completa). El fichero exportado es el mismo
formato Markdown que `durable_export` del durable de perfil — no es el snapshot sqlite de la
mudanza: para continuar la conversación en otra máquina sigue haciendo falta
`durable_project_export/import` (esto es la copia legible, aquella la viva).
