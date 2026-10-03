# Gentle AI dentro del chat de PiCode

Qué trae `gentle-pi` al pi interno y qué tiene que ofrecerle el host para que sus preguntas y
herramientas funcionen **en el chat** en vez de bloquearse.

## Lo que instala `gentle-pi` 4.0.0

El paquete declara 18 extensiones. Las que importan al host:

| Extensión | Hooks que registra | Lo que necesita del host |
| --- | --- | --- |
| `gentle-ai` | `session_start`, `agent_start/end`, `tool_call`, `tool_result`, `tool_execution_start/end`, `turn_end`, `session_tree`, `session_shutdown`, `before_agent_start` | `ctx.ui.confirm/select/input/notify`, `ctx.ui.custom`, `ctx.ui.setWidget/setFooter`, `ctx.sessionManager`, `ctx.modelRegistry` |
| `gentle-shell` | `session_start`, `agent_start/end/settled`, `tool_execution_start`, `session_tree`, `after_provider_response`, `session_shutdown` | `ctx.ui.setFooter/setWidget/theme/getTheme/getAllThemes/setTheme/setWorkingVisible`, `ctx.ui.select`, `ctx.ui.custom`, `ctx.hasUI` |
| `gentle-agents` | `session_start`, `agent_start/end/settled`, `tool_call`, `turn_end`, `before_agent_start`, `session_compact(_failed)`, `session_shutdown` | `ctx.ui.notify/confirm/select/setWidget/custom`, `ctx.hasUI` |
| `ask-user-question` | tool `ask_user_question` (1–4 preguntas) | `ctx.ui.custom` (TUI) o `ctx.ui.select/input` (RPC interactivo) |
| `ask-user-choice` | tool `ask_user_choice` | igual |
| `child-safety` | `tool_call` | bloquea comandos destructivos en hijos (`GENTLE_PI_AGENTS_CHILD=1`) |
| `quiet-tools`, `gentle-todo`, `codegraph-tools`, `skill-registry`, `runtime-metrics`, `gentle-stats`, `resume-hint`, `startup-banner`, `pi-pretty`, `child-context`, `nan-provider` | varios | en su mayoría tools/hook internos; `notify` y `select` sueltos |

## El contrato que gentle espera del host

`lib/rpc-host.ts` lo dice sin ambigüedad:

```ts
isInteractiveRpcHost(mode, env) = mode === "rpc" && env.GENTLE_SHELL_INTERACTIVE_HOST === "1"
isInteractiveMode(mode, env)    = mode === "tui" || isInteractiveRpcHost(mode, env)
```

- **`mode === "rpc"`** → `ctx.ui.custom` (componentes de terminal) no se usa; `ctx.ui.select`,
  `ctx.ui.input` y `ctx.ui.confirm` sí (los diálogos del host).
- **`GENTLE_SHELL_INTERACTIVE_HOST=1`** → el host declara que esos diálogos son respondibles.
- Sin lo segundo, `confirmCommand` (el guard de comandos destructivos) ve `ctx.hasUI === false` y
  responde `{ block: true, reason: "…requires interactive confirmation…" }`; el modelo solo puede
  contarlo. Con lo segundo, muestra la pregunta.

`ask_user_question` toma la misma decisión: en RPC interactivo responde preguntas con `select`/
`input`; si no, devuelve "unavailable outside the interactive TUI".

## Lo que PiCode hacía y lo que hace ahora

**Antes**: `bindSessionExtensions` llamaba a `session.bindExtensions({ onError })` — sin `uiContext`
y con el `mode` por defecto (`"print"`). Por eso:

- `ctx.hasUI` era `false` → gentle bloqueaba en vez de preguntar.
- `ask_user_question` / `ask_user_choice` devolvían "unavailable".
- `gentle-shell`/`gentle-agents` no pintaban nada interactivo.

**Ahora** (`extensions/picode/src/agent.ts`):

- Se pasa `uiContext` (el nuevo `extensionUiContext`) y `mode: "rpc"` a `bindExtensions`.
- El `uiContext` traduce:
  - `confirm(title, message)` → una pregunta SingleSelect `Allow`/`Deny` en el carrusel del chat;
    resuelve `true` solo con `Allow`.
  - `select(title, opciones)` → SingleSelect con las opciones; devuelve la etiqueta elegida.
  - `input(title, placeholder)` → pregunta Text; devuelve el texto.
  - `notify(message, type)` → una línea en el chat (`ℹ️`/`⚠️`/`❌`).
  - Todo lo de terminal (`custom`, `setWidget`, `setFooter`, `setHeader`, `setStatus`,
    `setWorking*`, `theme`, …) es inerte o devuelve `undefined`, igual que el modo RPC de pi.
- Se marca el proceso con `GENTLE_SHELL_INTERACTIVE_HOST=1` en cuanto la sesión enlaza sus
  extensiones (el contrato de `lib/rpc-host.ts`).

Las preguntas salen en el mismo sitio donde se responde: el carrusel de preguntas del chat
(`ChatResponseStream.questionCarousel`), que es el mismo que usa la puerta de permisos de PiCode.

## Lo que queda fuera (y por qué)

- **`ctx.ui.custom`** (paneles a pantalla completa de gentle: palette de comandos, selector de
  modelo SDD, perfiles). El chat no puede pintar un componente de terminal; resuelve `undefined`
  como el propio RPC de pi, y los llamantes lo tratan como "no eligió nada". Los que no lo traten
  así se reportan por `onError` y no tumban el turno.
- **`commandContextActions`** (`newSession`, `fork`, `switchSession`, `reload`, `navigateTree`).
  No se pasan: pi usa sus valores por defecto (`{ cancelled: false }`). Hacerlos reales exige que
  PiCode gestione sesiones/fork, que es otro trabajo.
- **`theme`/`getAllThemes`/`setTheme`**: inertes; el tema lo lleva el editor.
- **Doble confirmación**: PiCode ya pide `Allow` para todo `bash` mutante (su propia puerta de
  permisos) y gentle vuelve a pedirlo para los destructivos. Son dos preguntas para el mismo
  comando. Decidir si se unifican es una decisión de producto pendiente.

## Verificación

- `tsc -p extensions/picode/tsconfig.json --noEmit` y el typecheck de tests, en verde.
- La ruta de preguntas es la misma que ya usaba `permissionExtension` (`questionCarousel`), y la
  forma del `uiContext` copia la de `pi` en `dist/modes/rpc/rpc-mode.js`, que es el host
  interactivo que gentle documenta.
