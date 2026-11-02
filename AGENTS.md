# Lo que quiero, tal como lo digo

Este fichero es un registro de intenciones, no una especificación redactada por el agente. Cada punto contiene **la frase original** del dueño del proyecto y, justo debajo, su **traducción práctica**.

Si algo cambia en el proyecto, se actualiza la frase o se añade una nueva, pero nunca se reescribe la intención original.

> **Ubicación:** Vive en la raíz del repositorio para que cualquier sesión de trabajo lo lea obligatoriamente antes de modificar nada.

---

## 1. Diseño e Interfaz (UI/UX)

### La interfaz se juzga por lo que se usa, no por lo que se sabe
>
> *"Mucho texto redundante y versiones redundantes. Quiero algo funcional, no técnico."*

* **Cero redundancia:** Un dato aparece **una sola vez**. Si un número está visible en tres sitios del mismo panel, sobran dos.
* **Sin tripas a la vista:** Ocultar rutas absolutas, nombres de fuentes internas o banderas sin traducir. El dueño decide con estados claros: *está / no está*, *funciona / no funciona*, *versión*, *hay actualización*.
* **Acciones directas:** Si requiere una acción, se convierte en **botón**. "Reinicia pi" debe ser una acción ejecutable, no una instrucción de texto.
* **Eficiencia de espacio:** Un panel de estado no puede ocupar media pantalla solo para decir "todo bien".

### La pantalla enseña lo que pasa, no cómo está hecho
>
> *"para que quiero eso, omg"*

* La interfaz comunica **qué hay y qué puedes hacer** (ej. *Built*, *Stop build*, *Clean*).
* Ocultar explicaciones sobre la maquinaria interna (dónde se guarda cada cosa o cuándo se calcula). Ese detalle va a los ficheros de tareas o a la documentación.

### Un aviso sobre quién ve qué
>
> *"Me sigue saliendo el logo de vscodium..."*

* Antes de asimilar que un arreglo falló, verificar **dónde se ve exactamente** (pantalla, esquina, contexto). Evitar asumir que ambas partes están mirando lo mismo.

### Los iconos y el emoji son el estilo
>
> *"añade siempre iconos, de marcas, de emojis etc que le de un mejor estilo visual"*

* **Un icono antes que texto**: los encabezados, y cada fila de una lista o tabla, llevan su icono o su emoji. Un badge sin logo o una sección sin marca visual es una ocasión perdida.
* **Marcas de verdad**: los logos de terceros (GitHub, Node, TypeScript, Electron…) se ponen con su identificador real y **comprobado antes de usarlo**. Medido el 1-10: `windows` y `visualstudiocode` ya **no existen** en simple-icons (Microsoft los retiró), así que ahí no va logo: mejor sin él que roto.
* **Nada que no lleve a ningún sitio**: un badge que no enlaza a nada, o que promete algo que no existe, es una mentira. Si no hay a dónde ir, no se pone.

---

### El texto del editor es funcional, no técnico
>
> *"todo texto que va en el editor en su mayoría son escrito con carácter funcional para el usuario"*

* **Carácter funcional:** Todo texto que aparece en el editor (etiquetas, mensajes, tooltips, notificaciones, filas del panel, botones) se redacta para el usuario: qué hay, qué puedes hacer, qué cambió. Sin nombres de código, rutas, banderas ni detalles de la maquinaria interna.
* **Una sola voz:** El mismo concepto se dice igual en todas partes; si un dato necesita explicación técnica, esa explicación va a `docs/` o a los ficheros de tareas, no a la pantalla.
* **Acción = botón:** Si el texto pide hacer algo, se convierte en acción ejecutable (ver «Acciones directas» arriba); no se deja como instrucción de texto.

---

## 2. Marca e Iconografía

### Los iconos
>
> *"lo de la rosa cambialo por el de picode"* — 2026-10-01

* **Barra de actividad:** Usa **la marca de PiCode** (`extensions/picode/media/picode-status.svg`, el icono del contenedor).
* **Variante para 24 px (2026-10-19):** la barra de actividad usa `media/picode-activity.svg`, derivada de esa misma marca (cabeza, ojos y chevrones; sin la barra horizontal y con trazos más gruesos), porque a 24 px y en máscara la marca completa se leía como una hoja de papel. La marca completa sigue en `picode-status.svg` para el título de la vista de estado, que la pinta a su tamaño.
* **2026-10-21:** la barra de actividad usa **el mismo dibujo** que el título de la vista de estado (`picode-status.svg`), copiado tal cual a `picode-activity.svg`. El dueño pidió que la extensión y la app lleven el mismo icono; las dos variantes se leían como dos marcas distintas. Si a 24 px la barra horizontal vuelve a parecer una hoja de papel, se retoca entonces, pero partiendo del mismo dibujo.
* **La marca vive en el conector** (`extensions/picode/media/`) y lleva su **pareja claro/oscuro**: el icono de una fila del árbol se pinta como **imagen** (no como máscara), así que una sola tinta desaparece en uno de los dos temas.
* **Tratamiento como máscara:** La barra de actividad usa el icono como máscara (solo cuenta la silueta). No incluir fondos rellenos en el lienzo para evitar cuadrados macizos.

> *"El logo que cambiamos en el centro de la pantalla... no uses el png usa el svg"*

* **Marca de agua del editor vacío:** Utiliza el **dibujo vectorial de trazos** (`media/picode.svg`), no la versión con placa de fondo.

---

## 3. Metodología

### El método se llama ODD
>
> *"y ya no es SDD es ODD"*

* La metodología del proyecto es **ODD (Organic Driven Development)**. SDD es solo una rama dentro de ODD.
* En el texto visible para el dueño, «SDD» no se usa como nombre del método global. Sus comandos y artefactos específicos sí conservan su nombre.

---

## 4. Arquitectura y Gobierno de Pi

### El pi del editor es nuestro y vive en el núcleo
>
> *"no quiero que la versión de picode que vive en nuestro editor sea fija, quiero poder actualizarlo desde el editor"*
>
> *"El perfil de pi me gustaría que fuera interno y la configuración, etc también interna, pero poder 'importar' de la del pi del path"*
>
> *"necesito que en la config de modelos también podamos conectar proveedores, y modelos y tal para cualqueir pi ya sea para el interno o el externo."*
>
> *"Pi vive dentro de PiCode (Vscodium), es el HOST, el que maneja todo, agents, skills, etc. NUNCA vamos a añadir nada del path, yo tengo otro pi aquí para desarrollar esta app, que eres tú cacho cabezón."*
>
> *"Mete esto en el Agents.md olvidate del pi del path"*
>
> *"lo que si OLVIDATE de una extensión, todo ha de vivir en el núcleo."*
>
> *"y no ha de guardar NADA en el pi externo, si no en el interno, olvidate de la carpeta /.pi/ que hay en tapla"*

#### Reglas de arquitectura de Pi

* **Un único Pi (Host):** PiCode integra su propio Pi dentro del **núcleo del editor**. Es el Host que maneja todo: agentes, skills, proveedores y memoria.
* **Actualización interna:** Pi se actualiza desde el propio editor, sin reinstalar ni editar ficheros manualmente.
* **Aislamiento de escritura:** Se escribe **siempre** en el perfil propio de PiCode. La carpeta externa (`~/.pi/`) no se toca nunca para guardar o leer.
* **Sin extensión propia:** Todo (chat, proveedores, modelos, ajustes, habilidades y agentes) vive en el **núcleo del editor**, usando la superficie nativa (Chat y Agente).
* **El Pi del PATH:** No lo ejecuta el producto; sirve solo para desarrollo.
* **Conexiones y migraciones externas:**
  * **Conectarse** a un Pi externo (por RPC/WebSocket) es opcional si el usuario lo decide para usar sus datos donde están, pero **nada sale de PiCode**.
  * **Migrar** datos desde el Pi del PATH al interno es una opción explícita a petición del usuario, nunca un proceso automático.
* **Credenciales:** Las claves de endpoints se guardan como variables de entorno o valores cifrados; nunca se muestran en pantalla.

### El pi del PATH es del dueño: solo la app lo toca
>
> *"Esto no lo toques NUNCA, esto es mi pi que estamos corriendo ahora mismo."*
>
> *"Miento, cuidado, si se puede tocar, al actualizar y tal pero via app."*
>
> *"si conectamos el HOST que sea el Externo (PATH) debería poder actualizar Pi y Packages del externo"*

* **Nunca a mano:** ni el agente ni ningún script del repo escriben, instalan ni actualizan el pi del PATH directamente. Es el pi con el que se está trabajando ahora mismo.
* **Sí, vía la app (única excepción):** el producto puede tocarlo solo a través de sus propios flujos de actualización (Update Pi / Packages), nunca por escritura directa. Esto matiza la regla de aislamiento de escritura: seguir prohibido guardar ni leer a mano en esa carpeta.
* **Requisito de producto:** cuando el HOST conectado es el externo (PATH), los botones de actualizar Pi y Packages deben actuar sobre ese externo, no sobre el interno.

### pi durable ya no es experimental

> ⚠️ **Sustituido el 2026-10-25** por «Durable sale del producto» (abajo). Se conserva la frase original.

>
> *"Vamos a dejar de poner como algo experimental a pi durable, quiero que esté ya en nuestro source de picode, no lo quiero a parte en "experimental", tratalo como algo ya que vive en picode."* — 2026-10-09

* **Residencia:** el agente durable vive en el propio árbol del editor (`host/durable`, con su puente de chat en `host/durable/bridge/` y su cliente de prueba ACP en `host/durable/acp-client`). La carpeta `experimental/` no vuelve a ser su casa.
* **Nombre:** en todo lo que ve el dueño es **Durable agent**, a secas. Ninguna UI, ajuste o documento vivo lo presenta como experimental.
* **Build:** viaja dentro de la instalación (`resources/durable`), como ya hacía; solo cambia el nombre de la carpeta destino.

### Durable sale del producto: Pi + Gentle AI
>
> *"Lo primero - Quiero quitar todo durable. ya que impacta con Gentle en ciertas cosas. Este cambio será gordo pero necesario, quiero que sea Pi + Gentle AI (gentle pi y engram)."* — 2026-10-25

* **Fuera durable entero:** el programa, su puente, sus comandos y ajustes, el interruptor del primer arranque, la tarjeta de estado y el paso del build.
* **Las conversaciones son las de pi:** la lista única del panel son los transcríptos que pi escribe en el perfil, y se continúan en el sitio. Lo que solo guardaba durable no se migra.
* **Tasks:** muestra los trabajos del chat y los subagentes de gentle-pi (ADR-032), los que siguen y los últimos que acabaron.
* **Memoria:** gentle-engram será la memoria que pi usa; el vedado de `gentle-pi` y `gentle-engram` ya está levantado y los dos entran fijados (ADR-031). El detalle y las decisiones: ADR-030 en [`docs/DECISIONS.md`](docs/DECISIONS.md).

### Lo de Gentle AI se actualiza solo, pero sigue fijado
>
> *"habría tener un sistema para poder actualizar gentle-ai aunque sea casi automatizado o full automatizado, ya que tenemos pinneado esto. Imaginam que mañana y pasado y el dia siguiente salen versiones nuevas de gentle-pi o engram."* — 2026-10-29

* **Fijado no es congelado:** gentle-pi, gentle-engram, pi-intercom y el motor de engram siguen a versión exacta, pero un bot diario propone la versión nueva en cuanto lleva un día publicada.
* **Lo seguro entra solo:** si la versión nueva no trae nada que pida mirarla y las pruebas pasan, se fusiona sola en `experimental` y sale con la siguiente release.
* **Lo que no, espera con el motivo escrito:** salto grande, extensiones nuevas, otro pi, scripts de instalación… y siempre el motor de engram, porque su memoria es compartida.
* **Cerrar el PR es decir «esta no»:** el bot no vuelve a proponer esa versión.
* Detalle y uso: [`docs/PINS.md`](docs/PINS.md) · decisión: ADR-035.

### Todo se actualiza desde la app; lo fijado es el mínimo
>
> *"nono quiero que se pueda actualizar todo desde la app, desde pi, engram, gentle, etc. Si sacan actualizaciones como mucho sus features hasta que nosotros no la integremos 100% en el editor no funcionarán pero poco más. Pero pueden arreglar bugs y demás."* — 2026-10-29

* **Todo tiene botón de actualizar:** pi, sus paquetes, gentle-pi, gentle-engram, pi-intercom y el motor de engram salen en *Updates* y se actualizan con el mismo **Update**, sin esperar a una release de PiCode.
* **El pin es el mínimo, no el techo:** la versión que fija PiCode es la de partida. Lo que el usuario actualiza desde la app se queda; una actualización de PiCode solo sube, nunca baja.
* **Se acepta el coste:** una versión nueva puede traer funciones que el editor aún no enseña; sus arreglos llegan igual.
* Detalle: ADR-035, adenda 1 · [`docs/PINS.md`](docs/PINS.md).

---

## 5. Personalización del Editor

### Integración de temas
>
> *"Vamos a ver, necesito integrar los temas de <https://vscodethemes.com> para que tanto en la primera instalación como en cualquier momento puedan elegirse uno de esos temas."*

* **Puntos de acceso:** Selección disponible en el asistente de primer arranque, en **Ajustes > Aspecto**, y mediante comando en la paleta/menú.
* **Origen de datos:** Los temas se instalan desde **Open VSX**. `vscodethemes.com` se trata como un escaparate externo de referencia.
* **Vista previa nativa:** Pintada por PiCode usando los colores reales del tema (sin depender de red ni imágenes externas).
* **Instalación:** Aplicar un tema lo instala automáticamente si no existe. Solo se pide reiniciar la ventana cuando sea estrictamente necesario.

---

### Dos formas de usar PiCode: Agent o Editor
>
> *"el diseño es muy VSCODE ¿sería posible actualizarlo por algo más moderno?"* — 2026-11-01
>
> *"quiero una vista muy agentica, quiero poder elegir entre agente o entre editor en el setup o en las opciones. […] lo quiero como un diseño nuevo del editor que cambie columnas y cosas de sitio"*
>
> *"Nono solo Agent o Editor. CLassic sería el Editor."*

* **Solo dos diseños:** *Agent* y *Editor* (el VS Code de siempre). *Editor* es el de serie para no mover a nadie al actualizar.
* **Agent se parece a la vista de agente de Claude Code** (*"quiero el mismo diseño que claude code en agentic y las mismas funcionalidades"*, *"la activity bar en agentic no debería existir y a la derecha del chat debería estar otra sidebar"*): sin barra de iconos ni barra de estado; las sesiones en su propia columna a la izquierda (*"Saca todo lo de las sesiones a la izq como claude code"*); el chat en el centro; a la derecha una barra de revisión con pestañas arriba (archivos, búsqueda, cambios, terminal…); un fichero abierto se pone junto al chat y, al cerrarlo, el chat recupera el sitio. Lo que aún falta para igualar funciones (navegador, revisión de cambios con aceptar/descartar, tareas) va en `docs/`.
* **No es otra ventana:** VS Code trae una «Agents Window» aparte para Copilot; aquí *Agent* es el mismo editor con las columnas recolocadas.
* **La columna de sesiones habla con texto, no con iconos** (*"esos iconos quítalos y haz que el chat settings se abra desde un texto escrito como 'personalización' y buscar abra una ventana como esa"*, *"tiene que ser una ventana centrada"*): arriba *New session*, *Search* y *Customization*; abajo la cuenta (avatar, email y plan) y el engranaje. *Search* abre una ventana centrada sobre el editor oscurecido con las sesiones que piden atención, las recientes y las acciones. El chat no lleva iconos en su título. Todo esto solo en *Agent*.
* **El estado de la derecha no se pierde al encogerla** (*"que entorno al hacerse la parte derecha más pequeño vuelva a estar en el listado de arriba a la derecha de iconitos. Para poder ponerlo solo a él o al explorador de ficheros"*; 2026-11-02: *"quería que estado se ocultara de la izq y fuera a la derecha cuando la barra de la derecha fuera pequeña y saliese en el icono, si no, se oculta el icono y luego aparece estado + lo que sea"*): *Status* (entorno, MCPs, cambios y tareas) es **o columna o pestaña, nunca las dos**. Con la barra ancha es su columna a la izquierda de la barra, junto a lo que esté abierto, y su icono no sale arriba. Con la barra estrecha la columna se va y *Status* vuelve como un icono más de la fila de arriba.
* **Dónde se elige:** en su propio paso del asistente de primer arranque, *Layout*, el segundo (*"Pon el estilo la 2º pestaña y añade un mejor diseño para explicar las diferencias"*), con un dibujo de cada diseño y sus zonas rotuladas; en **Ajustes > Workbench > Appearance** con el botón del robot 🤖 arriba a la derecha (junto a los de las barras) y con el comando *PiCode: Switch Layout (Agent / Editor)*. Cambia al momento, sin reiniciar.
* **Por dentro (detalle en `docs/`):** *Agent* usa los propios ajustes del editor (paneles flotantes, barra lateral a la derecha, iconos arriba, sin barra de estado), pone el chat en el centro, una columna de sesiones a la izquierda y el terminal en la barra derecha; guarda cómo estaban y *Editor* los devuelve tal cual.

---

## 6. Modelo de Negocio y Nube

### El programa es gratis; lo que se vende es la nube

* **PiCode es 100% gratuito y completo:** No hay funciones recortadas ni dependencia de la nube para su funcionamiento local.
* **Valor comercial:** Sincronización y respaldo en la nube de toda la configuración (PiCode y Pi) como un único bloque.
* **Unidad de perfil:** Toda la configuración vive en un perfil interno propio que se sube/baja como una unidad aislada.
* **Seguridad de credenciales:** `auth.json` y tokens requieren cifrado y consentimiento explícito del usuario antes de subir a la nube.

---

## 7. Formas de Trabajo y Comunicación

### Autonomía de ejecución
>
> *"No me pidas permisos ni que revise yo nada, termina TODAS las fases."*

* Una vez autorizado un trabajo, se ejecuta hasta el final sin interrupciones. Las decisiones de producto no cerradas se toman, se registran y se explican al terminar.
* Transparencia total: lo que no se pueda completar se informa con la misma claridad que lo terminado.

### Builds sin instalador por defecto
>
> *"Generame solo la build portable luego y no el instalador, el instalador dejalo a partir de ahora si no te lo pido explicitamente."* — 2026-10-14

* Toda build local produce **solo el pack portable** (`PICODE_SKIP_INSTALLER=yes`).
* El instalador se construye **solo a petición explícita** del dueño.

### Reportes de cierre
>
> *"Una vez finalices dame un reporte."*

* Al terminar: informe con qué está hecho y verificado, qué falta, por qué y dónde quedó registrado.

### Una sola release por canal
>
> *"recuerda borrar la release anterior siempre"* — 2026-10-16

* Cada canal (stable, beta, experimental) muestra **una única release en GitHub: la más nueva**.
* Al publicar una release nueva, el pipeline borra automáticamente la anterior del mismo canal, con su tag.
* El borrado va **después** de publicar la nueva: si un run falla a mitad, el canal nunca se queda sin release.
* El guard de "versión estrictamente más nueva" no depende de la lista de releases: lee la versión anterior del feed del canal en el árbol, así que sigue funcionando tras borrar.

### La página de la release cuenta lo que cambió
>
> *"recuerda añadir tu siempre el texto de la release mejorado y con el changelog"* — 2026-10-16

* Toda release lleva, sobre el changelog crudo, **un resumen agrupado por tipo de cambio** (novedades, arreglos, rendimiento, editor, seguridad, resto) con iconos — lo genera `build/release.mjs release-notes` a partir de los commits del rango y el pipeline lo inserta solo.
* Los commits de feed y housekeeping no aparecen: no le dicen nada a quien lee la página.
* Siempre conserva: la descripción del canal encima (`build/release-notes/<canal>.md`), el changelog generado por GitHub debajo (con el enlace de comparación apuntando al propio tag) y la tabla de archivos.

### Las actualizaciones llegan pequeñas, y no se rompen
>
> *"Hay que pensar un sistema de hotfixes rápidos para esto que no sea rebuildeando todo."* — 2026-10-27
>
> *"No quiero subir una 0.3.2 a 0.3.3 y encontrarme problemas y errores."*
>
> *"y en vez de hablar de fixes solo añadimos también "minor update" en plan un pack de fixes + alguna mejora nueva"*

* **Una sola numeración:** cada hotfix es una versión de verdad (`0.5.0` → `0.5.1`). Lo que cambia es la descarga: quien está en la versión anterior (portable) baja solo lo que cambió; el resto, la release completa. Mismo resultado.
* **Tres etiquetas, que se ponen solas:** *Hotfix* (solo arreglos), *Minor update* (arreglos y alguna novedad) y *Release* (no cabe en un zip pequeño).
* **Nunca peor que antes:** el paquete se prueba antes de publicarse, va firmado, se aplica sobre una copia y, si la versión nueva no arranca, se vuelve sola a la anterior con el perfil. Cualquier fallo termina en la descarga completa.
* **Qué entra y qué no:** el editor, las pantallas y la extensión sí; Electron, dependencias, pi, engram y la identidad del producto, no. Un cambio que migre datos del usuario tampoco entra en un hotfix.
* Detalle y uso: [`docs/HOTFIX.md`](docs/HOTFIX.md) · decisión: ADR-034.

### Idioma del proyecto y del producto
>
> *"En español."*
>
> *"NOno a ver todo ha de estar en ingles, tu me hablas en español, ya costruiremos paquete sde lenguajes para todos los demás idiomas. Pero a priori en inglés."*

* **Producto (Interfaz):** Todo lo que ve el usuario final va en **inglés** (ventanas, avisos, comandos, ajustes, respuestas del chat sobre herramientas).
* **Comunicación interna:** La interacción con el dueño, los reportes y la documentación (`docs/`, `AGENTS.md`) se mantienen en **español**.
* **Internacionalización:** Otros idiomas se añadirán mediante paquetes de lenguaje sobre la capa superior, sin mezclar cadenas en el código base.
* **Excepciones técnicas:** Mensajes de commit, comentarios de código e identificadores permanecen en inglés.
* **Siempre se escribe en inglés:** todo código nuevo, sus comentarios, las cadenas de código y los mensajes de las herramientas se redactan en inglés — **nada en español** en el código («añade en el agents.md que siempre se escribe en inglés» / «tradúcelo todo al inglés, nada en español», 2026-10-16).
  * Si aparece español en el código (citas del dueño incluidas): se **borra** si el resto del comentario se entiende solo, o se **traduce** si hace falta para entenderlo.
  * Única excepción: el texto con destino a documentación en español (`docs/`, `README.md`, `AGENTS.md`).
* **Datos que no son texto nuestro:** las pruebas de acentos/teclados upstream, los nombres de idioma de los paquetes (`"español"`) y los mensajes citados de terceros se quedan como están.

### Comunicación clara y funcional
>
> *"necesito que me expliques a partir de ahora todo muy sencillo, no necesito nada técnico, quiero hablarte y que me hables funcional y fácil."*

* Explicaciones centradas en **qué hace y qué cambia para el usuario**, sin tecnicismos ni nombres de código/ficheros.
* Lenguaje directo y frases cortas.
* El detalle técnico se documenta de forma completa en `docs/`.
* Explicación funcional de errores: qué significa la falla (ej. "no se pudo conectar"), no la causa en el código.

### La ventana de gestión del chat habla de pi, no de Copilot

* La página **«Agent Customizations»** del chat debe listar los elementos reales del runtime pi (perfil en fuerza), no los de las convenciones de GitHub/Copilot.
* **Agents**: los agentes de pi. **Skills**: las de pi y las del proyecto. **MCP Servers**: los servidores mcp de pi. **Plugins**: los paquetes instalados de pi.
* **No existen** en este producto: **Instructions**, **Prompts** y **Hooks** (pi no tiene hooks) → fuera de la navegación y de la rejilla de la página.

---

### Cada carpeta se documenta al lado, y el mapa se genera
>
> *"deja avisado algo en el agents.md no? de usar esto"* — 2026-10-16

* **Toda carpeta nueva lleva su `README.md`:** una frase de qué hace esa carpeta y qué hay
  dentro, escrito al lado del código. Si no lo trae, CI lo avisa y el PR se detiene
  (`build/docs.mjs check`; las excepciones se apuntan en `.docsignore`).
* **El mapa se genera, no se escribe:** `docs/MAPA.md` sale de esos README con
  `node build/docs.mjs map` y **nunca se edita a mano**. Solo se refleja lo versionado: restos
  locales y salidas de build no entran.
* **Nivel fichero solo cuando el nombre miente:** si el nombre ya explica el fichero, no se
  documenta; si no, dos líneas de cabecera con el porqué.
* **La zona upstream no se documenta fichero a fichero:** `src`, `cli`, `build`,
  `scripts`, `resources`, `remote` y las extensiones built-in llevan un solo aviso de que no
  son nuestras (ahí está casi todo el código y detallarlo es trabajo que se pudre).
* **Dónde mirar primero:** `docs/MAPA.md` (árbol con una frase por carpeta) y, para saber quién
  llama a quién, el grafo de código (`.codegraph/`), no la documentación.

---

## 8. Trabajo por Fases

### Quiero ver las fases del trabajo mientras avanza
>
> *"Cuando lanzo fases de tareas no las veo… Tengo una lista con fases y no se ven."*
> *"gentle-ai siempre lo muestra ¿no deberíamos hacer lo mismo?"*

* **Panel de fases siempre visible:** al empezar cualquier trabajo con varias fases o pasos, el agente registra la lista completa con la herramienta `set_plan` (extensión pi-plan-widget de pi) y la mantiene actualizada: `in_progress` en la fase en marcha, `done` al cerrar cada una.
* **El panel es estado real, no decoración:** no se eliminan las fases ya hechas y cada cambio de fase se refleja en el panel en el mismo turno.
* **Sin ruido:** trabajos triviales de un solo paso no llevan plan.

## 9. La memoria: pi, durable y engram

> ⚠️ **Sustituido en parte el 2026-10-25:** durable sale del producto (sección 4). Pi y engram siguen como están descritos; lo que aquí se dice de durable es historia.

### Tres papeles, y ninguno repite al otro
>
> *"Pi es el agente | Durable las sesiones y el registro | Engram la memoria"*
>
> *"La idea es integrar a engram en picode, que funcione con pi y pi durable."*

* **Pi piensa.** Es el único que ejecuta: modelo, herramientas, permisos, pantalla.
* **Durable recuerda lo que pasó.** Las sesiones, el registro palabra por palabra y el trabajo
  largo que sigue sin el dueño delante. No piensa y no decide.
* **Engram recuerda lo que importa.** Conocimiento curado (decisiones, convenciones, porqués)
  que sobrevive a todo y que **es lo único que ve otro agente** de la misma máquina.
* **Las flechas van en un solo sentido:** pi escribe en los dos. Durable no lee la memoria y
  engram no lee las conversaciones; se cruzan solo a través de pi.
* **No son dos agentes:** el pi del chat y el pi durable son el mismo pi. Durable es dónde
  apunta y a dónde manda lo largo.

### Engram vive en el producto
>
> *"Yo quiero a engram en el producto, osea quiero que se ejecute con pi. ¿esto sería así?, si un usuario escribe engram tiene que funcionar."*

* Engram **viaja dentro de PiCode**, como durable: no se instala aparte.
* **Una sola declaración** en el perfil sirve a los dos motores.
* Escribir **`engram`** en el terminal integrado tiene que hacer algo de verdad.
* ~~El paquete `gentle-engram` de pi **no entra**: el protocolo de memoria se escribe aquí.
  Sigue valiendo la lista de `left-behind-packages.ts`.~~ **Sustituido el 2026-10-25:** gentle-engram entra, fijado por el producto (ADR-031). La lista de `left-behind-packages.ts` queda vacía.

### Su memoria es del usuario, no del perfil
>
> *"Luego donde gestiona él su memoria que será .engram es otro tema, el puede leer si ya hay algo existente o crearlo en el pc del usuario"*

* El almacén vive en **`~/.engram`** y **se comparte** con cualquier otro agente de la máquina.
* **Se mira primero:** si ya hay almacén se reutiliza **tal cual**; si no, se crea. Nunca se
  mueve, ni se migra, ni se pisa.
* **Consecuencia aceptada:** la memoria **no viaja con el perfil en la nube**. Queda apuntado
  como deuda, no se esconde.
* Si ya hay un engram sirviendo, PiCode **se engancha a ese**; no abre otro sobre la misma base.

### Lo que enseña el TUI, se enseña en el editor
>
> *"Recuerda que tienes que añadir todo lo que engram muestra en el TUI en el Editor de PICODE"*

* Se porta **lo que muestra** (datos y acciones), no el TUI: ni sus teclas, ni su tema, ni su
  terminal.
* Todo vive en **superficies que ya existen** (la vista del contenedor, una pestaña del editor y
  Ajustes). No se inventa panel, pestaña ni página de ajustes propia.
* **Las «sesiones» de engram no se pintan como sesiones:** son registros de atribución, y las
  sesiones de verdad son las de durable. Aparecen como *«de dónde salió»* dentro del detalle.
* La interfaz habla nuestro idioma: inglés, iconos, sin rutas ni nombres internos.

> 📋 El detalle punto por punto, con lo hecho y lo que falta, vive en
> [`docs/ENGRAM.md`](docs/ENGRAM.md).

## Registro de Cambios

* **2026-09-23** · Creado con las frases iniciales de la sesión de trabajo.
* **2026-09-23** · Añadido punto sobre conectar proveedores y modelos propios para la instancia elegida.
* **2026-09-23** · Añadido punto sobre selección de temas desde el catálogo e integración con Open VSX.
* **2026-09-24** · Añadida la regla de comunicación sencilla y migración del detalle técnico a `odd/tasks/`.
* **2026-09-24** · Clarificación de la arquitectura de Pi: Pi vive dentro de PiCode como **Host**. Prohibida la escritura en `~/.pi/`. Opciones explícitas para conexión y migración externa.
* **2026-09-24** · Confirmado que **no existe extensión propia**: todo el desarrollo va dentro del núcleo del editor.
* **2026-09-25** · Regla de UI: La pantalla muestra acciones y estados (*Built*, *Stop build*), no explicaciones de funcionamiento interno.
* **2026-09-25** · Definición del idioma: El producto habla **inglés** para el usuario; la comunicación con el dueño y la documentación interna se mantienen en **español**.
* **2026-09-27** · Regla de los iconos: la marca de agua cambia de hogar al borrarse la carpeta `extensions/` por decisión del dueño («pues borrala»); pasa al núcleo (`.../contrib/picode/browser/media/`). El dibujo de trazos del editor vacío no cambia.
* **2026-09-27** · Añadida la regla de la ventana de gestión del chat: datos de pi (agents, skills, mcp, packages) y eliminadas Instructions, Prompts y Hooks.
* **2026-10-01** · Icono de la barra de actividad: es **la marca de PiCode**, no la rosa («lo de la rosa cambialo por el de picode»). Esa marca lleva pareja claro/oscuro, porque un icono de fila se pinta como imagen y una sola tinta desaparece en uno de los dos temas.
* **2026-10-01** · Regla de estilo visual: iconos y emoji siempre («añade siempre iconos, de marcas, de emojis etc»), con marcas reales y comprobadas; sin badge que no lleve a ningún sitio.
* **2026-10-09** · pi durable deja de ser experimental: vive en el source de PiCode («tratalo como algo ya que vive en picode»). Su casa es `durable` y en la UI se llama Durable agent, sin el "(experimental)".
* **2026-10-13** · Regla de fases visibles: el trabajo por fases se muestra en el panel de pi (`set_plan`, widget de pi-plan-widget) («tengo una lista con fases y no se ven»). Confirmado funcionando por el dueño.
* **2026-10-14** · Builds sin instalador por defecto: solo pack portable; el instalador solo a petición explícita («Generame solo la build portable luego y no el instalador»). 
* **2026-10-16** · Una sola release por canal: al publicar una release nueva, el pipeline borra la anterior del mismo canal («recuerda borrar la release anterior siempre»). 
* **2026-10-16** · Página de release: resumen agrupado por tipo de cambio + changelog, siempre («recuerda añadir tu siempre el texto de la release mejorado y con el changelog»).
* **2026-10-16** · `odd/tasks/` deja de usarse: la carpeta se retira por decisión del dueño («odd ya no lo usamos») y el detalle técnico queda en `docs/`.
* **2026-10-16** · Aclaración a «no existe extensión propia»: el conector (`extensions/picode`) es código del núcleo, viaja en el árbol y se empaqueta con el editor — no es una extensión aparte que se instala.
* **2026-10-16** · Documentación por carpeta: cada carpeta lleva su `README.md` al lado del código, el mapa `docs/MAPA.md` se **genera** con `build/docs.mjs map` y CI vigila que no aparezcan carpetas sin ficha (`build/docs.mjs check`) («deja avisado algo en el agents.md no? de usar esto»).
* **2026-10-16** · El pi del PATH: **nunca** se toca a mano («esto no lo toques NUNCA, es el pi que estamos corriendo ahora mismo»), pero **sí vía la app** — si el HOST conectado es el externo (PATH), el producto debe poder actualizar su Pi y sus Packages («si conectamos el HOST que sea el Externo (PATH) debería poder actualizar Pi y Packages del externo»).
* **2026-10-20** · Memoria del producto: **pi piensa, durable recuerda lo que pasó, engram recuerda lo que importa** («Pi es el agente | Durable las sesiones y el registro | Engram la memoria»). Engram viaja dentro de PiCode y sirve a los dos motores («quiero a engram en el producto… si un usuario escribe engram tiene que funcionar»). Su almacén vive en `~/.engram`, se reutiliza si existe y se comparte con otros agentes — con su coste aceptado: no viaja con el perfil («él puede leer si ya hay algo existente o crearlo en el pc del usuario»). Todo lo que su TUI muestra se muestra en el editor, en superficies que ya existen («tienes que añadir todo lo que engram muestra en el TUI en el Editor de PICODE»). Registro punto por punto en [`docs/ENGRAM.md`](docs/ENGRAM.md).
* **2026-10-22** · Texto del editor: **todo texto que va en el editor se escribe con carácter funcional para el usuario** («todo texto que va en el editor en su mayoría son escrito con carácter funcional para el usuario»). Etiquetas, mensajes, tooltips, notificaciones y filas del panel hablan de qué hay y qué se puede hacer, sin nombres de código, rutas ni detalles de la maquinaria interna.
* **2026-10-25** · Durable sale del producto: **el producto es Pi + Gentle AI** («quiero quitar todo durable, ya que impacta con Gentle»). La lista del panel pasa a ser la de los transcríptos de pi; ADR-030 sustituye a ADR-018, 020 y 021. Siguen: entrada de gentle-pi y gentle-engram.
* **2026-10-25** · gentle-pi y gentle-engram entran como paquetes fijados del producto, sin su terminal, con la telemetría apagada y sin descargar el programa auxiliar (ADR-031). La memoria de pi pasa a ser la de gentle-engram.
* **2026-10-25** · El panel Tasks enseña los subagentes de gentle-pi, a partir de lo que gentle-pi ya publica (ADR-032).
* **2026-10-25** · Los modelos de los agentes de gentle se eligen desde el editor, con `/gentle:models` o la vista de estado («quiero poder los modelos que yo quiera a cada uno»; ADR-031, adenda 4).
* **2026-10-25** · Lo de gentle-pi se queda dentro del perfil de PiCode (nada en `~/.pi`), y el paquete `@earendil-works/pi-durable` se deja atrás en las importaciones y no se ofrece actualizar (ADR-031, adenda).
* **2026-10-25** · Un solo sistema de subagentes y una sola memoria: los de gentle («¿no debería siempre elegir el de gentle?»). Los paquetes que hacen lo mismo (`@tintinweb/pi-subagents`, `pi-interactive-subagents`, `pi-memory`) se dejan atrás en las importaciones y se apagan en el perfil (ADR-031, adenda 2).
* **2026-10-25** · Los subagentes de gentle-pi arrancan el pi que lleva el editor (antes fallaban con «spawn pi ENOENT»), y el panel Tasks ya los enseña (ADR-031, adenda 3). Sus agentes `review-*` solo funcionan dentro de la revisión nativa, que necesita el programa auxiliar que el producto no instala.
* **2026-10-26** · Engram al cerrar: la **última ventana** de PiCode que se cierra apaga el engram **que PiCode arrancó** («engram debería cerrarse si se cierra picode no?», «que sea el último proceso de picode el que cierre engram»); uno que ya estaba sirviendo de otro agente no se toca nunca. Antes quedaba suelto y retenía archivos de la carpeta de PiCode.
* **2026-10-26** · pi-intercom viene de serie («Haz que venga de serie»): las sesiones de pi se pueden mandar mensajes entre sí. Fijado como gentle-pi y gentle-engram, con sus datos dentro del perfil y su proceso intermediario arrancado con el propio editor, sin Node instalado (ADR-033).
* **2026-10-26** · Cada chat del editor es su propia conversación de pi («si hazlo»): un chat nuevo ya no sigue escribiendo en el anterior, cada uno sale como su fila en Sessions y los chats abiertos se ven entre sí en pi-intercom, con el nombre de su primer mensaje (ADR-033, adenda 1).
* **2026-10-27** · El chat puede buscar y leer las conversaciones anteriores de la lista Sessions, también las de antes de cerrar PiCode («sí, haz que pi pueda buscar y leer mis conversaciones anteriores de la lista Sessions»; ADR-033, adenda 2).
* **2026-10-27** · Actualizaciones pequeñas: **hotfix, minor update y release** («un sistema de hotfixes rápidos que no sea rebuildeando todo», «no quiero subir una 0.3.2 a 0.3.3 y encontrarme problemas»). Una sola numeración; el zip pequeño lleva solo lo que cambió, se prueba antes de publicar, va firmado y, si la versión nueva no arranca, se vuelve sola a la anterior (ADR-034, `docs/HOTFIX.md`). Al probarlo se arregló un fallo antiguo de la actualización portable: su script se movía a sí mismo y la dejaba a medias.
* **2026-10-29** · Las piezas fijadas de Gentle AI se actualizan solas («un sistema para poder actualizar gentle-ai aunque sea casi automatizado o full automatizado»): un bot diario mueve el pin, lo seguro se fusiona solo en `experimental` y lo demás espera revisión; el motor de engram siempre espera (ADR-035).
* **2026-10-29** · Todo se actualiza desde la app («quiero que se pueda actualizar todo desde la app, desde pi, engram, gentle, etc.»): las piezas de Gentle AI y el motor de engram salen en *Updates* con el resto, y el pin del producto pasa a ser el mínimo, no el techo (ADR-035, adenda 1).
* **2026-10-29** · Gentle Shell revisado: es la parte de terminal de gentle-pi y no se integra entera; solo se trae su consumo de suscripción. La tarjeta *Usage limits* enseña ChatGPT y Claude además de NaN, con avisos al 80 % y al 95 % («Sí, tráelo»; ADR-036).
* **2026-10-29** · Comandos en el chat revisados uno a uno («revisa que todos los comandos de gentle-ai y pi estén usables y disponibles en el chat del editor»): las skills del menú `/` ya se cargan, los comandos del terminal de pi (`/compact`, `/session`, `/export`, `/name`…) los responde el editor, las plantillas salen en el menú y lo que solo existe en el terminal se dice claro y se oculta del menú (ADR-037).
* **2026-10-29** · El chat aprende solo qué comandos son de terminal y los quita del menú («automatizalo claro»); al instalar un paquete, sus comandos, plantillas y skills entran solos, sin reiniciar («si instalo packages quiero que se integre todo») (ADR-037, adenda 1).
* **2026-10-29** · `/export` guarda donde debe y se abre en el navegador integrado («Cuando le des a open it quiero que lo abras con el explorador integrado»); las conversaciones antiguas también tienen los comandos en el menú `/` (ADR-037, adenda 2).
* **2026-10-30** · Dictado por voz en el chat, en el equipo y sin nube: el mismo modelo y motor que fija Gentle, con el micrófono del editor. Se descarga a petición (≈ 700 MB, con firmas), se dicta frase a frase y nunca se envía solo. Plan, resultados y límites en [`docs/VOZ.md`](docs/VOZ.md).
* **2026-11-01** · Dos diseños, *Agent* o *Editor* («quiero poder elegir entre agente o entre editor en el setup o en las opciones», «Classic sería el Editor»): *Agent* pone el chat en el centro y las sesiones a la izquierda en el mismo editor; *Editor* es el VS Code de siempre.
* **2026-11-01** · Avisos del chat más discretos y razonamiento siempre a la vista («queda algo feo lo de gentle ahí ese texto y lo de los mcp's… avisa muy raro», «que siempre se vea el thinking lo que hace»): el informe de arranque de gentle-pi ya no sale; los MCPs que piden entrar se avisan en una sola línea con su *Sign in*, una vez por ventana; y el razonamiento de pi sale abierto mientras trabaja y se queda abierto.
* **2026-11-01** · Cualquier idioma debe traducirse bien («quiero que cualquier idioma se traduzca bien»): el paquete de idioma de Microsoft no conoce lo que PiCode añade o reescribe, así que PiCode lleva sus propias traducciones por idioma (`src/vs/workbench/contrib/picode/l10n/`), que el editor mezcla sobre el paquete instalado; `node build/l10n.mjs check` vigila que cada idioma esté completo.
* **2026-11-01** · Los 13 idiomas son de verdad («quiero que cualquier idioma se traduzca bien», «traduce todos los textos»): las cuatro superficies que el usuario lee —el editor (1.315 frases), la ventana de primer arranque (209), lo que dice el conector (537) y los títulos de sus comandos en la paleta (46)— llegan traducidas a `cs`, `de`, `es`, `fr`, `it`, `ja`, `ko`, `pl`, `pt-br`, `ru`, `tr`, `zh-cn` y `zh-tw`. El texto del código sigue en inglés y los ficheros de idioma **no se escriben a mano**: `build/l10n.mjs` los saca del código (`extract`), reparte por trozos lo que falta (`split`), junta lo traducido (`merge`) y `check` para CI si a un idioma le falta una frase, se come un `{0}` o el bundle se quedó atrás. Detalle y reglas: [`docs/IDIOMAS.md`](docs/IDIOMAS.md) · decisión: ADR-038.
* **2026-11-02** · El estado de la derecha no se pierde al encogerla («que entorno al hacerse la parte derecha más pequeño vuelva a estar en el listado de arriba a la derecha de iconitos. Para poder ponerlo solo a él o al explorador de ficheros»): *Status* entra como una vista más de esa barra, con su icono en la fila de arriba, y su columna se recoge cuando el panel es lo que está abierto. Con la barra estrecha se elige ahí, como cualquier otra vista.
* **2026-11-02** · *Status* es o columna o pestaña, nunca las dos («quería que estado se ocultara de la izq y fuera a la derecha cuando la barra de la derecha fuera pequeña y saliese en el icono, si no, se oculta el icono y luego aparece estado + lo que sea»): con la barra ancha, columna y sin icono arriba; estrecha, solo el icono. Corrige el diseño que salía duplicado.
* **2026-11-02** · Estado vuelve si era la pestaña abierta («si estaba en estado al estar achicado y no en explorador pues eso, que es lo natural no?»): al estrechar la barra se recupera la pestaña que había antes de ensancharla. Y los iconos de la barra derecha se ordenan al entrar en Agent («reorganiza bien los iconos de arriba»): Estado, explorador, búsqueda, control de código, terminal, problemas, salida, depuración y extensiones.
* **2026-11-02** · *Status* enseña lo mismo que el panel de PiCode («mejores sumarize con todo lo que tiene Picode… tareas en segundo plano sería lo que tiene tareas (tasks) de la ext picode, y añadir la parte de Memoria»): *Tasks* (lo que está en marcha y lo terminado) y *Memory* (recuento, carpetas abiertas, búsqueda y comprobación); el icono de PiCode ya no sale en Agent, y el icono suelto de arriba de la columna de sesiones tampoco («y pq hay un iconito ahí en la vista agentica?»).
* **2026-11-02** · La primera vez en Agent, la barra derecha solo con *Status* y el chat y Bienvenida al 50 % («cuando abras por primera vez solo salga el sumarize a la derecha… el welcome y el chat cojan 50% cada uno»); si se cierra Bienvenida no vuelve a abrirse sola («y si cierro welcome que no vuelva a salir cada vez que abro o cierro»). Los arranques siguientes respetan lo que el usuario dejó.
* **2026-11-02** · Todo lo nuevo de *Status* sale traducido a los 13 idiomas («falta esto por traducir creo y también imagino que lo de las tareas»), y se arregla que lo que dice el conector salía en inglés aunque estuviera traducido: el editor no leía su carpeta `l10n` por ser una extensión integrada (`docs/IDIOMAS.md`).
* **2026-11-02** · El asistente prepara el idioma del editor («que el setup cogiera el lenguaje que tienes en el pc y de mientras… se descargue ese lenguage (la extension de vscodium)»): detecta el idioma del equipo, baja en segundo plano el paquete de idioma de Microsoft desde Open VSX y el editor lo instala en su primer arranque, con el aviso de VS Code para reiniciar. El idioma del editor no se puede cambiar en vivo desde el asistente porque se fija al arrancar; la actualización de PiCode sigue siendo la del actualizador de siempre (`docs/IDIOMAS.md`).
* **2026-11-02** · README público al día («actualiza el readme con lo nuevo que se ha añadido»): los dos diseños Agent o Editor, la columna *Status* (con las líneas añadidas y quitadas, las tareas y la memoria), los 13 idiomas y el asistente que prepara el idioma.
* **2026-11-02** · La bienvenida del asistente habla de la cuenta («quita lo de agente, modelo y tema… el texto de los 3 pasos cámbialo por algo de tu cuenta»; «que salga algo de registrarse y de la versión pro»): sin las tres tarjetas; el cuadro de la cuenta dice qué es (gratis, con correo, Google o GitHub; Pro añade la sincronización en la nube), tiene *Entrar o registrarse* y un enlace a los planes, y sus estados (esperando, sesión iniciada, cerrar sesión) se ven como botones y no como enlaces con flecha.
* **2026-11-02** · El selector de idioma del asistente lleva la bandera del país («pon la banderita del país para que se vea bien»): el botón enseña la bandera y el idioma en uso, y su lista (que se abre hacia arriba, con teclado) pone la bandera de cada uno de los 14. Las banderas van dibujadas en vectorial (`resources/onboarding/flags.js`) porque en Windows las banderas emoji salen como dos letras.
* **2026-11-02** · El asistente abre en el idioma del equipo y deja el idioma puesto en el editor («mi pc está en español, picode tiene que abrir en español el setup y automáticamente instalar el idioma español en el editor»): el asistente salía en inglés porque el navegador de dentro del editor dice el idioma del editor y no el del equipo, así que ahora el proceso principal le da la lista de idiomas del sistema. Tras el primer asistente el editor instala el paquete y cambia a ese idioma solo (se reinicia una vez); tras uno posterior, ofrece el cambio.
* **2026-11-02** · En el primer arranque, *Agent* sale marcado por defecto y con la etiqueta *Nuevo* («marca agente por defecto y pon algo como "nuevo"»): se guarda desde el principio, así que dejar el paso tal cual u omitir la configuración lo mantiene. Un asistente posterior respeta lo que la persona ya tiene. *Editor* sigue siendo el valor de serie del programa.
* **2026-11-02** · El asistente no salta arriba al elegir y tiene su propia barra de desplazamiento («cuando elija una config de gentle que no me suba cada vez arriba… y dale diseño a la barra de scroll»): al repintar un paso se guarda y se devuelve la posición, y solo llegar a otro paso empieza arriba; la barra es una píldora fina con los colores del producto en lugar de la blanca del sistema.
* **2026-11-02** · El número del editor sube a la 1.144.0 antes de la release 1.0.0 («cuidado vscode ha sacado 1.144.0, revisa changelog que puede venirnos bien y sube hasta ahí»): como manda ADR-016 se subió solo el número declarado, tras medir que la API estable de extensiones es idéntica de la 1.142.0 a la 1.144.0. De las novedades de la 1.143 y la 1.144 casi todo es de Copilot y de su ventana de agentes; lo útil para traer a mano queda anotado en el ADR-016.
* **2026-11-02** · pi sube a la 1.5.0 («Pin y mejoras»): el pi de serie pasa de la 1.4.0 a la 1.5.0, tras comprobar que gentle-pi, gentle-engram y pi-intercom siguen valiendo. Al iniciar sesión con código, el editor copia el código y abre la página solo; el coste del panel Status lleva «~» cuando es una estimación y no lo que facturó el proveedor; y al actualizar un paquete que trae su lista de cambios, aparece el botón «What’s new».
* **2026-11-02** · What's New avisa del diseño nuevo («en el whats news sale lo del nuevo layout? estaría bien poder avisar ahí a la gente para que pueda cambiar»): si las notas hablan de *Agent* y la persona sigue en *Editor*, la ventana lleva el botón *Try the Agent layout* que cambia en el momento. Sale la release 1.0.1 con todo lo anterior.
