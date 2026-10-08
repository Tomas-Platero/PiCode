# Feature: el login de MCP que se podía renovar deja de pedirse cada hora

**Estado:** en curso · **Rama:** `experimental` · **Abierta:** 2026-10-08

## Intención del dueño

> «Hay algo raro con el mcp de hound […] Dice que necesitara sign-in […], le doy y me aparecen dos
> mensajes […] pero sigue apareciendo [Needs sign-in]. he reiniciado y nada. […] No tenemos hound
> instalado.»

> «pues revisa con vercel por eso. sería lo mismo para hound.»

El síntoma: un servidor MCP remoto se entra bien, PiCode dice «is signed in», y aun así la fila
vuelve a **Needs sign-in**, y reiniciar no lo arregla. El dueño no pudo darme la definición de
`hound` (no está en ningún `mcp.json` de esta máquina, ni en el perfil de PiCode, ni en el del pi
externo, ni en ningún `.pi/mcp.json` de proyecto, ni en el snapshot de sincronización, ni en ningún
paquete de pi: búsqueda exhaustiva el 2026-10-08). Sí apareció el mismo síntoma, medido, en
**vercel**, y eso es lo que se arregla aquí.

## Lo que se midió antes de tocar nada (2026-10-08)

| Dato | Valor |
| --- | --- |
| `pi mcp list` contra el perfil de PiCode | `vercel: needs sign-in` (todos los demás, conectados) |
| Credencial guardada de **vercel** | `access_token`, `id_token`, `expires_in: 3600` — **sin `refresh_token`** |
| Credencial de **sentry** y **atlassian-rovo-mcp** | **con `refresh_token`** — esos no dan el problema |
| Lo que pi pide sin configurar nada | `scope=openid` (los permisos que anuncia el recurso) |
| Lo que anuncia el servidor de autorización de Vercel | `["openid","email","profile","offline_access"]` |
| Dónde mira PiCode la credencial | `mcp-auth.json` del perfil, clave `mcp__<nombre con - → _>|<url>` |

### Por qué pasa

Un proveedor OAuth solo emite **refresh token** si la petición incluye el scope `offline_access`. pi
no lo pide por su cuenta: pide los permisos que el **recurso** anuncia (`openid`), y el recurso de
Vercel no lista `offline_access` aunque su servidor de autorización sí pueda emitirlo. Sin refresh
token, cuando el access token caduca (una hora) pi no puede renovar y solo sabe volver a pedir login.
Reiniciar no ayuda: no hay nada con lo que renovar.

### El mecanismo, comprobado sin abrir navegador

Se condujo el propio `signInMcpServer` de pi con un prompt de mentira (`.scratch/mcp-scope-probe.mjs`)
para capturar la URL de autorización sin completar el login:

| `oauth.scope` en la entrada | scope que pi acaba pidiendo |
| --- | --- |
| (ninguno) | `openid` |
| `offline_access` | `offline_access` ← **pierde `openid`** |
| `openid offline_access` | `openid offline_access` ← **lo que queremos** |

De ahí la regla: se **añade** `offline_access` a lo que ya se iba a pedir, nunca se sustituye.

## Decisión

### 1. El arreglo inmediato: el perfil en vivo

`perfil/pi-agent/mcp.json` → la entrada de `vercel` pasa a
`{"url":"https://mcp.vercel.com","oauth":{"scope":"openid offline_access"}}`. Copia previa en
`.scratch/mcp.json.antes-scope.json`. El validador de pi acepta la entrada y `pi mcp list` sigue
listándola. Con esto, el siguiente login de vercel del dueño ya pide `offline_access` y guarda un
refresh token **sin esperar a un build**.

### 2. El arreglo de fondo: automático para cualquiera en la misma situación

Antes de lanzar `pi mcp login <server>`, PiCode mira los metadatos del servidor y, si su servidor de
autorización anuncia `offline_access`, escribe ese scope en la entrada **sumándolo** a los permisos
que ya se pedían. La fuente de metadatos es la de pi, no una segunda opinión:

1. Lo que pi **ya cacheó** junto a la credencial (`mcp-auth.json`, `discovery`), que está ahí para
   cualquier servidor que se haya contactado alguna vez.
2. Si no hay caché (un servidor nuevo), el propio `discoverOAuthServerInfo` de pi, cargado del
   **mismo paquete** (`@earendil-works/pi-mcp`, hermano del SDK dentro del runtime).

El paso es **best-effort**: cualquier fallo (sin red, metadatos raros, módulo ausente) deja el login
exactamente como estaba, nunca lo bloquea.

### 3. La entrada declarada ya no pierde lo que la fila no expresa

`mcpServersFile` reemplazaba la entrada declarada con la que escribe el formulario, así que
`enabled`, `exposure`, `toolExposure` y el propio `oauth.scope` se borraban en cada activación. Ahora
la entrada en disco es la base y el formulario solo pisa las claves que habla (`type`, `url`,
`command`, `args`, `env`, `headers`), con `oauth` fusionado clave a clave. Es la misma regla que
`mergeModelsFile` aplica a los modelos desde `picode-pi-102.md`.

## Ficheros

| Fichero | Qué cambia |
| --- | --- |
| `src/mcp-scopes.ts` (nuevo) | La decisión pura: cuándo añadir `offline_access` y con qué scope base |
| `src/piSdk.ts` | `mcpOauthModuleOf`: el `discoverOAuthServerInfo` de pi, del mismo install que el SDK |
| `src/mcp-provider.ts` | `storedDiscoveryOf`: leer la discovery cacheada junto a la credencial |
| `src/mcpServers.ts` | `mergedServerEntry` (la entrada declarada conserva lo ajeno) y `mcpServersTextWithOAuthScope` |
| `src/extension.ts` | `ensureSignInCanBeRenewed`, llamado antes de abrir el navegador |
| `test/mcp-signin-scope.test.ts` (nuevo) | 12 pruebas de la decisión y de la escritura |

## Verificación

| Qué | Cómo se comprobó |
| --- | --- |
| La decisión | `node --test …/test/mcp-signin-scope.test.ts` → **12 pasan, 0 fallan** |
| Toda la suite del conector | `node --test …/test/*.test.ts` → **392 pasan, 1 omitida, 0 fallan** |
| El tipado del conector | `tsc --noEmit` → **sin errores en los ficheros de este cambio** |
| La entrada en vivo la acepta pi | `validateMcpServerConfig('vercel', {url, oauth:{scope}})` → **aceptada** |
| El scope que pi pide con el arreglo | `mcp-scope-probe.mjs` → `scope=openid offline_access` |

### Cierre (2026-10-08)

| Qué | Valor |
| --- | --- |
| Conector compilado | `bash dev/build-connector.sh` → **exit 0**; `out/mcp-scopes.js` y los símbolos nuevos dentro de `out/extension.js` |
| Build del pack | La build de la sesión paralela (`PICODE_PACK_SUFFIX=" - experimental"`, sin instalador) → `PiCode-win32-x64 - experimental/`, con **los dos** trabajos dentro |
| pi dentro del pack | **1.1.0** |
| Mi cambio dentro del pack | `out/mcp-scopes.js` presente; `ensureSignInCanBeRenewed` en `out/extension.js`; y el **artefacto empaquetado** decide bien, importándolo y probándolo |
| Durabable y perfil | `resources/pi-durable` (116M) y el bridge; perfil sembrado en `data/` |
| Perfil del dueño | Arreglado en vivo: la entrada de vercel pide `openid offline_access` |

Prueba del artefacto empaquetado (no del fuente): `offlineAccessScope` devuelve `openid offline_access`
para vercel, `undefined` para un servidor sin `offline_access`, y `mcpServersTextWithOAuthScope` mueve
solo `oauth.scope` de la entrada pedida.

Lo que queda por comprobar con el navegador, y es del dueño: entrar en `vercel` una vez y ver que
`mcp-auth.json` guarda `refresh_token` y que la fila deja de pedir login al cabo de una hora.
