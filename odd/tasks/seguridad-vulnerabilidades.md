# Seguridad: vulnerabilidades de los lockfiles

**Contexto (dueño, 2026-09-29):** GitHub/Dependabot reporta 152 alertas abiertas en la
rama principal. No hay CLI de GitHub en la máquina, así que la revisión se hizo con
`npm audit --package-lock-only` sobre los **39 lockfiles** del árbol (lo mismo que mira
Dependabot, con la ventaja de poder actuar localmente). El lado .NET del builder está
limpio (`dotnet list package --vulnerable`: sin hallazgos).

## Estado inicial medido

53 hallazgos en 10 manifests (el resto de Dependabot es conteo por-ruta del mismo
universo de paquetes):

| Manifest | Antes | Después (fix dentro de rango) |
|---|---|---|
| raíz (`picode-source/package-lock.json`) | 25 (11H/14M) | 21 (8H/13M) |
| `build/package-lock.json` | 6 (5H/1M) | 2 (2H) |
| `build/npm/gyp` | 4 | **0** |
| `build/rspack` | 3 | **0** |
| `build/vite` | 2 | **0** |
| `build/agent-sdk/agents/claude` | 6 | **0** |
| `extensions/npm` | 2 | **0** |
| `extensions/json-language-features` | 1 | **0** |
| `extensions/markdown-language-features` | 3 | **0** |
| `extensions/emmet` | 1 (1H) | 1 (1H) |

**Commit:** `c427af8e` (10 lockfiles regenerados, solo bump dentro de semver).

## Las 24 que quedan y por qué no se tocaron solas

`npm audit fix --force` arreglaría casi todas, pero **exige saltos de versión mayor**:

- **Cadena gulp de tooling** (gulp 4→5, glob-watcher, chokidar 2→3, micromatch, braces,
  readdirp, findup-sync, matchdep, anymatch, gulp-sourcemaps, postcss): es la maquinaria
  de watch/build del árbol heredado. gulp 5 cambió la API de streams; los saltos
  automáticos pueden romper el build. **Decisión que requiere su propia sesión** con el
  build como verificador, no un fix nocturno.
- **`adm-zip`** (via `foundry-local-sdk`, raíz): fix = bump mayor de ambos. Revisar si
  `foundry-local-sdk` sigue teniendo uso real antes de subir nada.
- **`svgo`** (via markdown-math/esbuild): dentro de rango no hay parche.
- **`@xmldom/xmldom`**: parcheado en la pasada dentro de rango; si reaparece, revisar el
  dependiente.
- **Sin fix publicado (no arreglables hoy):**
  - `uuid` < 11.1.1 vía `@microsoft/dev-tunnels-connections` (runtime de túneles).
  - `@microsoft/dev-tunnels-connections` *: upstream no ha publicado parche.

## Riesgo real vs ruido

La mayoría de lo que queda es **tooling de build/CI**, no código que corre en el editor
empaquetado. Las dos dependencias de runtime sin fix (`dev-tunnels-connections`, `uuid`)
solo se activan con la función de túneles. Nada de lo pendiente es explotable sin una
superficie expuesta; el plazo lo marca upstream, no nosotros.

## Recomendación

1. Sesión dedicada a la cadena gulp 4→5 con el build como juez (recupera ~15 hallazgos).
2. Evaluar si `foundry-local-sdk`/`adm-zip` tienen uso real y si no, quitarlos.
3. Vigilar upstream para `dev-tunnels-connections`/`uuid`; re-auditar cuando publiquen.

## Verificación

Build completo tras los bumps: **superado** (exit 0, 8 min; `dev/build-run.sh`,
2026-09-29). Producto regenerado con las dependencias parcheadas.
