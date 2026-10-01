# Feature: two Pi instances, isolated, with a one-shot import

## Goal

Support two ways of running Pi — PiCode's **internal** pi and the **external** one the
owner already has — as instances that are **completely independent in all their
configuration**: models, providers, MCPs, profile, packages, skills, credentials and
memory. Choosing one must make everything the editor loads come from that instance, with
nothing from the other leaking in. And the internal one must be able to **import** the
external one's configuration once, as a copy, not as a continuous sync.

## What is already true (verified, not assumed)

- `picode.pi.runtime` already chooses **which program runs**: `managed` (PiCode's own,
  installed under `resources/pi-runtime`, pinned in `runtime.json`), `path` (the one on
  `PATH`) or `custom` (a path the owner gives). The settings row and the wizard ask for it.
- `picode.pi.transport` chooses **how that program is loaded**: as a child process over
  JSON on stdio (`rpc`) or inside the editor through pi's SDK (`embedded`).
- **The profiles are not separated today.** Both instances read and write `~/.pi/agent`:
  `resolveAgentDir()` (`src/transcription.ts:131`) answers `PI_CODING_AGENT_DIR` when set,
  otherwise `~/.pi/agent`, and nothing in the extension sets it. The SDK client passes
  `agentDir: this.options.agentDir ?? sdk.getAgentDir()` (`pi-sdk-client.ts:416`), which
  lands on the same place.
- pi itself honours `PI_CODING_AGENT_DIR`: its own packages read their configuration from
  `<agent dir>` (the MCP adapter's README states its files are read from
  `$PI_CODING_AGENT_DIR/mcp.json` when that variable is set).

## The architecture

**An instance is a pair: a program and a profile.** The program is already chosen; this
feature adds the profile and binds the two together, so there is exactly one place that
answers "what is this instance using".

| | Internal instance | External instance |
| --- | --- | --- |
| Program | `resources/pi-runtime` (PiCode's, updatable from the settings tab) | whatever `picode.pi.runtime` points at (`PATH`, or a path the owner gives) |
| Profile | `<distribution>/data/pi-agent` — inside PiCode's own portable profile | `PI_CODING_AGENT_DIR` if the owner set it, otherwise `~/.pi/agent` |
| Who writes it | PiCode and its pi | the owner, and every other pi tool on the machine |
| PiCode's access | read and write | **read-only**, forever |

**One resolver, used by every reader.** A new module owns the answer:

```text
instanceAgentDir(runtime)  ->  the profile directory of the selected instance
                               (the internal one, or undefined so pi uses its own)
```

`undefined` is the honest answer for the external instance: it means "do not set the
variable and do not pass a directory", so pi resolves its own default exactly as it does
when run from a terminal. Everything that reads or writes a profile goes through this
resolver, and that is the whole isolation mechanism:

- the RPC child's environment (`PI_CODING_AGENT_DIR` in `env`),
- the SDK client's `agentDir` (`pi-sdk-client.ts`, already a parameter),
- the settings service (`PiSettingsService.create({ agentDir })`, already a parameter),
- the skills discovery (`discoverSkills({ agentDir })`, already a parameter),
- the files read directly today: `auth.json` (chat-view) and `mcp.json` (extension).

Nothing else may call `resolveAgentDir()` directly for instance-bound work; a test asserts
the resolver is the only path, so a new reader cannot quietly reintroduce the shared
profile.

**Why the profile must live inside PiCode, beyond isolation.** It is the unit the paid
service is going to sync (`AGENTS.md`, "El programa es gratis; lo que se vende es la
nube"). A profile shared with the machine is neither a product's to upload nor safe to
overwrite.

## The import

A one-shot copy, never a sync. Four steps, in this order:

1. **Scan** the external profile and report what it holds, without copying anything:
   providers with stored credentials (names and counts, **never the secret values**),
   configured models, MCP servers, package list, skills, and the approximate size of the
   package tree.
2. **Choose** what comes across. Credentials are a separate, explicit decision: the copy is
   never a side effect of asking to import.
3. **Copy** into the internal profile, item by item, and **report each item**. A target that
   already has content is not overwritten without saying so. The import is repeatable.
4. **Install the packages** the copied list names, through the install path that already
   exists, into the internal profile — because pi owns that layout and the copy is of a
   *list*, not of a tree of `node_modules`.

After the import the two instances keep running isolated: no re-sync, no shared file, and
the external profile has not been written to.

### The safety rule that orders all of it

**The internal profile is never switched on empty.** An internal instance with no
credentials cannot talk to a model, and with no packages it has no Gentle AI, no skills and
no MCPs — that is not isolation, it is a broken editor. So: import first, or start from
scratch **on purpose** and say so, and only then move the profile. This is a rule, not a
preference, and the feature document states it because the obvious order is the wrong one.

Starting from scratch is possible today with one command in a terminal, which writes into
the internal profile because that is the agent directory it is given:

```bash
PI_CODING_AGENT_DIR=<distribution>/data/pi-agent pi     # then /login
```

Creating credentials **from inside the editor** is not possible yet: it needs pi's
interactive bridge (`extension_ui_request`), which is unimplemented. That is Fase 4, and it
is what will eventually make an empty internal profile a first-class start.

## Slices

| Slice | What it delivers | Why in this order |
| --- | --- | --- |
| 1. The resolver and the scan | `instanceAgentDir()` + a read-only inventory of the external profile, with tests. **No behaviour change**: nothing is switched, nothing is copied | The foundation, and the only part that is safe on its own |
| 2. The import | Scan, choose, copy, report; credentials separate; repeatable | Must land **before** the switch, or the switch leaves the editor without credentials |
| 3. The switch | The managed instance gets the internal profile end to end (RPC env, SDK `agentDir`, settings service, skills discovery, `auth.json`, `mcp.json`), with a row that says which profile is in use | The moment the instances become independent |
| 4. The interactive bridge (`extension_ui_request`) | pi can ask the editor for input — select, confirm, input, editor — which is what makes a provider login possible **from inside the editor** | Promoted ahead of the polish at the owner's request (2026-09-23), because it is what lets the first-run wizard work end to end: an empty internal profile only becomes a first-class start once credentials can be created here. It also unlocks models, providers and MCP authorisation, so it pays twice |
| 5. Polish | The import's progress, sizes, and a second import that reports what changed | After the isolation is real and the empty start is possible |

### The first run must not require a terminal

The owner's words: "mi idea era que el wizard de primer arranque (elegir tipo de pi +
activar gentle-ai) funcione todo dentro del editor, sin pasar por terminal", and "asegurarnos
de que el wizard no dependa de hacer login por terminal como paso intermedio".

The wizard asks two questions and installs what the answers name. It has to be completable
**entirely inside the editor**, so no path through it may end in "now run this command in a
terminal":

- bringing Gentle AI in, and installing and updating the internal pi, already happen in the
  editor through the existing install path;
- an external profile's configuration arrives through the import (slice 2);
- **credentials for an empty internal profile are the one case that still needs the bridge**
  (slice 4). Until it exists, an empty start is possible but only from a terminal, and the
  wizard must **say so before offering that path** rather than leaving the owner at a dead
  end.

The terminal command recorded below stays in this document as the interim escape hatch, and
not as the intended way in.

## Out of scope

Syncing anything to the cloud. Auto-updating the external instance. Migrating sessions: a
session belongs to the profile that made it, and moving them is a separate, deliberate
decision.

**Escritura en el perfil del dueño: revertido a propósito (2026-09-23).** Esta feature dejó
el perfil externo en solo lectura «forever», y esa regla ya no está en pie: el dueño pidió
que la configuración de modelos —proveedores y modelos propios— sirva para «cualqueir pi ya
sea para el interno o el externo». Con el pi del PATH elegido, escribir en su perfil *es*
configurar ese pi, y es lo que él ha pedido. Lo que cambia, y queda como regla nueva: el
destino de una escritura es el perfil de la instancia elegida (`instanceProfileDir`), sin la
guarda anti-mudez porque un login existe para llenar un perfil vacío; y cuando ese destino
es el perfil del dueño, la superficie pide **una** confirmación que lo nombra antes de
escribir. Detalle y tareas: `odd/tasks/picode-models-providers.md`. Todo lo demás de este
documento sigue igual: nada reescribe el perfil del dueño por su cuenta, ni lo sincroniza, ni
lo migra.

## Tasks

Worked in this order. A task is checked only when its outcome and its checks were
observed; every task closes with one work-unit commit on the feature branch, recorded here
as evidence.

- [x] **T1 — El resolutor y el escaneo.** `instanceAgentDir(extensionUri, runtime)` (managed
  → `<distribution>/data/pi-agent`, path/custom → `undefined`) y `scanProfile(agentDir)` con
  un inventario de solo lectura: paquetes, **nombres** de credenciales, modelos, MCPs,
  skills, memoria y sesiones. Parsers puros separados de las lecturas. Invisible en el
  producto: nada cableado. `1835df4`, 22 suites verdes, 15 comprobaciones.
- [x] **T2 — La copia de un perfil.** `importProfile({from, to, selection, onProgress})` en
  `src/instance-import.ts`: copia elemento a elemento hacia el perfil interno — ajustes
  (incluida la lista de paquetes), modelos, MCPs, skills, memoria — y **credenciales solo si
  se piden aparte**, informando `declined` y no `absent` para que la razón se vea. El origen
  solo se lee por construcción (las únicas escrituras son `copyFileSync` y `writeFileSync`
  bajo el destino), los directorios se fusionan sin borrar nada que la importación no haya
  puesto, y mismo origen y destino se rechaza antes de escribir. Las **sesiones quedan fuera**.
  `3549bb3`, 23 suites verdes, 16 comprobaciones.
- [x] **T3 — La fila de importación.** Una acción en el editor que enseña el inventario de
  T1, deja elegir qué viene, marca las credenciales como decisión aparte, ejecuta T2 y
  **informa de cada elemento**. Sin terminal en ningún paso.
  - [x] **T3a — El flujo del comando.** `picode.piChat.importProfile` («PiCode: Importar el
    perfil de tu pi»): resuelve los dos extremos, rechaza antes de escribir nada y en el
    orden en que el dueño descubriría el problema (no hay perfil, no tiene nada, o son el
    mismo o uno contiene al otro), enseña el inventario, copia con progreso e informa por
    elemento. Las credenciales salen marcadas y **sin marcar por defecto**. La guarda de
    solapamiento (`path.relative`) es lo que mantiene toda escritura bajo el perfil de
    PiCode. `8197a9a`, 24 suites verdes, 19 comprobaciones.
  - [ ] **T3b — La fila en el panel**, con el mismo mecanismo que la fila que repite la
    configuración inicial (`kind: "action"` + `command`).
  - [x] **T3c — Instalar los paquetes copiados** por el camino de instalación existente.
    Va **después de T4a**: ese camino lanza el pi, y si no apunta al perfil de la instancia
    elegida instalaría en el perfil equivocado — que es justo el cruce que este trabajo
    existe para evitar. `8caf35c`.
    **Corrección que resultó decisiva**: la instalación va al **destino de la importación**
    (`instanceAgentDir`, sin guarda), **no** a lo que diga la guarda. La guarda cambia de
    respuesta en cuanto entran credenciales, así que con credenciales declinadas habría
    instalado en el perfil de la máquina mientras los ficheros se copiaban en el otro. Copiar
    en un sitio e instalar en otro es el cruce, en pequeño. Eso es exactamente para lo que
    `instanceAgentDir()` está sin guarda y `selectedAgentDir()` es para lectores.
    Y **aplicar el cambio de perfil**. Los perfiles se leen en momentos distintos: la fila se
    relee en cada refresco, pero el cliente del agente se construye al arrancar. Así que tras
    importar hay que **ofrecer recargar la ventana**. `9a6273f` corrigió que el cierre prometía
    una recarga mirando solo las credenciales: con el pi del dueño elegido, recargar no cambia
    nada. El cierre es ahora una función pura de dos hechos con tres finales, y **solo el
    primero lleva botón**, porque solo ahí pulsarlo cambia algo.
- [ ] **T4 — El interruptor.** El aislamiento de verdad: el perfil de la instancia elegida
  llega a todo sitio que lea o escriba un perfil, con una fila que dice qué perfil está en
  uso. **Guarda:** no se enciende sin credenciales; si no las hay, lo dice en vez de dejar el
  editor mudo.
  - [x] **T4a — El resolutor en los sitios que lanzan pi.** Los procesos que pi lanza reciben
    el perfil de la instancia elegida, pasado explícitamente de arriba abajo (un `env` en las
    opciones del cliente RPC, un parámetro obligatorio en `runPiCli`, un campo en
    `PiMenuDeps`, y el perfil en `installedPackagesLister`). Los añadidos van **los últimos**,
    así PiCode impone su perfil frente a un `PI_CODING_AGENT_DIR` exportado por el dueño, y no
    lo impone cuando la instancia es la suya. Ningún módulo lanzador deriva la raíz de la
    distribución por su cuenta. `ccafd8e` (el ayudante y la comprobación) y `3549bb3`… → ver
    commits. **No desplegado a propósito**, por lo que sigue abajo. Los sitios, ya localizados:
    - se lanzan con `PI_CODING_AGENT_DIR`: el hijo del RPC (`pi-rpc-client.ts:329`, construido
      en `extension.ts`) y **el instalador de paquetes** (`pi-cli.ts:51` vía `runPiCli`,
      llamado desde `extension.ts`, `menu.ts` y `skills.ts`) — el que más importa porque es el
      que escribe;
    - **corregido**: `chat-view.ts:1583` es el hijo de **ffmpeg**, no pi (verificado: es
      `runFfmpeg`, no lee ningún perfil, y ese fichero nunca ha construido un `PiRpcClient`).
      No lleva la variable: ponérsela a un proceso que no lee perfiles sería ruido que
      alguien leería como intención;
    - **el perfil se pasa explícitamente** de arriba abajo (un `env` en las opciones del
      cliente RPC, un parámetro en `runPiCli`/`runExecutable`, un campo en `PiMenuDeps`).
      Ningún módulo lanzador deriva la raíz de la distribución por su cuenta: dos formas de
      localizarla serían justo el cruce que esto elimina;
    - leen del perfil: `chat-view.ts:912` (la clave de NaN, una credencial),
      `extension.ts:188` (el servicio de ajustes), `extension.ts:1510` (el `mcp.json`),
      `pi-sdk-client.ts:416` (ya es parámetro);
    - no lo necesitan: `runtime.ts:298` (`--version`) y `:647` (instalar el runtime).
    Con un **test que impida el retroceso**: leer las fuentes y fijar qué ficheros pueden
    llamar a `resolveAgentDir()` directamente, para que un lector nuevo no reintroduzca el
    perfil compartido sin que salte.
  - [ ] **T4b — La guarda, dentro del resolutor.** El interruptor no se echa a medias. **El
    peligro es real y está vivo en esta máquina**: `runtime` es `managed`, el perfil interno
    (`<distribución>/data/pi-agent`) **no existe**, y T4a ya apunta ahí las instalaciones de
    paquetes. Con el perfil interno vacío, la instancia gestionada se queda **muda**: sin
    credenciales, sin paquetes, sin gentle-ai.
    La decisión va **en el resolutor, no en un llamador**: `instanceProfile()` solo responde
    el perfil interno cuando ese perfil **sirve**; si no, responde el de la máquina con
    `owned: false`, que es exactamente el comportamiento de hoy. Así **todos** los que lanzan
    pi y **todos** los que leen un perfil siguen la misma respuesta sin cambiar una línea, y
    no puede quedar medio echado. Sirve = la carpeta existe y tiene al menos un proveedor en
    `auth.json` (se leen claves, nunca valores, con el parser que ya existe). Los hechos que
    la fila necesita —si el perfil interno existe y cuántos proveedores tiene— salen también
    del resolutor, para que la fila no los recalcule ni los lea por su cuenta.
    Y una fila en la categoría PiCode que diga **qué perfil está en uso**, sin rutas; cuando
    `managed` esté elegido y el perfil propio no sirva todavía, lo dice y señala la fila de
    importar.
    *Limitación conocida, a propósito:* una instancia interna sin credenciales (un modelo
    local sin clave) todavía no se puede usar, porque la guarda no distingue «vacío» de
    «vacío a propósito». Queda anotado para el pulido, en vez de resolverse adivinando.
  - [x] **T4c — Los lectores.** `selectedAgentDir()` es el **único** sitio que compone el
    respaldo (el perfil propio cuando la guarda dice que sirve, el de la máquina si no), y los
    lectores le preguntan a él: el cliente **embebido** (el transporte que usa esta máquina),
    el servicio de ajustes —que lee **y escribe**—, las skills, la clave de NaN y el `mcp.json`.
    La lista fijada baja a sus dos entradas finales: `instance.ts` (el resolutor, donde el
    respaldo vive) y `instance-import-command.ts` (el origen de la importación es el perfil de
    la máquina, a propósito). **Ese encogimiento es la demostración**, y está escrito en el
    comentario del propio test. `151c94a`.
    **Correcciones al mapa de este documento**, porque dos etiquetas mías eran falsas y las
    encontró el propio test, no mi grep: el lector de `extension.ts` que yo llamaba «servicio de
    ajustes» era el **descubrimiento de skills** —un quinto lector que mi lista no tenía—, y
    `settings-view.ts:352` no llamaba a `resolveAgentDir()` en absoluto: solo necesitaba que se
    le pasara el `agentDir` explícito. Lo que impuso la lista fijada de dos entradas fue lo que
    vio el quinto sitio: **una comprobación como instrumento**.
    No lo necesitan: `runtime.ts:298` (`--version`) y `:647` (instalar el runtime).
  - **Regla de despliegue:** el aislamiento se despliega **entero**, cuando la guarda está.
    Media respuesta desplegada es un editor que instala en un perfil y lee en otro.
    **Cumplida**: desplegado tras T4c, con la guarda respondiendo el perfil de la máquina en
    esta máquina (el perfil propio todavía no existe), o sea sin cambiar nada de lo visible
    salvo la fila nueva.
- [ ] **T5 — El puente interactivo.** `extension_ui_request` atendido en **las dos**
  implementaciones, que **no son el mismo trabajo** (comprobado en el pi instalado):
  - En **RPC**, `extension_ui_request` existe solo en `modes/rpc/`. Cuatro diálogos que
    bloquean (`select`, `confirm`, `input`, `editor` —este sin `timeout`) y cinco que no se
    responden (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`). Respuestas:
    `value` para selector/campo/editor, `confirmed` para confirmar, `cancelled` para cualquiera.
    Correlación **solo por id**, y **sin tiempos de espera propios**: el `timeout` es de pi, y un
    temporizador del host respondería a una petición que pi ya abandonó — inventando una
    decisión en nombre del dueño.
  - En **embebido** (el transporte de esta máquina) no hay tal evento: el SDK expone API propia
    —`login()`, `logout()`, `setRuntimeApiKey()`, `removeRuntimeApiKey()`—. Para una clave de API
    eso es un campo de texto; las **suscripciones** (ChatGPT Plus, Claude Pro, Copilot, xAI…) son
    OAuth y sí necesitan el puente. `login()` rechaza con `CredentialSynchronizationError` cuando
    commitea la credencial pero falla la sincronización: hay que inspeccionarlo, no reintentar
    a ciegas.
  - [x] **T5c — El login llena el perfil de PiCode o no escribe.** El defecto que encontró T5b,
    arreglado: `login(providerId, type, interaction, agentDir)` con el destino **obligatorio**, así
    que el compilador rechaza la omisión en vez de dejar que un llamador herede la carpeta
    equivocada. Con el pi del dueño elegido, `instanceAgentDir` es `undefined` y, al ser el
    parámetro `string`, **ni siquiera se puede pasar**: no hay respaldo silencioso y no hay forma
    de escribir el perfil del dueño ni por accidente. `434c6eb` y su arreglo. El suite ganó un
    **control por mutación** (se cambia el código a propósito para ver el test nuevo fallar), que
    es la primera evidencia de falsación de este trabajo.
  - [x] **T6a — El asistente de primer arranque, sin terminal.** Cuando el pi elegido es el propio
    y su perfil no sirve, el paso lo dice y ofrece las **dos puertas**, cada una ejecutando el
    comando que ya existe (`executeCommand`, sin copia de ningún flujo). El renderizador **dibuja y
    no decide**: decide el host, en una función pura. La fila de ajustes y el asistente leen el
    perfil con **una sola lectura compartida**, que es lo que evita que se contradigan. `35ac3fe`,
    28 suites. **Es la primera suite del asistente**: treinta suites cubrían esta extensión y
    ninguna cubría quién decide con qué pi arrancas tu editor.
    Texto, verbatim: «El pi propio de PiCode todavía no tiene perfil, así que nada ha cambiado: el
    editor sigue usando el perfil de tu equipo hasta que el perfil propio de PiCode tenga
    credenciales», con **Importar el perfil de tu pi** e **Iniciar sesión en un proveedor** debajo.
    Y una decisión de producto que merece quedar escrita: **no** copia la instrucción de la fila
    de ajustes («Usa «Importar el perfil de tu pi» para encenderlo») porque un botón debajo de la
    frase **ya es** la instrucción, y apuntar a una sola fila habría dejado fuera la puerta del
    login, que llegó después de escribir esa frase.
  - [x] **T6c — El primer arranque no puede saltarse la verdad.** Arreglado: el paso solo avanza
    cuando **no tiene nada que decir** (`message.ok && !profilePartVisible()`), y gana una salida
    propia —«Continuar con el perfil de tu equipo»— que vive **dentro** de la parte del perfil.
    Eso es lo que hace que la regla se sostenga con **un solo estado** en vez de dos: mientras la
    parte se ve, la salida está; y cuando una puerta deja el perfil usable, frase y salida
    desaparecen juntas, momento en que aplicar el pi vuelve a ser lo que avanza. Nunca hay un paso
    visible sin salida, ni una salida que se salte lo que el paso tenía que decir. `35ac3fe`+este.
    La suite **ejecuta** los dos comportamientos (con la parte visible el paso se queda y su botón
    llega al paso 2; sin nada que decir, avanza como antes) en un DOM de usar y tirar, en vez de
    inferirlos: la mejor evidencia de comportamiento de todo este trabajo.
  - [x] **T6b — Iniciar sesión en un proveedor, desde el editor.** `picode.piChat.loginProvider`
    («PiCode: Iniciar sesión en un proveedor»): pide el proveedor en los términos del dueño
    —diciendo si es **clave** o **suscripción**— y corre el login propio de pi contra el perfil
    de PiCode. El destino sale de `instanceAgentDir` y `selectedAgentDir` no aparece **ni una vez**
    en el fichero. Los finales no se colapsan: este pi no sabe iniciar sesión, cancelado, y
    **sincronización fallida** —que nombra proveedor y operación, advierte de no reintentar a
    ciegas y nunca lee la credencial—. `e463a3c`, 27 suites, 27 comprobaciones. Detalle que
    confirma que el puente no fue trabajo perdido: **pi pide la clave él mismo** (`type:"secret"`)
    y el puente lo convierte en campo que no ecoa.
    **El catálogo se descubre** (`getProviders()`, con `isUsingOAuth`/`isUsingSubscription`), así
    que no hay lista escrita a mano. **Desviación declarada**: el runtime se construye para el
    perfil destino (`createAgentSessionServices({cwd, agentDir: target})`) porque el de la sesión
    viva es privado en `pi-sdk-client.ts`; consecuencia real —los proveedores que registra una
    **extensión instalada en el perfil destino** solo aparecen si esos paquetes están ahí—, o sea
    que hoy, con el perfil interno vacío, la lista son los proveedores propios de pi y no los de
    `omni`/`nan`. Se resuelve importando (que trae esos paquetes) o compartiendo el runtime de la
    sesión, que exigiría `pi-sdk-client.ts` en las superficies.
- [ ] **T6 — El asistente sin terminal.** El de primer arranque se completa entero dentro del
  editor: importar (T3) o empezar de cero. Mientras T5 no exista, si el perfil interno está
  vacío lo **dice antes** de ofrecer ese camino, y no deja al dueño en un callejón sin salida.
- [x] **T7 — Pulido.** Lo que quedaba anotado, con lo que se hizo y lo que **se descarta a
  propósito**:
  - [x] **Un nombre para cada cosa.** El perfil del dueño se llamaba «el perfil de tu pi, el que
    ya tienes en el equipo» en la fila y «el perfil de tu equipo» en los dos cierres de la
    importación y en el asistente. Ahora es **«el perfil de tu pi»** en los cuatro sitios —las
    mismas palabras que la fila que el dueño pulsa—, incluida la salida propia del paso del
    asistente, que estaba en la misma pantalla y habría conservado el segundo nombre.
  - [x] **Un test fijaba la ortografía en vez del hecho.** `pi-settings.test.js` exigía el literal
    `instanceProfile(context.extensionUri, runtime.mode)` dentro de `extension.ts`, o sea que
    congelaba la lista de argumentos de un ayudante: un refactor de su firma rompía el test sin
    que nada estuviera roto. Ahora fija los dos hechos —el host registra una lectura del perfil y
    esa lectura pasa por el resolutor compartido— leyendo el **cuerpo** de la función registrada.
    Y se falsificó antes de creerlo: cambiar solo la lista de argumentos lo deja pasar (ya no
    prohíbe el refactor que lo motivó), mientras quitar el registro o dejar de usar el resolutor
    dentro de ese cuerpo lo hacen fallar.
  - [x] **T7b — La lista del login viene del perfil en vigor, y la escritura se queda donde
    debe.** La lista sale ahora del runtime de la **sesión en vigor** —el perfil que sí conoce
    los proveedores del dueño— y la credencial se sigue escribiendo en el perfil de PiCode, con
    su parámetro obligatorio intacto; el escritor **nunca** es el runtime vivo. Con sesión viva,
    abrir el comando **no construye nada** en el perfil propio (verificado con runtimes falsos:
    con sesión el constructor del destino se invoca 0 veces; sin ella, exactamente 1). El caso sin
    sesión puede crear la carpeta y el `auth.json` vacío, y ese coste está escrito donde está el
    respaldo en vez de dejarse para el descubrimiento. `2925caf`.
  - [x] **T7c — Sin callejón sin salida en inglés.** La lista mejor trajo un final peor: elegir
    un proveedor del perfil en vigor que el de PiCode no tiene —los de un paquete que el dueño
    instaló— fallaba con `Unknown provider: <id>`, en inglés y sin la salida a la vista. Ahora es
    una explicación en español que nombra la causa y el camino, con las palabras de la fila
    («Importar el perfil de tu pi»). Se reconoce **por forma** (nombre y código del error más el
    prefijo literal del mensaje), no por prosa: reconocer por prosa se pudre en silencio. Y una
    matriz de casos cercanos —un error normal, uno con el **mismo** código y otro mensaje, y algo
    que no es un objeto— demuestra que no se traga ningún otro fallo. Si pi renombra ese mensaje,
    el caso deja de reconocerse y el dueño ve el final genérico con el detalle de pi: degradar
    así es seguro, tragarse el fallo no. `2925caf`+este.
  - **Descartado a propósito, y queda escrito para que nadie lo «recupere»**: los **tamaños** en la
    importación y el **informe de la segunda importación** eran **ideas mías, no del dueño**. La
    importación ya informa elemento por elemento (copiado, sobreescrito, ausente, declinado,
    falló), y medir tamaños cuesta un recorrido recursivo del árbol de paquetes. Añadir cosas que
    nadie pidió es exactamente la redundancia que este dueño rechaza: se quitan del plan en vez de
    construirse por inercia.
  - Se queda anotado, sin tocar: el editor multilínea (`editor`) se responde cancelado con el
    porqué junto al código; la frase «Qué pi se ejecuta» está escrita en tres ficheros
    (`pi-settings.ts`, `menu.ts`, `instance-import-command.ts`), que hoy coinciden —riesgo de
    deriva al renombrar, no defecto visible—; y `readPin` (`runtime.ts:80`) hace
    `JSON.parse(readFileSync(...))` **sin** red, así que un `runtime.json` corrupto lanza. Es
    previo a todo esto, pero el aviso automático lo señaló al arreglar el espacio en la ruta:
    se arregla cuando alguien toque esa función, no de pasada.

## Evidence

- Work-unit commits, `npm test` green with per-suite counts on each.
- A live check that the internal and external profiles do not see each other: a package
  installed in one is absent in the other, and a provider configured in one is not offered
  by the other.
