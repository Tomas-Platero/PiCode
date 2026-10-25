# Engram — la memoria del producto

> **Qué es este papel.** El registro punto por punto de la memoria de PiCode. No es una
> propuesta: es **el estado real** de lo hecho y lo que falta, con la prueba al lado. Si algo
> de aquí no está marcado como hecho, no está hecho, aunque exista código.
>
> **La lista de qué queda la manda [`TAREAS.md`](TAREAS.md).** Este papel es el detalle de una
> sola cosa: la memoria. Si los dos discrepan, gana `TAREAS.md`, y este papel se corrige.

> ⚠️ **2026-10-25 · Durable sale del producto ([ADR-030](DECISIONS.md)).** PiCode es pi más
> Gentle AI: el reparto de abajo queda en **pi piensa · engram recuerda lo que importa**, y las
> sesiones son los transcríptos de pi. Lo que este papel dice de durable (fases 3 y 4, la fila 📼 y
> los «dos motores») es historia: el protocolo de memoria ya no se escribe para él. El motor, el
> almacén `~/.engram` y el panel Memory no cambian.

**Estado:** fases 0–7 cerradas en lo que se puede cerrar en código · **Última revisión:** 2026-10-21

**Lo que ya funciona, y se puede comprobar:** el motor viaja dentro del producto (3.5.1 fijado,
SHA-256 verificado), el editor lo encuentra, reconoce el almacén que ya existe y lo cuenta
— `163 memories · 8 projects` en el panel. Los dos motores lo usan: el chat por la declaración del
perfil y una sección `memory` en su prompt, y durable por el mismo `mcp.json` más el mismo texto
leído del perfil. Y se puede **mirar y tocar sin terminal**: proyectos, lista, búsqueda, detalle en
pestaña, copiar, borrar, conflictos y revisión si existen, y el diagnóstico. **Build portable**
listo: `./PiCode-Win32-x64/PiCode.exe`. 44 pruebas de memoria en verde, y la suite entera del
conector también.

---

## 1. El reparto, en una frase

**Pi piensa · Durable recuerda lo que pasó · Engram recuerda lo que importa.**

| | Qué es | Qué guarda | ¿Lo ve otro agente? |
| --- | --- | --- | --- |
| 🧠 **Pi** | El agente | Nada | — |
| 📼 **Durable** | Sesiones, registro y el trabajo largo que sigue sin ti | Todo lo que se dijo | No |
| 📚 **Engram** | La memoria | Lo que merece recordarse | **Sí** |

Las flechas van en un solo sentido: **pi escribe en los dos**. Durable no lee la memoria;
engram no lee las conversaciones. Se cruzan solo a través de pi, que es quien decide.

Reglas que mantienen esto sano:

1. **Durable es todo lo que se dijo; engram, lo que vale la pena.** Si engram guarda cada
   turno se convierte en un durable peor, y la idea se muere.
2. **La memoria es lo único que viaja.** Las conversaciones se quedan en PiCode; lo aprendido
   lo puede leer otro pi de la misma máquina.
3. **Quien decide qué se guarda es pi**, con el protocolo. Ni durable ni la base deciden solos.
4. **El pi del chat y el pi durable no son dos agentes.** Es el mismo pi; durable es donde
   apunta y a donde manda lo largo.

---

## 2. Lo que se decidió, y a cambio de qué

| Decisión | A cambio |
| --- | --- |
| Engram **viaja dentro del producto** (no se instala aparte) | Un runtime más que empaquetar y actualizar, como durable |
| ~~**No** se usa el paquete `gentle-engram` de pi~~ → **sí se usa, fijado** (ADR-031, 2026-10-25) | Pi recibe la memoria por sus herramientas nativas y su captura; el protocolo propio y la declaración MCP se retiran |
| La memoria vive en **`~/.engram`**, compartida con cualquier otro agente | **No viaja con el perfil en la nube.** Deuda reconocida, no escondida |
| Si ya hay almacén, **se reutiliza**; si no, se crea. Nunca se mueve ni se pisa | — |
| **Una sola declaración** en el perfil sirve al chat y a durable | — |
| Todo lo que el TUI de engram muestra, **se muestra en el editor**; el TUI en sí no se porta | Hay que construir superficie nativa y comprobar qué permite su API |

**Deuda asumida:** la nube sincroniza configuración, no memoria. Se resuelve en su propio
trabajo, cuando exista la nube.

---

## 3. Tareas, punto por punto

Leyenda: `[x]` hecho y comprobado · `[~]` hecho sin comprobar · `[ ]` pendiente.

### Fase 0 — Decidir y escribir · S

- [x] **Reglas del reparto** en `AGENTS.md` §9 (los tres papeles, almacenamiento compartido, quién decide qué se guarda)
- [x] **ADR-022** en [`DECISIONS.md`](DECISIONS.md): engram como memoria del producto, y el coste de vivir fuera del perfil
- [x] **`DISENO.md`**: matizada la regla «nada fuera del perfil» y añadida la capa de memoria
- [x] **Este papel** + entrada en el índice de [`README.md`](README.md)
- [x] **`TAREAS.md`** apunta aquí como el detalle del tema
- **Hecho cuando:** no queda ninguna regla escrita que contradiga lo decidido. ✅

### Fase 1 — Traer el binario y encender · 🔴 L

- [x] Binario en los recursos del producto, **versión fijada** y suma de control
  (`build/distribution/engram.json`, `engram 3.5.1`, `sha256` del `.zip` de su release)
- [x] Staging en el build, como `resources/durable` (`build/engram-runtime.sh`, fase 5 de
  `build.sh`): descarga, **verifica el SHA-256**, descomprime, copia a `resources/memory/` y
  **arranca el binario** desde donde ha quedado. Probado de verdad: 21 MB en su sitio.
- [x] **Reutilizar lo que ya corre:** si un servidor responde y **posee este almacén** (mismo
  `instance_id` que `~/.engram/.instance-id`), se engancha y **no lo reinicia**. Si responde uno
  que sirve **otro** almacén, se deja en paz y se dice: `foreign`.
  *Corrección de la idea inicial:* un segundo **proceso** sobre el mismo almacén es lo normal
  (SQLite en WAL lo soporta y el propio pi externo del dueño ya lo hace). Lo que no se hace es
  abrir un **almacén distinto** ni pelearse con quien ya lo sirve.
- [x] Almacén: `~/.engram` si existe, creado por el motor si no; nunca movido ni pisado
- [x] Estados claros, sin jerga: *lista · vacía · parada · no encontrada · servida por otro · error*
- [x] **Inventario de la API** medido con el motor en marcha (ver §4)
- [x] Pruebas con un binario falso: **23 pruebas**, sin depender de esta máquina
- [x] **Verificado en esta máquina**: encuentra el motor, reconoce el almacén de 6 MB, el
  `instance_id` coincide y lee **163 recuerdos en 8 proyectos** (`Memory: 163 memories`)
- [ ] Arranque desde el editor: `ensureEngramServer` está escrito y probado (arranca una sola vez,
  no arranca si otro sirve, respeta `ENGRAM_URL`), y `startMemory` ya lo llama al activar
  — **sin comprobar en la ventana**, porque eso pide recargarla
- [ ] **Verificado en instalación limpia** (sin almacén previo ni engram en el PATH)
- **Hecho cuando:** abrir PiCode enseña la memoria que ya existe; en limpio, la crea.

### Fase 2 — El chat lo usa · 🟡 M

- [x] Declaración en el perfil **sin pisar** lo que ya hay: se añade solo si falta, y una entrada
  que funciona (la del dueño, otra ruta viva, o incluso un servidor por HTTP) **no se toca**.
  Comprobado sobre una copia de tu perfil: añade `engram`, conserva los 10 servidores que ya
  tienes y una segunda pasada no reescribe nada.
- [x] Juego corto de herramientas: el perfil `agent` de su motor (**22 de 26**, medido con el
  handshake real contra el motor 3.5.2 de esta máquina). Incluye el arranque y cierre de sesión,
  que es lo que permite decir de dónde salió un recuerdo. El coste ya lo imprime el editor al
  abrir un chat.
- [x] **El chat dice cuándo guarda:** una escritura de verdad en el almacén (`mem_save`,
  `mem_update`, y una consolidación **confirmada**) deja una fila en la conversación que nombra el
  recuerdo y dónde cayó — `Saved "…" to memory · picode`. Lo que solo *toca* la memoria (buscar,
  fijar, dictaminar, una consolidación en vista previa) mantiene la fila normal: anunciar un
  guardado que no ocurrió enseña a no leer los anuncios. 11 pruebas sobre la parte pura.
- [x] **Verificado hasta la puerta del chat:** el servidor declarado arranca, contesta
  `initialize`, lista sus 19 herramientas y `mem_search` / `mem_context` devuelven **tus recuerdos
  reales** (proyecto `picode`, 134 recuerdos). Falta verlo dentro de una conversación.
- [ ] **Verificado en el chat:** preguntar algo guardado y que lo cuente con sus palabras, no inventado
- **Hecho cuando:** un recuerdo viejo aparece en el chat sin tocar nada.

### Fase 3 — Durable lo usa · 🟡 M

- [x] Las herramientas llegan por el mismo fichero, **aplazadas**, con el coste medido:
  `host/durable/proof-memory.js` conecta el servidor de verdad y comprueba que engram entra como
  uno más. Solo sus 19 herramientas declaradas serían **20,9 KiB**; aplazadas son **0,5 KiB**.
  Con el perfil real del dueño: **350 herramientas en 1,0 KiB**.
- [ ] **Verificado de punta a punta:** trabajo largo delegado → guarda → otro chat lo encuentra
- [x] Prueba automática junto a las que ya existen (`proof-memory.js`, verde)
- **Hecho cuando:** cerrar la ventana deja de ser una pérdida.

### Fase 4 — El protocolo · 🟡 M

- [x] Bloque de memoria en el prompt del **chat**: una sección `memory` que se decide **antes de
  cada turno** y solo aparece si las herramientas están de verdad en la sesión (`mem_search` y
  `mem_save`), no por un ajuste. Sin herramientas, se **borra** la sección: no se le pide al modelo
  algo que no tiene.
- [x] Bloque de memoria en el prompt de **durable**: mismo texto, leído del fichero que escribe el
  conector en el perfil, e instalado **solo cuando engram está conectado**.
- [x] Presupuesto acotado y medido: el texto tiene techo en las pruebas (1.200 caracteres) y hoy
  ocupa ~800. Es una decisión crecerlo, no un efecto colateral.
- [ ] **Verificado:** chat nuevo, sin pistas, saca una decisión antigua
- [ ] Comparado con y sin el bloque, para saber que no es sugestión
- **Hecho cuando:** la memoria se usa sola. Sin esto es un cajón que nadie abre.

### Fase 5a — La memoria en el editor: mirar · 🟢 S

- [x] Vista de memoria en el contenedor que **ya existe**: *Memory*, un bloque más de PiCode, con
  su contador en la primera fila (`163 memories · 8 projects`) y nada de maquinaria.
- [x] **La memoria no se lista como servidor MCP.** Se declara a pi por `mcp.json` porque así es como
  pi le da sus herramientas al modelo, pero no es un servidor que el dueño añada o edite: la
  sección **MCP Servers** deja esa fila fuera y lo dice en una línea. Su superficie es el bloque
  *Memory*, y ahí está lo que se puede mirar y tocar.
- [x] Lista agrupada por proyecto, de 50 en 50 (`Show 50 more`), leída al desplegar y guardada
  hasta el siguiente refresco.
- [x] Búsqueda sobre todo el almacén desde la cabecera del bloque: la respuesta ocupa el sitio de
  la pregunta y se quita con **Clear search**.
- [x] Detalle en **pestaña del editor** (`preview`): el cuerpo tal cual se escribió y, debajo, los
  datos una sola vez — proyecto, tipo, alcance, fechas, revisiones.
- [x] «De dónde salió» **dentro del detalle**, como *Came from: a PiCode session*; el identificador
  de la sesión no se imprime y las sesiones siguen siendo las de durable.
- [x] Conflictos y *Needs review*: aparecen **solo si hay**, con los títulos de las dos memorias
  (`A ↔ B · contradicts`) en vez de números.
- [x] *Check memory*: el diagnóstico del motor en una pestaña; una sola frase de veredicto, los
  fallos con su porqué y los aciertos contados, no listados.
- [ ] **Historial de versiones:** la API HTTP no lo expone (solo CLI/TUI). Queda apuntado como
  deuda en lugar de ofrecer un botón que no lleva a ninguna parte.
- [x] **Verificado contra la base real:** 163 recuerdos en 8 proyectos, lista de 50, búsqueda con
  resultados y detalle de 2.168 caracteres, sin abrir un terminal.
- **Hecho cuando:** se puede buscar, leer entero y ver el origen sin abrir un terminal.

### Fase 5b — La memoria en el editor: tocar · 🟡 M

- [x] **Borrar**, desde la fila, con confirmación que nombra la memoria y avisa de que afecta a
  todos los agentes. La llamada lleva `expected_project` (el motor lo exige: borrar sin decir de
  qué proyecto es un recuerdo se rechaza con 400). Probado: 200, `status: deleted`, y la fila
  desaparece de la lista.
- [x] **Copiar**: el título y el cuerpo, tal cual, al portapapeles. Botón en la fila.
- [ ] Fijar / quitar fijado: la escritura existe (`PUT`/`DELETE /observations/{id}/pin`), pero la
  **lectura no**: el JSON no trae `pinned` y el filtro `?pinned=true` no filtra. Un botón sin
  estado visible es un botón que parece no hacer nada → **no se pone** hasta que haya dónde leerlo.
- [ ] «Necesitan revisión» con **marcar revisado**: la escritura no tiene ruta HTTP (`/review` solo
  acepta GET). Queda para cuando se hable MCP desde el editor o el motor exponga la ruta.
- [ ] Resolver conflicto: igual, no hay ruta HTTP de escritura.
- [x] Diagnóstico: estado + botón *comprobar* (ya en 5a)
- [x] **Verificado:** borrar y copiar hacen lo que dicen sobre una base creada para la prueba
  (nunca sobre el almacén del dueño).

### Fase 6 — Control y terminal · 🟢 S

- [ ] **Actualizar el motor desde PiCode**: fila propia con la versión, *comprobar* y *actualizar*.
  No es como actualizar pi: el almacén es **compartido**, y un motor más nuevo puede migrarlo y
  dejar fuera al otro agente de la máquina. Por eso: avisar antes, **copiar la base** antes de
  abrirla con el motor nuevo, arrancar el nuevo, comprobar que responde y, si falla, volver al
  anterior. Nunca automático, nunca en silencio, y **nunca** tocando el engram del sistema ni
  `~/.pi`. La fila dice **qué motor está usando** (el que trae PiCode o el del sistema) y actualiza
  ese.
- [ ] Interruptor memoria sí/no (**hoy va siempre encendida**; el interruptor llega aquí)
- [ ] Estado en una línea: cuántos recuerdos, último guardado, versión — **un dato, una vez**
- [ ] `engram` disponible en el terminal integrado (para que escribirlo haga algo de verdad)
- [ ] Si no arranca: aviso claro y el chat sigue funcionando
- **Hecho cuando:** se enciende, se apaga y se ve el estado sin explicar la maquinaria.

### Fase 7 — Cierre · 🟢 S

- [x] `docs/MAPA.md` regenerado (`node build/docs.mjs map`): 20 carpetas documentadas.
- [x] **Build portable** (`PICODE_SKIP_INSTALLER=yes`): `./PiCode-Win32-x64/PiCode.exe`, 1.142.0, con el
  motor en `resources/memory/engram.exe` y el bloque *Memory* en el panel.
- [x] Informe de cierre: lo verificado y lo que no (abajo).
- [ ] ADR final y notas de release mejoradas — se cierran con la release, no con el build.

**Hecho cuando:** hay un pack que se pueda abrir y probar. (Hay uno.)

---

## 4. Lo que el motor deja leer y tocar (medido)

Levantado contra el almacén real, no leído en su documentación. Lo que no está aquí, no hay ruta
para hacerlo desde el editor.

| Qué se quiere enseñar | Cómo se obtiene | Nota |
| --- | --- | --- |
| ¿Está viva? versión e identidad | `GET /health` | `service`, `status`, `version`, `instance_id` |
| Recuento por proyecto | `GET /projects` | nombre + recuerdos, sesiones y prompts |
| **Listar** recuerdos (por proyecto) | `GET /observations?project=…&limit=…&offset=…` | **corregido el 2026-10-20**: sí existe; devuelve la fila entera, incluido el cuerpo |
| Buscar | `GET /search?q=…&project=…` | sin `q` responde 400; con `q=*` devuelve todo |
| Un recuerdo entero | `GET /observations/{id}` | cuerpo, alcance, revisión, duplicados y de qué sesión salió |
| Contexto para el prompt | `GET /context` | el bloque «Memory from Previous Sessions» |
| Conflictos | `GET /conflicts` | `relations` con `from_id`/`to_id` |
| Necesitan revisión | `GET /review` | `count` + las observaciones |
| Diagnóstico | `GET /doctor?project=…` | 10 comprobaciones; la única en rojo es de **nube** (`sync_target_closed_space`) |
| Todo el almacén | `GET /export` | pesado; **única** vía HTTP para sesiones y prompts |
| Nube | `GET /sync/status` | apagada, y así se queda |
| Borrar | `DELETE /observations/{id}?expected_project=…` | **exige** `expected_project`; sin él responde 400. Borrado suave por defecto (`hard_delete: false`) |
| Fijar / quitar | `PUT` / `DELETE /observations/{id}/pin` | funciona, pero **el estado no se puede leer**: el JSON no trae `pinned` |

**Lo que no tiene ruta HTTP:** la lista de sesiones, la lista de prompts, el historial de un
recuerdo, las relaciones sueltas y el detalle de un proyecto. Tampoco **`pinned`**: el fijado se
toca con las herramientas MCP (`mem_pin`/`mem_unpin`) y no aparece en el JSON de lectura. Decisión:
lo que no tenga ruta **no se ofrece todavía**; no se inventa una pantalla a medias. El historial se
queda como deuda anotada y el fijado como decisión pendiente para 5b.

**Herramientas para el modelo:** `engram mcp` admite perfiles — `agent` (19), `admin` (4) y
`all` (23) — y también elegirlas de una en una. La fase 2 declarará un **juego corto**, no las 23.

## 5. Riesgos abiertos

| Riesgo | Qué lo cierra |
| --- | --- |
| **Dos versiones, un almacén** (el motor que trae PiCode y el que ya tenía el dueño) | El build fija la versión y comprueba la suma; el motor que trae el producto se prueba **antes** que el del PATH. Avisar y ofrecer actualizar; **nunca** migrar a la brava |
| **Un servidor que sirve otro almacén** en el puerto | Cerrado: se compara `instance_id` y se deja en paz (`foreign`) |
| **Binario sin firmar** puede despertar antivirus en Windows | Decidir antes de publicar: firmar o documentar |
| **Marca registrada**: Engram™ es de su autor, el código es MIT | Se puede usar el motor; no se viste la pantalla como su producto |
| **La API no cubre todo el TUI** | Inventario hecho (§4). Lo que no tenga ruta se hace por CLI o **no se ofrece** |

## 6. Fuera de alcance

Nube de engram · sincronizar la memoria con el perfil ·
migrar memorias entre almacenes · el TUI y su tema · sus teclas.

---

## 7. Bitácora

- **2026-10-20** · Creado. Fase 0 cerrada: reglas, ADR, diseño, índice y este registro.
- **2026-10-20** · Fase 1 a medias y con prueba: el motor viaja en el build (3.5.1, SHA-256
  verificado y arrancado desde su destino), la resolución y la sonda están escritas y cubiertas
  por 23 pruebas, y contra el almacén real dice `Memory: 163 memories` en 8 proyectos. Falta
  llamar al arranque desde el editor y probar una instalación limpia.
- **2026-10-20** · Fase 1 cerrada en código y fase 2 declarada: `startMemory` corre al activar
  (declara el servidor y despierta el motor, sin bloquear), la declaración no pisa lo que
  funciona, y el servidor MCP contestó `initialize`, listó sus 19 herramientas y devolvió recuerdos
  reales con `mem_search` y `mem_context`. 25 pruebas. Lo que no se ha podido ver desde aquí: la
  conversación dentro del editor y una instalación limpia.
- **2026-10-20** · Fases 3 y 4: el mismo `mcp.json` sirve a durable (`proof-memory.js`: conecta,
  19 herramientas aplazadas en 0,5 KiB) y el protocolo de memoria vive en un solo texto, inyectado
  en el prompt del chat solo cuando las herramientas están y en el de durable solo cuando engram
  conecta. 29 pruebas. Queda probarlo en una conversación de verdad.
- **2026-10-20** · Fase 5a: bloque **Memory** en el panel que ya existe — recuento, proyectos,
  lista de 50 en 50, búsqueda, detalle en pestaña, conflictos y revisión solo si los hay, y
  *Check memory*. Contra la base real: 163 recuerdos, detalle de 2.168 caracteres. 43 pruebas.
  *Corregido:* `GET /observations` sí existe y sí lista; el inventario de §4 lo daba por ausente.
  *Deuda:* el historial de versiones no tiene ruta HTTP, y `pinned` tampoco se lee por HTTP.
- **2026-10-21** · Fases 6 y 7: interruptor `picode.memory.enabled` (off quita la declaración y el
  protocolo, deja el almacén intacto), el motor aparece en el PATH del terminal integrado cuando
  viene con PiCode, y la fila del panel muestra versión + último guardado. Build portable
  (`PICODE_SKIP_INSTALLER=yes`) terminado: `./PiCode-Win32-x64/PiCode.exe`, con
  `resources/memory/engram.exe`. MAPA regenerado. 44 pruebas.
  *Queda para la release:* la acción de actualizar el motor (diseño anotado en fase 6: aviso,
  copia de la base, arranque, comprobación, vuelta atrás) y las notas de release.
- **2026-10-25** · Durable sale del producto (ADR-030): el fichero `memory-protocol.md` que se escribía para él deja de escribirse; el chat sigue recibiendo el mismo protocolo en su prompt. La entrada de gentle-engram queda para el paso siguiente.
- **2026-10-25** · gentle-engram 0.4.2 entra como paquete fijado (ADR-031): la declaración MCP de `engram` que escribía el producto se retira, el prompt `<memory>` propio también, y `ENGRAM_BIN` apunta al motor que viaja con la instalación antes de que pi cargue. Mismo almacén `~/.engram`, mismo panel Memory.
