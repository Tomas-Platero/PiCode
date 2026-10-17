# picode-source/ — 🧬 El árbol del editor

**Es el editor entero: la fuente de VS Code con los cambios de VSCodium y los nuestros ya dentro**, versionada en este repositorio. No es una descarga ni un parche: editar PiCode es editar esta carpeta, y compilarla es `./dev/build.sh` (las fases, en [`dev/README.md`](../dev/README.md)).

La identidad (nombre, versión, iconos) **no vive aquí**: está en [`distribution/`](../distribution/README.md) y se aplica sobre el árbol en la fase 1 de la build.

## 🗂️ Qué es nuestro y qué es de upstream

| Carpeta | ¿Quién es? | Qué hay |
| --- | --- | --- |
| [`src/`](src/README.md) | ⬆️ upstream | El motor de VS Code (~9.400 ficheros). Solo tocamos lo imprescindible. |
| [`extensions/`](extensions/README.md) | ⬆️ upstream + **1 nuestra** | Las built-in de VS Code y, dentro, **`extensions/picode/`**: el conector con pi. |
| [`cli/`](cli/README.md) | ⬆️ upstream | El `code` CLI, escrito en Rust. |
| [`build/`, `scripts/`, `resources/`, `remote/` | ⬆️ upstream | Herramientas de compilación, lanzadores y recursos del empaquetado. |
| [`durable/`](durable/README.md) | ✅ **nuestro** | El **agente durable**: programa aparte que sobrevive a que maten al editor. |
| [`durable-bridge/`](durable-bridge/README.md) | ✅ **nuestro** | La extensión de pi que entrega trabajo al daemon durable. |
| [`durable-acp-client/`](durable-acp-client/README.md) | ✅ **nuestro** | Cliente mínimo de prueba: demuestra que durable habla ACP. |

## 📄 Ficheros de esta carpeta

| Fichero | Qué hace |
| --- | --- |
| `product.json` | Identidad del árbol (nombre, versión, URLs). La **fuente** de verdad es `distribution/product-delta.json`, que se aplica encima. |
| `package.json` / `package-lock.json` | Dependencias del editor. Instaladas una vez, no en cada build. |
| `gulpfile.mjs` | Las órdenes de compilación (type check, esbuild, empaquetado) que llama `dev/build.sh`. |
| `picode-url-handler.cmd/.ps1` | El manejador del protocolo `picode://` (abrir enlaces del producto). |
| `cgmanifest.json` / `cglicenses.json` | Inventario y licencias de terceros que exige la distribución. |

## 📖 Para saber más

- Qué hace cada carpeta del repositorio: [`docs/MAPA.md`](../docs/MAPA.md) (generado).
- Por qué el árbol vive aquí y no en parches: [`docs/DISENO.md`](../docs/DISENO.md).
- Cómo se compila: [`dev/README.md`](../dev/README.md) y [`docs/howto-build.md`](../docs/howto-build.md).
