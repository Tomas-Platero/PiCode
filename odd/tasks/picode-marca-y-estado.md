# Feature: la marca y el estado — lo que se ve

## Goal

> «sigue haciendo mejoras y recuerda mejoras de diseño y estética»

Presentación: que las dos marcas se vean en cualquier tema, que ocupen el sitio que se les da, y que
el panel de estado no enseñe un dato en el grupo equivocado. Nada de esto cambia qué hace el
producto; cambia cómo se ve mientras lo hace.

## Lo que se midió antes de tocar nada

1. **La marca ocupaba la mitad de su lienzo.** Leído de la geometría real de `picode.svg` (comandos
   `M/L/H/V/Q/C`, círculos, el ancho de trazo y el `translate(0,92)`): el dibujo va de x 226..798 e
   y 156..864 — **572 × 708 dentro de un lienzo de 1024 × 1024**, o sea **56% de ancho y 69% de
   alto**, con 226 de margen a cada lado. Centrado, sí, pero pequeño: en la barra de actividad, en
   una fila del árbol o en el chat vacío se veía más chico que el icono de al lado.
2. **Cada marca tenía un tema en el que desaparecía.** El icono de una fila del árbol es una
   **imagen**: no hay máscara ni color de tema, se dibuja la tinta del fichero. La rosa es
   `#000000` (invisible sobre fondo oscuro, que es el tema del dueño) y la marca de PiCode
   `#C5C5C5` (un gris pálido sobre fondo claro). Dos marcas, dos tintas fijas, ninguna se adapta.
3. **El fichero de la rosa venía de fuera.** `gentle-ai.svg` traía `DOCTYPE`, un comentario
   «Uploaded to: SVG Repo, www.svgrepo.com», un `<style>` con la clase `.st0` y un tamaño de 800px
   que no cuadra con su `viewBox` de 512. La procedencia ajena y el `<style>` además impedían
   recolorear la rosa desde el grupo.
4. **El contador de MCP estaba en el grupo equivocado.** «MCP servers» vivía bajo **Project**, y
   cuenta los servidores del **perfil de pi** (`countMcpServers(profileDir)`), no del proyecto.

## Decisión

| Qué | Cómo queda |
| --- | --- |
| Lienzo de la marca | `viewBox="118 116 788 788"` — un cuadrado que abraza el dibujo con aire parejo. Medido: **73% de ancho y 90% de alto**, y **ningún recorte** (márgenes 108/108/40/40) |
| Iconos del árbol | Cada marca con su pareja de tema: `{ light: picode-light.svg, dark: picode.svg }` y `{ light: gentle-ai.svg, dark: gentle-ai-dark.svg }`. La tinta clara para una, la oscura para la otra; el mismo dibujo |
| La rosa | Los **nueve `path` intactos**, el fichero limpio alrededor: fuera el `DOCTYPE`, el comentario de SVG Repo, el `<style>` y el 800px; el relleno pasa al `<g>`, que es lo que permite la pareja |
| El contador de MCP | Se mueve al grupo **pi**, que es de quien son los servidores |

`picode-light.svg` y `gentle-ai-dark.svg` son nuevos; `picode-status.svg` (el icono de la barra de
actividad) solo cambia de lienzo, sus colores no se tocan.

## Evidencia (ejecutada)

```text
ANTES (git HEAD)                     AHORA
viewBox 0 0 1024 1024                viewBox 118 116 788 788
drawn   x 226..798 (572)             drawn   x 226..798 (572)      ← el mismo dibujo
        y 156..864 (708)                     y 156..864 (708)
fills   56% wide, 69% tall           fills   73% wide, 90% tall
margins 226/226/156/160              margins 108/108/40/40        ← sin recorte
```

Más: la rosa baja de 3347 a 2921 bytes sin perder ni un trazo (9 `path` antes y después); las dos
copias de `picode.svg` (conector y núcleo) siguen idénticas byte a byte; `tsc` del conector 0;
**177 tests** siguen pasando.

## Lo que queda abierto (decisión del dueño)

`AGENTS.md` dice que **la rosa es el icono de la barra de actividad**, y hoy esa barra lleva la marca
de PiCode (`picode-status.svg`, contenedor «PiCode»). La rosa aparece solo en la fila *Gentle AI* del
panel. O el registro se actualiza, o el contenedor cambia de icono, o Gentle AI merece su propio
contenedor — pero eso es marca del producto, no presentación, así que no se toca sin decirlo.

Nota menor: la copia de `gentle-ai.svg` que vive en el núcleo
(`src/vs/workbench/contrib/picode/browser/media/`) **no la usa nadie** — la del conector es la que
pinta el panel. Se dejó sincronizada y limpia; borrarla o darle uso es otra decisión.

## El panel y los mensajes (segunda tanda)

| Qué | Antes | Ahora |
| --- | --- | --- |
| El panel de estado | refrescaba cada 5 s **siempre** — un `git` por carpeta y el perfil leídos con el panel cerrado, sin nadie mirando la respuesta | el árbol le dice al proveedor cuándo aparece y cuándo se va; el temporizador vive en medio. Al volver refresca al instante, porque lo que quedó en pantalla es tan viejo como el tiempo ausente |
| Una lectura que falla | vaciaba el panel: quedaba una fila de error y nada más | el error **se añade** a la última lectura buena, y una lectura buena (que no trae error) la sustituye |
| «Reinstall it», «Update the pi that ships with the editor», «switch to PiCode's internal pi» | instrucciones en texto, con el comando existiendo | el chat, que renderiza markdown, lleva el enlace (`[Set up PiCode](command:picode.setup)`); los avisos, que no renderizan enlaces, llevan **botón** y ejecutan lo que se pulsa |

Lo que **no** se tocó, y se comprobó antes de tocarlo: la paleta ya agrupa los cinco comandos del
producto bajo *PiCode* con títulos claros; el aviso de actualización ya aparece solo **cuando hay
algo** y trae botones (*Update/Later*, *Reload Window*). Estaban bien.

## Registro

- 2026-10-01 · medido, cambiado y verificado en la sesión de «mejoras de diseño y estética».
- 2026-10-01 · segunda tanda: el panel deja de trabajar cuando nadie mira y no se vacía al fallar;
  los mensajes con acción llevan la acción. Comprobado además que la marca **sí** llega al editor
  construido: el pack aplana los `media` de los contribuidores en `out/media/`, y ahí está
  `picode.svg` con el lienzo nuevo (`118 116 788 788`).
