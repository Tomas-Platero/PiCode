# Feature: pi 1.0.0 en el pin

## Goal

> «Paren todo, ha salido pi 1.0.0 vamos con eso primero»
> «continua con la revisión de pi 1.0.0»

Subir el pi que PiCode se lleva dentro (`distribution/runtime.json`) de **0.99.2** a la
**1.0.0** publicada, y revisar qué cambia ese salto para el conector. Es el mismo trabajo que
la subida a 0.99.2 (`picode-pi-0992.md`), un escalón de major.

## Lo que se midió antes de tocar nada (2026-10-01)

Medido contra npm y contra el paquete real `@earendil-works/pi-coding-agent@1.0.0`
(descargado y ejecutado en `.scratch/pi-1000/`, no leído de un blog).

| Dato | Valor | De dónde |
| --- | --- | --- |
| Última publicada | **1.0.0** | `npm view … dist-tags` → `latest: 1.0.0` |
| Pin del repositorio | **0.99.2** | `distribution/runtime.json` |
| El CLI sigue igual | sí | `--help` sobre el binario 1.0.0: `install`, `remove`/`uninstall`, `update`, `list`, `config`, `auth`, `mcp add\|remove\|list\|login\|logout` |
| El SDK sigue igual | sí | `dist/index.js` exporta `createAgentSessionServices`, `createAgentSessionFromServices`, `createMcpExtension`, `createCodemodeExtension`, `createToolSearchExtension`, `SessionManager`, `main` |
| Entradas que el conector resuelve | presentes | `dist/index.js` y `dist/cli.js` existen (el `bin` apunta a `dist/bundle/cli.js`, pero el conector usa `cli.js`, que sigue ahí) |
| Node que exige pi | `>=22.19.0` | `package.json` `engines` |
| Node que trae el editor | **v24.18.1** | `ELECTRON_RUN_AS_NODE=1 PiCode-win32-x64/PiCode.exe -v` |
| `pi update --all` | mismo significado que en 0.99.2 | `update --help` de los dos |

### Pruebas en vivo (no de lectura)

1. **El validador MCP de 1.0.0 acepta lo que escribe PiCode**: `node dev/check-mcp-entries.mjs
   --pack <1.0.0>` → **12/12 como se espera**, y los dos controles (`auth: "oauth"`,
   `oauth: false`) siguen **rechazados**.
2. **El cableado del chat funciona en 1.0.0** (`.scratch/pi-1000/probe.mjs` y `probe-tools.mjs`):
   `createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: { extensionFactories } })`
   → `createAgentSessionFromServices({ services, sessionManager, customTools })` →
   `session.bindExtensions({ onError })`. Resultado: extensión inline arrancada (el camino de
   `session_start`), sin errores, y la herramienta del editor **`mcp__probe__echo` registrada y
   activa** (`getAllTools()` / `getActiveToolNames()`).

### Cambios de 1.0.0 que no tocan a PiCode

Del `CHANGELOG` de 1.0.0: fullscreen por defecto y `tuiMode` (PiCode no usa la TUI de pi), codemode
más ligero e imagen en codemode (PiCode no carga codemode), Radius y copy-code en `/login` (es de
la TUI), endurecimiento de OAuth de MCP y `oauth.authServerMetadataUrl` (añadido), credenciales
OAuth por servidor+URL (compatible con las entradas de PiCode).

## Decisión

- **`distribution/runtime.json` → `1.0.0`.** No hace falta tocar código del conector: el contrato
  que usa se verifica intacto y las dos entradas que resuelve existen.
- El runtime del pack se refresca con el paso real del build (`dev/pi-runtime.sh`), que ya
  reinstala cuando el pin se mueve.
- Los dos objetos que ya posee el editor (`mcp.json` de su perfil interno y el árbol de la
  extensión `picode`) no se tocan.

## Tareas

- [x] Medir el salto 0.99.2 → 1.0.0 (CLI, SDK, validador, Node) antes de escribir.
- [x] Subir el pin a 1.0.0 y refrescar el runtime del pack.
- [x] Verificar 1.0.0 dentro del pack (versión, entradas, `--version` bajo el Electron del editor).
- [x] Pasar tests y typecheck del conector.
- [ ] **Revisar el nombre MCP que colisiona (`-`/`_`)**: 1.0.0 rechaza servidores cuyos nombres
      solo difieren en guion y guion bajo (`dist/core/extensions/loader.js`, «Names that differ
      only in `-` and `_` would share a namespace»). El patrón de PiCode (`mcpServers.ts`,
      `mcp-add.ts`: `^[a-z0-9][a-z0-9_-]*$`) admite los dos. Hoy el perfil del dueño no tiene
      colisión (10 servidores, ninguno choca), así que **no es urgente**; la nota queda dicha para
      que un futuro añadido no escriba un par que 1.0.0 rechace.

## Verificación

| Qué | Cómo | Resultado |
| --- | --- | --- |
| El pin manda | `distribution/runtime.json` | `1.0.0` |
| El runtime del pack se refresca | `bash dev/pi-runtime.sh PiCode-win32-x64` | instala 1.0.0, poda plataformas ajenas |
| La versión dentro del pack | leer `package.json` del runtime instalado | `1.0.0` |
| pi 1.0.0 corre bajo el Node del editor | `ELECTRON_RUN_AS_NODE=1 PiCode-win32-x64/PiCode.exe <runtime>/dist/cli.js --version` | `1.0.0` |
| El validador MCP acepta lo que escribimos | `node dev/check-mcp-entries.mjs --pack PiCode-win32-x64` | 12/12 |
| El chat sigue cableándose | `node --experimental-strip-types --test test/*.test.ts` (14 suites) | 14/14 ok |
| Los tipos de esos tests | `tsc -p extensions/picode/tsconfig.test.json` | exit 0 |
| La prueba en vivo del cableado | `node .scratch/pi-1000/probe.mjs` y `probe-tools.mjs` | todo ok; `mcp__probe__echo` registrada |
