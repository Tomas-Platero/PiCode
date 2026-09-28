# CI y release en GitHub

**Estado:** en curso · **Rama:** `feat/source-in-repo` · **Abierto:** 2026-09-28

## Intención del dueño

«Sigamos con las mejoras para la build + releases en GitHub. Quiero lo mejor de lo
mejor, dale varias vueltas, no cometas fallos, quiero que sea muy rápida y muy
rápida no son 40 m son 10 m por ejemplo.»

## De dónde parte

- El build **local** ya está en ~3 min 34 s de punta a punta (ficha `build-veloz.md`,
  ruta esbuild). El reto ya no es el build: es la **cadena en GitHub**.
- El 2026-09-27 se eliminaron los workflows (decisión del dueño entonces: consumían
  minutos y dinero). Hoy el dueño pide explícitamente volver a tener build + release
  en GitHub, rápidos. Esa petición revierte la decisión anterior.
- La release se hace hoy **a mano** con la guía `picode-release` (skill), que lleva
  las reglas duras: versión con una sola casa (`distribution/product-delta.json`),
  commit leído del producto construido, feed generado con `dev/update-feed.mjs`
  (nunca `--force`), `--target archive` obligatorio en Windows, feed en `master`.
- Existe un `ci.yml` borrador **sin versionar ni subir** (cachés de node_modules,
  npm-cache y binario de electron). GitHub no tiene ningún workflow registrado.
- El repositorio está **privado** y no hay ninguna release publicada todavía.

## Decisiones (tomadas con los números y reglas ya medidos)

- **La release se automatiza completa** en un workflow (`release.yml`) disparado por
  tag `v*` y por `workflow_dispatch`: construye, empaqueta, calcula el SHA-256,
  crea la release, genera el feed y lo sube a `master`, y verifica el feed en vivo.
  Así la guía de releases deja de poder ejecutarse mal: las reglas duras van dentro.
- **Reglas duras cosidas al workflow**: el tag debe coincidir con la versión del
  delta (una sola casa); si ya hay release previa, la nueva versión debe ser
  estrictamente mayor (regla 5); el commit se lee del `product.json` **construido**
  (regla 4); el feed se genera con `--target archive --platform win32 --arch x64`
  y `--installed` con la última release publicada (primera release: sin la bandera,
  nunca `--force`).
- **Solo Windows (win32-x64) en esta fase.** El feed del updater solo cubre esa
  plataforma y el zip portable es el único artefacto probado de punta a punta.
  Linux sigue siendo ruta local (ficha `picode-build-linux.md`); ampliar la matriz
  queda como siguiente paso cuando el dueño lo pida.
- **Velocidad**: caché de node_modules + npm-cache + binario de electron (el
  borrador ya las traía; `deps-current.mjs` salta `npm ci` con árbol caliente),
  build por esbuild (ya es la ruta por defecto desde `build-veloz`), y
  `cancel-in-progress` por rama. Objetivo realista en runner de 4 núcleos:
  ~10-15 min caliente, por debajo de los 40 del timeout.
- **El zip se hace con 7-Zip** (preinstalado en los runners de Windows): `zip` no
  viene de serie ahí; `Compress-Archive` tiene límites incómodos.
- El borrador de `ci.yml` se corrige en sitio: node fijado por `.nvmrc` (24.18.0,
  no el flotante `24`), ruta real del artefacto (`PiCode-Win32-x64`, con esa
  mayúscula — el borrador decía `win32`), y resumen del job.
- **Aviso de visibilidad**: si el repositorio sigue privado, el feed no llega a los
  usuarios (regla 1 de la guía). El workflow lo comprueba y lo deja escrito en el
  resumen del job; hacerlo público es decisión del dueño, no un paso automático.

## Tareas

| # | Tarea | Estado |
| --- | --- | --- |
| R1 | Validar `dev/update-feed.mjs` en local: primera release (sin `--installed`), rechazo de feed no nuevo sin `--force`, escritura en directorio temporal | ✅Las tres probadas: sin `--installed` escribe en `.scratch/feed-test/`; con `--installed 1.135.1` y versión igual rechaza con exit 1 (sin escribir nada); con `--force` escribe. |
| R2 | `ci.yml`: corregir nodo (`.nvmrc`), ruta del artefacto con su mayúscula real, resumen del job | ✅ Nodo fijado por `.nvmrc` (24.18.0), `path: PiCode-Win32-x64/`, resumen con `if: always()` que nunca rompe un build fallido |
| R3 | `release.yml` nuevo: guardas (tag=versión, versión estrictamente mayor), build, zip 7-Zip, SHA-256, release con notas generadas, feed con `--installed` previo, push del feed a `master`, verificación en vivo, aviso de visibilidad | ✅ Escrito y corregido por revisión: `mv` (no `cp`) antes del checkout del feed y verificación en vivo con tubería curl→node |
| R4 | Validación de sintaxis YAML de ambos workflows y revisión línea a línea contra la guía `picode-release` | ✅ YAML parseado con js-yaml; `bash -n` en los 14 bloques `run:`; guardia de versiones probada con 5 casos; 2 defectos reales hallados y corregidos |
| R5 | Documentación: reescribir `docs/CI.md` (la decisión de «sin CI» queda revertida y fechada) y añadir la vía automática a la skill `picode-release` | ✅ `docs/CI.md` reescrita (por qué es rápido, reglas que enforce el release, cómo publicar, trampas vigentes); skill con «The automated path» y la manual como reserva |
| R6 | Commits de unidad de trabajo (workflows, docs, ficha) | ✅ En curso |

## Registro

- 2026-09-28 · ficha abierta; leídos `build.sh`, `update-feed.mjs`, `deps-current.mjs`,
  `pi-runtime.sh`, el borrador de `ci.yml`, `docs/CI.md` y la skill de releases.
  Estado de GitHub verificado por API: repo privado, sin releases, sin workflows.
- 2026-09-28 · R1 ejecutada en local.
- 2026-09-28 · R2/R3 escritas por el delegado y R4 corregidas en la revisión:
  dos defectos reales en el borrador del release.yml (la verificación del feed
  guardaba la respuesta pero node leía stdin vacío — nunca habría tenido éxito;
  y el aterrizaje del feed copiaba en vez de mover el fichero, lo que habría
  roto la segunda release con un conflicto de checkout). Ambos corregidos y
  revalidados (js-yaml + `bash -n` en los 14 bloques + 5 casos de la guardia).
- 2026-09-28 · R5 terminada: `docs/CI.md` reescrita y skill actualizada.
