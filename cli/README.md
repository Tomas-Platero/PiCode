# cli/ — ⬆️ El CLI `code`, en Rust (zona upstream)

**Carpeta upstream: aquí no se documenta fichero a fichero.** Es el código fuente del comando `code` (VS Code CLI) tal como desciende de `host/upstream/stable.json`. PiCode lo compila como parte de la build y no lo modifica.

## 📌 La regla

Si hay que cambiar algo aquí (casi nunca), el porqué va en el commit. Este README solo dice que la carpeta no es nuestra, para que nadie la documente ni la refactore por accidente.

## 🗂️ Por dentro (orientación)

| Ruta | Qué es |
| --- | --- |
| `src/bin/` | Los ejecutables (`code`, `code-server`…): el punto de entrada. |
| `src/commands/` | Subcomandos (`serve`, `tunnel`, `status`…). |
| `src/desktop.rs` | Habla con la app de escritorio. |
| `src/tunnels/` | Túneles remotos. |
| `src/update_service.rs`, `self_update.rs` | Auto-actualización del CLI. |
| `build.rs` | Compilación (`cargo`), generación de versiones. |

El binario compilado aparece en el empaquetado; no se versiona (está en `.gitignore`).
