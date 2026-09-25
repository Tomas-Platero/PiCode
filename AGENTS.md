# Lo que quiero, tal como lo digo

Este fichero es un registro, no una especificación redactada por el agente. Cada punto
lleva **la frase original** del dueño del proyecto y, debajo, qué significa en la
práctica. Si algo de aquí cambia, se cambia la frase o se añade una nueva; no se
reescribe la intención.

Vive en la raíz del repositorio para que cualquier sesión de trabajo lo lea antes de
tocar nada.

---

## La interfaz se juzga por lo que se usa, no por lo que se sabe

> "Mucho texto redundante y versiones redundantes. Quiero algo funcional, no técnico."

En la práctica:

- Un dato aparece **una vez**. Si el mismo número se puede leer en tres sitios del mismo
  panel, sobran dos.
- Los valores internos del sistema no salen a pantalla: la ruta absoluta de un binario,
  el nombre de la fuente de un dato, pares de banderas sin traducir. El dueño decide con
  *está / no está*, *funciona / no funciona*, *versión*, *hay actualización*.
- Lo que exige una acción se convierte en **botón**. "Reinicia pi" no es información: es
  algo que el panel puede hacer por él.
- Un panel de estado que ocupa media pantalla para decir "todo bien" está mal resuelto.

## Los iconos

> "Tengo un svg para el menú de la izq para gentle-ai"
>
> "Es una rosa, es el logo de gentle-ai"

- El icono de la barra de actividad de Gentle AI es **su rosa**, en
  `extensions/picode-pi-chat/media/gentle-ai.svg`: SVG, monocromo y sin fondo.
- La barra de actividad dibuja el icono como **máscara**: solo cuenta la silueta. Un
  fondo que cubra el lienzo lo convierte en un cuadrado macizo.

> "El logo que cambiamos en el centro de la pantalla... no uses el png usa el svg"

- El marcador de agua del editor vacío usa el **dibujo vectorial de trazos**
  (`media/picode.svg`), no la marca con su placa de fondo: a ese tamaño la placa se ve
  como un bloque oscuro sobre el fondo del editor.

## El método se llama ODD

> "y ya no es SDD es ODD"

- La metodología de la capa Gentle AI es **ODD (Organic Driven Development)**. SDD es
  una rama dentro de ODD, no el nombre del método.
- En lo que el dueño lee, «SDD» no aparece como nombre del método. Lo que sí pertenece a
  esa rama —sus comandos y sus artefactos— conserva su nombre propio.

## El pi del editor es nuestro, y se gobierna desde aquí

> "no quiero que la versión de picode que vive en nuestro editor sea fija,
> quiero poder actualizarlo desde el editor"
>
> "El perfil de pi me gustaría que fuera interno y la configuración, etc también
> interna, pero poder 'importar' de la del pi del path"

En la práctica:

- El pi que corre dentro del editor no es una versión congelada a mano: se actualiza
  **desde el propio editor**, sin editar ficheros ni reinstalar el editor.
- Su perfil —ajustes, credenciales, modelos, paquetes, skills, **MCPs** y memoria— vive
  **dentro de PiCode**.
- **Nada se lee ni se escribe fuera de PiCode.**

> **Lo que decían antes estas frases ya no es la regla**, y se conservan como registro: «el pi
> del PATH y el del editor dejan de compartir carpeta», «se puede importar lo del pi del
> PATH», y la regla de seguridad que activaba el perfil solo con credenciales. Las tres
> suponían **dos pi**, uno dentro y otro en el PATH. Ver la frase del final de esta sección,
> que las sustituye.

> "necesito que en la config de modelos también podamos conectar proveedores, y
> modelos y tal para cualqueir pi ya sea para el interno o el externo."

En la práctica:

> **Superada por la frase del final de la sección.** No hay «instancia elegida»: hay un solo
> pi, el de PiCode, y su configuración se conecta ahí.

- La configuración de modelos conecta proveedores y declara endpoints y modelos propios
  (`models.json`) **dentro de PiCode**.
> "Pi vive dentro de PiCode (Vscodium), es el HOST, el que maneja todo, agents, skills, etc.
> NUNCA vamos a añadir nada del path, yo tengo otro pi aquí para desarrollar esta app, que
> eres tú cacho cabezón."
>
> "Mete esto en el Agents.md olvidate del pi del path"

- **Hay un solo pi: el que vive dentro de PiCode.** Es el **host**: el que maneja todo
  —agentes, skills, proveedores, memoria—. No hay un segundo pi con el que comparar,
  elegir ni sincronizar.
- **Nada se escribe nunca en el pi externo.** Ni configuración, ni credenciales, ni skills,
  ni sesiones. Esto es lo absoluto, y es lo que las frases de abajo protegen.
- **Pero conectarse a él sí es una opción que el usuario puede elegir.** PiCode usa su pi
  integrado por defecto —es el host—, y si alguien quiere, puede **conectarse a un pi
  externo** (por RPC, por WebSocket o por lo que pi exponga) para usar **sus datos y su
  configuración**, que viven fuera de PiCode. Conectarse no es copiar: los datos se usan
  donde están.
- **Y en un caso puntual, se puede ofrecer migrar** toda la configuración del pi del PATH al
  interno. Es una **oportunidad que se ofrece**, nunca algo que pasa solo ni por defecto.
- La diferencia con lo que se retiró es el matiz: no es que esté prohibido mirar fuera, es que
  **nada sale de PiCode hacia fuera, y nada entra sin que el dueño lo pida**.
- Consecuencia práctica: lo que se configure **vive en el perfil de PiCode**, y el editor
  corre su propio pi salvo que el usuario decida otra cosa.

> "lo que si OLVIDATE de una extensión, todo ha de vivir en el núcleo."

- **No hay extensión propia de PiCode, y no la habrá.** Todo vive en el **núcleo del
  editor**: el chat, los proveedores, los modelos, los ajustes, las habilidades y los
  agentes. Una extensión al lado es justo lo que hay que evitar, aunque funcione.
- La superficie que exista es **la del editor**: Chat y Agente. No una pestaña, ni un panel,
  ni unos ajustes aparte.
- Consecuencia para cualquier trabajo: si algo hay que construirlo «en la extensión», está
  mal planteado. La pregunta correcta es dónde va **dentro del núcleo**.

> "y no ha de guardar NADA en el pi externo, si no en el interno, olvidate de la carpeta
> /.pi/ que hay en tapla"

- **Se escribe siempre en el perfil propio de PiCode, sin excepciones.** Da igual qué pi
  esté elegido para ejecutar: la carpeta del pi del PATH (`~/.pi/`) **no se toca**, ni para
  guardar ni para leer. Esto **corrige** lo que decía antes este mismo punto —«con el pi del
  PATH elegido, escribir en su perfil es configurar ese pi»—: era la decisión de entonces y
  ya no lo es.
- **El pi del PATH no lo ejecuta el producto.** Existe para desarrollar PiCode y no es una
  pieza del editor: el editor corre su propio pi, el del núcleo.
- Esto refuerza lo de abajo (la nube): la unidad que se sube y se baja es el perfil propio,
  y un perfil compartido con la máquina no se puede subir ni sobreescribir desde un producto.
- Las claves de un endpoint se guardan como **variable de entorno** —lo recomendado— o como
  valor; nunca se enseñan de vuelta en pantalla.

> "Vamos a ver, necesito integrar los temas de https://vscodethemes.com para que tanto en
> la primera instalación como en cualquier momento puedan elegirse uno de esos temas."

En la práctica:

- Elegir el **tema del editor** está en tres sitios y es el mismo sitio por dentro: el paso
  «Tema» del asistente de primer arranque, la fila de la categoría **Aspecto** en los
  ajustes, y el comando de la paleta y del menú de PiCode.
- El catálogo sale de **Open VSX**, la galería desde la que este editor *instala* de verdad,
  no del Marketplace de Microsoft.
- **`vscodethemes.com` es un escaparate, no un origen**: escanea ese Marketplace y no aloja
  ningún tema. Se queda como el sitio al que se va a mirar sus capturas, enlazado desde
  cada tema; un tema que solo esté allí no se puede instalar aquí, y se dice.
- La vista previa la pinta PiCode con **los colores del propio tema**, nunca con la captura
  de otro: se ve la verdad, funciona sin red y no depende de permiso de nadie.
- Aplicar un tema **instala si hace falta** y deja el tema en vigor; el reinicio de ventana
  solo se ofrece cuando de verdad hace falta.

## El programa es gratis; lo que se vende es la nube

> "el servicio que voy a vender no es el programa de picode, este será gratuito 100%,
> si no la posibilidad de guardar toda configuración, ya sea de picode, pi o gentle
> en la nube"

En la práctica:

- PiCode es gratis y completo. Ninguna función se recorta para vender el servicio, y nada
  de lo que hace depende de la nube para funcionar.
- Lo que se vende es **guardar toda la configuración en la nube**: la de PiCode, la de pi y
  la de Gentle AI, como una sola cosa.
- Consecuencia de ingeniería, y es la que manda: esa configuración tiene que vivir en **un
  sitio propio de PiCode** y poder subirse y bajarse **como una unidad**. Por eso el perfil
  interno no es solo aislamiento — es la unidad que se sincroniza. Un perfil compartido con
  `~/.pi/agent` pertenece al usuario y a cualquier otra herramienta de la máquina: eso no se
  puede subir ni sobreescribir desde un producto.
- Importar lo que ya existe en el pi del PATH deja de ser una comodidad y pasa a ser el
  **camino de entrada** de quien ya tiene perfil: repetible, y sin sobreescribir nada por
  defecto.
- **Las credenciales son la parte delicada.** `auth.json` guarda tokens de proveedor; subir
  eso a la nube exige cifrado y consentimiento explícito. Copiarlas o subirlas es siempre
  una decisión del dueño, nunca un efecto colateral.

## Cómo quiero que se trabaje

> "No me pidas permisos ni que revise yo nada, termina TODAS las fases."

- Autorizado un trabajo, se ejecuta entero y sin interrupciones. Las decisiones de
  producto que no estén cerradas se toman, se registran por escrito y se informan al
  final; no se convierten en una pregunta a mitad.
- Lo que no se pueda terminar se dice **con la misma claridad** que lo terminado. No se
  marca como hecho lo que no lo está.

> "Una vez finalices dame un reporte."

- Al cerrar: qué está hecho y verificado, qué no, por qué, y dónde quedó registrado.

> "En español."

- *(Acotado el 2026-09-25: esto es para **lo que yo le hablo a él** y para los papeles que son
  suyos. La copia del producto se fue a inglés; ver «El idioma del producto», más abajo.)*
- Todo lo que el dueño lee —respuestas, paneles, mensajes de la interfaz, este
  fichero— va en español. Quedan en inglés solo las cosas que el proyecto exige así:
  mensajes de commit, comentarios de código e identificadores.

## El idioma del producto

> "NOno a ver todo ha de estar en ingles, tu me hablas en español, ya costruiremos paquete
> sde lenguajes para todos los demás idiomas. Pero a priori en inglés."

En la práctica:

- **Lo que enseña el producto va en inglés.** Ventanas, avisos, títulos de comandos,
  descripciones de ajustes y las etiquetas con las que el chat cuenta lo que hacen las
  herramientas de pi. Una sola lengua en pantalla, y es inglés.
- **Él y yo seguimos en español**: las respuestas, los reportes y los papeles de
  `odd/tasks/` y este fichero, que son suyos.
- **Los demás idiomas vendrán después, como paquetes de idioma.** Traduciendo la capa de
  encima, nunca las cadenas de origen: así se puede añadir, quitar o apagar un idioma sin
  tocar el producto. Por eso no se mezclan: una ventana no puede salir medio en un idioma y
  medio en otro.

## Háblame fácil

> "necesito que me expliques a partir de ahora todo muy sencillo, no necesito nada
técnico, quiero hablarte y que me hables funcional y fácil."

En la práctica:

- Se cuenta **qué hace y qué cambia para él**, no cómo está hecho por dentro. Nada de
  nombres de ficheros, de funciones, de tipos ni de siglas internas.
- Frases cortas y al grano. Si una explicación necesita un esquema para entenderse, está
  mal contada.
- Lo técnico **no desaparece: se muda**. Vive en los ficheros de `odd/tasks/`, que siguen
  llevando el detalle completo. En la conversación solo se dice lo que el dueño necesita
  para decidir o para saber si funciona.
- Cuando algo falla se explica **qué significa** —«no se pudo conectar», «falta esto»—, no
  por qué en términos de código.
- Los reportes de cierre también van así: cortos, en cristiano, y con lo que falta dicho
  con la misma claridad que lo que está hecho.

## La pantalla enseña lo que pasa, no cómo está hecho

> "para que quiero eso, omg"

En la práctica:

- Lo que expone la maquinaria —qué ficheros se escriben, dónde se guarda cada cosa, cuándo se calcula
  cada número— **no entra en pantalla**. Eso vive en la documentación y en los papeles de tareas, que es
  donde lo busca quien lo necesita.
- La pantalla dice **qué hay y qué puedes hacer**: *Built*, *Stop build*, *Clean*. Nada de "esto se
  escribe aquí cuando pasa aquello".
- Si un texto de interfaz se lee como una explicación de funcionamiento interno, está mal puesto: se
  quita o se muda a la documentación.

## Un aviso sobre quién ve qué

> "Me sigue saliendo el logo de vscodium..."

- Cuando algo "sigue saliendo" después de un arreglo, la descripción y el objeto casi
  nunca coinciden a la primera. Conviene averiguar **dónde se ve** —qué pantalla, qué
  esquina— antes de dar por hecho que el arreglo falló, y antes de suponer que el otro
  está mirando lo mismo que uno. Pasó dos veces: con el marcador de agua y con el
  interruptor de skills. Las palabras encajaban; las cosas no.

---

## Registro

- 2026-09-23 · creado, con las frases de esta sesión de trabajo.
- 2026-09-23 · añadido el punto de conectar proveedores y modelos propios para la
  instancia elegida, con la frase de esta sesión.
- 2026-09-23 · añadido el punto de elegir el tema del editor desde el catálogo, con la frase
  de esta sesión y la corrección de qué es vscodethemes.com.
- 2026-09-24 · añadido el punto de hablarle fácil: explicaciones sencillas y funcionales,
  y el detalle técnico mudado a los ficheros de tareas.
- 2026-09-24 · **pi vive dentro de PiCode y es el host**. Del pi del PATH no se **escribe**
  nada nunca; conectarse a él y migrar su configuración sí son **opciones a petición**
  (aclarado por el dueño).
- 2026-09-24 · **no hay extensión propia**: todo vive en el núcleo del editor.
- 2026-09-25 · **la pantalla enseña lo que pasa, no cómo está hecho**. Fuera de la interfaz las
  explicaciones de maquinaria interna (del tipo "esto se escribe aquí cuando pasa aquello"); van a la
  documentación. Añadido con la frase de la sección nueva.
- 2026-09-25 · **el producto habla inglés**. La copia que ve el usuario se traduce del
  español al inglés; el español queda para lo que yo le hablo a él y para los papeles suyos.
  Los demás idiomas, más adelante, como paquetes de idioma. Acota el punto «En español»,
  que hablaba de «mensajes de la interfaz».
