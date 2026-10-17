# cloud/ — ☁️ La nube de PiCode

**Todo lo que vive en la nube**: la única parte de pago del producto. El editor es gratis y completo; esto es la sincronización y el respaldo de la configuración, que es lo que se vende.

## 🗂️ Dentro

| Carpeta | Qué hace |
| --- | --- |
| [`sync-api/`](sync-api/README.md) | **La API de sincronización**: el backend REST que el motor de *Settings Sync* del editor espera, con autenticación de Firebase y almacenamiento en Firestore. Allí misma está su ficha fichero a fichero (`lib/` y rutas `app/api/`). |

## 🧱 Cómo se relaciona con el editor

- El editor apunta a la API con `configurationSync.store` (el valor sale de `distribution/product-delta.json`).
- Todo el contenido se cifra en el servidor (AES-256-GCM) antes de tocar Firestore; el editor sube y baja texto plano y no se entera.
- La sincronización es **Pro**: cualquier ruta responde `402` si la cuenta no es `pro`.

📖 La estrategia completa (qué se sube, qué se cifra, consentimiento) está en [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) y en el ADR-017 de [`docs/DECISIONS.md`](../docs/DECISIONS.md).

**Cuándo se toca:** al cambiar el contrato de sincronización, las cuotas, los planes o el despliegue. El despliegue es Vercel (`vercel deploy --prod` dentro de `sync-api/`).
