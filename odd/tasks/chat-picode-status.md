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
