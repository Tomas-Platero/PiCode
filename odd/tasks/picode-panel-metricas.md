# Feature: el panel de la izquierda — métricas siempre, todo, tareas y gráficos

## Goal

> «También me gustaría que revisaras las métricas bien de la extensión en la izquierda, haz que
> siempre salgan bien y añade todo, incluida las tareas que se van a ejecutar.»
> «También me gustaría graficos y eso si es posible.»

## Lo medido (con fichero y línea)

**Las filas de hoy, en orden** (`status-view.ts`):

| Fila | Línea | Cuándo falta |
| --- | --- | --- |
| Which pi | 227 | siempre |
| Version (de pi) | 228 | siempre |
| Providers | 229 | siempre |
| MCP servers (+ hijo por servidor) | 232-241 | siempre; datos de `status-data.ts:87-100` |
| Model / Thinking | 243 / 246 | solo si hay valor |
| Session: Context / Cost | 270 / 276 | **solo si `ctxTokens` existe** |
| «No turns yet» | 278 | ← esto es lo de «las métricas no siempre salen» |
| Usage | 283 | solo con proveedor NaN y credencial (`status-data.ts:216-241`) |
| Tokens in/out · Cache | 287 / 290 | solo con sesión y valores |
| Tareas del `todo` | 299-304 | solo si el plan tiene entradas |
| Project: Branch / Changes | 309 / 310 | «—» sin repositorio |
| Error | 314 | solo si lo hay |

**La causa principal de que salga a medias**: `getSessionUsage()` devuelve `undefined` cuando no hay
sesión o cuando esa sesión no ha reportado uso (`agent.ts:983-1030`), y las filas de contexto, coste,
tokens y caché están condicionadas a eso: sin sesión **no se pintan**, así que el panel parece
incompleto en vez de decir «todavía no hay nada que medir».

**Datos que ya existen y no se enseñan**:

- número de sesiones y transcripciones (`sessions-provider.ts:192`);
- paquetes instalados (`extension.ts:762`, comando de paquetes);
- estado de los updates (globalState `picode.updates.lastCheck`, `extension.ts:1595`);
- detalle de cada servidor MCP — comando, url, transporte — (`extension.ts:470`);
- agentes descubiertos (`customizations.ts:236`);
- el directorio de trabajo de la sesión (`sessionFolder`, hoy privado, `agent.ts:940`);
- actividad de subagentes (`subagents.ts:184`).

**«Las tareas que se van a ejecutar»** — cuatro fuentes, y solo una está en uso:

1. el plan del agente (el snapshot del `todo` en la sesión viva): **ya se lee**
   (`session-tasks.ts:57-76`, `agent.ts:995`) y ya se pinta (`status-view.ts:299-304`);
2. **subagentes en curso**: existen como presencia en disco (`subagents.ts:48-64`) pero solo se
   sondean durante un turno (`agent.ts:365`) — el panel no los ve;
3. tareas terminadas (`subagents.ts:352`): solo se ofrecen en un quick-pick (`extension.ts:1687`);
4. los ficheros `odd/tasks/*.md`: **nadie los lee** (alcanzables por fs desde las carpetas).

**Gráficos**: la Tree API solo admite por fila un icono (imagen o codicon), una descripción y una
etiqueta (`status-view.ts:146-163`). No hay barras ni lienzo. Un gráfico dentro del árbol solo se
puede lograr como **imagen e icono de fila** (un SVG dibujado por nosotros: el techo alcanzable). Y
**no hay ningún webview registrado** en el conector, así que una superficie gráfica de verdad habría
que crearla desde cero.

## Decisión

- **Siempre salen**: ninguna fila dependiente de la sesión desaparece. Sin datos, dice lo que pasa
  («no turns yet», «—») en lugar de dejar el panel a medias.
- **Todo lo que ya sabemos**, añadido: sesiones, paquetes, updates, detalle de cada servidor MCP,
  agentes, y el directorio de trabajo de la sesión.
- **Las tareas**, las tres que se pueden leer: el plan del agente (ya está), los **subagentes en
  curso** (presencia en disco) y las **tareas pendientes de `odd/tasks/*.md`** (los `- [ ]`).
- **Gráficos**: se empieza por lo que el árbol permite —un SVG de barras como icono de fila, para las
  filas que son cantidades (tokens, caché, coste, sesiones)—. Un webview queda para después y solo si
  lo pides: es una superficie nueva, con su propio coste.

## Tareas

- [ ] **1. Filas que nunca faltan**: quitar las condiciones de `status-view.ts:268-292` y pintar el
      estado honesto cuando no hay medida.
- [ ] **2. Fuentes nuevas** en `status-data.ts`: sesiones, paquetes, updates, agentes, directorio de
      trabajo, y el detalle de cada servidor MCP.
- [ ] **3. Las tareas**: subagentes en curso (leer la presencia sin depender de un turno) y las
      pendientes de `odd/tasks/*.md`.
- [ ] **4. El gráfico**: un SVG de barras por fila para las cantidades (`status-view.ts:146-163` es
      donde vive el icono).
- [ ] **5. Verificar**: tipos, tests, y una build para verlo.

## Fuera de alcance

- Un webview (una superficie gráfica nueva) salvo que lo pidas después de ver el SVG.

---

## Coda: el pase visual (2026-10-12)

> «Me gustaría gráficamente mejorar el panel de picode:status. Qué recomendaciones me das.» → «hazlo.»

Lo aprobado fueron cuatro bloques —color, ruido, iconos repetidos y resumen en la cabecera—, sin
logotipos de marca (esos van aparte, verificando marca por marca). Todo vive en `status-view.ts`.

### 1. Color para el estado (no había ninguno)

El panel entero era un gris: una fila que funcionaba se veía exactamente igual que una a la que le
faltaba el sign-in. Se añaden cuatro constantes, **todas comprobadas en el registro de colores del
tema** (`charts.green`, `charts.yellow`, `charts.red`, `disabledForeground`) y un ayudante
`stateIcon(id, color)`:

| Estado | Color | Dónde |
| --- | --- | --- |
| Pi puede usarlo | verde | fila de cada servidor MCP, `Daemon` |
| Le falta al dueño algo | amarillo | `needs sign-in`, `sign-in unknown`, la **cabecera** de MCP, y `Live streams` si hay |
| Está caído | rojo | `Daemon` no responde (fila **y** cabecera de `Durable`) |
| Apagado a propósito | gris apagado | servidor `off`, `No turns yet` |

El semáforo de verdad es el de la **cabecera de MCP**: se pone amarilla en cuanto un servidor pide
sign-in, así que el problema se ve sin desplegar la sección.

### 2. Fuera ruido y tripas (la regla de la casa)

- `pid 15596` sale de la línea y va al **tooltip**: la fila dice `running`; el número está para quien
  lo busque.
- «No turns yet · The session's usage appears after the first message» → la frase es **tooltip**; la
  fila se queda en `No turns yet`.
- «signed in with your own account» → **`signed in`**; «declared here» → **`declared`**.
- El servidor MCP que va bien ya no repite **`on`**: el punto verde lo dice. La excepción
  (`needs sign-in`) es la única con texto, y por eso destaca. `on · sign-in unknown` → `sign-in unknown`.
- **Durable**: los tres contadores a cero (`Conversations 0`, `Subagent conversations 0`,
  `Live streams 0`) dejan de pintarse. Un contador a cero no es una fila; la cabecera ya dice `Idle`.

### 3. Iconos que se repetían

- `history` estaba en la sección **Session** y en `No turns yet` → este último pasa a `circle-outline`.
- `server-process` estaba en **MCP servers** y en **Daemon** → MCP servers pasa a `server-environment`.
- Los 30 codicons usados se verificaron uno a uno contra `codiconsLibrary.ts` (los 30 existen).

### 4. La cabecera ya cuenta lo importante

- **`pi`** lleva el **modelo** en su descripción, y con él se **retira la fila `Model`**: un dato, un
  sitio. Antes había que desplegar la sección para verlo.
- **`Durable`** dice lo que está haciendo: `Idle`, o `N running` (streams vivos + conversaciones con
  un run en vuelo). Caído, la cabecera queda **sin texto** a propósito: el icono rojo ya lo dice y la
  fila `Daemon` lo deletrea; decirlo dos veces es justo lo que este panel pierde.
- **Versión con «update available»**: **no hecho**, y a propósito. El panel no tiene hoy ninguna
  lectura de actualizaciones, y el propio módulo prohíbe inventar (`nothing is invented`). Añadirlo
  es una fuente de datos nueva, no un retoque gráfico.

### 5. Sin tocar

- **Logotipos de marca** por fila (GitHub, Firebase, Supabase, Sentry, Vercel, Atlassian): es el paso
  siguiente, con verificación marca por marca y pareja claro/oscuro por fichero. GitHub ya está
  dentro del editor (`chat/browser/chatSetup/media/github.svg`).
- **Plegar Durable y Project por defecto**: era fricción; se quedan desplegadas.
- **Gráficos** (SVG de barras por fila): sigue siendo el techo del árbol y sigue pendiente de la
  decisión anterior.

### Verificación

- `gulp compile-extension:picode` → **0 errores** (con comprobación de tipos).
- `out/status-view.js` copiado al pack portable (idéntico), listo al reiniciar.
- Build completa del canal `experimental` relanzada para que el instalador también lo lleve.

---

## Coda II: el panel deja de ser una lista y pasa a ser seis bloques (2026-10-12)

> «¿Se podría cambiar en vez de en una lista en otra cosa? Por ejemplo en esto que puedes abrir y
> cerrar?» (la página de Extensiones: INSTALLED 4, RECOMMENDED 0…) → «Dale, hazlo.»

**Lo que es de verdad el ejemplo.** «INSTALLED», «RECOMMENDED» y «AGENT PLUGINS - INSTALLED» no son
secciones dentro de una lista: son **vistas distintas apiladas en el mismo contenedor**, y el editor
pinta cada una con su cabecera nativa, su flecha y su contador azul. Lo he verificado: el contador es
API pública (`vscode.ViewBadge`, `TreeView.badge`), así que se puede hacer **sin tocar el núcleo**.

**Lo hecho.**

- **Manifiesto** (`extensions/picode/package.json`): la vista única `picode.statusView` («Status») se
  parte en **seis** vistas del contenedor `picode-status`:
  `Host` · `Providers` · `MCP servers` · `Session` · `Durable` · `Project`, cada una con su codicon
  (`views[].icon` acepta un id de codicon — `ThemeIcon.fromString` en `viewsExtensionPoint.ts`; el
  primero usa el SVG de la marca, `media/picode-status.svg`, que es el gris medio que se lee en los
  dos temas).
- **Un solo lector** (`status-view.ts`): `StatusStore` guarda el `StatusData`, corre el temporizador
  mientras **alguna** vista está en pantalla, y deduplica la lectura en vuelo (`inFlight`), para que
  los seis bloques pintándose por primera vez lean **una** vez y no seis.
- **Un proveedor por bloque** (`StatusSectionProvider`), que dibuja sus filas de `sectionRows()`.
- **Contadores** (`sectionBadge()`): el número del que el bloque **trata**, no cuántas filas tiene —
  proveedores que hay, servidores MCP que piden sign-in, trabajo durable en vuelo, ficheros con
  cambios. Sin número que dar, no hay badge (mejor nada que un `0` que se lee como medición).
- **La acción que se perdió y se recuperó**: el enlace a los ajustes de proveedores estaba en la fila
  `Providers`; ahora la fila es una cabecera, así que va como acción de la cabecera —
  comando `picode.status.openProviderSettings` + `menus["view/title"]` con `view == picode.status.providers`.
- **`extension.ts`**: `registerStatusTreeView(uri)` → `registerStatusTreeViews()` (ya no necesita el
  `extensionUri`, porque el logo del bloque vive en el manifiesto).

**Lo que se pierde, y se dice:**

- El **modelo** vuelve a ser una fila (`Model`). En el pase anterior cabía en la descripción de la
  sección `pi`; una cabecera nativa no admite descripción, así que no hay dónde ponerlo salvo una fila.
- **La cabecera de un bloque no lleva emoji**: la pinta el editor, no nosotros. El icono del encabezado
  va por `views[].icon` (codicon o SVG), que el editor muestra cuando no cabe el nombre.
- El **logo grande y la tarjeta de dos líneas** del ejemplo (título + descripción + autor) siguen sin
  ser alcanzables desde un árbol: eso es pintado del núcleo o un webview, y queda como paso aparte.

**Verificado:** `gulp compile-extension:picode` → 0 errores; `package.json` válido y con las seis
vistas; `out/status-view.js` y `package.json` copiados al pack; build completa del canal `experimental`
relanzada para el instalador.

---

## Coda III: el bloque **Updates**, y actualizar desde ahí (2026-10-12)

> «Agrega una sección nueva con lo que haya que actualizar de Pi. Ya sea el propio pi (imagina que
> sale la 1.1.1, estamos en la 1.1.0) y la lista de updates de packages.» · «Sería bueno poder
> actualizarlo desde ahí.»

**No se inventa nada: la maquinaria ya existía.** `updates-check.ts` ya sabía comparar versiones
(semver con prerelease), preguntar a npm por la última de un paquete, decidir qué está realmente
detrás (`updatableTargets`), guardar la respuesta (`UpdatesSnapshot`) y correr la actualización
(`runPiUpdate`: npm para el runtime + `pi update --extensions` para los paquetes). Lo que faltaba era
una superficie donde verlo y un botón donde tocarlo.

**Lo hecho.**

- **La clave de almacenamiento pasa a su dueño**: `UPDATES_STATE_KEY` sale de `extension.ts` y vive en
  `updates-check.ts`, junto a la forma que guarda. El panel lee la misma respuesta, y dos maneras de
  escribir esa clave serían una de más.
- **`StatusData.updates`**: `parseSnapshot(globalState.get(UPDATES_STATE_KEY))`. El panel **lee** la
  respuesta guardada, nunca lanza la consulta: se relee cada cinco segundos y preguntar a npm por una
  docena de paquetes con esa frecuencia sería un error distinto del que se quería arreglar.
  `StatusDeps` gana `globalState` (que `setupDeps` ya traía).
- **Séptima vista**: `picode.status.updates` («Updates», icono `$(cloud-download)`), colocada **segunda**,
  justo detrás de `Host`: primero lo que pi es, luego lo que pi necesita.
- **Las filas** (`updatesSectionRows`): el runtime primero y los paquetes después — el orden que
  `updatableTargets` conserva —, cada uno `instalado → disponible` con una flecha azul
  (`charts.blue`, el color de «esto es una noticia», no de «esto va mal»). Ninguna fila lleva comando
  propio a propósito: una actualización se lleva el runtime **y** todos los paquetes a la vez, así que
  un botón por fila prometería una elección que pi no ofrece.
- **Las acciones**: `Update now` (comando `picode.updates.apply`) y `Check for updates`
  (`picode.updates.check`). Los dos registran **el mismo código** que ya corría la notificación
  (`runUpdateFlow` y `scheduledCheck`): el panel es una segunda puerta, no una segunda copia.
  `scheduledCheck(force)` deja que un clic manual funcione aunque el ajuste `picode.updates.check`
  tenga el chequeo de fondo apagado.
- **Cuándo no hay nada que decir**: sin snapshot todavía → «Not checked yet» + botón de chequear; con
  snapshot limpio → «Up to date» verde + «Last checked hace X» + botón. Con el pi **externo** en fuerza
  no se dice «up to date» (sería una promesa sobre un pi que este editor no escribe nunca): se dice
  «Your own pi · updates where it lives».
- **`describeAge`**: «just now», «N min ago», «N h ago», «yesterday», «N days ago».

**Verificado:** `gulp compile-extension:picode` → 0 errores; `package.json` válido con las **siete**
vistas y los dos comandos nuevos; ficheros copiados al pack; build completa del canal `experimental`
relanzada.

**Fuera de alcance, a propósito:** nada. El panel no hace ninguna consulta de red por su cuenta, y el
`picode.packages.updatesCheck` de la página de Paquetes (con su caché de diez minutos) sigue siendo
otra cosa: el detalle por paquete de esa página, no el resumen de pi.

---

## Coda IV: el bloque **Tasks**, que existe solo mientras hay tasks (2026-10-12)

> «Estaría bien una nueva sección que apareciese abajo del todo solo cuando el chat de pi lanza
> "tasks" de durable (que debería ser siempre que tenga que hacer varias cosas).»

**El mecanismo: una vista con `when`.** El bloque es la octava vista del contenedor
(`picode.status.tasks`, «Tasks», icono `$(checklist)`) declarada con
`"when": "picode.status.tasksVisible"` — el punto de extensión de vistas lo soporta
(`ContextKeyExpr.deserialize` en `viewsExtensionPoint.ts`). El store escribe esa clave de contexto
tras **cada lectura** (`setContext`): aparece en cuanto el daemon reporta una conversación con
`taskId` y desaparece cuando la última se va. Una sección que estuviera siempre vacía sería una
cabecera más que saltarse; que aparezca es parte de lo que dice.

**Qué es una task aquí.** Lo que durable llama subagent-owned conversation: el chat le entrega un
lote de varias cosas y durable le pone dueño (`taskId`) y conversación propia. La fila es de
`durable-tasks.ts` (`DurableWorkRow`), que ya existía: `taskId`, `inFlight` (presencia de `run` en el
snapshot del daemon — el único «estado» honesto que el protocolo contesta), `entries` y `newest`.

**Las filas.** `Task <id>` con `running` (icono `sync`, azul — actividad, no problema) o `idle`
(circulito apagado), `N entries`, y el clic abre el transcrípto (`picode.durable.list`). Sin estado
inventado: lo que el snapshot no contestó se dice «state unavailable». El badge cuenta las tasks y el
tooltip añade cuántas corren.

**Cero redundancia con Durable.** Las filas `Conversation N` del bloque Durable ahora excluyen las
de dueño task (`taskId === undefined`): esas viven en Tasks y solo ahí. Durable queda para el daemon
y las conversaciones sin dueño; Tasks, para el trabajo del chat.

**Verificado:** `gulp compile-extension:picode` → 0 errores; `package.json` válido con las **ocho**
vistas; copiado al pack; build completa del canal `experimental` relanzada.

---

## Coda V: Model Subscription, durable en Host, thinking con interruptor y tasks sin Herdr (2026-10-12)

Cuatro peticiones del dueño en una tanda:

### 1. «Model Subscription» debajo de Host
> «si es una suscripción de chatgpt, o nan que tiene cada modelo un % que se reinicia… si pongo un
> modelo de omni eso no tiene y se oculta, pero con chatgpt pro o claude code poder ver los timings
> o como con nan que tenemos el popup con los %.»

- **Séptima vista** `picode.status.subscription` («Model Subscription», `$(credit-card)`, `when:
  picode.status.subscriptionVisible`), segunda del stack, justo debajo de Host.
- **Solo se muestra cuando hay medidor**: `StatusData.subscription` (`status-data.ts`
  `readSubscription`) mantiene las tres condiciones de `readUsageRow` — proveedor declarado Y NaN Y
  credencial resoluble — y añade una: que el payload nombre un medidor para el modelo en uso
  (`nanModelUsage`). Sin medidor, `undefined` → la clave de contexto se apaga → sin sección. Con
  `omni` (endpoint declarado) no hay nada que enseñar y no se enseña.
- **Filas**: una por ventana, la más corta primero (`4-hour window`, `weekly window`,
  `billing period`), cada una `% used · resets in 2h 15m`, con el semáforo del panel (verde <60%,
  amarillo 60–89, rojo ≥90 o `limitReached`). El **badge** es el % de la ventana más corta.
- **La fila `Usage` de Session se retira**: mismo dato, mejor sitio (una cosa, un sitio).
- **Honesto sobre ChatGPT/Claude**: sus ventanas llegan en cabeceras SSE de la petición que hace pi,
  que el editor nunca ve (documentado en `usage-data.ts`). Hoy la única ruta es NaN; los demás
  modelos simplemente no tienen sección. No se inventa nada.

### 2. «La parte de durable mételo en el Host»
- La **vista `picode.status.durable` desaparece**; sus filas (`durableRows`) son la cola del bloque
  Host, tras Host/Version/Model/Thinking/Launched agents.
- El **badge de Host** hereda el de Durable: trabajo durable en vuelo.
- La sección **Tasks sigue existiendo abajo** (las tasks son su propio dato); las filas de
  conversaciones con dueño task siguen excluidas de Host (una cosa, un sitio).
- El stack queda: **Host | Model Subscription | Updates | Providers | MCP servers | Session |
  Project | Tasks (when)**.

### 3. «El thinking en el chat debería poder ocultarse»
- El ajuste **ya existía** (`picode.pi.reasoning`: `show`/`hide`, lo respeta `agent.ts` al puerta de
  los `thinking_delta`) pero no había nada que pulsar. Ahora: comando **`picode.pi.toggleThinking`**
  («Toggle Thinking in Chat») que lo alterna con un aviso, y la **fila Thinking del bloque Host es
  el interruptor**: clic alterna, tooltip dice qué pasa, y la descripción (`not shown`) repinta en
  el siguiente refresco. Los turnos ya en pantalla conservan lo mostrado; el cambio vale desde el
  siguiente turno.

### 4. El error HERDR_UNAVAILABLE al lanzar tasks
- **Qué era**: el chat de la captura era **Local** y el modelo usó `intercom` con
  `openProjectPaneIfMissing` — que lanza paneles con el **CLI externo `herdr`** (npm `herdr` = 0.0.0
  reservado; distribución propia), no instalado en la máquina y no empaquetado en PiCode.
- **La causa de fondo**: el agente durable tiene SU PROPIO `subagent` (`durable/lib/extensions.js`,
  `SubagentExtension`: herramienta `subagent` → tarea ancla en segundo plano → conversación hija con
  `taskId` → exactamente lo que la sección Tasks lista), pero **no estaba registrado** en las
  extensiones por defecto del daemon (`durable/lib/daemon.js` `serveStorage`): solo guard + skills.
  El modelo no tenía forma de crear tasks y fue a por lo que encontró.
- **El arreglo**: `SubagentExtension` entra en las extensiones del daemon. Cada conversación durable
  gana la herramienta `subagent` («Delegate a self-contained task to a BACKGROUND subagent and
  return immediately»), las tasks aparecen en la sección Tasks y **no hace falta Herdr**. La
  conversación hija se monta sin la extensión (sin recursión, ya estaba en el código). Sin choque de
  nombres: ningún paquete registrado del perfil (`settings.json`) declara una herramienta `subagent`.
- `intercom` se queda como está: su vía de paneles es legítima **cuando** Herdr existe; PiCode no
  depende de ella.

### Verificación
- `gulp compile-extension:picode` → 0 errores; `node --test` de `usage-data` → 16/16;
  `node --check` del daemon → OK; `package.json` válido (8 vistas, 2 con `when`).
- Copiado al pack y build completa del canal `experimental` relanzada.

### Coda VI: el bloque Tasks también lista los background jobs del chat (2026-10-12)

> «NO me salen las tareas que lanza» (captura: el chat lanzó Vitest, ESLint y Playwright como jobs
> en segundo plano, con sus tarjetas `/jobs`, y la sección Tasks no aparecía).

**Diagnóstico.** La sección Tasks solo miraba las conversaciones con dueño task del daemon durable.
Pero las "tareas" de la captura no eran de durable: eran **background jobs del propio chat** (la
herramienta `background` del agente), que el conector ya rastreaba — `background-jobs.ts` y su
`BackgroundJobTracker`, el mismo que alimenta la píldora sobre el chat — pero el panel no leía.

**El arreglo.** El bloque Tasks es ahora «el trabajo que el chat tiene fuera», de las dos clases:

1. **Background jobs** (`StatusData.jobs`, nuevo): `deps.runningJobs()` = `runningBackgroundJobs()`,
   el mismo array que lee la píldora — un solo dueño de la verdad, dos superficies, nunca pueden
   discrepar. Fila: la etiqueta del job (o `Job N`), `running · 2m 15s`, icono `sync` azul, el
   comando en el tooltip. El job sale de la lista cuando su mensaje de fin lo cierra (igual que la
   píldora): un job terminado ya reportó en el chat.
2. **Tasks de durable**: como estaban (`Task <id>` · running/idle · entries, clic abre transcrípto).

El **badge** cuenta el total y el tooltip desglosa `N running · M idle`. La **visibilidad** (`when`)
aparece si hay jobs o tasks — antes solo miraba durable, y por eso no salía.

**Verificado:** `gulp compile-extension:picode` → 0 errores; `StatusDeps` gana `runningJobs`
(`setupDeps` lo cablea a `runningBackgroundJobs` de `agent.ts`); copiado al pack; build 8 lanzada.
