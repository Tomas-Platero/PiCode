# Feature: pi 0.99.2 en el pin, y el MCP que pi ya trae

## Goal

> «Actualiza pi en el proyecto ha salido una nueva versión»
> «también revisa si hay que hacer algo en picode o fixear algo»

La subida del pin de pi a la última publicada, y la revisión de lo que esa subida deja
obsoleto o roto en el conector de PiCode.

## Lo que se midió antes de tocar nada

Medido el 2026-10-01 contra npm y contra el paquete `@earendil-works/pi-coding-agent@0.99.2`
(descargado y ejecutado, no leído de un blog).

1. **La versión publicada es 0.99.2**, y el pin del repositorio estaba en **0.99.1**. La
   subida anterior (0.87.1 → 0.99.1) dejó su registro en `picode-cloud-sync.md`.
2. **Sin cambios de rotura para la integración.** El SDK sigue publicando las mismas
   entradas (`dist/index.js`, `dist/cli.js`) y los comandos que el conector ejecuta siguen
   existiendo, comprobados con `--help` sobre el binario 0.99.2: `install`, `remove`,
   `update --all`, `list`, `config`, `auth`, `mcp add|remove|list|login|logout`.
3. **La novedad que sí importa: pi tiene MCP propio desde 0.99.0** y lee
   `<agent dir>/mcp.json` y, con el proyecto en confianza, `<proyecto>/.pi/mcp.json`
   (`dist/extensions/mcp/config.js:79-81`). La extensión es built-in y **reemplazable**: si
   otra extensión registra `/mcp`, la built-in no carga
   (`dist/extensions/index.js` → `replaceable`, `dist/core/resource-loader.js`
   `omitReplacedExtensions`).
4. **`pi-mcp-adapter` ya no lee el fichero que PiCode escribe.** Su configuración vive en
   `mcp-adapter.json` (`pi-mcp-adapter@4.0.0` `config.ts:202`); el `mcp.json` del agent dir
   lo considera de pi, y desde 4.0.0 detecta la built-in (`index.ts:62-66`,
   `hasBuiltInMcpCommand` → `builtin:mcp`) en vez de quedarse con `/mcp`. Su changelog lo
   dice con todas las letras: en ≤3.3.0 «the adapter took over `/mcp` and warned about
   `mcp.json` on every start even though the built-in extension owns that file».
5. **Los nombres con punto no valen.** El validador de pi acepta
   `^[A-Za-z0-9_-]+$` (`dist/core/mcp-servers.js:18`), y un nombre así se rechaza con
   `invalid server name`. El patrón de PiCode sí aceptaba puntos, así que un servidor
   `mi.servidor` se escribía y no conectaba nunca.

## Decisión

1. **Pin a 0.99.2** en `distribution/runtime.json`. El script del build ya refresca un
   runtime viejo cuando el pin se mueve (`dev/pi-runtime.sh`).
2. **Fuera la instalación de `pi-mcp-adapter`.** Con pi ≥0.99 el fichero
   `data/pi-agent/mcp.json` lo lee pi por sí mismo; el paquete ya no aporta nada a los
   servidores que declara la fila de ajustes, y encima es una trampa: una versión que se
   quede con `/mcp` desactiva la built-in y dejaría los servidores **mudos sin decirlo**.
   Sin instalar nada, los servidores siguen funcionando y se leen con la exposición por
   defecto de pi (`codemode`, que pi activa solo cuando hace falta).
   - Se deja de instalar; **no** se desinstala lo que el perfil del dueño ya tenga: la
     declaración en `settings.json` es suya y no es asunto de este cambio.
3. **Sin punto en el nombre.** `NAME_PATTERN` pasa a `^[a-z0-9][a-z0-9_-]*$` en
   `mcpServers.ts` y `mcp-add.ts`, y el importador convierte el punto en guion en vez de
   descartar el servidor entero.
4. **La copia dice la verdad.** Los encabezados que afirmaban «pi has no MCP» y las frases
   que decían que el fichero lo lee `pi-mcp-adapter` pasan a contar lo que pasa: lo lee pi.

**No se toca** la exposición de las herramientas (se queda la de pi, `codemode` por
defecto): forzar `direct` metería todas las herramientas de todos los servidores en el
prompt, y el dueño no lo ha pedido. Se deja escrito aquí como decisión abierta.

## Fuera de alcance

- Cambiar el puente del MCP **del editor** (`mcp.ts`, `lm.invokeTool`): ese camino sigue
  siendo el del editor, con sus permisos y sus credenciales, y no lo toca la subida de pi.
- Migrar el `mcp.json` de perfiles viejos con claves del adapter (`settings`, `imports`):
  pi ignora lo que no sea `mcpServers`, así que no estorba.
- Desinstalar `pi-mcp-adapter` de un perfil que ya lo tenga.

## Evidencia (ejecutada, no leída)

| Qué | Cómo se comprobó | Resultado |
| --- | --- | --- |
| El pin instala y deja el runtime donde el conector lo busca | `bash dev/pi-runtime.sh /tmp/packcheck` (el paso real de la fase 5) | `pi 0.99.2 in place`, `dist/index.js` y `dist/cli.js` presentes; podadas 20 plataformas ajenas, conservado win32/x64 |
| La superficie del SDK que usa el conector sigue ahí | `import()` real del entry instalado + `createAgentSessionServices` | `createAgentSessionFromServices`, `modelRuntime.login/getProviders/hasConfiguredAuth` presentes; 42 proveedores |
| pi lee `mcp.json` por sí mismo | `PI_CODING_AGENT_DIR=<tmp> pi mcp list --json` con un servidor de prueba | Listado como `scope: global`, `exposure: codemode`, sin adapter instalado |
| El nombre con punto era un fallo real | El mismo listado con `my.server` | `servers: []` y `invalid server name "my.server" (use letters, digits, "_" and "-")` |
| Lo que escribe el conector es lo que pi lee | `mcpServersText` + `mcpServersTextWithAdded` reales → fichero → `pi mcp list --json` | Los tres servidores (stdio, http con `headers`, y el de Add Server) aceptados con `errors: []` |
| El conector | `node --test test/*.test.ts` | 164 pasan, 0 fallan |
| El conector, tipos | `tsc -p extensions/picode/tsconfig.json --noEmit` | 0 |
| El editor, tipos (los dos ficheros de textos que se tocaron) | `tsc -p src/tsconfig.json --noEmit` | 0 |

## Registro

- 2026-10-01 · medido, decidido y ejecutado en la misma sesión. Commits de trabajo:
  `89f4c227` (pin) y `3b66ca1c` (MCP). Los restos sin versionar que había en el
  árbol (`theme-catalog.ts`, `gettingStarted.*`, `picodeSetup.ts`, `picode-cloud-sync.md`)
  son de la sesión anterior y **no** se tocaron.
