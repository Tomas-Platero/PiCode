# Tarea: ronda de pulido — asistente, carga de modelos, packages, dominios de confianza y chat

> Segunda ronda del 2026-09-28, peticiones del dueño sobre el editor ya construido.
> La ronda anterior vive en `picode-management-round.md`.

## Puntos pedidos

1. **Asistente de primer arranque**: «The pi on this machine» pasa a «External Pi», con
   texto más claro; el probe del PATH no debe dejar al dueño sin respuesta.
2. **Lista de modelos (Language Models)**: mientras carga (~30 s con pi externo) no dice
   nada. Pon un estado de carga dentro de la tabla.
3. **Packages**: cambia el icono de Disable (el ⊘ no dice nada) y mejora los textos para
   que digan qué hacen; las filas sin origen quedan sin acciones y sin explicación.
4. **Dominios de confianza**: los dominios que abre el producto (mcp.directory, skills.sh,
   pi.dev) van en la lista de confianza por defecto — el aviso «Do you want PiCode to open
   the external website?» no debe salir para ellos.
5. **MCP**: «Browse Marketplace» pasa a «Browse MCP's».
6. **Chat**: fuera el selector de modo («Ask» / «Configure Custom Agents...») del input.
7. **Chat**: junto al modelo, un selector de **nivel de thinking** (off…max) — escribe
   `pi.thinkingLevel` y el conector lo aplica en el siguiente turno.
8. **Chat vacío**: «Ask about your code» pasa a un saludo del producto («Hello, I'm
   PiCode…») y el icono del chat por la marca de PiCode (el dibujo de trazos).

## Terreno verificado

- **1** · `picodeSetup.ts:373-377` — label/detail/meta del pi externo; `:416/:447` el
  «not found». El probe corre mientras la tarjeta ya está pintada (meta «Looking for it
  on the PATH…»), así que el retraso es del probe (8 s de tope); el texto nuevo debe
  explicar qué pasa mientras tanto.
- **2** · `chatModelsWidget.ts:1190-1191` — el progreso va al título del editor
  (`editorProgressService.showWhile`), invisible en la práctica. La tabla se pinta en
  `render()` (:1717); falta una fila de estado «Loading models…» con animación mientras
  el viewModel no ha resuelto.
- **3** · `pluginListWidget.ts:305-308` — Enable usa `Codicon.check`, Disable
  `Codicon.circleSlash`; tooltips en :306/:307. Filas huérfanas (instaladas en disco sin
  declaración): sin acciones ni explicación hoy.
- **4** · `src/vs/workbench/contrib/url/browser/trustedDomains.ts` — el ajuste
  `http.trustedDomains`; añadir los dominios del producto como valores por defecto.
- **5** · `mcpListWidget.ts` — `localize('browseMarketplace', "Browse Marketplace")`.
- **6** · `chatInputPart.ts` — el `ModePickerActionItem` se crea para
  `OpenModePickerAction.ID` (~:3421); el móvil usa `MobileChatInputCombinedPickerActionItem`
  (~:3403) con modeDelegate. No tocar el resto: el modelo y los demás pickers se quedan.
- **7** · El nivel vive en el ajuste **`pi.thinkingLevel`**
  (`extensions/picode/src/piConfig.ts:26/:56`, niveles en `THINKING_LEVELS`); el agente lo
  aplica en cada turno (`agent.ts:771/:790-791`). El chip del input escribe ese ajuste
  (Global) y se repinta con el valor en fuerza.
- **8** · `chatWidget.ts:1623` — título de la vista de bienvenida; el icono es un codicon
  del proveedor/contribución (~:1603-1630). La marca del producto está en
  `src/vs/workbench/contrib/picode/browser/media/picode.svg` (trazos, la misma del editor
  vacío). Cómo se referencia media desde el núcleo: ver cómo el editor vacío importa
  `picode.svg`.

## Unidades

| # | Puntos | Quién |
| --- | --- | --- |
| V1 | 6+7+8 (chatInputPart + welcome: mismo fichero) | worker |
| V2 | 5 (etiqueta Browse MCP's) | inline |
| V3 | 4 (dominios de confianza por defecto) | inline |
| V4 | 1 (External Pi + textos) | inline |
| V5 | 3 (icono y textos de Packages) | inline |
| V6 | 2 (carga en la lista de modelos) | inline |
