# pi durable deja de ser experimental: vive en el source de PiCode

> «Vamos a dejar de poner como algo experimental a pi durable, quiero que esté ya en nuestro
> source de picode, no lo quiero a parte en "experimental", tratalo como algo ya que vive en
> picode.» — dueño, 2026-10-09

## Qué era y qué pasa a ser

Hasta hoy el agente durable vivía en `experimental/durable`, con su puente de chat en
`experimental/pi-durable-bridge` y su cliente de prueba ACP en `experimental/acp-client`. La
carpeta `experimental/` era la declaración de que era un experimento; el editor lo ejecutaba
igual, pero el nombre y el sitio decían otra cosa.

Hoy las tres piezas son parte del propio árbol del editor:

| Antes | Ahora |
| --- | --- |
| `experimental/durable` | `picode-source/durable` |
| `experimental/pi-durable-bridge` | `picode-source/durable-bridge` |
| `experimental/acp-client` | `picode-source/durable-acp-client` |

Movidos con `git mv` (historia intacta). La carpeta `experimental/` queda vacía y desaparece.

## La regla de residencia (ya escrita en `docs/ARCHITECTURE.md`)

Nada nuestro vive dentro de `picode-source/` salvo el código que el editor ejecuta. El agente
durable es exactamente eso: el editor lo lleva, lo arranca y lo para — ahora también reside
allí, junto a los cambios del editor, porque ya no es un experimento sino parte del producto.

## Qué cambió, pieza por pieza

**El conector** (`picode-source/extensions/picode`):

* `durable-folder.ts` — `DEFAULT_DURABLE_FOLDER` = `picode-source/durable` (el default del
  ajuste `picode.durable.folder`) y `SHIPPED_DURABLE_FOLDER` = `durable` (antes `pi-durable`).
  La lista de candidatos no cambia: carpetas abiertas → repositorio sobre un pack →
  `<app>/resources/durable`.
* `durable.ts` — el hermano del bridge ahora es `../durable-bridge/extension.ts`.
* `durable-client.ts`, `durable-cards.ts`, `durable-spawn.ts`, `durable-tasks.ts`,
  `mcp-provider.ts`, `extension.ts` — comentarios que citaban la ruta vieja o llamaban
  «experimento» al agente.
* Tests: `durable-folder.test.ts` y `durable-spawn.test.ts` actualizados a las rutas nuevas.

**El editor** (núcleo):

* `picodeConfiguration.ts` — default del ajuste = `picode-source/durable`; el comentario deja
  de decir "experimental".
* `settingsLayout.ts` — la sección de ajustes se llama **Durable agent** (antes
  "Durable agent (experimental)").

**La build** (`dev/`):

* `durable-runtime.sh` — copia desde `picode-source/durable` y `picode-source/durable-bridge`
  hacia `<pack>/resources/durable` y `<pack>/resources/durable-bridge`. El destino cambia de
  nombre (`pi-durable` → `durable`), que es lo único que un pack ya construido nota.
* `build.sh` y `dev/README.md` — la referencia a la carpeta vieja.

**El agente**:

* `package.json` — nombre `picode-durable` (era `picode-durable-experiment`) y descripción sin
  "Experimental proof". `package-lock.json` regenerado en consecuencia (el nombre raíz).
* `lib/settings.js`, `lib/mcp.js`, READMEs y proofs — "experiment" → "agent"; rutas nuevas en
  los ejemplos y los `# Run from ...`.
* El puente mantiene sus imports relativos (`../durable/...`), que resuelven igual tras el
  movimiento; el especificador pelado `@earendil-works/pi-coding-agent` lo resuelve pi desde su
  propio runtime, sin cambiar.

**Ignorar y estado**:

* `.gitignore` raíz — fuera las dos reglas de `experimental/durable`; dentro de la nueva
  `picode-source/durable/.gitignore` una sola: `.data/` (estado de pruebas, logs y credenciales
  de perfiles de mano; las conversaciones de verdad viven en `data/durable` del pack).
* Sin `.data/` versionado: la carpeta que viajó está vacía y el nuevo `.gitignore` la cubre.

## No se toca

* `odd/tasks/*` históricos (regla: no se reescriben).
* `docs/HARNESS.md` y `docs/DISTRIBUTION.md` sí se actualizaron (son papeles vivos);
  `docs/DECISIONS.md` no necesita ADR nuevo: ninguna decisión cambió, cambió el sitio.
* Los packs ya construidos (`PiCode-win32-x64-experimental`) siguen con `resources/pi-durable`;
  la próxima build los lleva con el nombre nuevo y el editor encuentra ambos mientras exista el
  fichero `cli.js` — el default nuevo solo busca en `picode-source/durable` y
  `resources/durable`, así que un pack viejo con el ajuste por defecto deja de encontrar el
  agente hasta la siguiente build. Es el caso de un pack de desarrollo, no de una instalación.

## Verificado

* `node --test durable-folder.test.ts durable-spawn.test.ts` — 7/7 ✔.
* tsc del conector con el compilador del árbol (`@typescript/native`) — exit 0.
* `node picode-source/durable/cli.js --help` — el agente carga desde su sitio nuevo.
* Los imports del bridge resuelven relativos a su nueva casa.
* `rg "experimental/durable|resources/pi-durable|pi-durable-bridge"` sobre el árbol vivo —
  cero apariciones fuera de `odd/tasks/` históricos y packs ya construidos.
