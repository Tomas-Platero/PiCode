# Feature: pi dentro de «Agent Customizations for Local»

## Goal

Que el hub nativo de personalizaciones muestre **lo que pi ya tiene** en disco
—skills, agentes, prompts, paquetes— sin reimplementarla y sin duplicar ficheros, y
**sin una extensión que lo haga**.

> **Corrección de rumbo (decidida por el dueño).** La vía de esta feature **no** es que una
extensión registre `chat.registerChatSessionCustomizationProvider`. El **host de agentes del
core ya descubre personalizaciones él solo**
(`src/vs/platform/agentHost/node/copilot/sessionCustomizationDiscovery.ts`), con una tabla
fija de directorios. Conectar pi es **extender esa tabla**, que es core y no
necesita extensión ninguna. Las tareas H1–H6 de abajo quedan **sustituidas** por D1–D3.

## Hallazgo que ordena todo (D3, ya auditado)

El hub es agnóstico del agente y **registrable desde una extensión** por la API propuesta:

- `chat.registerChatSessionCustomizationProvider(chatSessionType, metadata, provider)` en
  `src/vscode-dts/vscode.proposed.chatSessionCustomizationProvider.d.ts`.
- Métodos: `provideChatSessionCustomizations(sessionResource, token)` (devuelve los items) y
  `provideSourceFolders(sessionResource, type, token)` (dónde crear los nuevos).
- Tipos: `ChatSessionCustomizationType.{Agent, Skill, Instructions, Prompt, Hook, Plugins}`.
- Puente: `mainThreadChatAgents2.ts:850` → `registerExternalHarness`.
- Requiere `enabledApiProposals: ["chatSessionCustomizationProvider"]`.

Las secciones del hub son **fijas** (Agents, Skills, Instructions, Prompts, Hooks, MCP
Servers, Plugins; Tools oculto en Local). Un tipo custom no crea sección nueva, así que el
catálogo de **proveedores** no cabe aquí: necesita otra superficie (ver la feature de
proveedores).

## Decisions

1. **Se muestra lo que existe; no se copia nada.** El hub lee de las rutas donde pi ya
   escribe. Duplicar ficheros crearía dos fuentes de verdad.
2. **Se reutiliza `discoverSkills()`** (`src/skills.ts`, que ya distingue fuentes `pi`,
   `package` y `project`) en vez de escribir un segundo descubridor.
3. **Los desajustes se declaran, no se disfrazan.** Las *chains* y los temas no tienen
   sección: se quedan fuera del hub y se dice por qué. Las instrucciones inyectadas y los
   hooks se pueden *mostrar*; no se finge que el hub los gobierna.
4. **Los proveedores no van aquí.** No hay sección, así que el catálogo vive en su propia
   feature (`picode-providers.md`).
5. **`enabledApiProposals` en el manifiesto** de la extensión, como en la fase E se aprendió
   a hacer con `defaultChatParticipant`.

## Cómo entra, medido

`sessionCustomizationDiscovery.ts` descubre desde el host con dos tablas de raíces de
búsqueda (`searchRoots`, líneas 121-141) y una de ficheros fijos, y **todas son convenciones
de Copilot y Claude**:

| Ámbito | Directorios que conocía |
| --- | --- |
| Proyecto | `.github/agents`, `.claude/agents`, `.github/skills`, `.agents/skills`, `.claude/skills`, `.github/instructions`, `.github/hooks` |
| Usuario | `~/.copilot/agents`, `~/.agents/skills`, `~/.copilot/skills`, `~/.copilot/instructions`, `~/.copilot/hooks` |
| Ficheros fijos | `.github/copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.claude/CLAUDE.md`, hooks de `.github/copilot` y `.claude` |

**Las rutas de pi no estaban en ninguna.** Y `DiscoveredType` solo tiene
`Agent | Skill | Instruction | Hook | AgentInstruction`: **no hay `Prompt`**, así que los
prompt templates de pi (`.pi/prompts`, `~/.pi/agent/prompts`) no se pueden declarar sin
mentir sobre su tipo.

## Tasks

- [x] D1 Añadir las raíces de pi a la tabla: `.pi/agents`, `.pi/skills` (proyecto) y
      `~/.pi/agent/agents`, `~/.pi/agent/skills` (usuario).
- [ ] D2 Verificar en ejecución que el hub lista los agentes de pi
      (`~/.pi/agent/agents`).
- [ ] D3 Las **skills de paquete** (las de cualquier `pi install`)
      viven en `~/.pi/agent/npm/node_modules/<paquete>/skills`, que la tabla no puede
      expresar porque no hay globs. Necesita una raíz nueva que lea la lista de paquetes de
      pi, o una tabla con glob. **Es el hueco que queda.**

### Por qué D1 importa más de lo que parece

Además de las rutas de pi, esta tabla es la que hace que un harness instalado sea
visible **sin que él tenga que saber nada del editor**: su instalador ya deja sus
subagentes en `~/.pi/agent/agents`, así que basta con que el core mire ahí. Cero código en
la extensión, que es exactamente lo pedido.

## No medido

Nada todavía: la fase está sin empezar. La API es **propuesta**, así que su efecto solo se
ve con el editor en marcha, y esa verificación se hará como en las fases E y F: log de
`exthost.log` como prueba.

## Fuera de alcance

- Sección de proveedores en el hub (no existe; ver `picode-providers.md`).
- Registrar hooks o instrucciones inyectadas: no son ficheros que pi descubra.
