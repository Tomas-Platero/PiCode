# Visión de PiCode — dicha por el dueño

> Este documento es del dueño, no del agente. Se conserva tal cual, y cualquier sesión lo lee
> antes de proponer nada. Si algo cambia, se cambia aquí y se dice.

## La visión

Coger VS Code/VSCodium, compilarlo tú mismo desde la fuente (no como binario ajeno), y
convertirlo en un editor propio — PiCode — donde pi es el agente nativo, no una extensión
añadida. Nada de Copilot en ningún sitio. Todo integrado como si el editor "siempre hubiera
sido así".

### 1. Arquitectura de instancias (ya construida)

PiCode soporta un pi interno (vive dentro del editor, lo mantiene PiCode) y un pi externo (el
que ya tenías instalado en tu máquina), totalmente aislados entre sí — cada uno con su propio
perfil, modelos, MCPs, credenciales. Al primer arranque, un wizard pregunta cuál usar; si
eliges interno, migra todo el contenido del externo (paquetes, skills, MCPs, sesiones) sin
tocar el externo.

### 2. Compilación propia, no binario ajeno

En vez de partir de un VSCodium ya compilado, el árbol propio vive versionado en este
repositorio — `picode-source/` — y se compila desde ahí con `dev/build.sh`. Así los
colaboradores pueden auditar y recompilar sin depender de un binario opaco.

> **Actualización (2026-09-27).** Los `patches/vscodium/` + `patches/picode/` que describía
> esta frase **se retiraron**: sus cambios son ya el código de `picode-source/`. El pin
> `upstream/stable.json` (1.135.0) sigue siendo la procedencia, y el número que declara el
> producto se sube aparte para que las extensiones no queden fuera del catálogo.

### 3. Quitar a Copilot, poner a pi (el bloque grande, en curso)

El objetivo literal: `@pi` ocupa el hueco donde vivía Copilot en el editor — Chat Participant
por defecto, sus propias tools, MCP nativo, sin ningún resto de branding/menús de Copilot. El
panel custom viejo se disuelve: las categorías pasan a las Settings nativas, y
skills/paquetes/MCPs pasan al hub nativo "Agent Customizations" en vez de mantener una segunda
superficie aparte.

Estado real: el envío ya funciona en el CHAT nativo (dos bugs reales encontrados y arreglados
con logs de ejecución), pero `@pi` responde con "Language model unavailable" porque todavía no
está conectado a ningún proveedor de modelos.

### 4. Sistema de proveedores de modelos (lo que falta ahora)

No quieres un modelo fijo — quieres poder conectar los proveedores que elijas tú (ChatGPT,
Claude, tu proveedor actual con 163 modelos, OpenRouter, etc.), por OAuth (cuentas Pro/Max) o
por API key. pi ya trae este sistema hecho y maduro (`/login`, OAuth o API key por proveedor,
decenas soportadas de fábrica) — el trabajo real es **exponerlo en la UI del editor** (al
estilo "Add provider" de PI-Desktop), no reconstruirlo desde cero.

### 5. Mejoras de UX pendientes (del panel original, aún no abordadas)

Logo propio de PiCode, autocompletado de skills con "/", rediseño del catálogo de paquetes,
unificar categorías de Compactación/Razonamiento/Reintentos, mensajes de carga de sesión más
claros, cambios de configuración instantáneos.

---

## Cómo encajan el punto 1 y las frases posteriores (aclarado por el dueño, 2026-09-24)

El agente creyó ver una contradicción y no la había. La frase del dueño, que la resuelve:

> "PiCode podrá usar su pi integrado o si el usuario quiere, conectarse a un pi externo (ya
> sea por rcp o por websocket o por como deje pi) para poder usar sus datos y su
> configuración que vive externamente a PiCode. O darle en un mal caso la oportunidad de
> migrar toda la config que tiene el Pi del Path (externo) al pi interno."

Tres cosas distintas que no hay que confundir:

| | Qué es | Quién decide |
| --- | --- | --- |
| **pi integrado** | El de PiCode. Es el **host** y lo que se usa **por defecto** | Nadie: es lo que hay |
| **Conectarse a un pi externo** | Usar los datos y la configuración de un pi que vive fuera, **donde están**, hablando con él por el protocolo que exponga (RPC, WebSocket…) | El usuario, si quiere |
| **Migrar** | Copiar la configuración del pi del PATH al interno | El usuario, y solo como **oportunidad que se ofrece** |

**Lo absoluto es una sola cosa, y es la dirección:** nada se **escribe** en el pi externo. Lo
demás es opcional y siempre a petición:

- Conectarse **no es copiar**: los datos se usan donde viven.
- Migrar es una oferta explícita, nunca algo que ocurre solo ni por defecto.
- Por defecto, PiCode corre su pi y su perfil.

Así que el punto 1 **no se tira**: se reinterpreta. El asistente que pregunta y la migración
siguen teniendo sentido, como **opciones**, no como camino obligatorio.

### Lo que esto corrige de lo que hizo el agente

El agente convirtió «nunca vamos a añadir nada del path» en un **nunca** absoluto, y quitó la
importación y el asistente. Eso era de más: lo que no puede haber es **escritura hacia fuera**
ni **entrada sin pedirla**. Se restaura, pues, el derecho a ofrecerlo.
