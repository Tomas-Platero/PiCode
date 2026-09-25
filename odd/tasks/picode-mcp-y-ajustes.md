# Feature: MCP conectado al pi interno, y los ajustes de PiCode en su sitio

## Goal

Cuatro cosas que el dueño pidió mirando `Settings > Chat`:

> «Primero Chat renombralo a PiCode. Luego pi cambialo a Settings. Luego ordena las categorías.
> Ahora necesito que revises todas las opciones, sobre todo hay una que es "MCP" necesito que esas
> opciones puedan usarse para conectar los MCP con el PI interno de PiCode.»

## 1. Los nombres y el orden

En el árbol de ajustes (parche `04`):

| Antes | Ahora |
| --- | --- |
| Nodo **Chat** | Nodo **PiCode** |
| Nodo **pi** | Nodo **Settings** |

Y el orden de las categorías que cuelgan de él, medido y dejado así:

**Providers · Settings · Agent · Appearance · Sessions · Tools · MCP · Context · Inline Chat ·
Miscellaneous**

Las dos primeras son de PiCode y van delante (conectar un proveedor es lo primero que hace
cualquiera; luego cómo se comporta pi), y las del editor se quedan en el orden que ya tenían.

## 2. MCP: lo que se midió antes de tocarlo

- **pi no trae MCP, y lo dice él mismo.** Su README lista «MCP server integration» entre lo que
  *no* incluye en el núcleo, y en su filosofía: «**No MCP.** Build CLI tools with READMEs, or build
  an extension that adds MCP support.» Viene de su autor, con un artículo explicando por qué.
- **Pero pi deja añadir herramientas**: el SDK acepta `customTools` al crear la sesión, y esas
  herramientas viajan con el resto (el propio sistema de pi las anuncia en su prompt).
- **El editor sí tiene MCP**, y lo expone como herramientas de modelo: cada herramienta de un
  servidor MCP aparece en `vscode.lm.tools` con el prefijo `mcp_` (`mcpTypes.ts`: `Prefix = 'mcp_'`),
  y se invocan con `vscode.lm.invokeTool` — API **estable**, sin propuesta que habilitar.

## 3. Decisión

**El editor manda sobre los servidores; pi los usa.** Los servidores se siguen añadiendo,
autenticando y gobernando donde ya se hacía (su pantalla de MCP y su `mcp.json`), y PiCode traduce
sus herramientas a herramientas de pi que, al ejecutarse, llaman a `lm.invokeTool`. Así:

- no hay un segundo camino al mismo servidor, ni una segunda copia de sus credenciales;
- **las confirmaciones y los permisos del editor se aplican** a lo que pi hace con ellas (si el
  editor pregunta antes de llamar a una herramienta, pregunta igual cuando la llama pi);
- `chat.mcp.enabled` y `chat.mcp.access` siguen siendo los interruptores que deciden qué hay
  disponible, porque el puente solo ve lo que el editor le enseña.

Solo se toman las herramientas de **MCP** (`mcp_`): el resto de `lm.tools` es la maquinaria del
editor, y pi ya trae sus propias herramientas para leer, editar y ejecutar.

Detalle que obliga a una decisión más: pi registra las `customTools` **al crear la sesión** y no
admite añadir ninguna después. Por eso, cuando el conjunto de herramientas de MCP cambia (se añade
o se quita un servidor), **la sesión se reconstruye** — reutilizando su `SessionManager`, que es
donde vive la transcripción, para que la conversación no se pierda.

## 4. Dónde se añaden los servidores, y por qué no hay pantalla propia

El dueño preguntó si el puente usa el `mcp.json` de VS Code, y si convendría una interfaz para
crearlos a mano. Medido, la respuesta es **sí, y esa interfaz ya existe**:

- El puente **no lee `mcp.json`**. Lee la lista de herramientas que el editor tiene registradas
  (`lm.tools`), y esa lista sale de la configuración MCP del editor: su `mcp.json` de **usuario**,
  el del **proyecto** (`.vscode/mcp.json`) y lo que aporten extensiones. O sea: sí, lo que escribas
  ahí es lo que pi recibe — pero pasando por el editor, que es quien sabe de credenciales,
  confianza y permisos.
- El editor trae **pantalla de servidores MCP** (añadir a mano, catálogo, encender/apagar,
  confianza, credenciales) y el **JSON con esquema** (autocompletado y validación) para editarlo.
- Así que **no se hace una segunda pantalla de MCP**: duplicarla sería inventar un segundo camino al
  mismo `mcp.json`, y el editor ya cubre más de lo que cubriría la nuestra (credenciales, sandbox,
  galería, confianza). Lo que sí faltaba era **llegar desde donde él mira**.

Añadido por eso: una fila en `Settings > PiCode > MCP` — **«Give pi the tools of your MCP servers»**,
encendida por defecto — que es un interruptor de verdad (apagada, pi no recibe ninguna herramienta
de MCP) y cuya descripción lleva los tres accesos: añadir uno, verlos, y editar el `mcp.json`.

## 5. Hecho

- `mcpTools.ts` (puro, sin `vscode`): qué es una herramienta de MCP, qué esquema se le pasa a pi
  (el JSON Schema de MCP **es** lo que pi valida, así que se pasa tal cual; lo que no sea un objeto
  se vuelve permisivo en vez de impedir que la herramienta exista), qué texto se devuelve (lo que
  no es texto se escribe en JSON, nunca se pierde) y la firma que detecta un cambio de servidores.
- `mcp.ts` (con el editor): construye las definiciones de pi y ejecuta cada llamada con
  `lm.invokeTool`, con el `toolInvocationToken` del mensaje en curso (es lo que hace que la
  confirmación salga dentro del chat) y con el `AbortSignal` de pi traducido a un token del editor
  (cancelar en el chat cancela la llamada al servidor).
- `agent.ts`: las herramientas de MCP viajan en cada sesión, y la sesión se reconstruye sola cuando
  cambian los servidores.
- `picode.mcp.enabled`, en `Settings > PiCode > MCP`: el interruptor que decide si pi recibe esas
  herramientas (encendido por defecto), con los tres accesos al lado — añadir un servidor, verlos y
  editar el `mcp.json`.

## Verificación

Ejecutada, no leída. `.scratch/verificar-mcp.cjs`, trece comprobaciones contra el módulo compilado:

| Qué | Resultado |
| --- | --- |
| Una herramienta de MCP entra; una del editor no; el prefijo solo tampoco | OK |
| De un catálogo mezclado solo pasan las de MCP | OK |
| El esquema de objeto se pasa tal cual | OK |
| Un esquema que no es de objeto (o que falta) se vuelve permisivo en vez de romper | OK |
| Una herramienta sin descripción dice qué es | OK |
| El texto de la respuesta se junta; lo que no es texto se escribe en JSON; vacío no rompe | OK |
| La firma del conjunto no depende del orden, y cambia cuando aparece un servidor | OK |
| El interruptor: encendido por defecto, se apaga con `false` y no se apaga con basura | OK |

Y el editor construido, con las comprobaciones de siempre (`.scratch/verificar-editor-construido.cjs`)
más la build completa: el conector viaja con `mcp.js` y `mcpTools.js`, y los nodos se llaman
**PiCode**, **Settings** y **Providers**.

## Lo que queda, dicho claro

- **La pantalla de MCP y su `mcp.json` no se tocan**: añadir un servidor se hace donde siempre.
  Si el dueño quiere esa pantalla dentro del nodo PiCode (en vez de en su sitio), es otro cambio.
- **Los ajustes del editor que no aplican a pi** (los de Copilot, por ejemplo) siguen en el árbol:
  se revisaron uno a uno los que cuelgan del nodo y lo que hay es lo que se ve en la lista de
  arriba. Quitar los que no sirven es una limpieza aparte, y hay que hacerla con cuidado: son
  ajustes del editor, no nuestros.

## Registro

- 2026-09-25 · pedido y hecho en la misma sesión, después de quitar la ventana de agentes.
