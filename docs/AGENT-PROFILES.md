# Perfiles de agentes (Agent profiles)

Objetivo: que los perfiles de modelos de Gentle AI se elijan y gestionen desde el editor, y que cada perfil del editor pueda llevar el suyo.
Rama: `feat/agent-profiles` (desde `experimental`). Entrega: commits por fase. Pruebas: `node --test` en `extensions/picode/test`.

## Specs

- **S1** · «Los perfilers de picode que son los mismos que en vscode funcionan bien? hay que hacerles algo con todo lo que tenemos?» → los perfiles del editor funcionan con todo lo de PiCode: nada se guarda en un sitio equivocado cuando el perfil no es el de serie, y lo que es de todo PiCode no empieza de cero en un perfil nuevo.
- **S2** · «A parte se que gentle-ai tiene perfiles ahora, ¿se podrían integrar?» → la página *Customization › Agents* lista los perfiles de Gentle (`profiles.json`), deja crearlos, editarlos (modelo, razonamiento, modo rápido, respaldos, modo del orquestador), usarlos por defecto o solo en un chat, duplicarlos, renombrarlos y borrarlos. `/gentle:profiles` la abre.
- **S3** · «y usar los perfiles de vscode en picode (que ya viene integrado) e incluir ahí los de gentle-ai junto a sus sleectores o algo así?» → la ventana de perfiles del editor lleva una fila *Agent profile*; al cambiar de perfil del editor se activa el perfil de agentes elegido (con *Undo*). *None* no toca nada.
- **S4** · Diseño aceptado («Si y crea una rama para esto»): botón del perfil en el chat (solo con más de un perfil, dice de dónde viene), precedencia chat → proyecto → perfil del editor → por defecto siempre visible, fijar a un proyecto y compartir con el repositorio (respetando la confianza de carpeta), *Agent profiles* en *Cloud sync*, traducción a los 13 idiomas.

## Tasks

| ID | Specs | Ruta | Estado | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1 | inline | en curso | |
| T2 | S2, S4 | inline | pendiente | |
| T3 | S2, S4 | inline | pendiente | |
| T4 | S3 | inline | pendiente | |
| T5 | S4 | inline | pendiente | |
| T6 | S1–S4 | inline | pendiente | |

- T1: fallos de perfiles del editor (ruta de datos del usuario, estado que debe ser de toda la app).
- T2: medir y activar el canal de control de Gentle sin ruido en el chat.
- T3: página *Agents* y botón del chat.
- T4: fila *Agent profile* en la ventana de perfiles del editor y cambio al cambiar de perfil.
- T5: nube y fijar a proyecto.
- T6: traducciones, What's New, docs y reporte.

## Log

- **L1** (2026-11-18) · Petición original: «Los perfilers de picode que son los mismos que en vscode funcionan bien? hay que hacerles algo con todo lo que tenemos? A parte se que gentle-ai tiene perfiles ahora, ¿se podrían integrar?»
- **L2** (2026-11-19) · «y usar los perfiles de vscode en picode (que ya viene integrado) e incluir ahí los de gentle-ai junto a sus sleectores o algo así?» · «Piensalo bien, dale una buena vuelta de como todo debería ir integrado, revisa todo» · «Dale una pensada a toda la parte del diseño» · «Si y crea una rama para esto».
- **L3** · Hallazgos de la revisión:
  - El pi interno es uno por instalación (`runtime.ts:179`); todos los perfiles del editor lo comparten. Gentle guarda sus perfiles en `<pi>/gentle-ai/profiles.json` porque PiCode fija `GENTLE_PI_CONFIG_HOME` (`product-env.ts:45`).
  - Cambiar de perfil del editor reinicia las extensiones sin recargar la ventana (`userDataProfileManagement.ts:177-210`).
  - `extension.ts:2707` calcula la carpeta de datos subiendo tres niveles desde `globalStorageUri`; en un perfil que no es el de serie acaba en `User/profiles`.
  - Aplicar un perfil de Gentle reescribe varios ficheros con rollback; solo hay API para ello en el canal de control (`gentle-desktop-rpc.ts`), que hoy se filtra (`product-packages.ts:76`).
  - La sincronización no lleva `gentle-ai/` (`piProfileSync.ts:54-56`).
