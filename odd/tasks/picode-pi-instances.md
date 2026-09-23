# Feature: two Pi instances, isolated, with a one-shot import

## Goal

Support two ways of running Pi — PiCode's **internal** pi and the **external** one the
owner already has — as instances that are **completely independent in all their
configuration**: models, providers, MCPs, profile, packages, skills, credentials and
memory. Choosing one must make everything the editor loads come from that instance, with
nothing from the other leaking in. And the internal one must be able to **import** the
external one's configuration once, as a copy, not as a continuous sync.

## What is already true (verified, not assumed)

- `picode.pi.runtime` already chooses **which program runs**: `managed` (PiCode's own,
  installed under `resources/pi-runtime`, pinned in `runtime.json`), `path` (the one on
  `PATH`) or `custom` (a path the owner gives). The settings row and the wizard ask for it.
- `picode.pi.transport` chooses **how that program is loaded**: as a child process over
  JSON on stdio (`rpc`) or inside the editor through pi's SDK (`embedded`).
- **The profiles are not separated today.** Both instances read and write `~/.pi/agent`:
  `resolveAgentDir()` (`src/transcription.ts:131`) answers `PI_CODING_AGENT_DIR` when set,
  otherwise `~/.pi/agent`, and nothing in the extension sets it. The SDK client passes
  `agentDir: this.options.agentDir ?? sdk.getAgentDir()` (`pi-sdk-client.ts:416`), which
  lands on the same place.
- pi itself honours `PI_CODING_AGENT_DIR`: its own packages read their configuration from
  `<agent dir>` (the MCP adapter's README states its files are read from
  `$PI_CODING_AGENT_DIR/mcp.json` when that variable is set).

## The architecture

**An instance is a pair: a program and a profile.** The program is already chosen; this
feature adds the profile and binds the two together, so there is exactly one place that
answers "what is this instance using".

| | Internal instance | External instance |
| --- | --- | --- |
| Program | `resources/pi-runtime` (PiCode's, updatable from the settings tab) | whatever `picode.pi.runtime` points at (`PATH`, or a path the owner gives) |
| Profile | `<distribution>/data/pi-agent` — inside PiCode's own portable profile | `PI_CODING_AGENT_DIR` if the owner set it, otherwise `~/.pi/agent` |
| Who writes it | PiCode and its pi | the owner, and every other pi tool on the machine |
| PiCode's access | read and write | **read-only**, forever |

**One resolver, used by every reader.** A new module owns the answer:

```text
instanceAgentDir(runtime)  ->  the profile directory of the selected instance
                               (the internal one, or undefined so pi uses its own)
```

`undefined` is the honest answer for the external instance: it means "do not set the
variable and do not pass a directory", so pi resolves its own default exactly as it does
when run from a terminal. Everything that reads or writes a profile goes through this
resolver, and that is the whole isolation mechanism:

- the RPC child's environment (`PI_CODING_AGENT_DIR` in `env`),
- the SDK client's `agentDir` (`pi-sdk-client.ts`, already a parameter),
- the settings service (`PiSettingsService.create({ agentDir })`, already a parameter),
- the skills discovery (`discoverSkills({ agentDir })`, already a parameter),
- the files read directly today: `auth.json` (chat-view) and `mcp.json` (extension).

Nothing else may call `resolveAgentDir()` directly for instance-bound work; a test asserts
the resolver is the only path, so a new reader cannot quietly reintroduce the shared
profile.

**Why the profile must live inside PiCode, beyond isolation.** It is the unit the paid
service is going to sync (`AGENTS.md`, "El programa es gratis; lo que se vende es la
nube"). A profile shared with the machine is neither a product's to upload nor safe to
overwrite.

## The import

A one-shot copy, never a sync. Four steps, in this order:

1. **Scan** the external profile and report what it holds, without copying anything:
   providers with stored credentials (names and counts, **never the secret values**),
   configured models, MCP servers, package list, skills, and the approximate size of the
   package tree.
2. **Choose** what comes across. Credentials are a separate, explicit decision: the copy is
   never a side effect of asking to import.
3. **Copy** into the internal profile, item by item, and **report each item**. A target that
   already has content is not overwritten without saying so. The import is repeatable.
4. **Install the packages** the copied list names, through the install path that already
   exists, into the internal profile — because pi owns that layout and the copy is of a
   *list*, not of a tree of `node_modules`.

After the import the two instances keep running isolated: no re-sync, no shared file, and
the external profile has not been written to.

### The safety rule that orders all of it

**The internal profile is never switched on empty.** An internal instance with no
credentials cannot talk to a model, and with no packages it has no Gentle AI, no skills and
no MCPs — that is not isolation, it is a broken editor. So: import first, or start from
scratch **on purpose** and say so, and only then move the profile. This is a rule, not a
preference, and the feature document states it because the obvious order is the wrong one.

Starting from scratch is possible today with one command in a terminal, which writes into
the internal profile because that is the agent directory it is given:

```bash
PI_CODING_AGENT_DIR=<distribution>/data/pi-agent pi     # then /login
```

Creating credentials **from inside the editor** is not possible yet: it needs pi's
interactive bridge (`extension_ui_request`), which is unimplemented. That is Fase 4, and it
is what will eventually make an empty internal profile a first-class start.

## Slices

| Slice | What it delivers | Why in this order |
| --- | --- | --- |
| 1. The resolver and the scan | `instanceAgentDir()` + a read-only inventory of the external profile, with tests. **No behaviour change**: nothing is switched, nothing is copied | The foundation, and the only part that is safe on its own |
| 2. The import | Scan, choose, copy, report; credentials separate; repeatable | Must land **before** the switch, or the switch leaves the editor without credentials |
| 3. The switch | The managed instance gets the internal profile end to end (RPC env, SDK `agentDir`, settings service, skills discovery, `auth.json`, `mcp.json`), with a row that says which profile is in use | The moment the instances become independent |
| 4. The interactive bridge (`extension_ui_request`) | pi can ask the editor for input — select, confirm, input, editor — which is what makes a provider login possible **from inside the editor** | Promoted ahead of the polish at the owner's request (2026-09-23), because it is what lets the first-run wizard work end to end: an empty internal profile only becomes a first-class start once credentials can be created here. It also unlocks models, providers and MCP authorisation, so it pays twice |
| 5. Polish | The import's progress, sizes, and a second import that reports what changed | After the isolation is real and the empty start is possible |

### The first run must not require a terminal

The owner's words: "mi idea era que el wizard de primer arranque (elegir tipo de pi +
activar gentle-ai) funcione todo dentro del editor, sin pasar por terminal", and "asegurarnos
de que el wizard no dependa de hacer login por terminal como paso intermedio".

The wizard asks two questions and installs what the answers name. It has to be completable
**entirely inside the editor**, so no path through it may end in "now run this command in a
terminal":

- bringing Gentle AI in, and installing and updating the internal pi, already happen in the
  editor through the existing install path;
- an external profile's configuration arrives through the import (slice 2);
- **credentials for an empty internal profile are the one case that still needs the bridge**
  (slice 4). Until it exists, an empty start is possible but only from a terminal, and the
  wizard must **say so before offering that path** rather than leaving the owner at a dead
  end.

The terminal command recorded below stays in this document as the interim escape hatch, and
not as the intended way in.

## Out of scope

Syncing anything to the cloud. Auto-updating the external instance. Writing to the external
profile for any reason. Migrating sessions: a session belongs to the profile that made it,
and moving them is a separate, deliberate decision.

## Tasks

Worked in this order. A task is checked only when its outcome and its checks were
observed; every task closes with one work-unit commit on the feature branch, recorded here
as evidence.

- [x] **T1 — El resolutor y el escaneo.** `instanceAgentDir(extensionUri, runtime)` (managed
  → `<distribution>/data/pi-agent`, path/custom → `undefined`) y `scanProfile(agentDir)` con
  un inventario de solo lectura: paquetes, **nombres** de credenciales, modelos, MCPs,
  skills, memoria y sesiones. Parsers puros separados de las lecturas. Invisible en el
  producto: nada cableado. `1835df4`, 22 suites verdes, 15 comprobaciones.
- [x] **T2 — La copia de un perfil.** `importProfile({from, to, selection, onProgress})` en
  `src/instance-import.ts`: copia elemento a elemento hacia el perfil interno — ajustes
  (incluida la lista de paquetes), modelos, MCPs, skills, memoria — y **credenciales solo si
  se piden aparte**, informando `declined` y no `absent` para que la razón se vea. El origen
  solo se lee por construcción (las únicas escrituras son `copyFileSync` y `writeFileSync`
  bajo el destino), los directorios se fusionan sin borrar nada que la importación no haya
  puesto, y mismo origen y destino se rechaza antes de escribir. Las **sesiones quedan fuera**.
  `3549bb3`, 23 suites verdes, 16 comprobaciones.
- [x] **T3 — La fila de importación.** Una acción en el editor que enseña el inventario de
  T1, deja elegir qué viene, marca las credenciales como decisión aparte, ejecuta T2 y
  **informa de cada elemento**. Sin terminal en ningún paso.
  - [x] **T3a — El flujo del comando.** `picode.piChat.importProfile` («PiCode: Importar el
    perfil de tu pi»): resuelve los dos extremos, rechaza antes de escribir nada y en el
    orden en que el dueño descubriría el problema (no hay perfil, no tiene nada, o son el
    mismo o uno contiene al otro), enseña el inventario, copia con progreso e informa por
    elemento. Las credenciales salen marcadas y **sin marcar por defecto**. La guarda de
    solapamiento (`path.relative`) es lo que mantiene toda escritura bajo el perfil de
    PiCode. `8197a9a`, 24 suites verdes, 19 comprobaciones.
  - [ ] **T3b — La fila en el panel**, con el mismo mecanismo que la fila que repite la
    configuración inicial (`kind: "action"` + `command`).
  - [ ] **T3c — Instalar los paquetes copiados** por el camino de instalación existente.
    Va **después de T4a**: ese camino lanza el pi, y si no apunta al perfil de la instancia
    elegida instalaría en el perfil equivocado — que es justo el cruce que este trabajo
    existe para evitar.
- [ ] **T4 — El interruptor.** El aislamiento de verdad: el perfil de la instancia elegida
  llega a todo sitio que lea o escriba un perfil, con una fila que dice qué perfil está en
  uso. **Guarda:** no se enciende sin credenciales; si no las hay, lo dice en vez de dejar el
  editor mudo.
  - [ ] **T4a — El resolutor en todos los sitios.** El perfil sigue al programa: `runtime`
    ya elige cuál corre, así que `managed` usa el perfil propio y `path`/`custom` el del
    dueño, sin ajuste nuevo. Los sitios, ya localizados:
    - se lanzan con `PI_CODING_AGENT_DIR`: `pi-rpc-client.ts:329` (el RPC),
      `chat-view.ts:1583`, y `pi-cli.ts:51` — **el instalador de paquetes**, el que más
      importa porque es el que escribe;
    - leen del perfil: `chat-view.ts:912` (la clave de NaN, una credencial),
      `extension.ts:188` (el servicio de ajustes), `extension.ts:1510` (el `mcp.json`),
      `pi-sdk-client.ts:416` (ya es parámetro);
    - no lo necesitan: `runtime.ts:298` (`--version`) y `:647` (instalar el runtime).
    Con un **test que impida el retroceso**: leer las fuentes y fijar qué ficheros pueden
    llamar a `resolveAgentDir()` directamente, para que un lector nuevo no reintroduzca el
    perfil compartido sin que salte.
  - [ ] **T4b — La guarda y la fila.** No encender el perfil interno vacío: si `managed` está
    elegido y no hay credenciales, decirlo y seguir con el perfil del dueño hasta que la
    importación o el login lo resuelvan. Y una fila que diga qué perfil está en uso, sin
    rutas.
- [ ] **T5 — El puente interactivo.** `extension_ui_request` atendido (los cuatro diálogos que
  bloquean, los métodos que no esperan respuesta, correlación por id, sin tiempos de espera
  propios) en **las dos** implementaciones — RPC y SDK embebido — para que el login de un
  proveedor se pueda hacer desde el editor. Es lo que quita el terminal del camino.
- [ ] **T6 — El asistente sin terminal.** El de primer arranque se completa entero dentro del
  editor: importar (T3) o empezar de cero. Mientras T5 no exista, si el perfil interno está
  vacío lo **dice antes** de ofrecer ese camino, y no deja al dueño en un callejón sin salida.
- [ ] **T7 — Pulido.** Progreso de la importación, tamaños, y una segunda importación que
  informe de qué cambió.

## Evidence

- Work-unit commits, `npm test` green with per-suite counts on each.
- A live check that the internal and external profiles do not see each other: a package
  installed in one is absent in the other, and a provider configured in one is not offered
  by the other.
