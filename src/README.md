# src/ — ⬆️ El motor de VS Code (zona upstream)

**Carpeta upstream: aquí no se documenta fichero a fichero.** Son los ~9.400 ficheros del editor de VS Code tal como descienden de `host/upstream/stable.json` (VS Code `1.135.0`), con los cambios de VSCodium y los nuestros aplicados encima y commiteados.

## 📌 La regla

- **Lo nuestro** se vive en `extensions/picode/` y en `build/distribution/` (identidad). Este motor se toca solo cuando algo del editor en sí tiene que cambiar.
- **Quien toque aquí** documenta el porqué en el commit, no en un README: el fichero no es nuestro, la decisión sí.
- El «quién llama a quién» de esta zona está en el grafo de código (`.codegraph/`), no en ficheros.

## 🗂️ Por dentro (orientación)

| Ruta | Qué es |
| --- | --- |
| `src/vs/` | El editor: trabajo, ventanas, servicios de plataforma, APIs. |
| `src/vs/code/` | Los puntos de entrada de la app de escritorio y de servidor. |
| `src/main.ts`, `src/server-main.ts` | Arranque del proceso principal (escritorio / servidor). |
| `src/*.ts` (raíz) | Arranques y utilidades de arranque (bootstrap-*). |
| `typings/`, `vscode-dts/` | Definiciones de tipos que el editor expone a las extensiones. |

Para encontrar algo concreto: `codegraph_explore`, o `rg "texto"` dentro de `src/vs/`.
