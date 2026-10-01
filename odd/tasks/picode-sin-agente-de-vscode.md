# Feature: fuera la ventana de agentes de VS Code

## Goal

Que PiCode **no** tenga el **Agents window** de VS Code: ni el botón de la barra de título, ni la
entrada en el menú del chat, ni el atajo, ni los comandos de la paleta, ni el cartel de bienvenida
que lo anuncia.

> «Para cuando termines quita la ventana de agente, esto no lo quiero. Es al parecer un sistema de
> agente propio de vscode.»

## Por qué existe

VS Code 1.135 trae un «agente propio»: una ventana aparte con sus sesiones, y cuatro puertas para
llegar a ella (barra de título, menú del chat, `Ctrl+Shift+A` y la paleta) más un cartel en la
página de bienvenida. En PiCode eso es un segundo sistema de agente compitiendo con pi, que es **el**
agente del producto: dos sitsios donde el usuario cree que «habla con el editor», y el que él no
quiere.

## Decisión

**Quitar las puertas, no el chat.** El chat y su modo agente se quedan: son la superficie de pi. Lo
que desaparece es el *acceso* a la ventana de agentes y su promoción.

Y **por código, no por ajustes**: se midió que la ventana se ofrece a través de
`OPEN_AGENTS_WINDOW_PRECONDITION`, que exige `chat.agent.enabled: true` — el mismo ajuste que le da
a pi su modo agente con herramientas. Apagarlo habría quitado la ventana **y** el agente, así que no
es una salida: el parche borra las acciones.

## Hecho

`patches/picode/13-no-vscode-agents-window.patch`:

| Qué | Dónde |
| --- | --- |
| Las **seis acciones** de la ventana de agentes dejan de registrarse: abrir el espacio de trabajo en ella (comando de paleta, entrada del menú del chat y botón de la barra), su interruptor de la barra, abrir la ventana vacía y abrir la sesión actual | `chat.contribution.ts` |
| Las **dos contribuciones** que la empujan: la que abre el espacio de trabajo y el aviso de traspaso | `chat.contribution.ts` |
| Los **dos consejos** del chat que la anuncian, y el de Copilot CLI (otro agente que no es el de este producto) | `chatTipCatalog.ts` |
| El **cartel de bienvenida** («Try out the new Agents window») | cae solo: aparece cuando el comando existe (`canShowAgentsBanner`), y ya no existe |

Lo que **no** se toca, y por qué: la vista **Sessions** del chat (el panel de la derecha, con las
conversaciones). Es la lista de conversaciones del propio chat, no la ventana de agentes, y quitarla
dejaría al usuario sin historial. Si el dueño la quiere fuera también, es otra decisión.

## Verificación

| Qué | Cómo | Resultado |
| --- | --- | --- |
| El núcleo compila | `tsc --noEmit` sobre `src/tsconfig.json` | ver el registro de la sesión |
| El parche aplica sobre el árbol preparado | `git apply --reverse --check` | OK |
| El editor construido no ofrece la ventana | Grep del binario por los comandos y los rótulos de la ventana de agentes | ver el registro de la sesión |
| Nada más se rompió | Los tres scripts de comprobación del conector + las 18 comprobaciones del editor construido | ver el registro de la sesión |

## Registro

- 2026-09-25 · pedido por el dueño al ver el botón «Open in Agents» y el cartel de bienvenida.
