# Entrada local para otras apps

> *"quiero poder pulsar Arrancar en su ficha y que Pi se ponga a trabajar en el repositorio correspondiente"* — 2026-11-26 (OmPm)

Otra app del mismo equipo, ejecutándose con tu cuenta de Windows, puede pedirle a PiCode que abra un proyecto, arranque un chat de pi con un encargo y le devuelva el identificador de esa sesión. Decisión: ADR-047 en [`DECISIONS.md`](DECISIONS.md).

## Cómo se usa

1. En PiCode: **Settings › Chat and agent › Let other apps start chats**. Viene apagado y es de cada equipo: la sincronización en la nube no lo enciende en otro.
2. Desde la otra app, o con el ejemplo [`examples/start-pi-session.ps1`](examples/start-pi-session.ps1):

```powershell
.\docs\examples\start-pi-session.ps1 -UserData "$env:APPDATA\PiCode" -Folder D:\proyectos\tienda -TaskId OMPM-42 -Prompt "Arregla el login"
```

En la build portable, `-UserData` es `<carpeta portable>\data\user-data`.

Si PiCode está cerrado, el ejemplo lo abre con tu cuenta en esa carpeta y espera a que la entrada esté lista.

## Qué pasa

- PiCode enfoca la ventana que ya tiene **esa** carpeta, o abre una nueva. Nunca la abre encima del proyecto que tengas en otra ventana.
- Si la carpeta no es de confianza, la pide. Si se rechaza, no se envía nada.
- Crea **su propio** chat, no usa el que tengas a la vista, y le envía el encargo.
- Contesta en cuanto consta que pi tiene el encargo en el historial de esa sesión.
- La sesión sale en *Sessions* de ese proyecto con el nombre `OMPM-42 · <primera línea del encargo>`, y usa la memoria de ese proyecto, como cualquier otro chat.

## El protocolo

Una línea JSON por mensaje, en los dos sentidos, por una *named pipe*. La ruta de la pipe y el token están en `<user data>\agent-bridge.json`:

```json
{ "version": 1, "pipe": "\\\\.\\pipe\\picode-agent-…", "token": "…", "exe": "C:\\…\\PiCode.exe", "pid": 1234 }
```

- El token se renueva en cada arranque de PiCode.
- Al cerrar PiCode solo queda `exe`, para poder arrancarlo.
- Al apagar el ajuste, el fichero se borra.

Petición:

```json
{ "token": "…", "id": "1", "method": "session.start",
  "params": { "folder": "D:\\proyectos\\tienda", "taskId": "OMPM-42", "prompt": "Arregla el login", "resendUncertain": false } }
```

Respuesta:

```json
{ "id": "1", "result": { "sessionId": "019…", "taskId": "OMPM-42", "reused": false } }
{ "id": "1", "error": { "code": "outcome_uncertain", "message": "…" } }
```

| Código | Qué significa | Qué hacer |
|---|---|---|
| `unauthorized` | Falta el token o no es el actual. | Releer `agent-bridge.json`. |
| `invalid_request` / `unknown_method` | La petición está mal formada: falta un campo, la carpeta no es una ruta local (las carpetas de red no se aceptan) o el encargo empieza por `/` o `@` (el chat lo leería como un comando o como otro participante, y no llegaría a pi como encargo). | Corregirla. |
| `folder_not_found` | La carpeta no existe. | — |
| `folder_not_trusted` | Se rechazó la confianza en la carpeta. No se envió nada. | Se puede repetir. |
| `not_sent` | Falló antes de entregar el encargo. No se envió nada. | Se puede repetir. |
| `task_conflict` | Ese `taskId` ya se usó con otra carpeta o con otro encargo. | Usar otro `taskId`. |
| `outcome_uncertain` | No se puede confirmar si pi recibió el encargo, o todavía no ha terminado de arrancar (la respuesta tarda más de 3 minutos, por ejemplo mientras esperas a dar confianza a la carpeta). **No se reenvió.** | Repetir con el mismo `taskId`: si sigue en marcha, espera a ese mismo arranque. Para reenviar a propósito, `"resendUncertain": true`. |
| `internal_error` | Algo falló dentro de PiCode, o no puede leer su lista de tareas (`agent-bridge-tasks.json` dañado: no arranca ninguna hasta que se arregle o se borre a mano). | Mirar el registro de PiCode. |

## Una tarea, una sola vez

PiCode guarda en `<user data>\agent-bridge-tasks.json` cada `taskId`, con la carpeta, una huella SHA-256 del encargo y su estado. El estado pasa por dos puntos:

- `pending` se escribe **antes** de entregar el encargo a la ventana.
- `started` se escribe **cuando consta que pi recibió el encargo**, es decir, cuando el mensaje está en el historial de la sesión. El id de sesión por sí solo no lo prueba: existe en cuanto existe la sesión.

Qué recibe una petición repetida:

| Situación | Respuesta |
|---|---|
| Mismo `taskId`, otra carpeta u otro encargo | `task_conflict` |
| Tarea `started` | la misma sesión, `reused: true`, sin enviar nada |
| Tarea `pending` con la primera petición aún en curso | el resultado de esa petición |
| Tarea `pending` sin nadie trabajando en ella (PiCode se cerró, la ventana no contestó) | se busca la sesión en disco: con **marca y encargo en el historial**, se devuelve; si no, `outcome_uncertain` |

**La marca de la tarea.** Es una entrada propia en el historial de pi (`type: "custom"`, `customType: "picode.task"`, con `taskId` y la huella), escrita al crear la sesión. No es el título: renombrar la sesión no la toca.

pi solo escribe el fichero de la sesión al llegar el primer mensaje del usuario, y lo escribe entero. Por eso en disco la marca nunca aparece sin el encargo detrás; lo comprueba una prueba contra el pi real (`extensions/picode/test/agent-bridge-task.test.ts`).

Aun así, la marca sola **no** se toma como prueba de que pi recibió el encargo: hace falta el mensaje del usuario después de ella.

**Mientras la ventana no contesta, la tarea sigue «en marcha».** Si quien llama deja de esperar, recibe `outcome_uncertain`; un reintento se suma a ese mismo arranque, nunca empieza otro por detrás. Solo deja de estar en marcha cuando la ventana contesta o se cierra.

**Un reenvío que no llega a salir no borra la duda anterior.** Si un `resendUncertain` se queda en `folder_not_trusted`, la tarea sigue como incierta: la siguiente petición sin `resendUncertain` vuelve a recibir `outcome_uncertain`.

**Punto de prueba.** Para probar la caída entre la marca y el envío, PiCode arrancado con la variable `PICODE_AGENT_BRIDGE_TEST_HALT_TASK=<taskId>` se para justo después de guardar la marca de esa tarea y antes de entregar el encargo. Solo existe para esa prueba.

## Solo este equipo y tu cuenta

La pipe la crea un pequeño ayudante en Windows PowerShell, no Node.

**Por qué no Node.** Medido el 2026-11-26: una pipe de Node acepta clientes por `\\localhost\pipe\…` y `\\<equipo>\pipe\…`, que es el camino de la red. Una regla de permisos que deniega *NETWORK* tampoco bastó, porque en el bucle local Windows reutiliza tu propia sesión.

**Cómo la crea el ayudante:**

- `PIPE_REJECT_REMOTE_CLIENTS`: Windows rechaza todo cliente que llegue por la red. Medido: `\\localhost` y `\\<equipo>` quedan fuera y `.` funciona.
- Permisos protegidos: solo tu cuenta, y *NETWORK* denegado.
- `FILE_FLAG_FIRST_PIPE_INSTANCE`, con un nombre que lleva una parte aleatoria en cada arranque: nadie puede haberse adelantado con ese nombre.
- Siempre hay una instancia de la pipe esperando, también mientras atiende a otra: el nombre nunca queda libre para que otra cuenta lo cree con sus propias reglas.
- Una respuesta solo vuelve por la conexión por la que llegó la petición: si la pipe se reinicia (apagar y encender el ajuste), lo pendiente de la anterior no se entrega a otra app.
- Un mensaje de más de 1 MB se rechaza entero, sin leer su cola como otra petición.
- Se cierra solo cuando se cierra PiCode.

El token va además de todo esto: es una protección añadida, no sustituye a las anteriores.

**Pendiente de comprobar a mano** (para darlo por cerrado):

- [ ] Desde **otro equipo** de la red, con tus credenciales: debe rechazarse.
- [ ] Desde **otra cuenta** de este Windows (`runas /user:otra powershell`): debe rechazarse.

## Pruebas

**Automáticas** (se ejecutan con el resto):

- `src/vs/code/electron-main/test/picodeAgentBridgeLedger.test.ts`: una tarea una vez, conflictos, recuperación, lista dañada, formato de las peticiones.
- `src/vs/code/electron-main/test/picodeAgentBridgePipe.test.ts` (solo Windows): conexión local en UTF-8, varias a la vez, rechazo por `\localhost` y `\<equipo>`, nombre ya ocupado y mensaje demasiado largo.
- `extensions/picode/test/agent-bridge-task.test.ts`: la marca, «recibido» frente a «solo marcada», y la premisa contra el pi real (la marca no llega al disco sin el encargo).

**De principio a fin, con la build portable** (2026-11-26, 27 casos):

- arranque, repetición con `reused: true`, los dos conflictos y dos peticiones a la vez con una sola sesión;
- una tarea nueva en la misma ventana tiene su propia sesión, y el `/` se rechaza;
- el título en *Sessions* y la ventana propia, sin tocar la que ya estaba abierta;
- PiCode cerrado a la fuerza con la tarea a medias: `outcome_uncertain` y nada repetido;
- parado entre la marca y el envío (punto de prueba): la sesión no llega al disco, el reintento da `outcome_uncertain` y el reenvío explícito la arranca una vez;
- carpeta sin confianza rechazada en la ventana: `folder_not_trusted` y nada apuntado;
- apagar y encender el ajuste;
- arranque en frío desde el ejemplo.

Una nota de esa prueba: si PiCode se cierra **a la fuerza**, el fichero de conexión conserva el token viejo. El cliente no puede conectar con él y arranca PiCode igual que si estuviera cerrado (es el caso de arranque en frío). Un cierre normal deja solo `exe`.

**Sin comprobar todavía:**

- el rechazo desde otro equipo y desde otra cuenta de Windows (arriba);
- que pi use la memoria del proyecto en esas sesiones: es un chat normal de la carpeta, pero la prueba no lo midió.

## Lo que no cubre todavía

- **OmPm como servicio de *Sistema local*.** Ese servicio no debe abrir PiCode ni leer tu perfil, y la pipe no le deja entrar (no es tu cuenta). Dirección probable: un ayudante pequeño que corra con tu cuenta al iniciar sesión y sea el único que hable con PiCode.
- **Ver la respuesta en directo, mandar otro mensaje e interrumpir.** El protocolo ya admite más métodos por la misma conexión (`session.subscribe`, `session.send`, `session.interrupt`).
- **Solo Windows.** En otros sistemas el ajuste no hace nada.

## Dónde está el código

| Parte | Fichero |
|---|---|
| Conexión, token y fichero de conexión | `src/vs/code/electron-main/picodeAgentBridge.ts` |
| Pipe solo local (ayudante) | `src/vs/code/electron-main/picodeAgentBridgePipe.ts` |
| Registro de tareas | `src/vs/code/electron-main/picodeAgentBridgeLedger.ts` |
| Formato de las peticiones | `src/vs/code/electron-main/picodeAgentBridgeProtocol.ts` |
| Ventana: chat propio, envío y espera | `src/vs/workbench/contrib/picode/electron-browser/picodeAgentBridge.ts` |
| Conector: marca, «recibido» y búsqueda | `extensions/picode/src/agent-bridge-task.ts`, comandos `picode.agent.*` en `agent.ts` |
