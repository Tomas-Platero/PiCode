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

| **Los proveedores, en un formulario** | Una fila por proveedor con sus cuatro campos (nombre, dirección, dialecto, clave), pintada por un widget del núcleo: añadir, editar y borrar en su sitio, sin ventanas |
| **La lista de suscripciones** | ChatGPT Plus/Pro, Claude Pro/Max, Copilot, Grok, Kimi… los ocho que el pi instalado sabe conectar con OAuth (medido: 41 proveedores, 8 con suscripción), ordenados por los más usados y con los ya conectados marcados |
| **Proveedores, en su nodo** | `Settings > Chat > Providers`, con `picode.providers`; el nodo `pi` se queda para los ajustes de pi |
| **La integración de pi con el chat** | El modelo del selector es el que corre pi (y lo cambia en caliente), el nivel de pensamiento, el contexto del editor viajando con el mensaje, el razonamiento cuando se pide, y el progreso diciendo *qué* hace la herramienta |
| **Los ajustes de pi, en `Settings > Chat > Pi`** | Tres ajustes que hacen algo: cuánto piensa, si enseña el razonamiento y si el contexto del editor viaja. Los cinco que ya no aplican quedan dichos, con su porqué, en el papel de la tarea |
| **Los MCP del editor, conectados al pi interno** | pi no trae MCP (lo dice su README) pero deja añadirle herramientas: las herramientas de los servidores MCP del editor se le dan a pi, y las llama a través del editor, con sus permisos y confirmaciones. Trece comprobaciones ejecutadas |
| **Los ajustes, con los nombres y el orden del producto** | Nodo `PiCode` (antes Chat) y nodo `Settings` (antes pi), con `Providers` y `Settings` delante de las categorías del editor |
| **Fuera la ventana de agentes de VS Code** | Sus seis acciones no se registran: se acaban el botón «Open in Agents» de la barra, la entrada del menú del chat, el atajo `Ctrl+Shift+A`, los comandos de la paleta y el cartel de bienvenida. Sus dos consejos también fuera |

## Lo que está a medias

| A medias | Qué falta |
| --- | --- |
| **El conector** (`picode-source/extensions/picode`) | **Ya no es un cascarón**: 5.360 líneas en 24 ficheros, embarcado en el pack. Aporta al chat nativo el proveedor de modelos de pi, el participante `@pi`, herramientas MCP, asistente, importación de perfil y temas. Pendiente: comprobación en vivo (abrir el chat del editor empaquetado y hablar) |
| **El host de pi** | Lo que la ficha afirmaba («la sesión y la traducción están; falta la clase que las une») estaba **anclado al panel viejo**; en el modelo actual el pilotaje vive en el conector. Qué falta exactamente solo se sabrá abriendo el chat publicado y probándolo |
| **Los ajustes de pi en Chat** | Existe la fila de **Proveedores** en el núcleo (`picodeConfiguration.ts`, 172 líneas) además del proveedor de modelos del conector; el resto volverá cuando sus funciones existan |
| **El material viejo** | ~~Archivado en `legacy/`~~. El 2026-09-27 el dueño borró `legacy/` y la carpeta `extensions/` del panel («pues borrala»): la reconstrucción se apoya en el historial de git y en `.scratch/picode-pi-chat-ultima-copia.tar.gz`; los dos SVG de marca viven en el núcleo |

## Lo que falta, en orden

**Tamaño:** 🟢 pequeño · 🟡 mediano · 🔴 grande.

| # | Tarea | Tamaño | Qué desbloquea |
| --- | --- | --- | --- |
| 1 | **Que tus modelos salgan en la ventana del editor** | 🟡 | Es lo que hoy hace que `@pi` diga «Language model unavailable». La puerta del editor para registrar modelos es **estable**, y el catálogo de pi ya se lee |
| 3 | **La clase del host que une sesión y traducción** | 🔴 | Es la pieza más grande. Con ella, pi responde **con su propio bucle** y sus herramientas |
| 4 | **Registrar el host y apagar los otros agentes** | 🟢 | Que pi sea **el único** agente del editor. Va **después** del 3: apagarlos antes deja el selector vacío |
| 5 | **El asistente de primer arranque** | 🟡 | Preguntar qué hacer, con las tres opciones: pi de dentro · conectar uno externo · traerse la configuración |
| 6 | **Conectar a un pi externo / migrar su configuración** | 🟡 | Lo que el usuario puede elegir; nada se escribe fuera |
| 7 | **Las habilidades de los paquetes de Gentle-AI** | 🟢 | Su descubrimiento no sabe mirar dentro de un paquete de pi; hoy se ven sus agentes, no sus 13 habilidades |
| 8 | **Recuperar lo que valía del panel viejo** | 🟡 | Estadísticas de pi, sus comandos y las sesiones — dentro del Chat. El contexto del editor ya viaja con cada mensaje |
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
