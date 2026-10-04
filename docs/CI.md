# CI y releases en GitHub

## Estado actual: workflows activos (decisión del dueño, 2026-09-28)

Los workflows se eliminaron el 2026-09-27 (consumían minutos y dinero); el
2026-09-28 el dueño pidió volver a tener build y release en GitHub, y rápidos.
La decisión anterior queda **revertida y fechada aquí**.

Hay dos workflows:

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — **CI**: en cada
  push a `master`/`feat/**` y en cada PR (ignorando `.md` y `updates/`),
  compila, ejecuta los tests del conector y sube el editor empaquetado como
  artefacto. `cancel-in-progress` por rama: los pushes seguidos no acumulan runs.
- [`.github/workflows/release.yml`](../.github/workflows/release.yml) —
  **Release**: se dispara con un tag `v*` o a mano (`workflow_dispatch`).
  Construye, crea la release de GitHub con el zip y su SHA-256, genera el feed
  de actualizaciones y lo aterriza en `master`, y verifica el feed en vivo.

## Por qué es rápido

- **Cachés**: `node_modules` + caché de npm (cubierto también el runtime de pi)
  y el binario de electron, con clave por `package-lock.json`. Con árbol
  caliente, `dev/deps-current.mjs` salta `npm ci` entero — es el paso que
  costaba 5-8 min frío.
- **Ruta esbuild**: la compilación del producto usa la ruta de fábrica de
  Microsoft reactivada en `build-veloz` (compilar `src/` en segundos, no
  minutos), con `tsgo` cosido al prepack como control de tipos.
- **Un solo job, 4 núcleos**: el objetivo realista es ~10-15 min caliente y
  por debajo del timeout de 40. En frío (primera vez o lockfile movido) tarda
  más: eso es `npm ci`, no un fallo.

## Las reglas duras que el release enforcing

La guía `picode-release` (skill) documenta el procedimiento y sus reglas. El
workflow las lleva dentro para que no puedan ejecutarse mal:

1. La versión del **editor** vive en `distribution/product-delta.json →
   set.version`; la de **PiCode** (la que nombra la release y muestra el
   updater) en el mismo fichero, `set.picodeVersion`. El tag debe coincidir con
   `v<picodeVersion>`, y `set.version` debe ser estrictamente mayor que el del
   feed anterior.
2. La `picodeVersion` nueva debe ser **estrictamente mayor** que la última
   release publicada (comparación numérica por segmentos, sin el sufijo).
3. El commit del feed se lee del `product.json` **construido**, no de HEAD.
4. El feed se genera **dos veces** con `dev/update-feed.mjs --platform win32
   --arch x64` y `--installed <versión anterior del editor>`, una por destino:
   `--target archive` (zip portable) y `--target user` (el `.exe` del `user-setup` de
   Inno, que es el destino que el producto instalado lleva inyectado). Ambas llevan
   `--picode-version`. **Nunca** se pasa `--force` — si el generador se niega,
   la release se para.
5. Los dos feeds se comprometen en `master` (rama efímera `feed-ship` → push)
   y se verifican contra `raw.githubusercontent.com` hasta verlos en vivo (10
   intentos de 20 s, con bust de la caché CDN), y el resumen del job avisa si
   el repositorio sigue **privado** — el feed solo llega a usuarios con el
   repositorio público.

El zip se hace con 7-Zip excluyendo `data/` (el perfil portable no es
producto). El zip se sube además como artefacto del run para depurar sin
descargar la release.

## Cómo se publica una release

1. Bump de versión en `distribution/product-delta.json`: `set.picodeVersion`
   (el nombre de la release, `0.1.1-beta`) y `set.version` (el número del
   editor, estrictamente mayor que el del feed anterior).
2. Commit, push y tag: `git tag v<picodeVersion> && git push origin master --tags`.
   El workflow hace el resto: release + zip + SHA-256 + feed en `master`.
3. El resumen del run (Actions → Release → summary) lleva la versión, el
   commit, el SHA-256, la URL de la release y del feed, y el aviso de
   visibilidad si procede.

La **vía manual** de la skill `picode-release` sigue válida como reserva
(por ejemplo, si Actions no está disponible); las reglas son las mismas.

## Trampas conocidas del build (siguen vigentes)

- **RAM del runner/máquina**: el empaquetado pide más de 6 GB de heap. En una
  máquina con 8 GB, `NODE_OPTIONS="--max-old-space-size=5632"`; con 16 GB,
  12288 va sobrado. Ubuntu 24.04 además trae `systemd-oomd`, que mata el
  cgroup entero por presión de memoria sin escribir "Killed" — desactivarlo
  antes de compilar (`sudo systemctl stop systemd-oomd`).
- **Descargas de assets de GitHub** durante el build (`js-debug` etc.):
  anónimas se agotan (403 rate limit); con `GITHUB_TOKEN` en el entorno,
  `fetch.ts` se autentica solo.
- **Debian renombra el arch**: los `.deb` se generan bajo `amd64`, no `x64`;
  los `.rpm` bajo `x86_64`.
- **Instaladores en secuencia**: `prepare` y `build` de cada formato son dos
  invocaciones — en paralelo, `build` corre antes de que `prepare` cree el
  directorio (`spawn /bin/sh ENOENT`).
- **npm 11 bloquea install scripts** sin aprobación explícita por
  nombre@versión completos: la etapa `metadata` de `prepare_vscode.sh` escribe
  las aprobaciones de los paquetes nativos de VSCodium.
- **Windows busca Visual Studio en rutas fijas**: si el árbol está en otra
  ruta, `vs2022_install=<ruta>` es el override que honra.
- **`zip` no existe en los runners de Windows**: el zip del release se hace
  con 7-Zip (`7z a -tzip`), preinstalado ahí; el binario de la release local
  sigue la misma regla de excluir `data/`.

## El pin, sin vigilancia automática

El pin de VS Code (`upstream/stable.json`) se mueve a mano (los pasos en
[`howto-build.md`](howto-build.md)). El workflow que lo vigilaba
(`pin-watch.yml`) sigue eliminado; su lógica estaba en el historial de git.
