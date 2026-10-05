# Feature: pi por área de trabajo y por carpeta — las dos

## Goal

> «sería posible hacer que pi pueda trabajar no solo por proyecto si no por "Área de trabajo"? las
> Areas de Trabajo contienen multiples proyectos.»
> «cuidado quiero que sea por area de trabajo o por carpeta ambas cosas.»

Dos alcances, no uno en lugar del otro:

- **Carpeta**: el proyecto de siempre. Su identidad, sus sesiones, su git, su contexto.
- **Área de trabajo**: todas las carpetas del *workspace* como una sola cosa. Identidad propia, y el
  contexto que se le manda a pi incluye todas.

## Lo medido (con fichero y línea)

- **Quién decide dónde corre el chat hoy**: `agent.ts:869-870` —
  `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath`. **Solo la primera carpeta**, y
  `SessionManager.create(cwd, …)` en `agent.ts:902`. La SDK tipa `cwd: string` (`agent.ts:146`): un
  directorio, no una lista. Igual en el descubrimiento de comandos (`commands.ts:197`), el login de
  suscripción (`login.ts:142`) y el catálogo de modelos (`wizard-models.ts:145`,
  `extension.ts:1302`).
- **La identidad** es `piProjectSlug(cwd)`: replica el codificado de pi (`sessions-provider.ts:173-175`)
  sobre **un** cwd. Nunca ha tomado una lista de carpetas.
- **Lo que ya es multicarpeta** (esto corrige una suposición mía): el panel de sesiones une las
  carpetas del workspace (`extension.ts:688,710` + `sessions-provider.ts:196-206`), los
  `.pi/mcp.json` se leen por carpeta (`extension.ts:341-343, 786-791`), igual que los scopes de
  paquetes (`extension.ts:783-791`) y las raíces de agentes y skills (`customizations.ts:218-230`).
- **Con dos carpetas hoy, lo que está mal**: el chat corre en la carpeta 0; el bloque de contexto
  manda solo esa carpeta (`editorContext(folder)`, `agent.ts:869,927`); las sesiones nuevas se
  registran bajo el slug de la carpeta 0 mientras el panel enseña la unión de las dos; y la fila
  *Project* enseña el git de la carpeta 0 (`status-data.ts:283`).
- **Coexistencia**: las lecturas admiten varias identidades, pero el chat tiene **una** sesión
  (`session`/`sessionFolder`/`sessionManager` únicos, `agent.ts:940-950`): dos sesiones simultáneas de
  dos carpetas no están soportadas.
- **Dónde vive la elección**: el conector solo declara `picode.updates.check` (sin scope,
  `package.json:165-175`); el núcleo declara `picode.providers` y `picode.pi.runtime` con
  `scope: APPLICATION` y el resto sin scope (`picodeConfiguration.ts:57-146`).
- **API disponible y sin usar**: `vscode.workspace.workspaceFile` (el `.code-workspace`) no aparece en
  ningún sitio del conector ni del contrib.
- **Un fallo colateral, real**: las claves de backup/restore son `<slug>/<archivo>`
  (`sessions-backup.ts:232, 660-675`) y el match de slug solo es case-insensitive al **listar**
  (`sessions-provider.ts:203-206`): un restore con la letra de unidad en distinta caja crea un
  directorio duplicado.

## Decisión

- **`picode.pi.projectMode`**: `auto` (por defecto) · `workspace` · `folder`, con alcance de ventana.
  `auto` = una carpeta → carpeta; varias → área.
- **pi sigue arrancando en un directorio** (es la SDK, no una limitación nuestra): en modo área, la
  base es la primera carpeta y **el área se expresa donde sí cabe**: el bloque de contexto lleva
  todas las carpetas, y los listados (sesiones, git) las unen.
- **El almacén de pi no se toca**: sus sesiones siguen indexadas por cwd. El área no inventa un slug
  nuevo para el almacén; se compone al listar, que ya funciona.
- Los listados **etiquetan** qué es del área y qué de una carpeta, en vez de mezclarlo sin decirlo.

## Tareas

- [x] **1. El ajuste y la detección**: `picode.pi.projectMode` (alcance ventana), `auto` = una carpeta → esa carpeta, varias → el área.
- [x] **2. Resolver el modo y la carpeta base** en `runtime.ts` (`resolveProjectScope`), y que el chat lo use y reconstruya la sesión al cambiar de ámbito (`agent.ts`).
- [x] **3. El contexto del área**: en modo área, el bloque adjunto lleva todas las carpetas (`contextBlockFor`).
- [x] **4. Las filas del panel por modo**: en modo área, *Project* lista **una fila por carpeta** con su rama y sus cambios; en modo carpeta, la fila de siempre.
- [x] **5. El fallo de las claves de backup** (caja de la letra de unidad): las reglas puras viven ahora en `sessions-provider.ts` y se pliegan al construir la clave, con prueba que lo fija (RED observado en win32).
- [ ] **6. Verificar y cerrar**: tipos del núcleo y del conector hechos (0 errores, 175/175 tests); falta la build, que necesita el editor cerrado.
- [ ] **7. Elegir la carpeta** cuando el modo es `folder` y el área tiene varias: hoy pi corre siempre en la **primera**. O un ajuste, o la carpeta del fichero que tengas abierto. (Antes decía «fuera de alcance»; es lo único que falta para que «las dos cosas» estén completas.)

## Fuera de alcance

- Cambiar la SDK para aceptar varios directorios.
- Un selector de carpeta dentro del modo carpeta más allá de la primera (se puede añadir después si
  lo pides).

---

## 2026-10-05 · hecho, en la rama `experimental`

El objetivo de este documento —que pi trabaje por **área de trabajo**, no solo por proyecto— está
implementado y verificado (`d2ce7c68`):

- En modo **workspace** la sesión del chat **es del área**: se archiva con identidad propia
  (`--area-<nombre>-<hash>--`) en vez de quedar bajo la primera carpeta como si fuera suya.
- Su **contexto nombra todas las raíces** (nombre y ruta del editor) con una **regla de
  direcciones**: emparejar el proyecto que se nombra con su raíz, dirigir cada fichero por su ruta
  bajo la raíz correcta, y lanzar un comando de otra raíz **con esa raíz como destino**. El límite
  real va escrito: **un shell tiene un directorio a la vez**, y el contexto dice cuál es el suyo.
- La lista de **sesiones va agrupada por proyecto** —el área primero, luego una por carpeta, con
  tope por grupo— en vez de la lista sin fondo que había.
- El modo **folder no cambia**, y lo cubren las pruebas que ya existían.

De seguir las raíces salió además un fallo de esa misma mañana: la comprobación de carpetas solo
miraba las **anteriores** a la primera existente, de modo que una raíz movida podía figurar como
presente. Ahora se comprueban todas.

**Lo que queda**: verlo con los ojos del dueño en un editor abierto — que el nombre del grupo se
lea bien y que el modelo use de verdad la regla de direcciones en conversaciones reales.
