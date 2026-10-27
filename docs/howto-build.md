# Cómo compilar PiCode desde la fuente

Este documento describe cómo se compila PiCode desde su propia fuente: qué es
el árbol, qué hace cada fase del build y qué se hace el día que toca traer una
versión nueva de VS Code.

No sustituye a la release. El **ZIP precompilado** sigue siendo el camino de quien solo
quiere usar PiCode (montado por `build/stage-distribution.sh`, descrito en
[`DISTRIBUTION.md`](DISTRIBUTION.md)). Este es el camino de quien colabora en el núcleo y
necesita recompilar.

Construir desde la fuente permite que el producto se aplique a `product.json` **antes** de compilar, que los `checksums` se calculen sobre el resultado y que un cambio de comportamiento se escriba en TypeScript, en el propio árbol: nada de parchear un bundle minificado.

**Lo que cambió el 2026-09-27**, y es la razón de que este documento se lea distinto: el árbol
dejó de ser el resultado desechable de aplicar parches en cada build y pasó a ser **la fuente de
PiCode**, versionada en este repositorio. Ya no hay fase de descarga ni de
parcheo, y las dependencias se instalan una vez.

## 🗺️ Índice

- [Qué es el árbol](#qué-es-el-árbol)
- [La cadena, por capas](#la-cadena-por-capas)
- [Dependencias en Windows](#dependencias-en-windows)
- [Cómo compilar](#cómo-compilar)
- [Traer una versión nueva de VS Code](#traer-una-versión-nueva-de-vs-code)
- [El camino retirado: los parches (borrados)](#el-camino-retirado-los-parches-borrados)
- [Estado de verificación](#estado-de-verificación)

## Qué es el árbol

El árbol del editor **con los cambios de PiCode ya dentro**. Vino de aquí:

```text
  Microsoft VS Code 1.135.0  (commit 08d4889f, el tag y el commit de host/upstream/stable.json)
        │
        │  el juego de parches heredado   patches/vscodium/**
        │  (verbatim de la revisión de VSCodium fijada en upstream/vscodium.json)
        │
        │  los cambios propios            patches/picode/**
        │
        │  la capa de producto            product.json
        ▼
  la raíz del repositorio   ←  esto es PiCode, y aquí se trabaja
```

Ese trabajo se hizo **una vez**: primero quedó registrado como un commit en el git que había
dentro del árbol, y el mismo día **el árbol pasó a versionarse en este repositorio** (decisión
del dueño, 2026-09-27 — commit `396b3d7`). A partir de ahí:

- **no se descarga nada**: el árbol ya está;
- **no se aplica ningún parche**: los cambios son el código;
- `patches/**`, `upstream/vscodium.json` y el bundle de historial **se borraron** el 2026-09-27:
  no son entrada del build, y la procedencia que importa es `host/upstream/stable.json`.

Lo que trajo ese paso, y conviene no confundir: como la fuente de Microsoft vive ahora **dentro
de este repositorio**, la prohibición de `CONTRIBUTING.md` subió de nivel — lo que no puede
hacerse es **empujar este repositorio a un origen público**. Publicarlo es decisión exclusiva
del dueño. El historial anterior a la importación se guardó en un bundle fuera del repositorio
(`.scratch/picode-source-history.bundle`, 54 MB).

## La cadena, por capas

Las capas que formaron el árbol, y lo que el build hace hoy con ellas. El orden de las tres
primeras no es negociable —así se construyó el árbol— pero **el build ya no las ejecuta**.

| Capa | Fuente de verdad | Qué aportó | ¿La ejecuta el build? |
| --- | --- | --- | --- |
| Fuente | `host/upstream/stable.json` | El VS Code exacto del que desciende el árbol. | No (procedencia) |
| Cambios heredados | *(fueron `patches/vscodium/**`)* | Todo lo que VSCodium ya quita (telemetría, Copilot, cloud, update, firma, onboarding…), hoy **código dentro del árbol**. | No |
| Cambios propios | *(fueron `patches/picode/**`)* | Los cambios de fuente de PiCode, hoy **código dentro del árbol**. | No |
| Producto | `product.json` | Marca, galería, URLs, poda de claves, **versión**. Es la **única** fuente de la identidad PiCode. | **Sí** — fase 1, idempotente y **se deshace**: un build de canal lo sella, lo usa para empaquetar y lo devuelve tal cual al terminar |
| El árbol | la raíz del repositorio | Todo lo anterior ya aplicado, y es donde se edita. | Es la entrada |
| Empaquetado | `build/stage-distribution.sh` | Perfil portable, settings de primer arranque, panel como extensión built-in, iconos y nombres. | **Sí** — fase 5 |

## El sello del canal y su vuelta atrás

Un build con canal (`PICODE_CHANNEL=stable|beta|experimental`) escribe el canal **en el
`product.json` del árbol**: `quality`, la rama de `updateUrl`, la identidad de instalación y los
nombres de carpeta son lo que leen el compilador y el empaquetador. Eso es un sello, no un
cambio: el canal pertenece al producto **empaquetado**, y el árbol vuelve a ser el que era.

El original se copia en `.scratch/product.json.source` antes de sellar y se restaura en la
salida —build bueno, build fallido o `Ctrl-C`—, así que después de compilar el árbol queda
limpio. Si el build muere de golpe (sin trampa de salida), la copia sigue ahí y la siguiente
fase 1 la devuelve **antes** de leer nada.

## Dependencias en Windows

Los scripts están en **Bash**, así que en Windows se ejecutan desde **Git Bash**
(incluido en Git for Windows). PowerShell no sirve para estos scripts.

| Herramienta | Para qué | Instalación |
| --- | --- | --- |
| **Git for Windows** | Git **y Git Bash**: sin él no hay shell para los scripts. | `winget install --id Git.Git -e` |
| **Node.js 24.20.0** (lo que dice [`.nvmrc`](../.nvmrc)) | `npm ci` y las tareas gulp. Con nvm-windows: | `nvm install 24.20.0` y luego `nvm use 24.20.0` |
| ~~**jq**~~ | **Ya no hace falta para nada.** El build lee y escribe el JSON que toca con `node`; el último guion que usaba `jq` (`build/utils.sh`) fue borrado el 2026-09-27 junto con el aparato de parches. | — |
| **Python 3.11** | Lo pide el sistema de build de VS Code para los módulos nativos (`node-gyp`). Medido: con **3.14.7** `node-gyp` llegó hasta MSBuild sin quejarse, así que la versión **no** fue el obstáculo; 3.11 es lo que documenta upstream y lo recomendable. | `winget install --id Python.Python.3.11 -e` |
| **Rustup** | Compila algunos módulos nativos de VS Code. Reescribe el `PATH` al terminar: reinicia el shell. | [rustup.rs](https://rustup.rs/) o `winget install --id Rustlang.Rustup -e` |
| **7-Zip** | Empaqueta archivos `.zip`. | `winget install --id 7zip.7zip -e` |
| **Visual Studio 2022** (Community o Build Tools) con *Desktop development with C++* **y las librerías Spectre** | `node-gyp` compila los módulos nativos con MSBuild. **Sin las librerías Spectre el build se para** con `error MSB8040` en `@deviceid` y `@windows-registry`. | Ver el comando de abajo |

El componente Spectre se añade a una instalación existente con el instalador de Visual
Studio. Hace falta elevación y conviene cerrar Visual Studio antes:

```powershell
& "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vs_installer.exe" modify `
  --installPath "C:\Program Files\Microsoft Visual Studio\2022\Community" `
  --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre `
  --quiet --norestart
```

Se comprueba sin instalar nada:

```bash
VSW="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
"$VSW" -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre -property installationPath
# sin salida = el componente NO está, y la instalación de dependencias se parará con MSB8040
```

Node también se puede bajar de [nodejs.org](https://nodejs.org/); si se usa el instalador,
conviene marcar la opción de instalar las herramientas de compilación C++.

Comprobación rápida del `PATH`, desde Git Bash:

```bash
node --version    # debe casar con .nvmrc (24.20.0)
npm --version
python3 --version # debe ser 3.11.x
cargo --version
7z i 2>&1 | head -1
git --version
```

Si algo no aparece, añade su directorio al `PATH` (Propiedades del sistema → Variables de
entorno → Path) y abre una shell nueva.

### Estado real de las dependencias en la máquina donde se escribió el pipeline

Medido el 2026-09-23. Se deja dicho para que nadie lo dé por hecho:

- **Todas están instaladas, y ninguna es visible al `bash` de la sesión donde se midió.** El
  shell hereda un *snapshot* del `PATH`: lo que se instala con `winget` o `rustup` **durante**
  una sesión no aparece en esa sesión, aunque un terminal nuevo sí lo encuentre. Rutas:
  `jq` → `…\WinGet\Packages\jqlang.jq_…\jq.exe`; `7z` → `C:\Program Files\7-Zip\7z.exe`;
  `cargo`/`rustc`/`rustup` → `C:\Users\%USERNAME%\.cargo\bin`.
- **MSVC está**: Visual Studio 2022 Community con `Microsoft.VisualStudio.Component.VC.Tools.x86.x64`
  (comprobado con `vswhere`). `cl.exe` no está en el `PATH` y no hace falta: `node-gyp` lo
  localiza por `vswhere`.
- **Falta el componente Spectre** (`Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre`).
  Esta es la única dependencia ausente que se ha comprobado, y **fue la que paró la compilación**.
- **Node es 24.20.0**, no el 24.18.0 que fijaba el `.nvmrc` aquel día (hoy `.nvmrc` también
  dice 24.20.0). Es la misma línea 24, y VSCodium salta la comprobación con
  `VSCODE_SKIP_NODE_VERSION_CHECK=yes`.
- **Python es 3.14.7**, no 3.11. No fue el obstáculo: `node-gyp` invocó MSBuild y el fallo
  llegó de ahí.
- **`shellcheck` no está** instalado, así que los scripts solo se han validado con `bash -n`.

## Traer una versión nueva de VS Code

Los dos pines ya **no dirigen el build**: son la procedencia del árbol.

| Pin | Qué registra |
| --- | --- |
| [`host/upstream/stable.json`](../host/upstream/stable.json) | El commit de **VS Code** del que desciende el árbol: `tag`, `commit`, `repository`. **Es el único pin que queda**: `upstream/vscodium.json` y `build/vscodium-product.json` se borraron con el aparato de parches. |

El día que toque una versión nueva, el trabajo **no** es reaplicar parches: es **juntar las dos
versiones**. Este repositorio recibió el árbol como una importación aplastada (sin el historial
de VS Code dentro), así que la juntanza se hace en un clon desechable que sí tiene ese
historial, y el resultado entra aquí como un commit normal. **Nada de lo de abajo se ha
ejecutado todavía**: se lee como un plan, no como una receta comprobada.

1. Levantar un clon de trabajo **con el historial de VS Code**: `git clone
   https://github.com/microsoft/vscode .merge-work` y situarse en el commit que dice
   `host/upstream/stable.json`. El bundle superficial que se usó la primera vez **ya no existe** —
   nunca se versionó; un clon completo cumple la misma función y no depende de esta máquina.
2. Juntar allí: `git -C .merge-work merge <commit-nuevo>`. Los conflictos salen uno a uno y con
   contexto, en vez de un `git apply` que se para sin decir dónde.
3. Traer el resultado a casa: copiar el árbol fusionado sobre la raíz del repositorio (sin tocar
   `node_modules` ni los `out*`) y commitear aquí —el commit de la juntanza es la nueva
   procedencia—. `git status` en el padre es el control: si solo cambió lo que cambió el merge,
   entró limpio.
4. Actualizar `tag` y `commit` en `host/upstream/stable.json`, y —si el delta de producto necesita
   ajustes para la versión nueva— aplicarlos en `product.json`. No hay
   parches que re-vendorizar: se retiraron el 2026-09-27.
5. Comprobar que el árbol sigue siendo el que el build espera: `./build/build.sh -o`. Y volver a
   guardar el historial fusionado como bundle, para la próxima versión.
6. Compilar y confirmar que arranca.

`RELEASE_VERSION` sale de `product.json` (`version`), que es la **única**
casa de la versión desde que las fases 1-5 se retiraron. `host/upstream/stable.json` ya no la fija.

El pin se mueve **a mano**: el vigilante semanal de CI que abría la PR con el pin nuevo se
eliminó, y [`docs/CI.md`](CI.md) lo explica.

## Cómo compilar

```bash
./build/build.sh          # comprueba la fuente, instala si falta, compila, empaqueta y remata
./build/build.sh -o       # solo comprobación: segundos, sin instalar ni compilar
./build/build.sh -i       # fuerza la instalación de dependencias aunque el estado cuadre
```

- **`./build/build.sh`** ejecuta las 5 fases. Necesita las dependencias completas de la sección
  anterior, pero solo la **primera vez**: `npm ci` se repite únicamente cuando el estado que
  VS Code registró deja de cuadrar, que es lo que responde `build/build-helpers.mjs deps-current`.
- **`./build/build.sh -o`** para **dentro de la fase 1**, después de comprobar la fuente y la
  identidad y antes de instalar nada; sale con código 0 y **no compila nada**. En la
  práctica son segundos, y es la forma de saber que el árbol es el correcto antes de pagar un
  build largo.
- **`-f` no existe**, y a propósito: borraba el árbol. Ese árbol es la fuente y el único
  sitio donde existe; el flag da error y lo explica.
- **`-s`** se acepta con un aviso: significaba "reutiliza el árbol en vez de descargarlo", y desde
  el 2026-09-27 eso es lo único que puede pasar.

`OS_NAME` se deriva de `OSTYPE` (Git Bash → `windows`) y es **obligatorio**: un `OSTYPE` del que
no se pueda derivar `windows`, `osx` o `linux` es un error duro.

**Dónde queda todo:**

| Ruta | Qué es |
| --- | --- |
| El árbol | **La fuente de PiCode.** Se edita, se commitea y vive en **este** repositorio. |
| `./PiCode-Win32-x64` | La salida del empaquetado (fases 4 y 5). |
| `./PiCode-Win32-x64/PiCode.exe` | El ejecutable construido desde fuente. |

el árbol **se versiona en este repositorio** desde el 2026-09-27; `./PiCode-Win32-*` es
salida del empaquetado y sigue ignorado. La fuente de Microsoft vive aquí dentro, así que la
regla de publicación es la de `CONTRIBUTING.md`: este repositorio no se empuja a un origen
público sin decisión del dueño.

### El bucle de desarrollo (ver un cambio en segundos, sin empaquetar)

Para tocar código y verlo en el editor no hace falta pasar por las 5 fases. Con la ruta de
fábrica reactivada (esbuild):

```bash
cd the tree
npm run transpile-client      # src/ → out/ : 7.559 ficheros en ~7 segundos
npm run watch                 # y a partir de ahí, re-transpilación al guardar
scripts\code.bat              # arranca el editor DESDE out/ (la primera vez baja Electron)
```

Cosas que hay que saber de este modo, para que no sorprendan:

- La interfaz sale **en inglés**: el modo desarrollo omite a propósito el paso de traducción.
  El español lo mete el empaquetado, y para eso está `./build/build.sh`.
- `transpile-client` **no comprueba tipos**. El control salta al construir el producto (y en
  el bucle se puede tener aparte con `npm run gulp watch-client`).
- El `out/` de desarrollo **nunca se empaqueta**: el build del producto escribe sus propias
  salidas (`out-build`, `out-picode-min`) y no se pisa con esto.
- `npm run build-fast` está muerto (heredó referencias a una extensión que VSCodium borró);
  no lo uséis hasta que se limpie.

### Qué se midió cuando el build se hacía con parches

Esta lista es del camino **retirado** (las fases de descarga y parcheo). Se conserva porque fue
el trabajo real de verificación de aquella cadena y porque los defectos que encontró —sobre todo
el del icono— siguen siendo verdad hoy.

**Aviso sobre la numeración:** los números de fase que aparecen aquí (y en todo el apartado
retirado) son los del build **antiguo, de 8 fases**. El build de hoy tiene 5, y en él
"compilar y empaquetar" ya no es la fase 7.

- `./build/build.sh -o` se ha ejecutado **dos veces**, salida **0** las dos, con
  **50 patches aplicados** (43 de `patches/vscodium/*.patch`, 6 de
  `patches/vscodium/windows/*.patch`, 1 de `patches/picode/*.patch`) y las **2 acciones
  JSON** de borrado (`52-ext-copilot-remove-it.json` y `80-ui-disable-onboarding.json`,
  148 rutas). Cero `.rej`.
- `./build/build.sh -s` se ha ejecutado sobre un árbol ya preparado, salida **0**.
- La fase 8 (`build/stage-distribution.sh`) se ha ejecutado sobre una salida de empaquetado
  **sintética**, salida 0.
- **La cadena completa hasta `PiCode.exe` se ha ejecutado** en esta máquina, después de
  instalar el componente Spectre de Visual Studio. Resultado: `compile-src … with 0 errors`,
  fase 7 completa, fase 8 aplicada, y el árbol en `./PiCode-Win32-x64/` con su `PiCode.exe`
  (221.987.328 bytes, `ProductName "PiCode - Agentic Code Editor"`, `CompanyName "PiCode"`,
  `FileVersion 1.135.0`) y su perfil portable `data/`.
- **Defecto encontrado al ejecutarlo, ya corregido:** el `PiCode.exe` de la primera
  compilación llevaba **el icono de VS Code**. El icono del ejecutable se decide **al
  empaquetar**: `build/lib/electron.ts` declara `winIcon: 'resources/win32/code.ico'` y el
  empaquetado de Windows lo aplica con `rcedit(executablePath, { icon })`
  (`build/gulpfile.vscode.win32.ts`). La fase 8 sustituía solo la copia **interna**
  (`resources/app/resources/win32/code.ico`) y **después** del empaquetado, así que el
  icono ya incrustado no cambiaba. Ahora la marca del icono —y el redibujado de las dos
  teselas del menú Inicio— está **en el árbol**: los ficheros brandados viven en
  `resources/win32/` y se commitean; para cambiarlos, se cambian allí antes de
  empaquetar (el `build/prepare_vscode.sh` que hacía esta marca murió con el aparato de parches).
- **Verificado después del arreglo, y sin lugar a dudas:** parseando el directorio de
  recursos del PE, los **7 frames** de `build/distribution/picode.ico` (16, 24, 32, 48, 64, 128 y
  256) están presentes en `PiCode.exe` **byte a byte**. Ojo con la forma de medirlo:
  `System.Drawing.Icon` no puede leer `picode.ico` (sus frames van comprimidos en PNG) y
  `ExtractAssociatedIcon` devuelve un bitmap reescalado, no el frame nativo — comparar así
  da «distintos» con el icono correcto puesto.

## El camino retirado: los parches (borrados)

El 2026-09-27 el dueño decidió que PiCode no se mantiene con parches, y se **borró** todo el
aparato: `patches/**` (los propios y los heredados de VSCodium), `build/get_repo.sh`,
`build/prepare_vscode.sh`, `build/patch.sh`, `build/update_patches.sh`, `build/version.sh`,
`build/utils.sh`, `build/vscodium-product.json`, `upstream/vscodium.json` y `build/ci/pin-check.sh`.

Lo que merecía la pena guardar de ese camino está en otras manos:

- **Los cambios son la fuente**: el árbol, versionado en este repositorio.
- **La procedencia es un único pin**: `host/upstream/stable.json` (commit `08d4889f`, VS Code
  1.135.0) y el plan para la siguiente versión está más arriba, en *Traer una versión nueva*.
- La historia completa antes/después del parcheo existe además en el bundle local
  `.scratch/picode-source-history.bundle` (fuera del versionado: respaldo de esta máquina).

Los placeholders `!!APP_NAME!!` y las reglas de sufijos `.patch.no` / `.patch.yet` murieron con
la maquinaria: nada los expande ni los aplica. Lo que alguna vez hizo un parche, hoy se escribe
directamente en el árbol y se commitea.

## Estado de verificación

### La fuente propia (2026-09-27): lo que se midió al retirar las fases 1-5

- Cadena completa `./build/build.sh`, en régimen normal sobre esta máquina (16 núcleos):
  compilar e empaquetar → `PiCode.exe` → rematado. Medidas por separado con los comandos
  exactos del build y con salida 0 en todas las fases: **compilar 5 min 05 s**
  (`compile-src` con gulp-tsb = 264 s, el 85 % del tiempo), **empaquetar 36 s**,
  **rematar 17 s**. Build completo en régimen normal: **≈ 6 minutos** con las dependencias ya
  instaladas. El registro en bruto queda en `.scratch/baseline-{prepack,pack,stage}.{log,time}`
  (fuera del árbol versionado).
- **Actualizado el mismo día, con el interruptor de esbuild devuelto a su valor de fábrica**: la cadena volvió a medirse de punta a
  punta y **aplastó sus propios números** — compilar pasó de 5 min 05 s a **41 s** (dentro van
  14 s de control de tipos, cero errores), empaquetar de 36 s a 2 min 23 s (agrupar desde la
  fuente cuesta ~100 s) y el **build completo, de ~6 min a 3 min 34 s**, con el editor
  arrancando después. El `rimraf` de `out-build/` sigue costando ~3 s: no es palanca, y ahora
  menos.

- El árbol preparado se registró como commit en el git de el árbol (`5945775f`, sobre
  el commit virgen `08d4889f`). Después de eso `git status` queda **limpio**: las 5.053 rutas
  borradas, las 327 modificadas y las 40 añadidas pasan a ser historial.
- La comprobación de fuente y de identidad de la fase 1 se ejecutó contra el árbol real y pasa:
  nombre de producto, nombre de compañía en `electron.ts`, icono de Windows que lee el
  empaquetador, manifiesto del servidor y conector, todo presente.
- `build/build-helpers.mjs deps-current` se ejecutó contra el estado real y respondió que **cuadra** (node
  24.20.0). Eso es lo que permite que `npm ci` no vuelva a correr.
- `bash -n` y el análisis estático de los scripts tocados salen limpios. En esa fecha CI estaba
  apagado; volvió el 2026-09-28 (`.github/workflows/ci.yml` y `release.yml`), y
  [`docs/CI.md`](CI.md) lo documenta.
- **No medido:** la compilación y el empaquetado completos con el build nuevo. Tardan horas y no
  se han ejecutado en esta sesión. El primer build real es quien lo confirma, y hasta entonces
  esto no está verificado de punta a punta.

### El camino retirado (medido el 2026-09-23)

También con la numeración antigua de 8 fases: aquí "la fase 5" era el delta de producto y
"la fase 7" la compilación y el empaquetado.

- La composición de patches aplica limpia sobre la fuente fijada: el juego de VSCodium
  (43 + 6) más `patches/picode/` dan `exit 0` y **cero `.rej`**. Se reprodujo tres veces en
  un clon aparte y una más tras los arreglos de esta ronda.
- Los patches vendidos no quedan mutados: la comprobación real es un **manifiesto de hashes
  de contenido** calculado antes y después (`sha256` idéntico), no `git status` — mientras
  `patches/**` no esté trackeado, un patch mutado se vería igual que el estado actual. El
  pipeline expande las plantillas en un directorio temporal (`mktemp -d`) y la copia de
  `patches/` nunca se toca.
- Lo vendido es **byte-idéntico** a la revisión fijada de VSCodium: se extrajo con
  `git show HEAD:<ruta>` desde los *blobs*, que son LF, en lugar de copiar el árbol de
  trabajo (el `core.autocrlf=true` de Windows lo dejaba en CRLF). `.gitattributes` fija
  `*.patch text eol=lf` para que un checkout nuevo no lo vuelva a convertir.
- El patch de `patches/picode/` aplica **encima** del juego VSCodium (dos hunks con
  *offset*, que es justo lo que demuestra que compone) y también aplica sobre la fuente
  sin parchear; `git apply --check` y `git apply -R --check` salen limpios.
- La fase 5 era idempotente (el applier ya no existe): `apply-product-delta.mjs --check` sobre
  el `product.json` de la cadena completa declaraba todas las claves presentes y, tras
  `--write`, un segundo `--check` respondía «already current» (`exit 0`). Hoy ese papel lo
  cumple `product.json`, versionado en el árbol.
- El `product.json` producido por las fases 2–5 es **idéntico** al
  `resources/app/product.json` del PiCode enviado, excluyendo solo los sellos de build
  (`commit`, `date`, `version`, `checksums`, `serverDownloadUrlTemplate`): el camino desde
  fuente reproduce el producto del camino del ZIP.
- `./build/build.sh -o` sale con `exit 0` (tres veces en un clon aparte, más una tras los
  arreglos) y deja el árbol preparado.
- La marca del `package.json` y los metadatos de electron se aplican de verdad: tras
  `./build/build.sh -o`, `package.json` lleva `version 1.135.0` y `author.name
  "PiCode"`, `build/lib/electron.ts` lleva `companyName: 'PiCode'` y el copyright con
  `PiCode`, y `resources/server/manifest.json` lleva `name`/`short_name` `PiCode`.
- La fase 8 sobre una salida de empaquetado sintética sale con `exit 0` y es idempotente.

**Fallos por dependencias, con el error exacto (resuelto):**

- **`./build/build.sh -s` se paró en la fase 6 (`npm ci`).** No fue por Python ni por Node:
  `node-gyp` invocó MSBuild y este respondió
  `error MSB8040: Spectre-mitigated libraries are required for this project` en
  `@deviceid` y `@windows-registry`. Faltaba el componente
  `Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre`. **Instalado, la cadena
  completa termina**; el síntoma y su comprobación están en la tabla de dependencias.

**No medido, y por tanto no afirmado:**

- `build/patch.sh` y `build/update_patches.sh` no se han ejecutado (son interactivos y
  reescriben `patches/picode/*.patch`); solo se ha validado su sintaxis con `bash -n`.
  Ambos ficheros, y los parches que escribían, fueron **borrados** el 2026-09-27.
- La fase 8 se ha ejecutado sobre el empaquetado real de una compilación completa, pero no
  se ha arrancado el `PiCode.exe` resultante en esta máquina.
- No hay análisis estático de los scripts (`shellcheck` no está instalado).
- `undo_telemetry.sh` de VSCodium **no está integrado**: el pipeline no reescribe las URLs
  `*.data.microsoft.com` de la fuente. El patch de telemetría y el delta ya desactivan el
  envío, pero la reescritura de URLs es un hueco declarado en `build/README.md`. Sigue siendo
  hueco hoy: el cambio nunca llegó a hacerse en el árbol.
- Las teselas PNG del menú Inicio (`code_150x150.png`, `code_70x70.png`) **sí se
  redibujan** desde `build/distribution/picode.ico`, en la preparación: el empaquetado las copia
  antes de que la fase 8 pueda tocarlas. `build/README.md` explica por qué es ahí y no en el
  *stage*.
- **La configuración de producto se lee en tiempo de ejecución**, desde
  `resources/app/product.json`. El marcador `/*BUILD->INSERT_PRODUCT_CONFIGURATION*/` es un
  **comentario dentro de un literal de objeto** (`src/vs/platform/product/common/product.ts`)
  que solo se sustituye para el objetivo *web* (`build/gulpfile.vscode.web.ts`); el
  empaquetado de escritorio lo deja tal cual, así que la aplicación toma la vía de
  `vscode.context.configuration()` y saca el producto de ese fichero. Medido: el bundle
  empaquetado **no contiene `.picode`** en ninguna parte y el `product.json` empaquetado
  lleva todas las claves de marca. Consecuencia práctica, la contraria de la que se podría
  suponer leyendo `build/next/index.ts`: **el delta que aplica la fase 8 sí surte efecto**, y
  se puede corregir la marca después de empaquetar.
- **Lo único que hay que acertar ANTES de la fase 7 es lo que el empaquetador graba dentro
  de los binarios**: el icono y las cadenas de versión que escribe `rcedit`. Eso sí queda
  grabado a fuego en el `.exe`, y corregirlo después exige volver a ejecutar `rcedit`
  (`node_modules/rcedit/rcedit.exe`), no copiar un fichero.

**Sobre `defaultChatAgent` y el límite del núcleo minificado:** este camino elimina el
límite del camino binario, porque el cambio de fuente se escribe en TypeScript antes de
compilar y los `checksums` se calculan sobre el producto final. Dicho eso, con el
`product.json` **actual** el objeto `defaultChatAgent` sigue
declarado (sus subclaves de URL están podadas una a una, conservando
`extensionId`, `chatExtensionId`, `provider` y `providerScopes`), así que hoy las guardas
que escribió `patches/picode/` —ahora código en el árbol— son **defensivas**: protegen el workbench el día que el árbol deje de
declarar la clave, pero no cambian el comportamiento del binario construido. Que PiCode no
declare Copilot por defecto exige además un cambio en `build/distribution/`, que está congelado.

## ⚖️ Licencia

PiCode es una distribución de VSCodium, que es a su vez un build de la fuente MIT de VS
Code. Este camino reproduce esa cadena; las licencias y atribuciones de upstream se
conservan y se documentan en [`DISTRIBUTION.md`](DISTRIBUTION.md).
escritorio, para probarlo sin cambiar de máquina.
