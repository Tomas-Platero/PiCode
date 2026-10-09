# El harness de agentes en PiCode: cómo está integrado

> Documento de arquitectura, medido sobre el pack experimental **0.2.1-experimental**
> (número declarado 1.141.1, árbol de VS Code 1.135.0, pi 1.1.0). Fechas y commits citados.
> Si este papel y el código discrepan, gana el código — y este papel se corrige.

## 🤝 Primero, las palabras — porque hay dos "harness"

| Palabra | En el vocabulario del dueño | En el vocabulario de VS Code 1.141 |
| --- | --- | --- |
| **Host** | **pi**. El agente que ejecuta. Interno (el de PiCode) o externo (el de la máquina). | El agente que ejecuta. |
| **Harness** | La capa que organiza el trabajo por encima del host, hoy ejecutada por **pi** y sus paquetes. | El **harness de agente**: el proceso que mueve el bucle del agente (Copilot harness, harness picker). |

Hoy, en PiCode, **el papel de harness lo ejecuta pi**, con su ecosistema de paquetes.
Este documento describe cómo está montado.

---

## 🧩 Parte 1 — El harness que hay: pi, integrado en cinco capas

### 1. El runtime (lo que ejecuta)

- **Dónde**: `resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent`, dentro
  de la instalación. El pin vive en **un solo sitio**: `distribution/runtime.json`
  (hoy **1.1.0**). El SDK no es dependencia de compilación: se carga por `dynamicImport`
  en runtime, y los pocos miembros que se usan se tipan **estructuralmente**
  (`picode-source/extensions/picode/src/piSdk.ts`). Si el `createAgentSession` no está, se dice
  `no-sdk`; si la ruta no se puede leer, `unreadable` — dos frases distintas para dos
  problemas distintos.
- **Se usa como SDK**, no como CLI ni por RPC: el conector importa
  `createAgentSessionServices` / `createAgentSessionFromServices` y abre la sesión
  **dentro del proceso de la extensión**.

### 2. El perfil (lo que configura)

- **Dónde**: `data/pi-agent`, apuntado con `PI_CODING_AGENT_DIR` — la misma variable que
  cambia el perfil de cualquier pi. Nada se escribe nunca en el `~/.pi` externo.
- **Qué hay dentro**: `settings.json` (modelo por defecto, razonamiento, paquetes),
  `models.json` (endpoints y modelos), `auth.json` (credenciales, 0600), `mcp.json`,
  `skills/`, `sessions/` (las conversaciones, en fichero, por slug de proyecto).
- **Runtime interno o externo**: ajuste `picode.pi.runtime`. El externo se **conecta**
  (se lee, nunca se escribe) y el asistente de primer arranque ofrece **migrar** de él
  al interno — siempre a petición expresa del dueño. Una importación se niega a arrastrar
  paquetes vetados (`left-behind-packages.ts`).

### 3. El conector (lo que une el editor con pi)

`picode-source/extensions/picode` — la extensión única del producto, compilada por
`dev/build-connector.sh` y empaquetada dentro del editor. Sus módulos, por responsabilidad:

| Módulo | Qué hace |
| --- | --- |
| `agent.ts` | El participante `@pi` del chat: crea la sesión, traduce los eventos de pi al stream del chat (texto, thinking citado, tarjetas de herramientas), gestiona la cola de turnos por ventana, el steer, y **empuja** el estado a la píldora |
| `permissions.ts` | La puerta de permisos: `bash`, `edit`, `write` y toda tool `mcp__…` preguntan antes, con niveles (default/assisted); los comandos de solo lectura pasan sin preguntar |
| `mcp-provider.ts` / `mcpTools.ts` | Los servidores MCP del **editor** entran a pi como tools propias; los del perfil los carga pi con su conector builtin |
| `background-jobs.ts` / `background-cards.ts` | Los trabajos en background: tarjeta en el transcript y registro vivo para la píldora |
| `durable*.ts` | El puente con **pi-durable** (ver Parte 2): conversaciones que sobreviven un kill, subagentes como trabajo en fondo |
| `sessions-provider.ts` | La lista de sesiones del panel, leída de `sessions/` del perfil |
| `status-data.ts` / `status-view.ts` | El panel de estado: versión de pi, proveedores por origen, MCP por origen, uso y coste, git |
| `providers*.ts`, `models*.ts` | Declaración de endpoints y suscripciones; todo acaba en `models.json`/`auth.json` del perfil, que es lo que pi lee |
| `packages*.ts` | Los paquetes de pi (skills, agentes, extensiones), instalados en el perfil |
| `onboarding.ts`, `wizard*.ts` | El arranque: qué pi corre, migración, modelos |

### 4. Las superficies (lo que el dueño ve)

- **El chat**: `@pi` es el participante por defecto (`isDefault: true`, modos
  ask/agent/edit). El modelo lo elige pi, no el picker del editor (la API de modelos
  nativa sigue ligada al plan de Copilot — decisión documentada en
  `odd/tasks/picode-pi-native-chat.md`).
- **La píldora de estado** sobre el input: qué herramienta está usando, cuántos mensajes
  esperan turno (con *Cancel queued*), qué trabajos en background corren. El conector
  **empuja** (`picode.picodeAgentStatusChanged`); nada se sondea.
- **El panel de estado** (`picode.setup.status`): los datos que alimenta panel, página de
  Providers (proveedores del perfil como filas de solo lectura) y página de MCP
  (perfil + proyecto + descubiertos, con origen en cada fila).
- **Ajustes**: `picode.pi.*` (runtime, razonamiento — **show** por defecto —,
  herramientas desactivadas), `picode.mcp.*`, `picode.providers`.

### 5. Lo preparado pero aún sin enchufar

`src/vs/platform/agentHost/node/pi/` contiene el **puente hacia el agent host del editor**
(protocolo AHP): `piSession.ts` (abre una sesión de pi dentro del proceso del host) y
`piActionMapping.ts` (eventos de pi → acciones AHP). Falta la clase `PiAgent implements
IAgent` que lo una al contrato de 51 miembros, y con ella pi dejaría de vivir en la
extensión para vivir en el proceso host del editor. Está registrado como tarea abierta en
`odd/tasks/picode-pi-agent-host.md` (A2c-iv). Hoy no hay nada importando esos ficheros.

---

## 💾 Parte 2 — durable: el runtime que reemplaza al harness

`durable` es el runtime del agente, integrado en el propio árbol del editor
(`picode-source/durable`) y ejecutado por él.

- **Dónde**: `resources/durable`, junto a las dependencias que carga. Se ejecuta sobre
  el binario del propio editor en modo Node: una instalación es autocontenida.
- **Qué hace**: posee sus conversaciones en SQLite (`data/durable`, junto al perfil, nunca
  en la carpeta que una actualización reemplaza), sirve clientes locales por named pipe, y
  recupera un envío (submission) si el proceso muere a mitad de turno.
- **Cómo entra en el chat**: el conector delega en durable lo que no puede perderse; las
  tarjetas de background y de subagente dibujan su identidad.

---

## 🚫 Los caminos que NO existen (y no deben abrirse)

- **No hay superficie de Copilot en el editor**: el chat es `@pi` y nadie
  más. `defaultChatAgent` está a `null` y los ajustes de los subagentes de la familia
  Copilot se retiraron (commit `41185701`, ver `odd/tasks/picode-vscode-141.md`).
- **El perfil externo jamás se escribe**: conectarse es leer; migrar es una acción
  explícita del asistente.
- **Nada se sondea en la UI**: la píldora y las páginas se alimentan de empujes o de
  lecturas con caché; ninguna despierta el conector sola.
