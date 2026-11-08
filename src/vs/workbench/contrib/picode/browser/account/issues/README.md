# Issues

Las issues de GitHub y los tickets de Jira (solo Pro): conectar desde *Connections*, verlos en un panel de *Status* y pasar uno al chat con *Fix with pi*.

- `picodeConnectorService.ts`: el servicio `IPicodeConnectorService`. Conecta (código de un solo uso en GitHub; navegador en Jira) y lee y edita las issues **a través del servidor de PiCode**: no guarda ningún token y no habla directamente con GitHub ni Jira. Sin red enseña la última lista.
- `picodeStatusIssues.ts`: un panel por servicio en la columna *Status* (lista, *Show N more*, *Refresh*, *Fix with pi*).
- `picodeIssuesView.ts`: el mismo panel como una vista más del contenedor de PiCode en el diseño *Editor*, solo para cuentas Pro (clave de contexto `picode.account.isPro`).
- `picodeIssueActions.ts`: qué hace *Fix with pi*, cuándo sale apagado y las frases de los fallos.
- `picodeConnectorAuth.ts`, `picodeIssueSources.ts`, `picodeIssuePrompt.ts`: la lógica pura (lectura de las respuestas, callback con `state`, limpieza del texto de la issue). Sin imports del editor para poder probarla con `node --test` (`extensions/picode/test/picode-issue-*.test.ts`, `picode-connector-auth.test.ts`).
- `picodeIssuesEditor.ts`, `picodeIssuesEditorInput.ts`, `picodeIssues.contribution.ts`: el visor, una pestaña del editor por proyecto de Jira o repositorio de GitHub (tablero o listado, con la issue pulsada a la derecha). Se abre con el comando `picode.issues.open`.
- `picodeIssueBoard.ts`: la lógica pura del visor (estados del proyecto, columnas, filtros, iniciales). `extensions/picode/test/picode-issue-board.test.ts`.
- `picodeIssues.css`: estilos del código de conexión, de las filas de *Status* y del visor.

Detalle y límites: [`docs/CUENTA.md`](../../../../../../../docs/CUENTA.md) · decisión: ADR-042.
