# Feature: pi 0.99.2 en el pin, y el MCP que pi ya trae

## Goal

> «Actualiza pi en el proyecto ha salido una nueva versión»
> «también revisa si hay que hacer algo en picode o fixear algo»

La subida del pin de pi a la última publicada, y la revisión de lo que esa subida deja
obsoleto o roto en el conector de PiCode.

## Lo que se midió antes de tocar nada

Medido el 2026-10-01 contra npm y contra el paquete `@earendil-works/pi-coding-agent@0.99.2`
(descargado y ejecutado, no leído de un blog).

1. **La versión publicada es 0.99.2**, y el pin del repositorio estaba en **0.99.1**. La
   subida anterior (0.87.1 → 0.99.1) dejó su registro en `picode-cloud-sync.md`.
2. **Sin cambios de rotura para la integración.** El SDK sigue publicando las mismas
   entradas (`dist/index.js`, `dist/cli.js`) y los comandos que el conector ejecuta siguen
   existiendo, comprobados con `--help` sobre el binario 0.99.2: `install`, `remove`,
   `update --all`, `list`, `config`, `auth`, `mcp add|remove|list|login|logout`.
3. **La novedad que sí importa: pi tiene MCP propio desde 0.99.0** y lee
   `<agent dir>/mcp.json` y, con el proyecto en confianza, `<proyecto>/.pi/mcp.json`
   (`dist/extensions/mcp/config.js:79-81`). La extensión es built-in y **reemplazable**: si
   otra extensión registra `/mcp`, la built-in no carga
   (`dist/extensions/index.js` → `replaceable`, `dist/core/resource-loader.js`
   `omitReplacedExtensions`).
4. **`pi-mcp-adapter` ya no lee el fichero que PiCode escribe.** Su configuración vive en
   `mcp-adapter.json` (`pi-mcp-adapter@4.0.0` `config.ts:202`); el `mcp.json` del agent dir
   lo considera de pi, y desde 4.0.0 detecta la built-in (`index.ts:62-66`,
   `hasBuiltInMcpCommand` → `builtin:mcp`) en vez de quedarse con `/mcp`. Su changelog lo
   dice con todas las letras: en ≤3.3.0 «the adapter took over `/mcp` and warned about
   `mcp.json` on every start even though the built-in extension owns that file».
5. **Los nombres con punto no valen.** El validador de pi acepta
   `^[A-Za-z0-9_-]+$` (`dist/core/mcp-servers.js:18`), y un nombre así se rechaza con
   `invalid server name`. El patrón de PiCode sí aceptaba puntos, así que un servidor
   `mi.servidor` se escribía y no conectaba nunca.

## Decisión

1. **Pin a 0.99.2** en `distribution/runtime.json`. El script del build ya refresca un
   runtime viejo cuando el pin se mueve (`dev/pi-runtime.sh`).
2. **Fuera la instalación de `pi-mcp-adapter`.** El paquete no lee el fichero que PiCode
   escribe (`mcp-adapter.json` ≠ `mcp.json`), así que no aportaba nada a los servidores de
   la fila de ajustes. Y era peor que inútil: al cargarse en el chat resolvía su
   configuración en el perfil **externo** de la máquina (ver «Defectos encontrados»), o sea
   que metía servidores de `~/.pi/agent` en el chat de PiCode — justo lo que la regla del
   proyecto prohíbe. Quitarlo reduce esa fuga.
   - Se deja de instalar; **no** se desinstala lo que el perfil del dueño ya tenga: la
     declaración en `settings.json` es suya y no es asunto de este cambio.
3. **Sin punto en el nombre.** `NAME_PATTERN` pasa a `^[a-z0-9][a-z0-9_-]*$` en
   `mcpServers.ts` y `mcp-add.ts`, y el importador convierte el punto en guion en vez de
   descartar el servidor entero. pi rechaza el nombre entero con un punto, así que el
   servidor se escribía y no conectaba nunca.
4. **La copia dice lo que se puede probar.** Los encabezados que afirmaban «pi has no MCP»
   y las frases que decían que el fichero lo lee `pi-mcp-adapter` se corrigen. La
   descripción del ajuste **ya no promete** que pi lo lea en el chat: dice dónde se
   escribe.

## Defectos encontrados al verificar

Salieron al comprobar la premisa anterior con sondas sobre el SDK real, y son más gordos que la
subida de pi. Los tres primeros **ya están arreglados** — ver «Arreglado: los tres a la vez» — y no
se tocaron en el mismo cambio porque alteran cómo se comporta **cualquier** extensión en el chat (el
perfil que resuelve y los eventos que recibe).

1. **El chat resuelve el perfil externo (`~/.pi/agent`).** `agent.ts` pasa `agentDir` como
   parámetro de `createAgentSessionServices`, pero **no** define `PI_CODING_AGENT_DIR`, que
   es lo que lee `getAgentDir()` de pi (`dist/config.js:434,450`). Una extensión que resuelve
   su perfil por su cuenta acaba leyendo (y potencialmente escribiendo) el pi de la máquina.
   *Prueba*: con un perfil temporal pasado como `agentDir` y `mcp-adapter.json` propio con
   un servidor `marker`, la extensión `pi-mcp-adapter` cargada en esa sesión registró
   **`mcp__firebase`** — el servidor del `~/.pi/agent/mcp-adapter.json` real del dueño — y
   **nunca** el `marker` del perfil que se le pasó.
2. **El chat nunca emite `session_start`.** Ese evento lo emite
   `session.bindExtensions(...)` (`dist/core/agent-session.js:2556`), y solo lo llaman los
   modos CLI (`interactive-mode.js`, `print-mode.js`, `rpc-mode.js`); ni `sdk.js`, ni
   `agent-session-services.js`, ni `agent-session-runtime.js` lo llaman. *Prueba*: cargada
   la extensión built-in de MCP del propio pi (`createMcpExtension()`) en una sesión del
   SDK, y creada la sesión, su lista de herramientas se quedó **vacía**. Consecuencia:
   cualquier extensión que haga su trabajo en `session_start` es inerte en el chat.
3. **Por lo anterior, la fila Settings > PiCode > MCP no sirve nada en el chat.** El fichero
   que escribe lo lee el pi de la terminal (comprobado: `pi mcp list` lo lista), y en el
   chat no hay quien lo lea: la built-in de pi no se carga (`builtInExtensions` las añade
   solo `main.js`, el entry del CLI) y, aunque se cargara, no conectaría nada sin
   `session_start`. El `pi-mcp-adapter` que se instalaba tampoco, porque lee otro fichero.
4. **El `mcp.json` del perfil está en formato viejo del adaptador.** De los 10 servidores
   declarados, pi 0.99.2 acepta 7 y rechaza 3 (`atlassian-rovo-mcp` y `sentry` por
   `auth: "oauth"`; `github` por `auth: false` / `oauth: false`). No molesta hoy —nadie lee
   ese fichero en el chat— pero hay que migrarlo antes de activar el MCP propio de pi. La
   migración es quitar las claves del adaptador (`auth`, `oauth`, `lifecycle`, `directTools`)
   y dejar que pi use OAuth por defecto; **es dato del dueño y no se toca sin decirlo**.

## Arreglado: los tres a la vez (2026-10-01, petición «arregla todo»)

En `agent.ts`, al construir la sesión del chat:

1. **`pinAgentDir(agentDir)`** fija `PI_CODING_AGENT_DIR` al perfil en fuerza **antes** de que pi
   cargue nada. En modo externo la variable se **borra** (dejarla puesta haría que el pi de la
   máquina corriera contra el perfil interno).
2. **`piBuiltinExtensions(sdk)`** añade a `extensionFactories` las tres built-in de pi —`mcp`,
   `codemode` y `tool-search`— cada una con detección previa del export. No carga `llama.cpp`:
   no tiene nada que ver con esto. La extensión se llama **`mcp`** a propósito: el adaptador
   detecta la MCP built-in por ese nombre (`<inline:mcp>`) y así no se queda con `/mcp`.
3. **`bindSessionExtensions(session)`** llama a `session.bindExtensions({ onError })`, que es lo
   único que emite `session_start`. Va con **tope de 15 s**: una extensión que se quede esperando
   algo que este host no da no puede congelar el primer turno. Solo se enlaza el escucha de
   errores: aquí no hay interfaz de terminal, y quien la necesite pregunta `ctx.hasUI`.

La exposición de cada servidor se queda como la declare el fichero (pi las trae en `codemode`
por defecto y activa `codemode` o `tool_search` cuando un servidor lo necesita). No se fuerza
`direct`: serían todas las herramientas de los 10 servidores en el prompt.

### Verificado con sondas sobre el SDK real (perfil temporal con un servidor `marker`)

| Qué | Antes | Ahora |
| --- | --- | --- |
| Extensiones cargadas en el chat | 0 (o solo el adaptador) | `picode-permissions`, `mcp`, `codemode`, `tool-search` |
| Herramientas registradas | ninguna | `codemode`, `tool_search` y **`mcp__marker__echo`** |
| Servidor del perfil que se le pasa | no aparecía | aparece |
| Servidor del `~/.pi/agent` real (`firebase`) | aparecía | **no aparece** |
| Errores y avisos | — | ninguno |

### Tidy-up del perfil

`pi-mcp-adapter` seguía declarado en el perfil del dueño. Con el perfil ya fijado, el adaptador
lee `mcp-adapter.json` **de PiCode** (que no existe) y solo aporta dos herramientas vacías
(`mcp`, `mcpScript`) al chat. Se quita de la lista `packages` del perfil interno (copia previa en
`.scratch/settings-json-before-adapter-removal.json`); los ficheros instalados se dejan, no
estorban. Las configuraciones compartidas que el adaptador importaba (`~/.config/mcp/mcp.json`,
`~/.agents/mcp.json`) no existen en esta máquina, así que no se pierde ningún servidor.

## Forma vieja y nueva: una entrada que leen los dos

Petición del dueño: *«haz que cualquier mcp que se agregue manualmente se cree de la forma vieja
y nueva»*. Se cumple con **una sola entrada**, que resulta ser la nueva, porque el adaptador
entiende la nueva y pi no entiende la vieja:

| Servidor | Lo que se escribe | Lo lee pi 0.99.2 | Lo lee `pi-mcp-adapter` |
| --- | --- | --- | --- |
| Local | `{ command, args, env? }` | sí | sí |
| Remoto con token | `{ type: 'http', url, headers: { Authorization: 'Bearer …' } }` | sí | sí |
| Remoto que pide iniciar sesión | `{ type: 'http', url, oauth: {} }` | sí (`usesOAuth`, `runtime.js:36`) | sí (`oauth` objeto → `auth: "oauth"`, `config.ts:1215`) |

Lo que **nunca** se escribe es la grafía vieja que pi rechaza: `auth: "oauth"`
(`auth.provider must be a provider name`) y `oauth: false` (`oauth must be an object`). No se
pierde nada: el adaptador deriva su `auth` del objeto `oauth`, así que `oauth: {}` le sirve igual.

Y como el fichero ya tenía entradas con esas grafías viejas, todo lo que se lee para escribir
pasa por `normalizedServersFile`: la entrada se repara (fuera `auth`/`oauth` booleanos, dentro
`oauth: {}` si pedía iniciar sesión) y **todo lo demás se queda igual**, incluidas las claves del
adaptador que pi ignora (`lifecycle`, `directTools`) y las que no son del adaptador.

## Iniciar sesión en un servidor MCP desde la página (2026-10-01)

Cierra el hueco declarado arriba: los dos servidores del perfil que piden OAuth
(`atlassian-rovo-mcp`, `sentry`) necesitaban una terminal.

**No se implementa OAuth aquí.** pi ya lo hace: `pi mcp login <server>` levanta un callback local,
**abre el navegador solo** (`openUrl = options.openUrl ?? openBrowser`, `dist/extensions/mcp/cli.js:436`)
y guarda los tokens en el perfil. Lo que añade PiCode es el botón y el sitio donde vive la espera:

| Pieza | Dónde | Qué hace |
| --- | --- | --- |
| Contrato `picode.mcp.loginServer` | `extension.ts` | recibe el nombre, exige que exista el runtime y lanza pi contra el **perfil en fuerza** (`PI_CODING_AGENT_DIR`) |
| `runMcpLogin` | `extension.ts` | `execFile` como Node, con progreso cancelable (cancelar mata el proceso) y tope de 330 s (pi espera 300) |
| Reglas puras | `mcp-login.ts` | `loginArguments`, `loginTarget`, `authorizationUrlIn`, `lastLineOf` — con 6 tests |
| Acción **Sign In** | `mcpListWidget.ts` | en la fila de un servidor de pi **solo si es remoto** (`'uri' in definition`), junto a Edit y Remove |

Al terminar: si salió bien, se muestra **la frase de pi** (`Signed in to MCP server "x" (N tools).`,
que también cubre el «ya estaba dentro») y se refresca la lista; si falló, la **última línea** que
escribió pi, con botón **Open in browser** usando la dirección que pi imprimió — porque si el
navegador no llegó a abrirse, esa dirección es lo único que salva el flujo.

**Verificado ejecutando** (contra el perfil del pack, sin abrir navegador): `pi mcp login
does-not-exist` → `No MCP server named "does-not-exist". Configured: aikido, atlassian-rovo-mcp,
codegraph, engram, github, sentry, sequential-thinking, supabase-mcp-server, vercel, repomix.`; y
`pi mcp login codegraph` (local) → `MCP server "codegraph" does not use OAuth. Only HTTP servers
without an Authorization header do.` Los dos textos son los que el botón repite por mensaje. **Lo
único que no se ejecutó aquí es el viaje al navegador** (abriría una pestaña de verdad en la máquina
del dueño): hace falta un `sentry` o un `atlassian` real y el consentimiento de él.

También: `docs/DISTRIBUTION.md` decía «siete suites» y nombraba una extensión que ya no existe
(`picode.picode-pi-chat`); corregido a las suites reales del conector y a `picode.picode`.

## Mejoras entregadas después (2026-10-01, «haz lo que creas mejor»)

De la lista de recomendaciones se hicieron las cuatro que más valen por lo que cuestan: la única
que podía acabar en algo que el dueño no quería, el par del botón que acababa de estrenar, y las
dos que evitan que esto se rompa otra vez.

| Mejora | Qué hace | Cómo se comprueba |
| --- | --- | --- |
| **Los MCP piden permiso** (`permissions.ts`) | Las herramientas de un servidor de pi (`mcp__…`) cuentan como mutantes: ninguna corre sin preguntar en los niveles que preguntan. Las del editor (`mcp_…`, un guion bajo) se dejan, porque el editor ya pregunta por ellas | 4 tests nuevos; y las llamadas anidadas de `codemode` pasan por el mismo evento (`agent-session.js:308`), así que también preguntan |
| **Sign Out** (`picode.mcp.logoutServer`) | El par de Sign In: pi borra las credenciales que guardó y la entrada se queda, para que el siguiente inicio de sesión tenga dónde caer | `pi mcp logout` responde `Signed out of MCP server "x".` o `No stored credentials for MCP server "x".`; contrato y acción comprobados en el pack |
| **Check Server** (`picode.mcp.checkServer`) | Pregunta a pi por un servidor: estado, herramientas y, si falló, el motivo | Verificado contra pi 0.99.2 real (conectado / fallido con el error entero); 7 tests sobre las formas que imprime |
| **Los tests se comprueban de tipos** (`tsconfig.test.json`) | Los 15 ficheros corrían en CI pero nadie miraba sus tipos, y un test que llama mal a una función pasa igual en tiempo de ejecución. **12 errores preexistentes** corregidos | `tsc -p extensions/picode/tsconfig.test.json` → 0; los 177 tests siguen pasando |
| **Lo que escribimos, contra el validador de pi** (`dev/check-mcp-entries.mjs`) | Las 12 formas que produce el conector pasan por `validateMcpServerConfig` del runtime instalado, con **control positivo**: las dos grafías viejas tienen que seguir siendo rechazadas, o el chequeo no valdría nada | `node dev/check-mcp-entries.mjs` → 12/12 como se espera; paso nuevo en CI |

## Comprobar un servidor contra pi (2026-10-01)

Un servidor configurado y muerto se ve igual que uno que funciona: el fichero no los distingue, y esa
es justo la pregunta del dueño. `pi mcp list --json` es la respuesta de pi: el estado que alcanzó,
las herramientas que encontró y, si falló, **el motivo** — lo que nadie puede deducir desde fuera.

| Pieza | Qué hace |
| --- | --- |
| Contrato `picode.mcp.checkServer` | corre `pi mcp list --json` contra el perfil en fuerza (reutiliza `runMcpCommand`, con tope de 120 s y cancelable) |
| `mcp-state.ts` | lee la respuesta de pi: `mcpStateReport`, `stateSentence`, `oneLine`. Puro, con 7 tests |
| Acción **Check Server** | en cualquier fila de pi, junto a Sign In/Sign Out/Edit/Remove |

Dice una frase: `"probe": connected, 1 tool` o `"broken": failed — MCP connection closed · "no-such-command" …`.
Un servidor que pi **no lista** se cuenta con el error de fichero que lo explica (así el nombre con
punto sale como motivo y no como misterio).

**Verificado ejecutando** contra pi 0.99.2 real: con un servidor bueno y otro con un comando
inexistente, la respuesta trae `state: connected` con sus herramientas y `state: failed` con el
error de Windows entero. Los tests usan esas dos formas tal cual.

**El chequeo conecta todos los servidores** (es lo que hace el comando), así que es un clic
deliberado y nunca algo que el panel haga por su cuenta.

## Decisión del dueño: **el editor manda** (2026-10-01, «la mejor que siempre sea el editor»)

Esta sección **corrige** las dos anteriores de esta misma página («Iniciar sesión…» y «Comprobar un
servidor…»): lo que cuentan se construyó, se midió, y después se retiró por esta decisión.

### Lo que se midió, y que obligó a elegir

1. El conector ofrece los servidores de `mcp.json` **al editor** como definiciones
   (`lm.registerMcpServerDefinitionProvider('pi', …)`).
2. El núcleo registra las herramientas de **toda definición habilitada** y conecta ese servidor para
   tenerlas (`mcpLanguageModelToolContribution`: «Skip disabled servers — don't register their tools»).
3. El puente del chat toma esas herramientas (`mcp_…`) y se las da a pi como herramientas propias.

Y desde el arreglo del chat, pi cargaba **además** su propio MCP, que lee **el mismo fichero**. Total:
cada servidor corría **dos veces** (dos procesos, dos clientes) y sus herramientas llegaban al modelo
por **dos vías** (`mcp__servidor__herramienta` desde pi y `mcp_servidor_herramienta` desde el editor).
Eso es exactamente el «segundo camino al mismo servidor» que este producto se había prohibido.

### La decisión

**Los servidores son del editor y pi los usa a través de él**, con sus confirmaciones y sus permisos.
Consecuencias, aplicadas en el fuente:

| Qué | Estado |
| --- | --- |
| Las built-in de pi en el chat (`mcp`, `codemode`, `tool-search`) | **No se cargan.** El SDK no las trae; cargarlas era lo que duplicaba todo |
| Sign In / Sign Out / Check Server (y sus módulos `mcp-login.ts` y `mcp-state.ts`, con sus 14 tests) | **Retirados**: operaban sobre un MCP que ya no es el del chat. El editor ya ofrece arrancar, parar y autenticar en la propia fila — tener dos botones para lo mismo es lo que sobra |
| El comando de paleta «Check an MCP server» | Retirado con ellos |
| El perfil fijado en el entorno (`PI_CODING_AGENT_DIR`) | **Se queda**: sin él las extensiones leían `~/.pi/agent` |
| `session.bindExtensions(...)` (`session_start`) | **Se queda**: es el contrato de toda extensión, y sin él cargaban y no arrancaban |
| La regla de permisos para `mcp__…` | **Se queda**: hoy no la usa nada del chat, pero es la dirección segura si esa forma de nombre vuelve a aparecer |
| Las entradas en formato que pi acepta (`oauth: {}`, sin `auth: "oauth"`) y su reparación | **Se quedan**: es lo que el fichero debe decir |
| `enabled: false` respetado, y el interruptor del panel de estado | **Se quedan**: es la única forma de apagar un servidor sin perderlo, y el panel es el único sitio donde sigue visible |
| `dev/check-mcp-entries.mjs` (lo escrito contra el validador de pi, en CI) | **Se queda**: vale con cualquiera de las dos arquitecturas |

### Lo que esto deja pendiente

El editor arranca los servidores de `mcp.json` **porque el conector se los ofrece**, y eso es lo que
hace que la página de MCP los liste. Si algún día se quiere que **pi** sea el dueño (la opción B), hay
que aceptar que esa página pierde sus filas, porque las filas *son* definiciones del editor.

## Fuera de alcance

- Cambiar el puente del MCP **del editor** (`mcp.ts`, `lm.invokeTool`): ese camino sigue
  siendo el del editor, con sus permisos y sus credenciales, y no lo toca la subida de pi.
- Migrar el `mcp.json` de perfiles viejos con claves del adapter (`settings`, `imports`):
  pi ignora lo que no sea `mcpServers`, así que no estorba.
- Desinstalar `pi-mcp-adapter` de un perfil que ya lo tenga.

## Evidencia (ejecutada, no leída)

Primera tanda — el pin y lo que sirve para decidirlo:

| Qué | Cómo se comprobó | Resultado |
| --- | --- | --- |
| El pin instala y deja el runtime donde el conector lo busca | `bash dev/pi-runtime.sh /tmp/packcheck` (el paso real de la fase 5) | `pi 0.99.2 in place`, `dist/index.js` y `dist/cli.js` presentes; podadas 20 plataformas ajenas, conservado win32/x64 |
| La superficie del SDK que usa el conector sigue ahí | `import()` real del entry instalado + `createAgentSessionServices` | `createAgentSessionFromServices`, `modelRuntime.login/getProviders/hasConfiguredAuth` presentes; 42 proveedores |
| El pi de la terminal lee `mcp.json` | `PI_CODING_AGENT_DIR=<tmp> pi mcp list --json` con un servidor de prueba | Listado como `scope: global`, `exposure: codemode`, sin adapter instalado |
| El nombre con punto era un fallo real | El mismo listado con `my.server` | `servers: []` y `invalid server name "my.server" (use letters, digits, "_" and "-")` |
| Lo que escribe el conector es lo que pi lee | `mcpServersText` + `mcpServersTextWithAdded` reales → fichero → `pi mcp list --json` | Los tres servidores (stdio, http con `headers`, y el de Add Server) aceptados con `errors: []` |
| El conector | `node --test test/*.test.ts` | 167 pasan, 0 fallan |
| El conector, tipos | `tsc -p extensions/picode/tsconfig.json --noEmit` | 0 |
| El editor, tipos | `tsc -p src/tsconfig.json --noEmit` | 0 |

Segunda tanda — las sondas que destaparon los defectos de arriba (todas sobre el SDK real
del runtime del pack, con perfiles temporales):

| Qué | Cómo se comprobó | Resultado |
| --- | --- | --- |
| El chat no carga las built-in de pi | `createAgentSessionServices` con un perfil **sin** paquetes | 0 extensiones cargadas |
| El chat no emite `session_start` | La built-in de MCP de pi (`createMcpExtension()`) en `extensionFactories` + sesión creada | La extensión carga (`<inline:picode-mcp>`) y su lista de herramientas queda **vacía** |
| El adaptador resuelve el perfil externo | `pi-mcp-adapter` declarado en el perfil temporal que se pasa como `agentDir`, con `marker` en su `mcp-adapter.json` | Registró `mcp__firebase` (del `~/.pi/agent` real) y **nunca** `marker` |
| El fichero que declara la fila usa formato viejo | `validateMcpServerConfig` de pi 0.99.2 (importado por ruta, sin conectar a ningún servidor) sobre el `mcp.json` real del perfil | Antes: 7 de 10 aceptados; **3 rechazados**. Después de reparar: **10 de 10** |
| Lo que escribe PiCode lo acepta pi, y lo viejo reparado también | `mcpServerEntry` y `serverFileEntry` reales + `normalizedServerEntry` → `validateMcpServerConfig` | Las 9 formas escritas **aceptadas**; las dos formas viejas sin reparar, **rechazadas** (`auth.provider must be a provider name`, `oauth must be an object`) |

## Registro

- 2026-10-01 · **forma vieja y nueva** (petición del dueño): los dos escritores
  (`mcpServerEntry` y `serverFileEntry`) escriben `oauth: {}` cuando un servidor remoto no lleva
  token —forma que aceptan pi y el adaptador— y `readJsonFile` repara las entradas viejas al leer
  el fichero (`normalizedServersFile`), sin tocar nada más. El `mcp.json` del pack quedó reparado
  (4 claves fuera; copia previa en `.scratch/mcp-json-before-normalize.json`) y verificado
  **10/10** con el validador real de pi. 167 tests, tipos 0.
- 2026-10-01 · **arreglo del chat entregado y construido**: `8326328c`. Build por `dev/build-run.sh`,
  exit 0, `profile restored: 71028 files`. Verificado **dentro del pack**, no en el fuente:
  `agent.js` compilado lleva `PI_CODING_AGENT_DIR`, `bindExtensions` y las tres built-in
  (`createMcpExtension`, `createCodemodeExtension`, `createToolSearchExtension`); pi **0.99.2**;
  el perfil con **19 paquetes** (sin `pi-mcp-adapter`) y sus **10/10** servidores aceptados por el
  validador de pi.
- 2026-10-01 · **build**: dos construcciones verificadas sobre el árbol. La primera con
  `dev/build.sh` (dejó el pack sin perfil; se restauró a mano) y la segunda con
  `dev/build-run.sh`, que guarda y devuelve el perfil solo: `profile restored: 71028 files`,
  `build.status` 0. Medido en el pack: pi **0.99.2**, connector compilado sin la instalación
  del adaptador y con el patrón sin punto, y la descripción corregida dentro de la tabla de
  mensajes del editor (`out/nls.messages.json`). Perfil intacto: 20 paquetes, modelo y tema
  del dueño, y el adaptador aún declarado (no se desinstala nada).
- 2026-10-01 · **corrección de un error propio**: la primera versión de este documento (y el
  informe al dueño) afirmaba que, desde pi 0.99, «pi lee `mcp.json` por sí mismo» y que por
  eso los servidores seguían funcionando sin el adaptador. Cierto para el pi de la
  terminal, **falso para el chat**, que es el producto: allí no se cargan las built-in ni se
  emite `session_start`. Lo corrigieron las sondas de la segunda tanda; la copia del
  ajuste y los encabezados se ajustaron a lo que se puede probar.
