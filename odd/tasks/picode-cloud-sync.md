# Cloud Sync — Cuenta PiCode y sincronización en la nube (Firebase)

> Servicio de pago que se vende: sincronizar la configuración completa de PiCode + Pi
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
* **2026-10-01 (guardia de tamaño medía lo equivocado + fix)** — La guardia de tamaño del POST
  medía el CUERPO de la petición (`MAX_BODY_BYTES` = 4 MiB) pero eso no es lo que aterriza en
  Firestore: `store.writeResource` guarda `content: encrypt(payload.content)`, y el sobre
  `picode-enc:v2:` es `base64url(JSON{iv,tag,d})` sobre `base64(gzip(plaintext))` — con entrada
  incomprimible el sobre crece **~1,78x** el plaintext (gzip no encoge, base64 dentro de base64
  infla). Medido reproduciendo el algoritmo exacto: cuerpo 4 MiB → 7.458.960 bytes guardados
  (7x sobre el límite); 900 KB → 1.639.040 (1,5x sobre). Consecuencia observable: cuerpo entre
  ~576 KiB y 4 MiB incomprimible pasaba la guardia, Firestore lo rechazaba con el 500 opaco
  `The value of property "content" is longer than 1048487 bytes` — el único de los tres errores
  de runtime reportados que seguía vivo en HEAD (los otros dos, `machineId: undefined` y el
  ETag débil `W/"ref"`, ya estaban corregidos y verificados según este mismo registro). FIX:
  nueva constante `MAX_STORED_CONTENT_BYTES` (1.048.487 − 512 de reserva para los demás campos
  del ref doc) verificada en `writeResource` TRAS comprimir y cifrar y ANTES de abrir la
  transacción (un payload que se va a rechazar nunca debe abrir una), lanzando `HttpError`
  413 `TooLarge` con el mismo cuerpo de error del contrato; `MAX_BODY_BYTES` queda solo como
  guardia de buffering, documentado así. Bonus: se retiró de `http.ts` el bloque de debug
  temporal `PICODE_DEBUG_500` que el registro del 2026-09-30 daba por retirado pero seguía en
  el código. Verificación: `npm run typecheck` y `npm run build` limpios; script desechable en
  temp del SO que replica el algoritmo del sobre confirma el ratio 1,7785x y que un cuerpo
  incomprimible de 589.518 bytes guarda 1.048.485 bytes (510 sobre el límite con reserva —
  la medición original de 589.518 era contra el límite crudo de Firestore sin reserva) mientras
  que el cuerpo incomprimible más grande que pasa la verificación es 589.230 bytes, y uno de
  900 KB (1.639.040 guardados) lo excede de sobra. Pendiente:
  NO ejercitado contra producción — los despliegues del proyecto están fallando, así que el
  build en producción es anterior a este fix.
* **2026-10-01 (despliegue automático reparado + el fix de tamaño ya en producción)** — Causa
  raíz de los despliegues en rojo: el proyecto `picode-sync-api` tenía **`rootDirectory: null`**,
  así que los despliegues disparados por GitHub compilaban en la **raíz del repo PiCode**, donde
  no hay `app/` ni `pages/` → `Couldn't find any pages or app directory` (log de
  `dpl_HyN5PD8WmD32VwJ5rQbgVqgnnaiR`: `next` resolviendo desde `/vercel/path0/node_modules`).
  Los despliegues READY anteriores (último: 2026-09-30 20:55) no venían de git: su log dice
  «Downloading 28 deployment files» + `Running "npm run build"` con `picode-sync-api@0.1.0`, es
  decir publicados **por CLI desde `cloud/sync-api`**; el histórico de 43 despliegues muestra
  ERROR en todos los de git desde 2026-10-01 18:04. FIX: `PATCH /v9/projects/
  prj_GswcgD4mZLxAPmT030NjYtBVdu43` → `rootDirectory: "cloud/sync-api"` (framework `nextjs`,
  `productionBranch: master` y las 10 variables de entorno ya estaban bien). VERIFICADO: commit
  `c4dcc8cb` de `master` desplegado por la vía de git (**`dpl_8hEGsrxA9RYZ6W9twyA6p5u8HWLG`**,
  READY en 23 s, `Cloning github.com/Tomas-Platero/PiCode (Branch: master)` + las 11 rutas del
  contrato compiladas), el dominio `picode-sync-api.vercel.app` apunta ya a ese despliegue y
  responde `GET /api/health` → 200 `{"ok":true,...}` y `GET /api/v1/manifest` sin token → 401
  con el shape del contrato (`Missing bearer token.`). Con ello **el fix de
  `MAX_STORED_CONTENT_BYTES` está por fin en producción** (presente en `c4dcc8cb`, verificado
  con `git grep` sobre el commit). Las 10 variables de entorno (Firebase + cifrado + cuotas)
  siguen puestas en Preview y Production.

* **2026-10-01 (el sync manual deja de pedir `download/latest`)** — Cada sync manual empezaba con
  un `GET /api/v1/download/latest` que el servidor rechaza por diseño con un 404
  (`Download is not supported in v1.`), y el motor **volvía a pedir el manifiesto acto seguido**:
  una petición fallida por sync y una línea `[info] Request failed` en el registro, más un evento
  de telemetría (`sync.download.latest`), por nada. FIX en el núcleo
  (`userDataSyncService.createManualSyncTask`): va **directo al manifiesto**, el mismo camino que ya
  usaba el sync automático (`createSyncTask`), con el `reportUserDataSyncError` del caso de fallo
  real. Comprobado antes de tocar nada que el 404 no se puede sustituir por un 200: `getLatestData`
  transforma la respuesta leyendo `resources[r][0]`, así que un manifiesto haría `const [x] =
  undefined`, y un «latest-data vacío» haría que `isUserDataManifest` (exige `session` y `ref`) no
  lo reconociese y el editor creyese que **la nube está vacía**. El stub del servidor se queda como
  está: el que preguntaba de más era el cliente.

* **2026-10-03 (CAUSA RAÍZ del «Too many requests»: dos disparadores de sync, no el servidor)** —
  El dueño pega el error `LocalTooManyRequests ... Only 100 requests allowed in 5 minutes`. No es
  cuota del servidor: es el freno **del propio cliente** (`RequestsSession`, 100 peticiones / 5 min
  en `userDataSyncStoreService.ts`) saltando porque el motor hizo ~14 syncs completos en 4 minutos.
  Cada sync completo cuesta ~7 peticiones (manifest + `latest` de cada recurso + POST del recurso
  que cambió). Traza real leída del log de la app en marcha
  (`PiCode-win32-x64/data/user-data/logs/20261003T064324/userDataSync.log`): entre 06:43:27 y
  06:47:24, 14 `[AutoSync] Triggered by Activity`, y en **todos** los ciclos
  `PiProfile: Updated remote pi profile`. Dos disparadores independientes:
  1. **El hub de customizaciones escribía estado transitorio en storage sincronizado.**
     `AICustomizationManagementEditor` guardaba `aiCustomizationManagement.selectedSection` en
     `StorageScope.PROFILE` + `StorageTarget.USER` en cada clic de sección; `globalStateSync`
     reacciona exactamente a cambios con `StorageTarget.USER`, así que **cada clic en el hub
     despertaba un sync completo**. Es navegación, no una preferencia: pasa a
     `StorageTarget.MACHINE` (local, sigue recordando la sección en esta máquina, deja de viajar a
     la nube y de disparar el motor).
  2. **El recurso `piProfile` sincronizaba `~/.pi/agent`, no el perfil interno.** `models.json`
     (146 KB) del perfil externo lo reescribe continuamente el pi del PATH / su sync de OmniRoute;
     cada reescritura re-subía el bundle entero en el siguiente sync. Además incumplía AGENTS.md
     §4 (PiCode no lee ni escribe `~/.pi`; pi resuelve su perfil externo por sí solo). FIX en el
     núcleo (`piProfileSync.ts`): el recurso apunta a **`<dist>/data/pi-agent`**, el perfil propio
     que el extension host y el agent host ya resuelven (`distributionRoot` + `data/pi-agent`,
     `dev/build.sh` lo crea). Se resuelve por `process.execPath`
     (`dirname` = raíz de la distribución) con guarda `/picode/i`, igual que
     `sessionCustomizationDiscovery.ts`; en desarrollo/tests cae a
     `<userData>/../pi-agent`, que es el mismo layout portable. Se añadió además una línea de log
     `Found N pi profile file(s) to consider under <ruta>`: el bundle del perfil externo que quedó
     en `User/sync/piProfile/lastSyncpiProfile.json` contenía **solo los 5 ficheros raíz** pese a
     que `~/.pi/agent` tenía 162 ficheros en las carpetas sincronizadas (agents/skills/memory/
     chains) — el siguiente arranque con este cambio lo evidencia en el log en vez de
     fallar en silencio. Verificación de que el walk funciona: reproducido el algoritmo real con
     el `FileService`+`DiskFileSystemProvider` compilados sobre `~/.pi/agent` → 167 candidatos/162
     de carpetas, así que el cero observado apunta a la ruta/perfil usado en runtime, que es
     justo lo que el fix cambia. Pendiente: typecheck (en marcha) y build.

* **2026-10-03 (BUG DE FONDO: `piProfile` aplanaba todas las rutas y perdía ficheros)** — Verificado
  en vivo arrancando la app: con el cambio de perfil anterior el log ya dice
  `PiProfile: Using pi profile at ...\data\pi-agent` y `Found 37 pi profile file(s)`, o sea el walk
  de carpetas sí funciona. Pero el bundle subido a la nube salió con **32 claves planas**
  (`MEMORY.md`, `SKILL.md`, `2026-09-10.md`…) en vez de rutas (`memory/MEMORY.md`,
  `skills/agent-md-refactor/SKILL.md`), con **una sola `SKILL.md`** pese a que hay 6 skills: los
  ficheros con el mismo nombre colisionaban y se perdían. CAUSA: `PiProfileSynchroniser.getKey`
  hacía `extUri.relativePath(this.syncPreviewFolder, resource)`, pero `syncPreviewFolder` es un URI
  `file://` y el recurso de preview es `userDataSync://local|remote|base/…`; `ExtUri.relativePath`
  devuelve `undefined` cuando difieren scheme o authority (`resources.ts`), así que caía al
  `basename` y aplanaba. Reproducido con los módulos compilados: old → `"MEMORY.md"`, nuevo →
  `"memory/MEMORY.md"`. FIX: construir la carpeta de preview con el scheme+authority del recurso
  antes de comparar. Esto afecta a `updateLocalBackup`, `updateLocalFiles` y `updateRemotePiProfile`
  (los tres usan `getKey`), así que además evitaba que los ficheros remotos se escribieran en su
  subcarpeta. El bundle anterior de 5 ficheros raíz del perfil externo también encaja con este
  aplanado/colisión. Migración de transición aplicada en local (una vez): se borró
  `piProfile.lastSyncUserData` y `User/sync/piProfile/lastSyncpiProfile.json` para que el remoto
  (del mismo `machineId`, verificado `8be8ba58-…`) actúe de base y el primer sync del perfil interno
  sea limpio, sin el conflicto que apareció al cambiar de perfil. Verificado: `Last sync data state
  does not exist` → `Found 37` → `Updated remote pi profile` → `Sync done (4896 ms)`, un solo sync y
  cero `Too many requests`. Pendiente: recompilar con el fix de `getKey` y reconfirmar las claves con
  barra.
* **2026-10-03 (el build borra `data/`)** — Nota operativa: `dev/build.sh` estagía reescribiendo
  `PiCode-Win32-x64/` y el pack **borra la carpeta de plataforma**, así que `data/` (perfil
  portable: sesión de cuenta, estado de sync, perfil pi interno) se va con ella. Usar
  **`dev/build-run.sh`**, que copia `data/` a `.scratch/payload-data-backup` antes y la restaura con
  `dev/restore-profile.mjs` después. En esta sesión `build.sh` se usó una vez y se restauró a mano
  desde esa copia. Además se corrigió `restore-profile.mjs`, que tenía `picode.pi.runtime` en la
  lista de ajustes retirados y **resetaba al usuario a interno**: el runtime interno/externo sigue
  vivo (`runtime.ts`, `picodeConfiguration.ts`), así que se quitó de esa lista.

* **2026-10-03 (CIERRE verificado del storm + pérdida de ficheros)** — Recompilado con
  `dev/build-run.sh` (perfil preservado) y verificado en vivo con la app: primer sync
  `PiProfile: Using pi profile at ...\data\pi-agent` → `Found 37 pi profile file(s)` →
  `Updated remote pi profile` (re-clave única a rutas completas) → **segundo sync
  `PiProfile: No changes found during synchronizing pi profile`**, sin `Too many requests`. El
  bundle final tiene **37 ficheros, 35 con carpeta**, y conserva los **6 `SKILL.md`** distintos
  (`skills/*/SKILL.md`) que antes colisionaban en uno solo. `models.json`+`settings.json` siguen
  en la raíz. Perfil del usuario intacto (runtime `external`, tema, sesión de cuenta, sync).
  Nota: una verificación intermedia marcó `[AutoSync] Disabled` porque la app arrancó 5 s antes de
  que `restore-profile.mjs` terminase de copiar `data/` (carrera de reloj, no un fallo del sync);
  repetida sin build en vuelo, arrancó `Enabled` y sincronizó.

---

## 2026-10-05 · el manejador del callback estaba muerto

El «no me funciona el sync, me abre la web pero no conecta y el log no dice nada» tenía una causa
que se ve en el registro de Windows, no en el código:

```
HKCU\Software\Classes\picode\shell\open\command
  → "C:\Users\tapla\...\Programs\PiCode\PiCode.exe" --open-url -- "%1"    ← carpeta que ya no existe
```

El navegador llamaba a `picode:/auth/callback?…`, Windows lanzaba **un ejecutable inexistente**, y
por eso el editor no registraba nada: no fallaba la sincronización, **no había a quién llamar**.
Debajo había una razón estructural: `electronUrlListener.ts` **se saltaba el registro para
ejecuciones desde carpeta**, así que una build portable nunca podía reclamar el esquema.

Arreglado (`cbd72bad`): el editor **se registra en cada arranque** (portable incluida), **repara una
entrada muerta** al hacerlo y **lo registra en el log** — con la ruta exacta o un aviso si falla. Y
siguiendo el rastro aparecieron **dos bugs más**: el código del callback se **decodificaba dos veces**
(`URI.parse` + `URLSearchParams`) y el emparejador rechazaba la forma que la web envía
(`picode:/`, una barra). Los dos con sus pruebas. La espera ya no es muda: dice que espera, cuándo
llega, y a los cinco minutos **por qué no llegó y cómo arreglarlo**.

**Lo que queda**: que el dueño abra la build una vez y vea en el log
`Registered the picode:// protocol handler: …` antes de reintentar.
