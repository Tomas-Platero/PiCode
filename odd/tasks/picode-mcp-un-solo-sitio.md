# Feature: los servidores MCP, en un solo sitio

## Goal

> «Tenemos dos sitios donde configuramos mcp's, esto no me gusta, haz que solo sea en Agent
> Customization for Local y que sea con el form que tiene en settings > picode > mcp»

Hoy los servidores MCP de pi se configuran en **dos** pantallas:

1. **Settings → PiCode → MCP** (`picode.mcp.servers`, más el interruptor `picode.mcp.enabled`). Es
   la buena: su formulario («Add server» → nombre, dónde corre, dirección o comando, token) escribe
   el ajuste, y el conector lo baja a `data/pi-agent/mcp.json` en el formato que pi acepta.
2. **Agent Customizations for Local → MCP Servers**. Es la del editor (su `McpListWidget`), y en la
   práctica sale **vacía** —«No MCP servers configured»— porque los servidores de pi no son los del
   editor.

Queda **una**, la de Agent Customizations, y usa **el formulario de la 1**.

## Lo comprobado antes de tocar nada (14 comprobaciones)

- **El punto de enganche existe y es limpio**: `aiCustomizationManagementSectionRegistry.ts` acepta
  contribuciones (`register({ id, label, icon, description, supportsHarness, create })`) y el editor
  ya las consulta *antes* de pintar la sección
  (`aiCustomizationManagementEditor.ts:461`: `registry.get(id, harness) ?? registry.getDefault(id)`).
- **Pero el built-in no se retira solo**: el editor crea **siempre** el contenedor del MCP
  (`:992`, `mcpListWidget`) y su visibilidad se decide sin mirar si hay contribución (`:2012-2013`);
  el foco también prefiere el built-in (`:2285`). Sin arreglar esto, una contribución **añadiría** una
  segunda lista, en vez de sustituir.
- **Los cuatro verbos ya existen y son el formulario**: `picode.mcp.addServer` (sin argumentos),
  `picode.mcp.editServer(name?)`, `picode.mcp.removeServer(name?)`, `picode.mcp.toggleServer(name?)`
  (`extension.ts:588-613`, registrados en `:1074-1109`). El widget no necesita ningún formulario
  nuevo: **llama a estos**.
- **La forma de cada servidor** (`picodeConfiguration.ts:145-176`): `name` y `target` obligatorios,
  `transport` (`http` = remoto con dirección / `stdio` = local con comando), `args` (separados por
  espacios) y `key` (el token).
- **El estado de encendido no vive en el ajuste**: `picode.mcp.toggleServer` lo escribe en los
  `mcp.json` del perfil (`mcpServersTextWithToggled`, `extension.ts:1109-1122`). Quien ya sabe el
  estado de cada servidor es **la vista de estado**: `picode.status.data` (`status-data.ts` +
  `status-view.ts`), que es lo que el panel ya pinta. El widget debe leer de ahí, no abrir ficheros.
- **Retirar el ajuste de Ajustes exige poner sus valores por defecto en las lecturas**: hoy el
  `true` de `enabled` y el `[]` de `servers` los aporta la **declaración**. Fuera de Ajustes, cada
  lectura tiene que llevar el suyo.

## Decisión

- La **pantalla** única es Agent Customizations → MCP Servers, con un widget propio de PiCode que
  **sustituye** al del editor.
- El **formulario** es el que ya existe (los cuatro comandos). Ni un diálogo nuevo.
- Las **dos declaraciones** (`picode.mcp.enabled`, `picode.mcp.servers`) dejan de aparecer en
  Ajustes; el ajuste sigue siendo el almacén, y el conector sigue leyéndolo igual.
- La fila del **panel de estado** no se toca: ahí el interruptor es un mando de estado, no un sitio
  de configuración (decisión anterior del dueño).

## Tareas

- [ ] **1. Sustituir, no sumar**: que una sección con contribución **no** pinte su widget de serie
      (creación, visibilidad y foco del built-in en `aiCustomizationManagementEditor.ts`).
- [ ] **2. El widget de PiCode**: lista de servidores (nombre, dónde corre, dirección o comando,
      y encendido/apagado leído de `picode.status.data`), botón **Add server** y acciones de fila
      **Edit / Remove / Enable–Disable**, todas llamando a los comandos existentes. Los textos, en
      inglés y de usuario; nada de rutas ni de claves internas.
- [ ] **3. Un solo sitio**: quitar las dos entradas de `picodeConfiguration.ts` y poner el defecto
      en cada lectura (`enabled` → true, `servers` → lista vacía).
- [ ] **4. Verificar y cerrar**: tipos, tests, y una build para que el pack lo lleve; commits por
      unidad.

## Fuera de alcance

- El **formulario** en sí (los cuatro comandos): se reutiliza tal cual.
- El **panel de estado** y su interruptor.
- Lo que el editor haga con *sus* servidores MCP (otro agente, otra cosa): su pantalla no se borra,
  solo deja de ocupar la sección de PiCode.
