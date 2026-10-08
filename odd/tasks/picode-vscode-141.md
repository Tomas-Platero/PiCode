# Feature: adopción de funciones de VS Code 1.141 para el host pi

**Estado:** en curso · **Rama:** `experimental` · **Abierta:** 2026-10-08

## Intención del dueño

> «Revisa la versión de vscode 1.141.0 hay fixes, hay mejoras, etc. Revisa que podríamos añadir a picode y dame una lista, no añadas nada, solo dime que crees que podríamos añadir.»
>
> «Pues añade estas cosas al proyecto.»
>
> «revisa que es lo que hace la otra sesión y cuando termine revisa como añadir tu esos cambios, no me esperes»

Se revisaron las notas oficiales de VS Code 1.141.0 (7-10-2026) y se seleccionaron siete
funciones que encajan con el host pi. La otra sesión cerró mientras tanto la subida del
pi interno a 1.1.0 (`picode-pi-110.md`), así que esta ficha trabaja sobre **pi 1.1.0**.

## Lo que se midió antes de decidir (mapa de lectura, 2 exploradores en paralelo)

Rutas vivas: el árbol del editor es `picode-source/src/`; la extensión viva es
`picode-source/extensions/picode` (la raíz no tiene `extensions/`; lo confirman
`dev/build-connector.sh:21` y `dev/build.sh:271`). El SDK de pi **no está en
node_modules del repo**: se instala en runtime en
`resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent` (el pack
experimental ya lleva 1.1.0).

| # | Función de 1.141 | Estado en PiCode | Gancho medido |
| --- | --- | --- | --- |
| F1 | Servidores MCP descubiertos visibles en Customizations | La página existe (`aiCustomizationManagementEditor.ts`) y la sección MCP de PiCode (`src/vs/workbench/contrib/picode/browser/picodeMcpSection.ts`) pinta lo que le llegue en el estado (`IStatusDataSlice.mcpServers`); hoy el conector (`extensions/picode/src/status-data.ts:104-118`, `readMcpServers`) lee **solo** `<perfil>/mcp.json` + `mcp-auth.json` | El SDK trae `loadMcpConfig({agentDir, cwd, projectTrusted})` (`dist/extensions/mcp/config.d.ts:59-63`) y el registro de servidores que conectan extensiones (`McpServerRegistry`, `mcp_servers_change`, `getMcpServers()`). Ampliar `readMcpServers` para fusionar: perfil + proyecto de confianza + descubiertos por plugins |
| F2 | Píldora de shells en background | pi tiene una tool `background`; la extensión ya la modela con tarjetas (`background-cards.ts`, consumida en `agent.ts:476`) | El input del chat tiene un mecanismo de slots genérico (`chatInputStack.ts`, usados por notices/notifications/editing widget). La píldora es una superficie de ese stack alimentada por las llamadas background en curso |
| F3 | Encolar / reemplazar / cancelar mensajes entre sesiones | La extensión ya encola con `followUp` (`agent.ts:546`); no hay cancelar ni reemplazar | El SDK 1.1.0 trae `steer()`, `followUp()`, `clearQueue()` (RPC `clear_queue` devuelve los textos encolados), `deliverAs` y `set_steering_mode`. Reemplazar = `clearQueue` + re-encolar la versión nueva; cancelar = `clearQueue` |
| F4 | Progreso persistente en el chat | No existe en este árbol (`grep persistentProgress` = 0). El progreso hoy son parts de tool invocation y el estado "working" del input | Misma superficie del input stack (F2), alimentada por el turno en curso. La variante 1.141 mantiene visible la actividad mientras responde |
| F5 | Limpieza de worktrees | La infraestructura del host es madura: `src/vs/platform/agentHost/node/shared/worktreeIsolation.ts` (`WorktreeIsolation`, `_materializedWorktrees` por sessionId, `removeWorktree` en :824, cleanup on archive), git en `common/agentHostGitService.ts` | Falta la UI: editor/comando que liste worktrees materializados con tamaño e inactividad y los elimine vía el servicio existente |
| F6 | Rejilla de sesiones | Existe una vista de sesiones dentro del panel de chat (`agentSessionsControl`, `chatViewPane.ts:874-924`), no una ventana dedicada. Providers en `agentSessions.ts:15-23` **sin** `AgentHostPi` | La rejilla 2D (splits arrastrables) va sobre `AgentSessionsControl`; engancharla a la vista existente es más barato que una ventana nueva |
| F7 | Sandboxing del agente | **pi no trae sandbox** (`docs/security.md:99`). El sandbox del host (`chat.agent.sandbox.*`, `sessionPermissions.ts`) es ruta Copilot; no llega a pi | Tres vías medidas: (a) gating de tools en `createAgentSession` (`tools`/`excludeTools`, prefijo `mcp__`), (b) `BashSpawnHook`/`BashOperations` de extensiones para ejecutar la política del host sobre cada comando bash, (c) endurecer `permissions.ts` del conector. (a)+(b) es el encaje honesto |

Además, la subida de base a 1.141 arrastrará los ~30 arreglos de fugas de memoria de
upstream sin trabajo adicional (ya anotado en el reporte al dueño).

## Decisions

1. **Orden de implementación por valor/coste:** F1 (pequeña y el widget ya colabora) →
   F2 y F3 (la extensión ya tiene los datos y el SDK ya trae las operaciones) → F4 →
   F5 → F6 → F7 (la más grande). Nada se marca hecho sin compilar + tests.
2. **La superficie de UI es una sola:** F2 y F4 comparten el mecanismo de slots del
   chat input stack. Se hace una pieza de "estado del agente" sobre el input y no dos.
3. **F3 se expone como acciones del chat**, no como protocolo nuevo: cancelar cola y
   reemplazar el último encolado son operaciones sobre `clearQueue` + re-encolar.
4. **F7 no inventa un sandbox:** usa las dos palancas que pi ofrece (allowlist de tools
   al crear sesión y hook de spawn de bash). Lo que no se pueda restringir con esas dos
   se declara como límite, no se disfraza.
5. **No se toca el pack de la otra sesión:** su ficha (`picode-pi-110.md`),
   `distribution/runtime.json` y el `CHANGELOG.md` quedan fuera de alcance; solo se
   añade entrada propia al changelog al cerrar esta ficha.

## Tasks

- [x] **F1 · Servidores MCP descubiertos** (2026-10-08). `readMcpServers` fusiona tres fuentes
      con origen en cada fila (`origin`: `profile` / `project` / `discovered`): el perfil del pi
      en fuerza, el `.pi/mcp.json` del proyecto (solo con el espacio de confianza, porque es la
      regla con la que pi lo carga) y los servidores que la sesión viva tiene conectados — leídos
      de las herramientas `mcp__<servidor>__<tool>` que pi expone (`getAllTools`, añadido al
      tipado estructural de `PiSession`; el nombre del servidor sale de `mcpServerNameOfTool` en
      `mcp-provider.ts`). El primer origen gana en choque de nombres (el perfil es el que tiene
      fila editable). La página pinta `Project` / `Discovered` en la columna de origen y esas
      filas son de solo lectura: Editar/Quitar escribirían una entrada nueva del perfil, no lo
      que la fila muestra. Verificado: `build-connector.sh` exit 0, 39 tests (6 nuevos en
      `test/mcp-discovered.test.ts`), `tsc` del núcleo 0.
- [x] **F2 + F4 · Píldora de estado del agente** (2026-10-08). Una superficie sobre el input del
      chat (`contrib/picode/browser/picodeAgentStatusPill.ts`, hueco añadido a las dos variantes
      del stack en `chatInputPart.ts`) con dos filas: **actividad** — qué hace el agente ahora
      mismo y cuántos mensajes esperan su turno, con botón *Cancel queued* — y **trabajos en
      background** — cuántos siguen corriendo, cuál es el más antiguo y desde cuándo. El conector
      **empuja** el estado (`picode.picodeAgentStatusChanged`), no hay sondeo: un sondeo
      despertaría la extensión al arrancar la ventana solo para oír "nada". La píldora se
      redibuja en cada empuje y en el minuto que mueve los tiempos. El progreso persistente de
      1.141 queda cubierto por la fila de actividad: lo que el agente está haciendo se queda
      visible sobre el input aunque el transcript siga corriendo. Fuentes puras con tests:
      `background-jobs.ts` (registro de trabajos: alta por inicio, baja por fin, cerrado por
      número o por la etiqueta que el fin repite), `picodeAgentStatusData.ts` (lectura del
      empuje), 8 + 11 tests. Verificado: conector 0 errores, `tsc` del núcleo 0.
- [x] **F3 · Cancelar los mensajes encolados** (2026-10-08). La cola ya existía (`turnChain`);
      ahora cada turno en espera sale **en el momento** en que se le cancela (carrera contra su
      promesa de caída), no cuando el turno en curso termina. El botón *Cancel queued* de la
      píldora llama `picode.cancelQueuedTurns`, que devuelve sin ejecutar todos los turnos
      esperando y nunca toca el que está en vuelo — ese lo para el botón de parar del propio
      chat. El reemplazo del último encolado de 1.141 queda fuera a propósito: era para mensajes
      agente-a-agente; la cola nuestra es de peticiones del dueño, y cancelar + reenviar es el
      gesto honesto. Verificado con los mismos controles que F2.
- [x] **F7 · Herramientas desactivadas** (2026-10-08). Ajuste `picode.pi.disabledTools` (lista de
      nombres, vacío por defecto): al construir la sesión, cada nombre entra en el
      `excludeTools` de pi (`sdk.d.ts:54`, confirmado contra el pi 1.1.0 del pack). Un nombre que
      no sea cadena no vacía se descarta — una entrada que pi no puede casar es una herramienta
      que el dueño cree apagada y no lo está. El cambio de la lista reconstruye la sesión, igual
      que los servidores MCP. Queda dicho en el propio ajuste: es lo que el agente no puede
      alcanzar, **no una frontera de seguridad** — sus comandos siguen preguntando antes de
      ejecutarse. 5 tests en `test/disabled-tools.test.ts`. Verificado: conector 0 errores,
      todos los tests del paquete en verde.
- [x] **F5 · Limpieza de worktrees — decisión, no tarea** (2026-10-08). Medido: pi 1.1.0 **no
      crea worktrees por sesión** (su SDK no trae el concepto; solo su servicio git sabe leer un
      repo con forma de worktree), y el aislamiento del host (`worktreeIsolation.ts`) es para las
      sesiones del agent host, que PiCode aún no tiene — no hay ningún `IAgent` real registrado
      (`picode-pi-agent-host.md`, A2c-iv pendiente). Una pantalla de limpieza hoy limpiaría algo
      que no existe: el badge que promete lo que no hay que el dueño no quiere. Queda con su
      gancho medido (listar sobre `WorktreeIsolation` + `IAgentHostGitService`) para el día en
      que el host de pi tenga sesiones con worktrees.
- [x] **F6 · Rejilla de sesiones — descartada por el dueño** (2026-10-08). La rejilla de 1.141
      vive en su ventana de agentes, una vista que PiCode no tiene y no quiere: la decisión del
      dueño es que **nada vaya a la vista agéntica de VS Code**. En el chat, lo que la rejilla
      aportaría (dos conversaciones lado a lado) ya se tiene abriendo sesiones como pestañas del
      editor y dividiéndolo, y la vigilancia de "¿qué terminó, qué me espera?" la cubre la
      píldora de estado. El gancho medido queda anotado por si el producto crece algún día hacia
      una vista de agentes dedicada.
- [x] **F8 · El borde inferior del chat se cortaba** (2026-10-08). La lista del chat se
      dimensionaba con la última altura del input que había reportado el observador de cambios
      de tamaño — una cifra que llega un ciclo tarde cuando algo del stack del input crece (la
      tarjeta de sugerencias, un aviso, la píldora). En esa ventana la lista robaba píxeles y el
      borde inferior del input (iconos, última frase) se salía de la vista, a veces sin
      recuperarse hasta redimensionar. Ahora la lista se dimensiona con la altura **real** del
      input leída del DOM en el momento (`_layoutListForInputHeight` en `chatWidget.ts`), y la
      cifra en caché queda solo como reserva para un elemento aún no medido. Verificado: `tsc`
      del núcleo 0; el arreglo se prueba en el editor empaquetado, que es donde el dueño lo vio.
- [x] **Cierre** — changelog anotado y build del pack lanzada para verificar todo el árbol.

## Nota de coordenadas

- El test puro del núcleo (`contrib/picode/browser/test/`) se excluye de `src/tsconfig.json`:
  corre con `node --test` y type stripping, que exige imports `.ts` que el compilador del núcleo
  no admite — el mismo arreglo que ya tienen los tests del conector (su tsconfig solo incluye
  `src/**/*`).
- La píldora reutiliza el hueco `picodeBackgroundPillContainer` declarado en `chatInputPart.ts`
  (nombre del momento en que solo iba a llevar trabajos en background; la superficie es la de
  estado del agente entera).

## Registro

- 2026-10-08 · Abierta tras el listado al dueño («Pues añade estas cosas al
  proyecto»). Mapa medido con dos exploradores en paralelo. Descartadas por el
  encaje con el producto: sesiones externas de Copilot/Codex, GHE múltiple, Dev
  Container samples y mascota del chat.
