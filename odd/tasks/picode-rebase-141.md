# Feature: rebasar la base a VS Code 1.141.0

**Estado:** **cerrada sin rebase** — decisión del 2026-10-08: solo el número · **Rama:** `experimental` · **Abierta:** 2026-10-08

---

## Decisión final (2026-10-08, la que manda)

> «NO estamos trabajando en un fork ya, es nuestro código»
> «QUIERO QUE NUESTRO PRODUCTO NO CAMBIE SOLO QUERIA CAMBIAR UN NUMERO»

**La base NO se rebasa.** El código es nuestro, no un fork: el árbol no se sustituye por el de
upstream y **no entra nada de su refactor**. Lo único que se cambia es **el número que leen las
extensiones** (`engines.vscode`), para que un editor retrasado no quede fuera del catálogo.

Se hizo en **un solo valor**: `distribution/product-delta.json` → `set.version = "1.141.0"`.
`dev/build.sh` lo escribe en `picode-source/product.json` (que es lo que `productService.version`
reporta, y por tanto lo que el portero `isEngineValid` compara) y en `picode-source/package.json`.

**Qué NO se tocó:** ni una línea de nuestro producto. Se comprueba con `git diff -w`: tres líneas
(el valor del delta y sus dos copias). `upstream/stable.json` dice la verdad y sigue en 1.135.0:
de ahí desciende el árbol de verdad, aunque el número declarado sea otro. Esa distancia es
deliberada y está dicha aquí a propósito.

**El precio, medido (y mucho menor de lo que se supuso primero):** se temía que una extensión que
llamase a una función añadida entre las 1.136 y las 1.141 se instalara y fallara al usarla. Medido
contra el clon, **ese riesgo es casi nulo**:

| Qué | 1.135.0 → 1.141.0 |
| --- | --- |
| **API pública estable** (`src/vscode-dts/vscode.d.ts`) | **Cero cambios funcionales** — las 6 líneas del diff son comentarios |
| Implementación del API (`src/vs/workbench/api/common/extHost.api.impl.ts`) | 5 líneas |
| Propuestas nuevas | 2: `agentsWindowActivation`, `authSessionExpiration` |
| Propuestas tocadas | 14 ficheros, +132 líneas |

La superficie estable es **la misma**, así que ningún miembro estable puede faltar. Y las propuestas
no son alcanzables por una extensión ajena: el editor tiene que habilitarlas en
`product.json` (`extensionEnabledApiProposals`, 53 entradas, todas de extensiones conocidas).

**El precio real, por tanto, es comportamiento y no superficie:** se dejan fuera sus arreglos
internos (entre ellos ~30 de fugas de memoria) y su maquinaria interna. La compatibilidad de
extensiones, que era el motivo del cambio, se mantiene.

### Lo que se midió y quedó aparcado

Se montó la juntanza entera en un clon desechable (`.scratch/merge-work`, rama `picode-base`,
delta en `7115434a6de`, merge de `2a59476c` en `b73c95589b0` + `4c7faa3a688` + `4624d0235dd`) y se
midió el coste real de rebasar: **1 785 errores de tipos** (1 046 en pruebas suyas y **739 en
código del producto, en 197 ficheros**), todos nacidos de las costuras entre su forma nueva y la
nuestra. Ese clon queda **aparcado y sin aplicar**: no entra al repositorio. Si algún día se quiere
la 1.141 de verdad (sus fugas de memoria, sus APIs nuevas), el trabajo ya está empezado ahí y este
papel es el punto de partida.

### Dos lecciones técnicas de aquel intento

- **`git merge -X ours` no deja el fichero nuestro**: cose trozos, y en 3 ficheros dejó las llaves
descuadradas. Un fichero en conflicto hay que tomarlo **entero**, no por trozos.
- **La poda del fork no se deriva de «carpetas sin ficheros»**: `.agents` solo tiene subcarpetas,
así que esa regla no la veía y por ahí volvieron 207 ficheros. La regla buena es la **clausura de
ancestros** de las rutas del árbol.

---

## El plan original (se conserva como registro)

## Intención del dueño

> «cuando vscode saque una actualización deberíamos rebasar la base a esa versión también no?,
> vale me parece correcto. Pues empieza todo esto.»

La política queda fijada: **rebasar la base con cada versión de upstream** (o al menos cada
2-3, antes si una extensión clave exige la nueva). La 1.141.0 es la primera de esta política.

## Por qué ahora

1. **Las extensiones cierran la puerta gradualmente**: cada autor que sube el mínimo de su
   extensión a una base más nueva deja fuera a un editor retrasado. No es un corte, es una
   pendiente — y 1.135 ya tiene meses.
2. **Las funciones de agente que adoptamos de la 1.141** (píldora de estado, rejilla de
   sesiones, sandbox) viven en código del núcleo que en 1.141 ya trae piezas: montarlas sobre
   1.135 es trabajo doble.
3. Los ~30 arreglos de fugas de memoria de upstream vienen con el merge, sin trabajo extra.

## El procedimiento (docs/howto-build.md, medido hoy)

El árbol es **fuente propia comiteada**: la importación fue aplastada (commit `c4dcc8cb`), no
hay historial de VS Code dentro, y la maquinaria de parches se borró (2026-09-27). Por eso la
juntanza se hace en **un clon desechable con historial**, y el resultado entra aquí como un
commit normal. Pasos, con su estado:

1. **[hecho]** Clon parcial de `microsoft/vscode` (`.scratch/merge-work`, `--filter=blob:none`),
   checkout del tag **1.135.0** (`08d4889f`, el mismo que `upstream/stable.json` registra) y
   rama `picode-base`.
2. **[en curso]** Materializar **nuestro delta**: sobre `picode-base`, sustituir el árbol por
   `picode-source/` (excluidos `node_modules`, `out*`, artefactos de build) y commitear. Ese
   commit **es** la suma de: el conjunto de parches de VSCodium vendorizado + todos los cambios
   de producto de PiCode — contra el 1.135.0 vanilla.
3. **[pendiente]** `git merge 1.141.0` (tag `2a59476c`): los conflictos, uno a uno. **Medir
   primero** (`--name-only --diff-filter=U`): seis meses de upstream sobre un árbol muy
   tocado — la resolución es la obra gruesa.
4. **[pendiente]** Traer el árbol fusionado sobre `picode-source/` (sin `node_modules` ni
   `out*`), commitear, y actualizar la procedencia: `upstream/stable.json` (tag/commit 1.141.0)
   y re-vendorizar `patches/vscodium/**` + `dev/vscodium-product.json` desde la revisión de
   VSCodium correspondiente.
5. **[pendiente]** `./dev/build.sh -o` → build completa → arranque verificado. Y guardar el
   historial fusionado como bundle para la próxima (`.scratch/picode-source-history.bundle`),
   que es el prerequisito que **no existía** y obligó a montar el clon a mano.

## Lo que la juntanza no debe romper (checklist post-merge)

- El identity check del build (`-o`): delta de producto aplicado limpio.
- El conector compila (`dev/build-connector.sh`) y su suite en verde.
- El typecheck del núcleo en 0.
- Las cadenas de Copilot barridas (el merge trae superficie nueva de upstream que puede
  volver a nombrarlo — la poda del delta es la que manda).
- Las funciones del producto en el núcleo: píldora de estado, página de MCP, providers con
  filas de perfil, ajustes propios — presentes tras el merge (upstream puede mover los
  ficheros que tocamos).
- El pin de pi (`distribution/runtime.json`) no se toca en este merge.

## Relación con los canales

El rebaso va **antes** de congelar los canales: RC/Beta/Experimental se cortan todos de la
base nueva, y el número que casan las extensiones (`1.141.x`) viaja a los tres con el diseño
de `picode-canales.md`. La trampa del sufijo por calidad (C2, ya resuelta) se comprueba de
nuevo tras el merge, porque el fichero que la llevaba es de upstream y viene cambiado.
