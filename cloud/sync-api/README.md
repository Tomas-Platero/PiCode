# PiCode Cloud Sync API

Backend del servicio de sync de PiCode: implementa el contrato REST que espera el motor
Settings Sync del editor, autentica contra Firebase Auth y guarda los datos por usuario
en Firestore.

- Proyecto Firebase: `picode-7f24f`
- Contrato REST del cliente: ver `odd/tasks/picode-cloud-sync.md` (sección T1)

## Arranque en desarrollo

```bash
cd cloud/sync-api
npm install
npm run dev   # http://localhost:3400
```

## Variables de entorno

Crea `.env.local` (no se sube al repo) con:

```
FIREBASE_PROJECT_ID=picode-7f24f
FIREBASE_CLIENT_EMAIL=<firebase-adminsdk@picode-7f24f.iam.gserviceaccount.com>
FIREBASE_PRIVATE_KEY=<clave privada del service account, con \n escapados>
PICODE_WEB_ORIGIN=http://localhost:3600
PICODE_ALLOWED_CLIENTS=picode
```

`FIREBASE_CLIENT_EMAIL` y `FIREBASE_PRIVATE_KEY` salen del service account JSON:
Firebase console → Configuración del proyecto → Cuentas de servicio → Generar nueva clave
privada. En Vercel se configuran como variables de entorno del proyecto (nunca en el repo).

## Estructura

```
src/
  lib/firebase-admin.ts   # init único de Firebase Admin SDK
  lib/auth.ts             # verificación de token del editor (cabeceras de sync)
  lib/contract.ts         # tipos del contrato REST del motor de sync
  app/api/                # rutas del contrato (manifest, collection, resource, ...)
```

## API endpoints

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

## Size limits

The request body cap is 4 MiB, but it is only a buffering guard: it bounds what
the server is willing to read, not what the store accepts. What is stored is
`content`, an encrypted envelope that costs about **1.78x** the plaintext when
the payload does not compress, and Firestore rejects any document over
1,048,487 bytes.

The limit that matters is therefore the stored envelope, checked after
compression in `writeResource`; the API answers `413 TooLarge` when a revision
would not fit the store.

Practical consequence:

- Compressible JSON bundles can use the full 4 MiB request cap.
- Content that does not compress (already-compressed or binary payloads)
  tops out at about **576 KiB**: the largest body measured to still fit is
  589,230 bytes (a 589,518-byte body stores 1,048,485 bytes, just over the
  reserved limit).

Error mapping follows the client contract: 401 Unauthorized, 403 Forbidden
(disallowed `X-Client-Name`), 404 NotFound, 405 MethodNotFound, 409 Conflict,
412 PreconditionFailed, 413 TooLarge; 429 responses may carry `Retry-After`.

Firestore layout (paths strictly alternate collection/document segments):

- `users/{uid}/sync/manifest` — `{ latest, session, ref, updatedAt }`
- `users/{uid}/sync/resources/{resource}/{ref}` — `{ content, machineId?, version, created, deleted }`
- `users/{uid}/collections/{id}` — `{ created }`

The manifest's `latest[resource]` entry is the authoritative latest ref and is
updated in the same transaction as every write.

## Data encryption at rest

All synced resource content is **encrypted server-side before it is written to
Firestore** (AES-256-GCM, authenticated encryption). This is transparent to
clients: the editor still uploads and downloads plain content — encryption and
decryption happen entirely inside this API, so a leaked database dump never
exposes synced data in readable form.

- **What is encrypted:** every resource revision's `content`. The manifest
  (which only holds refs) and collection ids are not encrypted.
- **Algorithm:** AES-256-GCM per value, with a random 12-byte IV and the
  16-byte auth tag stored alongside the ciphertext.
- **Stored format:** `picode-enc:v1:<base64url JSON { iv, tag, d }>` — the
  prefix makes encrypted values unambiguous.
- **Key:** the `PICODE_ENCRYPTION_KEY` environment variable must hold a
  32-byte key, base64-encoded (generate one with `openssl rand -base64 32`).
  Set it in Vercel like the Firebase credentials; never commit it.
- **When the key is unset:** encryption is bypassed and content is stored in
  plaintext, so development works with zero configuration; the API logs a
  warning once per process. Setting the key later encrypts new writes, while
  previously stored plaintext values keep being served unchanged.
- **Client impact:** none. Reads always return plaintext; a value that cannot
  be decrypted (wrong key or corrupt data) answers `500 DecryptionFailed`
  instead of ever returning garbage.

## Despliegue (Vercel, plan gratuito)

1. `vercel link` dentro de esta carpeta.
2. Configurar las variables de entorno anteriores en el proyecto de Vercel.
3. `vercel deploy --prod`.
4. La URL resultante (p. ej. `https://picode-sync-api.vercel.app/v1`) es la que irá en
   `configurationSync.store` del `product.json` del editor (tarea T6).
