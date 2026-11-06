# Issues

Las issues de GitHub y los tickets de Jira (solo Pro): conectar desde *Connections*, verlos en un panel de *Status* y pasar uno al chat con *Fix with pi*.

- `picodeConnectorService.ts`: el servicio `IPicodeConnectorService`. Conecta (código de un solo uso en GitHub; navegador y servidor de PiCode en Jira), guarda los tokens cifrados, los renueva y lee las issues. Sin red enseña la última lista.
- `picodeStatusIssues.ts`: un panel por servicio en la columna *Status* (lista, *Show N more*, *Refresh*, *Fix with pi*).
- `picodeIssueActions.ts`: qué hace *Fix with pi*, cuándo sale apagado y las frases de los fallos.
- `picodeConnectorAuth.ts`, `picodeIssueSources.ts`, `picodeIssuePrompt.ts`: la lógica pura (lectura de las respuestas, callback con `state`, limpieza del texto de la issue). Sin imports del editor para poder probarla con `node --test` (`extensions/picode/test/picode-issue-*.test.ts`, `picode-connector-auth.test.ts`).
- `picodeIssues.css`: estilos del código de conexión y de los avisos.

Detalle y límites: [`docs/CUENTA.md`](../../../../../../../docs/CUENTA.md) · decisión: ADR-042.
