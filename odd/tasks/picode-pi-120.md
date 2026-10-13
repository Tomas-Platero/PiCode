# Feature: pi 1.2.0 en el pin

**Estado:** cerrada · **Rama:** `experimental` · **Abierta:** 2026-10-13

## Intención del dueño

> «Ha salido pi 1.2.0 revisa los cambios, actualiza la versión de pi en picode a esa y si hay que
> hacer algo debido a los ultimos cambios.»

Subir el pi que PiCode se lleva dentro (`distribution/runtime.json`) a **1.2.0** y decidir, con el
changelog delante, si el escalón obliga a tocar algo de la app o si hay alguna novedad que merezca
adoptarse. Es el mismo trabajo que `picode-pi-110.md` (1.1.0), `picode-pi-104.md` (1.0.4),
`picode-pi-102.md` (1.0.2), `picode-pi-101.md` (1.0.1) y `picode-pi-1000.md` (1.0.0).

El pin anterior era **1.1.0** y el registro publica **1.2.0**; el escalón es 1.1.0 → 1.2.0 y no hay
versión saltada.

## Lo que se midió antes de tocar nada (2026-10-13)

Medido contra el paquete real instalado con npm, no contra una nota.

| Dato | Valor |
| --- | --- |
| Última publicada | **1.2.0** (el registro lista hasta 1.2.0) |
| `@earendil-works/pi-telemetry` / `pi-durable` / `pi-ai` / `pi-mcp` / `chord` | **1.2.0 publicadas** |
| Pin del repositorio | **1.1.0** |
| Las 7 entradas del SDK que resuelve el conector | presentes (`createAgentSessionServices`, `createAgentSessionFromServices`, `createMcpExtension`, `createCodemodeExtension`, `createToolSearchExtension`, `SessionManager`, `main`) → **CONTRACT OK** |
| `dist/cli.js` | presente |
| `dist/extensions/index.js` (los built-ins que la sesión necesita) | presente, **4 entradas** bien formadas |
| Opciones del SDK que el conector pasa | `resourceLoaderOptions.extensionFactories` / `additionalExtensionPaths`, `customTools`, `excludeTools`, `model`, `thinkingLevel`, `services.diagnostics` siguen en los `.d.ts` de 1.2.0 → **sin deriva de API** |
| `defineTool` (lo importa el puente durable) | sigue exportado, con la misma firma |
| Validador de MCP de pi 1.2.0 contra los **12** escritores de PiCode | **12 aceptados**, y los dos controles heredados (`auth: "oauth"`, `oauth: false`) **siguen rechazados** |
| Dónde vive la versión | **un solo sitio**, `distribution/runtime.json`; el SDK no lleva ninguna versión escrita a mano |
| El árbol instala | `npm install --save-exact …@1.2.0` → **exit 0**, 118 paquetes |

**El pi del editor y el pi del daemon durable son familias distintas.** El daemon
(`picode-source/durable`) no usa `pi-coding-agent`: declara `@earendil-works/pi-durable`, `pi-ai` y
`pi-mcp` (este último fijado en `1.0.2`), más `@earendil-works/chord`, y su lockfile los resuelve a
1.0.2. Este escalón no los toca —igual que en las subidas anteriores—; que esas familias tengan
1.2.0 es una decisión aparte, no la del pi que el chat del editor carga.

## El changelog de 1.2.0, punto por punto

### Las cuatro rupturas, y por qué ninguna toca a PiCode

* **Esquemas de configuración publicados y validados.** El esquema de temas se muda a
  `https://pi.dev/schemas/theme.schema.json` y los temas pasan a validarse **también al arrancar**
  (antes solo al recargar), con los colores reutilizables bajo `vars`. Esto es de **ficheros de
  tema de pi**: PiCode no trae ninguno, su perfil no declara temas, y la importación de perfil
  (`profile-import.ts`) copia `settings.json`, `models.json`, `mcp.json`, `skills`, `memory`,
  `sessions` y `auth.json` — **no copia temas**. Nada que actualizar.
* **`before_agent_start` pasa a ser una unión por `messageType`** y la sesión cuenta como ocupada
  mientras arranca (`ctx.isIdle()` es `false`, `pi.sendMessage()` encola en el run que arranca,
  `pi.sendUserMessage()` exige `deliverAs`). PiCode **no registra manejadores de extensión** —su
  único manejador es el `permissionExtension` interno y el puente durable, ninguno escucha ese
  evento— y **no llama a `sendUserMessage`**. Ordena sus turnos con su propia cola y pide con
  `session.prompt(..., { streamingBehavior })`, así que nunca lanza dos prompts a la vez.
* **`pi mcp list --json` cambia `resources`**: pasa de contar recursos y plantillas a un booleano.
  PiCode **no ejecuta `pi mcp list`**: lista los MCP por las herramientas `mcp__*` de la sesión en
  vivo y gestiona los servidores en el editor. El único uso del CLI de MCP es `pi mcp login`, que no
  toca ese campo.
* **Fuera el stack experimental de servidor/cliente/plugin** y sus paquetes
  `@earendil-works/pi-client`, `-protocol` y `-server` (no publicados), y **fuera la dependencia de
  `@earendil-works/chord`**. PiCode no importa ninguno de esos paquetes; el daemon durable sí usa
  `chord`, pero **lo declara él mismo**, así que la retirada del lado de pi no lo alcanza.

### Lo que llega al dueño: arreglos dentro de pi, y una novedad que aparece sola

* **Escribir o leer `auth.json` en Windows reintenta tras un `EPERM`** cuando la carpeta de bloqueo
  anterior aún se estaba borrando. Es la clase de fallo que más se nota en la máquina del dueño.
* **Anthropic reintenta una vez con herramientas no estrictas** cuando el proveedor rechaza el juego
  estricto por tamaño de gramática, número de herramientas o límites de unión.
* **«The upstream provider returned an error» se reintenta** como error transitorio.
* **Los MCP con `structuredContent` que no es objeto** (array, `null`, primitivo, tal como permite
  MCP 2026-07-28) dejan de fallar.
* **El OAuth de MCP rechaza un `iss` que no pudo comprobar** en vez de dar el sign-in por bueno.
* **Los modelos router de OpenRouter (`openrouter/auto`) dejan de mostrar -$1.000.000** por millón
  de tokens (sus precios negativos de marcador pasan a 0).
* **Los flujos de Mistral ya no se abortan tras el timeout** de la petición: el plazo solo cubre la
  espera de cabeceras.
* **Codemode deja de bloquear** segundos o minutos tras un script con muchos `text()` (la unión de
  la salida era cuadrática).
* **Con una clave de OpenRouter, pi lista solo los modelos que esa clave puede usar**, con su
  contexto, salida máxima y precios (incluidos endpoints regionales de `models.json`). Llega **sola**:
  el desplegable del asistente lee `runtime.getModels(provider.id)` en vivo, sin caché en disco.

### Lo que no toca a PiCode

* **`PI_CLIPBOARD_OSC52`**: es de terminal y de sesiones remotas por multiplexor; PiCode no dibuja la
  TUI de pi.
* **Tiempos de codemode en la fila**, **`showHardwareCursor`**, **cursor inverso**, **scroll con
  rueda en overlays**, **respuestas de color fragmentadas en la terminal**, **imágenes en Herdr**,
  **atajos con símbolos desplazados** — todo es de la TUI de pi, que PiCode no usa.
* **`serializeConversation()` omite bloques de pensamiento**: PiCode no lo llama (los resúmenes de
  compactación los decide pi internamente en su sesión).
* **`reachesTools` y `aliases`** en las definiciones de herramientas: son campos **opcionales
  añadidos**; el puente durable usa `defineTool` con la misma firma y no declara ninguno.

## Decisión

### 1. El pin sube a 1.2.0

`distribution/runtime.json` → **1.2.0**, con la nota reescrita: se dice que las cuatro rupturas se
revisaron punto por punto y ninguna llega al producto, qué arreglos y qué novedad sí llegan, y lo
que se verificó antes de fijarlo. El runtime del pack se refresca con el paso real del build
(`dev/pi-runtime.sh`), que compara la versión instalada con el pin y reinstala cuando no coinciden.
**Ese paso es también la prueba**: si el árbol de 1.2.0 no instalara, el build falla.

### 2. No hay cambio de app que este escalón exija

Las cuatro rupturas quedan fuera de la superficie de PiCode (temas que no trae, eventos de extensión
que no registra, un `pi mcp list` que no ejecuta y paquetes que no importa). Las opciones del SDK que
el conector pasa siguen presentes en 1.2.0, y `defineTool` conserva su firma. No hay nada que tocar.

### 3. Novedades evaluadas y no adoptadas

* **`$schema` en `models.json`/`settings.json`.** Los esquemas publicados permiten validación y
  autocompletado en un editor. PiCode escribe `models.json` sin `$schema`; añadirlo sería una mejora
  cosmética del fichero del perfil, no una necesidad del escalón. Queda anotado como posible paso de
  producto.
* **Tiempos de herramienta / `aborted` en el chat.** Igual que en 1.1.0: adoptarlos sería una función
  nueva de producto, no una actualización del pin.

## Verificación

| Qué | Cómo se comprobó |
| --- | --- |
| 7 entradas del SDK + `dist/cli.js` + `dist/extensions/index.js` | `node .scratch/pi-contract.mjs .scratch/pi-120/resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent` → **CONTRACT OK**, 4 built-ins |
| El árbol instala | `npm install --save-exact @earendil-works/pi-coding-agent@1.2.0` → **exit 0**, 118 paquetes |
| MCP sigue aceptando lo que PiCode escribe | `node dev/check-mcp-entries.mjs --pack .scratch/pi-120` → **12 entries checked, all as expected**, con los dos controles heredados rechazados |
| Las opciones del SDK no cambiaron | `resourceLoaderOptions.extensionFactories`/`additionalExtensionPaths`, `customTools`, `excludeTools` presentes en los `.d.ts` de 1.2.0 |
| `--tools`/`--exclude-tools`/`--no-mcp` no se usan | `grep` del conector → sin coincidencias |
| El pin es el único sitio con la versión | `grep` de `1.1.0` en `distribution/`, `dev/`, `docs/` → solo `runtime.json` (hasta esta subida) |
| Ni temas, ni `pi-client`/`pi-protocol`/`pi-server`, ni `serializeConversation` | `grep` del árbol → sin coincidencias |

### Cierre

La subida deja el pin en **1.2.0** en `distribution/runtime.json`, actualiza la nota del pin, la
entrada de `CHANGELOG.md` (`[Unreleased] → Changed`) y las menciones de versión en
`docs/DECISIONS.md`, `docs/DISTRIBUTION.md` y `docs/HARNESS.md`. Publicar una release con el pi
1.2.0 es un paso aparte, como en las subidas anteriores.
