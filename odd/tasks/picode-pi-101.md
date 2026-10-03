# Feature: pi 1.0.1 en el pin

**Estado:** cerrada · **Rama:** `master` · **Abierta:** 2026-10-03

## Intención del dueño

> «actualiza pi a 1.0.1, revisa el changelog por si hay que actualizar algo de la app»

Subir el pi que PiCode se lleva dentro (`distribution/runtime.json`) de **1.0.0** a la **1.0.1**
publicada, y decidir, con el changelog delante, si ese escalón obliga a tocar algo del conector.
Es el mismo trabajo que la subida a 1.0.0 (`picode-pi-1000.md`).

## Lo que se midió antes de tocar nada (2026-10-03)

Medido contra npm y contra el paquete real `@earendil-works/pi-coding-agent@1.0.1` (descargado con
`npm pack` y leído su `CHANGELOG.md`, no de un blog).

| Dato | Valor | De dónde |
| --- | --- | --- |
| Última publicada | **1.0.1** | `npm view … versions` → `1.0.1` es la última |
| Pin del repositorio | **1.0.0** | `distribution/runtime.json` |
| Entradas que el conector resuelve | presentes | `dist/index.js` y `dist/cli.js` existen |
| El SDK que el conector usa, entero | sí | `dist/index.js` expone las **7** que `agent.ts`/`commands.ts` resuelven: `createAgentSessionServices`, `createAgentSessionFromServices`, `createMcpExtension`, `createCodemodeExtension`, `createToolSearchExtension`, `SessionManager`, `main` |
| Node que exige pi | `>=22.19.0` | `package.json` `engines` |
| Node que trae el editor | **v24.18.1** | `ELECTRON_RUN_AS_NODE=1 PiCode-win32-x64/PiCode.exe -v` |

### El changelog, punto por punto, contra PiCode

Novedades que **no tocan** el conector porque son de la TUI de pi, de plataformas que PiCode no
usa o de caminos que el conector no abre: el *flake* de Nix, los clasificadores
Cloudflare Clef, `pi.registerToolRenderer()` (el conector dibuja en el chat del editor, no en la
TUI de pi), las imágenes Kitty/Ghostty/WezTerm/Warp, el copy key de `/login`, las correcciones de
OAuth de Anthropic/Bedrock/AI Gateway, el ripgrep de NVIDIA y el reparto de tokens de codemode.

Lo que **sí** entra en territorio de PiCode:

1. **Overrides de MCP por proyecto** (`.pi/mcp.json`). Es la única novedad que toca un fichero que
   el conector lee. Un proyecto puede llevar una entrada **sin `command` y sin `url`** cuyo único
   trabajo es encender, apagar o cambiar la exposición del servidor de usuario del mismo nombre.
2. **Se retira `npm-shrinkwrap.json` del paquete publicado.** Las dependencias transitivas de pi
   ya no vienen fijadas: `npm install` las resuelve al instalar.
3. **Corrección de seguridad de `brace-expansion`** (GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7,
   GHSA-6j4f-fj2g-mc7p) fijada como dependencia directa. Motivo suficiente, por sí solo, para
   subir el pin.
4. **`oauth.clientRegistration: "cimd"`**, una opción nueva de MCP. PiCode no la ofrece en su
   formulario y el valor por defecto sigue siendo el de siempre: no hay nada que añadir.

## Decisión

### 1. El pin sube a 1.0.1 y el contrato queda verificado, no supuesto

`distribution/runtime.json` → `1.0.1`. El runtime del pack se refresca con el paso real del build
(`dev/pi-runtime.sh`), que ya reinstala cuando el pin se mueve. **El conector no cambia de
contrato**: las 7 entradas del SDK están, `dist/cli.js` está, y el validador de MCP de pi 1.0.1
acepta los **12** escritores que PiCode tiene y sigue **rechazando** las dos grafías heredadas que
el propio check usa como control. Eso se mide, y por eso se afirma.

### 2. Un override de proyecto deja de leerse como un error

El único cambio de la app. El lector de `mcp.json` (`mcp-provider.ts`) daba por malo —y lo decía en
el log— cualquier entrada sin `command` y sin `url`. Antes de 1.0.1 lo era; ahora es una forma
legítima de que un proyecto ajuste el servidor de usuario del mismo nombre, así que se reconoce:

- **`enabled: false`** en un fichero de proyecto **quita ese servidor de la lista**. No es
  cosmético: el código ya decía por qué (`mcp-provider.ts`, sobre `enabled`) — si la entrada se
  ofreciera al editor, el cliente del editor arrancaría el servidor de todas formas y sus
  herramientas llegarían a pi por el puente, así que «apagado» no apagaría nada.
- **`enabled`, `exposure`, `toolExposure`** (los tres que pi 1.0.1 admite en esa forma) no se
  reportan como entradas rotas. `exposure` y `toolExposure` deciden cómo expone pi las
  herramientas al modelo, y eso no lo reparte esta lista.

Medido contra el código instalado, no contra la nota del changelog: `dist/core/mcp-servers.js` y
el bundle de `/mcp` marcan la entrada con `override` y `scope: "global, project override"`, que es
exactamente la forma que ahora se reconoce.

### 3. La lección del `shrinkwrap` se documenta, no se disimula

Al no haber `npm-shrinkwrap.json`, **solo la versión directa está fijada**; las transitivas se
resuelven al instalar. El build siempre instala el pin (el script compara la versión instalada con
la del pin y reinstala si no coincide), así que el comportamiento no cambia, pero «una release
construida hoy se comporta igual dentro de seis meses» ya no es del todo cierto en las
transitivas. Se añade `--save-exact` a `dev/pi-runtime.sh` para que el `package.json` del runtime
diga `1.0.1` y no `^1.0.1` —la única parte del pin que queda—, y la limitación se escribe aquí. Un
lockfile propio dentro de `distribution/` sería el arreglo completo; queda como opción, no como
trabajo hecho.

## Tareas

- [x] Medir el salto 1.0.0 → 1.0.1 (SDK, CLI, validador, Node) antes de escribir.
- [x] Subir el pin a 1.0.1 y refrescar el runtime del pack.
- [x] Verificar 1.0.1 dentro del pack (versión, entradas, `--version` bajo el Electron del editor).
- [x] Reconocer el override de proyecto de pi 1.0.1 en `mcp-provider.ts`, con su prueba.
- [x] `--save-exact` en `dev/pi-runtime.sh` y la limitación del `shrinkwrap` documentada.
- [ ] **Lockfile propio del runtime de pi**: opción abierta, no urgencia. Hoy la versión directa va
      fijada por el pin y las transitivas no.

## Verificación

| Qué | Cómo | Resultado |
| --- | --- | --- |
| El pin manda | `distribution/runtime.json` | `1.0.1` |
| El runtime del pack se refresca | `bash dev/pi-runtime.sh PiCode-win32-x64` | instala 1.0.1 (104 paquetes altos, 110 bajas), poda plataformas ajenas |
| La versión dentro del pack | `package.json` del runtime instalado | `1.0.1` |
| pi 1.0.1 corre bajo el Node del editor | `ELECTRON_RUN_AS_NODE=1 PiCode-win32-x64/PiCode.exe <runtime>/dist/cli.js --version` | `1.0.1` (Node del editor v24.18.1, el pin pide ≥22.19.0) |
| El SDK que el conector resuelve | `require('…/dist/index.js')` y comprobar las 7 | 7/7 presentes |
| El validador MCP acepta lo que escribimos | `node dev/check-mcp-entries.mjs --pack PiCode-win32-x64` | 12/12 como se espera; los dos controles heredados siguen rechazados |
| Los tests del conector | `node --experimental-strip-types --test test/*.test.ts` | 176/176 ok (175 + el nuevo del override) |
| Los tipos de esos tests | `picode-source/node_modules/.bin/tsc -p extensions/picode/tsconfig.test.json` | exit 0 |
