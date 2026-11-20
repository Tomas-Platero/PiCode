# Ajustes: una sola ventana

Objetivo: una ventana **Settings** al estilo de Claude Code que junta los ajustes de VS Code más usados, la ventana Cuenta y Chat Settings. Rama: `feat/unified-settings`. Pruebas: `npm run test-browser`/`scripts/test.bat` con `--grep`, `node build/l10n.mjs check`, `node build/docs.mjs check`.

## Specs

- **S1** · «quiero que las opciones de picode (vscode). Se vean así como aquí en claude code o como tenemos la de cuenta, etc.» Ventana centrada, menú agrupado a la izquierda (Preferences, Account, Agent) con buscador; filas «nombre + explicación | control».
- **S2** · «Una sola ventana»: Cuenta y Chat Settings dejan de ser ventanas aparte.
- **S3** · «Podríamos unificar todo en la nueva ventana de settings y con "Categorías" llevar desde el botón por ejemplo de cuenta o sync a esas opciones. Como hacemos aquí en claude code». Cada entrada del editor abre Settings en su categoría; si ya está abierta, solo cambia de categoría.
- **S4** · «Revisa lo que hay en "cuenta" y "Chat Settings" para ver que no se duplique o si hay que quitar algo». Un dato, una casa (tabla del plan): fuera *Pro features*, el grupo de actualizaciones de Privacidad, las tarjetas repetidas de Status; restos muertos fuera; Tools con las herramientas de pi.
- **S5** · «recuerda las animaciones y eso»: entrada de la ventana, marca del menú que se desliza, página que entra, fila que se ilumina al llegar desde un botón, interruptores y segmentados que se deslizan, ✓ al guardar; todo apagado con *Reduce motion*.
- **S6** · «Mejora la ui y la estética»: páginas de Preferences (General, Editor, Chat & agent, Terminal, Memory, Updates, Accessibility, Keyboard) con controles comunes; el árbol de VS Code queda como *All settings* y se limpia (apartados vacíos, Copilot, `settingsSync`).

## Tasks

| ID | Specs | Ruta | Estado | Commit |
|---|---|---|---|---|
| T1 | S1 S2 S3 S5 | inline | en curso | |
| T2 | S6 | inline | pendiente | |
| T3 | S2 S3 S4 | inline | pendiente | |
| T4 | S4 (Tools) | inline | pendiente | |
| T5 | S6 (árbol) | inline | pendiente | |
| T6 | idiomas, docs, What's New | inline | pendiente | |

## Log

- **L1** (2026-11-20) · «quiero que las opciones de picode (vscode). Se vena así como aquí en claude code o como tenemos la de cuenta, etc. Así que dame un plan revisando TODAS las opciones, que añadir, que quitar y tal. Mejora la ui y la estética.»
- **L2** · Elegido: una sola ventana. Pedidos después: diseños, revisión de duplicados, categorías como Claude Code, animaciones. Plan aprobado.
- **L3** · Decisión de construcción: en vez de una ventana nueva, la ventana *Chat Settings* (`aiCustomizationManagementEditor`) pasa a ser *Settings*. Ya pinta Agents, Skills, Packages y Tools con su vista de detalle, ya es modal y ya admite páginas registradas (`aiCustomizationManagementSectionRegistry`). Se le añaden grupos en el menú, las páginas de Preferences y las de Cuenta (como páginas registradas). La ventana Cuenta se borra.
