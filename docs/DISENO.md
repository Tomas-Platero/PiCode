# Diseño de PiCode

> Cómo ha de ser el producto, hasta donde sabemos hoy. Las frases del dueño viven en
> `AGENTS.md`; su visión completa, en `docs/VISION.md`. Este documento dice **cómo se junta
> todo**. Los `patch` que aparecen en documentos históricos ya no existen: el árbol vive en
> el árbol.

## 💡 Qué es PiCode, en una frase

Un **VS Code compilado desde su fuente** donde **pi es el agente nativo**, no una extensión
añadida. Sin Copilot en ningún sitio, y con todo integrado como si el editor siempre
hubiera sido así.

## 🧱 Las capas

```text
  Fuente de VS Code 1.135.0   (host/upstream/stable.json — el pin de procedencia)
        │
        │  el árbol propio:   ← los cambios de VSCodium y los nuestros, ya dentro
        │
        │  + product.json ← el producto (nombre, icono, galería, ajustes, versión)
        ▼
  PiCode  ────────────────────────────────────────────────┐
        │                                                  │
        │  EL NÚCLEO                                       │  LA CONFIGURACIÓN
        │  · Chat y Agente (las superficies)               │  · El perfil propio
        │  · Ajustes, nodo PiCode                          │    (nada fuera)
        │  · El host de agentes (proceso con Node)         │  · Proveedores y claves
        │                                                  │  · Habilidades y paquetes
        │  EL CONECTOR  (extensions/picode)  ┤  · Sesiones
        │  · Puente a pi: proveedores, SDK, modelos        │
        └──────────────────────────────────────────────────┘
```

### 1. La fuente propia y el delta de producto

El árbol de VS Code **ya no se clona ni se parchea en cada build**: desde el 2026-09-27
el árbol **es la fuente de PiCode**, versionada en este repositorio, con los cambios
de VSCodium y los propios ya dentro. El build no descarga ni aplica parches; compila ese
árbol.

El producto vive en `product.json`, en la raíz del repositorio: nombre, icono, carpeta de
datos propia, galería y el **número** que leen las extensiones, todo versionado.
`build/distribution/` aporta los ajustes de primer arranque, el pi fijado y la marca.

**Procedencia y número no son lo mismo.** El pin `host/upstream/stable.json` registra de qué VS
Code desciende el árbol (1.135.0); el número declarado (`set.version`, por delante del pin) se sube
para que las extensiones que piden `engines.vscode: ^1.144.0` sigan instalándose. Es una
decisión medida, no un rebase: ver ADR-016.

**Por qué así y no un binario ajeno:** cualquiera puede auditar y recompilar. El instalador
sigue siendo el camino para quien solo quiere *usarlo*.

### 2. El núcleo: las superficies son del editor

Lo que el usuario ve es **Chat y Agente**, y **sus ajustes**. No hay panel de PiCode, ni
pestaña, ni página de ajustes propia. Los ajustes de pi viven en el nodo **PiCode** de Ajustes (antes «Chat»).

### 3. El Host: pi

pi es el agente que ejecuta. Tiene **su propio bucle** —sus herramientas de fichero, terminal,
búsqueda y memoria— y su catálogo de proveedores de modelos.

Vive **dentro del núcleo**, partido en dos por una razón técnica que conviene no olvidar:

| Dónde | Qué hace | Por qué ahí |
| --- | --- | --- |
| `src/vs/platform/agentHost/node/pi/` | El host de agentes: abrir una sesión de pi y traducir lo que dice y hace a lo que el editor entiende | Es el **proceso del núcleo que sí tiene Node**, y es el mismo sitio donde VS Code pone sus otros agentes |
| `extensions/picode/` | El **conector**: catálogo de proveedores, modelos, claves, perfil | Es una **extensión del núcleo** — se compila con el editor y viaja en el binario. Aquí está Node, y aquí van los puentes |

> **Estado (2026-10-16):** hoy el pilotaje de pi corre en el conector (`agent.ts`, en proceso); el host de `agentHost/node/pi/` está preparado pero sin enchufar (`HARNESS.md`, Parte 1 §5; `TAREAS.md` #3). Lo que describe esta sección es el destino.

**Esto no es una extensión al lado del editor.** Todo lo que hay bajo `extensions/`
*es* el editor: son `git`, `github-authentication`, `markdown-language-features`… y el
conector es uno más. **No dibuja nada**: ni chat, ni modales, ni ajustes propios. Si algo
necesita superficie, la superficie va al núcleo.

### 4. El Harness: la capa de paquetes de pi

Nada se reimplementa: pi carga **paquetes** desde su perfil, y esos paquetes aportan
habilidades, subagentes, cadenas y temas.

PiCode lo que hace es **enseñarlo**: sus habilidades y sus agentes aparecen en el editor
porque el **propio host de agentes los descubre en disco**, no porque una extensión los lea.

### 5. La configuración: el perfil propio

**Todo** —ajustes de pi, credenciales, modelos, paquetes, habilidades, MCPs y sesiones— vive en
**el perfil de PiCode**. Nada se lee ni se escribe fuera.

**La memoria es la excepción, y es a propósito.** Vive en `~/.engram`, junto a la de cualquier
otro agente de la máquina: es del usuario, no del producto. El perfil no la guarda; el perfil
sabe *dónde está*. Se reutiliza si existe y se crea si no; nunca se mueve ni se pisa. Su coste
está aceptado y apuntado: **no viaja** con el perfil el día que exista la nube
([ADR-022](DECISIONS.md), [`ENGRAM.md`](ENGRAM.md)).

Y esto no es solo aislamiento: es **la unidad que se sube y se baja** el día que se venda la
nube. Un perfil compartido con la máquina no se puede subir ni sobreescribir desde un
producto.

### 6. Los proveedores de modelos

**No hay modelo fijo y no hay que construir el sistema**: pi ya trae **41 proveedores**, ocho
con cuenta (Claude Pro/Max, ChatGPT, Copilot, xAI, Meta, Kimi, OpenRouter, Radius) y el resto
por clave.

El trabajo es **enseñarlo**: que los modelos salgan en la ventana de modelos del editor, y que
conectar uno se haga **desde el Chat** — con cuenta o con clave. Sin permisos especiales: la
puerta del editor para registrar modelos es **estable**.

### 7. El Host externo (opcional)

Por defecto se usa el pi de dentro. Si el usuario quiere, puede:

- **conectarse a un pi que vive fuera** para usar **sus datos y su configuración donde están**
  (por su protocolo: RPC, WebSocket o el que exponga), o
- **traerse su configuración** al perfil de PiCode, como **oportunidad que se ofrece**.

**Lo único absoluto es la dirección: nada se escribe en el pi externo.**

### 8. Lo que se vende

El programa es **gratis y completo**. Lo que se vende es **guardar toda la configuración en la
nube** —la de PiCode y la de pi— como **una sola cosa**, que es exactamente
el perfil propio.

## 📐 Las reglas de diseño

1. **No hay superficie propia de PiCode.** Chat, Agente y sus ajustes.
2. **Nada se escribe fuera del perfil de PiCode** — salvo la memoria del usuario (`~/.engram`),
   que se comparte a propósito con otros agentes y nunca se mueve ni se pisa.
3. **No se reimplementa lo que pi ya trae.** Se enseña.
4. **Un dato aparece una vez.** Si se puede leer en tres sitios, sobran dos.
5. **Lo que exige acción es un botón.** "Reinicia pi" no es información.
6. **El conector no dibuja.** Si necesita interfaz, la interfaz es del núcleo.
7. **Nada se marca como hecho sin verlo funcionar.** El registro de este repositorio tiene
   tres casos de lo contrario.

## 🚶 El recorrido del usuario

1. **Instala PiCode y abre.** No hay que configurar nada para empezar.
2. **El asistente de primer arranque** pregunta qué hacer: usar el pi de dentro (lo normal),
   conectarse a un pi externo, o traerse la configuración que ya tenía.
3. **Conecta un proveedor** desde el Chat: elige ChatGPT, Claude, DeepSeek… y lo conecta con
   su cuenta o con una clave.
4. **Habla con `@pi` en el Chat**, que es el del editor. Con sus herramientas, su memoria y
   sus habilidades.
5. **Todo queda en su perfil**, listo para subirse cuando exista la nube.

## 🗣️ Las palabras

Todo lo que el usuario lee está **en inglés** en el código, y PiCode lleva sus propias traducciones a
**13 idiomas** en cuatro sitios: el editor (mezcladas sobre el paquete de idioma instalado), la
ventana de primer arranque, y —en el conector— el bundle de frases y los títulos del manifiesto. Los
paquetes de idioma del mercado solo traducen el VS Code de serie: sin esto, todo lo nuestro se
quedaría en inglés aunque el editor esté en chino.

Dos ficheros se **generan** desde el código (`source.json` y `bundle.l10n.json`); los ficheros de
idioma los escribe `build/l10n.mjs merge` desde trozos ya traducidos, y `check` cuenta las claves,
compara los `{0}` y para CI cuando un idioma va a medias. El detalle, la herramienta y las reglas al
escribir texto nuevo: [`IDIOMAS.md`](IDIOMAS.md).

## 🚫 Qué NO es PiCode

- Un panel propio, una pestaña propia, unos ajustes propios.
- Una extensión al lado del editor.
- Escribir en el pi de la máquina.
- Reimplementar proveedores, OAuth, habilidades o el orquestador.
- Recortar funciones para vender la nube.

## 🤖 Los dos diseños: Agent y Editor

`picode.appearance.layout` elige cómo se reparte la ventana. *Editor* es el VS Code de siempre y
el valor de serie. *Agent* recoloca las mismas piezas del editor, sin abrir otra ventana (VS Code
trae una «Agents Window» aparte, `src/vs/sessions`, que no usamos):

| Zona | En Agent |
| --- | --- |
| Izquierda | La columna de sesiones (`picodeAgentSessionsView.ts`): filas *New session*, *Search* (ventana centrada, `picodeAgentSearch.ts`) y *Customization* (la página de ajustes del chat); el nombre del proyecto con refrescar y filtrar; las sesiones por fecha y, al pie, el botón de cuenta del editor (avatar, email y plan) y el engranaje; en la barra lateral secundaria |
| Centro | El chat, sin su lista de sesiones dentro (el panel inferior, acoplado a la izquierda) |
| Junto al chat | Un fichero abierto se pone a su derecha; sin ficheros, el editor se esconde y el chat ocupa el sitio |
| Derecha | La barra lateral principal, con sus vistas como pestañas arriba. **Status** (`picodeStatusView.ts`, el panel de `picodeAgentOverviewView.ts`) es la primera: entorno (equipo, carpeta, rama), contexto usado por la conversación, MCPs (los servidores MCP de pi, con *Sign in* si lo piden), cambios (líneas añadidas y quitadas sin guardar en git, `+N −M` como en Claude Code, con el número de ficheros al pasar el ratón y *Review*; pulsar la fila o *Review* abre una pestaña con todos los ficheros cambiados y su diff desplegable, cada uno con su propio `+N −M` en la cabecera (la vista de cambios múltiple del editor, `diffEditorItemTemplate.ts`), como la lista de cambios de Claude Code; al abrirla la barra derecha se estrecha a una columna (320 px) con Status como pestaña abierta, y al cerrarla vuelve al ancho que tenía si nadie la movió mientras; abrir o cerrar un fichero solo reparte el sitio entre el chat y el fichero: las columnas de los lados solo toman su ancho inicial al entrar en Agent; lo cuenta el conector con `git diff --numstat HEAD` más las líneas de los ficheros nuevos, `diff-stat.ts`) y **Tasks** y **Memory**: lo mismo que enseñan los bloques Tareas y Memoria del panel de PiCode, que en Agent no sale (sus vistas llevan `config.picode.appearance.layout != agent`). Tasks lista lo que está en marcha (un agente abre su transcripción; un trabajo, su salida) y *Finished* despliega lo acabado; Memory da el recuento con versión y última escritura, las carpetas abiertas con sus memorias, *Search memories…* (los resultados salen ahí mismo y se abren con un clic), *Check memory* y *Update* si hay motor nuevo. Los datos los da el conector con `picode.tasks.data` y `picode.memory.summary`. Es **o columna o pestaña, nunca las dos**: con la barra ancha (600 px o más) es su propia columna a la izquierda de la barra y su icono sale de la fila de arriba (la clave de contexto `picodeStatusColumnShown` oculta la vista; si la pestaña de Status estaba abierta, la barra pasa al explorador). Con la barra más estrecha la columna se va y Status vuelve como primer icono de la fila; si Status era la pestaña abierta antes de ensanchar, al estrechar vuelve a abrirse (salvo que mientras se eligiera otra a mano). Al entrar en Agent los iconos de la barra se ordenan: Status, explorador, búsqueda, control de código, terminal, problemas, salida, consola de depuración, depurar, extensiones, y el resto detrás (`orderReviewTabs` en `picodeLayoutStyle.ts`, que reescribe el orden guardado de la barra). La primera vez, problemas, salida y consola de depuración salen de la fila (siguen con sus atajos y con clic derecho en la fila); si el usuario las vuelve a poner, se quedan. Al abrir se pinta al momento: entorno, cambios y tareas los sabe el editor, y los MCPs y el `+N −M` salen de lo último que se vio en ese proyecto (`picode.status.lastSeen`, guardado con el espacio de trabajo) hasta que pi arranca y los refresca. Luego archivos, búsqueda, cambios, terminal, problemas, salida… |
| Fuera | Barra de iconos y barra de estado |

**Cómo está hecho** (`src/vs/workbench/contrib/picode/browser/picodeLayoutStyle.ts`): con los
ajustes propios del editor — `workbench.experimental.modernUI`, `workbench.sideBar.location: right`
(la secundaria pasa a la izquierda), `workbench.activityBar.location: top` y
`workbench.statusBar.visible: false` —, la posición del panel a la izquierda y moviendo
contenedores de vistas: el chat al panel; terminal, problemas, salida y consola de depuración a la
barra derecha; las sesiones a la secundaria. Lo que había antes (ajustes y posición del panel) se
guarda en almacenamiento de aplicación y *Editor* lo devuelve. Retoques al núcleo, marcados con
`PiCode`: en Agent el chat no pinta su propia lista de sesiones (`chatViewPane.ts`), el editor y
el panel pueden esconderse a la vez (`layout.ts`) y la barra lateral se parte en dos columnas
cuando es ancha (`sidebarPart.ts`, `sidebarSideColumn.ts`), con el panel de estado dentro de una
vista propia para que siga habiendo dónde elegirlo aunque la parte derecha se encoja.

**La primera vez** que un espacio de trabajo entra en Agent (`picode.layout.agentArranged`, se borra al
volver a Editor) las columnas se ordenan una sola vez: sesiones a la izquierda, la barra derecha
estrecha (320 px) y con solo *Status* abierto, y el chat y la página de Bienvenida a partes iguales
con lo que queda. Los arranques siguientes no tocan nada: se queda lo que el usuario dejó. La fila de
iconos de la columna de sesiones no se pinta (solo tiene una vista). La página de Bienvenida se abre
sola hasta que el usuario la cierra una vez (`picode.welcome.dismissed`, `startupPage.ts`); cerrar la
ventana no cuenta como cerrarla.

**Pendiente para igualar a la vista de agente de Claude Code:**

- Una pestaña de navegador en la barra derecha (el navegador integrado hoy se abre como editor).
- Revisar los cambios del agente en la barra derecha, con aceptar / descartar por fichero.
- Las tareas y el plan del agente como pestaña de esa barra.
- Una barra superior con el título de la sesión en lugar del buscador.
- Los proyectos como grupos de la lista de sesiones.
- En *Changes*, las líneas añadidas y quitadas (hoy solo el número de ficheros) y un botón para crear el PR.

**Volver a lo de fábrica:** el comando *PiCode: Reset Layout to Default* deja cada pieza donde VS Code
la pone (chat al lado, terminal y problemas abajo, barra de iconos y de estado visibles, barra
lateral a la izquierda), pase lo que pase con lo que el diseño Agent recordaba.
