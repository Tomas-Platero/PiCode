# 0.1.1-beta — lo que arregla esta versión

Task notes for the release that follows 0.1.0-beta. Everything here is in the CHANGELOG;
this file keeps the technical detail the owner does not need on screen.

## Versiones

- `distribution/product-delta.json`: `set.version` `1.135.2 → 1.135.3` (el número del
  editor, que es lo que el updater compara) y `set.picodeVersion` `0.1.0-beta →
  0.1.1-beta` (el nombre de la release, que es lo que se muestra).
- `updates/README.md`, `docs/CI.md`, `odd/tasks/picode-versionado.md` y la skill
  `picode-release` quedan con la regla de los dos números y los dos feeds.

## El updater

Tres defectos encadenados, todos comprobados contra el medio:

1. **404 al buscar.** El editor instalado con el `.exe` de Inno no tiene `target` en su
   `product.json`; `updateService.win32.ts` (`buildUpdateFeedUrl`) resuelve entonces el
   destino a `system` y pide `updates/stable/win32/x64/system/latest.json`. La release
   solo escribía `.../archive/latest.json`, así que la petición no existía. Ahora
   `release.yml` genera los dos con `dev/update-feed.mjs` (archive → zip, system →
   `-setup.exe`) y verifica los dos contra `raw.githubusercontent.com`.
2. **Versión mostrada.** `updateTooltip.ts` leía `productService.version` (VS Code). Ahora
   lee `picodeVersion` (con retroceso a `productVersion`), y el feed lo lleva
   (`--picode-version`). La comparación de verdad sigue usando `productVersion`.
3. **Comparación.** `set.version` sube a `1.135.3`; el feed anterior declaraba `1.135.2`,
   así que la release es estrictamente más nueva y el updater la ofrece.

## El asistente de arranque

- **Importador ausente.** `renderPiCard` construía la tarjeta sin el contenedor
  `.picode-import-area` que después buscaba con `querySelector`, así que la oferta de
  importar nunca se pintaba. Se añadió el nodo.
- **«Switching pi…» pegado.** `applyRuntime` no limpiaba la nota tras un cambio correcto;
  ahora llama a `setNote('', false)` antes del repintado.

## Galería de temas

- `isThemeOnlyManifest` (theme-catalog.ts) descarta los manifiestos que declaran
  `debuggers`, `languages`, `notebooks`, `notebookRenderer`, `taskDefinitions`,
  `problemMatchers` o un `extensionPack`. PowerShell entra por `category=themes` porque
  contribuye «PowerShell ISE»; con el filtro ya no aparece, y con él se va el aviso de
  confianza del editor. Prueba en `test/theme-catalog.test.ts`.

## Permisos del chat

- `isReadOnlyShellCommand` (permissions.ts) auto-aprueba `bash`/`powershell` cuando
  **todos** los tramos de la cadena son de lectura. Lista blanca de binarios y de
  subcomandos `git`; cualquier redirección (`>`), sustitución (`$(`/backticks) o binario
  fuera de la lista vuelve a preguntar. Pruebas en `test/permissions.test.ts`.

## Tema por defecto

- La extensión `picode` declara `contributes.configurationDefaults` →
  `workbench.colorTheme: "Abyss"`; `distribution/settings.json` lo repite para el perfil
  portable de primera ejecución. Una instalación existente conserva su tema.

## Sandbox

- Se retiran del registro todos los ajustes `chat.agent.sandbox.*` (el bloque de
  `terminalChatAgentToolsConfiguration.ts`), incluido el que el dueño vio como
  «Chat › Agent › Sandbox: Enabled Windows». El motor sigue en el árbol, pero su defecto
  es `off` y ya no hay ajuste ni control en el picker que lo encienda.
