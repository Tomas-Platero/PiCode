# Feature: pi como Chat Participant nativo (Bloque B)

## Goal

Que el editor compilado abra con **pi dentro del Chat nativo**, sin Copilot instalado ni
`defaultChatAgent`, sin depender del selector de proveedores de Copilot:

- `@pi` es un **Chat Participant** propio (`vscode.chat.createChatParticipant`),
  declarado `isDefault: true`, así que arranca como participante por defecto.
- Sus capacidades se exponen como **Language Model Tools** (`vscode.lm.registerTool`),
  incluida la memoria de engram.
- Los servidores MCP se leen del **`.vscode/mcp.json`** nativo (clave `servers`).
- El core se parchea solo donde no basta con contribuir (`patches/picode/`).

## Why this feature exists

Los Bloques A y B del brief parten de una suposición corregida en el propio brief: la
Language Model Chat Provider API (el selector de modelos nativo) está documentada como
disponible solo con plan de GitHub Copilot. Por eso pi **no** ocupa ese selector: se
registra como participante independiente, que sí es un mecanismo fiable.

## Hallazgo que ordena todo (B1)

Verificado contra la fuente clonada y pinneada (`08d4889f9ec4a1685d257b9b95de036c8e1ce1e5`,
VS Code `1.135.0`):

1. **`contributes.chatParticipants` admite `isDefault`**
   (`src/vs/workbench/contrib/chat/common/participants/chatParticipantContribTypes.ts:23`).
2. **El core prefiere el agente por defecto de una extensión sobre el suyo**
   (`ChatAgentService._preferExtensionAgent`,
   `src/vs/workbench/contrib/chat/common/participants/chatAgents.ts:474`:
   `findLast(agents, agent => !agent.isCore) ?? agents.at(-1)`).
   Consecuencia: declarar `@pi` como `isDefault` **basta** para ser el participante que
   arranca; no hace falta parchear la selección de agente por defecto.
3. **`defaultChatAgent` ya está desmontado** por `distribution/product-delta.json`
   (`unsetNested.defaultChatAgent`), así que todo el andamiaje guardado por
   `if (product.defaultChatAgent)` queda inerte: setup de Copilot, entitlement, picker de
   modelos con sesión, etc.
4. **Lo que queda visible y no está guardado** son textos y acciones sueltos en la vista
   de Chat, no el mecanismo. Los puntos concretos están en la auditoría del final.

## Decisions

1. **Un solo `PiClient` compartido.** El participante reutiliza el cliente que el panel ya
   construye (`getClient`/`ensureClient`), con la misma resolución de instancia y de
   transporte. No se abre un segundo proceso de pi.
2. **`isDefault: true`, `isSticky: true`.** Por (1) y (2) del hallazgo.
3. **El modelo lo elige pi, no el picker del editor.** El picker nativo queda fuera de
   alcance: pi no implementa `LanguageModelChatProvider` (es la API gated). El participante
   resuelve el modelo desde la configuración de pi que el panel ya escribe.
4. **`stream.markdown` para el texto, `stream.progress` para la herramienta en curso.**
   Los deltas `text_delta` se reenvían tal cual; el razonamiento no se vuelca al
   transcript (el panel ya lo dibuja plegado en su superficie).
5. **Espera a `agent_settled`, no a `prompt()`.** `prompt()` resuelve cuando el mandato se
   acepta; el turno termina en `agent_settled` (`pi-rpc-client.ts:480`).
6. **Cancelación = `abort()`.** El `CancellationToken` del handler llama a `client.abort()`.
7. **Migrar en el wizard = copiar todas las categorías y dejar el externo intacto.**
   Extiende `instance-import` a raíces de sesiones y a cualquier categoría que la
   importación en 4 pasos no cubriera.

## Tasks

- [x] B1 Auditar la fuente real de VS Code: referencias a Copilot visibles en Chat/Agent.
- [x] B2 `@pi` como Chat Participant (`contributes.chatParticipants` + handler).
- [x] B3 Tools de pi vía Language Model Tools API (incl. una tool que encarga a pi).
- [x] B4 MCP desde `.vscode/mcp.json` nativo (conversor + comando).
- [x] B5 Patch del core para lo que no resuelve la contribución.
- [x] B6 Pasada de limpieza de strings «Copilot» en la superficie de Chat.
- [ ] B7 Verificación en clon/build limpio.
- [x] B8 Wizard de primer arranque: interno (migrar todo) vs. externo (intacto).

## Hecho

**B2** — `extensions/picode-pi-chat` declara `contributes.chatParticipants` con
`id: picode.pi`, `isDefault: true`, `isSticky: true`, y lo registra con
`vscode.chat.createChatParticipant`. `src/chat-participant.ts` construye el handler; el
turno lo traduce `src/chat-turn.ts` (puro, sin `vscode`), que reenvía `text_delta` como
markdown, los `tool_execution_start` y las reintentas como progreso, y **espera
`agent_settled`** — no `agent_end`, que se dispara también en una reintentas, ni
`prompt()`, que resuelve al aceptarse el mandato.

**B3** — Dos Language Model Tools registradas con `vscode.lm.registerTool`:
`picode_pi_status` (instancia, perfil y modelo vivos, sin rutas absolutas) y
`picode_ask_pi` (encarga un sub-turno a pi y devuelve su texto). pi ejerce sus propias
herramientas de fichero, terminal y memoria dentro de ese turno: la memoria de engram no
se vuelve a declarar porque ya es una tool de pi.

**B4** — `src/mcp-native.ts` traduce `mcpServers` de pi al formato del editor
(`servers`, `stdio`/`http`), conservando `args`, `env` y `headers`, y **reporta** las
entradas sin equivalente en vez de perderlas. `src/mcp-command.ts` y el comando
`picode.piChat.migrateMcp` escriben el `.vscode/mcp.json` del espacio de trabajo previa
confirmación.

**B5/B6** — `patches/picode/03-remove-copilot-from-model-picker.patch`: quita las
cadenas «Sign in to use Copilot», «Sign in to GitHub Copilot to choose a model» y
«Upgrade to GitHub Copilot Pro» del selector de modelos, que es donde quedaban visibles
una vez desmontado `defaultChatAgent`. No toca el comportamiento: el flujo ya era inerte
sin `defaultChatAgent`, y el parche solo evita que la superficie siga nombrándolo.

**B8** — El wizard ya pregunta qué pi se ejecuta (interno/externo) y la puerta «interno»
es la importación en 4 pasos. Lo que faltaba era la cobertura: `instance-import.ts`
incorpora `sessions` como categoría, así que la importación cubre ahora ajustes y
paquetes, modelos, MCP, skills, memoria, sesiones y credenciales. El destino se escribe y
el origen solo se lee, que es la garantía de que el externo queda intacto.

## Evidencia

- **Build completa**: `./dev/build.sh -s` dos veces → `BUILD_EXIT=0` las dos, con las
  fases 6, 7 y 8 terminando y `PiCode-Win32-x64/PiCode.exe` producido. La segunda
  incluye el parche 03 ampliado a cuatro ficheros.
- **Empaquetado**: `PiCode-Win32-x64/resources/app/extensions/picode-pi-chat/` existe,
  con `out/extension.js` (81.712 bytes) y un `package.json` que declara el participante
  (`isDefault: true`), las dos tools y el keybinding.
- **B5/B6 medido sobre el binario**, en `resources/app/out/vs/workbench/workbench.desktop.main.js`:
  `Sign in to use Copilot` → 0; `Sign in to GitHub Copilot to choose a model` → 0;
  `Models, sign in to use Copilot` → 0; `Upgrade to GitHub Copilot Pro+` → 0. Y las cuatro
  cadenas en español están en `out/nls.messages.json`, que es de donde el editor lee el
  texto que muestra.
- `extensions/picode-pi-chat`: `npm test` → `EXIT=0`, **36 suites, 0 fallos**
  (35 previas + `test/chat-participant.test.js`, 30 checks).
- `test/chat-participant.test.js` fija: el mapeo de eventos, que `agent_end` con
  `willRetry` **no** cierra el turno, que los eventos posteriores al cierre se ignoran, el
  orden de `text_delta`, la cancelación → `abort`, y que el participante y las tools
  registrados coinciden con lo que declara el manifiesto.
- `patches/picode/03-...patch`: `git apply --reverse --check` → OK sobre el árbol con el
  parche aplicado; parseo TypeScript de los tres ficheros → 0 diagnósticos.
- El conversor de MCP, el texto de estado y la decisión del comando de migración están
  cubiertos por tests sobre texto, sin editor.

## No medido (y por tanto no afirmado)

- El `@pi` **no se ha invocado en un editor en marcha**: que registre, compile y viaje en
  el paquete no es haberlo usado.
- **Queda un literal «Upgrade to GitHub Copilot Pro»** en el bundle: es el título del
  comando `workbench.action.chat.upgradePlan`, registrado por `ChatSetupContribution`,
  cuya constructora hace `return; // disabled` cuando el servicio de entitlement no trae
  contexto ni peticiones — lo que ocurre sin `defaultChatAgent`. Es lectura de la fuente,
  no una observación en la aplicación arrancada: no se ha comprobado en ejecución que el
  comando no aparezca. Lo mismo vale para las dos apariciones de `Sign in to use GitHub
  Copilot` (`chatSetupRunner`, `chatSetupContributions`, `chatStatusDashboard`).
- El selector de modelos nativo sigue mostrando su estado vacío: pi no implementa
  `LanguageModelChatProvider`, que es la API ligada al plan de Copilot. Es la decisión
  registrada arriba, no un defecto.

## Auditoría B1 — referencias visibles en la vista de Chat

Las que quedan **sin guarda** de `defaultChatAgent` y por tanto siguen alcanzables:

| Fichero | Punto | Qué se ve |
| --- | --- | --- |
| `.../chat/browser/widget/input/modelPicker/modelPickerItemSections.ts:65` | header | `Sign in to use Copilot` |
| `.../modelPicker/modelPickerItemSections.ts:72-77` | item | `Sign in to GitHub Copilot to choose a model.` |
| `.../modelPicker/modelPickerActionItem.ts:192` | hover | `{0} • Sign in to GitHub Copilot to choose a model.` |
| `.../modelPicker/modelPickerWidget.ts:623` | aria | `Models, sign in to use Copilot` |
| `.../chatStatus/chatStatusDashboard.ts:608,619` | dashboard | `Sign in to use GitHub Copilot AI features.` |
| `.../chatSetup/chatSetupRunner.ts:434` | setup | `Sign in to use GitHub Copilot` |
| `.../chatSetup/chatSetupContributions.ts:335,373` | accounts | `Sign in to use GitHub Copilot` |
| `.../actions/chatActions.ts:1170-1200` | command | `Manage Copilot Settings` + `copilotSettings` URL |
| `.../actions/chatGettingStarted.ts:33-55` | welcome | se activa solo con `defaultChatAgent` (ya inerte) |

Guardadas por `defaultChatAgent` (inertes, no requieren patch): `chatSetup`,
`chatStatus`, `agentHost`, `chatGettingStarted`. La **vía de registro** de Copilot no
existe como extensión: no viene instalada y `extensionEnabledApiProposals` ya no la
declara.

## Fase E — el gate de Copilot, depurado contra el editor corriendo

### Lo que la ejecución real desmintió

B1 concluyó, leyendo el código, que `ChatSetupContribution` «se autodesactiva sin
`defaultChatAgent`». **La ejecución lo desmintió**, y el motivo es que la poda del delta no
hacía lo que decía:

- `distribution/product-delta.json` podaba **14 claves internas** de `defaultChatAgent`
  (`documentationUrl`, `termsStatementUrl`, …) mediante `unsetNested`, pero **dejaba el
  objeto en pie** con `extensionId: GitHub.copilot`, `chatExtensionId: GitHub.copilot-chat`,
  `provider`, `providerScopes`…
- `product.json` empaquetado lo confirmaba: `typeof defaultChatAgent === "object"`.
- Con el objeto presente, `if (product.defaultChatAgent)` es **verdadero** en todos los
  sitios, el servicio de entitlement construye su contexto, `ChatSetupContribution` **no**
  se desactiva, registra el agente `chat.setup`, y el input del Chat queda tras el aviso
  «You need to set up GitHub Copilot and be signed in to use Chat.»
  (`chatSetupProviders.ts:178`, el `SETUP_NEEDED_MESSAGE` del agente `chat.setup`).

### Y un segundo fallo, independiente, en el registro de `@pi`

El `exthost.log` de la ejecución del dueño traía, además:

```text
[picode.picode-pi-chat]: Extension 'picode.picode-pi-chat' CANNOT use API proposal: defaultChatParticipant.
Error: chatParticipant must be declared in package.json: picode.pi
```

`chatParticipant.contribution.ts:248` exige la propuesta `defaultChatParticipant` para
cualquier participante con `isDefault`, y `$registerAgent`
(`mainThreadChatAgents2.ts:340`) aborta si el participante no quedó registrado. Al no
declarar la propuesta, **el `contributes.chatParticipants` entero se rechazaba**: `@pi` no
existía en ejecución, y la petición caía al `chat.setup` del core. Dos causas, un solo
síntoma.

### Arreglos

1. **`extensions/picode-pi-chat/package.json`** declara
   `enabledApiProposals: ["defaultChatParticipant"]`. Las extensiones built-in acreditan
   propuestas desde su propio manifiesto (`extensions/git/package.json` declara treinta y
tres); no hace falta entrada en `extensionEnabledApiProposals`.
2. **`distribution/product-delta.json`** pasa `defaultChatAgent` a **`null`** (falsy, no
   solo podado) y deja de declarar el `unsetNested` que ya no aplica. `null` y no ausente
   porque toda desreferencia del core usa `?.` o está guardada, y `null` satisface ambas.
3. **`patches/picode/05-remove-copilot-default-agent.patch`** guarda
   `toDefaultAccountConfig` (`defaultAccount.ts`), **el único sitio que desreferenciaba sin
   guarda**. Sus dos llamadas ocurren en constructores, durante la construcción de
   servicios: sin esta guarda, anular el objeto habría roto la ventana en lugar de
   quitarle el gate. Es exactamente el caso que `distribution/README.md` documenta
   («un objeto anidado que el editor desreferencia hay que podarlo, no quitarlo»), y por
   eso se poda aquí **con** la guarda.

### Evidencia de la fase E (ejecución real, no lectura)

Log de la ejecución del dueño (build anterior), las dos causas:

```text
[error] Extension 'picode.picode-pi-chat' CANNOT use API proposal: defaultChatParticipant.
[error] chatParticipant must be declared in package.json: picode.pi
```

Log de la ejecución con los arreglos (`data/user-data/logs/20260924T085145`), **sin ningún
error**:

```text
[info] ExtensionService#_doActivateExtension picode.picode-pi-chat, startup: false,
       activationEvent: 'onChatParticipant:picode.pi'
```

Esa línea es la prueba de que el Chat **resolvió y activó `picode.pi` como participante
por defecto**: la activación llegó por `onChatParticipant:`, no por `onView:picode.piChat`
(el panel), así que la pidió el propio Chat. Y del `product.json` empaquetado:
`defaultChatAgent → null`, falsy.

### No medido en la fase E

- **La pulsación de «hola» en CHAT no la he dado yo**: no puedo escribir en la interfaz.
  Lo verificado es que el gate ya no existe (objeto anulado + guarda) y que el Chat activa
  `@pi` como predeterminado. La respuesta del modelo a un mensaje real es el paso que queda.
- `DEP0190` (`shell: true` al lanzar un hijo) aparece en el log justo tras activarse la
extensión: es nuestro `spawnTarget`, inocuo, pero queda anotado.

## Fase F — «No default agent for location panel»

### F1 · Dónde se decide el agente por defecto

El aviso sale de `chatServiceImpl.ts:1240`, dentro de `sendRequest`:

```ts
const defaultAgent = this.chatAgentService.getDefaultAgent(location, options?.modeInfo?.kind);
if (!defaultAgent) {
    this.logService.warn('sendRequest', `No default agent for location ${location}`);
    return { kind: 'rejected', reason: 'No default agent available' };
}
```

Y el filtro (`chatAgents.ts:454`) es:

```ts
getDefaultAgent(location, mode: ChatModeKind = ChatModeKind.Ask) {
    return this._preferExtensionAgent(this.getActivatedAgents().filter(a =>
        (!mode || a.modes.includes(mode)) && !!a.isDefault && a.locations.includes(location)));
}
```

`ChatAgentLocation.Chat = 'panel'`. Filtra por **tres** cosas: `isDefault`, `locations` y **`modes`**.

### F2 · `locations` no era el problema (y declararlo lo empeoraría)

`chatParticipant.contribution.ts:293-299` deriva los valores ausentes:

```ts
locations: isNonEmptyArray(providerDescriptor.locations)
    ? providerDescriptor.locations.map(ChatAgentLocation.fromRaw)
    : [ChatAgentLocation.Chat],                       // ← panel, por defecto
modes: providerDescriptor.isDefault
    ? (providerDescriptor.modes ?? [ChatModeKind.Ask]) // ← solo Ask, por defecto
    : [ChatModeKind.Agent, ChatModeKind.Ask, ChatModeKind.Edit],
```

Sin `locations`, el core ya pone `panel`. **Y declararlo explícitamente habría roto el
registro**, porque `chatParticipant.contribution.ts:253` exige la propuesta
`chatParticipantAdditions` en cuanto `locations` aparece, con `continue` si falta. La
hipótesis de F2 (falta `locations`) era exactamente al revés.

En cambio, un participante `isDefault` **sin `modes` queda solo con `Ask`**. Eso es lo que
no cubría la vista CHAT.

### F0 · La ausencia de modelo no era la causa

`no-model-at-toolbar-build` se emite en `chatInputPart.ts:3413`, al construir el widget del
selector de modelos, con severidad **`'info'`**, e inmediatamente después llama a
`setCurrentLanguageModelToDefault()`. Nunca participa en `getDefaultAgent`, que solo mira
`isDefault`, `locations` y `modes`. Un Chat Participant **no necesita ningún Language Model
registrado** para responder: dibuja su propia respuesta con `stream`.

Por eso **no se registra pi como Language Model provider**: sería la API ligada al plan de
Copilot, duplicaría la elección de modelo que pi ya hace, y no desbloquearía nada que el
modo no bloqueara ya.

### La causa, medida

- El estado persistido del panel (`data/user-data/User/workspaceStorage/*/state.vscdb`)
  contiene `"kind":"agent"` **3 veces**: el panel estaba en modo **Agent**.
- `chat.agent.enabled` es `true` por defecto (`chat.shared.contribution.ts:1456-1459`) y el
  dueño no lo anula.
- Nuestro participante había quedado con `modes: [Ask]` (no declarado → por defecto).
- Prueba por contradicción, sin necesidad del estado: **si el modo hubiera sido `ask`, el
  agente `[Ask]` se habría encontrado y no habría aviso**. El aviso es prueba de que el modo
  no era `ask`.

### F3 · Arreglo

`extensions/picode-pi-chat/package.json` declara `modes: ["ask", "agent", "edit"]`. Los tres
valores son los del enum `ChatModeKind` (`'ask' | 'agent' | 'edit'`, `constants.ts:134`). El
handler del participante ignora el modo: atiende cualquier modo igual. No se declara
`locations` (ver F2).

### F5 · El aviso del iframe

`allow-same-origin` + `allow-scripts` aparecen en **core**: `webviewElement.ts:421`,
`pre/index.html:1024` y `webWorkerExtensionHost.ts:149`. Es comportamiento preexistente del
editor, **no** algo introducido por los parches de PiCode.

### Hallazgo colateral: PiCode se apagaba el chat a sí mismo

`distribution/settings.json` (los valores por defecto que se escriben en el perfil)
trae `"chat.disableAIFeatures": true`, descrito en el propio core como «Disable and hide
built-in AI features provided by GitHub Copilot, **including chat**». Es un resto del plan
antiguo, en el que el chat lo ponía el panel propio.

Hoy la vista de Chat sigue apareciendo porque su `when`
(`chatParticipant.contribution.ts:70-81`) incluye
`ChatContextKeys.panelParticipantRegistered`, que nuestro `@pi` marcó al registrarse como
`isDefault`. Es decir: **el chat sobrevive a pesar de ese ajuste, no gracias a él**, y la
dependencia no está declarada en ningún sitio. No se cambia en esta fase —quitarlo
reabriría rutas de UI de Copilot y es una decisión de producto— pero queda escrito como el
riesgo que es.

### Evidencia de la fase F

- Build `./dev/build.sh -s` → `BUILD_EXIT=0`; `compile-src … with 0 errors`.
- Manifiesto empaquetado: `"modes": ["ask","agent","edit"]` junto a `isDefault: true`.
- Ejecución real (`data/user-data/logs/20260924T091137`): `exthost.log` **sin errores** y
  `_doActivateExtension picode.picode-pi-chat, activationEvent: 'onChatParticipant:picode.pi'`.
  Desaparecidos el error de propuesta y el de «must be declared».

### No medido en la fase F

- **La pulsación de «hola» sigue sin darla yo**: no puedo escribir en la interfaz. Lo
  verificado es que el modo del panel es `agent`, que el agente ya incluye `agent`, y que el
  registro y la activación son correctos. El envío y la respuesta visible son el paso que
  queda, y con él también la primera prueba real de `chat-turn.ts` en un turno completo
  (avisar si aparecen más problemas ahí, como pide el brief).

## Out of scope

- El picker de modelos nativo (API gated por plan de Copilot).
- La disolución del panel en Settings (Bloque C).
- CI de release a partir del pipeline de patches.
