# Lightweight: recorte de `picode-source/`

**Objetivo (dueño, 2026-09-29):** reducir el árbol fuente de PiCode (~3.3G en disco). Producto
ligero: editor para programar con look VS Code + capa agéntica (pi + Gentle AI). Nada de
notebooks, login Microsoft/GitHub ni diagramas mermaid.

**Estado inicial medido (2026-09-29):**

- Total en disco: **3.3G**.
- ~2.95G es **regenerable e ignorado por git** (`node_modules` de extensions/remote/build/web,
  más `.build/` de staging). Vuelve con `npm install` / compilación.
- Código fuente versionado: **~300M**.
- El empaquetador copia **todo** lo que hay en `extensions/` (`.build/extensions`, 163M
  compilados). No existe lista de exclusión: quitar carpeta = quitar del producto.

## Criterios de recorte

1. **Fuera del alcance del producto** (tests internos de VS Code, features que PiCode no usa).
2. **Peso desproporcionado** frente al valor (mermaid: 343M de deps, 59M en el producto).
3. Sin romper el build ni el núcleo: referencias de build actualizadas en el mismo cambio.

## Extensiones eliminadas (10 carpetas)

| Carpeta | Motivo | Peso source | Peso en producto |
|---|---|---|---|
| `vscode-api-tests` | Solo tests internos de VS Code | 5.8M | no se empaqueta |
| `vscode-colorize-tests` | Solo tests | 3.1M | no se empaqueta |
| `vscode-colorize-perf-tests` | Solo tests | 3.1M | no se empaqueta |
| `vscode-test-resolver` | Solo tests (extension host de test) | 2.8M | no se empaqueta |
| `mermaid-markdown-features` | Diagramas mermaid en preview markdown | 343M | **59M** |
| `ipynb` | Soporte notebooks Jupyter | 4.6M | 0.8M |
| `notebook-renderers` | Render de celdas notebook | 26M | ~0.5M |
| `microsoft-authentication` | Login cuenta Microsoft | 148M | 3.9M |
| `github-authentication` | Login GitHub | 106M | 2.6M |
| `github` | Publicar a GitHub / features GitHub | 148M | 2.8M |

**Degradaciones aceptadas (decisión del dueño: cada KB cuenta):**

- Bloques mermaid en markdown/chat se muestran como código, sin diagrama.
- `.ipynb` ya no renderiza celdas (el núcleo notebook queda, pero sin renderers).
- No hay login con cuenta Microsoft ni GitHub (PiCode usa su propia nube; no hay sync nativo).

**Se conservan** (código pequeño, valor alto para programar): colorizadores de todos los
lenguajes, `git`, `typescript-language-features`, `json/html/css-language-features`,
`markdown-language-features` + `markdown-math` (preview md sin mermaid), `emmet`, `npm`,
`merge-conflict`, `media-preview`, `simple-browser`, `references-view`, `search-result`,
`terminal-suggest`, `configuration-editing`, `extension-editing`, `debug-*`,
`tunnel-forwarding`, `theme-*` (onboarding), `picode` (conector, obligatorio).

## Cambios de build asociados

- `build/gulpfile.extensions.ts`: quitar de la lista `compilations` las 6 entradas que
  compilaban carpetas eliminadas (las carpetas de tests nunca estuvieron en la lista).
- `build/filters.ts`: limpiar globs negativos de mermaid/ipynb/notebook-renderers (muertos).

## Limpieza de regenerables

Borrado de todo lo gitignored: `extensions/*/node_modules`, `extensions/node_modules`,
`remote/node_modules`, `remote/web/node_modules`, `build/node_modules`,
`build/rspack/node_modules`, `build/vite/node_modules`, `build/next/node_modules` y `.build/`.

**Consecuencia asumida:** el siguiente `dev/build.sh` arranca con `npm install` completo
(el script ya lo hace: fase 1). Con 10 extensiones menos, esa instalación baja también.

## Segundo corte: lint infra y dotfiles (mismo día, petición del dueño)

**Eliminado:**

- **ESLint completo**: `eslint.config.js`, `.eslint-ignore`,
  `.eslint-allowed-javascript-files`, `.eslint-plugin-local/`, `build/eslint.ts`,
  `build/gulp-eslint.ts`, `build/lib/test/eslint.test.ts`; en `build/hygiene.ts` el bloque
  ESLint y el guardián de allowlist JS (sustituido por rechazo directo de JS nuevo); en
  `build/filters.ts` el filtro `eslintFilter`; en `build/gulpfile.hygiene.ts` la llamada
  eliminada; en `package.json` el script `eslint` y 10 devDependencies del ecosistema ESLint
  (esto reduce también la próxima `npm install`).
- **`.vscode/` entera** (430K): settings/tasks/launch/snippets/notebooks/searches para
  desarrollar VS Code, y `.vscode/extensions/` (4 extensiones selfhost de test). Referencias
  limpiadas en `build/npm/dirs.ts` y `build/gulpfile.extensions.ts`.
- **`.mailmap` y `.nvmrc`** (1K cada uno, muertos para el producto).

**Conservados a propósito (con razón):**

- `.npmrc` — configura headers de Electron, `legacy-peer-deps` y builds nativos; quitarlo
  rompe `npm install`.
- `.gitignore` — es lo único que mantiene fuera de git `node_modules/`, `.build/` y salidas;
  sin él el árbol se llena de miles de ficheros fantasma.
- `.gitattributes` — integridad de fin de línea al commitear (1K).

Los comentarios `// eslint-disable-*` que quedan en el código son inertes: no rompen nada.

## Resultado ejecutado (2026-09-29)

- Árbol en disco: 3.3G → **242M** (objetivo cumplido de sobra: «menos de la mitad»).
- Extensiones en source: 107 → 97 carpetas (10 eliminadas).
- Producto empaquetado: extensiones compiladas 163M → **~94M** esperados (−42% del payload
  de extensiones) en la siguiente compilación; el ejecutable final bajará acorde.
- Build verificado con `./dev/build.sh -o`: fase 1 superada (identidad y árbol válidos).
- LSP de los 5 ficheros de build editados: sin errores propios (el ruido `Cannot find module
  'fs'` es ambiental: los `node_modules` están limpiados y vuelven con `npm install`).
- Cambios en working tree, sin commit (el dueño no lo pidió): 231 borrados (10 carpetas de
  extensiones), 6 ficheros modificados (5 de build + `product.json` sincronizado por el
  script). Preexistentes, ajenos a esta tarea: `AGENTS.md`, `LICENSE.txt`,
  `ThirdPartyNotices.txt` borrados en picode-source antes de esta sesión.
- **Consecuencia asumida:** el próximo `dev/build.sh` arranca con instalación completa de
  dependencias (más ligera que antes: faltan 10 extensiones que ya no se instalan).
