# Listado de modelos instantáneo con refresco en segundo plano

**Abierta**: 2026-09-27 · **Rama**: `feat/source-in-repo` · **Estado**: implementación verificada

## Intención del dueño (27-09)

El picker de modelos tarda en aparecer, sobre todo con el pi externo:
`provideLanguageModelChatInformation` esperaba **todo** antes de devolver — el GET
`${endpoint}/models` sin caché en cada listado y, en modo externo, la construcción del
runtime de pi (escaneo de `~/.pi/agent`: extensiones, skills) en el primer listado tras la
activación y en cada cambio de carpeta.

## Diseño objetivo

Patrón *instant-with-background-refresh*: el listado responde **ya** con lo que tengan las
cachés (fresco o rancio) y agenda los refrescos que necesita; cuando un refresco cambia la
lista, dispara `onDidChangeLanguageModelChatInformation` y el editor vuelve a preguntar.

| Fuente | Caché | Clave | TTL |
| --- | --- | --- | --- |
| Endpoint del formulario propio (`modelsForConfiguration`) | `configuredModelsCache` | sha256(endpoint+apiKey) — la clave cruda jamás vive en un mapa | 5 min |
| Catálogo de pi (`subscriptionModels`, runtime cacheado) | `subscriptionModelsCache` | `agentDir` (`''` si externo sin definir) | 60 s |

**Invariantes**: el mecanismo `lastConfiguration` intacto (la petición lleva modelo, no
configuración; el listado sí puede carecer de ella — para eso es la caché); la proyección de
`projectDeclaredProviders`/`projectDeclaration` sigue en la ruta de respuesta (pi depende de
ella antes de la siguiente petición); sin cambios en `providers.ts`/`endpoint.ts`.

## Tareas

| # | Tarea | Estado |
| --- | --- | --- |
| M0 | `src/models-cache.ts` puro (sin `vscode` ni imports locales, patrón `usage-data.ts`): `CacheEntry`, `cacheKey` (join con \u0000, `undefined` como valor propio), `cachedModels` (frontera TTL exclusiva: fresco en ttl−1, rancio en ttl, miss→undefined+rancio), `storeModels`, `sameIds` (insensible al orden, conables los duplicados), `singleFlight` (un vuelo por clave; el fallo libera el hueco y no envenena el mapa) | ✅ 8 tests |
| M1 | Cableado en `extension.ts`: respuesta inmediata = fichero del perfil + caché configurada (rancia servida) + caché de suscripciones (rancia servida); refrescos en segundo plano con `singleFlight` + detección de cambio por `sameIds` + disparo del evento; proyección del formulario desde ids cacheados (en miss, diferida al refresco); fallos de refresco por `report`, nunca al vacío | ✅ |
| M2 | Invalidaciones: cambio de `picode.providers`/`pi.providers` limpia `configuredModelsCache` y dispara el evento (oyente de ajustes de `activate`); `forgetPiRuntime` limpia también `subscriptionModelsCache` (login/quitar suscripción siguen viéndose al instante) | ✅ |
| M3 | Validación: tsgo nativo `--noEmit` (0 errores) + emit; `node --test` del directorio 82/82 (74 previos verdes + 8 nuevos) | ✅ |

## Primera pintura (composición de la respuesta inmediata)

- **Tras la activación** (cachés vacías): filas del `models.json` del perfil + las de los
  proveedores declarados que `projectDeclaredProviders` proyecta; las cachés de endpoint y de
  suscripciones están en miss → devuelven vacío y el refresco aterriza después y dispara el
  evento → el picker se repinta con esas filas.
- **Tras un cambio de carpeta** (modo externo): el runtime se reconstruye en segundo plano,
  pero la lista sirve al instante desde `subscriptionModelsCache` (clave `agentDir`, sin
  cambiar) + perfil; si el catálogo cambió, repinta.
- **Listados siguientes**: todo desde caché fresca; red y runtime fuera del camino de respuesta.

## Registro

- 2026-09-27 · implementada y verificada por el obrero delegado. Nota residual: la ruta de
  respuesta conserva `await projectDeclaredProviders` (decisión de diseño: pi la necesita
  antes de la siguiente petición), y esa función hace un GET por proveedor declarado en la
  fila de ajustes — si el dueño usa filas declaradas y sigue percibiendo latencia, el
  seguimiento natural es cachear esos ids por (baseUrl, clave) con el mismo módulo.
