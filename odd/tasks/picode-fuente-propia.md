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
2. **Los parches dejan de gobernar.** **El 2026-09-27, por decisión del dueño, se borraron
todos**: `patches/**`, `dev/get_repo.sh`, `dev/prepare_vscode.sh`, `dev/patch.sh`,
`dev/update_patches.sh`, `dev/version.sh`, `dev/utils.sh`, `dev/vscodium-product.json`,
`upstream/vscodium.json` y `dev/ci/pin-check.sh`. Lo que eran los parches es ahora código en
`picode-source/`. La procedencia queda en `upstream/stable.json` (commit público de VS Code)
y, en esta máquina, en el bundle del historial pre-importación.
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
- 2026-09-27 · **borrado el aparato de parches** («pues si no necesitamos patches, bórralos»):
  10 rutas (98 ficheros solo en `patches/`) + las 3 funciones de `utils.sh` que el rematado aún
  usaba, ahora dentro de `stage-distribution.sh`. `jq` fuera también de la lista de requisitos.
  Comprobado tras el borrado: `-o` ✓, `bash -n` en todos los guiones ✓, y el rematado vuelve a
  correr idempotente sobre el pack real ✓ (17 s, 7 pasos, «staging complete»).
- 2026-09-27 · **revisión de carpetas** («¿las necesitamos todas?»): se conservan todas las
  versionadas. Dos hallazgos: `extensions/picode-pi-chat` **no es basura** (el núcleo solo tiene
  1 fichero de la migración; el chat sigue viviendo ahí) y `updates/` es el mecanismo vivo de
  entrega de actualizaciones. Borrados por decisión explícita del dueño, previa advertencia de
  irreversibilidad (no estaban en git): `data/` de la raiz (48 MB, perfil del editor suelto, en
  desuso desde el 21-09) y `legacy/` (5,8 MB, snapshot del panel aún más viejo).
  Arreglados de paso: `updates/README.md` citaba un parche borrado; `README.md`, `CHANGELOG.md`
  y el wiki contaban el mundo de los parches como presente.
- **Hueco declarado** (registrado para que no sorprenda; **corregido dos veces el 27-09 por
  culpa de dos ledgers rancios — el dueño: «a ver si hablas con propiedad»**): el chat que
  quiere el dueño es el **chat agéntico nativo ya modificado**, y ESTÁ en el build: 21
  ficheros del chat tocados (+138/−101) y el conector integrado `picode` (5.360 líneas en
  24 ficheros: proveedor de modelos —los modelos de pi salen en el selector—, participante
  @pi, herramientas MCP, localización y pilotaje de pi, asistente, importación de perfil,
  temas). Lo que NO está verificado es el **comportamiento en vivo**: nadie ha abierto aún la
  ventana del chat del editor empaquetado y ha visto responder a pi. Frases anteriores,
  ambas falsas: «el editor no trae chat» y «el conector es un cascarón vacío a propósito».
- 2026-09-27 · **borrada la carpeta `extensions/` del panel** («pues borrala», tras advertir
  que era el único material de migración y que el chat habría que reconstruirlo o sacarlo del
  historial): 119 ficheros versionados → recuperables por git; copia de comodidad en
  `.scratch/picode-pi-chat-ultima-copia.tar.gz`; los dos SVG de marca (rosa de la barra y
  marca de agua) rescatados a `picode-source/.../contrib/picode/browser/media/` y anotado en
  `AGENTS.md` siguiendo su propia regla. Comprobado antes de borrar: ni el núcleo, ni
  `product.json`, ni el delta, ni `apply-picode.ps1`, ni el pin de runtime referencian ya el
  panel — el paso de escenificarlo salió del script el 24-09 y solo los papeles lo seguían
  afirmando (`docs/DISTRIBUTION.md`, `distribution/README`), corregidos.
