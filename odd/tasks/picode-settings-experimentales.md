# Ajustes experimentales — auditoría y limpieza

**Abierta:** 2026-10-03 · **Estado:** limpieza aplicada, pendiente build

El dueño: «Hay un montón de settings con lo de “experimental”; revisa si son necesarias; da igual si es
para un pi externo o interno».

## Inventario

62 ajustes con etiqueta `experimental` (auditados con un subagente leyendo cada bloque y sus lectores):

- 58 en `picode-source/src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts`.
- 1 en `promptTimeline.contribution.ts` (`sessions.chatTimeline.display`) — se queda.
- 3 en `agentsVoice.contribution.ts` (`agents.voice.*`).
- La extensión propia (`extensions/picode/package.json`) **no tiene ningún ajuste experimental**.
- `src/vs/workbench/contrib/chat/common/*` no registra ajustes.

Resultado del análisis: **17 QUITAR, 42 MANTENER, 3 DUDA**.

## Retirados (17)

Restos de Copilot, de otros proveedores o huérfanos sin lector:

| Clave | Motivo |
| --- | --- |
| `chat.experimentalSessionsWindowOverride` | Nadie la lee. |
| `chat.sessionSync.enabled` | Sync de sesiones Copilot a GitHub; nadie la lee. |
| `chat.sessionSync.excludeRepositories` | Igual; huérfana. |
| `chat.agentSessions.migrateLegacyCopilotCli` | Migración de sesiones Copilot CLI (formato inexistente). |
| `chat.agentSessions.showExternal` | Sesiones de agentes ajenos al Agent Host de PiCode. |
| `chat.editor.codex.preferAgentHost` | Proveedor Codex (ajeno). |
| `chat.agentHost.copilot.mapLegacySettingsToManagedSettings` | Puente a “managed settings” del Copilot SDK. |
| `chat.agentHost.copilot.toolSearch.enabled` | Tool-search exclusivo del Copilot SDK. |
| `chat.copilot.semanticSearch.enabled` | Solo sesiones Copilot. |
| `chat.agentHost.sdkSandbox.enabled` | Sandbox del shell del Copilot SDK. |
| `chat.agentHost.sdkSandbox.enabledWindows` | Igual, Windows. |
| `chat.modeFilesLocations` | Deprecado y sin lector de producción. |
| `chat.experimental.collectInstructionsInExtension` | Ruta de la extensión GitHub Copilot Chat. |
| `chat.customizations.promptMigration.enabled` | Migración prompt→skill heredada; la página de customizations de PiCode no lista prompts. |
| `agents.voice.enabled` | Voice Mode depende de entitlement Pro de Copilot. |
| `agents.voice.showButton` | Botón de Voice Mode (Copilot). |
| `agents.voice.agentProgress` | Locución de progreso de Voice Mode (Copilot). |

Aplicado: se eliminaron los **bloques de registro** de esos ajustes (desaparecen de Settings) y los
imports que quedaron huérfanos. Los *lectores* de los que sí tenían se han dejado (leen el valor
como `undefined`, que apaga la función); el vocabulario interno (miembros de `ChatConfiguration`, etc.)
se conserva para no romper el resto del chat.

## Se quedan (42)

Los que configuran comportamiento real del chat de Pi (render incremental, thinking, prompts/skills,
MCP, plugins, artefactos, terminal, inline chat, sesiones, auto-approve, etc.). Lista completa en el
informe de la auditoría; ejemplos: `chat.tools.global.autoApprove`, `chat.experimental.incrementalRendering.*`,
`chat.agent.thinking.*`, `chat.useNestedAgentsMdFiles`, `chat.mcp.autostart`, `chat.pluginLocations`.

## Dudas (3) — no tocadas

- `mcp.enterpriseManagedAuth.idp` — auth empresarial de MCP; funcional pero orientada a política corporativa.
- `chat.agentHost.allowSignedOutWhenUsable` — puerta de sign-in de GitHub, cableada en varias rutas.
- `chat.customizations.userDataMigration.enabled` — migración de customizations del perfil; puede seguir aplicando al perfil interno.

## Pendiente

Decidir si se retira también el *código* de los lectores (queda apagado) y si se abordan las 3 dudas.

## Verificación (2026-10-03)

- `tsc --noEmit` limpio (dos pasadas tras los arreglos de imports).
- Build con `dev/build-run.sh` correcta (perfil preservado).
- En el binario: **0 apariciones** de las descripciones de los 17 ajustes retirados (p. ej. «Enable
  session sync to GitHub.com», «Enable the Voice Mode panel», «Specify location(s) of custom chat
  mode files»), y ninguno aparece ya en contexto de propiedad de configuración. Los IDs que aún
  aparecen en el bundle son los de los **lectores** (que leen el valor y lo encuentran vacío), no el
  registro.
- Prueba de arranque de la app: sin errores (job de smoke test).

## Segunda pasada: los huérfanos, borrados del todo (2026-10-03)

El dueño: «quita los huérfanos». De los 4 ajustes sin lector, se retiraron sus últimos rastros:

- `chat.experimentalSessionsWindowOverride` — ya no tenía ninguna referencia tras quitar el registro.
- `chat.sessionSync.enabled` / `chat.sessionSync.excludeRepositories` — se quitaron los miembros
  `ChatConfiguration.SessionSyncEnabled` y `SessionSyncExcludeRepositories`.
- `chat.modeFilesLocations` — se quitó `PromptsConfig.MODE_LOCATION_KEY`, la entrada colgante en
  `settingsLayout.ts`, y `LEGACY_MODE_DEFAULT_SOURCE_FOLDER` (solo lo usaban los tests). Se actualizaron
  los 4 tests que lo referenciaban (`config.test.ts`, `promptFilesLocator.test.ts`,
  `computeAutomaticInstructions.test.ts`, `promptsService.test.ts`). `LEGACY_MODE_FILE_EXTENSION` **se
  queda**: sí lo lee producción (`promptFilesLocator`, `promptCodeActions`, `promptValidator`).

Nota: `AgentHostSessionSyncEnabledConfigKey` (`sessionSyncEnabled` del esquema del agent host, para el
CLI del copilot-sdk) **no** se toca: es un esquema de sesión compartido, no un ajuste de Settings.

## Cierre (2026-10-03)

Build y verificación hechos: typecheck limpio, binario sin las descripciones/schema de los 17, app
arranca. El dueño amplió después la limpieza al resto del chat (ver `picode-auditoria-de-ajustes.md`,
tercera pasada). Lo que queda de esta ficha es solo lo que el dueño decida sobre el *código* de los
lectores (hoy apagados).
