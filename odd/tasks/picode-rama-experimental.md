# Feature: la rama `experimental`

## Goal

> «vamos a hacer una cosa, por ahora dejémoslo, pero planifica una rama "experimental"»
> «Esta rama créala cuando (como te pedí en la otra sesión) borremos todo el repo y dejemos todo
> lo actual en una rama Master y con 1 solo commit»

Planificar una línea de trabajo aparte para lo que **no toca el producto**, y hacerla nacer del
`master` limpio. **Estado: hecho el 2026-10-01** — local y publicado.

## Decisión

- **Pi Durable queda aparcado.** No se implementa ahora: es experimental, salió el mismo día que
  pi 1.0.0, no resuelve ningún problema que el editor tenga hoy, y cambiar el motor del chat
  dejaría a **gentle-ai sin dónde engancharse** (ver «Por qué no ahora»). *(Sigue siendo la decisión
  de `master`. El 2026-10-04 el dueño pidió probarlo dentro de la rama: ver «Registro».)*
- El camino barato sigue siendo el de siempre: **subir el pin de pi**. Ellos mismos dicen que las
  lecciones de Durable volverán al agente de código, y eso llega gratis por esa vía.
- La rama **`experimental`** nace del commit raíz de `master`. Es el vehículo para probar esto — y
  lo que venga — sin ensuciar `master`.

## Por qué no ahora (lo medido, para no re-litigarlo)

| Dato | Valor |
| --- | --- |
| Paquete | `@earendil-works/pi-durable@1.0.0`, publicado el **2026-10-01** (el mismo día que pi 1.0.0) |
| Estado | **Experimental**: ellos avisan de que la API puede cambiar |
| ¿Viene con pi? | **No**: comprobado dentro del paquete de pi 1.0.0, no hay ni rastro |
| ¿Depende del agente de código? | **No**: trae su propio motor de modelos y herramientas (deps: `pi-ai`, `chord`, `typebox`, `diff`) |
| Lo que reutiliza de PiCode | **Nada** de lo ya montado: proveedores, perfiles, MCP, credenciales y ajustes habría que rehacerlos sobre su API |
| Choque con gentle-ai | **Sí, por capa**: gentle-ai se engancha a la superficie de extensiones de **pi**; Durable tiene la suya (`defineExtension`, `defineTask`, `defineTool`). Una conversación corre sobre **un** motor, no sobre dos |

Y el detalle que lo resume: el ejemplo que enseñan (el planificador de vacaciones) son ~1.300
líneas y **la mayoría es interfaz**. Poner el chat del editor encima de esto es reescribir el motor
del chat, no enchufar una pieza.

## Por qué una rama aparte y no una rama de feature

Una rama de feature se abre para llevar algo a `master`. Esta no: es un **banco de pruebas**. La
diferencia importa porque PiCode tiene una regla que no se rompe desde una rama — **un solo Pi
dentro del editor, con agents, skills y gentle-ai**. Un experimento que cambia el motor es una
línea paralela, no una tarea.

## El reset del repositorio

### Local: hecho el 2026-10-01

- `master` es **un único commit raíz** («initial commit»), sin padres.
- Su árbol (`6018bd16`) es **idéntico al que había**, incluida la obra que estaba sin commitear en
  `cloud/sync-api`. Comprobado antes de firmar: el diff contra el tip anterior son exactamente esos
  6 ficheros, ni uno más.
- `experimental` nace de ese commit.
- Se borraron las ramas absorbidas (`docs/github-docs-wiki`, `feat/picode-distribution`,
  `feat/picode-foundation`, `feat/source-in-repo`).
- Red de seguridad intacta y **local**: ramas `backup-before-squash` (`fc15cb50`), `backup-final`
  (`a815a86e`), `backup-pre-reset` (`227a5ff9`), `backup-reset-2026-10-01` (`36b19e19`) y
  `.scratch/pre-reset-history-full.bundle` (43 MB, «records a complete history»).

### Remoto: hecho, con una salvedad

- Las tres ramas viejas se borraron: del remoto cuelga solo `master`.
- `origin/master` es **el mismo commit raíz** (un solo commit, 11.974 ficheros).
- El force-push necesitó levantar un *ruleset* que protegía la rama por defecto. GitHub lo rechazaba
  con «push declined due to repository rule violations», que **no** era falta de permisos sino una
  regla del repositorio.
- ⚠️ **Salvedad**: GitHub conserva además las referencias de sus *pull requests*
  (`refs/pull/*/head`: 15, todas **cerradas** y casi todas de Dependabot), y apuntan a commits
  viejos. No se borran desde `git`; solo desaparecen recreando el repositorio, o pidiéndolo a soporte
  de GitHub. Mientras estén, la historia vieja sigue siendo *alcanzable* aunque no haya ramas que la
  nombren.

## La rama

```bash
# ya hecha
git branch experimental master
# ¿subirla? decisión del dueño: por defecto NO (los experimentos no ensucian el remoto público)
```

## Contrato de la rama

1. 🚫 **Nunca se fusiona entera en `master`.** Si un experimento madura, se rehace como unidades de
   trabajo sobre una rama de feature desde `master`, con sus tests y su revisión (ODD).
2. 🧪 **Puede romperse** y seguir la API experimental de Durable: aquí el pin puede ir flojo y
   actualizarse a menudo; en `master` no.
3. 1️⃣ **No cambia la regla del único Pi.** Que un experimento funcione no convierte a Durable en el
   motor del editor: eso sería una decisión de producto, no un resultado de rama.
4. 🧩 **No exige gentle-ai.** Si un experimento necesita agents, skills o memoria de gentle, portarlos
   es trabajo del propio experimento, no un requisito de la rama.
5. 🧼 **No toca el perfil interno del producto** (`data/pi-agent`) salvo que sea el objetivo del
   experimento; lo normal es un perfil propio para no contaminar el del dueño.
6. ✅ `master` siempre construye; `experimental` **no tiene por qué**.

## El primer experimento

Un **programa aparte**, no el chat del editor: reutilizar la demo de ellos (el agente pequeño o el
planificador) y comprobar en la máquina del dueño las tres promesas que justifican todo esto:

1. una conversación **sobrevive al cierre del proceso** y sigue donde estaba,
2. un **subagente** es una tarea en segundo plano que no bloquea,
3. **dos clientes** se enganchan a la misma conversación en vivo.

Si eso no se sostiene en la práctica, la rama se borra y no se perdió nada.

## Qué decidiría si esto alguna vez importa

El umbral no es «me gusta». Es tener un producto donde el agente **corre solo y lejos del editor**:
agentes en la nube, varias personas sobre las mismas conversaciones, o algo que deba aguantar
caídas de verdad. Ahí Durable encaja y **no choca con nada**, porque sería **otra superficie**, no
el chat del editor. Antes de eso, este documento es la respuesta.

## Registro

### 2026-10-04 · el dueño reabre la línea y se prueba de verdad

El «aparcado» de arriba sigue siendo la decisión para `master`: **el motor del editor no cambia.**
Lo que cambió es que el dueño pidió probarlo, así que se ejecutó el primer experimento que este
documento describía.

**Ramas igualadas.** `experimental` era el commit raíz de `master`, de modo que igualarlas fue un
avance rápido: diferencias **0**. La rama sigue **local** (contrato 1: los experimentos no ensucian
el remoto público).

**🧹 Gentle fuera del producto** — commit `2ac4e68d` (28 ficheros, +171 / −2116).

| Comprobación | Resultado |
| --- | --- |
| Typecheck del conector y del proyecto de tests | exit 0 |
| Typecheck del núcleo | exit 0 |
| Tests del conector | 173/173 |

Se fueron con él dos superficies que existían **leyendo su runtime**, no por ser suyas: las tarjetas
de subagentes en vivo del chat y la lista de tareas de la sesión. Y un hueco real que no se había
visto: las carpetas `skills/` y `agents/` del perfil las registraba **la propia instalación de
gentle**, así que ahora no las registra nadie.

**🧪 pi-durable, probado** — commit `86fcdeae`, en `experimental/durable/`: un programa aparte, como
pedía este documento. JavaScript plano sobre `pi-durable@1.0.2`, contra el gateway de la casa. El
perfil se lee **solo lectura** y no se copia ninguna credencial.

| Promesa | Resultado medido |
| --- | --- |
| Sobrevive a un kill | `taskkill /F` a mitad de turno → el proceso nuevo retoma la **misma** submission y termina (`RUN-COMPLETED-AFTER-RESUME`) |
| Subagente en segundo plano | el padre responde `PARENT-NOT-BLOCKED` mientras el hijo trabaja, y recibe su informe después |
| Dos clientes, una conversación | A: 48 eventos, B: 30 (se enganchó a mitad); los dos vivos hasta el final |

Se ejecutan con `node smoke.js`, `node proof1-kill.js` + `taskkill` + `node proof1-resume.js`,
`node proof2-subagent.js` y `node proof3-two-clients.js`.

#### Lo que enseñó la API (trampas silenciosas, ninguna en la documentación)

- 🔍 **El `baseUrl` va por modelo, no por proveedor.** Sin eso, pi-ai manda las peticiones al OpenAI
  de verdad — y el 401 en `/v1/models` es una pista falsa.
- 📌 `settled.answer` es un **id de entrada**, no el mensaje.
- ⚠️ **Lo que devuelve el manejador de una tarea se convierte en su estado siguiente**: devolver el
  id de la conversación hija corrompe el checkpoint.

#### La restricción que decide la arquitectura (y que la spec no impone)

🚧 La spec dice que **un solo proceso es dueño del storage**, y por eso «dos clientes» eran dos
`watchEvents` sobre **un** harness. **Medido el 2026-10-04, con dos procesos y una sonda propia:
no es verdad.** Los dos abrieron el mismo SQLite y los dos **escribieron** — el invariante no lo
impone el runtime. El daño es real: dos escritores repartieron el mismo id
(`ID 368 already belongs to conversation`) y esa sesión se quedó envenenada
(`Session is poisoned by a failed commit after storage admission`) hasta reiniciarla.

Así que el daemon no está porque SQLite vaya a negarse: está porque **nadie se niega**, y el fallo
es silencioso y caro. Es lo que hay que resolver antes de pensar en el editor.

#### Abierto

- Reponer las dos superficies del chat que se fueron con gentle, esta vez sobre durable.
- El daemon dueño del storage, para más de un cliente a la vez. *(Hecho: ver más abajo.)*
- El puente de MCP: `pi-mcp` no forma parte de durable, así que las tools habría que envolverlas con
  `defineTool`.
- Y la alternativa barata sigue en pie: **subir el pin de pi** en `master` y no portar nada.

### 2026-10-04 · segunda tanda: el agente, MCP, los ajustes y el daemon

Cinco commits más sobre la rama, todos verificados **ejecutando**:

| Commit | Qué añade |
| --- | --- |
| `4d340e16` | **Agente usable**: `run` / `sessions` / `resume` / `fork` / `attach` / `allow`, y un **guard determinista** que bloquea en código los comandos destructivos. Probado de verdad: el directorio y su fichero existían antes y **sobrevivieron** al intento de borrado |
| `ce5fafa4` | **Puente de MCP** con la librería de MCP del propio pi: 11 servidores configurados, **8 conectados**, **174 tools**. Declararlas son **238,7 KiB** por petición; **diferidas, 1,1 KiB**, y el modelo las encuentra buscando |
| `0bffeff9` | **Las opciones en los ajustes de PiCode** (`picode.durable.*`), con `flag > ajuste > defecto`. El interruptor del guard **era una mentira** — apagaba el texto pero el hook seguía bloqueando: lo cazó una ejecución, no una lectura del código |
| `2e7c8734` | **El daemon**: un dueño del storage y clientes por un pipe local. `attach` deja de sondear y pasa a recibir eventos **en vivo**; `send` corre prompts por el daemon; dos clientes distintos ven los mismos eventos a la vez |
| `b2936dec` + `68927b96` | **OAuth de solo lectura, y solo del perfil interno**: los tokens se leen del perfil en vigor (`data/pi-agent/`), **nunca de `~/.pi`**; un acceso caducado o ausente dice que ese perfil necesita un login y que todavía no hay nada que lo haga. **No se escribe ni se renueva nunca** — un refresh consume la rotación. Comprobado con hash: el `mcp-auth.json` externo intacto, y el interno sin crear. Precio visible de la regla: `sentry` conectaba con 14 tools mientras se tomaba prestado un token externo, y ya no |
| `d424e5dc` | **El editor ve durable**: sección *Durable* en el panel de estado (daemon, conversaciones, de subagente, streams vivos) y cuatro comandos —arrancar, parar, listar/abrir, enviar un prompt— con la transcripción en un canal de salida. Los ajustes dejan de decir «el editor todavía no lo ejecuta» |
| `8474f4e3` | **pi + durable, demostrado**: una extensión que pi carga del repositorio le delega trabajo al daemon. La prueba: pi arranca seis pasos lentos, **se mata pi con `taskkill /F /T` a mitad**, el daemon termina el trabajo que le habían entregado, y un pi nuevo lee la conversación terminada y su respuesta. Sobre **el pi interno de PiCode**, no el de `~/.pi` |
| `c1730982` | **Vuelven las dos superficies que se fue gentle**: las tarjetas de subagente del chat (pintadas por el propio agente de chat, en la forma que la UI ya sabe dibujar, con la **identidad de durable** dentro) y la lista de trabajos del panel, con el único estado que el protocolo sostiene — `run` presente es *in flight*, ausente es *idle*, y lo que no se pudo leer lo dice |
| `8fac64d0` | **ACP v1** sobre el daemon: `initialize`, `session/new`, `load`, `list`, `prompt`, `cancel` y **permisos**. La joya: el guard determinista deja de bloquear en silencio y **pregunta al cliente** (`allow_once` / `allow_always` / `reject_once`), y la misma orden puede quedar bloqueada antes de correr o ejecutarse, según lo que se conteste. Sin cliente escuchando, el bloqueo de siempre — por eso `proof-daemon.sh` sigue pasando igual |
| `b9c26e35` | **Build al lado, no encima**: `PICODE_PACK_SUFFIX` empaqueta en otra carpeta (la tarea de empaquetado hace `rimraf` de la suya) y `PICODE_SKIP_INSTALLER` no genera instalador, porque instalarlo pisaría el PiCode que el dueño ya usa. Ambas vacías por defecto: una build normal no cambia |

**La respuesta a «pi + pi-durable», medida construyéndola:** no es un motor —los dos no
componen— sino un **reparto**: pi sigue siendo el que conduce, y lo que no puede perderse se le
entrega a durable, que es quien tiene la caja negra. Lo que el híbrido **no** da, y va escrito en
su README: la sesión propia de pi sigue sin ser a prueba de caídas; solo sobrevive lo delegado. Y
las tarjetas de subagente del chat siguen fuera, porque eso exige que el chat corra sobre durable
o sobre ACP: es el cambio de motor, y no se ha hecho.

Y la premisa que justificaba el daemon **resultó falsa al medirla**: el «un proceso es dueño del
storage» de la spec **no lo impone el runtime**. De ahí el daemon, y de ahí la corrección que está
más arriba en este documento.

**Trampas de la API encontradas hasta aquí** — todas silenciosas, ninguna en la documentación:
`baseUrl` va por modelo y no por proveedor; `settled.answer` es un id de entrada, no el mensaje; lo
que devuelve el manejador de una tarea se convierte en su estado siguiente; el `Harness` no tiene
`scanConversations` aunque lo documente; el filtro `tools` quiere `{name}` donde la spec y los tipos
dicen cadenas; y el dueño único del storage no se cumple.

### 2026-10-05 · lo que reporta el dueño, sin arreglar todavía

Cinco cosas, tal como las dijo, para que no se pierdan. Ninguna está hecha.

1. **`/mcp ` con espacio** da sus opciones en la TUI de pi; el chat del editor **no** ofrece los
   comandos de pi con argumentos. Pi tiene el comando (el connector builtin ya se carga), pero la
   lista de comandos del chat no lo incluye.
2. **`PiCode: Status` → «Which pi»** debe pasar a llamarse **«Host»** y decir si es **interno o
   externo**; fuera el texto «picode's owns pi».
3. **Clic en un MCP que dice «need sign-in»** debe **hacer login**, no apagarlo. Hoy el clic
   alterna el interruptor, y la acción que hace falta es la de autenticarse.
4. **Clic en una sesión guardada** debe dar **todos los datos de una vez**, sin esperar a que el
   dueño escriba algo para que aparezca el contenido.
5. 🔴 **sentry, vercel y otros piden login otra vez** cada vez que se cierra y se abre el editor.
   La credencial no persiste. Es el de fondo de los cinco.

Y una sexta, aparte de PiCode y explicada: **el sync no conecta**. El esquema `picode://` lo
registra la app **instalada** (lo declara su instalador en Windows), así que la build portable no
es dueña de él: al pulsar «Backup and Sync Settings» el sistema entrega la URL **a la instalada**
—por eso abría la beta— y al desinstalarla **no queda nadie escuchando** el esquema, de ahí que no
conecte y que no haya nada en el log: no falla la sincronización, falla que no hay manejador. Una
build portable necesita o registrar el esquema para sí misma o servir el flujo por otra vía.

### 2026-10-05 · jornada larga: de «pi-durable probado» a «todo funcionando en el editor»

Todo lo de abajo está **hecho y verificado ejecutando**, no leyendo. Los commits están en la rama.

**El editor ve y usa el agente**

| | Qué |
| --- | --- |
| `d424e5dc` | Sección **Durable** en el panel + cuatro comandos (arrancar, parar, listar, enviar) |
| `8474f4e3` | **pi + durable demostrado**: se mata pi con `taskkill /F /T` a mitad y el daemon termina el trabajo; un pi nuevo lo lee |
| `e1663a49` | El daemon **muere con PiCode** por un **latido** (un tubo, no un pid). Medido: 465 ms ordenado, 229 ms si te matan, 96 ms al cerrar el tubo. Y pararse no pierde nada |
| `8fac64d0` | **ACP v1** sobre el daemon: `initialize`, `session/new`, `load`, `list`, `prompt`, `cancel` y **permisos** — el guard determinista deja de bloquear en silencio y **pregunta al cliente** |
| `c1730982` | **Vuelven las dos superficies** que se llevó gentle: tarjetas de subagente y lista de trabajos, con la identidad de durable dentro |

**Los MCP del chat, de rotos a útiles**

| | Qué |
| --- | --- |
| `ce5fafa4` | Puente de MCP: 8 servidores, 174 tools. Declararlas costaban **238,7 KiB** por petición; **diferidas, 1,1 KiB** |
| `68927b96` | Las credenciales se leen **solo del perfil interno**; el pi externo no se lee (precio: `sentry` fuera) |
| `95bded14` | **El chat no cargaba las builtin de pi**: una línea nuestra las sustituía en vez de fusionarlas. Ahora **52 herramientas MCP** conectan |
| `98cfad9c` | El estado dice la verdad: **On / Needs sign-in / Off**, y `github` sigue On porque se autentica solo |
| `f03fb127` | **Las credenciales se iban al pi externo**: pi escribe en `~/.pi/agent` cuando nadie le dice otra cosa (`config.js:491`). Ahora el editor lanza su `mcp login` con el perfil de PiCode |
| `7d1fe848` | **`spawn cmd.exe ENOENT`**: pi lanza los MCP con el cwd de la sesión, y la primera carpeta del workspace (`guildboard`) **no existe**. Una carpeta que falta ya no puede tumbar los servidores, y el error nombra **el directorio**, no el comando |

**Chat y sesiones**

| | Qué |
| --- | --- |
| `d5603683` | **`/mcp` llega al chat** (el mismo bug de las builtin, en la sesión de descubrimiento). Y **las sesiones guardadas no se listaban**: el chat archivaba en la raíz de `sessions/` y el listado solo mira carpetas por proyecto |
| `d2ce7c68` | **Sesiones del área**: en modo workspace la sesión es del área (archivado propio), el contexto nombra **todas las raíces** con su regla de direcciones, y la lista va **agrupada por proyecto** (8 de cada uno) |

**Y lo que sostiene todo**

| | Qué |
| --- | --- |
| `2ac4e68d` | **gentle fuera del producto** (28 ficheros, +171/−2116) y el **import deja sus paquetes atrás** |
| `4ddcea9d` | El import **no arrastra** `gentle-pi` ni `gentle-engram`, ni deja sus declaraciones |
| `28166df4` | **Ninguna instalación de paquetes abre ventana**: era pi instalando uno por paquete con `stdio:"inherit"` y sin `windowsHide`. Y los nombres de paquete pasan por **lista blanca** antes del shell |
| `efc7f662` | **El empaquetado ya no borra `data/`**: lo aparta, empaqueta y lo devuelve. Con un fichero bloqueado **para limpio sin borrar nada**, y una build muerta se recupera sola |
| `cbd72bad` | **El sync tenía un manejador muerto** en el registro (una beta desinstalada) y una build desde carpeta no registraba el esquema. Ahora se registra, repara entradas muertas y **no se calla** |
| `a1af1d55` | **pi se queda en 1.0.2**: el árbol de 1.0.3 no instala — su `pi-telemetry@^1.0.2` resuelve a 1.0.4, anunciado en el registro y con el tarball en **404** |

**Lo que NO está, y por qué**

- ⌨️ Las opciones de `/mcp` **por pulsación**: la API de comandos del chat no tiene enganche por tecla. Está escrito en `commands.ts`, con la pista estática como lo más cerca que se puede llegar.
- 🖼️ El icono de la barra de tareas: **no estaba roto** — los iconos llegan y el `.exe` lleva el de PiCode; lo que falla es la **caché de iconos de Windows**.
- 🪟 La carpeta `PiCode-Win32-x64 - experimental` quedó a medias con un handle vivo; se limpia con un reinicio.
- 🔄 El **sync** necesita una comprobación del dueño: abrir la build una vez y ver `Registered the picode:// protocol handler: …` en el log.

### 2026-10-05 · requisito del dueño: actualizar el host y los paquetes

> «quiero que se pueda actualizar el pi interno, si sacan una versión nueva, me explico?, esto es
> importante, luego si fallan cosas es otro tema.»
> «Al igual que los packages, quiero saber si hay actualizaciones y poder actualizarlos.»

Dos capacidades, y son **dos**:

1. **El host (pi) se puede actualizar.** Existe el aviso —ofreció *«pi update to 1.0.4 available
   (now 1.0.2)»*— y el botón, pero el botón está roto: la ruta del runtime se parte por los
   espacios al pasar por el shell (`--prefix "…\PiCode-win32-x64" "-" "experimental2\resources\…"`),
   así que npm recibe un directorio que no existe. Latente desde siempre y destapado por el sufijo
   `" - experimental2"`; en una ruta con espacios —`Program Files`, un usuario con espacio— le pasa
   a cualquiera. **Importante**: el dueño quiere que la actualización **funcione**; si después
   fallan cosas con esa versión, es otro asunto.
2. **Los paquetes: saber si hay actualización y poder actualizarlos.** Hoy la página de *Packages*
   lista e instala; lo que falta es **decir cuál tiene versión nueva** y **poder actualizarlo**
   desde ahí, no solo reinstalarlo.

Ojo con lo que el botón hace hoy: instala **el último de npm**, no el que fija el repo — y ese
último puede traer árboles que no instalan (a `pi-telemetry@1.0.4` le responde **404** el registro).
Que falle por eso es un tema distinto del de la ruta, y conviene que se lea como tal.

### 2026-10-05 · «¿se pueden ver los agentes que lanzamos, como con /agents?»

**Lo que ya hay**: las **tarjetas del chat** (una por delegación, en su conversación) y la sección
**Durable** del panel, que lista las conversaciones de subagente y los streams vivos.

**Lo que falta**: **un solo sitio** con todo lo lanzado y su estado, esté o no abierta la
conversación de origen — que es lo que da `/agents` en la terminal.

**Es posible, y no necesita maquinaria nueva**: el daemon ya conoce sus conversaciones y sus tareas
en vuelo, y pi sus llamadas de herramienta. Lo que falta es **la vista que las junta**: qué se
lanzó, en qué estado, y poder entrar a verlo.

**Lo que NO se puede prometer hoy**: en el chat, cada sesión nueva arranca **sus propios** MCP y su
propia sesión de pi, así que "los agentes" no son un conjunto global hasta que todo lo delegado
pase por el daemon, que sí es un único proceso y un único sitio donde mirar.
