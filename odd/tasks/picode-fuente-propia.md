# Feature: la fuente es de PiCode; el build deja de descargar y de parchear

## Goal

Convertir `./picode-source` en **la fuente propia de PiCode**: un árbol que ya lleva
el juego de parches de VSCodium, los cambios propios y la identidad de producto,
**registrado en su historial**. A partir de ahí:

- el build **no descarga** nada de VS Code ni **aplica parches**;
- las dependencias se instalan **una sola vez**;
- quien colabora **trabaja directamente sobre el código**, sin recetas intermedias.

## Por qué existe esta feature

*"Del 1 al 6 no podemos hacer que solo lo hagamos una vez? quiero decir, que el repo ya tenga
todo esto incluido. [...] quiero trabajar sin meter patches, quiero trabajar directamente
desde un codigo fuente."* — el dueño, 2026-09-27.

El coste medido de la cadena anterior, y por qué no bastaba con optimizarla:

| Fase | Qué hacía | Coste real |
| --- | --- | --- |
| 1 | clonar VS Code en el pin | minutos (red) |
| 2-5 | marca, 69 parches heredados, 22 propios, delta de producto | segundos |
| 6 | `npm ci` — 1,7 GB | minutos |
| 7 | compilar y empaquetar | **horas** (techo de CI: 210 min en Windows) |
| 8 | pi y capa de distribución | minutos |

Las fases 1-5 son el *cómo*, no el *qué*: se repetían para reconstruir siempre el mismo
árbol. Ahora el árbol **es** el resultado y se guarda.

## Decisión

1. **El árbol se guardó, y acabó en este repositorio.** Primero como commit en el git que había
   dentro de `picode-source` (el borrado de 5.053 ficheros, 327 modificaciones y 40 altas que
   eran los parches) y, el mismo día por decisión del dueño (*"un único repositorio, lo clonas
   y ya está todo"*), importado aquí: commit `396b3d7`, 13.125 ficheros, la lista exacta que
   versionaba el git anidado. El historial anidado se guardó en
   `.scratch/picode-source-history.bundle` y el `.git` anidado se aparcó en
   `.scratch/picode-source-git-removed`.
2. **Los parches dejan de gobernar.** `patches/**` se conserva como registro de cómo se hizo
   cada cambio, pero el build ya no lo lee. Editar el código es editar el código.
3. **El build se queda en cinco fases**: prepare (el árbol, la identidad y las dependencias en una
   sola), compilar el conector, compilar el editor, empaquetar y rematar.
4. **Nada se toca en `origin`.** Todo el trabajo es local.
5. **`dev/get_repo.sh`, `dev/prepare_vscode.sh`, `dev/patch.sh`, `dev/update_patches.sh` y
   `dev/version.sh` no se borran**: quedan como el camino de recuperación y como registro.
   El build no los llama.
6. **Sin `jq`.** El build ya no lee ni escribe JSON con `jq`; lo hace con `node`. Las
   dependencias del build bajan a `git`, `node` y las del primer `npm ci`.

## Qué cambia, fichero a fichero

| Fichero | Cambio |
| --- | --- |
| `picode-source` (historial) | un commit con el árbol preparado completo |
| `dev/build.sh` | las fases 1-5 antiguas (descarga y parcheo) sustituidas por una sola fase **prepare**: comprobar la fuente, poner la identidad e instalar solo si hace falta |
| `dev/deps-current.mjs` | nuevo: decide si las dependencias siguen valiendo (sustituye al filtro `jq`) |
| `dev/build-progress.mjs` | marcadores y textos de las fases nuevas |
| `.vscode/tasks.json` | la tarea de preparación pasa a ser de comprobación |
| `CONTRIBUTING.md`, `dev/README.md`, `docs/howto-build.md`, `docs/CI.md` | dejan de describir descarga y parcheo |

## El precio, dicho claro

**Actualizar VS Code deja de ser "reaplicar parches" y pasa a ser "juntar dos versiones".**
Git trae la versión nueva, la pone encima de los cambios y marca los conflictos uno a uno.
Es trabajo real cada vez, pero es trabajo *visible*: antes un parche que no encajaba paraba
el build sin decir dónde.

Detalle técnico que eso arrastra: hoy el árbol se descargó **superficialmente** (un solo
commit, sin historial). Para poder juntar versiones hay que traer historial **una vez**
(`git fetch --deepen` o `--unshallow`). No se ha hecho aquí: no hace falta para compilar, y
es una descarga que el dueño debe decidir cuándo pagar.

## Fuera de alcance, registrado a propósito

- **El árbol no está versionado en el repo de PiCode**, sigue en `.gitignore`. Meter 293 MB
  y 13.125 ficheros en el historial de PiCode tiene consecuencias sobre `origin` y sobre
  quien clone el repo; es una decisión del dueño, no un efecto colateral de esta.
- **La velocidad de la fase de compilar y empaquetar** (el problema de las horas) es la
  siguiente feature. Aquí solo se elimina el trabajo repetido de las fases 1-6.
- **`dev/build-requirements.mjs`** (la lista de dependencias de la ventana del colaborador)
  sigue nombrando `jq`, que ya no hace falta. Se deja como está para no mezclar.

## Verificación

- [x] `bash -n dev/build.sh` y el análisis estático de todo lo tocado, limpios. `node --check` de `dev/deps-current.mjs`.
- [x] `./dev/build.sh -o` sale **0** en segundos, sin instalar ni compilar, e imprime la comprobación de identidad.
- [x] Ninguna ruta del build llama a `get_repo.sh`, `prepare_vscode.sh` ni lee `patches/**` (grep sobre `dev/build.sh`).
- [x] El árbol pasa su propia comprobación: producto, compañía, icono de Windows, manifiesto del servidor y conector.
- [x] La ruta de dependencias reutiliza sin instalar: `dev/deps-current.mjs` responde que el estado cuadra (node 24.19.0).
- [x] `-o` **no ensucia el árbol**: `git status` en `picode-source` sigue en 0 tras ejecutarlo (el delta es idempotente: *write skipped*).
- [x] `BUILD_SOURCEVERSION` sale idéntico al algoritmo anterior (`8ab4297d…` = `echo "1.135.1" | sha1sum`), así que el sello del producto no cambia.
- [x] `-f` es un error duro (sale 2) con la explicación; `-s` se acepta con un aviso; una opción desconocida sale 2.
- [x] `jq` no lo usa ningún script del camino del build (`build.sh`, `build-connector.sh`, `pi-runtime.sh`, `stage-distribution.sh`).
- [ ] **No medido: la compilación y el empaquetado completos.** Tardan horas y no se han ejecutado. El primer build real es quien lo confirma.

## Commits (rama `feat/source-in-repo`, local — `origin` no se toca)

- `d56d0a4` · `build: the pipeline stops fetching and patching` — la reescritura del build,
  los scripts y la documentación de la primera entrega.
- `396b3d7` · `source: picode-source is now versioned in this repository` — la importación:
  13.125 ficheros exactos, `.gitignore` corregido (la trampa `PiCode-*` que se comía
  `picode-source/` por insensibilidad a mayúsculas, y `.vscode`/`legacy` sin anclar), y el
  bundle de procedencia fuera del árbol.
- Queda sin commitear en esta entrega: los textos de documentación que cambian de «su propio
  git» a «este repositorio» — se commitean a continuación.

---

## Registro

- 2026-09-27 · pedido por el dueño (*"quiero trabajar sin meter patches, quiero trabajar
directamente desde un codigo fuente"*), medido, implementado y verificado hasta donde llega sin
compilar.
- 2026-09-27 · a petición del dueño, las tres primeras fases (árbol, identidad y dependencias) se
unificaron en una sola (`prepare`): son la misma faena, dejar el árbol listo para compilar. El
build pasa de 7 fases a 5. `-o` sigue parando antes de instalar nada, así que sigue siendo la
comprobación de segundos.
