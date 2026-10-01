# Auditoría de ajustes — qué sirve, qué sobra, y cómo se actualiza PiCode

> Auditoría pedida por el dueño (2026-09-28): revisar TODOS los ajustes, ver qué no se
> puede usar con pi / gentle, qué quitar, y explicar la historia de actualizaciones.
> Solo análisis y decisiones registradas; la ejecución vendrá después, decidida cosa por cosa.

## El resumen que importa

**La telemetría ya no existe en el producto construido.** No es que esté desactivada: el
producto se construye sin claves de telemetría, sin `enableTelemetry`, sin `aiConfig`, sin
`tasConfig` y sin URL de crash reporter — los tres procesos del editor montan servicios
nulos y ningún appender de red llega a crearse. Aunque un usuario pusiera
`telemetry.telemetryLevel: "all"`, no sale ni un byte de su máquina. Los ajustes de
telemetría que se ven en la interfaz son **no-ops honestos**, salvo
`telemetry.feedback.enabled`, que gatea el reportero de problemas y las encuestas del chat
(yo lo dejaría: hace más de lo que su nombre dice).

**Lo que de verdad llama fuera** es solo esto: open-vsx (galería de extensiones + su
control file en GitHub raw), el feed de actualizaciones propio (GitHub raw), y los
endpoints que el usuario configure él mismo. **Nada Microsoft.**

## (A) Quitar — peso muerto que confunde

| Ajuste / bloque | Por qué sobra |
| --- | --- |
| Bloque `chat.agentHost.*` (~50 ajustes: copilot, claudeAgent, codexAgent, cloudSandbox, sdkSandbox, otel, githubMcpServer, systemProxy…) | Configuran el arnés Copilot-CLI/Claude/Codex, que con `defaultChatAgent: null` no tiene producto detrás. Pi es el único agente. |
| `chat.defaultToCopilotHarness`, `chat.editor.preferCopilotHarness`, `chat.editor.localAgent.enabled` | Eligen un tipo de sesión Copilot-SDK que nada en PiCode sirve. |
| Entitlement/sing-in de Copilot: `chat.titleBar.signIn.enabled`, `chat.growthNotification.enabled`, `chat.upgradePlanUrl`, `chat.approvedAccountOrganizations`, `chat.allowAnonymousAccess` (con su propio "TODO remove me"), `chat.agentHost.byokModels.enabled` | El ChatEntitlementService sale temprano (defaultChatAgent null): nunca corre. |
| `chat.extensionUnification.enabled` | Unifica extensiones de Copilot que no existen. |
| `dictation.*` y `dictation.experimental.*` | La voz necesita la extensión `vscode-speech`, que no va empaquetada ni está en open-vsx. Ajustes sin motor. |
| `workbench.enableExperiments` | La descripción dice literalmente "fetched from a Microsoft online service". El cliente de experimentos (TAS) nunca se construye: falta `tasConfig`. Reliquia de UI. |
| `github.copilot.chat.claudeCode.enabled`, `sessions.github.copilot.multiChatSessions`, `github.copilot.chat.cli.isolationOption.enabled` (este ni siquiera está declarado) | Copilot por nombre. Sus lectores (`sessions/`, `chatSetup/`, `mcpCommandsAddConfiguration`, `renameSymbolProcessor`) deben salir en la misma pasada. |
| Deprecated visibles: `telemetry.enableTelemetry`, `telemetry.enableCrashReporter`, `update.channel`, `chat.experimental.detectParticipant.enabled` | Mensajes de deprecated que solo ensucian la interfaz. |

Riesgo: **bajo si se hace en una sola pasada** quitando también los lectores listados en
la auditoría (todo tiene file:line en el informe fuente). `chat.agent.enabled`,
`chat.disableAIFeatures`, `chat.mcp.*`, `chat.tools.*` (no-terminal) y
`telemetry.feedback.enabled` son **load-bearing para pi: no tocar**.

## (B) Cambiar — texto y marcas

- Las descripciones de `update.*` dicen "fetched from a Microsoft online service" — es
  copy heredado; nuestro feed es nuestro GitHub.
- El User-Agent de las peticiones de update dice `Code/<versión>` — debería decir PiCode.
- Las Release Notes integradas tiran de `https://code.visualstudio.com/raw/...` (404
  garantizado para PiCode; hoy sobrevive por el fallback a la página de Releases).
  Candidato: apuntar el fetch al markdown de nuestro propio release o quitar el fetch y
  dejar solo el enlace.

## (C) Se queda — funciona con pi/gentle

`picode.*` (los siete nuestros + `picode.updates.check`), `chat.agent.enabled`
(load-bearing), `chat.disableAIFeatures`, `chat.editor.*`/fuentes, `chat.mcp.access/*`
(y `chat.mcp.gallery.serviceUrl`, muerto por defecto pero revivible por el usuario),
`chat.tools.*` de aprobación, `chat.checkpoints.*`, `chat.implicitContext.*`,
`chat.editRequests`, `chat.undoRequests.*`, `extensions.autoUpdate/*` (open-vsx),
`extensions.ignoreRecommendations` (recomendaciones de workspace), y los
`chat.experimental.*` que consumen código vivo (mantener o podar es decisión de producto,
no de corrección). `telemetry.telemetryLevel` puede quedarse como divulgación honesta
(aunque es no-op) o podarse con toda la fontanería Null — decisión del dueño.

## (D) Cómo se actualiza PiCode (explicado)

1. **Qué pasa hoy**: al arrancar (30 s después) y cada hora, el editor pide
   `https://raw.githubusercontent.com/TomasPlatero/PiCode/HEAD/updates/stable/win32/x64/archive/latest.json`
   (nuestro build es zip/portable → target `archive`). Si ese JSON nombra una versión
   posterior, la barra/menú avisan: "Download Update".
2. **Qué hay que hacer para publicar una versión**:
   - Compilar (`dev/build.sh`) → zip de `PiCode-win32-x64/` → subirlo a GitHub Releases
     (tag v1.136.0, por ejemplo) y anotar el SHA-256.
   - Generar el feed con el script que ya existe:
     `node dev/update-feed.mjs --version 1.136.0 --commit <hash> --url <URL del zip en Releases> --sha256 <hash> --platform win32 --arch x64 --target archive --installed 1.135.1`
     → escribe `updates/stable/win32/x64/archive/latest.json`.
   - Commit y push. El editor de todo el mundo lo ofrece a la hora.
3. **Reglas del feed**: `productVersion` debe ser estrictamente mayor que la instalada;
   `timestamp` (epoch ms) debe tener más de 120 horas (`update.minReleaseAge` — margen de
   seguridad contra releases rotas); `url` absoluta. El README del feed tiene una trampa
   documentada: sin `--target archive`, el script escribe la ruta que Windows nunca pide.
4. **Release Notes**: `update.showReleaseNotes` abre hoy las notas de Microsoft (404) y
   cae al fallback (nuestra página de Releases). Decisión pendiente del dueño: (a) quitar
   el fetch a Microsoft y que muestre siempre nuestro `releaseNotesUrl`, o (b) servir el
   markdown de cada release desde nuestro repo con el mismo formato (`raw/v1_136.md`) y
   que la página integrada lo lea de ahí.

## Decisiones pendientes del dueño

1. ¿Ejecutamos la limpieza del bloque (A) en una pasada? (recomendado: sí, con sus lectores)
2. ¿Telemetría: quedan los ajustes como no-ops honestos o se poda toda la fontanería?
3. ¿Release notes: (a) enlace a Releases o (b) markdown propio en el feed?
4. ¿`chat.experimental.*` que siguen vivos: se quedan o se podan?

## Post-auditoría: el repo real y la skill de releases

- **Bug encontrado al preparar la skill de releases**: `product.json` apuntaba a
  `TomasPlatero/PiCode` (sin guion) — el repo real es `Tomas-Platero/PiCode` (el remoto
  de git). 8 URLs corregidas (`5065ad1f`-siguiente). Ojo: el repo está **privado** —
  hasta que sea público, updater y usuarios recibirán 404.
- Creada la **skill `picode-release`** (`~/.pi/agent/skills/picode-release/SKILL.md`):
  el procedimiento completo de release (versión en `distribution/product-delta.json`,
  build, zip sin `data/`, tag, release con `gh`, SHA-256, feed con
  `dev/update-feed.mjs --target archive` — el win32 SIEMPRE pide el target, el README
  miente —, y el feed debe llegar a `master`, que es lo que `HEAD` sirve).
  Reglas duras: repo público, nunca `--force`, nunca latest.json a mano, timestamp =
  hora de build (rollout de 120 h por `update.minReleaseAge`).
