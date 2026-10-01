# Tarea: ronda de gestión — notificaciones de actualización, página de Agent Customizations, chat y MCP

> Solicitud del dueño, 2026-09-28. Diez puntos. Este papel es el registro de decisiones
> y del terreno; la lista viva de estado está en `docs/TAREAS.md`.

## Puntos pedidos (frases del dueño, resumidas)

1. Notificación (abajo a la izquierda) cuando pi o Gentle-AI tengan actualizaciones —
   packages, el propio pi o gentle — con botón para actualizar. Antes de actualizar,
   parar sesiones; después, refrescar.
2. Packages: tabla en vez de lista, con deshabilitar al momento y/o borrar. Pi interno o externo.
3. MCP Servers: 3.1 «Extensions» pasa a «Servers». 3.2 Editar/quitar cualquier MCP
   (interno o externo). 3.3 El botón de marketplace lleva a `https://mcp.directory`.
   3.4 Usar el sistema de «vscode» al añadir desde mcp.directory.
4. Skills: 4.1 «Generate Skill» pasa a ser un único botón «Browse Skill» → `https://www.skills.sh/`.
   4.2 La lista «Plugins» pasa a «Packages». 4.3 El popup dice «Uninstall Skill».
   4.4 Fuera el botón «Install Chat Customization Extension».
5. Agents: 5.1 Solo agentes de Gentle-AI, sin categorías. 5.2 Fuera el botón de generar/añadir.
   5.3 Fuera «Install Chat Customization Extension»; quedan los otros 2.
6. Overview: fuera «Customize Your Agent».
7. Chat: fuera «Agente» (el modo).
8. Chat: todos los MCP siempre activos en las tools.
9. Revisar el error del MCP de Vercel (y Rovo): «Cannot convert argument to a ByteString
   because the character at index 7 has a value of 8212».
10. Con pi externo, modelos instantáneos al arrancar, refresco cada 5 min, y que siempre
    cargue el último modelo puesto. (Caché.)

## Terreno verificado (2026-09-28)

### P9 — causa raíz encontrada. No es el modelo.
- `product.json:3` — `"nameLong": "PiCode — Agentic Code Editor"` lleva una raya U+2014
  (8212) en el índice 7 (P-i-C-o-d-e-espacio = 0..6, raya = 7).
- `src/vs/workbench/api/common/extHostMcp.ts:849` — cada petición MCP HTTP manda
  `user-agent: ${product.nameLong}/${product.version}`. El `fetch` de Node exige
  ByteString (ASCII) en las cabeceras → TypeError exacto que se ve con Vercel y Rovo.
- Arreglo: sanear los valores de cabecera (quitar no-ASCII) en el cliente MCP del editor,
  sin tocar la marca del producto.
- Las cabeceras de usuario (`Authorization` desde `mcp.json`, vía `mcp-provider.ts`) pueden
  llevar lo mismo; se sanea todo en el mismo punto.

### P10 — la caché ya existe (83bce6af), falta arrancarla sola
- `models-cache.ts` + `extension.ts:894` — el listado responde al instante desde caché y
  refresca en segundo plano (TTL 5 min para modelos configurados).
- Pero **nada carga al arrancar**: las cachés nacen vacías y solo se llenan cuando el chat
  pide la lista por primera vez. Arreglo: al activar la extensión, lanzar el refresco ya;
  y un temporizador cada 5 min.
- «El último que puse» ya está persistido por el núcleo
  (`chat.currentLanguageModel.panel`, `chatSelectedModel.ts:15`); con la lista cargada al
  arrancar, la selección se resuelve al instante.

### P1 — no existe ningún mecanismo de comprobación de actualizaciones
- Versión de pi interno: `onboarding.ts:571` lee el `package.json` de la copia fijada.
- Versión de pi externo: `onboarding.ts:585` ejecuta `<cli.js> --version`.
- Versión de Gentle-AI: `onboarding.ts:562` lee `<perfil>/npm/node_modules/gentle-pi/package.json`.
- Packages instalados con versión: `packages-data.ts` (manifests en disco).
- Última versión publicada: el propio catálogo npm que ya usa `packages-registry.ts`
  (`https://registry.npmjs.org/...`; para pi y gentle: `<pkg>/latest`).
- pi CLI trae la maquinaria de actualización hecha: `pi update [--self|--extensions|--all]`,
  `pi remove <source>`, `pi install <source>`.
- «Parar sesiones»: pi corre **en proceso** (import ESM en el extension host); no hay proceso
  que matar. El gancho ya existe: `resetChatSession()` (`agent.ts:626`, `:821`), usado hoy
  cuando se instala/quita Gentle. Tras actualizar el runtime hace falta **recargar la
  ventana** para que el ESM recargado entre en el host.
- Posición de las notificaciones: el workbench pinta los avisos donde pinta los avisos
  (abajo a la derecha por defecto, no configurable por producto). Lo que sí es nuestro:
  un **elemento de la barra de estado (abajo-izquierda)** con el estado de actualizaciones,
  y el aviso con botón «Update». Decisión: aviso + botón + indicador en la esquina
  inferior izquierda; no se toca la posición global del workbench.

### P2 — packages: sin deshabilitar ni borrar hoy
- No hay `picode.packages.uninstall` ni disable: solo search/install (`extension.ts:624-655`).
- pi 0.87.1 guarda `packages` como **cadenas planas** en settings.json; el «paused» de 0.86
  ya no existe. La deshabilitación la gestiona el conector:
  - Deshabilitar = quitar la fuente del array `packages` de settings.json + recordarla en
    una lista propia del conector (storage de picode).
  - Habilitar = volver a añadirla (si faltan los ficheros, `pi install`).
  - Borrar = `pi remove <source>` + quitar el registro de deshabilitados (+ limpieza
    best-effort del directorio en node_modules del perfil).
- La UI de la sección es un widget dedicado: `pluginListWidget.ts` (núcleo). Se convierte a
  filas tipo tabla: Nombre · Versión · Origen · Estado · acciones (Disable/Enable, Uninstall).

### P3 — MCP Servers
- «Extensions» (renombrar): `mcpListWidget.ts:1540` (`extensionGroup`).
- No hay editar/quitar por servidor (solo Start/Stop/Enable/Disable; el único «quitar» es
  de servers aportados por plugins). Añadir: Edit y Remove. Los servers del perfil pi viven
  en `<perfil>/mcp.json` y `<carpeta>/.pi/mcp.json`; los del editor, en su mcp.json del
  usuario (se editan con las ayudas existentes de `mcp-add.ts` / configuración del núcleo).
- Marketplace: el botón «Browse Marketplace» hoy abre un modo de búsqueda interno que
  depende de `chat.mcp.gallery.serviceUrl` (no configurada → «Unable to load marketplace»).
  Decisión: el botón abre `https://mcp.directory` en el navegador externo.
- «Sistema de vscode»: el formato oficial de instalación web es `vscode:mcp/install?<json>`.
  El núcleo ya lo parsea (`mcpWorkbenchService.handleURL` → `mcp/install`), pero los
  abridores de URIs filtran por el protocolo del producto (`urlProtocol: "picode"`).
  Arreglo: aceptar también el esquema `vscode` con ruta `mcp/...` en los abridores del
  workbench. El registro del protocolo `vscode:` a nivel de sistema operativo (instalador)
  queda **fuera** a propósito: si hay un VS Code real instalado, secuestrarle el protocolo
  es una decisión de producto aparte.

### P4/P5/P6 — cadenas exactas localizadas
- «Generate Skill/Agent»: botón primario en `aiCustomizationListWidget.ts:1094/:1124`
  (`Generate ${typeLabel}`); suprimible por sección con `hideGenerateButton`.
- Dropdown «New Skill/Agent (Workspace)/(User)»: `buildCreateActions()` `:1120-1170`.
- «Plugins» como grupo dentro de Skills/Agents: `aiCustomizationListWidget.ts:1370/:1376`.
- «Uninstall Plugin» (popup): `aiCustomizationManagement.contribution.ts:525-564` (items) y
  `mcpListWidget.ts:1776-1783` (variante MCP). Se hace sensible al tipo: «Uninstall Skill»
  para skills, «Uninstall Agent» para agentes.
- «Install Chat Customization Extension»: `aiCustomizationManagement.contribution.ts:425-435`
  y `:464-475`. Fuera (Skills y Agents).
- Agents, categorías: grupos Workspace/User/Plugins/Extensions/Built-in en
  `aiCustomizationListWidget.ts:1374-1378`. Los agentes de Gentle-AI llegan del conector
  (`customizations.ts`, raíces `<perfil>/agents|subagents`; proveedor en `extension.ts:559`).
  Para Agents: solo esos, sin cabeceras de grupo.
- Overview, «Customize Your Agent»: banner en `aiCustomizationWelcomePagePromptLaunchers.ts:147-244`
  (gated por `showGettingStartedBanner`, `aiCustomizationWorkspaceService.ts:71`). Fuera.

### P7 — el modo «Agente» del chat
- `ChatMode.Agent` en `chatModes.ts:714`; incluido en el selector si `chat.agent.enabled`
  (`chatModes.ts:298-321`); el picker lo fuerza primero (`modePickerActionItem.ts:191-196`);
  el modo por defecto del input es Agent (`chatInputPart.ts:925`).
- Arreglo: «Agent» deja de ofrecerse en el selector y el modo por defecto pasa a Ask.
  El `ChatModeKind.Agent` se conserva internamente (código que depende del enum no se toca).

### P8 — MCP siempre activos en las tools
- El estado por defecto ya es «habilitado» (ausencia = enabled, `enablement.ts:76-95`), pero
  el memento del picker de tools (`chat/selectedTools`, `chatSelectedTools.ts:126-137`) puede
  tener deshabilitado un toolset MCP y eso llega a la petición (`chatWidget.ts:2553-2572`).
- Arreglo: los toolsets/herramientas MCP se tratan como siempre habilitados (ignorar sus
  entradas de deshabilitado del memento), y el picker no ofrece apagarlos.

## Decisiones registradas (no cerradas por el dueño, tomadas y explicadas al cierre)

- D1 · P1: notificación estándar + elemento de barra de estado abajo-izquierda; la posición
  de los avisos del workbench no se toca.
- D2 · P1: tras actualizar el runtime de pi o Gentle, se pide recargar la ventana (botón
  «Reload») porque el ESM del host no se recarga en caliente.
- D3 · P2: la deshabilitación es del conector (pi no la soporta en 0.87.1); el paquete sale
  del array `packages` y se recuerda para poder reactivarlo.
- D4 · P3.3: el botón de marketplace abre mcp.directory en el navegador; la galería interna
  del widget queda sin uso (no hay servicio de galería configurado).
- D5 · P3.4: se acepta el sistema `vscode:mcp/install` a nivel de editor; el secuestro del
  protocolo `vscode:` en el instalador de Windows es una decisión aparte.
- D6 · P4.1: el botón de la cabecera de Skills queda en uno solo («Browse Skill»).

## Unidades de trabajo (cada una, un commit con su prueba)

| # | Unidad | Puntos |
| --- | --- | --- |
| U1 | Saneado de cabeceras MCP en el editor (causa raíz del ByteString) | 9 |
| U2 | Modelos: carga al arrancar + refresco cada 5 min | 10 |
| U3 | MCP Servers: «Servers», editar/quitar, mcp.directory, sistema vscode | 3 |
| U4 | Packages: tabla con Disable/Enable/Uninstall (conector + núcleo) | 2 |
| U5 | Skills: Browse Skill, «Packages», «Uninstall Skill», fuera el botón de extensión | 4 |
| U6 | Agents: solo Gentle-AI sin categorías, fuera generar; Overview sin «Customize Your Agent» | 5, 6 |
| U7 | Chat: fuera el modo «Agente»; MCP siempre activos en las tools | 7, 8 |
| U8 | Notificaciones de actualización con botón Update (conector) | 1 |

Orden: U1 → U2 → U3 → U4 → U5 → U6 → U7 → U8 (U8 al final: toca `extension.ts`, como U2).
Verificación por unidad: pruebas del conector (`node --experimental-strip-types --test`) en
verde, typecheck 0 del conector y del núcleo, y al cierre compilación completa.

## Cierre (2026-09-28)

Ocho commits, uno por unidad (U5 y U6 comparten el suyo; el conector de U3 y U4
comparten `extension.ts`, así que su parte va junta y las piezas del núcleo van separadas):

| Commit | Unidad · puntos |
| --- | --- |
| `c7a5dcc5` | U1 · P9 — cabeceras MCP saneadas a ByteString (causa raíz: la raya del `nameLong`) |
| `3329b40d` | U2 · P10 — modelos resueltos al arrancar + reloj de 5 min en el conector |
| `721ea308` | U3 (núcleo) · P3 — «Servers», editar/quitar, mcp.directory, `vscode:mcp/install` |
| `dd242e20` | U7 · P7+P8 — fuera el modo «Agente», MCP siempre activos en las tools |
| `00f47b1f` | (higiene) — `IToolInvocation.parameters` pasa a `Record<string, unknown>` |
| `5693feea` | U4 (núcleo) · P2 — la tabla de Packages con acciones |
| `6d4dc502` | U3+U4 (conector) — `picode.mcp.editServer/removeServer` y `picode.packages.disable/enable/uninstall` |
| `ae123e61` | U5+U6 · P4+P5+P6 — Skills/Agents/Overview |
| `32ddb840` | U8 · P1 — notificaciones de actualización con botón Update |

Pruebas: 158 del conector en verde (11 ficheros + `updates-check`), typecheck del
núcleo y del conector en 0. Build completo en verde (4m 10s, `dev/build.sh`, PiCode 1.135.1 en `PiCode-Win32-x64/`): el empaquetado lleva dentro los símbolos nuevos comprobados — `picode.updates.show`, «updates available», `picode.packages.disable` en el conector; «Browse Skill», «Remove Server», «Uninstall {0}» (el tipo se pone en marcha) en la tabla NLS.

## Decisiones tomadas (resumen ejecutable)

- D1 · P1: los avisos del workbench van donde los pinta el workbench; la superficie
  «abajo-izquierda» es un elemento de la barra de estado con clic.
- D2 · P1: tras actualizar se ofrece «Reload Window»: el ESM de pi no se recarga en caliente.
- D3 · P2: la deshabilitación de packages es del conector (pi 0.87.1 no la trae); el
  paquete sale del array `packages` y se recuerda en `picode.disabledPackages`.
- D4 · P3.3: el botón de marketplace abre `https://mcp.directory` en el navegador.
- D5 · P3.4: el editor acepta `vscode:mcp/install?...` (solo rutas `mcp/`); reclamar el
  protocolo `vscode:` a nivel de instalador de Windows queda aplazado a propósito.
- D6 · P4.1: Skills tiene UN solo botón de cabecera («Browse Skill»).
- D7 · P9: no es el modelo; era la raya (U+2014) del `nameLong` viajando en el user-agent.
- D8 · P10: el núcleo resuelve los modelos al registrar el proveedor; el conector re-warma
  cada 5 min; el último modelo ya lo persistía el núcleo y ahora resuelve contra la lista
  que existe desde el arranque.
- D9 · P5.1: la lista de Agents muestra solo lo que aporta el conector; un agente creado
  con «New Agent (Workspace)/(User)» queda en su almacén y NO se ve en la lista — decisión
  literal del dueño; el filtro es una línea si cambia.
- D10 · (higiene) — `parameters: Record<string, any>` del upstream pasó a
  `Record<string, unknown>` con aserciones anotadas en los consumidores; el escáner lo
  exigía y `unknown` es el tipo honesto.
