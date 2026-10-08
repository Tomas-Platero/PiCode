# Feature: migrar la extensión al core y borrarla

## Goal

Que PiCode **no tenga extensión propia**: pi es el host, vive en el núcleo del editor, y todo
—chat, proveedores, ajustes, habilidades, agentes— está integrado en el Chat y en la
maquinaria de agentes que el editor ya trae.

> Decisión del dueño, 2026-09-24: «todo ha de ir en el core de vscode, integrado en su
> núcleo» · «quita esa extensión y toda configuración y demás lo migres a chat y el tema
> agentico que trae ya vscodium».

## Decisión que cambia el sitio del conector (dueño, 2026-09-24)

> "Puedes crear una extensión pero como las que están en la ruta
> `vscode/extensions` que son del core... si necesitas un conector, un puente, algo para
> apis, o lo que sea ahí, quiero que esté en el core"

Las extensiones de `vscode/extensions/` **son el núcleo**: se compilan con el editor, viajan
en el binario y son el sitio donde VS Code pone todo lo que necesita Node. Eso resuelve el
problema real que tenía: el renderer del core no tiene Node, y el host de extensiones sí.

Así que el conector de pi es una **extensión del core**, en `vscode/extensions/picode/`:

- **Aquí (el conector)**: el puente a pi — proveedores, catálogo, modelos, perfil, SDK.
- **En `src/vs/`**, las superficies: Chat, Agente y sus ajustes.
- **Nada dibuja un panel, una pestaña ni unos ajustes propios.** Si algo necesita superficie,
  la superficie va al core.

## Hecho

- **La extensión está fuera del editor.** `dev/build.sh` ya no la copia y
  `dev/builtin-extension.sh` se borró. Un build no la contiene.
- **Cuarentena con cartel**: `extensions/picode-pi-chat/README.md` explica que no se compila,
  por qué sigue existiendo y a dónde va cada pieza.
- **El conector creado dentro del núcleo**: `vscode/extensions/picode/` (manifiesto,
  `tsconfig.json` y la entrada), registrado en la compilación del core con el parche
  `11-picode-extension-in-core.patch`. Compila con el editor y viaja en el binario. Su
  `activate` está **vacío a propósito**: es el contenedor, y un aporte que no hiciera nada
  sería una superficie que miente. El primer contenido es el puente de proveedores.
- **Ya migrado al core**: la sesión de pi (`platform/agentHost/node/pi/piSession.ts`), la
  traducción de sus eventos a acciones del protocolo (`piActionMapping.ts`), el ajuste de
  proveedores bajo el nodo Chat (`contrib/picode/browser/picodeConfiguration.ts` + el nodo
  del árbol de ajustes) y el descubrimiento de personalizaciones de pi
  (`sessionCustomizationDiscovery.ts`).

## Por qué no se ha borrado el directorio todavía

Su código **está sin commitear** — incluido lo de esta sesión, como el catálogo de
proveedores con las dos vías— y borrarlo ahora lo perdería sin historial. Es material de
origen hasta que la migración copie lo que sirve.

## Tareas

- [ ] M1 **Proveedores en el core**: catálogo, las dos vías (suscripción y clave), el login y
      `models.json`. Es lo que hoy vive en `pi-login-command.ts` / `models-config.ts` /
      `models-command.ts`. Sin extensión, esto tiene que ser un servicio del workbench.
- [ ] M2 **Que los modelos de pi salgan en la ventana del editor.** Verificado que se puede:
      `registerLanguageModelChatProvider` es API **estable** y sin guarda de permiso. Es la
      respuesta a «conecto omni y no veo los modelos».
- [ ] M3 **Ajustes de PiCode en el core**, dentro de Chat y Agente, no bajo Extensions.
- [ ] M4 **Habilidades de paquete** en el descubrimiento del core — hoy
      la tabla de directorios no sabe expresar `~/.pi/agent/npm/node_modules/<paquete>/skills`.
- [ ] M5 **El asistente de primer arranque**, en el core.
- [ ] M6 **Borrar `extensions/picode-pi-chat`** cuando no quede nada por migrar.
- [x] M7 **Quitar el escalón de la vía ZIP**: `distribution/apply-picode.ps1` y
      `dev/stage-distribution.sh` siguen metiendo la extensión en el árbol empaquetado.
      **Hecho el 2026-09-25**: se quitaron los dos pasos 4 (y el bloque muerto que quedaba en el
      empaquetado), se renumeraron los pasos a 1..7 y 1..5, y se borraron las variables y los
      comentarios que ya no usaba nadie. De paso, el paso del icono del ZIP **seguía leyendo el
      dibujo de dentro de la extensión retirada** — ahora lo saca del propio `.ico` con
      `dev/ico-to-png.mjs`, así que no hay una segunda copia que se quede atrás. El material de
      la extensión entró en el historial en `e705f4f` (1.947 líneas que solo existían en el
      `.tar.gz` de `legacy/`), que es lo que el papel pedía antes de borrarla.

## Lo que está roto y se acepta

El editor construido no puede hablar con ningún modelo: ni chat, ni login de proveedores. El
dueño lo aceptó explícitamente («me da igual como quede de roto, luego lo arreglas»).

## Lo que hay que recuperar del panel, no perder

Contexto del editor, estadísticas de pi, comandos y sesiones. Estaban pedidos y siguen
queriéndose; van al chat del core (ver `picode-agent-panel.md`, cerrada como superada).
