# resources/onboarding/ — 🧭 La ventana de configuración

La ventana que PiCode enseña **antes de que exista el editor**: la cuenta, cómo se reparte la
pantalla, qué modelo usa pi, el tema y dónde empezar. La misma página sirve para cuatro
situaciones; [`onboarding.js`](onboarding.js) lee `mode` y parte de lo que ya está configurado en
vez de volver a preguntarlo:

| `mode` | Cuándo |
| --- | --- |
| `first-run` | no hay `onboarding.json` para esta instalación |
| `update` | cambió el `onboardingVersion` guardado o la versión mayor del producto |
| `setup` | `PiCode: Setup` desde la paleta, con el editor ya abierto |
| `import` | `PiCode: Import from Pi or VS Code`: la misma ventana, solo con la vista Import |

## 🗺️ Los cinco pasos (2.3.0)

| Paso | Qué decide | Qué escribe |
| --- | --- | --- |
| **Welcome** | la cuenta de PiCode (opcional) y, como acción secundaria, *Import from Pi or VS Code* | nada; la importación tiene su propia vista |
| **Layout** | *Agent* o *Editor*, con un dibujo SVG de cada uno | `setLayout` |
| **Agent** | el modelo de las conversaciones nuevas, en **una sola lista con buscador**: los proveedores listos para usar, las suscripciones (inicio de sesión con el navegador) y las claves de API (OpenRouter, DeepSeek, Groq u otra dirección). El pi incluido es el de serie y sale plegado en una línea; el pi del equipo vive en *Advanced* | `setModel`, `addProvider`, `setRuntime` |
| **Look** | el tema, con una **vista previa al lado** (editor y chat en los colores del tema) | `setTheme` |
| **Ready** | el resumen con un *Change* por fila, dónde empezar (carpeta, clonar, vacío) y un bloque *Advanced* plegado: MCP, dictado, contexto del chat, tono y permisos de Gentle | `setExtras`, `setContextMode`, `setGentle` |

Ningún paso es obligatorio: *Continue* siempre avanza. Sin modelo, el paso Agent lo dice, el carril
lo marca con **!** y el resumen lo pinta en naranja, pero no bloquea.

## 🧩 Qué hay aquí

| Fichero | Su único trabajo |
| --- | --- |
| [`index.html`](index.html) | el esqueleto: carril, cinco secciones vacías y pie. El contenido se pinta desde datos. |
| [`onboarding.js`](onboarding.js) | todo lo que decide la página: qué paso, qué enseña y qué comandos llama. |
| [`onboarding.css`](onboarding.css) | el aspecto, con la paleta **fija** del producto (lienzo `#0B0F19`, carril `#111625`, tarjeta `#182030`, azul `#2563EB`, verde `#10B981`). |
| [`import.js`](import.js) · [`import.css`](import.css) | la vista Import: orígenes, categorías plegables y una casilla por elemento. En modo `import` es toda la ventana. |
| [`flags.js`](flags.js) | las 14 banderas del selector de idioma, en vectorial (en Windows las banderas emoji salen como letras). |
| [`l10n/`](l10n/) | los textos, un fichero por idioma (inglés más 13). Ver su README. |
| [`preload.cjs`](preload.cjs) | el único puente con el proceso principal: operaciones con nombre, sin `invoke` genérico. |
| [`host.cjs`](host.cjs) | el backend: carga `onboarding-host` del conector y responde un comando por proceso. |
| `media/picode.svg` | la marca, **copiada tal cual** de `extensions/picode/media/picode.svg`. |

## ⚙️ Cómo pinta

- **Un solo `render()`.** Cada cambio de estado vuelve a construir el paso como elementos normales
  (`el()`) y `patch()` los **encaja sobre lo que ya hay**: los nodos que siguen ahí se conservan
  (por `key` o por orden y etiqueta), solo se toca lo que cambió. Así un campo no pierde el foco ni
  el cursor al escribir (el buscador de proveedores filtra mientras se teclea), una lista no salta
  y los logos ya cargados no parpadean. Sigue siendo JavaScript sin dependencias.
- **Los manejadores viajan con el nodo.** `el()` guarda cada `on…` en el propio nodo y un único
  oyente por tipo lo llama; al reutilizar un nodo, `patch()` le pasa los manejadores nuevos.
- **Al cambiar de paso** se vuelve arriba y el foco pasa al título del paso (para lector de
  pantalla y teclado). Los cambios dentro de un paso no mueven nada.
- **El carril dice el estado de cada paso**: número, ✓ si ya se vio, **!** si pide atención, y
  debajo lo que tiene ahora (cuenta, diseño, modelo, tema). Se puede saltar a cualquier paso.
- **La ventana no se repinta con los temas.** Pasar el ratón (o el foco) por un tema solo cambia
  la vista previa; la ventana mantiene la paleta del producto.
- **Movimiento corto** (≈200 ms) y **nada** si el sistema pide menos movimiento
  (`prefers-reduced-motion`, al final de `onboarding.css`).

## ⌨️ Teclas y botones con un solo significado

- **Skip setup** = abrir el editor ya, conservando lo elegido hasta ahí. Está en todos los pasos
  menos el último y siempre significa eso.
- **Escape** cierra lo que está encima (la vista Import, un aviso, la lista de idiomas). Ya **no**
  se salta la configuración entera.

## 🔑 Lo que conviene saber

- **No escribe nada por su cuenta.** Cada escritura es un comando con nombre que pasa por
  `host.cjs` → `extensions/picode/src/onboarding-host.ts`, y cada respuesta trae el estado fresco
  del disco, que es lo que se vuelve a pintar.
- **Probar una clave no la guarda.** *Test connection* (`testProvider`) pregunta a la dirección
  qué modelos tiene y cuánto tarda; solo *Connect* (`addProvider`) la guarda, y el backend la
  rechaza si la dirección no lista modelos. (Hasta la 2.2 esa pestaña llamaba a funciones que ya
  no existían; quedó arreglado con el rediseño.)
- **Las suscripciones las lista pi**, no una lista nuestra. Su inicio de sesión corre en un
  proceso hijo con el perfil de PiCode; los mensajes van marcados con `##picode##` porque esa
  salida la comparte con npm, y cada intento lleva su número para ignorar los eventos de uno
  cancelado.
- **Las credenciales nunca se marcan por defecto** al importar, y la ventana no dice que estén
  cifradas porque `auth.json` no lo está.
- **El editor siempre se abre.** Cerrar la ventana, que se cuelgue o que no cargue cuenta como
  "omitir"; la ventana se oculta (no se destruye) hasta que existe la del editor, porque VS Code
  se cierra al quedarse sin ventanas.
- **El idioma del editor** no se puede cambiar en vivo desde aquí: se descarga su paquete mientras
  pasan los pasos (`prepareLanguage`) y el editor lo instala al arrancar. Ver `docs/IDIOMAS.md`.
- **Primera vez:** *Agent* sale marcado y guardado desde el principio, y el tema PiCode Dark
  también; una configuración posterior respeta lo que la persona ya tiene.

## 🧪 Cómo probarla

**Sin compilar el editor:** servir esta carpeta y sustituir `window.picode` por un simulado antes
de `flags.js` permite recorrer los cinco pasos en cualquier navegador (`?mode=first-run|setup`,
idioma del sistema simulado). Así se verificó la 2.3.0 en inglés y en español: foco en el
buscador, Escape, Skip, vista previa de temas y el flujo de clave de API.

**En la ventana real:** arrancar el editor con `--remote-debugging-port=9222`, borrar antes
`<datos>/onboarding.json` para que salga, y evaluar clics dentro de la página por el protocolo de
DevTools (buscar el destino cuya URL contiene `onboarding/index.html`). Las tres comprobaciones que
importan:

1. **Skip** y la **X** terminan siempre con una ventana del editor y `onboarding.json` escrito.
2. Sin el fichero, la ventana vuelve a salir; con él, no se crea nada.
3. `PICODE_ONBOARDING_CONNECTOR=<conector>/out … host.cjs state` responde JSON con la versión de
   pi: el backend funcionando sin editor.

## 📍 Dónde está el resto

- La puerta, la ventana, el IPC y el fichero de marca: `src/vs/code/electron-main/picodeOnboarding.ts`.
- El backend: `extensions/picode/src/onboarding-host.ts` y `onboarding-settings.ts`.
- El comando que la reabre: `src/vs/workbench/contrib/picode/browser/picodeSetupCommands.ts`.
- La copia al paquete: `build/stage-distribution.sh` (paso 3b).
