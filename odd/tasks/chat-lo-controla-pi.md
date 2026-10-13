# El chat lo controla pi; durable es el backend (inversión del ADR-018)

> «Mira ves? Esto pasa pq hablas directamente con durable. A ver, la idea es que durable sea el
> backend, el que controla sesiones y memoria. Pero el chat, el chat realmente lo controla pi.
> Pi tiene el modelo, agente, etc y es el que lanza las tools de durable de sesiones, de mcps,
> etc.» — dueño, 2026-10-11

## El síntoma y su causa

Al enviar «Hola» en el chat, la respuesta fue:

```text
No activated agent with id "durable"
```

No era un handler que faltaba por despiste: era estructural.

- El panel **CHAT** ejecuta **agentes** (`chatAgentService.invokeAgent(agent.id)`).
- Una contribución `chatSessions` es un **proveedor de sesiones**: registra *datos* de agente
  (`chatSessions.contribution.ts` → `_registerAgent`) **sin implementación**, porque la
  implementación de un tipo de sesión la pone un agent-host o un *chat participant*.
- Durable no tiene ninguna de las dos: su proveedor de contenido expone un `requestHandler`, y
  **nada en el camino de envío del panel CHAT convierte un proveedor de contenido en una
  implementación de agente** (no hay un solo lector de `IChatSession.requestHandler` en
  `contrib/chat` fuera de su declaración).
- Como el ADR-018 puso durable por defecto y retiró Local, el chip seleccionaba `durable`, el
  envío se convertía en `@durable` y `invokeAgent('durable')` moría.

En una frase: **hablar con durable directamente no puede funcionar en el panel CHAT**, y eso es
exactamente lo que hacía el ADR-018.

## Lo que se ha hecho

1. **El chat vuelve a ser pi.** Se revierten los cambios de núcleo del ADR-018
   (`constants.ts`: `getComputedDefaultSessionType`, `getDefaultNewChatSessionType`,
   `resolveDefaultNewChatSessionType`, `isNewChatSessionTypeUsable`,
   `isVisibleEditorChatSessionType`; y el salto de Local vacío a durable en `chatViewPane.ts`).
   El harness por defecto es el de pi y el agente es `@pi` (`agent.ts`), que sí tiene
   implementación, modelo y tools.
2. **Durable deja de ser harness.** La contribución `chatSessions` de `picode` se queda
   declarada pero **deshabilitada** (`"when": "false"`, `canDelegate: false`). No se borra
   porque es la declaración del tipo; se apaga porque estar disponible es lo que producía el
   error.
3. **Durable sigue de backend.** El puente `picode-source/durable-bridge` ya da a pi
   `durable_send` / `durable_list` / `durable_read`; MCP sigue siendo de pi. Pi lanza ahí lo que
   necesite (tareas, sesiones, memoria) sin que el panel tenga que hablar con el daemon.
4. **El contexto del editor sigue viajando** (ADR-019): el turno de pi lleva fichero, selección,
   problemas y adjuntos.

## Decisión registrada

`docs/DECISIONS.md` → **ADR-020** (sustituye a ADR-018). `docs/ARCHITECTURE.md` → capa 3
reescrita: el chat lo corre pi en proceso; durable es el backend por tools; la contribución
deshabilitada y por qué.

## Qué NO se ha hecho (a propósito)

- **No se ha borrado durable.** El daemon, sus conversaciones y el puente siguen ahí.
- **No se ha dado a `durable` una implementación de agente.** Eso permitiría abrir y continuar
  conversaciones durables en el panel con pi ejecutando el turno y escribiendo en durable: es un
  proyecto, no un flag, y es el paso siguiente si el dueño quiere que las conversaciones vivan
  en durable.

## Verificado

- `tsc -p tsconfig.json --noEmit` y `tsc -p tsconfig.test.json` → 0 errores.
- Suite completa del conector en verde.
- `package.json` del conector válido tras el `when`.
- Build del pack experimental.

## No medido

- **No he enviado un mensaje en la interfaz**: la prueba real (abrir el chat, escribir y ver que
  responde pi, y pedirle algo que delegue en durable) es del dueño.

---

## Coda: cómo trabaja el chat del editor con pi y pi durable (revisión 2026-10-12)

> «Todavía creo que no nos queda claro cómo el chat trabaja con pi y pi durable. Revisa todo esto
> bien, revisa cómo debería ir todo.»

### Los tres caminos del panel CHAT, verificados en el código

**1. PiCode (tipo `durable`) — el camino bueno, el que se abre por defecto.**
El turno se envía al **agente durable** (el daemon, `durable/lib/daemon.js`), que mantiene la
conversación **fuera de la ventana**: sobrevive cerrar la pestaña y recargar. El daemon corre pi con
el perfil interno (modelo configurado, guard, skills, MCP, paquetes del perfil y — desde hoy — su
propia herramienta `subagent`). El contexto del editor viaja con cada turno (`withContext`: carpeta,
fichero abierto, selección, problemas, adjuntos). El registro en el core es `constants.ts`
(`getComputedDefaultSessionType`: si la contribución durable está, ES el defecto en cualquier
ventana) y el puente es `durable-sessions-register.ts` (`runDurableTurn` → submit al daemon →
eventos → stream del chat).

**2. Local (tipo `local`) — el motor viejo, retirado del selector.**
pi corre **dentro del proceso de la ventana** (agent host). La conversación vive en la memoria de la
ventana. No habla con el daemon: sus "varias cosas a la vez" son **background jobs** efímeros (la
herramienta `background`), que mueren con la ventana. Solo llega a él una sesión vieja creada antes
del cambio o una memoria de selección anterior; los chats nuevos salen en PiCode.

**3. `pi` — no es un chat: es el lector de transcríptos.**
Un proveedor **de solo lectura** (`extension.ts`, `registerChatSessionItemProvider('pi', …)`) que
lista las conversaciones que pi escribió **fuera del editor** (una importación, o una sesión del CLI
de pi). Oculto por defecto en el filtro del panel de Sessions; existe para que nada que pi grabó
quede inalcanzable.

**Los background jobs** no son un motor: son la herramienta que el modelo de CUALQUIER camino puede
usar para correr un comando mientras sigues charlando. Mueren con la ventana. Desde hoy se ven en el
bloque Tasks junto a las tasks de durable (Coda VI de `picode-panel-metricas.md`).

### Cómo debería ir — y cómo va tras los arreglos de hoy

| Pregunta | Debería | Va |
| --- | --- | --- |
| ¿Qué chat abre una ventana nueva? | PiCode (durable), siempre | ✅ defecto en cualquier ventana + arreglo de la carrera de arranque |
| ¿Dónde vive la conversación? | En el agente durable, fuera de la ventana | ✅ daemon + perfil interno |
| ¿Varias cosas a la vez? | `subagent` de durable → tasks visibles/abortables que sobreviven recargas | ✅ `SubagentExtension` registrado hoy; Tasks lista tasks **y** jobs |
| ¿El contexto del editor? | Viaja con cada turno | ✅ `withContext` en cada turno durable |
| ¿Los transcríptos de pi CLI/importados? | Alcanzables pero sin estorbar | ✅ filtro `pi`, oculto por defecto |
| ¿Local? | Herencia: solo sesiones viejas | ✅ retirado de selectores; sin migración de historial (no se puede traducir una conversación de un motor a otro) |

### Lo que queda abierto (decisión, no bug)

- **Las sesiones Local viejas siguen siendo Local.** No hay traducción de historial entre motores.
  Si molestan, el paso final es retirar Local del todo (no abrir sus sesiones), que ya se ofreció.
- **Los background jobs mueren con la ventana** — por diseño. El trabajo que deba sobrevivir es una
  task de durable; el modelo de una sesión PiCode ahora puede decidirlo solo, o se le pide expreso.
