# Feature: el agente durable a la familia `@earendil-works` 1.2.0

**Estado:** cerrada · **Rama:** `experimental` · **Abierta:** 2026-10-13

## Intención del dueño

> «revisa si hay actualizaciones de pi durable»

El agente durable (`picode-source/durable`) no usa `@earendil-works/pi-coding-agent`: se apoya en
su propia familia de paquetes, `@earendil-works/pi-durable`, `pi-ai`, `pi-mcp` y `chord`. La
pregunta es si esa familia tiene versiones nuevas y, en su caso, si subirlas obliga a tocar el
daemon. Lo es y obliga: se sube y se aplica la única ruptura que le llega.

El árbol declaraba `pi-durable`/`pi-ai`/`chord` `^1.0.2` y `pi-mcp` `1.0.2`; el registro publica
**1.2.0** en las cinco (incluido `pi-codemode`, dependencia transitiva nueva de `pi-durable` 1.2.0).
El escalón es **1.0.2 → 1.2.0** (con 1.0.3, 1.0.4 y 1.1.0 en medio).

## Lo que se midió antes de tocar nada (2026-10-13)

Medido contra los paquetes reales instalados con npm y contra su `CHANGELOG.md`.

| Dato | Valor |
| --- | --- |
| Última publicada (familia) | **1.2.0** (`pi-durable`, `pi-ai`, `pi-mcp`, `chord`, `pi-codemode`, `pi-telemetry`) |
| Declarado en el árbol | `^1.0.2` / `pi-mcp` `1.0.2` |
| Raíz de los paquetes | el mismo monorepo que pi (`github.com/earendil-works/pi`, `packages/durable`) |
| `pi-durable` 1.2.0 depende de | `chord ^1.2.0`, `pi-ai ^1.2.0`, `pi-codemode ^1.2.0` |
| `pi-mcp` 1.2.0 | sin cambios de dependencias (`cross-spawn`) |
| El daemon usa de `pi-durable` | `Harness`, `createRegistry`, `AgentDoc`, `watchEvents`, `defineExtension/defineTool/defineTask`, `configure`, `defineDoc`, `hook`, `section`, `ToolTask`, `CodingTools`, `NodeExecutionEnv`, `openNodeSqliteStorage` — **todos presentes en 1.2.0** |
| El daemon usa de `chord` | solo `BACKGROUND_CONTEXT` de `chord/context` — **idéntico en 1.2.0** |
| El daemon usa de `pi-mcp` | `McpClient`, `StdioTransport`, `StreamableHttpTransport`, `McpOAuthProvider` — presentes |
| El daemon usa de `pi-ai` | `createModels`, `createProvider`, `Type`, `openAIResponsesApi` (`/api/openai-responses.lazy`) — presentes |
| El árbol instala | `npm install` en `picode-source/durable` → **exit 0**, resuelto a 1.2.0 |

## El changelog de la familia, punto por punto

### La ruptura que sí llega: `content` pasa a `output`

En `pi-durable` 1.2.0, `ToolExecutionResult.content` se llama ahora **`output`**, junto al nuevo
`structuredOutput`. El `content` viejo **se ignora** (medido en el runtime: `dist/harness/tool.js`
lee `result.output` y, si falta, usa el texto retenido por `api.output()`, que en estas herramientas
está vacío). Sin cambiarlo, cada herramienta del daemon le devolvería al modelo un resultado vacío.

Aplicado en las **8** devoluciones de herramientas del daemon:

| Fichero | Qué herramienta | Sitios |
| --- | --- | --- |
| `lib/extensions.js` | `subagent` (ya en marcha / recién creado) | 2 |
| `lib/skills.js` | `load_skill` (encontrado / desconocido) | 2 |
| `lib/mcp.js` | puente MCP (éxito, error, discovery sin coincidencias y con coincidencias) | 4 |

### Las demás rupturas, y por qué no llegan

* **`ToolTaskInput`/`ToolTaskResult` pasan a uniones etiquetadas** (`{ kind: "model" | "nested" }`) y
  `pi.tool` sube a versión 2 (migra las tareas vivas de la versión 1). El daemon **no construye ni
  lee** esos tipos; el hook del guard recibe `ToolHookCall` (`ToolCall & { parent? }`), que conserva
  `name` y `arguments`, y devuelve `{ block }`, que sigue siendo la forma del resultado del hook.
* **`content` → `output`** ya tratada arriba; `structuredOutput` no se usa.
* **`bash`/`powershell` responden a un exit distinto de cero con un error** (`exit_code` como
  diagnóstico) en vez de lanzar. El daemon no define esas herramientas (las pone `CodingTools`), y
  su guard mira la **llamada** antes de ejecutar, no el resultado.
* **Cualquier error de un `Storage` falla la sesión**; `StorageRejected` desaparece y nace
  `StorageRequestError`. El daemon no implementa su propio `Storage` (usa `openNodeSqliteStorage`)
  ni menciona `StorageRejected`.
* **`subscribeCommits()`/`subscribeClose()`** que lanzan se reportan por `onReport`. El daemon no
  registra esos suscriptores; el `onReport` que pasa al harness sigue siendo válido.
* **`chord` 1.2.0 reescribe su runtime entero** (fuera el runtime de facetas/servicios, fuera
  `defineService`/`createFacetHost`/…, fuera los paquetes `pi-client`/`pi-protocol`/`pi-server`,
  y pasa de `esbuild` a `typebox`). El daemon **solo importa `BACKGROUND_CONTEXT` de
  `chord/context`**, que el propio changelog declara sin cambios, y `pi-durable` 1.2.0 declara
  `chord ^1.2.0`, así que npm deduplica a **una sola copia** —la identidad del contexto no se parte—
  y la prueba de arranque lo confirma.
* **`pi-mcp` 1.2.0** cambia el tipo de `CallToolResult.structuredContent` de `Record<string, unknown>`
  a `unknown` y añade un `signal` opcional a `McpTransport.send()`. El daemon **serializa**
  `structuredContent` tal cual (`JSON.stringify`, válido para cualquier valor JSON) y usa los
  transports de la librería, no un `send()` propio.
* **`InputEntry` / `entry: { kind, data }`** en las sumisiones, y **`order`** en las consultas de
  almacenamiento (1.1.0), y **`TaskRuntime.context(id, context, { at })`** (1.1.0): el daemon sigue
  enviando `{ type: "input", content }` (la forma base sigue existiendo), no pide `order` y llama a
  `runtime.context(childId, context)` sin el `at` opcional.
* **`configure`/`harness.*`/`conversation.*`**: `root`, `conversation`, `createConversation`,
  `taskGraph`, `close`, `readOnLine`, `snapshot`, `configure`, `submit`, `entries`, `fork`, `abort`,
  `viewState` — todas con la misma firma en 1.2.0.

### Lo que se gana

Arreglos de las cinco releases intermedias, todos dentro de la familia: una **compactación
bloqueante que fallaba** ya no deja pasar la petición sin resumen (el turno falla con `model_error`
en vez de contestar vacío por falta de contexto); el **scheduler deja de recorrer cada tarea viva**
en cada pasada (una cadena de 500 pasos tarda 50 ms en vez de 12 s, 20 000 en 1,5 s) y acota sus
índices de propiedad a lo vivo (dejaba 10 000 tareas terminadas tras 10 000 subagentes); la **caché
de documentos** de la sesión se acota por uso (retenía todas las conversaciones y documentos vistos
durante la vida del proceso); añadir a un array deja de costar un recorrido entero (32 000 inserciones
en 1,4 s en vez de 11,3 s); el `read` devuelve **imágenes** y lee ficheros que crecen durante la
lectura; los primeros system messages encabezan el contexto (conserva la prompt cache de Anthropic);
y las consultas de almacenamiento respetan el `order` que pide quien pagina.

## Decisión

**Subir la familia a 1.2.0 y aplicar la única ruptura que llega.** El pin se mueve en un solo sitio,
`picode-source/durable/package.json`, y su `package-lock.json` se regenera con `npm install` (el
build instala desde ese lockfile cuando le faltan las dependencias). La edición de código es de una
palabra por devolución (`content` → `output`), en tres ficheros. No hay decisión de producto
pendiente: es mantenerse al día dentro de la misma librería que el daemon ya usa.

`@earendil-works/pi-mcp` se fija **exacto** (`1.2.0`), como estaba (`1.0.2`): es la frontera del
puente MCP y se prefiere un pin reproducible; los demás van con `^1.2.0` como ya iban con `^1.0.2`.

## Verificación

| Qué | Cómo se comprobó |
| --- | --- |
| El árbol instala | `npm install` en `picode-source/durable` → **exit 0**; `pi-durable`/`pi-ai`/`pi-mcp`/`chord`/`pi-codemode` a **1.2.0** |
| El grafo de módulos carga y el harness arranca | import de `common.js`/`guard.js`/`skills.js`/`extensions.js` y `openHarness` sobre SQLite → **OPEN OK**, 7 herramientas (`read, write, edit, bash, slow_step, subagent, load_skill`), conversación creada, `taskGraph` leído, **CLOSE OK** |
| La clave nueva es la que se consume | `pi-durable@1.2.0/dist/harness/tool.js` lee `result.output` (y usa el texto de `api.output()` cuando falta) — por eso el `content` viejo daba un resultado vacío |
| Una sola copia de `chord` | `pi-durable` 1.2.0 pide `chord ^1.2.0` y el daemon también → npm deduplica; la prueba de arranque ejercita el runtime nuevo |
| Lo que el daemon importa de la familia sigue existiendo | `grep` de cada símbolo en los `dist/*.d.ts` de 1.2.0 |

**Lo que no se pudo verificar aquí:** los `proof*.js` y `smoke.js` hacen llamadas reales al
proveedor (OmniRoute) y no se ejecutan en esta sesión. La prueba hecha cubre carga de módulos,
construcción del harness, registro de extensiones, almacenamiento y ciclo de conversación; el
comportamiento con modelo (subagente en fondo, dos clientes) queda para una corrida del dueño.

## Referencias

* `distribution/runtime.json` — el **pi del editor** (`pi-coding-agent`), que es otra familia y se
  subió a 1.2.0 en `odd/tasks/picode-pi-120.md`. Este trabajo no lo toca.
* `picode-source/durable/README.md` — menciones de versión actualizadas.
