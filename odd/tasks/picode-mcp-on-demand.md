# Feature: los MCP, «siempre on demand»

**Estado:** abierta · **Rama:** `experimental` · **Abierta:** 2026-10-07

## Intención del dueño

> «Al hablar con picode en una sesión nueva intenta arrancar los mcp el chat, esto quitalo, los MCP
> deben ser siempre "on demand".»

Los servidores MCP no deben arrancar porque él hable: deben arrancar cuando haga falta uno.

## Lo que se midió antes de tocar nada (2026-10-07, pi 1.0.4)

### 1. pi conecta **todos** los servidores activos al crear la sesión

En `dist/extensions/mcp/index.js`, el manejador de `session_start` hace, literalmente:

```js
const enabled = servers.filter(isEnabled);
if (enabled.length === 0) { reportProblems(ctx); return; }
const runtime = new Promise((resolve) => setImmediate(resolve)).then(() => loadMcpRuntime());
pending = Promise.all(enabled.map((server) => startConnection(server, isCurrent, runtime)))
```

La exposición (`exposure`) decide **cómo llegan las herramientas al modelo**, no si el servidor se
conecta:

| Exposición | Qué hace |
| --- | --- |
| `codemode` (por defecto) | Llamable desde scripts de codemode; no se declara al modelo |
| `deferred` | No se declara hasta que `tool_search` encuentra algo |
| `direct` | Declarada al modelo como una herramienta propia |
| `hidden` | Registrada pero inalcanzable |

Lo único que cambia con la exposición es **a quién espera el primer prompt** (`waitForDirectServers`):
el prompt solo aguanta a los servidores con herramientas `direct`. Los demás se conectan igual, en
segundo plano.

### 2. pi **no tiene** opción para no conectarlos

Las claves que acepta un servidor (`dist/core/mcp-servers.ts`, `extensions/mcp/config.ts`) son:
`command`, `args`, `env`, `url`, `type`, `headers`, `auth`, `enabled`, `exposure`, `toolExposure`,
`description`. No hay ninguna de conexión perezosa. Lo que existe fuera del fichero es un ajuste por
sesión (`/mcp` cambia `enabled`/`exposure`, `--no-mcp` lo apaga del todo para una ejecución), y
`autoEnableCodemode` — que es sobre activar codemode, no sobre conectar.

**Conclusión medida: con el conector MCP de pi cargado, no hay configuración que lo haga on demand.**

### 3. Y hay **dos** caminos que arrancan los mismos servidores

| Camino | Quién conecta | Cuándo |
| --- | --- | --- |
| **El de pi** (`builtin:mcp`) | pi | Al crear la sesión (`session_start`) |
| **El del editor** (`mcp-provider.ts` + `mcp.ts`) | El editor, y pi llama por `lm.invokeTool` | Cuando el chat pide su lista de herramientas |

Los dos leen **el mismo** `<perfil>/mcp.json`. Medido en la sesión del 00:29:47 del perfil del dueño:
el editor arrancó **11 servidores** (`mcpServer.picode.picode<nombre>.log`), y el primero arrancó a las
**00:34:49** («Starting server codegraph» … «Discovered 1 tools»), es decir **cinco minutos después de
abrir**, al hablar por primera vez — exactamente lo que el dueño describe.

El propio código ya lo tenía anotado como defecto conocido: *«a server declared both in the profile and
bridged from the editor would run twice — the pre-0992 overlap — and is the owner's to reconcile in the
profile, not something this editor decides»*. El dueño acaba de decidir.

## Las tres salidas, con su coste

### A. Un solo dueño (barato, pero **no** es on demand)

Quitar el MCP de pi de la sesión del chat (dejar de cargar `builtin:mcp`) y quedarse con el camino del
editor, que es el que el dueño pidió («las opciones de MCP del editor para el pi interno»). Quita el
arranque en `session_start` y el doble arranque; **el editor sigue arrancando sus servidores cuando el
chat pide las herramientas**, así que sigue habiendo arranque «al hablar».

*Coste:* bajo. *Riesgo:* medio — pi es hoy quien tiene el login OAuth de MCP que arregló 1.0.4, así que
quitar su camino puede llevarse por delante el que funciona. Habría que comprobarlo con `sentry`/`vercel`.

### B. Puente perezoso (caro, y **sí** es on demand)

El editor deja de enumerar sus herramientas MCP al construir la sesión (esa enumeración es lo que
obliga al editor a arrancar los servidores) y se le da a pi **una** herramienta propia que resuelve en
el momento de la llamada: el modelo busca (o nombra) y `lm.invokeTool` arranca **solo el servidor de esa
herramienta**. Es el mismo reparto que ya usa `codemode`/`tool_search` para diferir declaraciones.

*Coste:* medio-alto (herramienta nueva, búsqueda, errores). *Riesgo:* medio — hay que comprobar si el
editor sirve la lista de herramientas de su caché (`mcp-cache.json`, 1,1 MB) sin arrancar los servidores;
si no la sirve, la búsqueda los arranca igual y B se queda en A con más código.

### C. Esperar a que pi lo ofrezca

Es una limitación de pi, no nuestra: `session_start` conecta todo lo activo. Un `--no-mcp` ya existe
para la CLI; lo que falta es un «conectar cuando haga falta» en el conector. Se puede pedir upstream y
mientras tanto quedarse como está.

## Recomendación

**B**, y antes de escribirla, una medición de una línea de tiempo: ver si la lista de herramientas del
editor sale de su caché sin arrancar servidores. Eso decide si B es on demand de verdad o solo A
disfrazada — y es exactamente el dato que no se puede suponer. Si sale que la enumeración arranca, la
respuesta honesta es **C** (pedirlo upstream) más **A** como mitigación consciente, aceptando que el
arranque sigue ocurriendo al primer mensaje.

**Lo que NO se ha hecho, y por qué:** ningún cambio de MCP en esta sesión. Las dos direcciones (quitar
el MCP de pi o quitar el puente del editor) tocan la única vía por la que el dueño tiene MCP funcionando
hoy, y elegir a ciegas a la 01:00 cuesta un rebuild y, si sale mal, sus servidores.
