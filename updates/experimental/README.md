# updates/experimental/ — 🟠 El feed del canal experimental

**Los documentos estáticos que lee el actualizador del editor para el canal experimental**, servidos tal cual desde `raw.githubusercontent.com` (por eso no hay servidor de actualizaciones que mantener).

| Ruta | Qué hace |
| --- | --- |
| `win32/x64/user/latest.json` | La última build para el canal. |
| `win32/x64/archive/latest.json` | La versión archivada del propio canal. |

📖 Cómo se genera, por qué cada canal es una rama distinta y la regla de «una release por canal»: [`updates/README.md`](../README.md) y [`docs/DISTRIBUTION.md`](../../docs/DISTRIBUTION.md).

**Cuándo se toca:** nunca a mano. Lo escribe `dev/update-feed.mjs` desde el pipeline de release (`--force` no se pasa jamás: si el generador se niega, la release se detiene).
