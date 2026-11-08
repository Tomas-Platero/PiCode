# ⚡ Rendimiento

Qué se ha mejorado, cómo se mide y qué queda pendiente. Se compara siempre con números.

## 📏 Cómo medir

El comando `picode.perf.report` (no sale en la paleta; se lanza desde las herramientas de desarrollo con
`executeCommand`) abre una tabla con lo que lleva hecho esta ventana: cuántas veces, media, el más lento y el último.

| Fila | Qué mide |
| --- | --- |
| `activation` | El arranque del conector, hasta devolver el control al editor |
| `status: MCPs` | La lectura ligera de MCPs de la columna *Status* |
| `status: lines changed` | El recuento de líneas cambiadas (lanza git) |
| `status: full reading` | La lectura completa del estado que usan las páginas de ajustes |
| `sessions: listing` | La lista de sesiones |
| `memory: reading` | Una lectura completa del panel de memoria |

## ✅ Hecho (2026-11-05)

**Columna *Status*:**

- Ya no pide el estado completo cada 4 s (tres procesos de git por carpeta, versión de pi, consumo): pide solo los MCPs.
- Las líneas cambiadas se recuentan cuando cambian archivos de la carpeta, con una red de seguridad de 60 s, y solo si hay algo que enseñar.
- Con la ventana en segundo plano refresca cada 30 s en vez de cada 4 s, y al volver el foco refresca al momento.
- Cada lectura espera a la anterior del mismo tipo, y una lenta no retiene a las demás.
- Solo se repinta si cambió algo de lo que enseña; así no parpadea ni pierde el *hover*.
- Las órdenes de memoria no esperan al resto de lecturas.

**Panel de memoria:**

- La lista de un proyecto no se vuelve a descargar en cada redibujado.
- En *Agent* hay *Show N more* y la lista desplegada sigue a los contadores.
- La búsqueda pide 20 filas por proyecto, el máximo del motor, y marca `20+` cuando llega a ese techo.
- Una búsqueda sin resultados lo dice.
- El estado de la búsqueda ya no se pierde si falla el motor ni reaparece si se borró durante una lectura.
- La comprobación de versión del motor no retrasa los contadores.
- Una carpeta con un nombre distinto al de su repositorio encuentra sus memorias.
- **Filtros** (*Filter memories…*, en el árbol y en la columna *Status*): tipo, ámbito y fecha (7 o 30 días). Se aplican a las listas y a la búsqueda. El motor solo filtra por ámbito y, en la búsqueda, por tipo; el resto se filtra en el editor, así que con un filtro puesto se leen hasta 500 memorias por proyecto. Con un filtro, *Show more* se limita a lo ya leído.

**Resto:**

- El contador de consumo (`picodeUsageStatus`) ya no lee cada 15 s con la ventana en segundo plano; al volver el foco lee al momento.
- La búsqueda en conversaciones anteriores lee los ficheros sin bloquear y cede el turno entre uno y otro, así que el chat no se queda parado mientras busca.
- La lista de sesiones describe cada transcrito leyendo solo sus dos extremos (64 KB cada uno) si es largo, y guarda su caché entre arranques en el almacenamiento del editor (`sessions-listing.json`). Solo vuelve a leer lo que cambió. Si un extremo corta una respuesta, lee el fichero entero, como antes.

## 🔜 Pendiente

| Qué | Por qué | Esfuerzo |
| --- | --- | --- |
| Medir en la app, con `picode.perf.report`, antes y después de todo lo anterior | Nada de esto está medido en la app | Pequeño |
| Precarga de pi fuera del proceso del editor | **Probado y descartado por ahora (2026-11-05):** con los ficheros ya en caché, importar pi sigue costando ~1,2 s en el propio proceso, porque es ejecutar sus módulos, no leerlos. Solo ayudaría en un arranque en frío, que no se pudo reproducir, y duplicaría la CPU. Volver a medirlo en frío antes de intentarlo | Grande |
| Empaquetar el SDK de pi en un solo fichero, o ejecutarlo en otro proceso | **Medido y descartado por ahora (2026-11-05):** el import cuesta ~1,2 s repartidos entre miles de ficheros, sin ninguna dependencia que pase de 33 ms; la caché de compilación de Node lo empeora (~2,3 s). Solo el empaquetado lo reduciría, y obliga a que los paquetes que se instalan usen la misma copia de pi. El motor de memoria arranca en ~0,7 s y no es el cuello | Grande |
| Que el motor filtre por tipo y fecha | Hoy se filtra en el editor tras leer hasta 500 filas; es una petición al motor, no al editor | Fuera de PiCode |
