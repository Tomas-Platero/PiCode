# .github/ — 🤖 La vida del repositorio en GitHub

**Plantillas y automatismos**: lo que se ve cuando alguien abre una issue, un PR o lanza una build.

## 🗂️ Dentro

| Ruta | Qué hace |
| --- | --- |
| [`workflows/ci.yml`](workflows/ci.yml) | **Build continua**: compila el árbol, ejecuta los tests del conector, valida las entradas MCP y sube el editor empaquetado. |
| [`workflows/release.yml`](workflows/release.yml) | **Pipeline de release**: etiqueta → build → release en GitHub → feed de actualizaciones → borrado de la release anterior del mismo canal. |
| `ISSUE_TEMPLATE/` | Los formularios: 🐛 bug, 🔧 fallo de build, ✨ idea, ❓ pregunta. |
| `PULL_REQUEST_TEMPLATE.md` | La checklist que acompaña a cada PR. |

📖 El detalle de cada pipeline está en [`docs/CI.md`](../docs/CI.md); las reglas duras de la release (versión, feed, una release por canal) están en [`docs/DISTRIBUTION.md`](../docs/DISTRIBUTION.md).

**Cuándo se toca:** al añadir un workflow, cambiar una plantilla o tocar esa checklist. Los cambios que solo tocan `.md` ni siquiera disparan la CI.
