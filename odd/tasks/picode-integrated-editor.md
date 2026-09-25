# Feature: PiCode como editor integrado (Bloque C)

## Goal

Que el binario compilado **sea PiCode** de forma integrada, no un VSCodium con una
extensión encima:

- pi como **extensión built-in** (dentro del binario, no instalable/desinstalable).
- El panel propio **se disuelve en las Settings nativas** (`contributes.configuration`).
- Identidad completa en `product.json` (nombre, carpeta de datos, protocolo, icono).
- **Auto-update** por JSON estático servido en crudo, sin servidor propio.
- Decisión sobre el **auth provider de GitHub**.
- Icono de Activity Bar y **keybinding** remapeados a `@pi`.

## Decisions

1. **Built-in por copia en la fase 8.** `dev/build.sh` copia
   `extensions/picode-pi-chat` dentro de `vscode/extensions/` antes de compilar, que es
   como VS Code integra sus propias extensiones. No hay VSIX instalado aparte.
2. **El panel no se borra hasta que su bloque esté migrado.** Cada categoría se mueve a
   `contributes.configuration` y solo entonces se retira del panel.
3. **`updateUrl` apunta a un JSON estático por plataforma** (`TomasPlatero/PiCode` →
   `updates/win32-x64.json`), generado al publicar y servido por
   `raw.githubusercontent.com`. No se apunta `updateUrl` a GitHub Releases: el
   actualizador espera el formato `GET /api/update/{plataforma}/{canal}/{versión}`.
4. **El auth de GitHub se conserva, pero se le quita el gancho a Copilot.** La extensión
   `github-authentication` la usan git y otras integraciones; lo que se elimina es el
   punto de entrada de Chat («Sign in to use GitHub Copilot»). La decisión de producto
   queda **conservar** el proveedor para OAuth de modelos si algún día hace falta.
5. **Icono y keybinding apuntan a `@pi`.** El icono de la Activity Bar era el de la
   extensión de Copilot Chat; el keybinding por defecto abría su panel.

## Tasks

- [x] C1 pi built-in en `dev/build.sh`.
- [~] C2 Disolver el panel en Settings nativas (por bloques) — **sustituida por D1–D5**
  (ver la fase D al final).
- [x] C3 `product.json` de identidad completa.
- [x] C4 Auto-update por JSON estático.
- [x] C5 Decidir el auth provider de GitHub.
- [x] C6 Remapear icono de Activity Bar y keybinding.
- [ ] C7 Verificación específica en clon limpio.

## Hecho

**C1** — `dev/builtin-extension.sh` compila `extensions/picode-pi-chat` con su propio
`tsc` y copia el resultado a `vscode/extensions/picode-pi-chat`, que es de donde el
empaquetado coge toda extensión local (`glob('extensions/*/package.json')` en
`build/lib/extensions.ts`). La copia reemplaza, no fusiona, para que un `out/` de un
fichero ya borrado no viaje al binario, y falla en voz alta si `out/extension.js` no
queda. `dev/build.sh` lo ejecuta como primer paso de la fase 6.

**C2** — Los ajustes del panel **ya estaban** declarados en `contributes.configuration`
(los ocho `picode.*`) y por tanto ya viven en las Settings nativas. Lo que no se migra,
con motivo: la tabla de skills y el catálogo de paquetes **no son ajustes** —son
superficies de gestión, no valores— y `contributes.configuration` no puede expresarlas.
Disolverlas exige decidir dónde vive una tabla dentro de Settings, que es una decisión de
producto todavía abierta; el panel sigue siendo la superficie de gestión a la que se
llega desde Settings, y no se retira antes de migrar cada bloque.

**C3** — La identidad ya estaba en `distribution/product-delta.json` (29 claves:
nombre, `applicationName`, `dataFolderName` `.picode`, `urlProtocol`, AUMID, cadenas de
Windows, galería Open VSX, URLs). Verificado con el delta en seco: todas «already
current» salvo `updateUrl`, que C4 cambia.

**C4** — `dev/update-feed.mjs` escribe `<out>/<quality>/<platform>/<arch>[/<target>]/latest.json`
con `version`, `productVersion`, `timestamp`, `url` y `sha256hash`, que es exactamente lo
que lee el updater con el parche de VSCodium aplicado. **Se niega a escribir un feed que
no sea más nuevo** que la versión instalada (con `--force` como escape): ese es el bug
conocido de «siempre hay actualización». `updateUrl` pasa a
`https://raw.githubusercontent.com/TomasPlatero/PiCode/HEAD/updates`, y
`updates/README.md` documenta el paso de release y la dependencia pendiente de la
numeración de versión del Bloque A.

**C5** — Decisión: **conservar** `github-authentication`, que usan git y otras
integraciones, y quitarle el gancho a Copilot en la superficie de Chat. Lo segundo lo
hace el parche 03 quitando las cadenas del selector; la retirada del proveedor entero
queda descartada porque rompería el login de Git.

**C6** — El keybinding por defecto se añade en la extensión: `Ctrl+Alt+I` (macOS
`Cmd+Alt+I`) ejecuta `workbench.action.chat.open` con `{ query: "@pi ", isPartialQuery: true }`,
así que abre el Chat con `@pi` ya escrito. `ctrl+alt+i` no tiene binding en el core
(comprobado sobre la fuente). El icono de la Activity Bar ya era el de PiCode
(`media/picode.svg`, enmascarado): el de Copilot venía de la extensión `GitHub.copilot`,
que VSCodium ya retira.

## Evidencia

- **C1 medido sobre el paquete**: `./dev/build.sh -s` → `BUILD_EXIT=0`, y
  `PiCode-Win32-x64/resources/app/extensions/picode-pi-chat/` contiene `out/extension.js`
  más `media/`, `package.json` y `runtime.json`. El manifiesto empaquetado conserva el
  participante, las tools y el keybinding.
- **C3/C4 medidos sobre el paquete**: `resources/app/product.json` lleva
  `dataFolderName .picode`, `win32AppUserModelId PiCode.PiCode` y
  `updateUrl https://raw.githubusercontent.com/TomasPlatero/PiCode/HEAD/updates`.
- **C4 medido en el generador**: escritura correcta en
  `updates/stable/win32/x64/latest.json` y rechazo (exit 1) de un feed que no supera la
  versión instalada.
- **C6**: `ctrl+alt+i` no tiene binding en el core (comprobado con `git grep` sobre la
  fuente pinneada) y el keybinding viaja en el manifiesto empaquetado.

## No medido (y por tanto no afirmado)

- **C7 no se ha hecho**: no hay verificación en clon limpio de este bloque.
- **La aplicación no se ha arrancado.** Que la extensión esté dentro del paquete no es lo
  mismo que haber visto al editor cargarla, mostrar `@pi` y activar la herramienta.
- El feed de actualización **no se ha servido nunca**: el generador está probado, pero no
existe todavía un `latest.json` publicado ni una versión con la que compararlo.

## Fase D — Settings nativas y el hub de personalizaciones

La prueba en vivo de la build encontró dos superficies nativas que resuelven mejor lo que
C2 dejó abierto. D1–D5 sustituyen a C2.

### D1 — categorías de pi dentro del nodo Chat de Settings · **DEFECTO ENCONTRADO: el parche no surte efecto**

> **Corrección (verificada leyendo el código que construye el árbol).** Este parche
> **no mueve nada**: `settingsEditor2.ts:1477` llama a
> `resolveSettingsTree(tocData, coreSettingsGroups, …)` con **solo los grupos del core**, y
> los ajustes que aporta una extensión van por otro camino:
> `createTocTreeForExtensionSettings(extensionService, extensionSettingsGroups, filter)`
> (`settingsTree.ts:480`), que construye el árbol a partir de la configuración **de la
> propia extensión** y **nunca consulta `tocData`**. Los ajustes `picode.*` son de
> extensión, así que siguen apareciendo bajo `Extensions > PiCode` y las tres categorías
> nuevas del nodo Chat quedan invisibles (un nodo sin ajustes que le casen lo descarta
> `_resolveSettingsTree`).
>
> **Arreglo correcto, pendiente:** declarar los ajustes `picode.*` en el **core** (una
> contribución de `configurationRegistry` en la fuente, con las mismas claves) y quitarlas
> de `contributes.configuration` de la extensión. Solo entonces pasan por `tocData` y el
> nodo Chat las recoge. Un ajuste declarado dos veces avisaría y aparecería en ambas
> superficies, que es justo lo que D1 quiere evitar, así que es mover, no duplicar.

Lo que sigue describe el parche tal como está escrito, que es correcto en forma pero
inocuo mientras los ajustes sean de extensión.

La tabla de contenidos de Settings no sale del registro de configuración: es un árbol
**curado a mano** en `tocData` (`src/vs/workbench/contrib/preferences/browser/settingsLayout.ts:70`),
cuyo nodo `chat` (línea 182) lista `Agent`, `Appearance`, `Sessions`, `Tools`, `MCP`,
`Context`, `Inline Chat` y `Miscellaneous` como globs de claves.

`patches/picode/04-pi-settings-under-chat.patch` inserta las categorías de pi **al
principio** del nodo Chat, porque pi es el agente que este producto trae:

| Nodo | Ajustes que agrupa |
| --- | --- |
| `chat/picodeRuntime` · «Qué pi se ejecuta» | `picode.pi.runtime`, `.executablePath`, `.transport`, `.extraArgs` |
| `chat/picodeReasoning` · «Razonamiento y panel» | `picode.panel.reasoning` |
| `chat/picodeAttachments` · «Contexto y adjuntos» | `picode.context.attach`, `picode.media.*` |

Un nodo cuyos globs no casan ningún ajuste lo descarta `_resolveSettingsTree`, así que
declarar una categoría antes de que existan todas sus claves no deja una caja vacía.

**Desviación registrada respecto a D1.** El documento pedía cuatro categorías
(«Modelo y razonamiento», «Extensiones de pi», «Qué pi se ejecuta», «Proveedores y
credenciales») apuntando a `contributes.configuration`. Solo tres son de verdad
*configuración*:

- «Modelo» **no** puede ser un ajuste del editor. `picode.pi.defaultModel` existió y el
  proyecto lo retiró: duplica el `defaultModel` de pi, que es fuente única, y hay un test
  que prohíbe su vuelta (`test/settings-view.test.js`, «the duplicated default-model
  setting is gone from the manifest»). Intentarlo de nuevo reproduce un defecto ya
  cerrado. El modelo es una **superficie de gestión** (escribe el `settings.json` de pi).
- «Extensiones de pi» y «Proveedores y credenciales» tampoco son ajustes: son una tabla
  de paquetes y un flujo de login con credenciales en fichero. Pertenecen al hub (D4) y al
  comando de login.

Por eso el nodo se llama «Razonamiento y panel» y no «Modelo y razonamiento»: nombra lo
que de verdad configura.

### D2 — descripciones genéricas de Agent/Tools/MCP · PARCIAL, con motivo

`ITOCEntry` **no tiene campo `description`**: en `tocData` una categoría es `id`, `label`,
`order`, `children` y `settings`, y no hay dónde escribir una descripción por nodo. La
redacción que se ve bajo Agent/Tools/MCP sale de los `description`/
`markdownDescription` de los **ajustes** que cada glob agrupa (`chat.agent.*`,
`chat.tools.*`, `chat.mcp.*`), que son del marco de agentes genérico de VS Code y rigen
cosas que no son de pi.

Decisión: no se reescribieron. Renombrar esos ajustes para hablar de pi afirmaría que
gobiernan a pi cuando no lo hacen. Sí se hizo lo que corresponde: las tres categorías
nuevas llevan nombres de pi, y los ajustes de pi llevan sus propias descripciones en
`contributes.configuration`.

### D3 — el hub «Agent Customizations» · AUDITADO

**Es agnóstico del agente activo.** No hay una sola referencia a Copilot en el servicio ni
en el hub:

- `src/vs/workbench/contrib/chat/common/customizationHarnessService.ts` define
  `IHarnessDescriptor` (id, label, icon, `supportedTypes`/`hiddenSections`, `itemProvider`,
  `sectionOverrides`, `requiredAgentId`) y `CustomizationHarnessServiceBase`.
- El hub vive en `src/vs/workbench/contrib/chat/browser/aiCustomization/` y resuelve cada
  sección con `aiCustomizationManagementSectionRegistry.get(id, harnessId)`, es decir
  **por harness activo**, no por agente cableado.
- `createVSCodeHarnessDescriptor()` construye el harness «Local» con `id: SessionType.Local`.

**Y es registrable desde una extensión**, que es lo que desbloquea D4:

- Puente: `$registerChatSessionCustomizationProvider` →
  `registerExternalHarness(...)` en `src/vs/workbench/api/browser/mainThreadChatAgents2.ts:850`.
- API pública (propuesta):
  `chat.registerChatSessionCustomizationProvider(chatSessionType, metadata, provider)` en
  `src/vscode-dts/vscode.proposed.chatSessionCustomizationProvider.d.ts`, con
  `ChatSessionCustomizationType.{Agent,Skill,Instructions,Prompt,Hook,Plugins}`,
  `provideChatSessionCustomizations()` y `provideSourceFolders()`.

Conclusión: **no hace falta desligar nada de Copilot primero**, y **no hace falta parchear
el core** para D4.

### D4 — contenido del hub · PLAN (no hecho)

Mapeo decidido, apoyado en la API propuesta y no en parches:

| Panel de pi | Hub | Cómo |
| --- | --- | --- |
| Tabla de skills | `Skills` | `provideChatSessionCustomizations` devuelve los `SKILL.md` que `src/skills.ts` ya descubre, con `type: Skill` |
| Catálogo de paquetes | `Plugins` | `type: Plugins`, con el catálogo de `catalog.ts`; `uri` sintético porque un paquete no es un fichero |
| Configuración de MCP | `MCP Servers` | ya migrado en B4 (`.vscode/mcp.json`); el hub lo lee de core |
| — | `Agents`, `Instructions`, `Prompts`, `Hooks` | nativos, sin aportación de pi |

Requisitos medidos: `enabledApiProposals: ["chatSessionCustomizationProvider"]` en el
manifiesto de la extensión, y un `sessionType` que dé identidad al harness (el
`requiredAgentId` permite colgarlo de `picode.pi`).

**No implementado.** Es código contra una API *propuesta* cuyo efecto solo se ve en un
editor en marcha, y esta sesión no ha arrancado la aplicación. Escribirlo a ciegas y
declararlo hecho sería exactamente lo que el registro de este repositorio evita.

### D5 — retirar el panel propio · NO HECHO, y no debe hacerse todavía

El propio documento lo condiciona a que D1–D4 estén **verificados**. D4 no lo está, así que
retirar el panel dejaría a pi sin superficie para skills ni paquetes. El panel sigue donde
estaba; lo que ya cambió es que sus ajustes aparecen dentro del nodo Chat de Settings.

### Evidencia de la fase D

- `patches/picode/04-pi-settings-under-chat.patch`: `git apply --reverse --check` → OK;
  parseo TypeScript del fichero → 0 diagnósticos. **Compila y se empaqueta, pero no
  coloca las categorías**: ver la corrección de arriba.
- Build completa `./dev/build.sh -s` → `BUILD_EXIT=0`, con
  `compile-src ... with 0 errors` incluyendo el parche 04.
- Las tres etiquetas nuevas están en `resources/app/out/nls.messages.json`.
- `extensions/picode-pi-chat`: `npm test` → `EXIT=0`, 36 suites, 0 fallos.

### Decisión de numeración (bloqueaba C4) · RESUELTA

Se adopta el esquema de VSCodium: `productVersion = <VS Code major.minor>.<PiCode release>`,
con el contador en `upstream/picode-release.json` (hoy `1`). Se descartó la versión propia
independiente (`v0.1.0`…) **porque `engines.vscode` se valida contra la versión del
producto**: un `0.x` haría que toda extensión (`^1.90.0`) se viera incompatible.
`dev/build.sh` deriva `APP_VERSION` y `dev/prepare_vscode.sh` la sella en `package.json`,
que es de donde el empaquetado la inyecta en `product.json`. `RELEASE_VERSION` (el tag)
sigue nombrando los assets.

Verificado en el paquete: `resources/app/product.json` → `version 1.135.1`; y
`1.135.1` satisface `^1.90.0`.

**Lo que la decisión NO unifica todavía**, y hay que decirlo: la vía **ZIP precompilado**
sigue sellando la versión de VSCodium (`1.135.06055`, forma que no es semver estricto y que
por eso el parche heredado del updater trae un `normalizeVersion`). Las dos vías, por
tanto, **no son comparables entre sí**: un feed escrito para una puede dejar colgada a la
otra. Cerrarlo exige o marcar también la vía ZIP con este esquema —hoy
`distribution/product-delta.json` no fija versión, la trae el archivo— o dejar de publicar
esa vía. Registrado en `updates/README.md`.

## Out of scope

- CI de release.
- Rebrandear dependencias de terceros (`@vscodium/native-keymap`, ripgrep).
