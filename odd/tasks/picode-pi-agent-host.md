# Feature: pi dentro del core, como host de agentes

## Goal

pi deja de ser una extensión con superficies propias y pasa a ser **código de core**, y el
**único host de agentes** con el que se puede hablar desde Chat y Agente. Decidido por el
dueño: «quiero que Pi esté dentro del core, que sea el único host con el que se pueda
hablar».

## Por qué esto es core y no una extensión (restricción medida)

pi necesita **Node**: lanza un proceso y habla RPC. El renderer del workbench no tiene
Node, así que una integración «en el core» que viva en el renderer es imposible. Pero el
core **ya tiene** la pieza que resuelve eso:

`ElectronAgentHostStarter` (`src/vs/platform/agentHost/electron-main/`) lanza un
**utility process** (`entryPoint: 'vs/platform/agentHost/node/agentHostMain'`) y el
renderer habla con él por AHP. Ese proceso **es core, va dentro del binario y sí tiene
Node**. Ahí cabe pi sin ninguna extensión.

## Hallazgo que hace viable el plan

Los agentes del host **no están implementados en el repo**: son **SDKs externos** que el
proceso carga. Dependencias reales del workbench:

| SDK | Versión | Agente |
| --- | --- | --- |
| `@vscode/copilot-api` | ^0.5.2 | Copilot |
| `@anthropic-ai/claude-agent-sdk` | 0.3.220 | Claude |
| `@openai/codex` | 0.146.0 | Codex |

Y pi **tiene SDK propio** (`@earendil-works/pi-coding-agent`, cuyo `createAgentSessionServices`
ya usa PiCode en la extensión). O sea: pi entra por la **misma puerta** que Claude y Codex,
no por una inventada.

### Cómo se habilita un agente hoy (medido)

- Ajuste: `chat.agentHost.claudeAgent.enabled` (por defecto **true**),
  `chat.agentHost.codexAgent.enabled` (por defecto **false**), en
  `src/vs/platform/agentHost/common/agentService.ts`.
- Cada ajuste tiene su forma en variable de entorno, que **el starter** pone al lanzar el
  proceso (`VSCODE_AGENT_HOST_CLAUDE_AGENT_ENABLED`, …). El proceso del host decide con ella
  si registra ese proveedor.
- El host se reinicia para que el cambio surta efecto.
- Punto de registro: `src/vs/platform/agentHost/node/agentHostMain.ts` («registers agent
  providers (Copilot)»), sobre `createAgentHostRuntime` (`agentHostBootstrap.ts`).
- El proveedor de Copilot, que sirve de plantilla, vive en
  `src/vs/platform/agentHost/node/copilot/` (arranque del SDK, sandbox, terminales,
  prompts, descubrimiento de personalizaciones, BYOK…).

## Decisions

1. **pi entra como un proveedor más del host**, siguiendo `node/copilot/` como plantilla, no
   como una vía paralela. Es la única forma de que Chat y Agente lo traten como tratan a
   Copilot.
2. **Se apagan los demás**: `claudeAgent.enabled` y `codexAgent.enabled` a `false`, y el
   proveedor de Copilot fuera, para que pi sea **el único host** con el que se puede hablar.
   Eso se hace **después** de que el proveedor de pi funcione: apagarlos antes deja el
   selector de agentes vacío, que es peor que tener alternativas.
3. **La extensión se queda solo como puente temporal**, sin superficies propias, y se retira
   cuando el host de pi esté verificado. Nada de dos superficies a la vez.
4. **El ajuste `picode.pi.providers` sigue donde está** (nodo Chat de Settings) mientras no
   exista el host; no crece más y se retira con la extensión.

## La interfaz que hay que cumplir (medida)

Un proveedor del host es un `IAgent` (`src/vs/platform/agentHost/common/agent.ts:1068`) y no es
pequeña:

- identidad y catálogo: `id`, `getDescriptor()`, `models: IObservable<IAgentModelInfo[]>`,
  `refreshModels?()`;
- ciclo de chat: `onDidChatProgress`, `onDidMaterializeChat`, `onDidChangeChatData`,
  `onDidSpawnChat`;
- operaciones exactas por chat (`IAgentChats`, línea 697): `createChat`, `disposeChat`,
  `canReleaseChat?`, `releaseChat`, `send`, `abort`, mutar, restaurar historial;
- re-enganche desde datos opacos: `materializeChat(...)`;
- opcionales: `setPendingMessages` (steering), `truncateChat`.

### Y nadie la implementa en el repo

Búsqueda hecha: **cero implementaciones de `IAgent` en `src/`**. El directorio
`node/agentHost/node/copilot/` son **2.815 líneas de soporte** (sandbox, terminales, prompts,
descubrimiento de personalizaciones, BYOK), no el agente. Los SDK se consumen por
declaraciones ambientales (`src/typings/copilot-api.d.ts`) y las implementaciones llegan
**de paquetes externos**: `@anthropic-ai/claude-agent-sdk`, `@openai/codex`, y —para
Copilot— la extensión `extensions/copilot`, que VSCodium **retira** (`53-ext-copilot-remove-it.patch`).

Eso explica por qué este build no tiene ningún host de agente local utilizable, y fija el
trabajo real: **hay que escribir el `IAgent` de pi entero**, no adaptar uno existente.

### Y no hay adaptador que imitar

Barrido hecho: en todo `src/` la **única** llamada a `registerProvider(IAgent)` es
`ScriptedMockAgent` (`agentHostServerMain.ts:246`), un mock de script. **Ningún proveedor
real se registra en este árbol** — ni Copilot, ni Claude, ni Codex. Encaja con lo que ya
sabíamos por otro lado: VSCodium retira `extensions/copilot`, y con ella el host que
PiCode podría haber tenido.

Oportunidad y coste a la vez: **el `IAgent` de pi sería la primera implementación real de
este árbol**. No hay nada a lo que conformarse salvo la interfaz — y eso es todo lo que hay.

## A2 · Veredicto de encaje: `IAgent` contra el RPC de pi

Enfrentadas las dos superficies (la interfaz leída aquí; el RPC, que es el de
`docs/rpc.md` y el que la extensión ya habla en `src/protocol.ts`):

| `IAgent` pide | pi ofrece | Veredicto |
| --- | --- | --- |
| `id`, `getDescriptor()` | — | **Nuestro.** Es nuestro proveedor. |
| `models`, `refreshModels()` | `get_available_models`, `get_state` | Encaja directo |
| `onDidChatProgress` | `message_update`, `tool_execution_*`, `turn_start/end` | Encaja: es el mismo flujo que `chat-turn.ts` ya traduce |
| `chats.createChat` | `new_session` (pi ata la sesión a un `cwd`) | Encaja |
| `send` | `prompt` | Encaja |
| `abort` | `abort` | Encaja |
| `setPendingMessages` (opcional) | `prompt` con `streamingBehavior: steer\|followUp` | Encaja |
| `onDidChangeChatData` | `sessionFile` / `sessionId` al cambiar de sesión | Encaja |
| **`materializeChat`** | **`switch_session(sessionPath)`** + las sesiones viven en fichero | **El cruce se resuelve con el `sessionFile` de pi.** Era el riesgo y era el que más miedo daba |
| `releaseChat` / `disposeChat` | apagar el proceso / `switch_session` fuera | Encaja, con cuidado en no matar una sesión que otro chat usa |
| `truncateChat` (opcional) | no existe en el RPC | **Se omite.** Es opcional |
| `onDidSpawnChat` (subagentes) | no se expone en el RPC | **Se omite**: pi delega dentro de su propio bucle |

**Conclusión: el encaje es viable y no necesita inventar nada.** El único punto que podía
romper el diseño —re-enganchar una sesión desde datos opacos— lo cubre pi con su
`sessionFile` y su `switch_session`.

Lo que **no** ofrece el RPC y habrá que resolver por nuestra cuenta: la persistencia de la
relación `chat URI → sessionFile` (el host la pide por `providerData`), y el ciclo de vida
del proceso por sesión (cuándo uno se apaga sin llevarse chats vivos).

## A2c · El contrato real, medido (y por qué no lo he escrito)

El único `IAgent` que existe en el árbol es un **mock**
(`src/vs/platform/agentHost/test/node/mockAgent.ts`, **1.263 líneas**) y sirve de patrón
exacto. La interfaz declara **51 miembros**; el mock implementa, entre otros:

```text
ciclo de chat      createChat, sendMessage, sendMessageError, abortSession, disposeChat,
                   releaseChat, finalizeSession, truncateChat, materializeChat, load
listado/metadatos  listSessions, listExternalChats, listChatsToMigrate, getChatMetadata,
                   getSessionMetadata, importConversation
configuración      resolveChatConfig, resolveSessionConfig, getInheritedChatConfig,
                   chatConfigCompletions, sessionConfigCompletions
modelo/agente      changeModel, changeAgent, getModel
permisos e input   respondToPermissionRequest, respondToUserInputRequest, setPendingMessages
personalizaciones  getChatCustomizations, getCustomizations, syncClientCustomizations
clientes/tools     onClientToolCallComplete, removeActiveClient, getOrCreateActiveClient
identidad          id, getDescriptor, getProtectedResources, authenticate
observables/eventos models, authenticationRequired, onDidChatProgress, onDidDiscoverChats,
                   onDidMaterializeChat, onDidChangeChatData, onDidSpawnChat,
                   onDidCustomizationsChange
```

**Veredicto de tamaño, sin adornos: es una implementación de ~1.200-1.500 líneas** de un
contrato de 51 miembros — permisos, herramientas de cliente, personalizaciones, completado
de configuración, importación y finalizado de sesión, cambio de modelo y de agente,
truncado — **y hay que ejercitarla contra un host en marcha**.

No la he escrito, y es una decisión, no un olvido: escribir 1.500 líneas no verificables
para poder decir «terminado» es precisamente el fallo que este proyecto lleva documentado
desde el Bloque A (el icono que decía éxito con el trabajo sin hacer, los dos alias de
`resolveAgentDir`, el patch incompleto que protegía 4 de 6 sitios). Aquí sería peor: un
proveedor que compile y no hable parece hecho y no lo está.

### Lo que sí queda listo para el que lo escriba

- **El contrato completo**, arriba, con el mock como patrón de forma.
- **El encaje con pi**, ya verificado: `sendMessage`←`prompt`, `abortSession`←`abort`,
  `createChat`←`new_session`, **`materializeChat`←`switch_session` + `sessionFile`**,
  `listSessions`/`getSessionMetadata` ← las sesiones en fichero de pi,
  `setPendingMessages`←`streamingBehavior`, `changeModel`←`set_model`.
- **El interruptor ya está puesto** (A3): el host sabrá si registrar el proveedor con solo
  leer `chat.agentHost.piAgent.enabled`.
- **La decisión de transporte**: SDK **dentro del proceso del host** (que ya es Node), no
  proceso hijo — por eso la dependencia va con el proveedor.

## La superficie del SDK, medida (para escribir el proveedor)

De `dist/index.d.ts` y `dist/core/*.d.ts` de pi 0.87.1, lo que el proveedor usará:

- `createAgentSession(options)` → `{ session: AgentSession, extensionsResult,
  modelFallbackMessage? }`; opciones `cwd`, `agentDir`, `modelRuntime`, `model`,
  `thinkingLevel`, `scopedModels`, `noTools`, allowlist de herramientas.
- `AgentSession`: `prompt(text, PromptOptions)` (con `images` y `streamingBehavior:
  steer|followUp`), `abort()`, `subscribe(listener) → () => void`, `dispose()`, `steer()`,
  `followUp()`, `sendUserMessage()`, `sendCustomMessage()`; estado por `sessionId`,
  `sessionFile`, `sessionName`, `isStreaming`, `isIdle`, `messages`, `model`,
  `modelRuntime`, `thinkingLevel`, y las herramientas por `getAllTools()`,
  `getToolDefinition(name)`, `setActiveToolsByName(names)`.
- Eventos (`AgentSessionEvent`): `agent_start`/`agent_end`/`agent_settled`,
  `message_start`/`message_update`/`message_end`, `turn_start`/`turn_end`,
  `tool_execution_*`, `queue_update`, `compaction_start`/`compaction_end`,
  `auto_retry_start`/`auto_retry_end`, `session_info_changed`, `entry_appended`.

## A2c-ii · Qué le queda exactamente (medido, no estimado)

Al leer `AgentSignal` apareció la pieza que no esperaba: un señal **no lleva «progreso»**,
lleva una **acción del protocolo AHP** (`IAgentActionSignal.action: SessionAction |
ChatAction`). O sea que el proveedor no pinta nada: **construye acciones** y el host las
despacha. Eso es lo que hace grande al proveedor… hasta que se mira **qué** acciones hacen
falta, y ahí se encoge:

| Evento de pi | Acción AHP que hay que emitir |
| --- | --- |
| `turn_start` | `ChatTurnStartedAction` |
| `message_update` (`text_delta`) | `ChatDeltaAction` |
| `message_end` | `ChatResponsePartAction` |
| `tool_execution_start` | `ChatToolCallStartAction` |
| `tool_execution_update` | `ChatToolCallDeltaAction` |
| `tool_execution_end` | `ChatToolCallReadyAction` / `ChatToolCallCompleteAction` |
| `turn_end` / `agent_settled` | `ChatTurnCompleteAction` |
| `abort` | `ChatTurnCancelledAction` |

Ocho acciones, y cada una tiene su evento de pi en frente. **Eso es todo el mapeo.**
Los tipos de acción son **generados** (`state/sessionActions.ts` re-exporta
aliases de `state/protocol/action-origin.generated.ts`), así que lo que queda por hacer es
leer la forma exacta de esos ocho constructores (campos de turnId/partId) y escribir el
mapeo — trabajo de lectura y escritura, con el compilador como red.

### Las acciones, con sus campos (leídas de la spec generada)

`protocol/channels-chat/actions.ts`. Esto es exactamente lo que el proveedor debe construir:

```text
ChatTurnStartedAction    { type, turnId, startedAt, message: Message, queuedMessageId?, _meta? }
ChatDeltaAction          { type, turnId, partId, content, _meta? }
ChatResponsePartAction   { type, turnId, part: ResponsePart, _meta? }
ChatReasoningAction      { type, turnId, partId, content, _meta? }
ChatToolCallStartAction  { type, turnId, toolCallId, toolName, displayName, intention?,
                           contributor? }
ChatToolCallDeltaAction  { type, turnId, toolCallId, content?, invocationMessage? }
ChatToolCallReadyAction  { type, turnId, toolCallId, contributor?, intention?, ... }
ChatToolCallCompleteAction { type, turnId, toolCallId, result: ToolCallResult,
                           requiresResultConfirmation? }
ChatTurnCompleteAction   { type, turnId, duration }
ChatTurnCancelledAction  { type, turnId, duration }
```

`duration` es **del reloj del productor** y el protocolo dice expresamente que los clientes
no lo calculan restando marcas de tiempo: hay que medirlo en el proveedor.

### Y por qué sigo sin escribirlo: cada tipo arrastra dos más

Al ir a construir `ChatTurnStartedAction` hace falta `Message`; `ChatResponsePartAction`
necesita `ResponsePart`, que es una unión con `ResponsePartKind`; los de herramienta
necesitan `ToolCallResult`, `ToolCallContributor` y `ToolInput`. Es el modelo de estado
generado de AHP, y es correcto que sea grande — pero significa que el proveedor se escribe
**con esa spec abierta al lado**, no de memoria, y que un campo mal puesto **no falla al
compilar: falla en ejecución**, que es la peor clase de error.

Añadido a que no puedo ejercitarlo contra un host en marcha, escribir las ~1.200 líneas
ahora sería entregar algo que parece hecho. **Lo que falta está perfectamente acotado**: los
tres o cuatro tipos del modelo de estado (`Message`, `ResponsePart`, `ToolCallResult`,
`ToolInput`), y luego el mapeo de los ocho eventos a estas acciones.

## Lo que ya está escrito del proveedor

| Pieza | Fichero | Estado |
| --- | --- | --- |
| Sesión de pi en el host | `node/pi/piSession.ts` | escrito, compila |
| Traducción a acciones AHP | `node/pi/piActionMapping.ts` | escrito, compila (texto **y** herramientas) |
| La clase `IAgent` que las une | — | **pendiente** (A2c-iv) |

La traducción está **completa**: cubre todo lo que ocurre en un turno salvo el contenido de
la salida de una herramienta, que es una decisión aparte y está declarada.

## Tamaño, dicho sin adornos

No es un parche: es una funcionalidad comparable al directorio `copilot/` — ciclo de vida de
sesión, mensajes del protocolo, herramientas, aprobaciones, personalizaciones. Es un build
de varias sesiones, y decirlo así es más útil que un esqueleto que compile y no hable.

## Tasks

> **A3 quedó sin efecto por decisión del dueño** («quita el interruptor, no quiero que se
> pueda deshabilitar»). El ajuste se añadió y después se **retiró por completo** — id,
> variable de entorno, campo, `setIfMissing`, la lectura en los dos lanzadores y su registro —
> dejando en `agentService.ts` un comentario que explica por qué no debe volver: pi es el
> agente que este producto trae, y un host sin agente no es una configuración, es un editor
> roto. Lo que sí se configura es **qué proveedores usa pi y cómo**, y eso vive donde
> corresponde.

- [x] **A3 — hecho y deshecho, a propósito.** Se añadió el ajuste
      `chat.agentHost.piAgent.enabled`, su variable de entorno, el campo en
      `IAgentSdkStarterSettings`, su `setIfMissing`, la lectura en los dos starters y su
      registro en `agentHostStarter.config.contribution.ts`; y después se **retiró entero**
      por decisión del dueño, que es lo que cuenta la nota de arriba. El parche
      `08-pi-agent-host-setting.patch` **ya no procede**: la fuente final no contiene nada de
      eso, y el parche quedará obsoleto cuando se regeneren los que siguen vigentes.
- [x] **A2c (primera parte) — el puente de sesión, escrito y compilando**:
      `src/vs/platform/agentHost/node/pi/piSession.ts` (parche `09-pi-session-bridge.patch`).
      Abre una sesión de pi **dentro del proceso del host** (`createAgentSession({cwd,
      agentDir})`), y expone lo que un chat necesita: `sessionId`, `sessionFile`,
      `prompt` (con `steer`/`followUp`), `abort`, `subscribe`, `dispose` y sus banderas de
      estado.

      **Y aquí está la decisión que desatasca A1: pi NO es dependencia de compilación.** La
      extensión ya lo carga por `dynamicImport` desde la instalación elegida, y el host hace
      lo mismo con la ruta que le llega por parámetro. Los pocos miembros que se llaman se
      tipan **estructuralmente** — la misma disciplina que `pi-login-command.ts` usa para
      `LoginSdk` — y así el build no arrastra una dependencia que habría que fijar en el
      `package-lock.json`. Si el `createAgentSession` no está, se dice (`no-sdk`), y si la
      ruta no se puede leer, se dice otra cosa (`unreadable`): son dos frases distintas para
      quien lee el log, y colapsarlas contaría un problema de versión como instalación
      ausente.

      **Verificado**: compila limpio en estricto con el compilador del árbol
      (TypeScript 7.0.2), y el control de sanidad previo confirma que ese compilador falla
      cuando debe.

      Lo que **falta** de A2c para que el proveedor exista: la clase `PiAgent implements
      IAgent` que use este puente, y el mapeo de eventos de pi a `AgentSignal`. El puente no
      la incluye a propósito: sin `AgentSignal` y los tipos de chat leídos, escribirla sería
      adivinar.
- [x] **La versión del producto tiene un solo hogar**: `set.version` en
      `distribution/product-delta.json` (`1.135.1`). Lo lee el build para el `package.json` y
      lo aplica la vía del ZIP al árbol empaquetado, así que las dos no pueden discrepar.
      Decisión del dueño: «quiero que la versión la pongas tú». El contador
      `upstream/picode-release.json` se borró por redundante.
- [x] **A1 · resuelta sin dependencia**: pi se carga por `dynamicImport` desde la
      instalación elegida, igual que ya hace la extensión, así que no entra en
      `package.json` ni obliga a regenerar el `package-lock.json`.
- [x] **A2c-ii (camino de texto) — el mapeo, escrito y compilando**:
      `src/vs/platform/agentHost/node/pi/piActionMapping.ts` (parche
      `10-pi-action-mapping.patch`, 202 líneas). Traduce los eventos de pi a las acciones
      AHP **reales** (`ChatTurnStarted`, `ChatResponsePart`, `ChatDelta`, `ChatReasoning`,
      `ChatTurnComplete`, `ChatTurnCancelled`), es **puro** (sin sesión, sin SDK, con el
      reloj inyectado) y por eso se puede ejercitar sin host.

      Dos decisiones que quedan escritas en el propio código:

      1. **Una parte se crea antes de streamearse.** `chat/responsePart` *crea* la parte y
         `chat/delta` *añade* a una por `partId`; streamear a una parte inexistente sería
         una acción contra algo que el reductor no tiene. Y el emparejamiento es exacto
         porque son los propios deltas de pi (`text_start`, `thinking_start`) los que
         anuncian esa frontera.
      2. **`turn_end` no cierra el turno.** pi emite `agent_settled` después, y un turno
         cerrado en `turn_end` se cerraría mientras pi todavía puede reintentar. Cierra
         `agent_settled`; `abort` cierra como cancelado.

      **El compilador encontró un fallo real mío** y así queda registrado: el ternario que
      construía la parte ensanchaba `kind` al enum y el resultado dejaba de pertenecer a la
      unión `ResponsePart` (TS2322). Arreglado construyendo cada variante en su rama.
      Verificado después: **0 errores en el fichero** (los 2 que aparecen son de
      `src/vs/nls.ts`, artefacto de las banderas sueltas del chequeo).
- [x] **A2c-iii (camino de herramientas) — hecho y compilando**, dentro del mismo
      `piActionMapping.ts` (parche 10 regenerado, 274 líneas). Emite `ChatToolCallStart`
      (empezó), `ChatToolCallDelta` (avanza) y `ChatToolCallComplete` (terminó, con si fue
      bien o mal y una frase en pasado).

      **Lo que deja fuera a propósito**: `ToolCallResult` admite llevar la salida de la
      herramienta (`content`), y este mapeo **no la rellena**. `ToolResultContent` es una
      unión de texto, recurso incrustado, edición de fichero, terminal y subagente, y
      describirla a medias pondría en pantalla algo que dice ser la salida de la herramienta
      cuando solo es una parte. El **ciclo de vida** es lo que el chat necesita para enseñar
      que algo está pasando, y es honesto por sí solo.

      El nombre de la herramienta se busca en una tabla corta (`read`→Leer, `edit`→Editar,
      `bash`→Ejecutar…) y **un nombre desconocido se muestra tal cual**, que es la misma
      regla que sigue la propia extensión: esconderlo sería peor que el nombre.

      Verificado: **0 errores** en el fichero (los 2 de `nls.ts` son artefacto de las banderas
      sueltas del chequeo).
- [ ] **A2c-iv (la clase)** — `PiAgent implements IAgent` que una el puente (A2c-i) y este
      mapeo (A2c-ii/iii) con el resto del contrato de 51 miembros.
- [ ] A4 Registrar el proveedor en `agentHostMain.ts`/`agentHostBootstrap.ts` cuando A2c
      exista. El interruptor (A3) ya está puesto.
- [ ] A5 Verificar en ejecución: el selector de agentes ofrece pi y una sesión responde.
- [ ] A6 Apagar `claudeAgent`/`codexAgent`/Copilot: pi como único host. **Después** de A5.
- [ ] A7 Retirar el panel de la extensión y su chat (E4), dejando la extensión en nada.

## No medido

- **No he escrito ni una línea del proveedor.** Lo verificado es la arquitectura completa:
  dónde se registra, con qué SDKs, con qué ajustes, cómo se lanza el proceso y **qué interfaz
  exacta hay que cumplir**. El paso de «pi habla el protocolo del host» sigue sin probar.
- No se ha comprobado que el SDK de pi exponga lo que `IAgent` pide (streaming incremental,
  herramientas, aprobaciones, checkpoints, re-enganche por `materializeChat`). **Es lo
  primero de A2**, y decide el diseño: si pi no puede re-enganchar una sesión desde datos
  opacos, `materializeChat` hay que resolverlo guardando el `sessionFile` de pi.
- No se ha mirado dónde vive el adaptador de Claude/Codex, porque no está en `src/`: puede
  estar en el paquete que distribuye el host. Eso importa, porque si existe un punto de
  extensión para proveedores **fuera** del repo, el camino se acorta mucho.

## Fuera de alcance

- El hub de personalizaciones (`picode-customizations-hub.md`): con pi como host, las
  personalizaciones las descubre el host, no la extensión.
