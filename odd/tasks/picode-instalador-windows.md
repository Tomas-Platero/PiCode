# Instalador de Windows, y el release que no llegaba a publicar

**Estado:** cerrada (instalador y zip publicados) · **Rama:** `master` · **Abierta:** 2026-10-03

## Intención del dueño

> «Arregles build que falló y salgan zip comprimido, y instalador para windows»
>
> «Ah si darle estilo al instalador con logo y esas cosas estaría genial»

## Por qué fallaba el release (cinco defectos, en cadena)

El `Build` se caía, y cada arreglo destapaba el siguiente. Ninguno era del código de la aplicación:

1. **La caché de dependencias mentía.** `dev/deps-current.mjs` decidía «ya está instalado» mirando solo
   los hashes de `package.json`/`package-lock.json`. Actions restaura el `node_modules` de la raíz
   (que lleva el fichero de estado) pero **no** los `node_modules` anidados (`build/`, `extensions/*`).
   En un acierto de caché el build decía «al día» y luego moría en `gulp-merge-json`, importado desde
   `build/lib/gulp/facade.ts`. Arreglo: si falta el `node_modules` de un subproyecto, se instala.
2. **La descarga de ripgrep iba sin credencial.** Al volver a instalarse de verdad, `npm ci` fallaba
   con 403: `@vscode/ripgrep` pide su release a `api.github.com` y, sin token, choca con el límite de
   peticiones sin autenticar. Arreglo: los dos workflows pasan `secrets.GITHUB_TOKEN` al paso `Build`
   (el postinstall ya lee `process.env.GITHUB_TOKEN`).
3. **El zip subía con el nombre equivocado.** Se crea como `PiCode-win32-x64-${PICODE_VERSION}.zip`
   (la versión propia de PiCode, `0.1.0-beta`) y el paso de subida buscaba `…-${VERSION}.zip` (la del
   editor, `1.135.1`). El release se publicaba y acto seguido el job fallaba con *«No files were
   found»*. El resumen imprimía el mismo número equivocado y apuntaba al tag equivocado.
4. **La URL del feed salía rota.** Se construía con un `\` de continuación dentro de comillas dobles,
   que en bash une las líneas pero **se queda con la indentación de la siguiente**: el
   `latest.json` publicado llevaba `PiCode  /releases/download/…`, con dos espacios. Ningún
   actualizador puede descargar eso. Arreglo: una sola línea, sin continuación.
5. **La versión no se podía escribir nunca.** La fase 1 del build reescribe el `version` de
   `picode-source/package.json` desde el delta, con un patrón que exigía **tabulador** delante de
   `"version"`. El fichero indenta con **cuatro espacios**: mientras el número no cambiaba decía
   «already reports», y la primera vez que cambiaba de verdad fallaba con *«has no version line this
   script can rewrite»*. Por eso el árbol llevaba clavado en `1.135.1` y por eso el release —que
   rechaza una versión del editor que no crezca— no podía salir.

`set.version` sube a **1.135.2** por ese mismo motivo: el feed ya ofrecía `1.135.1` y una release con
la misma versión no la recibe nadie.

## El instalador

`build/win32/code.iss` y la tarea de Inno (`build/gulpfile.vscode.win32.ts`) llevaban en el árbol sin
usarse — el propio `dev/build.sh` decía *«PiCode builds no installer»*. Ahora:

- **`dev/build-installer.sh`** lanza la tarea desde el árbol ya empaquetado y deja
  `PiCode-win32-x64-<versión>-setup.exe` en la raíz. `dev/build.sh` lo llama al final de la fase 5,
  así que `dev/build.sh` —lo que corre una persona y lo que corre el release— produce todos los
  artefactos de una release. En otro sistema el script lo dice y sigue.
- **Instalación por usuario** (`user`, `PrivilegesRequired=lowest`): no pide administrador y no escribe
  fuera del perfil.
- **Marca:** `PiCodeSetup.exe`, editor `PiCode`, enlaces al repo (antes: `VSCodeSetup.exe`, *Microsoft
  Corporation*, `code.visualstudio.com`). El icono ya era el de PiCode.
- **Imágenes del asistente:** las que traía eran el logo azul de VS Code sobre blanco. Las dibuja
  `dev/make-inno-images.mjs` desde el dibujo de marca que ya existía
  (`resources/win32/code_150x150.png`, el mismo del mosaico del menú Inicio): el panel lateral sobre
  un fondo PiCode en los siete tamaños de la escalera, y el cuadrado de la esquina en 150x150. Sin
  librerías de imagen y sin rasterizador: node puro, la misma promesa que `dev/ico-to-png.mjs` hace
  para el icono de Linux. Son **BMP y no PNG**, y eso no es un gusto: el motivo está en el defecto de
  abajo. Los 14 BMP de VS Code se han borrado.
- **Licencia:** el `.iss` exigía `LICENSE.rtf` o `LICENSE.txt` en el árbol fuente, y ahí no hay
  ninguno: la compilación abortaba. La página de licencia se omite cuando el fichero no está, en vez
  de inventar contenido legal.
- **`data/` se excluye.** Es el perfil portable (ajustes, extensiones, estado del agente): 1,7 GB en
  un árbol de desarrollo. El zip ya lo excluía; el `.iss` no, así que el instalador se estaba
  empaquetando el perfil de quien compilaba.

## El asistente que no arrancaba: «Bitmap image is not valid.»

El instalador publicado se abría y moría con ese cuadro **antes de enseñar la primera página**. Eran
dos defectos distintos, los dos en las imágenes del asistente, y ninguno en el `.iss` más allá de qué
ficheros nombra:

1. **Inno Setup 6.4.1 no lee PNG en las imágenes del asistente.** Es la versión que trae el paquete
   `innosetup` con el que compila el build (lo dice su propio `whatsnew.htm`, que no menciona PNG en
   ninguna versión). Un PNG **compila** sin una queja y revienta al arrancar: `Setup.MainFunc.pas`
   pregunta por la firma PNG, no la encuentra, cae al lector de mapas de bits, y ese responde —con
   razón— que un PNG no es un BMP. Medido: los tres PNG probados (los dos del repo y uno generado por
   .NET, que no se puede culpar) fallan igual.
2. **Los BMP hechos a mano no eran BMP válidos.** El primer intento de arreglo convirtió los PNG a
   BMP con un escritor ad hoc, y su cabecera salía **dos bytes corrida**: `biPlanes` y `biBitCount`
   empezaban en el octavo byte del bloque en vez del sexto, así que Windows leía `biPlanes=0`,
   `biBitCount=1` («monocromo») y `biCompression=24`. Compilaba igual y moría igual. Comparado byte a
   byte con un BMP de .NET que sí funcionaba, la diferencia estaba entera en esos dos
   desplazamientos.

El arreglo es uno: **`dev/make-inno-images.mjs` escribe BMP** —24 bits, cabecera de 40 bytes campo a
campo, filas de abajo arriba y relleno a cuatro bytes—, y `code.iss` nombra `inno-big-*.bmp` e
`inno-small.bmp`. El pequeño deja de ser `code_150x150.png` y pasa a ser el mismo panel en 150x150,
hecho del mismo dibujo: la marca se dibuja una vez y el asistente la reutiliza en los dos sitios.

Cómo se comprobó, en lugar de suponerlo: se montó un banco de `.iss` mínimos en `.scratch/innotest` y
se arrancó cada instalador compilado **leyendo el título de su ventana** —`Setup - PiCode version 1.0`
es que el asistente abrió, `Error` es el cuadro de marras—. Con eso quedó aislado cada factor por
separado (formato, tamaño, cabecera y contenido) y se descartaron los que no eran: el tamaño no
importa (Inno estira), mezclar una imagen de fichero con una de recurso tampoco, y el contenido de
los píxeles tampoco.

## Verificación

- Build local desde cero (sin `node_modules` ni salidas): compila, empaqueta, monta y genera el
  instalador. `PiCode-win32-x64-0.1.0-beta-setup.exe`, 179 MB, cabecera `MZ` (PE válido).
- Release `v0.1.0-beta` publicado con **los dos** assets:
  `…-0.1.0-beta-setup.exe` (172,5 MB) y `…-0.1.0-beta.zip` (259,8 MB).
- Feed en master limpio: `productVersion 1.135.2` y URL sin espacios, que responde `200`.
- CI en verde sobre `770c5e21`.
- **El asistente abre** con las imágenes nuevas: un instalador compilado con la configuración real
  del `.iss` (las siete medidas del panel más el cuadrado) muestra `Setup - PiCode version 1.0` en vez
  del cuadro «Bitmap image is not valid». Comprobado por el título de la ventana, dos veces.
- Los ocho BMP llevan cabecera válida, medida campo a campo: `BM`, `bfOffBits=54`, `biPlanes=1`,
  `biBitCount=24`, `biCompression=0`, `biSizeImage` igual al relleno calculado y tamaño de fichero
  igual a `54 + biSizeImage`.

## Lo que queda

- **El instalador no está firmado**, así que Windows mostrará el aviso de SmartScreen («Editor
  desconocido»). Firmarlo necesita un certificado de firma de código; es una decisión aparte.
- El instalador solo se publica para **x64**; `arm64` tiene tarea de Inno y no se está generando.
- Solo se construye el flavour **por usuario**. El `system` (por máquina, con administrador) existe
  como tarea y no se ha conectado.
