# Cómo compilar PiCode desde la fuente

Este documento describe el **camino adicional** que construye PiCode parcheando la fuente
de VS Code, con el modelo de VSCodium: clonar el commit fijado, aplicar el juego de
patches heredado, aplicar los patches propios, aplicar la capa de producto y compilar.

No sustituye a la release. El **ZIP precompilado** sigue siendo el camino de quien solo
quiere usar PiCode (`distribution/apply-picode.ps1`, descrito en
[`DISTRIBUTION.md`](DISTRIBUTION.md)). Este es el camino de quien colabora en el núcleo y
necesita recompilar.

La diferencia que justifica el trabajo: en el ZIP el producto se parchea sobre un
`resources/app` ya minificado y con un mapa `checksums` que impide tocar el bundle. Aquí
el producto se aplica a `picode-source/product.json` **antes** de compilar, los `checksums` se
calculan sobre el resultado, y un cambio de comportamiento se escribe en TypeScript en
`patches/picode/`.

## Índice

- [La cadena, por capas](#la-cadena-por-capas)
- [Dependencias en Windows](#dependencias-en-windows)
- [Los dos pins y cómo volver a fijarlos](#los-dos-pins-y-cómo-volver-a-fijarlos)
- [Cómo compilar](#cómo-compilar)
- [Arreglar un patch cuando upstream se mueve](#arreglar-un-patch-cuando-upstream-se-mueve)
- [Reglas de `patches/picode/`](#reglas-de-patchespicode)
- [Estado de verificación](#estado-de-verificación)

## La cadena, por capas

Cada capa añade algo y ninguna reescribe la anterior. El orden no es negociable.

```text
  Microsoft VS Code
  (commit fijado en upstream/stable.json)
        │
        │  fase 1 · dev/get_repo.sh: clona/fetch del commit y verifica HEAD
        ▼
  ./picode-source              VS Code sin tocar
        │
        │  fase 2 · dev/prepare_vscode.sh brand
        │  (identidad base de VSCodium en product.json + dev/vscodium-product.json)
        ▼
  ./picode-source              listo para los patches heredados
        │
        │  fase 3 · patches/vscodium/**  (verbatim de upstream/vscodium.json;
        │           acciones .json de borrado, luego *.patch, luego ${OS_NAME}/)
        ▼
  ./picode-source                     con el juego VSCodium aplicado
        │
        │  fase 4 · patches/picode/**    (los cambios propios de fuente)
        ▼
  ./picode-source                     con los cambios propios
        │
        │  fase 5 · distribution/product-delta.json
        │           (node distribution/apply-product-delta.mjs … --write)
        ▼
  ./picode-source/product.json        ya es el producto PiCode
        │
        │  fase 6 · npm ci        (dependencias; hasta 5 intentos)
        │  fase 7 · gulp vscode-min-prepack + recursos + politicas win32
        │           + gulp vscode-win32-x64-min-packing
        ▼
  ./PiCode-Win32-x64/          árbol empaquetado
        │
        │  fase 8 · dev/stage-distribution.sh
        │           (capa distribution/: delta, perfil portable, settings, panel, marcas,
        │            renombrado PiCode.exe / bin/picode*)
        ▼
  ./PiCode-Win32-x64/PiCode.exe
```

Las capas están separadas a propósito:

| Capa | Fuente de verdad | Qué aporta |
| --- | --- | --- |
| Fuente | `upstream/stable.json` | El VS Code exacto sobre el que se compila. |
| Patches heredados | `patches/vscodium/**` + `upstream/vscodium.json` | Todo lo que VSCodium ya quita (telemetría, Copilot, cloud, update, firma, onboarding…). |
| Patches propios | `patches/picode/**` | Cambios de fuente que PiCode necesita y que no son datos. |
| Producto | `distribution/product-delta.json` | Marca, galería, URLs, poda de claves. Es la **única** fuente de la identidad PiCode. |
| Empaquetado | `dev/stage-distribution.sh` | Perfil portable, settings de primer arranque, panel como extensión built-in, iconos y nombres. |

## Dependencias en Windows

Los scripts están en **Bash**, así que en Windows se ejecutan desde **Git Bash**
(incluido en Git for Windows). PowerShell no sirve para estos scripts.

| Herramienta | Para qué | Instalación |
| --- | --- | --- |
| **Git for Windows** | Git **y Git Bash**: sin él no hay shell para los scripts. | `winget install --id Git.Git -e` |
| **Node.js 24.18.0** (lo que dice [`.nvmrc`](../.nvmrc)) | `npm ci` y las tareas gulp. Con nvm-windows: | `nvm install 24.18.0` y luego `nvm use 24.18.0` |
| **jq** | La fase 2 marca `product.json` con `jq`, y las acciones `.json` lo leen. Sin `jq` en el `PATH`, la preparación falla con un mensaje claro. | `winget install --id jqlang.jq -e` |
| **Python 3.11** | Lo pide el sistema de build de VS Code para los módulos nativos (`node-gyp`). Medido: con **3.14.7** `node-gyp` llegó hasta MSBuild sin quejarse, así que la versión **no** fue el obstáculo; 3.11 es lo que documenta upstream y lo recomendable. | `winget install --id Python.Python.3.11 -e` |
| **Rustup** | Compila algunos módulos nativos de VS Code. Reescribe el `PATH` al terminar: reinicia el shell. | [rustup.rs](https://rustup.rs/) o `winget install --id Rustlang.Rustup -e` |
| **7-Zip** | Empaqueta archivos `.zip`. | `winget install --id 7zip.7zip -e` |
| **Visual Studio 2022** (Community o Build Tools) con *Desktop development with C++* **y las librerías Spectre** | `node-gyp` compila los módulos nativos con MSBuild. **Sin las librerías Spectre el build se para** con `error MSB8040` en `@picode-source/deviceid` y `@picode-source/windows-registry`. | Ver el comando de abajo |

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
# sin salida = el componente NO está, y la fase 6 se parará con MSB8040
```

Node también se puede bajar de [nodejs.org](https://nodejs.org/); si se usa el instalador,
conviene marcar la opción de instalar las herramientas de compilación C++.

Comprobación rápida del `PATH`, desde Git Bash:

```bash
node --version    # debe casar con .nvmrc (24.18.0)
npm --version
jq --version
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
- **Node es 24.19.0**, no el 24.18.0 del pin. Es la misma línea 24, y VSCodium salta la
  comprobación con `VSCODE_SKIP_NODE_VERSION_CHECK=yes`.
- **Python es 3.14.7**, no 3.11. No fue el obstáculo: `node-gyp` invocó MSBuild y el fallo
  llegó de ahí.
- **`shellcheck` no está** instalado, así que los scripts solo se han validado con `bash -n`.

## Los dos pins y cómo volver a fijarlos

El pipeline se apoya en **dos** archivos de pin, y se mueven **juntos**:

| Pin | Qué fija |
| --- | --- |
| [`upstream/stable.json`](../upstream/stable.json) | El commit de **VS Code**: `tag`, `commit`, `repository`. Es lo que clona la fase 1. |
| [`upstream/vscodium.json`](../upstream/vscodium.json) | La revisión de **VSCodium** cuyo árbol `patches/` se vendió en `patches/vscodium/`, y de la que sale `dev/vscodium-product.json` (el `product.json` raíz de VSCodium). |

Los patches heredados no son genéricos: están escritos contra **una** revisión de VS Code
concreta. Por eso los dos pines forman una pareja y por eso `upstream/vscodium.json` lleva
la nota de que volver a fijar VS Code sin moverlo es un defecto.

**Modo de fallo si solo se mueve uno:**

- **Se mueve `upstream/stable.json` y se deja `upstream/vscodium.json`:** la fase 3 aplica
  patches escritos para la revisión anterior de VS Code; los hunks que ya no encajan hacen
  que `git apply` falle y **el build se detiene** ahí (no hay `--reject` en el pipeline: un
  juego a medias es peor que un build parado). Además, el `dev/vscodium-product.json`
  vendido puede estar incompleto para las claves nuevas de la fuente.
- **Se mueve `upstream/vscodium.json` (se vendían patches nuevos) y se deja
  `stable.json`:** los patches están escritos contra un VS Code más nuevo y fallan contra
  la fuente vieja, por el mismo motivo en sentido contrario.

**Pasos para volver a fijarlos:**

1. Actualiza `tag` y `commit` en `upstream/stable.json`.
2. Actualiza `tag` y `commit` en `upstream/vscodium.json`.
3. Vuelve a vendoriar `patches/vscodium/**` y `dev/vscodium-product.json` desde esa
   revisión de VSCodium. `patches/vscodium/**` es verbatim: nunca se edita a mano.
4. Comprueba que componen, sin compilar:
   ```bash
   ./dev/build.sh -o
   find vscode -name '*.rej'   # debe salir vacío
   ```

`RELEASE_VERSION` sale del `tag` de `upstream/stable.json` (una release real lo fija en el
entorno y debe ser `X.Y.Z`). Ese valor es con lo que se expande `!!RELEASE_VERSION!!`.

## Cómo compilar

```bash
./dev/build.sh          # cadena completa: fetch, preparar, npm ci, compilar, empaquetar, stage
./dev/build.sh -o       # solo preparación (fases 1-5): sin npm ci y sin compilar
./dev/build.sh -s       # reutiliza ./picode-source en vez de descargarlo
```

- **`./dev/build.sh`** ejecuta las 8 fases. Necesita las dependencias completas de la
  sección anterior.
- **`./dev/build.sh -o`** para en la fase 5, sale con código 0 y **no compila nada**. Es la
  forma de verificar la preparación en un minuto en lugar de tras un build largo.
- **`./dev/build.sh -s`** reutiliza `./picode-source`. Si el árbol está limpio (descargado pero
  nunca preparado) pasa por las fases 2–5; si está sucio, se considera **preparado**, se
  saltan las fases 1–5 y el build continúa en la 6. `-s` verifica además que el `HEAD` de
  `./picode-source` coincide con el commit del pin.

`OS_NAME` se deriva de `OSTYPE` (Git Bash → `windows`) y es **obligatorio**: un `OSTYPE`
del que no se pueda derivar `windows`, `osx` o `linux` es un error duro, porque el stage de
patches acabaría haciendo glob de `patches/vscodium//*.patch` y aplicando el juego de
arriba dos veces.

**Dónde queda todo:**

| Ruta | Qué es |
| --- | --- |
| `./picode-source` | El clon de la fuente, ya preparado (fases 1–5). `-o` lo deja así y para. |
| `./PiCode-Win32-x64` | La salida del empaquetado (fase 7). |
| `./PiCode-Win32-x64/PiCode.exe` | El ejecutable construido desde fuente. |

`./picode-source` y `./VSCode-*` están en `.gitignore`: la fuente y la salida nunca se versionan.

### Qué se ha ejecutado y qué no

- `./dev/build.sh -o` se ha ejecutado **dos veces**, salida **0** las dos, con
  **50 patches aplicados** (43 de `patches/vscodium/*.patch`, 6 de
  `patches/vscodium/windows/*.patch`, 1 de `patches/picode/*.patch`) y las **2 acciones
  JSON** de borrado (`52-ext-copilot-remove-it.json` y `80-ui-disable-onboarding.json`,
  148 rutas). Cero `.rej`.
- `./dev/build.sh -s` se ha ejecutado sobre un árbol ya preparado, salida **0**.
- La fase 8 (`dev/stage-distribution.sh`) se ha ejecutado sobre una salida de empaquetado
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
  teselas del menú Inicio— ocurre en la preparación, en `dev/prepare_vscode.sh`, **antes**
  de la fase 7.
- **Verificado después del arreglo, y sin lugar a dudas:** parseando el directorio de
  recursos del PE, los **7 frames** de `distribution/picode.ico` (16, 24, 32, 48, 64, 128 y
  256) están presentes en `PiCode.exe` **byte a byte**. Ojo con la forma de medirlo:
  `System.Drawing.Icon` no puede leer `picode.ico` (sus frames van comprimidos en PNG) y
  `ExtractAssociatedIcon` devuelve un bitmap reescalado, no el frame nativo — comparar así
  da «distintos» con el icono correcto puesto.

## Arreglar un patch cuando upstream se mueve

Cuando se mueve el pin, algún patch deja de aplicar. El flujo es el de VSCodium, adaptado a
que los patches viven en `patches/picode/`.

> **Antes de nada:** si el patch que falla está en `patches/vscodium/**`, **no se arregla a
> mano**. Ese árbol es vendido verbatim: se vuelve a vendoriar desde la nueva revisión de
> VSCodium. `./dev/patch.sh` y `./dev/update_patches.sh` trabajan **solo** sobre
> `patches/picode/`.

### Semiautomático

- Ejecuta `./dev/build.sh`; si un patch falla,
- ejecuta `./dev/update_patches.sh`;
- cuando el script se pare en `Press any key when the conflicts have been resolved...`,
  abre el directorio `vscode` en un PiCode (o VSCodium);
- arregla todos los ficheros `*.rej`;
- ejecuta `npm run watch`;
- ejecuta `./script/code.sh` hasta que todo funcione;
- vuelve a la terminal y pulsa una tecla para que el script reescriba los patches.

El baseline sobre el que se regeneran es el baseline real del pipeline (fases 2–5,
patches heredados incluidos), y la referencia es el índice de git: no se crean commits
desechables en el clon.

### Manual

- Ejecuta `./dev/build.sh`; si un patch falla,
- ejecuta `./dev/patch.sh <name>.patch`, donde `<name>.patch` es el patch que falló;
- abre `vscode` en una ventana nueva de PiCode (o VSCodium);
- arregla los `*.rej`;
- ejecuta `npm run watch`;
- ejecuta `./script/code.sh` hasta que todo funcione;
- vuelve a la terminal del `./dev/patch.sh`, pulsa **ENTER** para validar y reescribir el
  patch.

### Los sufijos `.patch.no` y `.patch.yet`

Un patch solo se aplica si su nombre termina en **`.patch`**. Los ficheros que acaban en
`.patch.no` o `.patch.yet` están **inactivos por nombre** y el glob los salta. La forma de
habilitar o deshabilitar un patch es, por tanto, renombrarlo.

(Única excepción, heredada de VSCodium: `patches/vscodium/00-update-disable.patch.yet` se
aplica explícitamente solo si `DISABLE_UPDATE=yes`, que el build por defecto no fija.)

## Reglas de `patches/picode/`

- **Un concepto por patch.** Nombre `NN-<area>-<qué-hace>.patch`, con el número fijando el
  orden de aplicación.
- **Solo cambios de fuente.** Si algo se puede hacer con `distribution/product-delta.json`,
  se hace allí; un patch aquí es el último recurso. Por eso la carpeta es pequeña.
- **Misma plantilla que el juego heredado.** `dev/utils.sh` expande `!!APP_NAME!!` y
  compañía en una **copia temporal** del patch antes de aplicarlo; el fichero de
  `patches/picode/` nunca se reescribe. Los placeholders solo pueden aparecer en líneas
  añadidas, que es lo que permite aplicar el patch tal cual mientras se edita.

  | Placeholder | Valor |
  | --- | --- |
  | `!!APP_NAME!!` | `PiCode` |
  | `!!APP_NAME_LC!!` | `picode` |
  | `!!ASSETS_REPOSITORY!!`, `!!GH_REPO_PATH!!` | `TomasPlatero/PiCode` |
  | `!!BINARY_NAME!!` | `picode` |
  | `!!GLOBAL_DIRNAME!!` | `picode` |
  | `!!ORG_NAME!!` | `TomasPlatero` |
  | `!!RELEASE_VERSION!!` | el `tag` de `upstream/stable.json` |
  | `!!TUNNEL_APP_NAME!!` | `picode-tunnel` |

- **Prefijos `a/` y `b/`**, saltos de línea LF y contenido ASCII.
- **Nunca se edita `patches/vscodium/`.** Es material heredado y vendido verbatim.
- En la fase 4 el orden es: acciones `.json` de borrado, `*.patch` ordenados con la
  localización C, `patches/picode/${OS_NAME}/*.patch`, `patches/picode/user/*.patch`.
  Cada patch se aplica con `git apply --ignore-whitespace`; si uno no aplica, el build se
  para (no hay `--reject` en el pipeline).

Para autorar uno:

```bash
./dev/build.sh -o            # una vez, para tener ./picode-source preparado
./dev/patch.sh 00-my-change  # resetea, rehace el baseline, aplica, edita, regenera
./dev/update_patches.sh      # regenera todos los patches en orden
```

El pipeline avisa: **`patches/**` no se escribe** salvo por `patch.sh` /
`update_patches.sh`, cuando el desarrollador se lo pide. `distribution/**`,
`extensions/**` y `.git/**` no se tocan.

## Estado de verificación

**Medido en esta máquina (2026-09-23):**

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
- La fase 5 es idempotente: `apply-product-delta.mjs --check` sobre el `product.json` de la
  cadena completa declara todas las claves presentes y, tras `--write`, un segundo
  `--check` responde «already current» (`exit 0`).
- El `product.json` producido por las fases 2–5 es **idéntico** al
  `resources/app/product.json` del PiCode enviado, excluyendo solo los sellos de build
  (`commit`, `date`, `version`, `checksums`, `serverDownloadUrlTemplate`): el camino desde
  fuente reproduce el producto del camino del ZIP.
- `./dev/build.sh -o` sale con `exit 0` (tres veces en un clon aparte, más una tras los
  arreglos) y deja el árbol preparado.
- La marca del `package.json` y los metadatos de electron se aplican de verdad: tras
  `./dev/build.sh -o`, `picode-source/package.json` lleva `version 1.135.0` y `author.name
  "PiCode"`, `build/lib/electron.ts` lleva `companyName: 'PiCode'` y el copyright con
  `PiCode`, y `resources/server/manifest.json` lleva `name`/`short_name` `PiCode`.
- La fase 8 sobre una salida de empaquetado sintética sale con `exit 0` y es idempotente.

**Fallos por dependencias, con el error exacto (resuelto):**

- **`./dev/build.sh -s` se paró en la fase 6 (`npm ci`).** No fue por Python ni por Node:
  `node-gyp` invocó MSBuild y este respondió
  `error MSB8040: Spectre-mitigated libraries are required for this project` en
  `@picode-source/deviceid` y `@picode-source/windows-registry`. Faltaba el componente
  `Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre`. **Instalado, la cadena
  completa termina**; el síntoma y su comprobación están en la tabla de dependencias.

**No medido, y por tanto no afirmado:**

- `dev/patch.sh` y `dev/update_patches.sh` no se han ejecutado (son interactivos y
  reescriben `patches/picode/*.patch`); solo se ha validado su sintaxis con `bash -n`.
- La fase 8 se ha ejecutado sobre el empaquetado real de una compilación completa, pero no
  se ha arrancado el `PiCode.exe` resultante en esta máquina.
- No hay análisis estático de los scripts (`shellcheck` no está instalado).
- `undo_telemetry.sh` de VSCodium **no está integrado**: el pipeline no reescribe las URLs
  `*.data.microsoft.com` de la fuente. El patch de telemetría y el delta ya desactivan el
  envío, pero la reescritura de URLs es un hueco declarado en `dev/README.md`.
- Las teselas PNG del menú Inicio (`code_150x150.png`, `code_70x70.png`) **sí se
  redibujan** desde `distribution/picode.ico`, en la preparación: el empaquetado las copia
  antes de que la fase 8 pueda tocarlas. `dev/README.md` explica por qué es ahí y no en el
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
  (`picode-source/node_modules/rcedit/rcedit.exe`), no copiar un fichero.

**Sobre `defaultChatAgent` y el límite del núcleo minificado:** este camino elimina el
límite del camino binario, porque el cambio de fuente se escribe en TypeScript antes de
compilar y los `checksums` se calculan sobre el producto final. Dicho eso, con el
`distribution/product-delta.json` **congelado actual** el objeto `defaultChatAgent` sigue
en `product.json` (el delta poda sus subclaves de URL con `unsetNested`, pero conserva
`extensionId`, `chatExtensionId`, `provider` y `providerScopes`), así que hoy las guardas
de `patches/picode/` son **defensivas**: protegen el workbench el día que el delta deje de
declarar la clave, pero no cambian el comportamiento del binario construido. Que PiCode no
declare Copilot por defecto exige además un cambio en `distribution/`, que está congelado.

## Licencia

PiCode es una distribución de VSCodium, que es a su vez un build de la fuente MIT de VS
Code. Este camino reproduce esa cadena; las licencias y atribuciones de upstream se
conservan y se documentan en [`DISTRIBUTION.md`](DISTRIBUTION.md).

## Otros sistemas: Linux, y Windows con WSL

La cadena entiende **Windows y Linux**. macOS no está puesto todavía: necesita su propio nombre de
carpeta en `build/gulpfile.vscode.ts` (el mismo cambio de una línea que 16 y 17) y un caso más en la
tabla de `dev/build.sh`; el resto valdría igual.

El sistema se deduce del entorno (`OSTYPE`) y decide tres cosas: qué parches se aplican
(`patches/*/${OS_NAME}/`), qué tarea empaqueta (`vscode-<sistema>-<arch>-min-packing`) y **cómo se
llama la carpeta que sale**:

| Sistema | Carpeta del paquete |
| --- | --- |
| Windows | `PiCode-Win32-x64` |
| Linux | `PiCode-linux-x64` |

### Construir en Linux

Los mismos pasos que arriba, con `jq`, `python3` y Git instalados. Lo que cambia es poco y está
resuelto: el paquete se llama PiCode, el icono de la ventana se saca de `distribution/picode.ico`
(que ya lleva PNGs dentro), y los binarios del pi se podan a los de la plataforma que se construye.

**Una build de Linux hay que hacerla en Linux.** Los módulos nativos (la terminal, el vigía de
ficheros) se compilan para la máquina donde compilas: no se puede cruzar desde Windows.

### Con WSL, desde Windows

WSL es un Linux de verdad, así que sirve. Dos cosas, en este orden:

1. `wsl --install` **en una terminal como administrador**, y reiniciar. (Pide permisos: la
   instalación de WSL es una característica de Windows.)
2. **El repositorio, dentro del disco de Linux** (`~/PiCode`), no sobre `/mnt/d/...`: compilar sobre
   el disco de Windows con miles de ficheros pequeños es varias veces más lento. El resultado es un
   paquete para Linux, que se saca copiándolo.

Con WSL 2 en Windows 11 (WSLg) incluso se puede **abrir el editor resultante** y verlo en el
escritorio, para probarlo sin cambiar de máquina.
