# EN MIGRACIÓN AL CORE — este directorio NO se compila ni se empaqueta

> Decisión del dueño, 2026-09-24: **«todo ha de ir en el core de vscode, integrado en su
> núcleo. Quita esa extensión.»**

A partir de esa fecha:

- `dev/build.sh` **ya no** copia esta extensión al editor. Un build no la contiene.
- `dev/builtin-extension.sh`, que hacía esa copia, fue **borrado**.
- Este directorio se queda en el repositorio **solo como el código que se está migrando**.
  No es una superficie viva del producto: es el material de origen.

**Por qué no se ha borrado todavía, y no es pereza.** Su código —incluido lo escrito en esta
misma sesión, como el catálogo de proveedores con las dos vías de conexión— **está sin
commitear**. Borrar el directorio ahora lo perdería para siempre, sin historial del que
recuperarlo. Se borra cuando la migración haya copiado lo que sirve.

## A dónde va cada cosa

| Aquí | Va a |
| --- | --- |
| Proveedores, login, `models.json` | El core: Chat y el sistema de agentes del editor |
| Descubrimiento de habilidades | El core (el host de agentes ya descubre personalizaciones) |
| Ajustes de PiCode | El core (`contrib/picode`, ya empezado) |
| Sesión de pi y traducción de eventos | Ya migrado: `src/platform/agentHost/node/pi/` |
| El panel y su chat | **Se borra.** El chat es el del editor |

## Qué está roto mientras tanto, dicho claro

El editor construido **no tiene forma de hablar con ningún modelo**: ni chat, ni login de
proveedores. Es el precio aceptado de quitar la extensión antes de terminar el proveedor de
pi en el core. Si hubiera que pausar la migración, restaurar el paso del build es lo que
devuelve la superficie vieja (el script está en el historial de git).
