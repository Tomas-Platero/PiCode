# Tareas de PiCode — la lista

> **Esta es la única lista.** El historial de git y las páginas de release son el registro de
> cómo se llegó hasta aquí, con sus aciertos y sus errores; para saber *qué queda*, manda
> este documento. Si algo de allí dice otra cosa, gana esto.

> ✅ **Contrastado con el código (2026-10-16).** Hechas y verificadas: filas 1, 5 y 6 — el conector registra su provider de modelos en la API nativa (`extension.ts`), y el asistente de arranque con las tres vías (interno · externo · migración) vive en `onboarding.ts` y el wizard. Siguen abiertas: 3 y 4 — en `agentHost/node/pi/` solo están `piSession.ts` y `piActionMapping.ts`, aún sin la clase que une sesión y traducción.

## ✅ Lo que ya está hecho, y con qué se prueba

| Hecho | Cómo se sabe |
| --- | --- |
| **El número que leen las extensiones, en 1.141** | Un solo valor, `product.json`; el build lo escribe en `product.json` y `package.json`. Comprobado: 1.135.7 no cumple `engines.vscode: ^1.141.0` y 1.141.0 sí. **Nuestro código no cambió** — se decidió NO traer el refactor de upstream |
| **Se compila desde su propia fuente**, sin parches | `the tree` es el árbol propio, versionado aquí; `build/build.sh` produce `PiCode.exe` en cinco fases |
| **Copilot fuera del Chat** | El aviso que bloqueaba el chat desapareció; su causa se encontró en los registros reales, y eran **dos** |
| **El selector de modelos sin marca de Copilot** | Las cadenas comprobadas a cero en el editor construido |
| **Los ajustes de pi, dentro del nodo Chat** | Un nodo «pi» con comodín, bajo Chat |
| **El editor ve las personalizaciones de pi** | La tabla de descubrimiento del núcleo incluye sus rutas |
| **La sesión de pi dentro del núcleo** | Escrita y compilando en modo estricto |
| **La traducción de lo que pi dice y hace** | Escrita y compilando: texto y herramientas |
| **La extensión vieja, fuera del producto** | No se compila ni se empaqueta; su material está archivado |
| **La copia del producto, en inglés** | Traducidas las cadenas del conector, las del ajuste de Proveedores y las del selector de modelos; el editor construido se barrió y no queda copia nuestra en español |
| **El conector, con casa en el árbol** | Vive en `extensions/picode/`, versionado con el resto de la fuente; lo compila `build/build-connector.sh` en la fase 2. Ya no lo crea ningún parche |
| **Los proveedores, declarados en los ajustes** | La cadena de cuatro ventanas, borrada; una línea por proveedor con sus campos en la fila de Proveedores, y once comprobaciones ejecutadas contra un endpoint local (la lista, la clave, los ficheros de pi) |
| **Los proveedores, en un formulario** | Una fila por proveedor con sus cuatro campos (nombre, dirección, dialecto, clave), pintada por un widget del núcleo: añadir, editar y borrar en su sitio, sin ventanas |
| **La lista de suscripciones** | ChatGPT Plus/Pro, Claude Pro/Max, Copilot, Grok, Kimi… los ocho que el pi instalado sabe conectar con OAuth (medido: 41 proveedores, 8 con suscripción), ordenados por los más usados y con los ya conectados marcados |
| **Proveedores, en su nodo** | `Settings > Chat > Providers`, con `picode.providers`; el nodo `pi` se queda para los ajustes de pi |
| **La integración de pi con el chat** | El modelo del selector es el que corre pi (y lo cambia en caliente), el nivel de pensamiento, el contexto del editor viajando con el mensaje, el razonamiento cuando se pide, y el progreso diciendo *qué* hace la herramienta |
| **Los ajustes de pi, en `Settings > Chat > Pi`** | Tres ajustes que hacen algo: cuánto piensa, si enseña el razonamiento y si el contexto del editor viaja. Los cinco que ya no aplican quedan dichos, con su porqué, en el papel de la tarea |
| **Los MCP del editor, conectados al pi interno** | pi no trae MCP (lo dice su README) pero deja añadirle herramientas: las herramientas de los servidores MCP del editor se le dan a pi, y las llama a través del editor, con sus permisos y confirmaciones. Trece comprobaciones ejecutadas |
| **Los ajustes, con los nombres y el orden del producto** | Nodo `PiCode` (antes Chat) y nodo `Settings` (antes pi), con `Providers` y `Settings` delante de las categorías del editor |
| **Fuera la ventana de agentes de VS Code** | Sus seis acciones no se registran: se acaban el botón «Open in Agents» de la barra, la entrada del menú del chat, el atajo `Ctrl+Shift+A`, los comandos de la paleta y el cartel de bienvenida. Sus dos consejos también fuera |
| **La ronda de gestión (10 puntos, 2026-09-28)** | Ocho commits (`c7a5dcc5`…`32ddb840`): causa raíz del ByteString (la raya del `nameLong` en la cabecera user-agent), modelos al arrancar con reloj de 5 min, página MCP con «Servers» + editar/quitar + mcp.directory + deep link `vscode:mcp/install`, Packages como tabla con disable/enable/uninstall, Skills con «Browse Skill» → skills.sh y textos, Agents sin categorías y sin banner en Overview, chat sin modo «Agente» y MCP siempre activos, y notificaciones de actualización con botón Update (elemento de barra de estado abajo-izquierda, `pi update --all` tras parar sesiones). 158 pruebas del conector en verde, typecheck del núcleo en 0 |
| **Adopción de 1.141 + release 0.1.5-experimental** (2026-10-08) | Píldora de estado del agente sobre el chat (actividad, cola con cancelación, trabajos en background, empujada sin sondeos), MCP con origen por fila (perfil/proyecto/descubiertos), cancelación inmediata de turnos en cola, `picode.pi.disabledTools`, thinking en show por defecto, nan visible en Providers, ajustes muertos de la sección Agent fuera, corte del borde inferior del chat arreglado. Release publicada y verificada en GitHub |
| **El número declarado, subido a 1.141** (2026-10-08) | **Sin rebase**: el código es nuestro, solo se subió `set.version` a 1.141.0 (entonces quedó en 1.141.1) para que las extensiones que piden `^1.141.0` sigan instalándose. Riesgo medido contra un clon (la API estable no cambió). ADR-016 |
| **Pi interno 1.1.0** (2026-10-08; hoy 1.4.0 — la fuente de verdad es `build/distribution/runtime.json`) | `build/distribution/runtime.json` y `build/pi-runtime.sh`: 1.0.4 → 1.1.0, medido antes de fijarlo (las 7 entradas del SDK que usa el conector resuelven, el validador MCP de pi acepta los 12 escritores) |
| **Tres canales: Stable / Beta / Experimental** (2026-10-08) | Una rama por canal (`master`/`beta`/`experimental`), el feed en su propia rama, y el canal sellado en el build (`PICODE_CHANNEL` escribe `quality` y la rama del `updateUrl`). Hechas C1–C5; C6/C7 en marcha. ADR-015 |
| **Fuera el menú Help de VS Code, y el aviso de actualización fallida** (2026-10-09) | El menú se queda con las ocho entradas del producto (Welcome, Show All Commands, Documentation, Show Release Notes, Report Issue, View License, Check for Updates, About) y salen Editor Playground, Open Walkthrough, Get Started with Accessibility Features, Ask @vscode, Search Feature Requests, Toggle Developer Tools y Open Process Explorer; los comandos siguen en la paleta, `Ask @vscode` se retira entero y `requestFeatureUrl` pasa a `unset` del delta. `build/branding.mjs patch-inno-updater` marca ahora también las cadenas propias del binario (la caja de error, su título, el prefijo `vscode-inno-updater-`), las nueve lenguas del instalador dicen PiCode y la guarda de la fase 1 mira las dos formas |
| **pi durable deja de ser experimental y vive en el source** (2026-10-09) | `experimental/durable` → `durable`, el puente → `durable/bridge`, el cliente ACP → `host/durable/acp-client` (`git mv`, historia intacta). El editor lo busca en `durable` y `resources/durable` (antes `pi-durable`), la sección de ajustes se llama **Durable agent** y el agente ya no se presenta como experimento en su `package.json` ni sus papeles. 7/7 tests de rutas y spawn, tsc del conector en 0, `cli.js --help` desde su casa nueva |
| **Durable sale del producto: pi + Gentle AI** (2026-10-25) | Fuera `host/durable`, su puente, los ficheros del conector que le hablaban, sus comandos y ajustes, el interruptor del primer arranque y el paso del build. La lista del panel son los transcríptos de pi (`sessions-register.ts`) y Tasks muestra los trabajos del chat. ADR-030. Siguen: entrada de gentle-pi y gentle-engram, y los subagentes de gentle-pi en Tasks. |
| **Limpieza** (2026-09-29) | Fuera `apply-picode.ps1` (la vía del ZIP que lo usaba ya no existe), fuera ESLint y `.vscode/` del árbol, y el recorte lightweight de `the tree` |
| **Tus modelos, en la ventana del editor** | El conector registra su provider en la API nativa (`registerLanguageModelChatProvider` en `extension.ts`): el picker pide y el conector contesta con el catálogo de pi — «Language model unavailable» dejó de ser el camino |
| **El asistente de primer arranque, en ventana propia** (2026-10-23) | Ya no es un wizard dentro de la Welcome: la ventana se abre **antes** de que exista el editor (`resources/onboarding` + `src/vs/code/electron-main/picodeOnboarding.ts`), sirve para el primer arranque, la actualización y `PiCode: Setup`, y escribe a través del conector (`onboarding-host.ts`). El wizard viejo (`picodeSetup.ts`, 2.020 líneas) se **borró** de la Welcome, que ahora solo dice qué cubre el setup y ofrece el botón que lo reabre. Ver ADR-023 |
| **Conectar a un pi externo / migrar su configuración** | `picode.pi.runtime` en modo externo (se lee, nunca se escribe) y migración por importación explícita (`profile-import.ts`) — nada se escribe fuera |
| **La 1.142 en el árbol: seguridad, fugas y Markdown** (2026-10-17) | Cherry-picks de 1.142 sobre el árbol 1.135 **sin rebase** (ADR-016): hardening de webview y enlaces de comando (`d0482949`), las 60 fugas de 1.136–1.142 (`ee22339e`, `eb84f7bc`), el editor Markdown rico con la propuesta `customTextEditorNavigation` (`5e9faf9e`) y `set.version` → **1.142.0**. Verificado: typecheck a 0, suite 474, build completo en verde |

## 🚧 Lo que está a medias

| A medias | Qué falta |
| --- | --- |
| **El conector** (`extensions/picode`) | **Ya no es un cascarón**: ~18.600 líneas en 59 ficheros, embarcado en el pack. Aporta al chat nativo el proveedor de modelos de pi, el participante `@pi`, herramientas MCP, asistente, importación de perfil y temas. Pendiente: comprobación en vivo (abrir el chat del editor empaquetado y hablar) |
| **El host de pi** | El pilotaje vive hoy en el conector (`agent.ts`); del puente al host (`agentHost/node/pi/`) falta la clase que une sesión y traducción (filas 3 y 4). Pendiente: probar el chat publicado |
| **Los ajustes de pi en Chat** | Existe la fila de **Proveedores** en el núcleo (`picodeConfiguration.ts`, 172 líneas) además del proveedor de modelos del conector; el resto volverá cuando sus funciones existan |
| **El estado, en un solo sitio** (2026-10-22) | El árbol nativo del activity bar se retiró: sus ocho bloques decían lo mismo que la sección **Status** de la página de Agent Customizations, leída y pintada dos veces. Lo que el árbol tenía y las tarjetas no daban —el filtro— pasa a ser una caja de filtro dentro de la sección, que sobrevive a los refrescos; la fila de *Thinking*, que era un botón, es ahora un botón de verdad. Los MCP no se pierden: tienen su propia sección en esa misma página. Verificado: typecheck del núcleo y del conector en 0, y 52 ficheros de pruebas en verde |
| **El material viejo** | ~~Archivado en `legacy/`~~. El 2026-09-27 el dueño borró `legacy/` y la carpeta `extensions/` del panel («pues borrala»): la reconstrucción se apoya en el historial de git y en `.scratch/picode-pi-chat-ultima-copia.tar.gz`; los dos SVG de marca viven en el núcleo |

## 📋 Lo que falta, en orden

**Tamaño:** 🟢 pequeño · 🟡 mediano · 🔴 grande.

| # | Tarea | Tamaño | Qué desbloquea |
| --- | --- | --- | --- |
| 12 | **Tres canales: Stable / Beta / Experimental** | 🟡 | Una rama por canal: `stable`↔`master`, `beta`↔`beta`, `experimental`↔`experimental`, y **el feed vive en la rama de su canal** (una beta no puede recibir una release de stable ni equivocándose el pipeline). Hechas **C1, C2, C3, C4 y C5**: sellado del canal, trampa de versión, identidad de instalador y perfil por canal, y **un** workflow consciente de canal. C6 en marcha (primera release de beta disparando el pipeline) y queda C7 (verificación end to end, con tres instalaciones). El canal se llama `stable` — `rc` se retiró |
| 3 | **La clase del host que une sesión y traducción** | 🔴 | Es la pieza más grande. Con ella, pi responde **con su propio bucle** y sus herramientas |
| 4 | **Registrar el host y apagar los otros agentes** | 🟢 | Que pi sea **el único** agente del editor. Va **después** del 3: apagarlos antes deja el selector vacío |
| 7 | **Las habilidades de los paquetes de pi** | 🟢 | Su descubrimiento no sabe mirar dentro de un paquete de pi; hoy se ven sus agentes, no sus habilidades |
| 8 | **Recuperar lo que valía del panel viejo** | 🟡 | Estadísticas de pi, sus comandos y las sesiones — dentro del Chat. El contexto del editor ya viaja con cada mensaje |
| 9 | **La nube** | 🔴 | Subir y bajar **el perfil como una unidad** |
| 13 | **La memoria: engram** | 🔴 | Pi recuerda entre sesiones y entre agentes. Fase 0 cerrada; detalle punto por punto en [`ENGRAM.md`](ENGRAM.md) |

## 🚫 Lo que NO hay que hacer

Estas cosas están **decididas en contra**, y si alguien las propone, aquí está el porqué:

- **Un panel, una pestaña o unos ajustes propios de PiCode.** La superficie es el editor.
- **Escribir en el pi de la máquina.** Ni configuración, ni credenciales, ni sesiones. La
  dirección es una sola: hacia dentro.
- **Reimplementar proveedores, OAuth, habilidades o el orquestador.** pi ya los
  trae.
- **Duplicar un ajuste de pi en el editor.** Ya pasó con el modelo por defecto: se retiró, y
  hay una prueba que impide que vuelva.
- **Marcar algo como hecho porque compila.** El registro tiene tres casos de eso.

## 🧭 El orden que propongo

**Ya hechos**: 1, 5, 6 y 10. **Ahora tocan** el 3 y el 4 — hacer que pi sea el agente de verdad —,
después el 7 y el 8 (las habilidades de los paquetes y lo recuperable del panel), y al final el 9
(la nube).
