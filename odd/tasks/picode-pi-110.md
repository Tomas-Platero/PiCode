# Feature: pi 1.1.0 en el pin

**Estado:** cerrada · **Rama:** `experimental` · **Abierta:** 2026-10-08

## Intención del dueño

> «añade la nueva 1.1.0 versión de pi a picode, revisa el changelog y si añadimos algo nuevo.»

Subir el pi que PiCode se lleva dentro (`distribution/runtime.json`) a **1.1.0** y decidir, con el
changelog delante, si el escalón obliga a tocar algo de la app o si hay alguna novedad que merezca
adoptarse. Es el mismo trabajo que `picode-pi-104.md` (1.0.4), `picode-pi-102.md` (1.0.2),
`picode-pi-101.md` (1.0.1) y `picode-pi-1000.md` (1.0.0).

El pin anterior era **1.0.4** y el registro publica **1.0.4 → 1.1.0** seguidos (sin pasos intermedios
entre ambos), así que el escalón es **1.0.4 → 1.1.0** y no hay versión saltada.

## Lo que se midió antes de tocar nada (2026-10-08)

Medido contra el paquete real instalado con npm, no contra una nota.

| Dato | Valor |
| --- | --- |
| Última publicada | **1.1.0** (el registro lista hasta 1.1.0) |
| `@earendil-works/pi-telemetry` | **1.1.0 publicada** |
| Pin del repositorio | **1.0.4** |
| Las 7 entradas del SDK que resuelve el conector | presentes (`createAgentSessionServices`, `createAgentSessionFromServices`, `createMcpExtension`, `createCodemodeExtension`, `createToolSearchExtension`, `SessionManager`, `main`) → **CONTRACT OK** |
| `dist/cli.js` | presente |
| `dist/extensions/index.js` (los built-ins que la sesión necesita) | presente, **4 entradas** bien formadas |
| Validador de MCP de pi 1.1.0 contra los **12** escritores de PiCode | **12 aceptados**, y los dos controles heredados (`auth: "oauth"`, `oauth: false`) **siguen rechazados** |
| Dónde vive la versión | **un solo sitio**, `distribution/runtime.json`; el SDK no lleva ninguna versión escrita a mano |
| El árbol instala | `npm install --save-exact …@1.1.0` → **exit 0**, 121 paquetes |

## El changelog de 1.1.0, punto por punto

### Lo que llega al dueño: arreglos, y ninguno exige tocar código

* **Anthropic browser login caía con «localhost refused to connect» cuando el puerto 53692 está
  reservado o en uso** — por ejemplo, exclusiones de puerto de Hyper-V/WSL **en Windows**. El login
  ahora cae a un puerto loopback libre. Es el problema de la familia que el dueño reportó, y el que
  más se nota en su máquina.
* **Los MCP OAuth se pueden cancelar en todo momento**: con `Esc` en cada paso, el apagado de sesión
  aborta un login en curso, y cada petición al servidor de autorización tiene un plazo de **15 s**.
* **El apagado deja de esperar hasta 15 s** para refrescar un token de MCP OAuth que estaba a punto
  de caducar, solo para cerrar la sesión del servidor.
* **`/mcp` abre en vivo**: la lista deja de esperar a que *todos* los servidores conecten antes de
  pintarse; se puede usar mientras los servidores se habilitan, reconectan o deshabilitan.
* **`server_busy` / «servers are currently busy» y las respuestas de Mistral que terminan con
  `finish_reason: "error"` se reintentan** en vez de terminar el turno.
* **Menos fallos de límite de contexto**: la entrada se estima a **3,5 caracteres por token** en vez
  de 4 al calcular los límites de salida.
* **Los costes de sesión dejan de quedarse cortos** con prompts largos en modelos con tramos de
  precio por longitud (Claude Haiku 5.5, Gemini 3.1 Pro, GPT-5.4) a través de OpenCode, OpenRouter,
  Vercel AI Gateway, Google, MiniMax y otros.
* **`headers` de un modelo en `models.json` ahora pisa `originator` y `User-Agent`** de las
  peticiones a Codex (`mergeModelsFile` respeta esos campos desde `picode-pi-102.md`).
* **`agent_settled` gana `aborted`** y **`tool_execution_end` gana `durationMs`** (el tiempo de
  ejecución registrado de un resultado final). Son dos campos nuevos que el conector **ya recibe**,
  no dos APIs que haya que activar.

### Lo que no toca a PiCode

* **`+name`/`-name` en `--tools`** (`pi -t +codemode,-write` cambia la selección por defecto en vez
  de reemplazarla): PiCode **no pasa ninguna bandera de selección de herramientas de pi**
  (`--tools`/`-t`, `--exclude-tools`, `--no-mcp`); el único `--no-mcp` del árbol es el del propio
  daemon durable de PiCode (`experimental/durable/cli.js`), que no llega al analizador de pi. La
  nueva semántica no roza al producto.
* **Program status reporting con OSC 7501**: es de terminal y de dashboards que lo soporten. PiCode
  habla con pi por el SDK, no por una TUI, así que no aplica.
* **Claude Haiku 5.5, GPT-6 Luna y los modelos de decisión nativos de llama.cpp**: llegan por el
  **catálogo de pi**, y el desplegable de modelos de PiCode **ya lee ese catálogo** (con caché en
  disco desde el último cambio). No hay nada que declarar: aparecen solos en cuanto el runtime es
  1.1.0.
* **`pi update` gestionado conservando solo la release nueva y la anterior**: PiCode **no usa
  `pi update --self`**; actualiza el runtime con `npm install --prefix` y los paquetes del perfil con
  `pi update --extensions`, que deja el runtime en paz.
* **Los binarios standalone cargando `.env` del directorio de lanzamiento**: PiCode no lanza el
  binario standalone de pi.
* Arreglos internos que no tocan al producto: el formato de salida de codemode (`==> text N/M <==`,
  bloque `<console_output>`), `searchTools()`/`describeTool()` marcados async, imágenes bajo
  `node --watch`, pegado en Termux, fragmentos de códigos de color en la salida de `!` y de `bash`
  por RPC, selección de texto en pantalla completa tras cambiar de sesión, nivel de pensamiento de
  modelos OpenAI en Bedrock, modelos Radius de una organización, enlaces Markdown en Herdr, y el
  logo en color en las páginas de OAuth.

## Decisión

### 1. El pin sube a 1.1.0

`distribution/runtime.json` → **1.1.0**, con la nota reescrita: se dice que es un escalón normal sin
ruptura, lo que se revisó punto por punto, y lo que se verificó antes de fijarlo. El runtime del pack
se refresca con el paso real del build (`dev/pi-runtime.sh`), que compara la versión instalada con el
pin y reinstala cuando no coinciden. **Ese paso es también la prueba**: si el árbol de 1.1.0 no
instalara, el build falla.

### 2. No hay cambio de app que este escalón exija

Ni el renombrado de proveedores (ya resuelto en 1.0.3, no lo declaramos), ni los patrones de
`--tools` (no los pasamos), ni el formato de `models.json` (PiCode ya conserva los campos por modelo
desde 1.0.2). Los arreglos que importan (login de Anthropic en Windows, MCP OAuth, reintentos,
límite de contexto, costes, `headers`) viven **dentro de pi** y llegan con solo subir el pin.

### 3. Las dos novedades de integración se **evalúan y no se adoptan todavía**

Dos campos nuevos caen del lado del conector y merecen una decisión explícita, no un silencio:

* **`durationMs` en `tool_execution_end`.** PiCode pinta las herramientas normales con una línea de
  progreso (`stream.progress`) que el siguiente evento reemplaza, y **no** dibuja una fila persistente
  por herramienta; las únicas tarjetas persistentes son las de delegación durable y de trabajo en
  segundo plano, y su forma (`ChatSubagentToolInvocationData`) no tiene un campo de duración. Meter
  el tiempo en la línea de progreso dejaría un destello que el siguiente `progress` borra. **Queda
  anotado como posible paso de producto** (una fila por herramienta con su tiempo), no como parte de
  la subida del pin.
* **`aborted` en `agent_settled`.** PiCode ya cierra el turno con `agent_settled` y la cancelación la
  pinta el propio chat (el botón de parar, el flujo que se corta). Añadir un aviso «turno cancelado»
  sería texto redundante con lo que el usuario acaba de hacer. **No se adopta.**

Adoptar cualquiera de los dos sería una función de producto nueva, no una actualización del pin; la
intención del dueño para esta tarea es la subida.

## Verificación

| Qué | Cómo se comprobó |
| --- | --- |
| 7 entradas del SDK + `dist/cli.js` + `dist/extensions/index.js` | `node .scratch/pi-contract.mjs <raíz de 1.1.0>` → **CONTRACT OK**, 4 built-ins |
| El árbol instala | `npm install --save-exact @earendil-works/pi-coding-agent@1.1.0` → **exit 0**, 121 paquetes |
| MCP sigue aceptando lo que PiCode escribe | `node dev/check-mcp-entries.mjs --pack .scratch/pi-110` → **12 entries checked, all as expected**, con los dos controles heredados rechazados |
| `--tools`/`--exclude-tools`/`--no-mcp` no se usan | `grep` del conector y del build → sin coincidencias |
| El pin es el único sitio con la versión | `grep` de `1.0.4` en `distribution/`, `dev/`, `src/` → solo `runtime.json` |
| El catálogo trae Haiku 5.5 sin declararlo | `claude-haiku-5-5` presente en el bundle de pi 1.1.0; el desplegable lee el catálogo de pi |

### Cierre: medido sobre el pack que el build deja (2026-10-08)

| Qué | Valor |
| --- | --- |
| Build | `PICODE_BUILD_ANYWAY=1 PICODE_PACK_SUFFIX="-experimental" PICODE_SKIP_INSTALLER=yes ./dev/build-run.sh` → **exit 0** en **8m 12s** |
| pi dentro del pack | **1.1.0** (`PiCode-win32-x64-experimental/resources/pi-runtime/…/package.json`); el log dice `pi 1.1.0 in place` y `added 121 packages` |
| Contrato, contra el pi del pack | `node .scratch/pi-contract.mjs <pack>` → **CONTRACT OK**, 4 built-ins |
| MCP, contra el pi del pack | `node dev/check-mcp-entries.mjs --pack "PiCode-win32-x64-experimental"` → **12 entries checked, all as expected**, con los dos controles heredados rechazados |
| Perfil | El pack **no tenía perfil real** (el dueño corre desde la instalación de `AppData`); el build creó el seed (`data/user-data`, `data/extensions`, `data/tmp`) y **no quedó ningún `-data-hold`** atrás |
| `PiCode.exe` | 221 916 672 bytes, del 2026-10-08 09:13:38 |

**Por qué el instalador se salta aquí:** esta build reconstruye la **misma** versión que ya está publicada
(0.1.4-experimental); generar el instalador o el zip con otro contenido y la misma versión pisaría un
artefacto ya publicado. La verificación no lo necesita: el pack se puede ejecutar directamente
(`PiCode-win32-x64-experimental/PiCode.exe`). Publicar una release con el pi 1.1.0 es un paso aparte.
