# Ajustes de PiCode: inventario y destino

Este documento es el mapa de **todas** las opciones de configuración del producto: qué clave es,
para qué sirve, dónde aparece hoy y dónde debería aparecer. Lo que se decide aquí se aplica en el
código: el árbol de Ajustes del editor (`settingsLayout.ts`), lo que declara el núcleo
(`picodeConfiguration.ts`) y lo que declara el conector (`extensions/picode/package.json`).

> **Regla de oro:** solo un ajuste declarado por el **núcleo** entra en el árbol de Ajustes.
> `settingsEditor2.ts` construye ese árbol con grupos del núcleo, así que lo que declara una
> extensión queda para siempre bajo *Extensions › PiCode*, donde nadie lo encuentra. Ese fue el
> motivo de mover `picode.updates.check`, `picode.memory.enabled` y `picode.memory.binary` aquí.

## 1. Qué hay, clave por clave

### 1.1 IA y agentes

| Clave | Para qué | Dónde está | Destino |
| --- | --- | --- | --- |
| `picode.providers` | Proveedores de IA: id, endpoint, dialecto y clave | Ajustes › Chat › **Providers** | Chat Settings › *AI providers* |
| `picode.pi.runtime` | Qué pi responde: el incluido o el de la máquina | Ajustes › Chat › **Settings** | Chat Settings › *Your Pi* |
| `picode.pi.thinkingLevel` | Cuánto razona el modelo (`off`…`max`) | Ajustes › Chat › Settings | Chat Settings › *Model* |
| `picode.pi.reasoning` | Si el razonamiento se escribe en el chat | Ajustes › Chat › Settings | Chat Settings › *Model* |
| `picode.pi.disabledTools` | Herramientas del agente apagadas por nombre | Ajustes › Chat › Settings | Chat Settings › *Tools* |
| `picode.pi.projectMode` | Primera carpeta o toda el área del workspace | Ajustes › Chat › Settings | Chat Settings › *Context* |

### 1.2 Contexto y sesión

| Clave | Para qué | Dónde está | Destino |
| --- | --- | --- | --- |
| `picode.context.attach` | Enviar carpeta, archivo abierto y selección con cada mensaje | Ajustes › Chat › Settings | Chat Settings › *Context* |
| `picode.context.mode` | Cuánto viaja: `project` / `file` / `selection` | Ajustes › Chat › Settings | Chat Settings › *Context* |
| `chat.defaultModel` | Modelo de una conversación nueva (lo escribe el setup) | Ajustes del editor (no es nuestro) | Sin cambios |

### 1.3 Memoria y actualizaciones

| Clave | Para qué | Dónde está ahora | Destino |
| --- | --- | --- | --- |
| `picode.memory.enabled` | Recordar decisiones y convenciones entre sesiones | **Ajustes › Chat › Settings** (antes en Extensions) | Chat Settings › *Memory* |
| `picode.memory.binary` | Ruta a otro motor de memoria | Ajustes › Chat › Settings | Ajustes (infraestructura) |
| `picode.updates.check` | Buscar actualizaciones en segundo plano | **Ajustes › Chat › Settings** (antes en Extensions) | Chat Settings › *Updates* |

### 1.5 MCP

| Clave | Para qué | Estado |
| --- | --- | --- |
| `picode.mcp.servers` | Lectura heredada de servidores | **Oculta** (`included: false`). El almacén vivo es `<perfil>/mcp.json`, que escribe la página *MCP Servers* |
| `picode.mcp.enabled` | Interruptor heredado | **Oculta** (`included: false`) |

Se declaran ocultas, no se borran: una clave sin declarar que aparezca en `settings.json` produce el
aviso *Unknown Configuration Setting* — el editor regañando por una clave que escribió él mismo.

### 1.6 Estado interno de la cuenta (nunca en el árbol)

`picode.account.sessionEmail`, `.pendingRefreshToken`, `.pendingUid`, `.pendingEmail`,
`.pendingCode`, `.signOutOnStart`, `.signInOnStart`.

Son el traspaso entre la ventana de setup y el editor. Declaradas `included: false`: legibles por el
código, invisibles y no editables para el dueño.

### 1.7 Estado guardado (no son ajustes)

`picode.onboarding.done`, `picode.sessionsBackup.state.v1`, `picode.updates.lastCheck` y la lista de
paquetes deshabilitados viven en `globalState`. No se mueven a la configuración.

## 2. Permisos de herramientas: lo que ya está puesto

La política que pedía el documento de migración **ya es la del editor** (`chatSettings.ts`), y no hay
que configurarla para tenerla:

- **Ediciones** (`chat.tools.edits.autoApprove`): `**/*` aprobado, con **confirmación obligatoria** en
  `**/.git/**`, `package.json`, `Cargo.toml`, `.env`, `*.lock`, ficheros de proyecto y los de
  `.vscode/`, `.github/agents/` y `.claude/`.
- **Herramientas** (`chat.tools.global.autoApprove`): decide si *todo* se aprueba solo. Por defecto,
  no: PiCode pregunta antes de ejecutar.
- **Servidores MCP** (`chat.mcp.access`): si el chat puede usar servidores MCP, y
  `chat.mcp.allowedServers` limita cuáles.

### Dos desviaciones, a propósito

1. **No se aprueban terminales por adelantado.** El documento pedía permitir `ls`, `git status`,
   `npm test` sin preguntar. PiCode pregunta siempre: es la promesa del producto («te pregunta antes
   de hacer»), y una lista de comandos «seguros» envejece mal — `cat` sobre `.env` filtra secretos.
2. **`chat.mcp.autostart` sigue en `never`.** La guía pedía arrancar los servidores MCP con el
   editor. Se deja en nunca a propósito: arrancar servidores de terceros sin pedirlo es una decisión
   del dueño, y está a un ajuste de distancia.

## 3. Cómo se aplica un cambio

- Una clave nueva **visible** → declararla en `picodeConfiguration.ts` y añadir su glob a
  `settingsLayout.ts`, en el nodo que le toque.
- Una clave **interna** → `included: false`, nunca un glob en el árbol.
- Una clave que escribe el conector y lee el editor → se declara en el núcleo, no en el conector.
