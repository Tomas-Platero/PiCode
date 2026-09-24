# Tareas de PiCode — la lista

> **Esta es la única lista.** Los papeles sueltos de `odd/tasks/` son el registro de cómo se
> llegó hasta aquí, con sus aciertos y sus errores; para saber *qué queda*, manda este
> documento. Si algo de allí dice otra cosa, gana esto.

## Lo que ya está hecho, y con qué se prueba

| Hecho | Cómo se sabe |
| --- | --- |
| **Se compila desde la fuente** con parches fijados (12 parches) | Builds completas que terminan en `PiCode.exe` |
| **Copilot fuera del Chat** | El aviso que bloqueaba el chat desapareció; su causa se encontró en los registros reales, y eran **dos** |
| **El selector de modelos sin marca de Copilot** | Las cadenas comprobadas a cero en el editor construido |
| **Los ajustes de pi, dentro del nodo Chat** | Un nodo «pi» con comodín, bajo Chat |
| **El editor ve las personalizaciones de pi y de Gentle-AI** | La tabla de descubrimiento del núcleo incluye sus rutas |
| **La sesión de pi dentro del núcleo** | Escrita y compilando en modo estricto |
| **La traducción de lo que pi dice y hace** | Escrita y compilando: texto y herramientas |
| **La extensión vieja, fuera del producto** | No se compila ni se empaqueta; su material está archivado |
| **La copia del producto, en inglés** | Traducidas las cadenas del conector, las del ajuste de Proveedores y las del selector de modelos; el editor construido se barrió y no queda copia nuestra en español |
| **El conector, con casa en git** | Sus ficheros los crea `patches/picode/12-picode-connector.patch`: hasta ahora solo existían dentro de `vscode/`, y cualquier regeneración de parches se los llevaba por delante |
| **Los proveedores, declarados en los ajustes** | La cadena de cuatro ventanas, borrada; una línea por proveedor con sus campos en la fila de Proveedores, y once comprobaciones ejecutadas contra un endpoint local (la lista, la clave, los ficheros de pi) |

## Lo que está a medias

| A medias | Qué falta |
| --- | --- |
| **El conector** (`vscode/extensions/picode`) | El contenedor está creado y registrado en la compilación del editor, con su `activate` **vacío a propósito**. Le falta su primer contenido real: el puente de proveedores |
| **El host de pi** | La sesión y la traducción están; falta **la clase que las une** con todo lo que el editor pide a un agente |
| **Los ajustes de pi en Chat** | Solo existe la fila de **Proveedores**; el resto volverá cuando sus funciones existan |
| **El material viejo** | Archivado en `legacy/picode-pi-chat.tar.gz`, **sin migrar todavía** |

## Lo que falta, en orden

**Tamaño:** 🟢 pequeño · 🟡 mediano · 🔴 grande.

| # | Tarea | Tamaño | Qué desbloquea |
| --- | --- | --- | --- |
| 1 | **Que tus modelos salgan en la ventana del editor** | 🟡 | Es lo que hoy hace que `@pi` diga «Language model unavailable». La puerta del editor para registrar modelos es **estable**, y el catálogo de pi ya se lee |
| 2 | **Conectar proveedores desde el Chat** | 🟡 | Que la fila de Proveedores funcione: elegir ChatGPT, Claude, DeepSeek… y conectarlo **con cuenta o con clave** |
| 3 | **La clase del host que une sesión y traducción** | 🔴 | Es la pieza más grande. Con ella, pi responde **con su propio bucle** y sus herramientas |
| 4 | **Registrar el host y apagar los otros agentes** | 🟢 | Que pi sea **el único** agente del editor. Va **después** del 3: apagarlos antes deja el selector vacío |
| 5 | **El asistente de primer arranque** | 🟡 | Preguntar qué hacer, con las tres opciones: pi de dentro · conectar uno externo · traerse la configuración |
| 6 | **Conectar a un pi externo / migrar su configuración** | 🟡 | Lo que el usuario puede elegir; nada se escribe fuera |
| 7 | **Las habilidades de los paquetes de Gentle-AI** | 🟢 | Su descubrimiento no sabe mirar dentro de un paquete de pi; hoy se ven sus agentes, no sus 13 habilidades |
| 8 | **Recuperar lo que valía del panel viejo** | 🔴 | Contexto del editor (proyecto, fichero, selección), estadísticas de pi, sus comandos y las sesiones — **dentro del Chat** |
| 9 | **La nube** | 🔴 | Subir y bajar **el perfil como una unidad** |
| 10 | **Limpiar** | 🟢 | Borrar el archivo de cuarentena cuando ya no haga falta, quitar el paso del panel en la vía del ZIP (`distribution/apply-picode.ps1`) y retirar los papeles viejos |

## Lo que NO hay que hacer

Estas cosas están **decididas en contra**, y si alguien las propone, aquí está el porqué:

- **Un panel, una pestaña o unos ajustes propios de PiCode.** La superficie es el editor.
- **Escribir en el pi de la máquina.** Ni configuración, ni credenciales, ni sesiones. La
  dirección es una sola: hacia dentro.
- **Reimplementar proveedores, OAuth, habilidades o el orquestador.** pi y Gentle-AI ya los
  traen.
- **Duplicar un ajuste de pi en el editor.** Ya pasó con el modelo por defecto: se retiró, y
  hay una prueba que impide que vuelva.
- **Marcar algo como hecho porque compila.** El registro tiene tres casos de eso.

## El orden que propongo

**Primero el 1 y el 2**: son los que te desbloquean lo que estás intentando usar — conectar
tus modelos y verlos. **Después el 3 y el 4**, que es hacer que pi sea el agente de verdad.
Luego el 5 y el 6 (las opciones del usuario), el 7, el 8 (recuperar el panel), y al final el
9 y el 10.
