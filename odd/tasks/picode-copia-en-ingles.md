# Feature: la copia del producto pasa a inglés

## Goal

Que **todo lo que enseña el producto esté en inglés** —ventanas, avisos, títulos de comandos,
descripciones de ajustes y las etiquetas del chat— y que el español quede solo donde es
conversación: lo que yo le hablo al dueño y los papeles que son suyos. Los demás idiomas
vendrán después, como paquetes de idioma, no traduciendo las cadenas de origen.

## Por qué existe

Viene de la frase del dueño del 2026-09-25:

> «NOno a ver todo ha de estar en ingles, tu me hablas en español, ya costruiremos paquete
> sde lenguajes para todos los demás idiomas. Pero a priori en inglés.»

Antes mandaba lo contrario: la copia del producto estaba en español mientras el editor que la
aloja está en inglés. El síntoma que lo destapó fue una ventana **medio en cada idioma**: el
diálogo de conectar un proveedor salía con su frase en español y, pegado al final, el
`(Press 'Enter' to confirm or 'Escape' to cancel)` que pone el propio editor. Ese trozo no es
nuestro y ninguna extensión puede traducirlo ni quitarlo — sale de la tabla de textos del
editor, y solo cambia si cambia el idioma del editor entero o si se parchea su núcleo.

Se midió la otra salida antes de descartarla, para no volver a proponerla a ciegas: el
paquete de idioma español de la galería traduce **22 052 de los 24 625** textos de este editor
(89,6 %), incluido ese sufijo (→ «{0} (Presione "Entrar" para confirmar o "Esc" para
cancelar)»). Se probó de verdad —instalado con el propio instalador del editor y el idioma
marcado en `argv.json`— y se deshizo: poner el editor entero en español no es una decisión que
este producto tome por quien lo use. Queda como paso posterior y opcional.

## Decisions

- **La copia va en inglés; los registros del dueño siguen en español.** `AGENTS.md` (sus
  palabras) y `odd/tasks/` son suyos y se leen en español; el producto, no.
- **Los demás idiomas, por paquete de idioma.** Es el mecanismo del editor: una capa aparte
  sobre el texto inglés, que se puede añadir, quitar o apagar sin tocar las fuentes. Por eso
  no se mezclan idiomas a mano en las cadenas.
- **El conector tiene que estar en git.** Traducirlo sin versionarlo habría durado hasta el
  siguiente `dev/patch.sh`.

## Hecho

### La copia, traducida

| Dónde | Qué había |
| --- | --- |
| Conector (`vscode/extensions/picode`): `package.json`, `providers.ts`, `agent.ts`, `extension.ts` | Títulos, descripciones y placeholders del proveedor; los diálogos de conectar; el aviso de que no hay pi; los errores de modelo y de proveedor; el botón de recargar la ventana |
| `patches/picode/03-remove-copilot-from-model-picker.patch` | Cinco textos del selector de modelos que sustituyen a los de Copilot |
| `patches/picode/06-picode-provider-settings.patch` | La descripción de la fila de Proveedores en los ajustes |
| `patches/picode/10-pi-action-mapping.patch` | Las etiquetas de las herramientas (`Leer`, `Escribir`, `Buscar en el código`…) y `Falló:` / `Hecho:` |
| `distribution/apply-picode.ps1`, `distribution/runtime.json`, `docs/DISTRIBUTION.md` | Un rótulo de paso, una nota y dos avisos que estaban en español |

Dos correcciones que salieron al traducir, y se hacen porque el texto se reescribía de todas
formas:

- El **título del comando** llevaba el prefijo `PiCode:` *y* la categoría `PiCode`, y el
  editor compone «categoría: título»: la paleta enseñaba «PiCode: PiCode: …». El prefijo se
  quita del título; la categoría lo pone.
- La descripción del endpoint usaba como ejemplo una **IP privada** de esta máquina
  (`http://192.168.1.65:20128/v1`). Ahora usa el ejemplo público que ya usaba el diálogo.

Se deja a propósito lo que es **cita del dueño**: `agent.ts` cita su frase en un comentario
(«quiero que esté funcional…»), y esa se queda en español, en su idioma.

### El conector, con casa en git

`vscode/extensions/picode` **no estaba versionado en ningún sitio**: no lo creaba ningún
parche, vivía solo dentro de `vscode/`, que está ignorado. Cualquier regeneración de parches
(`dev/patch.sh`, `dev/update_patches.sh`) hace `git add .`, `git reset --hard` y
`git clean -fd` dentro de ese árbol: lo habría borrado entero, con o sin traducción.

Se versiona como los demás ficheros del núcleo: `patches/picode/12-picode-connector.patch`,
generado con el mismo `git diff` que usa la casa para sus parches, y que crea los seis
ficheros (manifiesto, `tsconfig.json`, `.vscodeignore` y los tres fuentes).

## Verificación

| Qué | Cómo | Resultado |
| --- | --- | --- |
| El conector compila | `bash dev/build-connector.sh` (el compilador del propio árbol) | `connector compiled` y `out/extension.js` en su sitio |
| Los tres parches tocados siguen aplicando | `git apply --reverse --check` contra el árbol con los parches puestos | los tres OK |
| El parche 12 crea el conector desde cero | `git apply --check` en un repositorio git vacío, y luego aplicado | los seis ficheros aparecen; el `package.json` resultante es JSON válido y su comando se llama `Connect a model provider` |
| No queda copia nuestra en español | barrido del editor construido (`resources/app`, sin `.map`) por las cadenas conocidas | ninguna; lo único que queda es la cita del dueño en un comentario compilado |
| El editor que él usa ya la enseña | copiados `package.json` y `out/*.js` del conector compilado al árbol empaquetado | hecho, con la ventana recargada se ve |

La tabla de textos del editor construido (`resources/app/out/nls.messages.json`) llevaba
**diez** entradas nuestras en español: la descripción de la fila de Proveedores y los nueve
textos del selector de modelos. Se reescribieron ahí mismo, con el índice sacado del
`nls.keys.json` del propio editor —cada índice comprobado contra su módulo y su clave, para no
tocar un texto ajeno— y se verificó que son exactamente diez las entradas distintas y que
ninguna otra suena a español. **Es un apaño de la salida generada**: la próxima build escribe
esa misma tabla desde las fuentes ya traducidas, y el resultado tiene que ser idéntico. Copia
de seguridad del original: `%TEMP%\nls.messages.json.bak`.

## Lo que queda

- **El próximo build tiene que reproducir la tabla de textos** desde las fuentes (las diez
  entradas, en inglés). No se ha lanzado una build completa en esta sesión: es larga y su
  empaquetado escribe sobre el mismo árbol desde el que él trabaja.
- **El material viejo del panel** (`extensions/picode-pi-chat`, retirado y con su copia en
  español) se traduce cuando se migre lo que sirve; no se compila ni se empaqueta, así que no
  se ve.
- **Los paquetes de idioma** no existen todavía: son el paso que él dejó dicho para después.

## Registro

- 2026-09-25 · el dueño corrige el criterio («todo ha de estar en inglés») y se traduce la
  copia; el conector gana casa en git por el camino (ADR-012).
