# Feature: pi 1.0.4 en el pin

**Estado:** cerrada · **Rama:** `experimental` · **Abierta:** 2026-10-06

## Intención del dueño

> «Necesitamos que pi sea 1.0.4»

Subir el pi que PiCode se lleva dentro (`distribution/runtime.json`) a **1.0.4** y decidir, con el
changelog delante, si el escalón obliga a tocar algo de la app. Es el mismo trabajo que
`picode-pi-102.md` (1.0.2), `picode-pi-101.md` (1.0.1) y `picode-pi-1000.md` (1.0.0).

El pin anterior era **1.0.2**, y no por elección: **1.0.3 estaba bloqueado por el registro**. Su
árbol resuelve `@earendil-works/pi-telemetry@^1.0.2` a **1.0.4**, cuya entrada en el registro existía
y cuyo tarball respondía **404**, así que `npm install` fallaba y el build no podía empaquetar pi
(medido el 2026-10-05, anotado en `distribution/runtime.json`). El escalón real de esta tarea es
**1.0.2 → 1.0.4**, saltándose 1.0.3 por necesidad y no por gusto.

## Lo que se midió antes de tocar nada (2026-10-06)

Medido contra el paquete real, no contra una nota.

| Dato | Valor |
| --- | --- |
| Última publicada | **1.0.4** (el registro lista hasta 1.0.4) |
| `@earendil-works/pi-telemetry` | **1.0.4 publicada** — el tarball que daba 404 ya existe, que es lo que desbloquea 1.0.3 y 1.0.4 |
| Pin anterior | **1.0.2** |
| Las 7 entradas del SDK que resuelve el conector | presentes (`createAgentSessionServices`, `createAgentSessionFromServices`, `createMcpExtension`, `createCodemodeExtension`, `createToolSearchExtension`, `SessionManager`, `main`) → **CONTRACT OK** |
| `dist/cli.js` | presente |
| Validador de MCP de pi 1.0.4 contra los **12** escritores de PiCode | **12 aceptados**, y los dos controles heredados (`auth: "oauth"`, `oauth: false`) **siguen rechazados** |
| Dónde vive la versión | **un solo sitio**, `distribution/runtime.json`; el SDK no lleva ninguna versión escrita a mano |

### El changelog de 1.0.3, punto por punto

**Cambio de ruptura, y el único que importa:**

> **Azure provider renombrado** de `azure-openai-responses` a `azure` — afecta a `auth.json`,
> `models.json` y `settings.json` (`defaultProvider`, patrones de `enabledModels`,
> `modelThinkingLevels`). Las sesiones que usaban el proveedor viejo caen a otro modelo al
> reanudarse.

**Coste para PiCode: cero, y comprobado**: el conector no menciona ningún proveedor `azure`
(el único `azure` del repositorio es el id de una extensión ajena en `product-delta.json`), y el
perfil del dueño no lo declara (`models.json` y `auth.json` sin ninguna entrada `azure`). No hay
nada que renombrar en el producto.

Lo demás de 1.0.3 no toca al conector: imágenes de codemode guardadas en ficheros, ficheros de
salida legibles solo por el usuario, `Home`/`End` en la TUI, y arreglos (login con suscripción tras
un refresh cancelado, codemode tras un `pnpm update` global, crash de terminal al cerrarse).

### El changelog de 1.0.4, punto por punto

* **Patrones en `--tools` / `--exclude-tools`, y `--no-mcp`** — PiCode **no pasa ninguna de las
  tres** (comprobado: no aparecen en el conector ni en el build), así que el cambio de semántica
  («`--tools` ahora conserva las herramientas MCP salvo que una entrada empiece por `mcp__`») no
  roza al producto.
* **Codemode conserva imágenes** — `tools.read()` de un fichero de imagen devuelve un bloque de
  imagen. Solo afecta a codemode dentro de pi.
* **Arreglado: login OAuth de MCP con `invalid_redirect_uri`** en servidores con registro de
  cliente OpenID Connect (por ejemplo `mcp.modem.dev`): pi se registra ahora como cliente nativo.
  **Relevante para el dueño** — es la familia del problema que reportó («sentry, vercel y otros
  piden login otra vez»), así que tras el rebuild hay algo concreto que comprobar, no una promesa.
* **Arreglado: apagado de sesión MCP** que volvía mientras un servidor seguía conectando y dejaba
  el transporte abierto ([#10249](https://github.com/earendil-works/pi/issues/10249)) — toca la
  vida de los servidores MCP que PiCode arranca por sesión.
* **Arreglado: reglas del prompt de sistema y pista de skills** con herramientas ocultas por
  `prepareLoadout`; `ToolLoadout` gana `getPromptGuidelines()`.
* Arreglos que no tocan al producto: resaltado de sintaxis en bloques de código, reintento de
  Bedrock tras HTTP/2 colgado, y scripts de codemode que parcheaban built-ins y dejaban la llamada
  sin resolver.

## Decisión

### 1. El pin sube a 1.0.4

`distribution/runtime.json` → **1.0.4**, con la nota reescrita: el bloqueo de 1.0.3 queda dicho como
resuelto, y escrito lo que costó el escalón (nada) y lo que se verificó antes de fijarlo.

El runtime del pack se refresca con el paso real del build (`dev/pi-runtime.sh`), que compara la
versión instalada con el pin y reinstala cuando no coinciden. **Ese paso es también la prueba**: si
el árbol de 1.0.4 no instalara, el build falla.

### 2. No hay cambio de app que este escalón exija

Ni el renombrado de Azure (no lo declaramos), ni los patrones de `--tools` (no los pasamos), ni el
formato de `models.json` (1.0.2 ya añadió `samplingParamsByThinkingLevel`, que `mergeModelsFile`
respeta desde `picode-pi-102.md`).

## Evidencia

| Qué | Cómo se comprobó |
| --- | --- |
| 7 entradas del SDK + `dist/cli.js` | `node .scratch/pi-contract.mjs <1.0.4>` → **CONTRACT OK** |
| El árbol instala | `npm install --save-exact @earendil-works/pi-coding-agent@1.0.4` → **exit 0**, 121 paquetes |
| MCP sigue aceptando lo que PiCode escribe | `node dev/check-mcp-entries.mjs --pack <1.0.4>` → **12 entries checked, all as expected** |
| Azure no nos afecta | `grep` del conector y de `models.json`/`auth.json` del perfil → sin entradas `azure` |
| `--tools`/`--exclude-tools`/`--no-mcp` no se usan | `grep` del conector y del build → sin coincidencias |
| El pin es el único sitio con la versión | `grep` de `1.0.2` en `distribution/`, `dev/`, `src/` → solo `runtime.json` |

### Cierre: medido sobre el editor que el dueño tiene en la mano

| Qué | Valor |
| --- | --- |
| Build | `PICODE_PACK_SUFFIX=" - experimental" ./dev/build-run.sh` → **exit 0** en 5m 38s |
| pi dentro del editor | **1.0.4** (`resources/pi-runtime/…/package.json`, y el manifiesto del runtime lo declara) |
| MCP, contra el pi **que va dentro** | `node dev/check-mcp-entries.mjs --pack "PiCode-win32-x64 - experimental"` → **12 entries checked, all as expected**, con los dos controles heredados rechazados |
| Perfil del dueño | **57 595 ficheros y 261 transcripciones**, apartado y devuelto por el build; `models.json`, `auth.json`, `mcp.json`, `mcp-auth.json`, agents y skills en su sitio, y sin ningún `data-hold` dejado atrás |
| `PiCode.exe` | 221 916 672 bytes, del 2026-10-06 23:47 |

**Lo que el dueño puede comprobar él mismo**, y no es una promesa: que `sentry` y `vercel`
ya no le pidan login cada vez — 1.0.4 arregla justo ese fallo de OAuth (`invalid_redirect_uri`).
Si sigue pasando, el siguiente sospechoso es la persistencia de la credencial en el perfil, no pi.
