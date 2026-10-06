# Feature: los MCP, «siempre on demand»

**Estado:** cerrada · **Rama:** `experimental` · **Abierta:** 2026-10-07

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

## Lo que se midió **después**, y cambia la respuesta (2026-10-07)

Antes de elegir entre A y B se midió lo que decidía: **¿enumerar las herramientas del editor arranca
los servidores?** No. El editor guarda las herramientas de cada servidor en una caché persistida
(`McpServerMetadataCache`, clave `mcpToolCache` — el `mcp-cache.json` de 1,1 MB) y las sirve
**mientras el servidor no está en marcha**:

```ts
// mcpServer.ts — el valor que el editor entrega al modelo
const serverTools = this.fromServer.read(reader);
const definitions = serverTools?.data ?? this._fromStaticDefinition?.read(reader) ?? this.fromCache?.data ?? this.defaultValue;
```

y `McpServerMetadataCache.get()` está documentado como *«used before a server is running»*. Es decir:
la lista de herramientas **no** obliga a arrancar nada.

Entonces, ¿quién arrancó los 11 servidores a las 00:34:49.69x, todos en 3 milisegundos? El **autostart
del editor**, que tiene ajuste propio:

```ts
// mcpService.ts
export const mcpAutoStartConfig = 'chat.mcp.autostart';   // never | onlyNew | newAndOutdated (por defecto)

public autostart(): IObservable<IAutostartResult> {
    const autoStartConfig = this.configurationService.getValue(mcpAutoStartConfig);
    if (autoStartConfig === McpAutoStartValue.Never) {
        return observableValue(this, IAutostartResult.Empty);   // no arranca nada
    }
    …
```

Y el propio editor lo describe en su interfaz con esa frase exacta: *«Automatically start MCP servers
when sending a chat message»*, con su casilla en la vista de MCP.

**Esto es «on demand», tal cual:** al enviar un mensaje no arranca nada, y un servidor arranca cuando
se **invoca** una de sus herramientas.

## Aplicado

1. `distribution/settings.json` → `"chat.mcp.autostart": "never"`. El `settings.json` de fábrica es el
   que el empaquetado copia al perfil, así que **una instalación nueva nace con los MCP a demanda**.
2. El perfil en uso del dueño (`data/user-data/User/settings.json`) → el mismo ajuste, para que tenga
   efecto **ya**, sin esperar a un build. Es reversible desde la casilla de MCP del editor.

## Lo que queda (la segunda mitad)

**Cerrado por decisión del dueño, el 2026-10-07:**

> «claro pi ha de activarlos, eso no pasa nada, pero el editor solo los ha de usar cuando lo necesita,
> no es normal que hablo y empieza a revisarlos.»

Es decir: **pi activa los servidores del perfil cuando crea la sesión y eso se queda** — es su trabajo,
no el ruido que molestaba. Lo que no puede pasar es lo que hacía el **editor**: revisarlos al enviar un
mensaje. Y eso es exactamente lo que apaga `chat.mcp.autostart: never`.

Por eso **no** se toca `builtin:mcp`: quitarlo era la única forma de dejar la sesión sin ningún arranque
inicial, y con esto el dueño ha dicho que ese arranque no le molesta. De paso desaparece el riesgo que
tenía apuntado (pi es quien tiene el login OAuth de MCP que arregló 1.0.4).

Los **duplicados** que se midieron (tres `@aikidosec/mcp`, dos `@supabase/mcp-server-supabase`) son la
suma de los dos caminos, y se quedan como están: cada uno arranca por su motivo y los dos leen el mismo
`mcp.json`. Si algún día molestan, la vía barata es apagar en `/mcp` los servidores que no haga falta
tener encendidos, no quitarle el MCP a pi.

### El arranque del editor, medido y apagado

El disparador estaba en el chat, no en el conector:

```ts
// chatServiceImpl.ts:1748 — al enviar un mensaje
const autostartResult = new ChatMcpServersStarting(this.mcpService.autostart(token));
```

y `autostart()` devuelve vacío con `never` (ver arriba). Ahí está «hablo y empieza a revisarlos»,
literal: era el chat el que revisaba los servidores al enviar. Apagado, esa rama no arranca nada y el
editor solo usa un servidor cuando **invoca** una de sus herramientas.
