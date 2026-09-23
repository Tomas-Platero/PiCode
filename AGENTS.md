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
  **dentro de PiCode**, no en `~/.pi/agent`. El pi del PATH y el del editor dejan de compartir
  carpeta: lo que se configure en uno no toca al otro.
- Si usa el pi propio de PiCode, **todo es propio**: paquetes, skills, MCPs, credenciales y
  memoria. Nada se lee ni se escribe fuera de PiCode, ni siquiera para consultarlo.
- Y desde ahí se puede **importar** lo del pi del PATH cuando el dueño lo pida. No se copia
  solo, y nada se sobreescribe sin decirlo: importar credenciales es una decisión, no un
  efecto colateral de abrir el editor.
- **Regla de seguridad, no de estilo**: el perfil interno no se activa si queda sin
  credenciales. Un perfil propio y vacío deja el editor sin poder hablar con ningún modelo,
  y eso no es aislamiento, es una avería. Primero se importa —o el dueño decide
  conscientemente empezar de cero—, y solo después se cambia la carpeta.

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

- Todo lo que el dueño lee —respuestas, paneles, mensajes de la interfaz, este
  fichero— va en español. Quedan en inglés solo las cosas que el proyecto exige así:
  mensajes de commit, comentarios de código e identificadores.

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
