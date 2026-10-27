# upstream/ — 📌 El pin de procedencia

**Un único fichero que dice de dónde viene el árbol**: la versión y el commit exacto de VS Code del que desciende el árbol.

| Fichero | Qué hace |
| --- | --- |
| `stable.json` | `{ tag, commit, repository }` — hoy VS Code `1.135.0`. Lo leen la build y los ADR cuando hay que justificar de qué parte somos fork. |

**Cuándo se toca:** solo al traer una versión nueva de upstream. Ese trabajo es un *merge* contra el árbol y nada más cambia (la identidad vive en `product.json`, así que no se toca).

El porqué de cada salto de versión está en [`docs/DECISIONS.md`](../../docs/DECISIONS.md) y el estado de la migración en [`docs/TAREAS.md`](../../docs/TAREAS.md).
