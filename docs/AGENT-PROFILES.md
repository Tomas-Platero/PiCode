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
| T1 | S1 | inline | hecho | `f64fc45c` |
| T2 | S2, S4 | inline | hecho (sin canal de control: el servicio de perfiles de Gentle se alcanza desde una extensión del chat) | `ea4db50a` |
| T3 | S2, S4 | inline | hecho | `ea4db50a`, `2123c2eb` |
| T4 | S3 | inline | hecho | `ea4db50a`, `2123c2eb` |
| T5 | S4 | inline | hecho (nube); fijar a proyecto va en T3 | `2f64b5ce` |
| T6 | S1–S4 | inline + traducción en paralelo | hecho (13 idiomas, `l10n check` limpio); What's New en la 2.4.0 | `8ce2f47f` |

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
- **L4** (2026-11-19) · Cambio de plan en T2: no hace falta activar el canal de control de Gentle Desktop. `gentle-ai.ts` responde al servicio `gentle:desktop:profiles-service` en el bus de eventos de pi, y pi comparte un bus por sesión entre las extensiones de los paquetes y las del editor (`resource-loader.js`, `loadExtensionFromFactory`). Una extensión mínima por chat guarda el contexto de la sesión y pide a Gentle que aplique.
- **L5** · Pruebas: `agent-profiles.test.ts` (13) y `agent-profiles-live.test.ts` (9) pasan; el conector entero, 977/978. El que falla (`status-layout.test.ts:93`) mira `picodeStatusSection.ts`, que esta rama no toca. Comprobación de tipos del editor y del conector, limpias.
- **L6** · Pendiente o sin verificar: no se probó en una build en marcha (el canal con Gentle de verdad, el botón del chat y la fila de *Profiles*); los modelos de respaldo se ven pero no se editan; exportar e importar perfiles a fichero sigue en el terminal; *What's New* se añade con la release. En un repositorio fijado, Gentle hace que *Make default* cambie solo la fijación local, no el predeterminado global.
- **L7** (2026-11-19) · Hecho tras la prueba del dueño («todo bien, sigue»): el botón del perfil en el chat abre un desplegable como el del razonamiento (`6271d203`); gentle-pi 4.9.0 (`90953637`); interruptor *Agent / Editor* en la barra de título (`3638a9d4`); y los modelos de respaldo se editan desde la página: un botón por agente y otro para «todos los agentes sin uno propio», que abre la lista en orden para subir, quitar o añadir (`efcce600`, 4 pruebas nuevas, 17 en total). Sigue pendiente: exportar e importar perfiles a fichero (terminal de Gentle), *What's New* con la release, y comprobar si gentle-pi 4.9.0 aplica el agente principal del perfil fijado a un proyecto (la marca *This project* dice que no).
- **L8** (2026-11-20) · «Me voy a la cama, prueba tu, tienes acceso al pc total en lo que necesites, quiero que esté funcionando bien, haz las pruebas en el editor y rebuidlea lo que necesites». Probado en la build portable, manejando la ventana por su puerto de depuración (las capturas de pantalla del sistema salían en gris): el interruptor *Agent / Editor* en los dos sentidos; la página de perfiles (elegir, *Make default*, menú ⋯); los modelos de respaldo (añadir, no ofrecer uno repetido, subir, quitar, guardado en `profile-fallbacks.json`); el botón del chat y su desplegable, *Only for this chat* con un chat en marcha y vuelta al predeterminado; gentle-pi 4.9.0 instalado y respondiendo. Arreglado (`b844c2da`): el botón del chat no se enteraba de un cambio hecho en la página; las filas con respaldos se descuadraban; «Guardado» salía en amarillo de aviso; y la nota nueva de gentle-pi 4.9.0 «started with profile…» se oculta cuando el perfil no cambia nada. Comprobado en el código de gentle-pi 4.9.0 que un perfil fijado a un proyecto también mueve el agente principal de los chats nuevos: la marca *This project* se corrige.
- **L9** (2026-11-20) · Sale en la release 2.4.0, en los tres canales («sube todo a una neuva release en todos los canales»), con tres páginas de *What's New* (perfiles de agentes, el interruptor *Agent / Editor* y la sincronización por partes), en el editor y en la web. La sincronización de los agentes por partes y sin claves (ADR-041, adenda 1) va en la misma release. Siguen pendientes: exportar e importar perfiles a fichero.
