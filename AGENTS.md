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
