# pi y Gentle-AI: qué son, y cómo se integran en PiCode

> Documentado a partir de las fuentes que pasó el dueño (`pi.dev/docs/latest`, el árbol de
> docs de `Gentleman-Programming/gentle-ai`, `vastsa/PI-Desktop`) y de los paquetes
> **instalados en la máquina**, que son la fuente que manda. Se conserva para no volver a
> investigarlo ni para volver a suponerlo.

## El vocabulario, tal como lo fija el dueño

| Palabra | Qué es |
| --- | --- |
| **Host** | **pi**. El agente que ejecuta. PiCode tiene el suyo **integrado** (interno), y puede conectarse a uno **externo**. |
| **Harness** (orquestador) | **Gentle-AI**. La capa que organiza el trabajo por encima del host. También puede ser interno o externo. |
| **Configuración** | Cada Host y cada Harness tiene la suya, y esa configuración es interna o externa **con él**. |

Cuatro combinaciones posibles, y ninguna es «la buena»: Host interno + Harness interno es lo
que PiCode trae por defecto; las otras tres son elecciones del usuario.

---

# Parte 1 — pi (el Host)

## Qué es

`@earendil-works/pi-coding-agent`. Un agente de código que corre en Node, con su propio bucle
de agente, sus herramientas (leer, editar, ejecutar, buscar) y su catálogo de proveedores de
modelos. Se usa de tres maneras: **interactivo** (su TUI), **RPC** (`pi --mode rpc`, JSON por
stdio) y **SDK** (importado dentro de otro proceso, que es como lo usa PiCode).

## Dónde vive su configuración

Un directorio de perfil —`~/.pi/agent` por defecto— que la variable **`PI_CODING_AGENT_DIR`**
cambia. Eso es lo que permite que PiCode tenga su perfil propio y aislado.

| Fichero | Qué guarda |
| --- | --- |
| `settings.json` | Ajustes: modelo por defecto, nivel de razonamiento, paquetes activos… |
| `models.json` | Endpoints propios y modelos declarados a mano |
| `auth.json` | **Credenciales** (0600): claves de API y tokens OAuth |
| `models-store.json` | Caché de tokens refrescados y de catálogos de proveedor |
| `mcp.json` | Servidores MCP |
| `skills/`, `agents/`, `prompts/` | Habilidades, subagentes y plantillas |
| `sessions/` | Las conversaciones, en fichero |

## Proveedores de modelos (lo importante para PiCode)

**Medido en ejecución contra la instalación real: 41 proveedores**, cada uno con su forma de
autenticarse. **Ocho admiten cuenta (OAuth)**, y siete de ellos admiten además clave:

| Admite cuenta | Y clave |
| --- | --- |
| `anthropic` (Claude Pro/Max), `openai-codex` (ChatGPT), `github-copilot`, `xai`, `meta`, `kimi-coding`, `openrouter`, `radius` | todos menos `openai-codex`, que es solo cuenta |

El resto (OpenAI, Google, DeepSeek, Mistral, Groq, Cerebras, Together, Fireworks, NVIDIA,
Hugging Face, Z.AI, MiniMax, Qwen, Xiaomi, Moonshot, Bedrock, Vertex…) son **clave de API**.

- El login se hace con **`/login`** (con nombre: `/login xai`), y `/logout` borra. En modo
  no interactivo: `--api-key` o variables de entorno.
- **Orden de resolución**: `--api-key` → `auth.json` → variable de entorno → clave del
  proveedor en `models.json`.
- Un proveedor nuevo se declara en `models.json`; si es OpenAI-compatible basta con
  `baseUrl` + `api` + `models[]`. Los dialectos usables en JSON son cuatro:
  `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`.
- Los flujos OAuth son de pi: navegador con retorno local, **código de dispositivo** (Meta) y
  dominio de GitHub Enterprise (Copilot). Una extensión puede añadir el suyo con
  `pi.registerProvider(id, { oauth: { name, login, refreshToken, getApiKey } })`.

**Consecuencia para PiCode: el sistema de proveedores no hay que construirlo, hay que
enseñarlo.**

## Lo que pi carga (y de dónde)

- **Habilidades**: `SKILL.md` en `~/.pi/agent/skills/`, `.pi/skills/`, `.agents/skills/` y en
  los paquetes. Frente-materia: `name` (≤64, minúsculas y guiones) y `description` (≤1024).
- **Subagentes**: ficheros `.md` en `~/.pi/agent/agents/` y `.pi/agents/`.
- **Plantillas de prompt**: `~/.pi/agent/prompts/*.md` y `.pi/prompts/*.md`. El nombre del
  fichero es el comando (`review.md` → `/review`).
- **Paquetes**: `pi install npm:…` o `git:…`. Un paquete de pi declara lo que trae en la
  **clave `pi` de su `package.json`**: `extensions`, `skills`, `prompts`, `themes`.

## Las dos instalaciones de esta máquina (medido)

| Ruta | Versión | Para qué |
| --- | --- | --- |
| `~/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent` | **0.86.1** | El paquete que pi gestiona para sí mismo |
| `%APPDATA%/npm/node_modules/@earendil-works/pi-coding-agent` | **0.87.1** | El pi del PATH, con el que se desarrolla PiCode |

Sus catálogos de proveedores son **idénticos** (41 y los mismos 8 con cuenta). La versión
publicada de las docs va por 0.87.1; el paquete local documenta 0.86.1.

---

# Parte 2 — Gentle-AI (el Harness)

## Ojo con el nombre, que induce a error

- **`github.com/Gentleman-Programming/gentle-ai`** es el **CLI en Go** que lo instala.
- El **paquete de pi** se llama **`gentle-pi`** (marca *gentle-shell*) y es el que pi carga.

## Cómo se carga

Por la **clave `pi` de su `package.json`**: `extensions`, `themes`, `prompts`, `skills`. No
declara `commands`, `mcp` ni `hooks`.

## Qué trae

| Pieza | Cuántas | Dónde |
| --- | --- | --- |
| **Habilidades** | 13 | `skills/*/SKILL.md` |
| **Subagentes** | 23 | `assets/agents/*.md` — los instala su CLI en `~/.pi/agent/agents/` |
| **Cadenas** | 4 | `assets/chains/*.chain.md` |
| **Plantillas de prompt** | 1 | `prompts/skill-creation.md` |
| **Temas** | 3 | `themes/` |
| **Instrucciones del orquestador** | 5 | `assets/orchestrator*.md` — **inyectadas en tiempo de ejecución**, no son ficheros que pi descubra |
| **Extensiones** | 13 | Registran las herramientas de review, los subagentes, la TUI… |
| **Binario de review nativo** | 1 | `.gentle-ai/v3.7.0/gentle-ai.exe`, compilado en Go |

Los 23 subagentes se reparten así: 3 de delegación, 4 lentes de revisión, 3 de «judgment day»
y 13 del ciclo SDD.

## Qué espera del entorno

- **Node ≥ 24** y **Go 1.25.10+** — porque **compila su binario en la instalación**.
- Sus propios directorios: config en `~/.pi/gentle-ai`, y respeta `PI_CODING_AGENT_DIR` para
  el perfil del agente.
- Un **CLI propio**, nunca desde el PATH: siempre el suyo, dentro del paquete.
- **No trae MCP ni hooks declarativos.** Los MCP llegan por paquetes compañeros; los hooks
  son código dentro de sus extensiones.

## Memoria

**Engram** no viene dentro: es un **paquete compañero** (`gentle-engram`) que aporta las
herramientas de memoria (`mem_*`). PiCode lo trata como una herramienta más de pi.

---

# Parte 3 — Cómo encaja en PiCode

## Lo que hay que respetar

1. **El Host interno es lo que hay por defecto**, y su perfil es el de PiCode.
2. **Nada se escribe en el Host externo.** Conectarse a él es usarlo donde está; traer su
   configuración es una **opción que se ofrece**, nunca algo que ocurre solo.
3. **El Harness vive donde vive su Host**: Harness interno con Host interno; y si alguien
   conecta un Host externo, su Harness es el de allí.
4. **El Harness no se reimplementa.** Es un paquete de pi: se instala y pi lo carga. PiCode
   lo que hace es **enseñarlo** — sus habilidades, sus agentes — en la superficie del editor.

## Lo verificado, y con qué

- Catálogo de proveedores: **en ejecución**, contra las dos instalaciones.
- Ficheros y esquemas de pi: sus **docs locales** (0.86.1) y las publicadas (0.87.1).
- Gentle-AI: el **paquete instalado** (`gentle-pi`), que manda sobre el repositorio.
- Cómo lo hace otro producto real: **PI-Desktop**, que deriva sus proveedores OAuth del
  propio pi y guarda los secretos fuera del renderer.

## Lo que NO está verificado

- Que el SDK de pi cubra todo lo que el host de agentes del editor pide (queda por probar
  `materializeChat`, y lo demás ya está enfrentado y encaja).
- Cómo se comporta Gentle-AI cuando el perfil es el de PiCode y no el suyo.
- El paquete de Gentle-AI de la máquina es la versión **v3.7.0**; sus docs de GitHub pueden
  ir por delante.
