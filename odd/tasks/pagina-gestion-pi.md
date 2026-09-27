# Página de gestión del chat con datos de pi

**Abierta**: 2026-09-27 · **Rama**: `feat/source-in-repo` · **Estado**: exploración delegada

## Intención del dueño (frase original, captura 27-09 17:30)

> "Necesito que esta ventana contenga las cosas de pi y gentle-ai ejemplo:
> - Agents - Agentes de Gentle.
> - Skills - Skills tanto en pi, proyecto y gentle-ai.
> - Instructions - esto quitalo.
> - Prompts - Esto quitalo
> - Hooks - Esto quitalo (pi no tiene hooks).
> - MCP Servers - Lista de servidores mcp de pi.
> - Plugins - Listado de Packages de Pi."

Registrada como regla permanente en `AGENTS.md` (§ La ventana de gestión del chat habla de pi).

## Qué es esa ventana

Página **«Agent Customizations for Local»** del chat nativo, en el núcleo:
`picode-source/src/vs/workbench/contrib/chat/browser/aiCustomization/`
(registro de secciones en `aiCustomizationManagementSectionRegistry.ts`).
Hoy lista elementos de las convenciones GitHub/Copilot (`.github/agents`, prompts,
hooks, gallery de plugins…), no el runtime pi.

## Fuentes objetivo (perfil en fuerza, misma disciplina que Status)

| Sección | Debe listar | Dónde vive de verdad |
| --- | --- | --- |
| Agents | agentes de Gentle/pi | `<perfil>/agents/*.md` global + `.pi/agents/*.md` del proyecto |
| Skills | pi + proyecto + gentle-ai | `<perfil>/skills/`, proyecto (`.agents/skills`, `.pi/skills`), `gentle-pi/skills/` |
| MCP Servers | servidores mcp de pi | `mcp.json` global del perfil + `.pi/mcp.json` del proyecto |
| Plugins | paquetes de pi instalados | `<perfil>/npm/node_modules/*` (los que pi carga como packages) |
| Instructions | — FUERA | — |
| Prompts | — FUERA | — |
| Hooks | — FUERA | — |

`<perfil>` = perfil interno (`data/pi-agent`) o el directorio externo si el dueño lo
configuró — el mismo resolutorio que usa el conector (`profile-paths`).

## Tareas

| # | Tarea | Estado |
| --- | --- | --- |
| G0 | Mapeo delegado (Explore `dc84abb8-8dab-451`) | ✅ mapa completo; ver decisiones abajo |
| G1 | Núcleo: quitar Instructions/Prompts/Hooks de `managementSections` (`browser/aiCustomization/aiCustomizationWorkspaceService.ts:55-61`), quitar tarjetas Voice/Dictation (`aiCustomizationWelcomePagePromptLaunchers.ts:106`) y reencaminar la caja libre (quita el prefijo `/init`, `:189`) | ✅ W1 (typecheck 0 errores) |
| G2 | Conector: `chat.registerCustomAgentProvider` (agentes del perfil en fuerza + `.pi/agents` del proyecto) y `chat.registerSkillProvider` (skills de perfil + proyecto + paquetes npm incl. gentle-pi) | ✅ W2: `customizations.ts` (436 L) + 11 tests. El bloqueo declarado por W2 (falta la propuesta en el `include` del tsconfig, fuera de su superficie) lo cerró el padre: una línea + comentario, patrón idéntico al de `chatProvider`. Typecheck 0 |
| G3 | Conector: `lm.registerMcpServerDefinitionProvider` (estable) alimentando la sección MCP desde el `mcp.json` del perfil + proyecto | ✅ W2: `mcp-provider.ts` (239 L) + 8 tests; punto de manifest `mcpServerDefinitionProviders` |
| G4 | Plugins: comando conector `picode.setup.packages` (contrato fijo) + clase de descubrimiento en `agentPluginServiceImpl.ts` que lo llama (patrón `CopilotCliAgentPluginDiscovery:854`) | ✅ núcleo `0236ddff` + W2 `packages-data.ts` (385 L) + 11 tests; contrato exacto cumplido |
| G5 | Build completo + verificación visual en el editor empaquetado | ✅ build 0; pack verificado (3 módulos + manifest + discovery); editor relanzado |
| G6 | Documentar, commits por unidad y cierre | ✅ `0236ddff` + `f104e729` + `cfc30b75` |
| G7 | Verificación del dueño: ¿conecta con el pi externo E interno? | ✅ verificado en código: `profileInForce()` (extension.ts:302) y `chatAgentDir()` (runtime.ts:66) resuelven al MISMO directorio en ambos modos — interno `data/pi-agent`, externo `~/.pi/agent`. La ventana y las sesiones de pi ven siempre el mismo `mcp.json` |
| G10 | (petición del dueño 27-09, captura) Sección Plugins → **Packages**: título y descripción hablando de los paquetes de pi (hoy texto de plugins de VS Code con "commands, skills, agents, hooks"); enlace "Learn more" → pi.dev; quitar el botón "Create Plugin"; "Install from Source" → "Install from Repository" (pi acepta git); "Browse Marketplace" debe BUSCAR el catálogo de pi.dev. Hallazgos del padre: pi.dev NO tiene API pública ("reserved") pero su catálogo son paquetes npm etiquetados pi → la búsqueda oficial de npm (`registry.npmjs.org/-/v1/search?text=keywords:pi-package`) devuelve la misma lista con metadatos; el gestor de pi acepta `npm:` y git (`PackageUpdate.type: "npm"|"git"`); instalar = `pi install npm:<nombre>` en el perfil en fuerza + refresco con `workbench.agentPlugins.checkForUpdates` | ⏳ explorador `140b7cbc` mapeando el pipeline de browse/instalación |
| G8 | (petición del dueño) Añadir servidores MCP desde la propia sección MCP y que pi los detecte — sin `mcp.json` previo también debe funcionar. El conector ya tiene escritor (`mcpServers.ts`); falta dirigir ahí el flujo "Add" de la sección | ✅ W3: botón → `picode.mcp.addServer` con retorno al flujo del editor; módulo `mcp-add.ts` + 15 tests; typechecks 0, 61/61 |

## Decisiones de arquitectura (27-09, tras G0)

1. **El núcleo NO hardcodea rutas de pi**: el perfil en fuerza es dinámico (interno `data/pi-agent` vs externo) y solo el conector lo resuelve bien → los datos vienen del conector por APIs de extensión ya existentes.
2. Agents/Skills → propuesta `chatPromptFiles` (`registerCustomAgentProvider:472`, `registerSkillProvider:493` en el d.ts). El conector añade `chatPromptFiles` a `enabledApiProposals` (es extensión integrada → permitido).
3. MCP → `lm.registerMcpServerDefinitionProvider` (ESTABLE, `vscode.d.ts:20510`); los servidores aparecen vía `extensionMcpDiscovery` sin tocar el widget.
4. Plugins → no hay provider de extensión (`chat.getPlugins` es consumidor, verificado en el d.ts); se pone un **contrato**: comando `picode.setup.packages` → `Array<{ id, name, version?, description?, path }>`; el núcleo lo invoca desde una discovery nueva.
5. Se quitan también Voice Mode / Dictation (no existen en pi; la regla del dueño es que la ventana hable de pi) y el prefijo `/init` de la caja libre (pi no tiene `/init`; se envía el texto tal cual). Decisiones registradas aquí porque el dueño no las nombró.
6. Riesgo a verificar por W1: otros descriptores de harness (Copilot CLI/Claude) podrían re-mostrar las secciones quitadas vía `hiddenSections` — ✅ **resuelto, no había riesgo**: `managementSections` es la única fuente de la lista de secciones
   (`aiCustomizationManagementEditor.ts:454`) y `hiddenSections` solo **resta**
   (`:586-598`); `sectionOverrides` únicamente cambia el botón de una sección ya
   visible (`aiCustomizationListWidget.ts:1033`). Ningún descriptor puede
   re-añadir nada. Harnesses posibles en este producto: Local
   (`createVSCodeHarnessDescriptor`, oculta Tools y tiene una entrada muerta de
   Instructions → `agent-md` en `sectionOverrides`, inocua), los que registre un
   agente del host (Copilot CLI/otros: `agentHostChatContribution.ts:330`),
   servidores remotos (`remoteAgentHostCustomizationHarness.ts:146`) y los que
   aporten extensiones vía `mainThreadChatAgents2.ts:819-846` (traduce
   `supportedTypes` a `hiddenSections`). `product.json` tiene
   `defaultChatAgent: null`. → **sin edición en `customizationHarnessService.ts`**.

## Bloqueo declarado (27-09, W2) — RESUELTO por el padre

El conector **no compilaba** mientras `enabledApiProposals` no tuviera su otra mitad. La
propuesta `chatPromptFiles` necesitaba la línea que **todos** los demás in-tree añaden a su
propio `tsconfig.json` (17 extensiones lo hacen así; `extensions/github/tsconfig.json` es
un ejemplo). W2 no podía tocarlo (fuera de su superficie autorizada) → paró y lo declaró.
El padre añadió exactamente esa línea con su comentario (mismo patrón que la entrada de
`chatProvider`), y los cinco errores TS2694/TS2339 de `extension.ts` desaparecieron:
`tsc --noEmit` y emisión `out/` en verde. 46/46 tests (11+8+11 nuevos + 16 de usage).
```

`picode-source/extensions/picode/tsconfig.json` no estaba en la lista de superficies
autorizadas de W2, así que W2 **no lo ha tocado**: se para y pide autorización (una línea).
El resto del conector (MCP estable, comando de paquetes, los tres módulos puros y sus 30
pruebas) compila y pasa sin esa línea.

## Nota del tsconfig del conector (27-09)

`extensions/picode/tsconfig.json` queda en **JSON estricto, sin comentarios** (el checker
JSON del árbol lo exigía; TypeScript los acepta ambos — no hay riesgo funcional). Las
decisiones que documentaban los comentarios eliminados, aquí quedan:

1. `skipLibCheck: true` — un fichero de propuesta referencia tipos de otras propuestas;
   listarlas todas arrastraría media colección. `git` hace lo mismo. Lo que se verifica
   con fuerza es el código del propio conector, que es el que se compila.
2. `include` de `vscode.proposed.chatProvider.d.ts` — sin él el compilador solo ve la
   superficie estable, que no lleva el `configuration` del proveedor de modelos: leer la
   configuración que rellena el dueño es justo la razón de ser del conector.
3. `include` de `vscode.proposed.chatPromptFiles.d.ts` (añadido hoy) — los proveedores de
   Agents y Skills de la página de gestión solo existen en esa propuesta
   (`registerCustomAgentProvider` / `registerSkillProvider`).

## Registro

- 2026-09-27 · abierta tras la captura del dueño; regla añadida a AGENTS.md; mapeo
  delegado antes de tocar el núcleo.
- 2026-09-27 · G0 entregado (mapa completo con file:línea). Decisiones de arquitectura
  arriba. Dos obreros en paralelo: W1 núcleo (G1+G4-núcleo), W2 conector (G2+G3+G4-comando).
  Contrato entre ambos: `picode.setup.packages`.
- 2026-09-27 · W1 núcleo commitado (`0236ddff`) tras revisión del padre del diff completo.
- 2026-09-27 · W2 MURIÓ a mitad (cupo mensual agotado del modelo deepseek en NaN, 402) justo
  al cablear `extension.ts`. El padre terminó: un include en tsconfig (la propuesta
  `chatPromptFiles`), arreglo de una línea malformateada en `package.json` (array pegado),
  typecheck 0, emisión de out/ y 46/46 tests. Registro en `extension.ts:382-460` verificado
  completo (3 providers + watchers con coalescencia). Nota del padre: el checker JSON de
  pi-lens marca los comentarios del tsconfig como bloqueantes — falso positivo: tsconfig es
  JSONC, el fichero ya se commiteó con comentarios en `396b3d77` y tsgo compila con 0.
- 2026-09-27 · G1 y G4-núcleo entregados por W1. Detalle de lo hecho, hallazgos y lo
  que queda fuera:

  - `managementSections` sin Instructions/Prompts/Hooks en núcleo (`browser/…:55-61`) y
    sin Instructions/Hooks en sessions (`sessions/…:102-110`). El enum, `ITEMS_MODEL_SECTIONS`
    y los `switch` quedan intactos (muertos pero inofensivos, como preveía el mapa).
  - Tarjetas Voice Mode / Dictation: `standaloneCustomizations` vaciado con comentario y
    sin los `CONFIGURE_*_INSTRUCTIONS_ACTION_ID` importados (`…PromptLaunchers.ts:106`).
    El mecanismo de render se conserva porque el constructor es compartido con
    `aiCustomizationWelcomePage.ts:77` y con su test.
  - Caja libre del núcleo: `query = value` (sin `/init`); la variante de sessions
    (`Generate agent customizations. …`) queda igual.
  - Plugins: `PiPackagesAgentPluginDiscovery` (`agentPluginServiceImpl.ts:1099`) llama
    `picode.setup.packages`, mapea `name` → etiqueta y `path` → `URI.file`, sin
    `remove` (el perfil pi no se borra desde esta lista) y sin `fromMarketplace`
    (no es marketplace; inventarlo traería acciones y versiones falsas).
  - Se añadió `IPluginSource.label` opcional (`:246`) para que el nombre del paquete
    mueva a la etiqueta en vez del basename del directorio (`:485`).
  - Registro de la discovery: al lado de la clase (`:1195`), no en
    `chat.shared.contribution.ts` (fuera de la superficie autorizada de W1).
  - Límite honesto conocido: `IAgentPlugin` no lleva versión ni descripción, así que el
    nombre es lo único que llega del contrato del conector; la segunda línea de cada fila
    la compone el widget con la ruta (`pluginListWidget.ts:324`) y el detalle lee el
    `README.md` real del paquete. Nunca se fabrican manifiestos.
  - Fuera de superficie (lo decide el padre): la sección Plugins sigue con textos de
    Copilot — «Enabled Locally / available for syncing to the remote session», «No plugins
    installed», «Browse the marketplace» (`pluginListWidget.ts:1009-1066`).
  - Verificación: `node picode-source/node_modules/@typescript/native/lib/tsc.js -p
    picode-source/src/tsconfig.json --noEmit` → 0 errores.

- 2026-09-27 · **G2 + G3 + G4-comando (conector) entregados por W2**, con una línea de
tsconfig pendiente de autorización (bloqueo arriba). Detalle, hallazgos y límites:

  - Tres módulos nuevos, puros y sin `vscode` (se pueden ejecutar con `node --test`):
    `src/customizations.ts` (agentes + skills), `src/mcp-provider.ts` (mapeo de
    `mcp.json`), `src/packages-data.ts` (paquetes + skills de paquete). El registro de
    los tres providers, los `FileSystemWatcher` y el comando viven en `src/extension.ts`.
  - **Rutas reales, leídas del runtime** (no supuestas): agentes en
    `<perfil>/agents`, `<perfil>/subagents`, `<cwd>/.pi/agents`, `<cwd>/.pi/subagents`
    (el runtime de pi vía `gentle-pi/lib/agents-config.ts:211`; `subagents/` gana a
    `agents/` y el proyecto gana al perfil, igual que allí). Skills en
    `<perfil>/skills`, `<cwd>/.pi/skills` y `<pkg>/skills`
    (`pi/docs/skills.md` + `dist/core/package-manager.js:203`; `SKILL.md` a cualquier
    profundidad, `*.md` suelto solo en la raíz, `_shared/` y los directorios con punto
    nunca son skills).
  - **Paquetes = los que lo declaran**, no todo `node_modules`: allí viven 95
    directorios (dependencias transitivas) y solo 3 son paquetes de pi
    (`gentle-pi`, `gentle-engram`, `@heyhuynhgiabuu/pi-pretty`), reconocidos por su
    manifiesto `pi`, la keyword `pi-package` o un directorio de recursos convencional.
    Una declaración sin nada instalado **no se lista** (pi tampoco la resuelve): se
    registra en el log. Declaraciones y directorios se unen por ruta, así que una fila
    por instalación, no dos.
  - **MCP**: se lee la clave `mcpServers` (la que escribe `mcpServers.ts:93` y leen
    `status-data.ts:99` y `profile-import.ts:147`), con `command`/`args`/`env` o
    `type: 'http'`/`url`/`headers`, del perfil y de cada `<cwd>/.pi/mcp.json`. Un
    transporte sin definición en el editor (p. ej. `sse`) o una entrada malformada se
    **omite y se dice**; nunca se inventa un servidor.
  - **Manifiesto**: `enabledApiProposals` + `chatPromptFiles`; activationEvents
    `onCustomAgentProvider`, `onSkillProvider`, `onMcpCollection:pi`; y el
    `contributes.mcpServerDefinitionProviders` con `id: "pi"` (el host **exige** esa
    contribución: `extHostMcp.ts:176` lanza si el `id` no está declarado).
  - Límite honesto conocido: el host de extensiones **no transporta el `source`** de un
    recurso (`$providePromptFiles` solo cruza `uri`/`name`/`description`/`when`/
    `sessionTypes`), así que los agentes y skills de pi llegan a la página como
    customizaciones de extensión, sin la distinción Usuario/Proyecto — si el dueño la
    quiere, es trabajo del núcleo (W1) o de un cambio en esa frontera.
  - Fuera de la lista por decisión: las dos ubicaciones de Agent Skills que pi también
    lee, `~/.agents/skills` y `<cwd>/.agents/skills` (`package-manager.js:1976`): la
    primera está en el home de la máquina y no es asunto de este conector; la segunda se
    reporta aquí para que el dueño decida.
  - Pruebas: `node --test "picode-source/extensions/picode/test/*.test.ts"` → 46 pasan
    (16 de `usage-data` intactas + 30 nuevas: 11 agentes/skills, 8 MCP, 11 paquetes).
  - Nota para el padre: el módulo que resuelve el perfil en fuerza se llama
    `src/runtime.ts` (`readRuntimeMode` + `internalProfileDir`) más
    `externalProfileDir()` de `src/profile-import.ts`; no existe ningún
    `src/profile-paths.ts` en el conector.
- 2026-09-27 · **G8 entregado por W3** (worker delegado). Detalle, decisiones y límites:

  - **Núcleo, una edición** (`mcpListWidget.ts:1152`): el botón "+ Add Server" lanza
    `picode.mcp.addServer` y, solo si la llamada **rechaza** (conector ausente o
    desactivado → comando sin registrar), cae al flujo del editor
    (`McpCommandIds.AddConfiguration`). El comentario del botón explica el PORQUÉ
    (la ventana habla pi; el flujo del editor escribiría otro fichero/forma). La
    cancelación del flujo pi **resuelve**, no rechaza → nunca cae al flujo del editor.
  - **Conector**: comando `picode.mcp.addServer` (`ADD_MCP_SERVER_COMMAND` en
    `extension.ts`, registrado junto a `picode.setup.packages`, sin entrada en
    manifest — como el de paquetes, es invocación programática). Flujo quick-pick:
    nombre (validado al teclear) → duplicado (overwrite/cancel si existe) →
    transporte (stdio/http) → comando (+ args con `splitArguments`) o URL →
    cabeceras/env de una línea `KEY=VALUE` cada vez (el input box es de una línea;
    vacío termina, malformada se dice inline y repite). Todo cancelable en silencio.
    Escribe SOLO `<perfil-en-fuerza>/mcp.json` (el mismo fichero que lista el
    provider), `mkdir` + `mode 0o600` como `writeMcpServers`; tras escribir,
    `ensureMcpAdapter` fire-and-forget; el refresco de la lista viene del watcher
    existente (sin código extra); mensaje final único "MCP server <name> added to pi.
    It will appear in the list.". Los errores internos se **dicen y no se re-lanzan**:
    un rechazo haría caer el botón al flujo del editor, que escribiría el fichero
    equivocado — el fallback solo corresponde a "conector no registrado".
  - **Módulo puro nuevo** `src/mcp-add.ts` (sin `vscode` ni imports de hermanos —
    verificado: Node no resuelve import de hermano sin extensión, así que los módulos
    ejecutables de este conector van sueltos; igual que los demás): `AddServerDraft`,
    `validateServerName`, `validateDraft`, `parseKeyValueLines`, `serverFileEntry`,
    `mcpServersWithAdded`, `mcpServersTextWithAdded`, `serverNames`.
  - **Desviación justificada del plan (opción b)**: el plan decía fusionar vía
    `mcpServersFile(existing, [...existingServers, newOne])` y un helper
    `buildMcpServerSetting`. Verificado en fuente: `McpServerSetting`/`mcpServerEntry`
    **no pueden expresar** `env` de un stdio ni cabeceras más allá del bearer único
    (`McpServerEntry` stdio es `{command, args}` sin env), y `mcpServersFile` con la
    lista completa **reescribiría** las entradas existentes pasándolas por esa forma
    estrecha → perdería `env`/cabeceras que el dueño ya tenga a mano. Por eso el
    helper se llama `mcpServersWithAdded`: normaliza como `mcpServersFile` con lista
    vacía (fichero ausente/roto = vacío; `mcpServers` no-objeto = objeto), conserva
    **verbatim** todo lo existente, sustituye solo el nombre coincidente, y escribe la
    entrada nueva directamente (stdio `command/args/env`, http `type/url/headers`).
    El formato de texto es idéntico al de `mcpServersText` (2 espacios + `\n` final),
    y los tests cruzan ambos módulos para mantenerlo (añadido + reescritura de la
    fila de ajustes + relectura por `mcpServersFrom`).
  - **Fuera de superficie / notas**: dos anotaciones sin cambio de comportamiento en
    helpers preexistentes de `extension.ts` para calmar la regla del repo
    (`readJsonFile` devuelve `Record<string, unknown> | undefined` — un `mcp.json`
    que no sea objeto se lee como ausente, mismo resultado final que antes vía
    `mcpServersFile`; `buildRequestBody` tipado como `ProviderRequestBody`).
  - **Pruebas**: `mcp-add.test.ts` — 15 (entradas stdio/http con y sin env/headers,
    validateDraft/validateServerName, parseKeyValueLines con malformadas, fusión que
    preserva fichero existente + reemplazo por nombre + fichero ausente/roto, texto
    redondo vía el lector de la sección, y supervivencia ante la reescritura de la
    fila de ajustes). Total del directorio: 61/61 (46 previas intactas).
  - **Verificación**: typecheck del conector 0 + emisión `out/`; typecheck del
    workbench (`-p picode-source/src/tsconfig.json --noEmit`) 0. Pendiente del
    dueño/padre: prueba visual en el editor empaquetado (el refresco de la lista
    depende del watcher existente, verificado en código).
- 2026-09-27 · aviso del dueño: "el chat está usando el interno al parecer" con runtime
  externo. Autopsia: FALSO — la sesión de su «hola» cayó en ~/.pi/agent/sessions (externo) y el
  perfil interno no tiene NI UNA sesión. Causa real de la sospecha: AGENT_FRAME decía «runs inside
  the PiCode editor» SIEMPRE, también al pi externo. Fix 89c051b9: el marco ahora sigue el modo
  («the machine's own coding agent, answering through the PiCode editor» en externo). Editor
  relanzado. Pendiente del hilo anterior: interfaz interactiva de MCP (G9) — el dueño pide estilo
  Proveedores (ver lo guardado) en vez de quick-picks secuenciales; ya localizado el widget
  (McpServerListSettingWidget + picode.mcp.servers ya existentes).
- 2026-09-27 · G10 entregado y commitado (a7f2720c). Contrato: picode.packages.search
  (búsqueda npm keywords:pi-package, caché 5 min) + picode.packages.install (CLI de pi como
  Node, perfil en fuerza, cola secuencial con resultado propio por llamada — el padre corrigió
  el vuelo compartido de W5 que respondía por el paquete equivocado). Núcleo W4: textos Packages,
  fuera Create Plugin, Install from Repository reencaminado. 99/99 tests. Nota: dos avisos
  del linter exigían "declarar questionCarousel en vscode" — falsos: los tipos viven en las
  propuestas del tsconfig y tsc pasa en 0; no se aplicaron.
