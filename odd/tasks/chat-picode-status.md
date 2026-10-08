# Chat PiCode y Status vivo

**Estado:** cerrada (falta el visto bueno visual del dueño) · **Rama:** `feat/source-in-repo` · **Abierto:** 2026-09-27

## Intención del dueño

El chat nativo ya funciona con pi (captura: respuesta correcta del agente). Quedan dos
cosas: **«que el chat el nombre del agente no sea "pi" sino "PiCode". Y su logo no el de la
imagen esa del bubble»** y **«lo que no funciona es el PICODE Status a la izq»** (panel vacío,
solo un guion).

## Diagnóstico (medido en el árbol, 27-09)

- Participante: `extensions/picode/package.json` → `chatParticipants[0]` con `name: "pi"`,
  `fullName: "pi"`. El icono de la cabecera de respuesta lo decide
  `chatListRenderer.getAgentIcon` desde `metadata.icon`, que sale de
  `participant.icon` (API `ChatParticipant.icon`) — el conector **nunca lo pone**, y cae en
  el avatar por defecto. El manifiesto de `chatParticipants` NO admite `iconPath`
  (`additionalProperties: false`, verificado en `chatParticipant.contribution.ts:87`).
- Status: tres fallos sumados. (a) `package.json` declara la vista `"type": "webview"` pero
  `status-view.ts` registra un **TreeDataProvider** (su propio comentario dice «tree,
  deliberately, not a webview») → panel vacío. (b) `registerStatusTreeView()` no está
  llamado desde `activate` (grep: cero llamadas). (c) El comando de datos
  `picode.setup.status` está referenciado pero **no implementado** en ningún fichero.
- Título duplicado: contenedor `title: "PiCode"` + vista `name: "PiCode Status"` → la cabecera
  sale «PICODE: PICODE STATUS». Con `name: "Status"` queda «PiCode: Status».

## Tareas

| # | Tarea | Estado |
| --- | --- | --- |
| S1 | Participante `PiCode`: `name: "picode"`, `fullName: "PiCode"`, e icono `media/picode.svg` (el dibujo de trazos de marca, copiado del núcleo) vía `participant.iconPath` (la API real en este árbol; `.icon` no existe — el obrero lo corrigió y compile lo prueba) | ✅ |
| S2 | Status vivo: vista a `type: "tree"`, llamada a `registerStatusTreeView()` en activate, y comando `picode.setup.status` implementado (`status-data.ts`, 190 líneas) leyendo **el perfil en fuerza** (interno `data/pi-agent` vs `externalProfileDir()`); sin dato honesto, fila con `—`, nunca inventado. Título «PICODE: PICODE STATUS» → «PiCode: Status» | ✅ |
| S3 | Reconstruir (build completo ~3,5 min) y comprobar en el editor empaquetado | ✅ build status 0 (4 min 42 s con todo); verificado EN EL PACK: participante `picode`/`PiCode`, vista `tree`/`Status`, `iconPath` en out/agent.js, status-data.js registrado; editor arrancado (8 procesos). La comprobación visual final es del dueño |
| S4 | Documentar y cerrar | ✅ esta ficha + commit `48a6b1ca`. **Seguimiento anotado**: el `buildStatusData` duplicado y nunca registrado de `onboarding.ts` queda vivo-muerto — comparte helpers (`countDirs`, `gitInfo`, `readContextWindow`) con el wizard; borrarlo pide trazar cada uno, va en commit propio cuando toque |
| S5 | (petición nueva del dueño con capturas) Quitar `Sessions` (lo trae el chat) y `Agents`; el Status debe dar datos reales como el TUI: contexto, usage, coste… | ✅ **el «No turns yet» era un bug**: el rastreo leía `entry.usage` y pi lo guarda en `entry.message.usage` (solo mensajes del asistente) — confirmado contra una sesión real. Ahora: contexto con % de ventana, coste, tokens, caché, modelo vivo, esfuerzo y `N files · +A −D`. Comps: `3c6e9c38`. **Honestidad**: el «usage 20%» del TUI es cuota del proveedor, no vive en la sesión — no se muestra. Y `+A −D` no cuenta ficheros sin trackear (git no puede contar lo que no está en HEAD) |
| S6 | (dono: «eso lo necesitamos») Barra `usage` de suscripción. Investigación pedida confirmada: la barra de uso se pinta con datos **vivos del proveedor**, no de la sesión. **Implementado NaN** (Codex/Anthropic siguen siendo follow-up: sus ventanas viajan en cabeceras SSE que el conector no ve). La fila `Usage` sale justo detrás de `Cost (session)` | ✅ |
| S6.1 | **Fuentes y decisiones del wiring** (medido, no supuesto): `src/usage-data.ts` (nuevo) es el lector del endpoint NaN — `NAN_QUOTA_URL = https://cloud-api.nan.builders/api/usage/quota`, `Bearer <apiKey>` + `Accept: application/json`, `redirect: "error"`, `cache: "no-store"`; no-ok/error/lectura vacía → `undefined`, nunca lanza. Parser espejo: ventana de periodo `tokensUsed/allowance` (`fullCap ?? cap`; un modelo sin allowance se salta, uno **medido sin uso** falla la lectura **entera**), ventana rodante `windowTokensUsed / (fullWindowTokens ?? windowTokens ?? 400M)` con `windowHours ?? 4`; defaults 400M/4 h son los que publica el panel del proveedor. Selección por **significado**: meter cuyo `model` coincide con el de la sesión; si no coincide y solo hay uno, ese; si hay varios y ninguno, ninguno | ✅ |
| S6.2 | **Gating (arregla el riesgo declarado)**: el modelo vivo sale de `getSessionUsage()` en `src/agent.ts` (no existe `session-usage.ts`/`currentModel`: es `model: "provider/modelId"`). La fila solo se dibuja si **el provider de la sesión** coincide con una entrada de `picode.providers` del **mismo id** que además es NaN (`id === "nan"` o endpoint contiene `nan.builders`). Un NaN declarado mientras la sesión va por otro proveedor → **ninguna fila**; otro proveedor cualquiera → **ninguna fila** (ni un guion: Codex/Anthropic no tienen ruta legible, y prometer un número que no puede llegar es peor que no prometerlo). NaN con clave y lectura fallida → `unavailable` (con *stale-on-error*: la última lectura buena sobrevive) | ✅ |
| S6.3 | **Orden de la clave** (nunca se ejecuta nada ni se pinta nada): (1) literal del campo `key` de la entrada; (2) `$NAME` / `$env:NAME` desde `process.env` — variable sin definir no es clave, pasa el turno; (3) `auth.json` del perfil **en fuerza** (`{type,key}` o *string*). `!command` **NUNCA se ejecuta**: se trata como irresoluble y se continúa con `auth.json` (efecto colateral de un refresco de estado que nadie pidió). La caché va por **hash SHA-256** de la clave, TTL 60 s, intento rate-limitado aunque falle (≤1 red/min con refresco cada 5 s) y lecturas solapadas comparten una petición | ✅ |
| S6.4 | **Formato de fila decidido**: `Usage · <modelId> <ventana-rodante> <pct>% · periodo <pct>%` — ventana más corta primero (`4h`), el allowance del periodo sin etiqueta propia se imprime como `periodo`; porcentajes `Math.round`. Ejemplo verificado en test: `glm5.3-flash 4h 33% · periodo 12%` | ✅ |
| S6.5 | **Evidencia**: `node --test picode-source/extensions/picode/test/usage-data.test.ts` → **16 tests, 16 pass, 0 fail**; `node picode-source/node_modules/@typescript/native/lib/tsc.js --project picode-source/extensions/picode/tsconfig.json --noEmit` → **exit 0**; emit real (sin `--noEmit`) → **exit 0** y `out/usage-data.js` presente (el conector se empaqueta desde `out/`). Ficheros: `src/usage-data.ts` (nuevo), `src/status-data.ts`, `src/status-view.ts` (`usage?: string` en `StatusData` + fila), `test/usage-data.test.ts` (nuevo). El comando es asíncrono (ya lo era) y espera la caché con tope de 4 s | ✅ |

## Superficie de edición autorizada

`picode-source/extensions/picode/`: `package.json`, `src/extension.ts`, `src/agent.ts`,
`src/status-view.ts`, `src/status-data.ts` (nuevo), `media/picode.svg` (nuevo, copia).

## Registro

- 2026-09-27 · abierto tras la captura del dueño; diagnóstico completo arriba; writer
  delegado con S1+S2.
- 2026-09-27 · writer entregó en verde (tsgo 0 errores) con una corrección buena: la propiedad
  de la API es `iconPath`, no `icon`. Revisión del padre: el duplicado de onboarding está muerto
  (nadie llama su registro) pero comparte helpers con el wizard → limpieza aplazada a commit
  propio. Build completo status 0; verificado DENTRO del pack (nombre del participante, tipo de
  vista, iconPath, comando de datos); editor abierto para el dueño. Commit `48a6b1ca`.
- 2026-09-27 · el dueño reclama la barra `usage`. Investigación: es cuota del proveedor que
  se pide viva (no vive en sesión). Ruta NaN implementada con parser espejo y caché 60 s;
  Anthropic/Codex quedan declarados follow-up (cabeceras SSE invisibles al conector).
- 2026-09-27 · **S6 cerrada**. El obrero paró a la primera (faltaba `src/status-view.ts` en la
  superficie: el contrato `StatusData` y el render del árbol viven ahí, no en `status-data.ts`) y
  el dueño autorizó el conjunto corregido. Correcciones de punteros del padre aceptadas: no hay
  `session-usage.ts` ni `currentModel` — la verdad es `getSessionUsage()` de `src/agent.ts` con
  `model: "provider/modelId"`. 16/16 tests, typecheck y emit en 0. Sin commit (rama del dueño).
| S7 | Iconos en el Status: raíces `pi` (robot de marca), `Session` (history), `Project` (root-folder) + todas las filas bullet con icono por significado (runtime circuit-board, versión tag, proveedores plug, modelo chip, effort dashboard, estado check, skills lightbulb, contexto pulse, coste credit-card, usage symbol-numeric, tokens arrow-swap, caché archive, rama git-branch, cambios diff, MCP server-process). Cada id verificado contra `codiconsLibrary.ts` (gauge no existe → pulse) | ✅ padre (el obrero murió sin escribir nada; trabajo recuperado inline) |\n| S8 | Lista de tareas de la sesión: fuente verificada en la tool `todo` (snapshot completo en el `details` de cada resultado); `session-tasks.ts` puro (última foto gana, in-progress primero, entradas malas se saltan), cableado en el bucle de usage de `agent.ts` → `StatusData.tasks` → bloque bajo Session con icono por estado (check/sync/circle-large-outline) y nota como descripción. Sin lista → sin filas | ✅ 5 tests; 117/117 conector |
- 2026-09-27 · S7/S8: el obrero delegado murió sin escribir (3 h, cero ficheros); el padre las
  terminó inline con el brief original. Iconos verificados contra codiconsLibrary (ninguno
  inventado). 117/117 tests; tsc 0; build 0; pack verificado (session-tasks.js + picode.svg en
  status-view.js dentro del pack). Editor relanzado.
