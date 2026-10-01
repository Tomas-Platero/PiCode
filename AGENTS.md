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

## 2. Marca e Iconografía

### Los iconos
>
> *"Tengo un svg para el menú de la izq para gentle-ai"*
> *"Es una rosa, es el logo de gentle-ai"*
>
> *"lo de la rosa cambialo por el de picode"* — 2026-10-01

* **Barra de actividad:** Usa **la marca de PiCode** (`extensions/picode/media/picode-status.svg`, el icono del contenedor). El registro decía antes que ahí iba la rosa; el dueño lo corrigió el 1 de octubre.
* **La rosa es de Gentle AI** y se usa **donde aparece Gentle AI**: la fila *Gentle AI* del panel de estado (`extensions/picode/media/gentle-ai.svg`).
* **Las dos marcas viven en el conector** (`picode-source/extensions/picode/media/`) y cada una lleva su **pareja claro/oscuro**: el icono de una fila del árbol se pinta como **imagen** (no como máscara), así que una sola tinta desaparece en uno de los dos temas.
* **Tratamiento como máscara:** La barra de actividad usa el icono como máscara (solo cuenta la silueta). No incluir fondos rellenos en el lienzo para evitar cuadrados macizos.

> *"El logo que cambiamos en el centro de la pantalla... no uses el png usa el svg"*

* **Marca de agua del editor vacío:** Utiliza el **dibujo vectorial de trazos** (`media/picode.svg`), no la versión con placa de fondo.

---

## 3. Metodología

### El método se llama ODD
>
> *"y ya no es SDD es ODD"*

* La metodología de la capa Gentle AI es **ODD (Organic Driven Development)**. SDD es solo una rama dentro de ODD.
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
>
> *"el servicio que voy a vender no es el programa de picode, este será gratuito 100%, si no la posibilidad de guardar toda configuración, ya sea de picode, pi o gentle en la nube"*

* **PiCode es 100% gratuito y completo:** No hay funciones recortadas ni dependencia de la nube para su funcionamiento local.
* **Valor comercial:** Sincronización y respaldo en la nube de toda la configuración (PiCode, Pi y Gentle AI) como un único bloque.
* **Unidad de perfil:** Toda la configuración vive en un perfil interno propio que se sube/baja como una unidad aislada.
* **Seguridad de credenciales:** `auth.json` y tokens requieren cifrado y consentimiento explícito del usuario antes de subir a la nube.

---

## 7. Formas de Trabajo y Comunicación

### Autonomía de ejecución
>
> *"No me pidas permisos ni que revise yo nada, termina TODAS las fases."*

* Una vez autorizado un trabajo, se ejecuta hasta el final sin interrupciones. Las decisiones de producto no cerradas se toman, se registran y se explican al terminar.
* Transparencia total: lo que no se pueda completar se informa con la misma claridad que lo terminado.

### Reportes de cierre
>
> *"Una vez finalices dame un reporte."*

* Al terminar: informe con qué está hecho y verificado, qué falta, por qué y dónde quedó registrado.

### Idioma del proyecto y del producto
>
> *"En español."*
>
> *"NOno a ver todo ha de estar en ingles, tu me hablas en español, ya costruiremos paquete sde lenguajes para todos los demás idiomas. Pero a priori en inglés."*

* **Producto (Interfaz):** Todo lo que ve el usuario final va en **inglés** (ventanas, avisos, comandos, ajustes, respuestas del chat sobre herramientas).
* **Comunicación interna:** La interacción con el dueño, los reportes y la documentación (`odd/tasks/`, `AGENTS.md`) se mantienen en **español**.
* **Internacionalización:** Otros idiomas se añadirán mediante paquetes de lenguaje sobre la capa superior, sin mezclar cadenas en el código base.
* **Excepciones técnicas:** Mensajes de commit, comentarios de código e identificadores permanecen en inglés.

### Comunicación clara y funcional
>
> *"necesito que me expliques a partir de ahora todo muy sencillo, no necesito nada técnico, quiero hablarte y que me hables funcional y fácil."*

* Explicaciones centradas en **qué hace y qué cambia para el usuario**, sin tecnicismos ni nombres de código/ficheros.
* Lenguaje directo y frases cortas.
* El detalle técnico se documenta de forma completa en `odd/tasks/`.
* Explicación funcional de errores: qué significa la falla (ej. "no se pudo conectar"), no la causa en el código.

### La ventana de gestión del chat habla de pi, no de Copilot
>
> *"Necesito que esta ventana contenga las cosas de pi y gentle-ai ejemplo: Agents - Agentes de Gentle. Skills - Skills tanto en pi, proyecto y gentle-ai. Instructions - esto quitalo. Prompts - Esto quitalo. Hooks - Esto quitalo (pi no tiene hooks). MCP Servers - Lista de servidores mcp de pi. Plugins - Listado de Packages de Pi."*

* La página **«Agent Customizations»** del chat debe listar los elementos reales del runtime pi (perfil en fuerza), no los de las convenciones de GitHub/Copilot.
* **Agents**: los agentes de Gentle/pi. **Skills**: las de pi, las del proyecto y las de gentle-ai. **MCP Servers**: los servidores mcp de pi. **Plugins**: los paquetes instalados de pi.
* **No existen** en este producto: **Instructions**, **Prompts** y **Hooks** (pi no tiene hooks) → fuera de la navegación y de la rejeta de la página.

---

## Registro de Cambios

* **2026-09-23** · Creado con las frases iniciales de la sesión de trabajo.
* **2026-09-23** · Añadido punto sobre conectar proveedores y modelos propios para la instancia elegida.
* **2026-09-23** · Añadido punto sobre selección de temas desde el catálogo e integración con Open VSX.
* **2026-09-24** · Añadida la regla de comunicación sencilla y migración del detalle técnico a `odd/tasks/`.
* **2026-09-24** · Clarificación de la arquitectura de Pi: Pi vive dentro de PiCode como **Host**. Prohibida la escritura en `~/.pi/`. Opciones explícitas para conexión y migración externa.
* **2026-09-24** · Confirmado que **no existe extensión propia**: todo el desarrollo va dentro del núcleo del editor.
* **2026-09-25** · Regla de UI: La pantalla muestra acciones y estados (*Built*, *Stop build*), no explicaciones de funcionamiento interno.
* **2026-09-25** · Definición del idioma: El producto habla **inglés** para el usuario; la comunicación con el dueño y la documentación interna se mantienen en **español**.
* **2026-09-27** · Regla de los iconos: la rosa y la marca de agua cambian de hogar al borrarse la carpeta `extensions/` por decisión del dueño («pues borrala»); pasan al núcleo (`picode-source/.../contrib/picode/browser/media/`). La intención —la rosa de la izquierda, el dibujo de trazos en el editor vacío— no cambia.
* **2026-09-27** · Añadida la regla de la ventana de gestión del chat: datos de pi/gentle (agents, skills, mcp, packages) y eliminadas Instructions, Prompts y Hooks.
* **2026-10-01** · Icono de la barra de actividad: es **la marca de PiCode**, no la rosa («lo de la rosa cambialo por el de picode»). La rosa sigue siendo el logo de Gentle AI y se usa donde aparece Gentle AI (su fila del panel de estado). Se añade que cada marca lleva pareja claro/oscuro, porque un icono de fila se pinta como imagen y una sola tinta desaparece en uno de los dos temas.
* **2026-10-01** · Regla de estilo visual: iconos y emoji siempre («añade siempre iconos, de marcas, de emojis etc»), con marcas reales y comprobadas; sin badge que no lleve a ningún sitio.
