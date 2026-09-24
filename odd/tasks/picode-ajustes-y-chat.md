# Feature: pi dentro del Chat — que hable bien, y sus ajustes donde tocan

## Goal

Tres cosas que el dueño pidió el 2026-09-25:

> «Revisa la integración luego del chat con pi, quiero a pi bien integrado y que el chat se
> comunique bien, no se si esto se cerró o no. Quiero todas las opciones que teníamos en la
> anterior extensión de PiCode en Settings > Chat > Pi.»
>
> «la parte de proveedores en Settings > Chat > Providers (muevelo de pi)»

## 1. La integración de pi con el chat

La pieza que lo une es `vscode/extensions/picode/src/agent.ts`: registra `@pi` como el agente del
editor y corre un turno de la sesión de pi por cada mensaje. Lo que estaba a medias era el
**trato entre los dos**, y son cuatro cosas que el dueño ya decide en el editor:

| Qué | Antes | Ahora |
| --- | --- | --- |
| **El modelo** | La sesión se abría sin modelo: pi usaba el suyo, y el selector del chat no llegaba a pi — un selector que miente | El modelo elegido en el chat **es** el que corre pi, y cambiarlo a mitad de conversación cambia la sesión (`setModel`) |
| **El nivel de pensamiento** | No existía | Lo dice un ajuste, y se pasa a la sesión (y se cambia en caliente con `setThinkingLevel`) |
| **El contexto del editor** | No viajaba: «arregla esto» no decía qué | Carpeta, fichero abierto y selección viajan con el mensaje cuando el ajuste está encendido, con la selección recortada (120 líneas / 8000 caracteres) porque pi puede leer el fichero entero si lo necesita |
| **El razonamiento** | Se tiraba a la basura | Se escribe en el chat solo si se pide, en bloque citado, y se cierra cuando empieza la respuesta |

Además, el progreso de las herramientas dice **qué** está haciendo (`read src/app.ts`, no `read`),
y la sesión se rehace sola si cambia la carpeta del proyecto, porque una sesión que sobrevive a su
directorio es una sesión que pi no puede usar.

## 2. Los ajustes de la extensión anterior, en `Settings > Chat > Pi`

Inventario medido de la extensión retirada (`extensions/picode-pi-chat`, en git) y qué se ha hecho
con cada uno:

| Ajuste de antes | Decisión | Por qué |
| --- | --- | --- |
| `picode.context.attach` | **Se trae** (`picode.context.attach`, encendido por defecto) | Es lo que hace que «arregla esto» signifique el fichero que tiene delante. De antes venía apagado; ahora viene encendido, que es lo fácil |
| `picode.panel.reasoning` | **Se trae** (`picode.pi.reasoning`: `hide`/`show`) | Enseñar el razonamiento sigue teniendo sentido; el nombre «panel» no, porque no hay panel |
| **Nuevo**: nivel de pensamiento | **Se añade** (`picode.pi.thinkingLevel`) | Es una decisión que el dueño entiende («cuánto piensa») y que pi acepta por sesión |
| `picode.pi.runtime` | **No se trae** | Existía para elegir *cuál* de los dos pi corre. El dueño decidió que hay **uno**, el de PiCode |
| `picode.pi.executablePath` | **No se trae** | Era la ruta del pi del PATH, que ya no es una pieza del producto |
| `picode.pi.transport` | **No se trae** | Elegía entre `rpc` y `embedded`. Aquí pi se carga por el SDK, dentro del editor: no hay dos formas de hablarle |
| `picode.pi.extraArgs` | **No se trae** | Eran argumentos para arrancar el binario de pi por línea de comandos; por SDK no hay línea de comandos que pasar |
| `picode.media.ffmpegPath`, `picode.media.transcription` | **No se traen** | Eran la voz del panel retirado. El Chat del editor trae su propio dictado, y una casilla que no hace nada es una superficie que miente |

Un ajuste que no cambia nada se nota, y el dueño ya dijo que la interfaz se juzga por lo que se
usa. Lo que no aplica se dice aquí, no se disfraza de opción.

## 3. Proveedores, en su propio nodo

`picode.providers` bajo **`Settings > Chat > Providers`**, con el nodo `Providers` declarado antes
del nodo `pi` en el árbol de ajustes (parche `04`). El nodo `pi` se queda para los ajustes de pi
(`picode.pi.*` y `picode.context.*`).

El cambio de clave (`picode.pi.providers` → `picode.providers`) es lo que hace posible el nodo: el
árbol casa nodos por patrón de clave. El conector sigue leyendo la clave vieja, para que un
`settings.json` escrito antes no pierda sus proveedores.

## Verificación

| Qué | Cómo | Resultado |
| --- | --- | --- |
| Los ids de modelo que viajan entre el chat y pi | `.scratch/verificar-chat-y-ajustes.cjs` (módulos compilados, sin editor) | 6 comprobaciones OK |
| Los tres ajustes, con valores válidos e inválidos | el mismo script | 7 comprobaciones OK |
| El bloque de contexto del editor | el mismo script | 6 comprobaciones OK |
| El progreso de las herramientas | el mismo script | 6 comprobaciones OK |
| El núcleo compila | `tsc --noEmit` sobre `src/tsconfig.json` (12 GB de montón) | ver el registro de la sesión |
| El editor construido lo lleva | build completa desde la fuente | ver el registro de la sesión |

## Lo que queda

- **Los ajustes de pi que pi ya tiene** (`~/.pi/agent/settings.json`: caché, compactación,
  reintentos, confianza de proyecto…) no se duplican en el editor a propósito: son de pi, y pi los
  edita con su propio `/settings`. Si el dueño quiere tocarlos desde aquí, es una decisión aparte
  (y sería leer y escribir el fichero de pi, no inventar ajustes nuevos).
- **La voz** (transcripción) no existe en esta arquitectura: el Chat del editor trae el suyo.

## Registro

- 2026-09-25 · pedido y hecho en la misma sesión, después de los proveedores.
