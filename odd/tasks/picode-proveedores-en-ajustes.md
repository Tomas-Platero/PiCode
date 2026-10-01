# Feature: los proveedores se declaran en un formulario, y las suscripciones en una lista

## Goal

Que conectar un proveedor de modelos sea **fácil y a la vista**, sin ventanas encadenadas. El
dueño lo pidió mirando la fila de Proveedores del Chat:

> «no quiero la ventanita de arriba, quiero añadir items abajo con sus campos necesarios y/o una
> lista de proveedores a los cuales conectarme por oauth»

Y después, sobre dónde vive:

> «la parte de proveedores en Settings > Chat > Providers (muevelo de pi)»

## Por qué existe

Hasta ahora, «conectar uno» abría **cuatro cuadros seguidos** (nombre, dirección, dialecto, clave).
La fila de ajustes que él miraba no hacía nada: nadie escribía esa lista y nadie la leía.

## Las tres formas de tener un proveedor, y por qué son tres

| Forma | Para qué | Dónde |
| --- | --- | --- |
| **Formulario** (una fila por proveedor, con sus campos) | Endpoints con dirección propia: el router de casa, un servidor local, cualquier API compatible | `Settings > Chat > Providers` |
| **Lista de suscripciones** (eliges la cuenta que ya pagas) | ChatGPT Plus/Pro, Claude Pro/Max, GitHub Copilot, Grok, Kimi… que no tienen dirección: son cuentas | comando «Connect a subscription», enlazado desde esa misma fila |
| **Pantalla de proveedores del editor** (la del propio VS Code) | Quien prefiera casillas con la clave guardada como secreto | el selector de modelos → «Manage Models» |

Las tres acaban en el **mismo sitio**: el perfil de PiCode (`data/pi-agent`), que es lo que hace
que la lista de modelos del editor y el pi que ejecuta estén de acuerdo.

## Decisions

- **Un ajuste del editor no puede ser un formulario con campos** — medido: el editor solo deriva
  el tipo de los elementos de un array cuando son escalares (`settingsTreeModels.ts`) y un ajuste
  no admite secretos. Por eso el formulario es un **widget del núcleo** para esta fila
  (`ProviderListSettingWidget`, `SettingValueType.ProviderList`), y no un truco de esquema.
- **La declaración es la superficie; el perfil es la proyección.** Lo que se escribe en el
  formulario se copia a los dos ficheros que lee pi (`models.json` para qué es cada proveedor y
  qué modelos tiene, `auth.json` para la credencial). Un proveedor que el editor puede listar y pi
  no puede usar sería un modelo que falla justo cuando el agente lo elige.
- **La clave literal va a `auth.json`; `$VARIABLE` y `!comando` se quedan en `models.json`.** Son
  las interpolaciones de pi, y ese es el fichero que las lee. Así una credencial no acaba en
  `settings.json`, que es el fichero que se comparte y se sincroniza.
- **La lista de suscripciones sale de pi, no de una tabla nuestra.** Qué proveedores existen y
  cuáles se pueden conectar se pregunta a pi cada vez; lo único nuestro es **el orden** (los más
  usados primero) y las palabras. Cualquier proveedor que pi ofrezca y no esté en esa lista sale
  igual, después y por orden alfabético.
- **El orden no es inventado.** Los tres primeros —ChatGPT Plus/Pro, Claude Pro/Max, GitHub
  Copilot— son los que encabezan las listas públicas de «usa la suscripción que ya pagas»: la
  documentación de Zed de sus inicios de sesión por suscripción
  (`zed.dev/docs/ai/use-an-existing-subscription`) y los recuentos de agentes de 2026. Después,
  Grok (xAI), Kimi For Coding y OpenRouter.
- **La clave del archivo de ajustes no se copia a pantalla nunca**, y la descripción de la fila lo
  dice: `$VARIABLE` es lo recomendado.

## Hecho

- **El formulario, en el núcleo**: `ProviderListSettingWidget` (`settingsWidgets.ts`) con filas de
  cuatro campos (nombre, dirección, dialecto, clave), añadir / editar / borrar, y aviso en la
  propia fila cuando falta el nombre o la dirección. La fila se pinta con
  `SettingProviderListRenderer` (`settingsTree.ts`) y el tipo `SettingValueType.ProviderList`.
- **La fila, en su nodo**: `picode.providers` bajo `Settings > Chat > Providers` (parche 04 del
  árbol de ajustes: el nodo `Providers` antes del nodo `pi`).
- **La lista de suscripciones**: `subscriptions.ts` (catálogo, orden y marcas, sin `vscode`) +
  `login.ts` (los diálogos del editor y el login de pi). Se apoya en `openai-codex`, `anthropic`,
  `github-copilot`, `xai`, `kimi-coding`, `openrouter`, `meta` y `radius`, que son **los ocho que
  el pi instalado ofrece con OAuth** (medido: 41 proveedores, 8 con login de suscripción).
- **La cadena de cuatro ventanas está borrada**: no queda ni un `showInputBox` en el conector para
  pedir datos de un proveedor.
- **La forma antigua de la lista** (una línea por proveedor con sus campos separados por `|`) se
  sigue leyendo, porque un fichero de ajustes escrito ayer no puede dejar de funcionar hoy.

## Verificación

Ejecutada, no leída. Tres scripts, todos contra los módulos compilados del conector (sin editor):

| Script | Qué comprueba | Resultado |
| --- | --- | --- |
| `.scratch/verificar-proyeccion.cjs` | La fila se lee; el endpoint se pregunta de verdad (servidor local); `models.json` y `auth.json` quedan bien; la clave `$VARIABLE` **no** se copia a `auth.json`; proyectar lo mismo **no reescribe**; un endpoint caído no toca el perfil; los demás proveedores sobreviven | 11 comprobaciones OK |
| `.scratch/verificar-suscripciones.cjs` | Solo salen los que pi sabe conectar con OAuth; el orden (ChatGPT, Claude, Copilot, Grok, Kimi, OpenRouter, y el resto alfabético); quien ya tiene credencial lo dice; una herramienta de solo clave no se ofrece; avisos y enlaces | 17 comprobaciones OK |
| `.scratch/verificar-chat-y-ajustes.cjs` | Los ids de modelo (vendor, barras internas, proveedor ajeno); los tres ajustes de pi leídos con sus valores válidos e inválidos; el bloque de contexto del editor | 24 comprobaciones OK |

Además: el conector compila con el compilador del árbol; los parches 03, 04, 06, 10 y 12 siguen
aplicando (`git apply --reverse --check`).

## Lo que se hizo en el editor construido

Una **build completa** desde la fuente, que es la única forma de que un cambio del núcleo (el
widget, el nodo de ajustes, los ajustes nuevos) llegue al editor: el conector viaja en el binario.
La build también regenera la tabla de textos del editor, así que las descripciones nuevas están en
inglés sin ningún apaño.

## Registro

- 2026-09-25 · el dueño pide quitar la ventanita, tener los campos en su sitio y una lista de
  proveedores por suscripción; después, mover la fila a su propio nodo y revisar la integración
  de pi con el chat.
