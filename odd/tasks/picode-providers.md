# Feature: conectar proveedores (OAuth y clave) desde PiCode

## Goal

Poder conectar los proveedores que la gente usa —ChatGPT, Claude, xAI, OpenRouter…— **por
suscripción (OAuth)** o **por clave de API**, desde PiCode, para la instancia de pi que se
haya elegido. Sin reimplementar OAuth: pi ya hace el flujo y guarda la credencial; lo que
falta es superficie.

## Why this feature exists

pi trae un catálogo de proveedores con sus métodos de autenticación, y PiCode ya lo lee.
Pero la lista que ofrecía **colapsaba cada proveedor a una sola vía**, y el orden de
comprobación hacía que la clave ganara siempre. Resultado medido: **41 filas, 1 sola con
«suscripción»**, y los siete proveedores que admiten ambas —entre ellos `anthropic`
(Claude Pro/Max) y `openrouter`— aparecían únicamente como «clave». Conectar Claude con
una cuenta Pro/Max era **imposible** desde aquí aunque pi lo soporte.

## Hallazgo que ordena todo (medido, no leído)

`pi-login-command.ts` decidía con `loginType(facts)`:

```text
si ya hay suscripción → oauth
si ya hay oauth       → oauth
si hay login por clave → api_key     ← ganaba siempre
si hay oauth           → oauth
```

Y un catálogo real instanciando el SDK (`createAgentSessionServices` →
`modelRuntime.getProviders()`) da **41 proveedores**, de los cuales **8** admiten OAuth:

`anthropic`, `github-copilot`, `kimi-coding`, `meta`, `openai-codex`, `openrouter`,
`radius`, `xai`.

De esos, **7 admiten además clave** (`openai-codex` es OAuth puro), y los 7 se ofrecían
solo como clave.

### Las dos instalaciones de pi, y por qué importa

La máquina tiene dos, y no son la misma versión:

| Ruta | Versión | Quién la usa |
| --- | --- | --- |
| `~/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent` | **0.86.1** | el pi propio de PiCode (lo fija `extensions/picode-pi-chat/runtime.json`) |
| `%APPDATA%/npm/node_modules/@earendil-works/pi-coding-agent` | **0.87.1** | el pi del PATH, y `picode.pi.runtime` por defecto es `path` |

Medido con las dos: **el catálogo es idéntico** (41 proveedores, los mismos 8 con OAuth,
mismos nombres, `login()` presente en ambas). No hay que ramificar por versión, pero sí
saber que las docs de 0.86.1 y las publicadas (0.87.1) pueden diferir.

> **Decisión del dueño sobre qué proveedores ofrecer** («copilot es otro 'proveedor' más
> que podemos usar con pi, hay muchísimos como deepseek, etc, **pon los más usados**»).
> La lista salía alfabética y enterraba Claude, ChatGPT, DeepSeek y Copilot bajo nombres que
> empiezan por letras tempranas. Ahora hay una **lista curada** (`FEATURED_PROVIDERS`) que va
> primero: Anthropic, OpenAI Codex (ChatGPT), OpenAI, Google, DeepSeek, xAI, OpenRouter,
> GitHub Copilot, Mistral y Groq. **No filtra**: todo lo demás sigue ofreciéndose debajo, en
> orden alfabético. Copilot entra como uno más, sin trato especial.

## Decisions

1. **Una fila por vía, no por proveedor.** Una suscripción de Claude y una clave de
   Anthropic son **dos decisiones distintas** y pi corre un flujo diferente para cada una.
2. **Orden de las vías**: la credencial ya guardada primero (la fila en vigor se lee
   antes), después la **suscripción** (es la más estrecha y la que estaba invisible), y por
   último la clave (siempre aplica, no necesita ayuda para encontrarse).
3. **`loginType` es la primera vía ofrecida**, así que la decisión de un solo login y la
   lista no pueden contradecirse.
4. **No se reimplementa OAuth.** `runtime.login(providerId, type, interaction)` es el flujo
   de pi; las interacciones (`onAuth`, `onDeviceCode`, `onProgress`, `onPrompt`,
   `onSelect`) se siguen resolviendo con los diálogos del editor, como ya hacía el comando.
5. **`openai-codex` no ofrece clave** porque pi no le da login por clave: la fila de
   ChatGPT es solo «suscripción», y eso es un hecho del catálogo, no una limitación nuestra.

## Tasks

- [x] T1 Medir el catálogo real de las **dos** instalaciones de pi y compararlas.
- [x] T2 `providerOffers(facts)` y `loginType` = primera vía.
- [x] T3 `providerEntries` → una fila por vía; `chooseProvider` sigue funcionando con
      filas repetidas (se distinguen por la descripción).
- [x] T4 Tests que cubren el caso que nadie cubría: un proveedor con **ambas** vías.
- [x] T4b `providerRows(entries)`: la vía entra en la etiqueta **solo** cuando el nombre se
      repite, para que dos filas del mismo proveedor no se lean como gemelas y sin imprimir
      el mismo dato dos veces. Puro, con test, en vez de dentro del widget.
- [x] T5 Superficie nativa: **la fila de proveedores vive en Settings**, dentro del nodo
      Chat. Decidido por el dueño: «quiero que el flujo viva nativamente en settings».
- [x] T6 Build completa y arranque real sin errores (ver abajo).

### T5 · cómo está construido, y por qué así

Una fila de Settings **es un valor, no un botón**, y —medido en la fase D— el árbol de
Settings se construye con `resolveSettingsTree(tocData, coreSettingsGroups, …)`
(`settingsEditor2.ts:1477`): solo los ajustes del **core** pasan por `tocData`. Los de una
extensión acaban siempre bajo `Extensions > <nombre>`
(`createTocTreeForExtensionSettings`, `settingsTree.ts:480`), que no consulta `tocData`.

De ahí las tres piezas:

1. **`patches/picode/06-picode-provider-settings.patch`**: declara `picode.pi.providers`
   **en el core** (nuevo `contrib/picode/browser/picodeConfiguration.ts`, importado desde
   `workbench.desktop.main.ts`, que está limpio; el `workbench.common.main.ts` lo tiene
   tocado VSCodium y no se puede parchear limpio). Es la única forma de que un ajuste
   caiga dentro de un nodo del core.
2. **`patches/picode/04-…`** añade el nodo `chat/picodeProviders` («Proveedores») con el
   glob `picode.pi.providers`.
3. **La descripción lleva los enlaces**, que es el idioma nativo del editor para poner una
   acción en una fila: `[por suscripción o con una clave](command:picode.piChat.loginProvider)`
   y `[con sus modelos](command:picode.piChat.modelsProviders)`. El flujo que se abre detrás
   es el de pi, con los diálogos del editor.
4. **La extensión escribe la fila** (`withConnectedProvider`, puro, + `rememberConnectedProvider`)
   tras un login **correcto**, nunca antes: registrar un proveedor cuya credencial falló
   haría de la fila la única parte mentirosa del flujo. Es el registro de lo conectado
   desde PiCode, no un espejo de `auth.json`.

No se movieron los otros ocho ajustes `picode.*`: eso es el defecto de D1 y va aparte.

## Evidencia

- Antes: `rows offered: 41 of 41` · `how many rows say 'suscripción': 1`.
- Después: `rows offered: 48 of 41` (los 7 duales aportan dos filas) ·
  `how many rows say 'suscripción': 8`.
- Fila doble de Anthropic, medida contra el catálogo real:
  `Anthropic · suscripción · todavía sin credenciales` y
  `Anthropic · clave · todavía sin credenciales`.
- `extensions/picode-pi-chat`: `npm test` → `EXIT=0`, **36 suites, 0 fallos, 1357 checks**
  (`test/pi-login-command.test.js` con los nuevos casos de vía doble y de filas).

## Evidencia de T5/T6

- Build `./dev/build.sh -s` → `BUILD_EXIT=0`, `compile-src … with 0 errors` con la
  contribución de core nueva.
- En el paquete: `picode.pi.providers` presente en
  `out/vs/workbench/workbench.desktop.main.js`, y en `out/nls.messages.json` la etiqueta
  `"Proveedores"` y la descripción completa con **los dos enlaces de comando**.
- Arranque real (`data/user-data/logs/20260924T101123`): `exthost.log` sin errores; el
  único error del renderer es el `DEP0190` conocido de nuestro `spawn`.

## No medido (y por tanto no afirmado)

- **La colocación dentro del nodo Chat no está observada, solo razonada.** Mi primer
  intento de probarla se apoyaba en que el ajuste no apareciera en el aviso «Settings not
  included in settingsLayout.ts», pero ese aviso **no se emite en esta ejecución**: lo
  lanza el editor de Settings al abrirse, una vez por sesión, y no lo abrí. O sea que la
  ausencia no probaba nada, y así queda dicho. Lo que sí está verificado es que el ajuste
  está registrado **por el core** y que el nodo con su glob existe, que es la condición
  exacta que `resolveSettingsTree` comprueba; la confirmación visual necesita abrir
  Ajustes → Chat → Proveedores.
- **No se ha ejecutado un login OAuth real** desde el editor: lo verificado es que la vía
  se ofrece, que el catálogo es el de pi y que la fila se escribe tras un login correcto.
  El flujo en sí es el de pi y ya existía.

## Fuera de alcance

- Registro del propio pi/gentle-ai en el hub de personalizaciones (feature aparte).
- Múltiples cuentas por proveedor (lo que PI-Desktop sí hace: una fila por cuenta). Aquí
  pi guarda una credencial por id de proveedor.
