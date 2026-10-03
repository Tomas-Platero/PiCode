# Feature: la versión de PiCode, aparte de la de VS Code

## Goal

> «la versión de este proyecto y de este software debería ser 0.1.0 beta hasta que yo diga lo
> contrario y cada release subirá el minor (0.x)»
>
> «vale el product-delta debería ir acorde con la última versión siempre de vscode entonces no?»
> «revisa bien la ultima versión estable de vscode (no codium) vscode»

Dos números, porque hacen dos trabajos distintos:

- **`set.version`** — el número del **editor**. Sigue siempre a VS Code: base de upstream más el parche
  de PiCode (hoy `1.135.1` sobre la base `1.135.0`).
- **`set.picodeVersion`** — el número de **PiCode**. Es el que da nombre a la release y el que sube por
  el minor en cada una (`0.1.0-beta`, `0.2.0`, `0.3.0`…).

## Por qué no pueden ser el mismo número (comprobado en la fuente)

`extensionValidator.ts:340` valida el `engines.vscode` de cada extensión contra la **versión del
producto** (`isVersionValid(productVersion, …, extensionManifest.engines.vscode)`). Si ese número
pasara a `0.1.0`, el editor **rechazaría instalar cualquier extensión que pida `^1.x`** — todas,
incluidas las de la galería de temas. Y el actualizador compara la versión del feed contra ese mismo
número, así que las dos cosas van atadas al mismo valor.

De ahí el reparto: el número del editor se queda con forma de VS Code (compatible), y el que se
anuncia es el de PiCode. VSCodium y Cursor hacen lo mismo.

## Lo medido antes de tocar nada

| Dato | Valor | De dónde |
| --- | --- | --- |
| Última estable de **VS Code** | **1.140.0** | `update.code.visualstudio.com/api/releases/stable` (Microsoft, no VSCodium) |
| Base sobre la que está construido el repositorio | **1.135.0** | `upstream/stable.json` (commit `08d4889f`) |
| Lo que declara el delta | **1.135.1** | base + parche de PiCode |
| Quién lee `set.version` | la build (`APP_VERSION`) y el paso de identidad del release | `dev/build.sh:225`, `release.yml` |
| ¿Admite el delta claves nuevas? | **Sí** | `apply-product-delta.mjs`: `set` no tiene lista blanca y las claves nuevas se añaden al final |
| Releases publicadas | **ninguna** | `github_list_releases` → vacío: la guarda del release no bloquea nada hoy |

## Decisión

- `set.picodeVersion` = `0.1.0-beta` (y el minor en cada release).
- El **tag** y el **título** de la release usan la versión de PiCode; el nombre del ZIP también.
- El **feed** sigue llevando la versión del **editor**: es la que el actualizador compara contra el
  producto instalado. Por eso cada release **también** mueve `set.version` (el parche, o la base
  cuando upstream se mueva). Una guarda nueva lo exige y falla antes de publicar nada.
- La guarda de "estrictamente más nueva" compara versiones de PiCode, ignorando el sufijo
  (`0.2.0-beta` compara como `0.2.0`).

## Tareas

- [x] Declarar la versión de PiCode en el delta y partir el release en dos números, con las dos
      guardas y la verificación de la lógica de comparación en seco.
- [ ] **Subir la base a la última estable de VS Code (1.140.0).** Es un trabajo de otro tamaño:
      traer el árbol de upstream y reconciliar lo nuestro, con la build como juez. Cinco versiones
      por detrás (1.136.0 → 1.140.0).
- [x] **Enseñar la versión en la interfaz**: el diálogo de actualización muestra ahora
      `productService.picodeVersion` en «Current Version» y `update.picodeVersion` en «Latest»
      (`updateTooltip.ts`), con retroceso a `productVersion` cuando el feed no lo trae.
- [x] Actualizar la skill `picode-release` y `docs/CI.md` con la regla de los dos números.
- [x] **El feed lleva `picodeVersion`.** `dev/update-feed.mjs` acepta `--picode-version`; el
      workflow lo pasa y publica **dos** feeds por release: `archive` (zip portable) y `system`
      (el `.exe` de Inno, que es el destino que resuelve una instalación sin `target`). Sin el
      segundo, la instalación pedía `.../system/latest.json` y el updater decía
      «Server returned 404».

## 2026-10-03 — lo que se hizo al publicar 0.1.1-beta

- `set.version` sube a `1.135.3` (el feed anterior era `1.135.2`) y `set.picodeVersion` a
  `0.1.1-beta`.
- El updater ya no «apunta a la versión de VS Code»: la comparación sigue siendo el número del
  editor (`productVersion`), pero lo que el dueño lee —versión actual y versión nueva— es la de
  PiCode.
- La release escribe los dos feeds, así que la instalación de Inno deja de dar 404.

## Fuera de alcance

- Fijar las acciones de GitHub a un commit exacto en vez de a una etiqueta (lo pide el linter; es una
  decisión de mantenimiento, no de versiones).
