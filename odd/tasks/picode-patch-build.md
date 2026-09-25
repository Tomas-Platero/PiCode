# Feature: build por patches sobre la fuente (estilo VSCodium)

## Goal

Añadir a PiCode un **camino de compilación desde fuente** con el modelo de VSCodium:
clonar VS Code en un commit fijado, aplicar el juego de patches de VSCodium, aplicar los
patches propios de PiCode, aplicar la capa `distribution/` y compilar `PiCode.exe`. El ZIP
precompilado sigue siendo el camino para quien solo quiere usar PiCode; este es el camino
adicional para quien quiere cambiar o auditar el núcleo.

## Why this feature exists

Hasta ahora PiCode se distribuye como **binario VSCodium ya compilado** más una capa de
modificación *de datos*. Un colaborador solo puede tocar `extensions/picode-pi-chat/` y
`distribution/`; no puede cambiar el core, recompilar ni auditar un diff versionado.

## Hallazgo que ordena todo

**No existía un conjunto de cambios al código fuente que "extraer" a patches.** El PiCode
actual *es* un binario VSCodium (`1.135.06055`) con los patches de VSCodium ya dentro, más un
delta de `product.json`. El trabajo real no era trocear diffs inexistentes, sino
**reclasificar** lo que vivía fuera de la fuente:

| Modificación | Dónde vivía | Dónde vive en la fuente |
| --- | --- | --- |
| Marca (`nameShort`, `nameLong`, `applicationName`, `urlProtocol`) + 17 claves más | `product-delta.json` | el mismo delta, aplicado a `vscode/product.json` (fase 5) y al árbol empaquetado (fase 8) |
| Galería → Open VSX, URLs de docs/issues/release | `product-delta.json` | idem |
| Quitar telemetría, Copilot, cloud, update, firma, onboarding | *ya lo hacía VSCodium* | `patches/vscodium/**` (heredados, sin tocar) |
| Podar `defaultChatAgent`, `extensionEnabledApiProposals`, `builtInExtensionsEnabledWithAutoUpdates` | `product-delta.json` | el mismo `apply-product-delta.mjs`, antes de compilar |
| Versión y marca de `package.json` / `electron.ts` / `server/manifest.json` | no existía | etapa `metadata` de `dev/prepare_vscode.sh` |
| Icono del ejecutable y teselas del menú Inicio | no existía | `brand_windows_icons`, en la etapa `metadata` |
| Perfil portable `data/`, `settings.json`, panel built-in, nombres de fichero | `apply-picode.ps1` | `dev/stage-distribution.sh` (fase 8) |
| URL de sourcemaps de VSCodium en cada bundle | *venía de un patch heredado* | `patches/picode/02-remove-inherited-sourcemap-url.patch` |

Consecuencia honesta: `patches/picode/` tiene **dos** patches, y solo cambian fuente con
razón. Es una carpeta de extensión, no un vertedero.

## Decisions

1. **Estructura pedida, respetada:** `patches/vscodium/`, `patches/picode/`, `dev/`,
   `docs/howto-build.md`; `distribution/` solo cambió el delta, por petición expresa del dueño.
2. **Dos pins.** `upstream/stable.json` fija el commit de VS Code;
   `upstream/vscodium.json` fija además la revisión de VSCodium de la que se vendoriaron los
   patches. Mover uno sin el otro es un defecto.
3. **`patches/vscodium/` verbatim**: 75 ficheros extraídos con `git show HEAD:<ruta>` (blobs
   LF), no copiando el árbol de trabajo, para que "verbatim" sea literal.
4. **`patches/picode/` se templa igual** que los heredados (`!!APP_NAME!!`, etc.).
5. **El delta se aplica antes de compilar** (fase 5) y otra vez al árbol empaquetado (fase 8).
6. **Versión de la build desde fuente = tag de `upstream/stable.json` (`1.135.0`)**, no la
   fórmula por fecha de VSCodium. Efecto conocido: una build desde fuente sella `1.135.0` y el
   ZIP precompilado lleva `1.135.06055`. Unificar los números es política de versiones,
   **pendiente del dueño**.
7. **Sin CI** (fuera de alcance declarado).
8. **Rebranding completo pedido por el dueño**: el delta pasó de 12 a 29 claves y se quitó la
   URL de sourcemaps heredada. Lo que **no** se toca, con motivo: el *namespace* `vscode` de la
   API de extensiones (es el contrato de todas las extensiones), las rutas internas `out/vs/**`,
   los IDs reales de extensiones, la URL de la API de Open VSX y los avisos legales
   (`LICENSE.txt`, `ThirdPartyNotices.txt`, `LICENSES.chromium.html`), que son obligación de
   licencia. Decisión menor: las etiquetas del selector de teclado del asistente
   (`onboardingKeymaps`, que dicen «VS Code») se dejan, porque describen **qué mapeo de teclas
   es**, no la marca del producto — y VSCodium también las deja.

## Tasks

- [x] T1 Vendoriar `patches/vscodium/` desde VSCodium `5a73682c` (tag `1.135.06055`).
- [x] T2 Pins `upstream/stable.json` y `upstream/vscodium.json`.
- [x] T3 `.nvmrc`, `.gitignore` y `.gitattributes` (`*.patch text eol=lf`).
- [x] T4 Auditar el core: el residual es el producto por defecto OSS con
      `defaultChatAgent: GitHub.copilot` más **seis** líneas sin guarda en **cuatro** ficheros.
- [x] T5 `patches/picode/01-remove-hardcoded-copilot-default.patch` (5 ficheros, 7 hunks).
- [x] T6 `dev/build.sh` (8 fases), `get_repo.sh`, `prepare_vscode.sh`, `utils.sh`, `version.sh`.
- [x] T7 `dev/patch.sh` y `dev/update_patches.sh`.
- [x] T8 `docs/howto-build.md`, `dev/README.md`, y la sección de compilación del `README.md`.
- [x] T9 Verificación independiente (dos verificadores; ver abajo).
- [x] T10 Preparación completa en clon limpio: `exit 0`, 50 patches, cero `.rej`.
- [x] T11 **Compilación completa hasta `PiCode.exe`**: conseguida. `compile-src … with 0 errors`,
      fase 7 y fase 8 completas.
- [x] T12 Icono del ejecutable arreglado y verificado (7 de 7 frames, byte a byte).
- [x] T13 Delta de marca extendido de 12 a 29 claves; verificado en el `product.json`
      empaquetado **y** en el árbol construido.
- [x] T14 Borrado el payload antiguo de la raíz (~1,17 GB) sin tocar nada versionado ni el
      perfil del dueño.
- [x] T15 `patches/picode/02-remove-inherited-sourcemap-url.patch`: quita el último rastro
      literal de VSCodium del producto.

## Verified facts (2026-09-23)

- El árbol anterior era un VSCodium **1.135.06055**, con 66 claves de producto y `checksums`
  de 10 entradas.
- VSCodium fija VS Code en `1.135.0` / `08d4889f9ec4a1685d257b9b95de036c8e1ce1e5`; su repo, en
  `5a73682ca091082675b10c9dc3f348c1d824d94f`, tiene 54 entradas de nivel superior y **75
  ficheros** en `patches/`.
- **`OS_NAME` es obligatorio**: sin él el glob `${OS_NAME}/*.patch` se convierte en
  `../patches//*.patch` y reaplica todo. Costó un falso «fallo de patches».
- Tres patches heredados reescriben `package.json`, así que la marca del `package.json` va
  **después** de los patches.
- El icono del ejecutable lo decide el empaquetado: `build/lib/electron.ts` declara
  `winIcon: 'resources/win32/code.ico'` y `build/gulpfile.vscode.win32.ts` lo aplica con
  `rcedit(executablePath, { icon })`.
- El `product.json` **no** se incrusta en el empaquetado de escritorio: el marcador
  `/*BUILD->INSERT_PRODUCT_CONFIGURATION*/` es un comentario dentro de un objeto y solo lo
  sustituye el objetivo *web*, así que la aplicación lee `resources/app/product.json` en
  tiempo de ejecución.
- Dependencias medidas: `jq` 1.8.2, `7-Zip` 26.03, `rustup`/`cargo` y MSVC (VS 2022 Community
  con `VC.Tools.x86.x64`) presentes; **falta el componente Spectre** y es lo que paró la
  primera compilación; Python 3.14.7 en lugar de 3.11, que **no** fue el obstáculo.

## Independent verification (dos verificadores, clon aparte)

**`pipeline-run` — pass-with-findings.** `./dev/build.sh -o` tres veces: `exit 0` las tres,
50 patches, cero `.rej`, manifiesto `sha256` de `patches/` idéntico antes y después. Declaró
explícitamente que **no** corrió `npm ci` ni gulp.

**`adversarial-review` — fail.** 1 blocker, 2 majors, 6 minors, todos confirmados antes de
tocar nada:

1. **Blocker — `dev/build.sh:283`, `bash build/windows/rtf/make.sh`.** Ese fichero vive en el
   repositorio de VSCodium, no en VS Code, y con `set -eo pipefail` la fase 7 abortaba con
   127. Su único producto es `LICENSE.rtf`, que solo lee el instalador Inno, y PiCode no
   construye instaladores. **Eliminado.**
2. **Major — `update_patches.sh` regeneraba contra el objetivo equivocado.** Un
   `echo … | while read` alimentaba por tubería el `read -rp` de la resolución de conflictos:
   la pausa nunca esperaba y se comía el byte siguiente de la lista. **Reescrito a array.**
3. **Major — no se escribía la versión ni la marca del `package.json`**, y el fichero afirmaba
   que estaba documentado cuando no lo estaba. **Cerrado** con la etapa `metadata`.
4. **Minor, y era mi error — el patch estaba incompleto.** Protegía 4 de 6 sitios; faltaban
   `chatWidget.ts:1482-1484` y `extensionsWorkbenchService.ts:2876`. **Añadidos.**
5. **Minor — CRLF.** Los 75 ficheros vendidos estaban en CRLF por `core.autocrlf=true`.
   Re-extraídos de los blobs (LF) y `.gitattributes` lo fija.
6. **Minor — `stage-distribution.sh`** usaba `sed -i` en vez del ayudante `replace()` y tenía un
   `|| cp` que enviaba el icono **con la metadata C2PA dentro** si el `sed -z` fallaba. Ahora
   falla en voz alta.
7. **Minor — afirmaciones falsas** en docs y `dev/README.md`: corregidas.

## Defectos que encontró la ejecución real (no la lectura)

1. **El icono del `.exe` era el de VS Code.** El icono se graba al empaquetar; la fase 8 lo
   sustituía después, y solo la copia interna. Movido a la preparación, antes de la fase 7.
   Verificado parseando el directorio de recursos del PE: **7 de 7 frames de
   `distribution/picode.ico` presentes byte a byte**.
2. **Y dentro del arreglo, dos fallos propios que merecen quedar escritos**, porque los dos
   reportaban éxito con el trabajo sin hacer:
   - `System.Drawing.Icon` no puede leer `picode.ico` (sus frames van comprimidos en PNG):
     `ToBitmap()` lanzaba `ArgumentOutOfRangeException`. Se extrae el frame a mano del
     contenedor.
   - El escapado de bash convirtió `${size}` en vacío, así que los dos tiles se escribieron en
     un único fichero llamado `code_x.png` mientras el paso decía «redrew the Start Menu
     tiles». Ahora el nombre se construye por concatenación **y se vuelve a leer el fichero
     escrito** comprobando sus dimensiones.
3. **Dos conclusiones mías que eran falsas y quedaron corregidas en la documentación:**
   - Afirmé que el `product.json` se incrusta al compilar y que por eso la marca no se podía
     corregir después de empaquetar. Medido: no es así en el empaquetado de escritorio.
   - Atribuí el icono a `gulpfile.vscode.ts:439/:609`; el mecanismo real es
     `build/lib/electron.ts` (`winIcon`) más `rcedit` en `gulpfile.vscode.win32.ts`.
   - Y una tercera, en el registro: escribí «74 entradas en `patches/`» cuando son **75
     ficheros**. El verificador también señaló que `git status` **no sirve** como prueba de que
     los patches vendidos no se mutan mientras `patches/**` no esté trackeado: la prueba real
     es el manifiesto de hashes.

## Evidence

- Preparación: `./dev/build.sh -o` → `EXIT=0`, 50 patches, `find vscode -name '*.rej'` vacío.
- Patch 01 completo: `git apply --reverse --check` → OK; `grep -c defaultChatAgent` en el
  producto OSS → `0`.
- Patch 02: `git apply --check` → `exit 0`; las 4 apariciones de la URL de VSCodium quedan
  eliminadas de `vscode/build/`.
- Compilación: `Finished compile-src … with 0 errors`; `== done`.
- Ejecutable: `PiCode-Win32-x64/PiCode.exe`, 221.987.328 bytes, `ProductName "PiCode - Agentic
  Code Editor"`, `CompanyName PiCode`, `FileVersion 1.135.0`, `OriginalFilename electron.exe`.
- Icono: los 7 frames de `distribution/picode.ico` presentes en el PE byte a byte (parser de
  recursos propio).
- Marca: `product.json` empaquetado con `dataFolderName .picode`,
  `win32AppUserModelId PiCode.PiCode`, `nameLong PiCode — Agentic Code Editor`; el bundle
  empaquetado **no contiene `.picode`** (lo lee en tiempo de ejecución).
- Perfil portable: `PiCode-Win32-x64/data/{user-data,extensions,tmp,argv.json}` con el
  `settings.json` de `distribution/`.
- `bash -n` sobre los 8 scripts de `dev/` → OK.

## Not measured (y por tanto no afirmado)

- **El `PiCode.exe` construido no se ha arrancado** en esta máquina. Que compile, empaquete y
  lleve la marca correcta no es lo mismo que haberlo ejecutado.
- La fase 8 sobre un empaquetado real se ejecutó; no se ha probado el árbol resultante como
  aplicación en uso.
- `dev/patch.sh` y `dev/update_patches.sh` no se han ejecutado (son interactivos y reescriben
  `patches/picode/*.patch`); su sintaxis pasa `bash -n` y el defecto del bucle está corregido.
- `shellcheck` no está instalado: no hay análisis estático.
- `undo_telemetry.sh`, la inyección de anuncios y `build_cli.sh` no están integrados. Medido:
  `bin/picode` y `bin/picode.cmd` **sí** existen; lo que falta es el **túnel**
  (`picode-tunnel.exe`), que VSCodium construye desde assets publicados.
- No hay commit: el trabajo queda sin commitear por regla del repositorio.

## Cierre: dónde queda la palabra «VSCodium», y por qué se queda

Verificado sobre el árbol construido por la última compilación (51 patches, los dos de
PiCode incluidos):

- **El código del producto está a cero**: `resources/app/out/` → **0 ficheros, 0
  ocurrencias**. El comentario de sourcemap ya no nombra a nadie
  (`sourceMappingURL=sourcemaps/core-main.js.map`, relativo). El `product.json` empaquetado,
  el ejecutable, su icono y sus cadenas de versión son PiCode.
- Quedan **10 ficheros** con la palabra, y los dos motivos son de terceros:
  1. **`@vscodium/native-keymap`**, dentro de `node_modules.asar`: su propio script de
     instalación descarga el binario precompilado desde
     `https://github.com/VSCodium/native-keymap/releases/download`. Es un paquete publicado
     por la organización VSCodium: ese nombre y esa URL son su identidad y su origen de
     descarga. Reescribirlos rompería la instalación y falsearía la autoría.
  2. **`@vscode/ripgrep-universal`**, los 9 binarios de `rg`. La cadena está en la ayuda que
     ripgrep lleva incrustada, listando los esquemas de URL que soporta (`vscodium://`). Es
     contenido de un binario de terceros, firmado y ajeno.

Conclusión: **no queda marca de otro proyecto en nada que PiCode compile, empaquete o
declare**. Lo que queda es la identidad de dependencias de terceros, y eso no se rebrandea.

## Fuera de alcance

- Arquitectura de instancias Pi (interno/externo).
- Release automática por CI a partir de este pipeline.
- Unificar la numeración de versión entre el camino fuente y el ZIP.
