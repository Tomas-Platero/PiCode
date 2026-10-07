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

### 2026-10-06 · «la parte de "sesiones" del chat se refresca mucho, cambia, pierde sesiones, vuelven a aparecer»

**Lo que estaba pasando, medido** (perfil interno del dueño, 6 de octubre): 164 transcripciones
en los tres proyectos abiertos = **56 conversaciones + 108 agentes**. El panel enseña **8 filas por
proyecto**, y esas 8 se las comían los agentes: en el grupo del repo, **las 8 más nuevas eran 6
agentes y 2 conversaciones**. Cada prompt que lanzaba tres agentes escribía tres transcripciones
nuevas, el tope se gastaba en ellas y las conversaciones del dueño **salían de la lista** y
volvían cuando el agente viejo dejaba de ser el más reciente. Eso es «pierde sesiones, vuelven a
aparecer», literalmente.

Debajo había tres mentiras más, todas del propio listado:

| Qué decía el listado | Qué era verdad |
| --- | --- |
| Nada, pero **republicaba todo en cada refresco** (fabricaba fila nueva siempre) | El puente del editor compara las filas **por referencia** y salta el trabajo entero si el delta viene vacío. Repintar las 8 filas cada vez que el editor pregunta es lo que se ve como parpadeo |
| Una transcripción que no se puede leer **ahora** decía ser de 1970 y llamarse como su uuid | pi escribe en la transcripción **viva** mientras el panel mira. Mentir con la fecha y el nombre la renombra, la manda al final y, con el tope de 8, **la saca de la lista** hasta el refresco siguiente |
| El orden de los empates de fecha lo decidía el directorio | Dos ficheros escritos a la vez (una importación trae un árbol entero) quedan en el orden que a `readdir` le apetezca; una lista que se reordena sola es una lista que no se puede leer |

Y una que sí era una decisión, tomada al revés: **el tope de 8 contaba agentes**. Un agente no es
una conversación: su transcripción no pertenece a *Sessions*.

**Lo que hay ahora**

| Commit | Qué cambia |
| --- | --- |
| `5b531f90` | Una lista que no parpadea: filas reutilizadas cuando no cambian, mtime y nombre recordados cuando la lectura falla, y orden determinista (fecha, luego id, luego ruta) |
| *(este)* | **Los agentes salen de la lista de conversaciones** y tienen la suya |

**La vista de agentes** (`picode.agents`, y su fila *Launched agents* en el panel de estado):

* **Un solo sitio** con todo lo lanzado desde los proyectos abiertos, esté o no abierta la
  conversación que lo pidió: etiqueta (el encargo del agente), de qué conversación salió, y hace
  cuánto trabajó por última vez.
* **El estado se lee, no se adivina**: `answered` cuando la última entrada de su transcripción es
  la respuesta del propio agente; `working` cuando le quedó algo por responder (su última entrada
  es tuya o de una herramienta); `empty` cuando no se le pidió nada todavía. No hay ningún reloj
  metiendo la pata: en los 129 subagentes del perfil, los 123 acabados terminan en `assistant` y
  ninguno en mitad de un turno.
* **Se entra**: elegir uno abre su transcripción en el chat, en solo lectura, igual que pulsar
  una sesión en el panel. Es la misma resolución de editor que usa el panel, no un camino nuevo.
* **Lo que no promete**: el daemon durable sigue siendo su propia sección, con su verdad (un run
  en vuelo o ninguno); esta vista es lo que pi ejecutó dentro de este editor.

**Verificado ejecutando** (no leyendo):

* `node --test picode-source/extensions/picode/test/*.test.ts` → **345 tests, 345 pasan, 0 fallan**
  (13 nuevos entre `agents.test.ts`, el listado y el tope por grupo). Los tests nuevos del listado
  se ejecutaron **contra el código viejo** y fallan allí: son prueba, no adorno.
* `tsc --project picode-source/extensions/picode/tsconfig.json --noEmit` → **exit 0**.
* Sobre el perfil real (`.scratch/agents-evidence.ts`): de 164 transcripciones salen **56
  conversaciones y 108 agentes**; las 8 filas del panel pasan de «1 conversación + 7 agentes» a
  **8 conversaciones**.
* `PICODE_PACK_SUFFIX=" - experimental" ./dev/build-run.sh` → **exit 0** en 8m 22s. `PiCode 1.135.5`
  staged en `PiCode-win32-x64 - experimental/` con el conector nuevo dentro (`out/agents.js`,
  `reuseRows` y `picode.agents` en el paquete), y el perfil del dueño intacto: apartado durante el
  pack y devuelto con **57 632 ficheros y 261 transcripciones**.

**Lo que sigue sin estar**: el slug del área se recalcula con la lista de carpetas cada vez, así
que una carpeta que se abra o se cierre **refila** la sesión viva (agente `agent.ts`, `scopeChanged`).
Anotado como el primer punto de la próxima sesión.

### 2026-10-06 (tarde) · «y salen menos»: una lista que no se pudo construir no es una lista vacía

> «Mira primero me sale esto y luego esto: y salen menos.»

**Lo que enseñan las dos capturas, medido**: la primera son **11 filas de pi + 3 locales = 14**
(TODAY 2 + YESTERDAY 12), que es **exactamente** lo que produce el código nuevo para esa ventana
— área 1 + `ArticTempest-Web` 8 + `artictempest-bot-dashboard` 2 (`.scratch/panel-now.ts`, contra el
perfil real). La segunda son **solo las 3 locales**: su etiqueta es el mensaje del dueño, no el
texto del fichero, así que no las produce el proveedor de pi. Es decir: el proveedor **devolvió cero
filas** en una ventana donde debía devolver once.

**La causa está en el log del propio editor**, en la sesión que el dueño estaba mirando:

```text
23:02:58.871  Extension host started
23:02:58.911  activating picode.picode            (onChatParticipant:picode.pi)
23:04:05      host terminating
```

El proveedor se registra **al activarse la extensión**, y el panel refresca justo ahí — en el
primer segundo de una ventana que vivió 67. Si en ese instante `workspaceFolders` todavía no está
resuelto, el listado no se puede construir, y el código publicaba esa imposibilidad como
**«estos proyectos no tienen sesiones»**. Y el panel se lo cree: `computeItemsDelta` convierte una
fila ausente en un **borrado**. Como nada más dispara un refresco, la lista se quedaba vacía.

Es el mismo defecto del parpadeo, un paso más afuera: **el vacío es una afirmación**, y solo es
verdad cuando los proyectos se conocieron y se recorrieron.

**El arreglo** (`8b420586`):

* `listingForPanel` — mientras las carpetas son **desconocidas**, la respuesta honesta es el último
  listado real; cuando ya se conocen, el vacío se publica porque entonces sí es un hecho sobre los
  proyectos y no sobre nuestra propia ignorancia. Los tres casos están probados como función pura.
* **Suscripción a `onDidChangeWorkspaceFolders`** que dispara el evento del proveedor: una ventana
  cuyas carpetas llegan después de la primera pregunta vuelve a ser preguntada. Sin eso, el panel
  se quedaba con la respuesta que recibió mientras el workspace cargaba.

**Verificado**: 346 tests, 346 pasan, 0 fallan; typecheck exit 0; y contra el perfil real el listado
de esa ventana sigue dando las mismas 11 filas (no se pierde nada por el camino).

**Lo que NO se ha reproducido**: la segunda captura en sí. Se explica por lo de arriba y encaja con
los tiempos del log, pero no se ha visto el fallo en vivo — queda dicho como lo que es.

**Y una tercera cosa que la primera captura enseñaba sin decirlo** (`d5ae5e86`): **siete filas con la
misma etiqueta**, «You are pi, the coding agent that runs insi…». El editor pone ese marco delante de
cada mensaje (`withContext`, `context.ts`) y el listado tomaba como título el primer texto del
usuario — que es el marco, idéntico en todas. Una lista donde todas las filas dicen lo mismo no la
puede leer nadie, y es exactamente la redundancia que el dueño tiene por regla. Ahora la etiqueta es
**lo que escribió él**:

```text
antes:  "You are pi, the coding agent that runs insi…"   ×7  (todas iguales)
ahora:  "Hola puedes ver el espacio de trabajo?", "hey", "hola de nuevo", "hola!", …
```

Sin adivinar y sin duplicar frases: lo que se busca es el separador que `withContext` pone, y solo
cuando lo que va delante dice de dónde viene («PiCode editor») — así una línea horizontal escrita por
el dueño no se confunde con un marco. Una conversación escrita por el pi de la terminal no lleva
marco y conserva su texto entero.

**Cierre del día (build definitivo)**: `exit 0` en 5m 38s, con **347 tests / 347 pass / 0 fail** y
typecheck en 0. El paquete `PiCode-win32-x64 - experimental` lleva pi **1.0.4**, el listado arreglado
(`reuseRows`, `listingForPanel`, `ownerPrompt`, `conversationFiles`), el módulo de agentes y su fila
*Launched agents*; el perfil del dueño intacto en **57 595 ficheros y 261 transcripciones**; y el
validador de MCP del pi que va dentro acepta los **12** escritores de PiCode.

### 2026-10-06 (noche) · «me salen sesiones tanto de proyectos (carpetas) como del workspace»

> «Yo solo quiero ver si estoy en un workspace las de workspace y sale "artictemepst (workspace)
> (workspace area)". Ese doble workspace queda feo.»

**Lo que estaba mal, y eran dos cosas:**

1. El panel partía las sesiones de la ventana en **varias listas** — el grupo del área primero y
   luego uno por carpeta, cada uno con su tope. Una ventana es **una** cosa.
2. **Cada fila llevaba su etiqueta de grupo**, y la del área decía
   *«Artictempest (Workspace) (workspace area)»* — la misma palabra dos veces en cada fila, que es la
   redundancia que el propio registro del proyecto tiene por regla.

**Ahora (`36460c2f`)**: **una sola lista**, la de los proyectos que la ventana cubre
(`projectSlugsOfWindow()`: el slug del área, luego el de cada carpeta abierta), de más nueva a más
vieja, con tope. **Ninguna sesión de un proyecto que no esté abierto puede aparecer**, que es la
mitad de su frase que más importa. Y **sin etiqueta por fila**: el título y la fecha son lo que
distingue dos filas — que es justo lo que el arreglo anterior hizo legible.

El tope pasa a ser **un solo número** (`PI_SESSIONS_LIST_CAP`): un tope por proyecto dejó de
significar nada en cuanto el panel dejó de ser varias listas. Y sigue contando **conversaciones**,
nunca agentes: un transcript de agente se filtra **antes** del tope.

`listSessionGroups` y sus dos tipos se **borran** en vez de quedarse sin usar, y las reglas que
codificaban son ahora la de una sola función, probada (`session-listing.test.ts` sustituye a
`session-groups.test.ts`).

**Verificado**: 352 tests, 352 pasan, 0 fallan; typecheck exit 0.

**Y el tope se fue con los grupos** (`6103d79f`): existía para que «un proyecto muy ocupado no
convirtiera el panel en una lista interminable» — el deseo del dueño **cuando el panel eran varias
listas**, una por proyecto. Con una sola lista no hay grupos que acotar, y un tope escondería las
filas viejas **sin nada que diga que existen**: exactamente la lectura que él ya reportó como «salen
menos». Medido en su perfil, esa ventana tiene **36 conversaciones** y el panel enseñaba ocho; ahora
enseña las 36, en un panel que hace scroll y tiene buscador. El tope sigue existiendo como parámetro
de `listProjectConversations` (y sus tests), para quien quiera acotar.

#### Lo que se midió de paso: el árbol npm del perfil

Durante estas horas el perfil pasó de **57 595 ficheros a 27 705**, y no fue ningún build: el propio
editor escribió `<perfil>/npm/package.json` y su `package-lock.json` a las **23:56**, en una sesión
que abrió a las 23:53 — es **pi instalando y podando** su árbol npm, que es lo que hace al asegurar
sus paquetes declarados. Lo que importa, comprobado: **los 16 paquetes declarados siguen ahí y
resuelven** (`piPackages` → 16 filas, 0 avisos), `pi-interactive-subagents` sigue teniendo su copia
npm además de la git (o sea, el duplicado que se arregla arriba era real y sigue siéndolo), y las
261 transcripciones, los agents, las skills, `models.json`, `auth.json`, `mcp.json` y `mcp-auth.json`
están intactos.

### 2026-10-06 (noche) · el paquete que salía dos veces en la página de Packages

> «Por cierto revisa el error de ese package.»

La página enseñaba `pi-interactive-subagents` **dos veces**: una `Enabled` desde
`github.com/HazAT/pi-interactive-subagents`, y justo debajo otra con *«Not declared — Installed on
disk; pi does not load it»*. Mismo nombre, misma versión 3.7.2, y dos cosas contradictorias sobre
un solo paquete.

**No era la página mintiendo sobre lo que encontraba**: era el listado contando **directorios**
donde pi cuenta **paquetes**. Medido en el perfil del dueño, las dos copias existen y las dos tienen
su razón: la settings declara `git:github.com/HazAT/pi-interactive-subagents` (que se materializa en
`<perfil>/git/…` y es **la que pi carga**), mientras el npm root de pi lleva
`"pi-interactive-subagents": "github:HazAT/pi-interactive-subagents"` como dependencia, así que npm
dejó la misma copia en `<perfil>/npm/node_modules/`.

**El arreglo (`7ef50fbb`)** colapsa por **nombre de paquete**, y el orden es lo que lo mantiene
honesto:

1. **Toda declaración es una fila.** Una declaración es una instrucción que pi lee; dos
   declaraciones del mismo paquete son dos instalaciones, y esconder una escondería algo que el
   dueño puede tener que quitar.
2. **Un directorio que ninguna declaración nombra es una fila solo si nada más lista su paquete.**
   Esa es la copia que pi **no** carga, y con una copia basta para decirlo. Gana la primera por ruta,
   para que dos lecturas de un perfil sin cambios contesten lo mismo.

Lo que quita la mitad 2 es **fontanería**, no un estado sobre el que actuar: la copia descartada es
un árbol npm resolviendo una dependencia del propio pi, y el paquete que contiene se lista una vez,
desde la copia que carga.

**Medido en el perfil real** (`.scratch/packages-evidence.ts`): la página pasa de **17 filas a 16**,
que son exactamente sus dieciséis declaraciones, con `pi-interactive-subagents` listado **una vez** y
apuntando a la copia git.

**Verificado**: 352 tests, 352 pasan, 0 fallan (tres nuevos: el duplicado con declaración, dos copias
sin declaración contestando lo mismo dos veces, y dos declaraciones del mismo paquete quedándose en
dos filas); typecheck exit 0.

### 2026-10-07 (madrugada) · el build que murió por abrir el editor, y el rebuild de cero

> «Quiero que buildee de 0 experimental, cárgate todo, no pasa nada, rebuildea todo para ver los
> cambios. Olvídate de mi perfil, no quiero guardarlo, quiero que esté de 0. Quiero reinstalar, volver
> a hacer el onboarding, todo.»

**Lo que pasó, en orden, porque el orden es la lección:** el build del 00:16 arrancó con **cero**
procesos de PiCode (la comprobación del contenedor pasó). A las **00:19:42** el dueño abrió el editor
desde esa misma carpeta y a las **00:19:45** el build intentó borrarla: `EBUSY: resource busy or
locked, rmdir 'PiCode-win32-x64 - experimental'`. El build murió **sin** haber destruido nada
—el pack no llegó a escribir— y la **red de seguridad de `dev/build.sh:201` funcionó**: al fallar con
el perfil en el `-data-hold`, lo devolvió a `data/`.

El daño no vino del build: vino de que el dueño pidió borrar todo y se borró la carpeta entera. **Su
perfil (261 conversaciones) se fue con ese borrado**, por decisión suya y dicha así. Sobreviven dos
copias antiguas en `.scratch/` (`exp-data-now`, 255 conversaciones; `exp-data-backup`, 254), que se
le dijeron antes de seguir.

**La comprobación que faltaba (`db71d7db`)**: el contenedor pregunta si hay un editor abierto al
**empezar**; abrirlo a mitad no lo cazaba nadie. Ahora se pregunta otra vez justo antes de la fase
del pack —antes de apartar el perfil y antes del borrado— donde parar **no cuesta nada**: nada movido,
nada borrado. La función (`picode_editor_running`) vive junto al perfil al que protege
(`dev/data-hold.sh`) y la usan los dos sitios, para que «¿hay un editor abierto?» tenga una sola
definición. **Probado en las dos direcciones**: sin editor, el build sigue (este mismo rebuild llegó a
exit 0); con el editor abierto, bloquea — medido lanzando el editor recién empaquetado y volviendo a
preguntar.

**El rebuild de cero**: carpeta borrada, `PICODE_PACK_SUFFIX=" - experimental" ./dev/build-run.sh`
→ **exit 0** en 5m 0s, y el paquete nuevo lleva:

| Qué | Comprobado en el paquete |
| --- | --- |
| pi | **1.0.4** |
| Lista de sesiones | `listProjectConversations`, `listingForPanel`, `ownerPrompt`, `reuseRows`; `listSessionGroups` **fuera** |
| Paquetes | `oneRowPerPackage` |
| Agentes | `out/agents.js` y `picode.agents` en el manifiesto |
| Perfil | **de cero**: un solo fichero (el `settings.json` de fábrica), sin `pi-agent`, sin marca de onboarding |

Es decir: arranca como una instalación nueva y pide el onboarding, que es lo que pidió. El dueño lo
abrió, hizo el onboarding y **está importando** desde el pi externo — así que en el perfil aparecieron
sus 269 transcripciones **por su propia importación**, no por ningún proceso automático. La regla se
mantiene: importar es una decisión suya, nunca algo que el producto haga solo.

#### Y el build de cierre, con las dos cosas de esta madrugada

`exit 0` en 5m 4s, con el editor cerrado (y esta vez **el build lo comprobó por sí mismo** antes de la
fase del pack, que es el arreglo de arriba). El paquete `PiCode-win32-x64 - experimental` lleva,
verificado sobre los ficheros compilados:

| Qué | Comprobado |
| --- | --- |
| pi | **1.0.4** |
| Sesiones: en un workspace, solo el área | `listedSessionSlugs` y `windowSessionSlugs` |
| Lista de conversaciones | `listProjectConversations`, `listingForPanel`, `ownerPrompt` |
| Agentes | `out/agents.js` + `picode.agents` en el manifiesto |
| Paquetes | `oneRowPerPackage` |
| MCP a demanda | `"chat.mcp.autostart": "never"` en el perfil de fábrica empaquetado |
| Perfil del dueño | **57 127 ficheros y 270 conversaciones** (una más: la suya de después del rebuild de cero) |

**Lo que el dueño debe saber al abrirlo**: las 270 conversaciones que importó están archivadas por
**carpeta**, así que **no salen en el workspace** — salen al abrir esa carpeta sola. Es lo que pidió («yo
solo quiero ver si estoy en un workspace las de workspace»), dicho antes de que lo descubra él.

### 2026-10-07 · los dos informes de la primera vuelta con el build nuevo

> «cuando abro sesiones multiples me salta esto: PiCode: the turn could not finish — Agent is already
> processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.»
>
> «Y luego la lista de sesiones en un area de trabajo sigue fallando, es que parpadea es como si
> intentase coger las de una de las carpetas que tendrá luego ahí otras sesiones. Ejemplo las de
> artictempest-web.»

**Los dos eran ciertos, y los dos eran míos.**

#### 1. El modo de ventana se decidía contando carpetas (`d8b08536`)

`resolveProjectScope()` preguntaba «¿hay más de una carpeta?» para saber si la ventana era un
workspace. Una ventana abierta desde un **fichero de workspace** reporta **una** carpeta mientras el
workspace se está restaurando: durante un instante la respuesta era «carpeta», el panel listaba **las
sesiones de esa carpeta** — las de `artictempest-web`, exactamente las que él nombró — y en cuanto
llegaba la segunda carpeta la respuesta pasaba a «workspace» y la lista cambiaba bajo sus pies. Eso es
el parpadeo, y no era el listado: era la pregunta.

Ahora un **fichero de workspace** decide la respuesta. Es como una ventana dice «soy un workspace», se
sabe **desde el principio** (antes que las carpetas), y no cambia. El recuento se queda como respaldo
para una ventana abierta solo con carpetas, y el ajuste del dueño por encima de los dos.
`isWorkspaceWindow` es pura y está probada (ocho casos).

#### 2. Dos pestañas de chat compartían un agente, y chocaban (`d8b08536`)

Hay **una** sesión de pi por ventana (`agent.ts`, `session`): cada pestaña de chat que el dueño abra
conduce el **mismo** agente. Al enviar en una segunda mientras la primera seguía transmitiendo, pi
rechazaba el mensaje —«Agent is already processing…»— y el turno no llegaba a empezar.

La cola vive ahora **de este lado**: el turno siguiente espera a que termine el que está en vuelo, y
la pestaña que espera lo dice en su propio stream. **No** se usa el `streamingBehavior` de pi, y el
motivo merece quedar escrito: `followUp` le entrega el segundo mensaje a pi para después del turno
actual, y el evento que cierra un turno (`agent_settled`) saltaría entonces para el **primero**
mientras la segunda petición aún espera su respuesta — esa pestaña no transmitiría nada y terminaría
antes de tiempo, que es peor que el error. Serializando, el turno y su final van emparejados.

**Verificado**: 354 tests, 354 pasan, 0 fallan (uno nuevo con los ocho casos de la regla); typecheck
exit 0.

#### Lo que se sabe y **no** se arregla aquí

**Dos pestañas de chat comparten la conversación de pi.** Es una consecuencia de que haya una sola
sesión por ventana, y esa decisión es lo que evita que cada pestaña arranque **todos** los servidores
MCP activos — cada sesión de pi conecta cada servidor, que es justo lo que el dueño pidió parar. Queda
dicho aquí para que, si algún día quiere aislamiento por pestaña, se sepa el precio.

### 2026-10-07 · la causa raíz del parpadeo: la identidad del área salía de las carpetas

> «Ves como primero me salen 8 sesiones y luego 5 en el área de trabajo que tengo abierto?. Sigue
> fallando, no se si está cargando menos o de más, pero revísalo bien. Date una vuelta sobre esto
> porque no puede seguir fallando.»

Tenía razón en insistir, y la vuelta que pedía encontró la raíz. **El área tenía 3 conversaciones**,
y él veía 8 y luego 5: las que desaparecían eran **las de pi**, y el panel se quedaba con las locales
del editor. Medido en su propio perfil, con los tres hashes:

```text
las 2 carpetas (como están en disco)   --area-Artictempest--Workspace--513d6f42--   ← sus 3 sesiones
con 1 sola (a medio cargar)            --area-Artictempest--Workspace--19976c25--   ← busca aquí: NADA
con una 3ª carpeta abierta             --area-Artictempest--Workspace--f44eca3a--   ← y otra vez
```

**La identidad del área se calculaba hasheando las carpetas abiertas**, y esa lista no es estable: una
ventana reporta una carpeta mientras el workspace se restaura, y el dueño abre y cierra carpetas
mientras trabaja. Cada uno de esos momentos **renombraba el área**, el listado pedía la identidad
recién calculada, encontraba una carpeta **sin sesiones** y publicaba ese vacío como un hecho.

Esto explica **todo** lo que ha reportado sobre esta lista: el «8 y luego 5», el «salen menos» de
antes, y que una conversación viva se refilara al abrir una carpeta.

**El arreglo (`420040ff`), por los dos lados para que no pueda volver por ninguno:**

1. **La identidad es el workspace, no la lista de carpetas.** Cuando la ventana tiene fichero de
   workspace, el hash es sobre **ese fichero** (`vscode.workspace.workspaceFile`) — es como una ventana
   dice *cuál* workspace es, y no cambia. Una ventana abierta solo con carpetas mantiene las carpetas
   como identidad, que es todo lo que tiene.
2. **El listado recoge todas las identidades** que ese workspace haya usado: las sesiones **no se
   mueven** cuando la identidad se mueve, están donde se escribieron. `listAreaConversations` pide
   todas las carpetas que comparten el **nombre** del área — la actual solo como respaldo para un
   workspace sin sesiones todavía — y `areaFamilySlugs` da la misma respuesta a abrir una sesión por
   su id, para que una fila que el panel enseña **abra siempre** al pulsarla.

**Verificado**: 356 tests, 356 pasan, 0 fallan; y el test nuevo se ejecutó **contra el código viejo**,
donde falla (10 tests, 9 pasan, 1 falla) — el caso roto es justo el que afirma. El otro test fija la
otra mitad: el mismo nombre de área se recoge, el área de **otro** workspace no, y un slug de proyecto
no tiene familia. Typecheck exit 0.

#### La lección, escrita para no repetirla

Es la **tercera vez** que esta familia de fallo le muerde: primero una lista que no se pudo construir
publicada como vacía, luego una ventana cuyo workspace aún no estaba resuelto, y ahora una identidad
que se movía sola. La regla que las une: **antes de publicar un vacío, preguntarse si lo que se buscó
es lo que existe.** Un panel que lee del disco no puede decir «no hay nada» cuando la pregunta se ha
movido.

#### El build, y lo que costó llegar a él

Tres intentos: los dos primeros murieron a los 53 s, **sin borrar ni mover nada**, porque el
renombrado del perfil fue rechazado — `Permission denied` — **sin ningún PiCode corriendo**. Lo que
pasaba está en el log del propio editor:

```text
12:01:53.345  Extension host terminating: received terminate message from renderer
12:01:53.357  Extension host with pid 81136 exiting with code 0
12:01:53.452  [UtilityProcessWorker]: terminated unexpectedly with code 3221225477
```

El editor salió limpio y **uno de sus procesos de utilidad crasheó al salir** (violación de acceso), y
los logs del host de extensiones se quedaron **abiertos minutos** después. Comprobado luego: no son de
solo lectura y `data/` se renombra sin problema. El arreglo (`fd12aeb1`): el renombrado **reintenta
hasta 80 s** antes de rendirse — la negativa sigue siendo segura, solo que ya no es gratuita. El crash
queda **apuntado como observación**, no como conclusión: puede ser cosa del editor y no nuestra.

**Tercer intento: `exit 0` en 3m 36s.** El paquete lleva, comprobado sobre lo compilado:
`areaFamilyPrefix`, `areaFamilySlugs`, `listAreaConversations`, `windowSessionScope`,
`isWorkspaceWindow`, el hash sobre `workspaceFile`, `turnChain`, `listingForPanel`,
`oneRowPerPackage`, `chat.mcp.autostart` y pi **1.0.4**. El perfil del dueño: **57 169 ficheros y 272
conversaciones**, con **3 en el área** — las que el panel debe enseñar ahora, sin que la lista se
vacíe cuando el workspace se está cargando.

### 2026-10-07 · la causa **real**: un directorio que no se pudo leer publicado como vacío

> «Aquí hay 8 sesiones. Luego hay 5. ¿Entiendes?»

Al final la prueba estaba en el **propio registro del panel**. En
`data/user-data/User/workspaceStorage/<hash>/state.vscdb`, la clave `agentSessions.model.cache`
guarda **exactamente las filas que el panel recibió**, y ahí estaban las ocho:

```text
pi      11:50  hola          ← las del área, mías
pi      01:01  hola
pi      00:35  Hey
local   11:49  hola          ← las locales del editor
local   01:01  mola / esta sesión es de prueba / como estamos
local   00:34  Hey
```

Es decir: la segunda captura es **las cinco locales, y ningunas de las mías**. Y no era el filtro
(`providers: []`, nada excluido), ni un error del proveedor (no hay nada en los logs), ni la identidad
del área (eso ya estaba arreglado). Era esto:

```ts
list: dir => { try { return readdirSync(dir).map(…) } catch { return []; } }
```

**Un directorio que se negó a leerse volvía como un directorio vacío.** En un perfil ocupado —el suyo,
con una importación, un árbol npm y once servidores MCP— `readdirSync` falla **un instante**, y el
listado publicaba «estos proyectos no tienen sesiones» con el panel creyéndoselo y borrando **todas**
las filas. Al siguiente refresco volvían: el 8 → 5 → 8 que llevaba toda la mañana viendo.

**El arreglo (`23a0a732`)** es la diferencia que el paseo estaba tirando a la basura:

* **`SessionsFs.list` devuelve `undefined`** cuando el directorio no se pudo leer, y el paseo informa
  `complete: false`.
* **`conversationsReport` / `areaConversationsReport`** sacan eso junto con las filas, y el panel pide
  esos en vez de las listas simples.
* **`listingForPanel` retiene salvo que la respuesta se pueda sostener**: los proyectos se conocen **y**
  el paseo leyó todo lo que necesitaba. Una lista **más corta** también se retiene, porque la fila que
  falta **no se borró: no se pudo leer**.

**Verificado**: 358 tests, 358 pasan, 0 fallan; y la regla nueva se ejecutó **contra la vieja** primero,
donde falla (15 tests, 14 pasan, 1 falla) — el caso que afirma es justo el que le vaciaba el panel.
Typecheck exit 0.

#### La lección, ahora sí completa

Cuatro veces el mismo patrón: una lista que no se pudo construir, un workspace sin resolver, una
identidad que se movía, y un directorio que no se pudo leer. **Todas dicen «no hay nada» cuando lo
cierto es «no pude mirar».** La regla, taquigráfica: *si la lectura falló, la respuesta es la de antes,
no el vacío.*

### 2026-10-07 · decisión del dueño sobre la lista duplicada: **filtro del panel** (C)

> «pero las de pi son de las importaciones seguro, pq vendrán del pi externo y las guarda como "pi"
> — o las reconviertes en local o va a blinkear siempre el panel de sesiones»
>
> «la c»

**Lo que era cierto de su sospecha**, y era lo importante: **la misma conversación sale dos veces**,
una como `pi` (nuestra transcripción) y otra como `local` (la del editor). Medido en su perfil, las
tres del área tienen pareja local por hora (`11:50 hola ↔ 11:49 hola`, `01:01 ↔ 01:01`,
`00:35 Hey ↔ 00:34 Hey`). Es redundancia de verdad y va contra su propia regla de «cero redundancia».

**Lo que no era cierto**: esas tres **no son importadas**. El pi externo **no tiene carpeta de área**
(comprobado), así que las del área las creó PiCode al hablar él aquí; las 269 importadas están
archivadas **por carpeta** y en un workspace **no se listan**. Y la duplicación **no** era el parpadeo:
ese era el `readdir` que fallaba y se leía como vacío.

Las tres salidas se le pusieron sobre la mesa con su coste, y eligió **C**:

| | Qué pasa | Coste |
| --- | --- | --- |
| A | No listar nuestras filas en workspace (el editor ya lista esas conversaciones) | Pequeño; en un workspace no se pierde nada, en carpeta seguirían saliendo las importadas |
| B | **Marcar** cada conversación con el id de la sesión del editor y saltar las que el editor ya lista | Medio; sin duplicados **y** sin perder importadas ni CLI, y las que ya existen se quedan sin marca |
| **C ← elegida** | Dejarlo, y filtrar él con el menú del panel | Cero; el duplicado sigue a la vista |

**Cómo se filtra** (para que quede escrito, no solo dicho): el panel de SESSIONS tiene un icono de
filtro en su cabecera; ese menú lista los proveedores y deja marcarlos o desmarcarlos — **desmarcar
`pi` en un workspace** deja la lista del editor sin duplicados y sin perder nada (todas las del área
nacen del editor), y **desmarcar `Local`** deja las nuestras, que incluyen las importadas y las que
escribió la CLI. La elección se guarda en el perfil
(`agentSessions.filterExcludes.agentsessionsviewerfiltersubmenu`), así que se hace una vez.

**B sigue siendo el camino si algún día quiere una sola lista sin filtros**: deja las importadas
visibles y quita el duplicado sin depender de que él toque el menú. Queda anotado, no descartado.

### 2026-10-07 · «siempre las locales por defecto, nunca ambas juntas»

> «Me gustaría que siempre filtrara por defecto por las "local" y luego yo si quiero poner las
> externas, nunca ambas juntas.»

El duplicado que él venía señalando, resuelto **por defecto y sin depender de que él toque nada**
(`5179f950`). PiCode guarda sus propias conversaciones **dos veces** —las sesiones `Local` del editor
y las transcripciones `pi` son los mismos chats— y el panel enseñaba las dos. Medido en su perfil:
tres filas `pi` y cinco `local`, con las tres emparejadas por hora.

`agentSessionsFilter.ts` los conoce ahora como **un grupo** (`ONE_LIST_SESSION_PROVIDERS`):

* **El valor por defecto oculta `pi`**, así que el panel se abre con la lista del editor.
* **Mostrar una esconde la otra** (`excludesAfterToggle`), que es el «nunca ambas juntas» que pidió.
  La regla es una **función pura y probada**, porque es justo el tipo de cosa que un refactor pierde
  en silencio.
* **Los proveedores registrados por código ya salen en el menú del filtro.** No salían: el menú se
  construía solo con las contribuciones **declaradas**, y el conector registra `pi` **por código**, así
  que el único interruptor que alcanza las conversaciones que el editor nunca grabó —una importación, o
  una que escribió la CLI— **no existía**. Sin eso, el valor por defecto habría sido una puerta de un
  solo sentido.

**Y una corrección que hay que dejar escrita**: la indicación que se le dio antes («desmarca `pi` en el
menú del filtro») **era falsa** — `pi` no aparecía en ese menú. Lo que él pidió es lo que arregla eso.

**Verificado**: el typecheck del núcleo pasa por encima del cambio, y la regla tiene su prueba en la
suite del propio núcleo (`agentSessionsOneList.test.ts`): el valor por defecto, las dos direcciones del
grupo, que esconder una **no** revela la otra, y que un proveedor ajeno al grupo conserva su estado.

### 2026-10-07 · el «2» de proveedores, el thinking que no se ve, y un mando muerto

Tres cosas que el dueño encontró mirando, y las tres eran ciertas.

**«El proveedor de nan no me sale en la lista de providers… en picode:status salen 2 proveedores.»**

Los dos tenían razón sobre su propia pregunta, y **ese era el problema**: la página de ajustes edita
**declaraciones** (`picode.providers`) y el panel contaba la **unión de tres fuentes** —las
declaraciones, los `models.json` del perfil y las credenciales de `auth.json`—. Su `nan` existe **solo**
como credencial del perfil (sus modelos llegan de un paquete instalado), así que estaba en el número y
en ninguna fila.

`providers-list.ts` (puro y probado) las mantiene separadas, y la fila **Providers** del panel ahora se
despliega en una fila por proveedor diciendo de dónde viene: *declared here*, *models in pi*, *signed in
with your own account* — que es además la respuesta a «¿por qué este no lo puedo editar y el otro sí?».
El recuento se queda; lo que cambia es que ya no es lo único que dice.

**«y no consigo ver el thinking en el chat.»**

Verificado de punta a punta antes de tocar nada: el modelo **sí piensa** (63 partes `thinking` en su
transcripción), el campo del delta es exactamente el que lee el código
(`@earendil-works/pi-ai`: `{ type: "thinking_delta", delta: string }`), los tres lectores del ajuste usan
la sección `picode` correctamente, y **su ajuste ya estaba en `show`** — puesto minutos antes. La
explicación honesta: aún no había mandado un mensaje desde entonces. Lo que **sí** faltaba era poder
saberlo: la fila **Thinking** del panel ahora dice las dos mitades —el nivel, y `· not shown` cuando está
oculto— y al pulsarla abre ese ajuste. El valor por defecto (`hide`) no se toca: es una decisión, y ahora
la fila la dice en voz alta en vez de dejar que la busque.

**«Revisa esta opción si es necesaria.»** — `Chat › Agent: Thinking Style`.

**No lo era, y ya no está en los ajustes.** Renderiza *partes de thinking del chat del editor*, y el chat
de PiCode no tiene ninguna: el de pi se escribe dentro de la respuesta como cita. Los dos sitios que lo
leen caen a su propio valor por defecto cuando no está (`chatThinkingContentPart` a `Collapsed`,
`chatWidget` a `FixedScrolling`), así que quitarlo no cambia nada de lo que corre; solo saca de los
ajustes un mando experimental sin nada detrás. **Sus vecinos se dejan a propósito**: `collapsedTools`
**sí** vive aquí (decide cómo se pliegan las llamadas de herramienta, y este chat tiene herramientas), y
`generateTitles` está muerto por lo mismo que el quitado — anotado, no supuesto.

**Verificado**: 362 tests, 362 pasan, 0 fallan (4 nuevos, uno con su perfil exacto); typecheck del
conector y del núcleo, los dos exit 0.

### 2026-10-07 · ver el trabajo en background: **tarjetas** (A)

> «Y mira lo que me sale si pregunto como van» — y el chat contestaba *«corriendo en background»*.
>
> «¿Hay alguna forma de que yo vea ese background o algo?»

Se le dieron tres salidas —**A** tarjetas en el chat, **B** además una lista en un sitio, **C** las dos—
y eligió **A**. Lo que había hasta ahora: la llamada de herramienta plegada, y minutos después un
mensaje con el resultado. **Nada en medio.**

**Los dos extremos de un trabajo ya estaban en la conversación**, así que los dos se vuelven tarjeta:

* **El arranque.** La herramienta `background` vuelve al instante, así que la llamada y su resultado
  son el mismo momento: aparece una tarjeta que dice *Running in the background* con la etiqueta que el
  agente le puso al trabajo y el comando, y **esa misma tarjeta se actualiza** con el número de trabajo
  en cuanto el resultado lo nombra (mismo `toolCallId` y `enablePartialUpdate`, el mecanismo que ya usan
  las tarjetas de durable).
* **El final.** El resultado llega **como un mensaje propio** a la conversación. Se reconoce por su
  **marca** (`customType: 'specpi-background'`) y se convierte también en tarjeta: *A background job
  finished* o *failed*, la etiqueta, el comando, el código de salida y el final de su salida.

**Son dos tarjetas, y es a propósito**: el editor solo actualiza una parte **dentro de la respuesta que
se está transmitiendo**, y el final de un trabajo llega en un turno posterior. El par se lee como un
trabajo: la primera dice dónde está, la segunda cómo acabó.

**Nada se inventa, y las pruebas son la prueba de dónde sale cada dato**: las cadenas que afirman están
**copiadas de la conversación del dueño** (los `{command, label}` de la llamada y
`Started background job 3 (web lint + type-check).`) y de **un trabajo que terminó en esta sesión** (el
contenido del mensaje de final y sus `details`). Un mensaje que no lleve esa marca exacta —uno que
escriba el dueño, o una respuesta que solo mencione un trabajo— **no produce tarjeta**.

**Verificado**: 369 tests, 369 pasan, 0 fallan (7 nuevos); typecheck exit 0.

**Lo que queda**: **B** —una lista con todos los trabajos, corriendo o acabados— sigue sobre la mesa, y
es la misma información leída de los mismos dos extremos. No se ha hecho porque él eligió A.
