# Tarea: limpieza de ajustes — fuera lo que no usamos, releases siempre nuestras

> Decisión del dueño (2026-09-28, tras la auditoría de `picode-auditoria-de-ajustes.md`):
> «yo quitaba todo lo que no usemos. Y las releases ponlas para mi página — quita todo lo
> de Microsoft que no usemos.»

## Decisiones registradas

- D1 · La importación/import ya está decidida en rondas previas; aquí solo limpieza.
- D2 · Release notes: **siempre la página del dueño** (`releaseNotesUrl` → GitHub
  Releases). Fuera el fetch a `code.visualstudio.com` (notas integradas y el widget
  post-instalación).
- D3 · Telemetría: fuera los ajustes visibles que son no-ops
  (`telemetry.telemetryLevel`, `telemetry.enableTelemetry`, `telemetry.enableCrashReporter`).
  **Se conserva** `telemetry.feedback.enabled` (gatea el reportero de problemas y las
  encuestas del chat — load-bearing). La fontanería interna Null no searranca: no envía
  nada por construcción y arrancarla sería cirugía upstream de riesgo alto.
- D4 · Copilot: fuera el bloque `chat.agentHost.*` (~50), los interruptores del arnés
  (`chat.defaultToCopilotHarness`, `chat.editor.preferCopilotHarness`,
  `chat.editor.localAgent.enabled`), entitlement (`chat.titleBar.signIn.enabled`,
  `chat.growthNotification.enabled`, `chat.approvedAccountOrganizations`,
  `chat.allowAnonymousAccess`, `chat.agentHost.byokModels.enabled`),
  `chat.extensionUnification.enabled`, `dictation.*`, `workbench.enableExperiments`, y los
  tres con nombre Copilot (`github.copilot.chat.claudeCode.enabled`,
  `sessions.github.copilot.multiChatSessions`, el no declarado).
- D5 · Fuera los deprecated visibles: `update.channel`,
  `chat.experimental.detectParticipant.enabled`.
- D6 · El User-Agent del update pasa de `Code/…` a `PiCode/…`; las descripciones de
  `update.*` dejan de citar a Microsoft.
- D7 · No se toca (load-bearing para pi): `chat.agent.enabled`, `chat.disableAIFeatures`,
  `chat.mcp.*`, `chat.tools.*` (no-terminal), `telemetry.feedback.enabled`, todos los
  `picode.*`. El código interno que LEE ajustes eliminados se queda (devuelve undefined →
  defaults); solo se retiran los registros y las rutas muertas triviales.
- D8 · Rutas muertas invisibles (command IDs de copilot que nadie provee) se dejan: no se
  ven y arrancarlas es riesgo sin beneficio visible. Quedan anotadas.

## Unidades

| # | Unidad | Quién |
| --- | --- | --- |
| L1 | Ajustes muertos: agentHost + arnés + entitlement + unification + dictation + experiments + copilot-named + deprecated (update.channel, detectParticipant) | worker |
| L2 | Update sin Microsoft: release notes → siempre `releaseNotesUrl`, fuera el fetch de notas y el widget post-instalación (`update.showPostInstallInfo`), User-Agent PiCode, descripciones sin Microsoft | worker |
| L3 | Telemetría visible fuera: `telemetry.telemetryLevel`, `telemetry.enableTelemetry`, `telemetry.enableCrashReporter` (+ su fontanería de registro), AppCenter en main.ts | worker |
| L4 | Verificación: typecheck núcleo + conector, pruebas del conector, build completa | yo |

## Ejecución (2026-09-28, tarde) — `266192b9`, `a3ce7c47`, `919e5d86`

Los tres frentes en el árbol, typecheck global en 0, pruebas del conector en verde.

**Se quedaron a propósito** (excepciones documentadas):
- `chat.titleBar.signIn.enabled` y `chat.titleBar.openInAgentsWindow.enabled` — la UI viva
  del title bar los consume en cláusulas when; sin registro ocultarían sus botones.
- `chat.agentHost.copilot.toolSearch.enabled` — sin registro, la lectura resolvería false
  y desactivaría tool search silenciosamente (su default era true).
- `telemetry.feedback.enabled` — gatea el reportero de problemas y las encuestas del chat.

**Lectores que quedan a propósito**: el código que leía ajustes eliminados sigue ahí y
resuelve undefined → defaults (anotado en el informe de L1, con file:line). Las rutas
muertas invisibles (command IDs de Copilot que nadie provee) no se tocaron (D8).

**Update sin Microsoft**: cero referencias a code.visualstudio.com bajo los caminos de
update; Release Notes → siempre `releaseNotesUrl` (GitHub Releases del dueño);
`update.showPostInstallInfo` y `update.channel` fuera; User-Agent `PiCode/…`;
descripciones hablando del feed propio en GitHub.

**Telemetría**: `telemetry.telemetryLevel` (+ su política), `telemetry.enableTelemetry` y
`telemetry.enableCrashReporter` fuera; `getTelemetryLevel` ahora falla cerrado (unset →
OFF); AppCenter y la marca Microsoft fuera de `main.ts`; volcados de crash locales
conservados con subida desactivada para siempre.
