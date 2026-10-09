# Los papeles de trabajo

Esta carpeta **es el registro**, no la lista de lo que falta.

- **Qué queda por hacer, y en qué orden** → `docs/TAREAS.md`. Es la única lista.
- **Cómo ha de ser el producto** → `docs/DISENO.md`.
- **Qué quiere el dueño, en sus palabras** → `AGENTS.md` y `docs/VISION.md`.

Los ficheros de aquí abajo se conservan porque cuentan **cómo se llegó hasta aquí**: qué se
probó, qué se rompió, qué se decidió y por qué. Varios están **superados** y lo dicen en su
primera línea; alguno contiene afirmaciones que después se corrigieron, y también lo dice.
Leerlos sirve para no repetir un error; **no** para saber el estado actual.

## Superados, y por qué se quedan

| Fichero | Estado |
| --- | --- |
| `picode-agent-panel.md` | **Superado**: pedía un panel propio, y la decisión es que no haya ninguno. Sus **requisitos** (contexto del editor, estadísticas, comandos, sesiones) siguen queriéndose — dentro del Chat; ver la tarea 8 de `docs/TAREAS.md` |
| `picode-pi-instances.md` | Su vocabulario cambió: ahora se dice **Host** (pi) y **Harness** (la capa que organiza el trabajo), cada uno interno o externo |
| `picode-models-providers.md` | Superado por `docs/TAREAS.md` |
| `picode-ui-program.md`, `picode-ui-completion.md`, `picode-options-surface.md`, `picode-panel-configuration.md`, `picode-packages-table.md`, `picode-attachments.md`, `picode-default-model-live.md`, `picode-dual-runtime.md` | Construidos sobre la superficie que ya no existe (el panel). Lo que valga de ellos se migra al núcleo |
| `picode-patch-build.md`, `picode-distribution.md`, `picode-foundation.md` | **Superados**: describen la vía de parches y el árbol VSCodium del root, retirados el 2026-09-27. Los sustituye `picode-fuente-propia.md` |
| `picode-themes.md` | **Vigente**: la galería de temas sigue siendo verdad, en el núcleo |
| `picode-pi-native-chat.md`, `picode-integrated-editor.md`, `picode-providers.md`, `picode-customizations-hub.md`, `picode-pi-agent-host.md`, `picode-migrar-al-core.md` | **Vigentes**: el trabajo de esta etapa, con su evidencia y sus «no medido» |
| `picode-pi-110.md`, `picode-vscode-141.md`, `picode-rebase-141.md`, `picode-canales.md`, `picode-rama-experimental.md` | **Vigentes (octubre 2026)**: pi 1.1.0 en el pin, la adopción de 1.141, el número declarado sin rebase y los tres canales |

No hay índice de los 72 ficheros a propósito: sería una segunda lista de estado y competiría con
`docs/TAREAS.md`. Se busca por nombre de feature o con un `grep` por el asunto.
