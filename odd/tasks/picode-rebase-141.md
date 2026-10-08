# Feature: rebasar la base a VS Code 1.141.0

**Estado:** aparato montado, juntanza empezada · **Rama:** `experimental` · **Abierta:** 2026-10-08

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
