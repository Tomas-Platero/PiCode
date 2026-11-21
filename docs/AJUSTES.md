# Ajustes: una sola ventana

Objetivo: una ventana **Settings** al estilo de Claude Code que junta los ajustes de VS Code más usados, la ventana Cuenta y Chat Settings. Rama: `feat/unified-settings`. Pruebas: `npm run test-browser`/`scripts/test.bat` con `--grep`, `node build/l10n.mjs check`, `node build/docs.mjs check`.

## Specs

- **S1** · «quiero que las opciones de picode (vscode). Se vean así como aquí en claude code o como tenemos la de cuenta, etc.» Ventana centrada, menú agrupado a la izquierda (Preferences, Account, Agent) con buscador; filas «nombre + explicación | control».
- **S2** · «Una sola ventana»: Cuenta y Chat Settings dejan de ser ventanas aparte.
- **S3** · «Podríamos unificar todo en la nueva ventana de settings y con "Categorías" llevar desde el botón por ejemplo de cuenta o sync a esas opciones. Como hacemos aquí en claude code». Cada entrada del editor abre Settings en su categoría; si ya está abierta, solo cambia de categoría.
- **S4** · «Revisa lo que hay en "cuenta" y "Chat Settings" para ver que no se duplique o si hay que quitar algo». Un dato, una casa (tabla del plan): fuera *Pro features*, el grupo de actualizaciones de Privacidad, las tarjetas repetidas de Status; restos muertos fuera; Tools con las herramientas de pi.
- **S5** · «recuerda las animaciones y eso»: entrada de la ventana, marca del menú que se desliza, página que entra, fila que se ilumina al llegar desde un botón, interruptores y segmentados que se deslizan, ✓ al guardar; todo apagado con *Reduce motion*.
- **S7** · (2026-11-21) «La opción de entorno de ejecución de pi debería estar bloqueada si no hay un pi externo en el pc»; «la comprobación de memoria dale un toque mejor que abrir una página ahi sola»; «las actualizaciones si son automáticas, que sean para todo, tanto para picode, packages (que se instalen automaticamente pero sin abrir una ventanita cmd) y extensiones de vscode»; «Añade mas opciones de accesibilidad»; «en atajos de teclado que salga la lista de atajos»; «Perfiles de agentes de gentle-ai ponlos en Agentes, mezcla ambas ventanas que se vean bien».
- **S8** · (2026-11-21) «quiero que siempre que añadas téxtos sean cálidos para el usuario»; «esto de "nunca va al recuento" es lo que te digo». Textos del aviso de uso, *Privacy* y *What's New* reescritos, y traducidos sin calcar.
- **S6** · «Mejora la ui y la estética»: páginas de Preferences (General, Editor, Chat & agent, Terminal, Memory, Updates, Accessibility, Keyboard) con controles comunes; el árbol de VS Code queda como *All settings* y se limpia (apartados vacíos, Copilot, `settingsSync`).

## Tasks

| ID | Specs | Ruta | Estado | Commit |
|---|---|---|---|---|
| T1 | S1 S2 S3 S5 | inline | hecho | 6f78deef |
| T2 | S6 | inline | hecho | 6f78deef |
| T3 | S2 S3 S4 | inline | hecho | 6f78deef |
| T4 | S4 (Tools) | inline | hecho | 6f78deef |
| T5 | S6 (árbol) | inline | hecho (parcial, ver L4) | 1d06299e |
| T6 | idiomas, docs, What's New | inline | idiomas y docs hechos; What's New a la release | 692b53a7 |
| T7 | S7 S8 | inline | hecho (ver L5) | 00afc973, 748b853b, 03211a70 |

## Log

- **L1** (2026-11-20) · «quiero que las opciones de picode (vscode). Se vena así como aquí en claude code o como tenemos la de cuenta, etc. Así que dame un plan revisando TODAS las opciones, que añadir, que quitar y tal. Mejora la ui y la estética.»
- **L2** · Elegido: una sola ventana. Pedidos después: diseños, revisión de duplicados, categorías como Claude Code, animaciones. Plan aprobado.
- **L3** · Decisión de construcción: en vez de una ventana nueva, la ventana *Chat Settings* (`aiCustomizationManagementEditor`) pasa a ser *Settings*. Ya pinta Agents, Skills, Packages y Tools con su vista de detalle, ya es modal y ya admite páginas registradas (`aiCustomizationManagementSectionRegistry`). Se le añaden grupos en el menú, las páginas de Preferences y las de Cuenta (como páginas registradas). La ventana Cuenta se borra.
- **L4** · Hecho y comprobado: compila, 5 pruebas de `picodeSettingsData` pasan, `l10n check` y `docs check` limpios. Decisiones: `picode.sync.*`, `picode.agents.profile` y `picode.privacy.shareUsage` no se ocultan del árbol (con `included: false` el editor se niega a escribirlos); la lectura de `pi.providers` del conector se queda (protege ajustes antiguos); las opciones `chat.*` de Copilot siguen en *All settings* hasta comprobar una a una que pi no las lee. La página de *What's New* se escribe con la release, cuando se sepa la versión.
- **L5** (2026-11-21) · Hecho en `feat/warm-texts`. *System* en «Qué pi responde» se apaga, con su motivo al pasar el ratón, si el equipo no tiene pi propio (`picode.setup.probeExternal`). *Check memory* responde en la propia página: veredicto, comprobaciones superadas y solo lo que hay que mirar (`picode.memory.checkSummary`; lo de la nube se ignora porque aquí no se usa). Con *Automatic*, la búsqueda de fondo instala sola lo que encuentra (pi, paquetes, motor de memoria), esperando a que ningún chat esté respondiendo; los paquetes ya no pasan por `pi update --extensions`, que lanzaba npm por consola sin `windowsHide` y abría una ventana por paquete, sino por la misma instalación oculta del botón *Update* de *Packages*; elegir *Automatic* enciende también `extensions.autoUpdate`. *Accessibility* gana *Reading* (subrayar enlaces, línea actual, grosor del cursor, atenuar paneles) y *Mouse and movement* (zoom con rueda, desplazamiento suave, espera de las ayudas, sangría de listas). *Keyboard* enseña la lista de atajos con buscador. *Agents* tiene dos pestañas: *Profiles* (los perfiles de Gentle, antes pestaña *Gentle AI* de *Providers & models*) y *Your agents*; `picode.providersModels.open 'agents'` lleva ahí.
