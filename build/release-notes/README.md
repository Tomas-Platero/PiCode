# build/release-notes/ — 📝 El texto de cada canal

**La descripción que encima del changelog en cada página de release**, una por canal. El resumen agrupado por tipo de cambio (novedades, arreglos, rendimiento…) lo genera `build/release.mjs release-notes` a partir de los commits; estos ficheros son la voz del canal, que va justo encima.

| Fichero | Canal | Se usa cuando |
| --- | --- | --- |
| `stable.md` | 🟢 stable | Sale una versión estable (`v0.x.y`). |
| `beta.md` | 🟡 beta | Sale una beta (`v0.x.y-beta`). |
| `experimental.md` | 🟠 experimental | Sale una experimental (`v0.x.y-experimental`). |

📖 Cómo se insertan y el resto de reglas de release: [`docs/CI.md`](../../docs/CI.md).

**Cuándo se toca:** solo si cambia lo que queremos contar de un canal. El fichero de otro canal no se toca: cada release lleva el del suyo.
