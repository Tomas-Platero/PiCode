# PiCode Cloud Sync API

The backend of PiCode's sync service: it implements the REST contract the editor's
Settings Sync engine expects, authenticates against Firebase Auth, and stores each
user's data in Firestore.

- Firebase project: `picode-7f24f`
- Client REST contract: `src/lib/contract.ts` (types) and the route table below

## 🔨 Development

```bash
cd cloud/sync-api
npm install
npm run dev   # http://localhost:3400
```

## 🔑 Environment variables

Create `.env.local` (it is not committed) with:

```bash
FIREBASE_PROJECT_ID=picode-7f24f
FIREBASE_CLIENT_EMAIL=<firebase-adminsdk@picode-7f24f.iam.gserviceaccount.com>
FIREBASE_PRIVATE_KEY=<the service account's private key, with escaped \n>
PICODE_WEB_ORIGIN=http://localhost:3600
PICODE_ALLOWED_CLIENTS=picode
```

`FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` come from the service account JSON:
Firebase console → Project settings → Service accounts → Generate new private key.
On Vercel they are set as project environment variables (never in the repository).

## 🗂️ Layout

```text
src/
  lib/                    # shared rules (no route logic here)
  app/api/                # contract routes (manifest, collection, resource, ...)
test/                     # pure rules: plans, retention
```

### `src/lib/` — las reglas compartidas

| Fichero | Qué hace |
| --- | --- |
| `firebase-admin.ts` | La única inicialización del SDK de Firebase Admin (una app, no una por request). |
| `auth.ts` | Verifica el token de Firebase de cada petición (cabeceras de sincronización). |
| `contract.ts` | Los tipos del contrato REST que el cliente de sincronización espera (extraídos del editor). |
| `errors.ts` | El error que las rutas convierten en respuesta (sin Next.js, para poder probarlo solo). |
| `http.ts` | Helpers de respuesta: el `x-operation-id` (UUID) que lleva toda respuesta. |
| `store.ts` | El modelo de datos en Firestore (rutas alternando colección/documento) y sus transacciones. |
| `crypto.ts` | Cifrado en reposo: brotli + AES-256-GCM en binario antes de escribir (lee también los formatos viejos). |
| `plans.ts` | Qué plan declara el perfil (lo no reconocido es `free`). Sin Firestore. |
| `quota.ts` | Lee el plan del usuario y lo memoriza un momento (la política vive en `plans.ts`). |
| `retention.ts` | Cuántas revisiones por recurso se conservan (20) y qué historial se suelta si la cuota se llena. |

### `src/app/api/` — las rutas

| Ruta | Qué hace |
| --- | --- |
| `health/route.ts` | Liveness: no toca Firebase, sirve para validar el despliegue. |
| `v1/manifest/route.ts` | Devuelve el manifiesto con `ETag` y responde `304` si no cambió. |
| `v1/resource/[r]/route.ts` | Lista las revisiones de un recurso / añade una / las borra. |
| `v1/resource/[r]/latest/route.ts` | La última revisión de un recurso (`ETag`, `304`). |
| `v1/resource/[r]/[ref]/route.ts` | Una revisión concreta por su ref. |
| `v1/resource/route.ts` | Borra todos los datos del usuario + manifiesto. |
| `v1/collection/` · `v1/collection/[id]/` | Lista, crea y borra colecciones (idempotente). |
| `v1/account/route.ts` | La cuenta, con CORS (la llama el renderer del editor). |
| `v1/download/` · `v1/download/latest/` | `404` en v1 (no se usa), pero autenticado y con control de plan. |

La tabla completa de métodos y códigos de respuesta está más abajo, en *API endpoints*.

## 🔌 API endpoints

All routes live under `/api/v1` (the client computes `<storeUrl>/v1`), require
`Authorization: Bearer <firebaseIdToken>` plus `X-Account-Type`, and always
return an `x-operation-id` header (UUID) for diagnostics.

| Method & path | Behavior |
| --- | --- |
| `GET /api/v1/manifest` | Manifest `{ latest, session, ref }` with `ETag`; `If-None-Match` → `304`. |
| `GET /api/v1/resource/:r` | Ref list `[{ url, created }, ...]`; `:r` sanitized to `[A-Za-z0-9_-]+`. |
| `GET /api/v1/resource/:r/latest` | Latest ref's ISyncData with `ETag`; `If-None-Match` → `304`; no data → `200`, `ETag: "0"`, empty body. |
| `GET /api/v1/resource/:r/:ref` | That ref's ISyncData with `ETag`; unknown ref → `404`. |
| `POST /api/v1/resource/:r` | Append new revision (server-minted UUID ref, manifest bump, transactional); optional `If-Match` → `412` (stale) / `409` (unknown ref); body > 4 MiB → `413`, or a revision that would not fit the store → `413`; answers `ETag: "<newRef>"`. |
| `DELETE /api/v1/resource/:r` | Delete the resource's refs; manifest entry reset to `"0"`. |
| `DELETE /api/v1/resource/:r/:ref` | Delete one ref; manifest updated if it was the latest. |
| `DELETE /api/v1/resource` | Clear all the user's data + manifest. |
| `GET/POST /api/v1/collection` | List `[{ id }]` / create (plain-text UUID id). |
| `DELETE /api/v1/collection/:id` | Delete one collection (idempotent). |
| `GET /api/v1/download(/latest)` | `404` (not used in v1). |

## 📏 Size limits

The request body cap is 4 MiB, but it is only a buffering guard: it bounds what
the server is willing to read, not what the store accepts. What is stored is
`content`, a binary envelope (brotli, then AES-256-GCM, plus 32 bytes of header)
in a Firestore Bytes field, and Firestore rejects any document over
1,048,487 bytes.

The limit that matters is therefore the stored envelope, checked after
compression in `writeResource`; the API answers `413 TooLarge` when a revision
would not fit the store. Compressible JSON (everything the editor syncs) fits
the full 4 MiB request cap; incompressible content tops out just under 1 MiB.

Error mapping follows the client contract: 401 Unauthorized, 403 Forbidden
(disallowed `X-Client-Name`), 404 NotFound, 405 MethodNotFound, 409 Conflict,
412 PreconditionFailed, 413 TooLarge; 429 responses may carry `Retry-After`.

Firestore layout (paths strictly alternate collection/document segments):

- `users/{uid}/sync/manifest` — `{ latest, session, ref, updatedAt }`
- `users/{uid}/sync/resources/{resource}/{ref}` — `{ content, machineId?, version, created, deleted }`
- `users/{uid}/collections/{id}` — `{ created }`

The manifest's `latest[resource]` entry is the authoritative latest ref and is
updated in the same transaction as every write.

## 🧾 Plans and quotas

Cloud sync is **Pro-only**. Every contract route calls `requirePro`, which
answers `402 PaymentRequired` for any account whose `users/{uid}.plan` is not
`pro`, so a free account can sign up and link the editor but stores nothing:
its quota is 0 on purpose and `PICODE_QUOTA_FREE_BYTES` is ignored.

The Pro quota is `PICODE_QUOTA_PRO_BYTES` (default 50 MiB), counted on stored
bytes and enforced inside the write transaction. A full quota costs **history,
not data**: before refusing a write, the oldest revisions are dropped (the
resource with the heaviest history first), and the latest revision of every
resource is never dropped. Only when every resource is down to its latest and
the write still does not fit does the API answer `413 TooLarge`, and the editor
then keeps syncing every other resource (`TooLarge` no longer stops the run).

## 🔐 Data encryption at rest

All synced resource content is **encrypted server-side before it is written to
Firestore** (AES-256-GCM, authenticated encryption). This is transparent to
clients: the editor still uploads and downloads plain content — encryption and
decryption happen entirely inside this API, so a leaked database dump never
exposes synced data in readable form.

- **What is encrypted:** every resource revision's `content`. The manifest
  (which only holds refs) and collection ids are not encrypted.
- **Algorithm:** brotli (quality 9), then AES-256-GCM with a random 12-byte IV
  and the 16-byte auth tag stored alongside the ciphertext.
- **Stored format (v3, written now):** a Bytes field,
  `"PCE3" | iv | tag | ciphertext`. It costs about half of the old text
  envelopes (`picode-enc:v1:` / `v2:`, base64 inside base64, ~1.78x their
  payload), which are still read so nothing has to be migrated.
- **Key:** the `PICODE_ENCRYPTION_KEY` environment variable must hold a
  32-byte key, base64-encoded (generate one with `openssl rand -base64 32`).
  Set it in Vercel like the Firebase credentials; never commit it.
- **When the key is unset:** encryption is bypassed and content is stored
  compressed but readable (`"PCZ3" | brotli`), so development works with zero
  configuration; the API logs a warning once per process. Setting the key later
  encrypts new writes, while previously stored values keep being served.
- **Client impact:** none. Reads always return plaintext; a value that cannot
  be decrypted (wrong key or corrupt data) answers `500 DecryptionFailed`
  instead of ever returning garbage.

## 🚀 Deploy (Vercel, free plan)

1. `vercel link` inside this folder.
2. Set the environment variables above on the Vercel project.
3. `vercel deploy --prod`.
4. The URL goes in the editor's `product.json` `configurationSync.store` **without** `/v1` —
   the editor appends it itself (`userDataSyncStoreService` joins `v1`). The shipped value is
   `https://www.getpicode.app/api`.
