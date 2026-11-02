# 🌍 Los 13 idiomas de PiCode

Todo lo que el usuario lee está escrito **en inglés** en el código, y PiCode lleva su propia
traducción a **13 idiomas**. No depende de los paquetes de idioma de Microsoft: esos solo conocen
los textos del editor de serie, y todo lo que PiCode añade o reescribe se quedaría en inglés.

Los 13 son los que ya conoce el editor (`defaultLanguages` y `extraLanguages` en
`build/lib/i18n.ts`):

| Código | Idioma | Código | Idioma |
| --- | --- | --- | --- |
| `cs` | Čeština | `pl` | Polski |
| `de` | Deutsch | `pt-br` | Português (Brasil) |
| `es` | Español | `ru` | Русский |
| `fr` | Français | `tr` | Türkçe |
| `it` | Italiano | `zh-cn` | 简体中文 |
| `ja` | 日本語 | `zh-tw` | 繁體中文 |
| `ko` | 한국어 | | |

## 🧩 Las cuatro superficies

| Superficie | Dónde vive | Cómo la lee el editor |
| --- | --- | --- |
| **Editor** | `src/vs/workbench/contrib/picode/l10n/<idioma>.json` | `src/vs/base/node/nls.ts` mezcla el fichero sobre el paquete de idioma instalado |
| **Ventana de primer arranque** | `resources/onboarding/l10n/<idioma>.js` | la propia ventana, que abre en el idioma del sistema si hay fichero |
| **Conector: lo que dice el código** | `extensions/picode/l10n/bundle.l10n.<idioma>.json` | `vscode.l10n.t()` busca la frase inglesa en el fichero del idioma |
| **Conector: títulos del manifiesto** | `extensions/picode/package.nls.<idioma>.json` | el editor resuelve los `%clave%` del `package.json` antes de cargar el código |

El conector va integrado en el editor, y para una extensión integrada VS Code solo busca sus
traducciones en el paquete de idioma de Microsoft. Por eso `extensions/picode/package.json` declara
`"l10n": "./l10n"` y `extHostLocalizationService.ts` (marcado `PiCode`) lee esa carpeta cuando existe:
sin ello, todo lo que dice el conector con `vscode.l10n.t()` salía en inglés aunque estuviera traducido.

`source.json` (editor) y `bundle.l10n.json` (conector) **no se escriben a mano**: salen del código.
Los ficheros de idioma tampoco: los escribe `merge` desde los trozos traducidos.

## 🌍 El idioma del propio editor, desde el asistente

La ventana del asistente (`resources/onboarding/`) coge el idioma **del equipo**, y lo cambia el
selector. No lo lee del navegador: dentro del editor el navegador dice el idioma *del editor* (inglés
mientras no haya paquete de idioma), no el del equipo, así que el proceso principal se lo da a la
página (`systemLanguages` en `picodeOnboarding.ts`, con `app.getPreferredSystemLanguages()`). Pero el idioma **del editor** se fija al arrancar el programa, y el asistente
se abre antes de que exista el editor, así que no puede cambiarlo en vivo. Lo que sí hace es dejarlo
todo listo, en dos tiempos:

1. **En el asistente** (`extensions/picode/src/display-language.ts`, orden `prepareLanguage`): mientras
   la persona recorre los pasos, descarga de Open VSX el paquete de idioma de Microsoft
   (`MS-CEINTL.vscode-language-pack-<idioma>`) a `<datos de usuario>/picode-language/` y deja una nota
   (`pending.json`). No hace nada si el editor ya está en ese idioma o ya tiene el paquete. Sin red,
   acaba en `offline` y el resumen final lo dice; el editor abre igual.
2. **En el editor** (`src/vs/workbench/contrib/picode/electron-browser/picodePendingLanguage.ts`):
   instala el paquete como cualquier extensión, al arrancar y cada vez que la ventana recupera el foco
   (así recoge un asistente abierto desde dentro del editor en cuanto se cierra). Tras el **primer**
   asistente además cambia a ese idioma, lo que reinicia el editor una vez (la nota lo dice con
   `firstRun`); tras uno posterior, el aviso de VS Code (*Cambiar idioma y reiniciar*) ofrece el
   cambio. La nota se borra **antes** de instalar, para que un fallo no se reintente en cada arranque.

El resumen final del asistente solo cuenta el idioma mientras queda algo por hacer (paquete listo, o
sin poder bajarlo). La actualización de PiCode no se toca desde aquí: la hace el actualizador de
siempre, que busca y baja la versión nueva a los 30 s de abrir el editor.

## 🛠️ La herramienta

`build/l10n.mjs` hace las cuatro cosas, siempre con `--surface editor|window|extension|manifest`
(el editor es el valor de siempre):

```bash
node build/l10n.mjs extract --upstream <checkout de VS Code>   # reescribe source.json del editor
node build/l10n.mjs extract --surface extension                # reescribe bundle.l10n.json
node build/l10n.mjs split de [--surface s] [--size 120]        # saca por trozos lo que a 'de' le falta
node build/l10n.mjs merge de [--surface s]                     # mete los trozos ya traducidos
node build/l10n.mjs check                                      # los 13 idiomas, las cuatro superficies
```

### Cómo se traduce sin perder el hilo

`split` deja el trabajo en `<carpeta de la superficie>/.work/<idioma>/01.json`, `02.json`… Cada
trozo es una lista de `{ "key", "text" }`. Traducir un trozo es escribir `01.out.json` al lado con
`{ "<clave>": "<texto>" }`; `merge` junta todos los `.out.json`, respeta el orden del original,
comprueba los `{0}` y escribe el fichero del idioma.

Los trozos **no se borran nunca**: un trabajo que se corta a la mitad se retoma donde estaba y
nada se traduce dos veces. `.work/` no se versiona (está en `.gitignore`).

### Lo que vigila `check` (y CI)

- Falta un idioma de los 13, o a un idioma le falta una frase.
- Una traducción ha cambiado los `{0}` de su frase (movidos vale, perdidos o inventados no).
- Un fichero de idioma tiene claves que el original no tiene.
- `source.json` o `bundle.l10n.json` se han quedado atrás respecto al código (`extract`).
- La ventana de primer arranque no carga alguno de los 13 ficheros en `index.html`.
- La ventana pide por nombre una frase que `en.js` no tiene (se vería la clave en pantalla).

## ✍️ Reglas al escribir texto nuevo

**Se escribe en inglés y para el usuario.** Qué hay, qué puede hacer, qué cambió. Sin nombres de
código, rutas internas ni banderas. El texto de la pantalla no explica la maquinaria; eso vive en
`docs/`.

**Los datos variables van como `{0}`, `{1}`…** nunca dentro de la frase:

```ts
// bien
vscode.l10n.t('MCP server {0} added to pi.', name)
// mal: la frase se traduce y el nombre se queda pegado en inglés
`MCP server ${name} added to pi.`
```

**No se traduce lo que identifica:** `PiCode`, `pi`, `MCP`, `engram`, `gentle-pi`, `bash`, `$NAME`,
un modelo, una ruta, un id de ajuste, un comando. Un `.t()` que envuelve un identificador es peor
que ninguno: mete en el bundle algo que nunca debe cambiar.

**Una llamada, una frase.** `l10n.t(l10n.t('…'))` es un error, y `l10n.t('A') + l10n.t('B')` no se
puede traducir: si el texto se arma por partes, se convierte en una frase con `{0}`.

**Solo se envuelve lo que el usuario lee:** avisos, preguntas con opciones, títulos y etiquetas de
la vista, tooltips, mensajes de error que llegan a pantalla. **No** se envuelven los mensajes de
registro (`console`, `logService`), los errores internos que nunca se enseñan, las claves de objeto,
las expresiones regulares ni lo que se compara con `===`.

**Ojo con las comillas:** un apóstrofo dentro de `'…'` rompe el fichero entero
(`'… pi's profile'`). Se escapa (`\'`) o se usan comillas dobles.

### En el conector, el import lleva `.ts`

Los módulos que no importan `vscode` usan `import { l10n } from './l10n.ts'`, **con la extensión**.
No es un descuido: los tests cargan esos ficheros por su ruta con `node --test`, que resuelve ESM
de verdad y no encuentra un hermano sin extensión. `extensions/picode/tsconfig.json` tiene
`rewriteRelativeImportExtensions` justo para eso: el compilador escribe `require('./l10n.js')` en
`out/`, que es lo que el editor carga.

## ➕ Añadir un idioma

1. Añade el código a `SHIPPED` en `build/l10n.mjs` y a la tabla de arriba.
2. `node build/l10n.mjs split <código>` (y `--surface window|extension|manifest`), traduce,
   `merge`.
3. En la ventana, añade su `<script src="l10n/<código>.js">` a `resources/onboarding/index.html`.
4. `node build/l10n.mjs check` tiene que salir limpio.
