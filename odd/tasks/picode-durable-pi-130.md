# pi 1.3.0 + pi-durable 1.3.0: revisión, adopción y subida de versiones

Fecha: 2026-10-15

## Goal

> «Se ha actualizado pi a la 1.3.0 y pi durable, revisa las mejoras y si podemos implementar algo y sube las versiones»

## Qué trae cada uno

### @earendil-works/pi-durable 1.3.0 (publicada hoy 2026-10-15)

- `SqliteStorage.open(database, { prefix })`: permite compartir UNA base SQLite entre varias
  instalaciones de pi poniendo un prefijo a todas sus tablas e índices. Los adaptadores
  `openNodeSqliteStorage()` y `openDurableObjectSqliteStorage()` lo reenvían.
- Cloudflare Durable Object: varias Pi sobre la misma base DO se coordinan solas. (No aplica:
  todo nuestro durable corre local.)
- **Fix de contexto tras compactar**: el system baseline escrito después de una compactación ahora
  va DELANTE del contexto del modelo cuando el historial conservado tiene mensajes de assistant.
  Antes se enviaba como system en mitad de conversación, lo que en Anthropic y Codex rompía el
  prompt inicial (sin prompt ni toolset delante). Ganancia directa para nuestras conversaciones
  durables largas.
- **Fix de memoria en `toBase64`**: codificar una imagen de 3 MiB gastaba ~140 MB de heap
  (por encima del límite de 128 MB de un Durable Object). Ahora se codifica por bloques de 8 KiB.
  Ganancia directa para `read` con imágenes en el daemon.

### pi (pi-coding-agent) 1.3.0

- `sessionShareDestination` para `/share` (auto/gist/radius): ajuste de TUI, no aplica al durable.
- Caché de prompt preservada al cambiar el thinking level (GPT-6 con API key) y al añadir tools
  medio de conversación (Kimi Code). Vía pi-ai 1.3.0, gratis para el daemon.
- Al cambiar de modelo se descarta el thinking del modelo anterior en vez de dárselo como texto.
- Las sesiones reanudadas conservan sus tools activas.
- Fila de fixes: reintentos transitorios, parsing de argumentos de tool calls con `\u` inválido,
  resultados de tool con imágenes tras error 400, etc.

## Qué se adoptó y qué no

| Mejora | Decisión |
| --- | --- |
| Fixs de contexto/compactación y memoria de pi-durable | Adoptada de facto: el perfil corre sobre pi-durable 1.3.0 |
| `SqliteStorage.open({ prefix })` | **No aplicada**: nuestra `agent.sqlite` es dedicada del daemon (proceso único dueño), no comparte base con tablas del host. Queda anotada por si un futuro comparte base |
| Caché de prompt (GPT-6/Kimi) y limpieza de thinking entre modelos | Gratis vía pi-ai 1.3.0 |
| `sessionShareDestination`, OSC/terminal, Nix | Fuera de alcance (TUI/distribución de pi, no del durable) |

## Verificación

- `tsc -p ~/.pi/agent/tsconfig.pi-lens.json` → **0 errores** contra pi 1.3.0 + pi-durable 1.3.0.
- Tests del durable: `node --test tests/widget.test.ts tests/tasks-integration.test.ts` → **15/15**
  (11 widget + 4 integración contra el daemon real, que arrancó sobre pi-durable 1.3.0).
  - Un test tuvo que arreglarse: `guard: comando destructivo…` esperaba `/bloquead/` en la respuesta
    del modelo, y el modelo contestaba «bloqueó». Frágil por texto, no por comportamiento (el guard
    SÍ bloqueó). Ahora `/bloque/` (bloquea/bloqueó/bloqueado).
- `picode-source/durable` (árbol del editor): deps subidas a la familia 1.3.0, `npm install` OK,
  `node smoke.js` sin crash (termina `unanswered/no_model` porque ese perfil no tiene modelos.json,
  comportamiento esperado).

## Versiones

- `~/.pi/agent/durable/package.json` (host del perfil): **0.1.0 → 0.2.0** (corre sobre pi-durable 1.3.0).
- `~/pi-durable-export/durable/package.json` (export portable): **0.1.0 → 0.2.0**, test del guard
  sincronizado y zip regenerado (`~/pi-durable-export.zip`, 19 ficheros, rutas con `/`).
  El instalador hace `pi install npm:@earendil-works/pi-durable`, así que un perfil nuevo recibe
  1.3.0 sin cambios en el instalador.
- `picode-source/durable/package.json` (árbol del editor): **picode-durable 0.1.0 → 0.2.0** y deps
  `pi-durable`/`pi-ai`/`chord` `^1.2.0 → ^1.3.0`, `pi-mcp` `1.2.0 → 1.3.0`; lock actualizado.

## Nota de operación

- El daemon cargó pi-durable 1.2.0 en su última vida; los tests de integración lo arrancaron ya con
  1.3.0. Cualquier arranque nuevo (o respawn de la extensión) usa 1.3.0.
- Drift detectado (fuera de alcance de esta tarea): el árbol del editor tiene otra generación del
  durable (`picode-source/durable` en JS + `durable-bridge/extension.ts`) que difiere del host vivo
  del perfil (`~/.pi/agent/durable` en TS). Reconciliar es trabajo aparte.
