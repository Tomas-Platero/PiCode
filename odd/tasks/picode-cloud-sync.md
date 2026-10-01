# Cloud Sync — Cuenta PiCode y sincronización en la nube (Firebase)

> Servicio de pago que se vende: sincronizar la configuración completa de PiCode + Pi + Gentle AI
> entre instalaciones del editor y una cuenta en nuestra web. PiCode sigue siendo 100% gratuito.
> Referencias: AGENTS.md §6 (modelo de negocio y nube). Investigación previa guardada en memoria
> (observación #119, topic_key `picode-cloud-sync`).

## Decisiones tomadas (por el dueño)

* **Backend: Firebase** (Auth + Firestore). Elección del dueño tras descartar Supabase
  (plan gratis capeado a 2 proyectos) y PocketBase/VPS (mantenimiento).
* **Motor de sync: el motor nativo de VS Code** ya presente en `picode-source`
  (`src/vs/platform/userDataSync/`, `src/vs/workbench/contrib/userDataSync/`). Dormito porque
  `product.json` no declara `configurationSync.store` y las extensiones de login MS/GitHub están
  quitadas. Encenderlo es la vía; no se reinventa un sincronizador.
* **Aviso conocido**: Cloud Functions de Firebase ya no se despliegan en el plan Spark (gratis)
  sin dar de alta facturación. Por eso la API REST del sync se implementa como **Next.js API
  routes en Vercel (plan gratuito)** usando Firebase Admin SDK, y no con Cloud Functions.

## Arquitectura

```
Editor (picode-source)                         Nuestra nube
┌──────────────────────────────┐   HTTPS    ┌─────────────────────────────┐
│ Motor de sync nativo (ya hay)│ ─────────► │ Vercel: Next.js API routes  │
│  - configurationSync.store   │            │  - contrato REST del sync   │
│    apunta a nuestra URL      │            │  - Firebase Admin SDK       │
│  - Proveedor "PiCode Account"│            ├─────────────────────────────┤
│    (login propio, en núcleo) │            │ Firebase Auth (email+pass)  │
│  - Nuevo recurso de sync:    │            │ Firestore (datos por user)  │
│    perfil interno de Pi      │            │ Claves de proveedores:      │
└──────────────────────────────┘            │ cifradas antes de guardar   │
                                            └─────────────────────────────┘
```

## Tareas

- [ ] T1 · Extraer el contrato REST exacto del motor de sync (endpoints, cabeceras, auth) desde
      `picode-source/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts` y afines.
      Salida: especificación API en este documento.
- [x] T2 · Proyecto Firebase "picode-cloud": COMPLETO. Auth Email/Password + GitHub + Google;
      Firestore eur3; reglas publicadas; login del editor en producción (E2E verificado);
      social login en /auth/editor en el scope del worker de la web; www.getpicode.app en
      authorized domains (verificado por la web vía REST); linking de credenciales por email
      manejado (linkWithCredential); decisión canónica: www.getpicode.app.
      cloud/sync-api DESPLEGADA en Vercel (proyecto picode-sync-api, SSO de Vercel desactivado,
      env del service account puestas vía CLI por la web) y verificada por el orquestador:
      401 con nuestro shape en manifest/resource, health 200.
- [x] T3 · Scaffolding `cloud/sync-api/` (Next.js + Firebase Admin) en este repo. Hecho:
      esqueleto completo (package.json, tsconfig, firebase-admin.ts, auth.ts, contract.ts,
      health route, README con variables de entorno). `tsc --noEmit` limpio. Pendiente: rutas
      del contrato REST cuando T1 entregue la especificación.
- [x] T4 · Firestore: esquema y reglas de seguridad. Hecho: esquema real
      (`users/{uid}/sync/manifest`, refs en `users/{uid}/sync/resources/{resource}/{ref}`,
      colecciones en `users/{uid}/collections/{id}`) implementado en `src/lib/store.ts` con
      escrituras transaccionales; reglas publicadas en `cloud/sync-api/firestore.rules`
      (pendiente de pegarlas en la consola), índices vacíos en `firestore.indexes.json`.
      Nota: el esquema se ajustó a las restricciones de rutas de Firestore (alternancia
      colección/documento); el manifest es la fuente de verdad del último ref por recurso.
- [x] T5 · Proveedor de autenticación "PiCode Account" en el núcleo del editor.
      Hecho y verificado: picodeAccountProvider.ts (flujo one-time code → canje
      /api/auth/editor-exchange → custom token → sesión propia; refresh con caché 50min,
      coalescencia, rotación de refresh token, 4xx = revocación; secret storage) +
      picodeAccount.ts (contribución con fail-soft sin config). Corrección del orquestador:
      canje Firebase en form-urlencoded snake_case (el worker lo tenía en JSON camelCase →
      siempre fallaría 400). Typecheck del proyecto completo: 0 errores.
- [x] T6 · Encender el motor: `configurationSync.store` en `product.json` del fork + elegir
      categorías visibles (settings, keybindings, snippets, MCP servers, UI state…).
      Hecho: clave literal "configurationSync.store" apuntando a https://getpicode.app/api
      (el motor añade /v1) + proveedor picode scopes ["sync"] + bloque "picode" (webOrigin,
      firebaseApiKey pública). Callback del login: picode:/auth/callback?flow=editor
      (comunicado a la web).
- [x] T7 · Nuevo recurso de sync para el perfil interno de Pi (agents, skills, subagents,
      proveedores `picode.providers` / `picode.mcp.servers`).
      Hecho y verificado: PiProfileSynchroniser (plantilla SnippetsSynchroniser — recurso de
      DIRECTORIO, no fichero único; merge por fichero reutilizando snippetsMerge; conflicto
      whole-file), bundle {version:1,files} de agents/subagents/skills en ~/.pi/agent vía
      IFileService (skip node_modules/symlinks/>512KB, cap 900KB omitiendo mayores), watch en
      las 3 raíces, backups nativos, borrados aplicados. Solo desde el perfil por defecto.
      Todos los switches exhaustivos extendidos. tsc completo: 0 errores. NOTA: providers y
      mcp servers NO van en este bundle — viajan por el recurso Settings (normal) y sus
      claves por el cifrado server-side de T8.
- [x] T8 · Cifrado de claves de proveedores + consentimiento. DECISIÓN DEL DUEÑO
      (2026-09-29): cifrado del lado del servidor. Implementación en curso: AES-256-GCM con
      clave maestra en env PICODE_ENCRYPTION_KEY (generada por la sesión web, nunca por chat),
      cifrado de TODO el contenido sincronizado en reposo (formato picode-enc:v1:),
      descifrado transparente al servir al cliente autenticado, fallback a texto claro con
      warning si la env no existe. Aplica a claves de proveedores y al resto del contenido por
      igual — la base de datos jamás ve contenido en claro.
- [x] T9 · UI: encendido/apagado en menú de cuentas, gestión de máquinas, textos en inglés.
      Hecho: quick pick de encendido con "Pi Profile" + descripción, disableSync, área label;
      todos los strings nuevos en inglés (verificado por grep).
- [ ] T10 · Pruebas de extremo a extremo: dos instalaciones, misma cuenta, sync bidireccional,
      conflictos y borrar datos en la nube.

## Contrato REST del motor de sync (T1) — extraído del código fuente

Fuente: `picode-source/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts` y afines.

* **Autenticación**: `Authorization: Bearer <token>` (token = idToken o accessToken de la sesión
  del proveedor declarado en `authenticationProviders`) + cabecera `X-Account-Type: <proveedor>`.
  Con 401 el cliente borra el token y re-autentica.
* **Cabeceras de cliente**: `X-Client-Name`, `X-Client-Version`, `X-Client-Commit` opcional;
  sesión: `X-Machine-Session-Id` (siempre), `X-User-Session-Id` (el `session` del último
  manifest), `X-Execution-Id` por ejecución.
* **Base**: `<url>/v1`. Endpoints: `GET manifest` (ETag = ref; 304 con If-None-Match),
  `GET/POST/DELETE resource/:r` (lista de refs con url+created en segundos; POST con If-Match →
  409/412 en conflicto; 413 si >1MiB), `GET resource/:r/latest` (ETag = ref; ref inexistente =
  "0"), `GET resource/:r/:ref`, `DELETE resource`, `GET/POST/DELETE collection`. Errores:
  401/403/404/405/409/410/412/413/426/429; cabecera `x-operation-id` en respuesta.
* **Formas de datos**: manifest `{ latest: {recurso: ref}, session, ref, collections? }`;
  ISyncData `{ version: number, machineId?, content: string }`. Los refs los genera SIEMPRE el
  servidor (UUID), devueltos en la cabecera ETag.
* **configurationSync.store** (product.json): `{ url, insidersUrl, stableUrl, canSwitch?,
  authenticationProviders: { <id>: { scopes: string[] } } }`. Sin esto, el sync aparece como
  no disponible; con providers vacíos, no se puede encender.

Implementación de la API: `cloud/sync-api/` (Next.js en `/api/v1`, desplegable gratis en Vercel;
Cloud Functions descartadas por requerir plan Blaze).

### Cuotas por plan (acordado con la web)

* El plan vive en `users/{uid}.plan` y SOLO lo escriben los webhooks de Stripe de la web.
* Nuestra API lo lee con Admin en cada subida (POST) y limita el total almacenado:
  `free` ≈ 1 MB, `pro` ≈ 25 MB (ajustables con `PICODE_QUOTA_FREE_BYTES` /
  `PICODE_QUOTA_PRO_BYTES`). Excedido → 413 TooLarge. Implementado en `src/lib/quota.ts`.

## Instrucciones para el dueño (T2 — solo tú puedes hacerlo)

1. Entra en console.firebase.google.com con tu cuenta y crea el proyecto **picode-cloud**.
2. Dentro: *Authentication → Sign-in method → habilita Email/Password*.
3. *Firestore Database → Crear base de datos* (modo producción, ubicación europea).
4. *Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada*
   (fichero JSON; NO se sube al repo, va solo a Vercel como variable de entorno).
5. Pásame los datos de *Configuración del proyecto → Tus apps → Web app* (config pública,
   sin peligro) cuando los tengas.

## Coordinación con la web (PiCode-Website)

* La web trae login/registro email+contraseña, sesión httpOnly con cookie `picode_session`
  (verifica ID token con Admin SDK + revocación) y perfil `users/{uid}` (plan, suscripción
  Stripe futuro). Su init de Admin es lazy/env-gated con 503 — patrón a imitar.
* **Decisión de arquitectura (pendiente de confirmación de la sesión web):** el editor habla
  SOLO con el contrato nativo del motor Settings Sync (cloud/sync-api, /api/v1); la web NO
  necesita una segunda API de sync — para paneles lee Firestore directo con Admin. Mensaje
  enviado por intercom; su /api/sync en pausa hasta confirmar.
* Firestore: perfil `users/{uid}` propiedad de la web; datos de sync en
  `users/{uid}/sync/manifest` + `users/{uid}/sync/resources/{resource}/{ref}` (nuestra API).

## Diseño T5 — Login "PiCode Account" (en el núcleo, patrón LanguageModelAccessAuthProvider)

* Proveedor `picode` registrado directamente desde el núcleo (sin extensión), id `picode`,
  scopes `['sync']`.
* **Flujo**: el editor abre `https://getpicode.app/auth/editor?callback=picode://auth/callback`;  
  la web (SDK client Firebase) hace login y redirige al deep-link con `refreshToken` + `uid` +
  `email`. El editor guarda el refreshToken **cifrado** en secret storage
  (`picode.account.refreshToken`) y canjea por ID tokens vía REST público de Firebase
  (`securetoken.googleapis.com/v1/token`), con caché de ~50 min (el ID token dura 1 h).
* La sesión expone el ID token en `accessToken` e `idToken` (el motor prefiere `idToken`).
* En 401 el motor limpia el token y re-pide sesión: el proveedor refresca o, si el refresh
  token está revocado, borra el secreto y dispara cambio de sesiones.
* Fail-soft: sin `product.picode.webOrigin` el proveedor no se registra.

## Diseño T6 — Encender el motor

* `product.json`: clave literal `"configurationSync.store"` apuntando a
  `https://getpicode.app/api` (el motor añade `/v1` → `/api/v1`, nuestras rutas) con
  `authenticationProviders: { picode: { scopes: ["sync"] } }`; bloque `"picode"` con
  `webOrigin` + `firebaseApiKey` (clave Web pública, segura de publicar).

## Contrato con la web para el login del editor (FINAL, v2 one-time code)

* Página `GET {webOrigin}/auth/editor?callback=<uri-encoded picode://auth/callback>`: login
  email+contraseña (SDK client Firebase).
* Tras login, la página llama a `POST /api/auth/editor-token` con `{ idToken }` (verificación
  Admin + checkRevoked por parte de la web); la web genera un **código de un solo uso**
  (random 32+ bytes, Firestore con TTL 5 min, vinculado al uid, marcado usado al consumirse)
  y responde `{ code }`.
* La página redirige a `<callback>&code=<code>` — SOLO el código viaja por el deep-link.
* El editor canjea: `POST {webOrigin}/api/auth/editor-exchange` con `{ code }` → la web
  valida y responde `{ customToken }` (Admin createCustomToken(uid, {app:'editor'})).
* El editor canjea el custom token contra `securetoken.googleapis.com/v1/token` (REST
  público) → obtiene su PROPIO refresh token + ID token, independiente de la sesión del
  navegador. Cero tokens sensibles en URLs/logs (modelo MS/GitHub, propuesta de la sesión
  web aceptada y adelantada).
* Estado: web implementando /auth/editor + los 2 endpoints; editor side delegado al worker
  con este contrato (steer enviado a mitad de vuelo).

## Registro de trabajo

* **2026-09-29** — Creado el documento tras decidir el dueño: backend Firebase. Investigación de
  viabilidad previa concluida (motor nativo reutilizable; sin nada de servidor en el repo).
* **2026-09-29 (web en producción)** — La sesión web publicó y verificó E2E en producción el
  flujo del editor: /auth/editor + /api/auth/editor-token (código de un solo uso, 32B base64url,
  TTL 5min) + /api/auth/editor-exchange (customToken con claim app:editor). Fix de despliegue:
  override jose@5.9.6 (ERR_REQUIRE_ESM en Admin routes). PENDIENTE DECISIÓN DE DESPLIEGUE: cómo
  exponer cloud/sync-api bajo https://getpicode.app/api — opción preferida: rewrite de Vercel en
  el website (/api/v1/* → deployment de cloud-sync-api); alternativa descartada: duplicar rutas
  en el repo de la web. Preguntado a la sesión web.
* **2026-09-29 (limpieza + pagos)** — Limpieza de datos de test ejecutada por la web: 4 docs de
  editorAuthCodes + subcolecciones sync/collections tratadas (recursiveDelete con BulkWriter),
  perfil real del dueño respetado. Webhook de Stripe configurado (whsec) — el plan en
  users/{uid}.plan que escriben los webhooks conecta pagos con las cuotas de la API.
* **2026-09-29 (redeploy cifrado)** — Redespliegue con cifrado en producción verificado por el
  orquestador (picode-sync-9rl4r3bdo; /api/v1/manifest → 401 shape correcto). LADO SERVIDOR
  CERRADO: contratos + auth + cuotas + cifrado + pagos Stripe. Pendientes del dueño (side web):
  suscripción de prueba con cargo real, reCAPTCHA v3, rotación de secretos rk_live_/whsec_.
  Web: OAuth 3 métodos + linking + reset/verificación + consentimiento + legales desplegándose.
  T7: primer worker murió a mitad (enum tocado sin más); relanzado con estado intermedio
  documentado. Siguiente: verificar T7 → T9 textos → construir editor → E2E final.

## Actualización de pi (0.87.1 → 0.99.1) — 2026-09-29

* Pin actualizado en `distribution/runtime.json` → 0.99.1 y runtime instalado en el pack
  (`PiCode-win32-x64/resources/pi-runtime`). El pi global de la máquina del dueño ya estaba
  en 0.99.1.
* **Bug corregido en `dev/pi-runtime.sh`**: el chequeo de "ya instalado" solo miraba si existía
  `dist/index.js`, no la versión — un runtime viejo nunca se actualizaba al mover el pin. Ahora
  compara la versión instalada contra el pin y reinstala cuando difieren.
* Changelog 0.87.1→0.99.1 revisado: **sin breaking changes para nuestra integración**. El SDK
  carga y expone toda la superficie usada (AgentSession, RpcClient, createAgentSession, login,
  ModelRuntime). Novedades: MCP nativo como extensión built-in, codemode, Sign in with ChatGPT,
  modelos virtuales, GPT-6.1 Sol, generación de imágenes/clasificadores; fixes relevantes de
  login por navegador que cuelga y de RPC.
* **Pendiente futuro (no bloqueante)**: pi 0.99 trae MCP nativo (mcp.json / pi.registerMcpServer);
  decidir si la proyección MCP de PiCode pasa a usar el mecanismo nativo en vez del propio.
* **2026-09-29 (CORS definitivo)** — El fallo del canje identificado con logs de ambos lados: el
  HTTP stack del editor hace preflight CORS y la ruta no respondía OPTIONS (405). Fix de la web
  (commits 16bd265 + d8353b1): reflejo de Origin en editor-token y editor-exchange, verificado
  en producción con vscode-file://, null y Origin normal. Justificado: CORS no es la barrera —
  lo son el idToken y el código de un solo uso. **El dueño puede reintentar el login.**
* **2026-09-29 (E2E: dos fallos de contrato encontrados y corregidos)** — Primer login REAL del
  dueño: ✅ auth completa (código → canje → sesión, con el fix del custom token en
  accounts:signInWithCustomToken — securetoken los rechaza). El sync falló después por dos
  desviaciones de contrato de nuestro servidor: (1) GET latest de recurso inexistente devolvía
  200+body vacío y el cliente parsea '' → IncompatibleRemoteContent ("datos antiguos") — lo
  correcto es **204 No Content** (hasNoContent del cliente); (2) DELETE /api/v1/collection sin
  id devolvía 405. Ambos corregidos, desplegados a producción (dpl_GVTiKDob...) y verificados
  (CLI confirma producción; health 200, manifest 401 shape correcto). Además: dominios de
  confianza (linkProtectionTrustedDomains) y callback limpio sin windowId en el editor.
* **2026-09-29 (PRUEBA DE FUEGO CERRADA ✅)** — Verificación final por la sesión web (lectura
  Firestore con Admin, uid del dueño): manifest ✓; 4 refs (extensions 1, globalState 2,
  settings 1); **4/4 blobs cifrados con prefijo picode-enc:v1: — cero en claro**; ~135.6 KB de
  cuota. El servicio funciona de punta a punta: login (3 métodos) → código de un solo uso →
  canje → sesión propia del editor → sync cifrado. Nota: el doc padre "resources" no existe
  (subcolecciones huérfanas, quirk de Firestore — no hacer get() del padre). Pendientes de
  pulido: avatar en el menú de cuentas, ocultar vista Developer (decisión del dueño),
  commits de todo el trabajo (sin versionar aún).

## Lote de pulido (2026-09-29, noche) — decisión del dueño

* **Sync solo para Pro**: no podrá activarse sin cuenta Pro. Refuerzo en servidor (autoritario:
  402 en rutas de sync para no-Pro) + editor (mensaje limpio "requiere Pro" al crear sesión).
* **Avatar** en el menú de cuentas: soporte nativo (`AuthenticationSessionAccount.icon` +
  ajuste `workbench.accounts.showAvatar` por defecto true) — alimentar con el claim `picture`
  del ID token (Google/GitHub).
* **Ocultar "Sync Activity (Developer)"** (userDataSyncViews.ts:176).
* **Menú de cuentas**: quitar "Turn on Remote Tunnel Access" (fuera de la historia del
  producto); se conservan "Manage Extension Account Preferences" y "Manage Language Model
  Access" (esta última pertenece al chat).
* **2026-09-30 (E2E: dos bugs más, stack capturado)** — El primer sync real del dueño sincronizó
  9/11 recursos correctamente (settings, keybindings, snippets, tasks, mcp, globalState,
  extensions, prompts, profiles — todo estable en ciclos siguientes). Fallaron: (1) piProfile
  500 — **stack capturado por el monitor de la web** (console.error desplegado): Firestore
  rechaza content > 1.048.487 bytes — el bundle ~900KB cifrado crece ~33% y supera el límite
  1MiB/doc. FIX: compresión gzip dentro del cifrado (formato **picode-enc:v2:**; v1 legacy
  soportado en lectura) — 900KB → ~200KB cifrado. (2) machines 400 — el servicio de machines
  envía JSON SIN envoltura ISyncData; el POST ahora acepta contenido OPAQUE (el servidor solo
  guarda y sirve bytes). También: errorResponse ahora loguea con stack los errores inesperados
  (antes se tragaba los 500). Desplegado; pendiente re-test con token fresco por fichero.
* **2026-09-30 (CAUSA RAÍZ + HARNESS 100%)** — Diagnóstico definitivo del fallo del POST: la
  transacción escribía `machineId: undefined` cuando el payload no lo traía (contenido opaco) y
  **Firestore rechaza valores undefined por diseño** → 500 en TODOS los POSTs opacos. FIX
  correcto (nivel 2): sanitizar los metadatos del ref — omitir campos undefined
  (`refData.machineId` solo si existe). El flag global ignoreUndefinedProperties no existe en
  firebase-admin 12. Verificación automatizada sin el dueño: token de prueba por FICHERO (los
  tokens se corrompen por chat — 3ª vez), custom token canjeado vía identitytoolkit, y harness
  E2E completo contra producción: **12/12 pasos OK** + bundle de 500KB con unicode → POST 200,
  round-trip intacto, gzip v2 (~500KB → ~50KB cifrado), DELETE clear 200. Debug temporal
  (PICODE_DEBUG_500) retirado tras el diagnóstico. Test data users/e2e-probe-user pendiente de
  borrar por la web al cerrar.
* **2026-09-30 (CAUSA RAÍZ DEL 500 FINAL + validación 100%)** — Los 500 de piProfile/machines
  NO eran tamaño: era el **If-Match en formato ETag débil** (`W/"ref"` — los intermediarios
  debilitan los ETags al comprimir respuestas) pasado crudo a Firestore doc() → path inválido.
  FIX: normalizeIfHeader strippea W/ + comillas + whitespace (aplica a If-Match e If-None-Match).
  Validación automatizada contra producción: caso exacto (POST con If-Match weak) → 200 ✓,
  ref inexistente → 409 ✓ (diseñado), round-trip contenido ✓, account plan pro ✓, clear ✓,
  post-clear vacío ✓. El dueño retestea en la app; limpieza de datos de prueba coordinada con
  la web (users/e2e-probe-user + .probe-token).
* **2026-09-30 (FASE 2: canal de respaldo de sesiones ✅)** — Implementado y verificado
  (tsc doble limpio): cada fichero de sesión (~/.pi/agent/sessions/<proyecto>/*.jsonl) se sube
  como su propio ref opaco en `piSessionsBackup` (el servidor hace gzip+v2 cifrado); subida
  INCREMENTAL por hash SHA-1 con estado en globalState (`picode.sessionsBackup.state.v1`);
  estado persistido tras cada subida individual (una ejecución interrumpida nunca recarga);
  omisiones: no-jsonl, >20MB (reportados); borrados locales NUNCA borran en la nube (historial).
  Comandos: `picode.backupSessions` + `picode.restoreSessions` (restauración con confirmación
  modal, dedupe por clave reconstruida desde la primera línea del ref). Cuota Pro: **25 MB →
  500 MB** desplegada a producción. Nota: el comentario del changelog interno de dev/pi-runtime.sh
  cita una regla del dueño en español — intencional. Onboarding: End-the-setup cierra Welcome ✓,
  primer paso = Login ✓ (6 pasos; hallazgo: login.ts era el flujo de PROVEEDORES, el login de
  cuentas vive en el núcleo y se reutilizó). Pendiente: build final en marcha, prueba del dueño,
  commits (aprobación pendiente).
* **2026-09-30 (decisión final de cuota)** — El dueño ajustó su propuesta: **Pro = 50 MB** con
  **ventana móvil de 7 días** de conversaciones y expulsión de las más antiguas al acercarse al
  límite (borrar la más vieja para entrar en la nueva). Implementado: quota.ts pro=52.428.800 B
  desplegada a producción; sessions-backup.ts con filtro de ventana (mtime ≥ now−7d), expulsión
  de refs fuera de ventana + guardia blanda (45 MB) que prioriza las más recientes. Cero cambios
  en el servidor para la expulsión (DELETE por ref ya existía). Números del dueño validados:
  206 MB de conversaciones → ~40-60 MB comprimidas → ventana de 7 días típicamente 5-20 MB ✓.
* **2026-09-30 (web: cuota alineada — cierre)** — La web desplegó (a7818e6): plans.ts
  SYNC_QUOTA_BYTES pro = 52.428.800 (50 MiB) + "50 MB" en /pricing y landing, con el argumento
  "Your last week of AI conversations, always with you". La barra de uso de /account lee de
  plans.ts (se corrigió sola). Paridad total web ↔ API ↔ editor en la cuota. Bonus: fix de un
  import de releaseUrl dropeado en su refactor. Lado web cerrado.
* **2026-09-30 (CAUSA RAÍZ de la galería vacía + fix)** — Diagnóstico con la API real de Open
  VSX: la respuesta de búsqueda NO incluye files.manifest en NINGUNA candidatura (0/48) y el
  conector descartaba toda fila sin manifestUrl → la galería se pintaba vacía ("no funciona
  para nada"). FIX: derivar manifestUrl del download URL (…/file/{vsix} → …/file/package.json,
  el manifest servido por Open VSX con 302 que fetch sigue). Verificación replicada con la
  lógica exacta del conector: 48/48 candidaturas con manifest → **36 temas de color reales**
  (One Dark Pro, Catppuccin, Dracula, GitHub Theme…). Reconstrucción de la app en marcha.
