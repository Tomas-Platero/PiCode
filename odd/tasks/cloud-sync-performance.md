# Rendimiento y recuperación de la sincronización
Base: árbol local con la primera ronda de mejoras. Entrega local por unidad. Verificación: Node y pruebas del editor con dos clientes aislados.

## Specs
- S1 — «Una lectura de Firebase cuando no hay novedades.» Conservar creación concurrente y compatibilidad con datos antiguos.
- S2 — «Comprobar al volver a PiCode o recuperar conexión.» Agrupar avisos, conservar el respaldo periódico y priorizar «Sincronizar ahora».
- S3 — «Enviar solo lo que cambió y conservar lo pendiente al cerrar.» Conservar la sincronización completa en el primer ciclo y en recuperación.
- S4 — «Deshacer un cambio sincronizado desde el historial.» Comparar y recuperar por categoría, con carga bajo demanda.
- S5 — «Reposo, un cambio, una ráfaga de cambios y una reconexión.» Medir operaciones y tiempo entre clientes con datos de prueba.
- S6 — «Enviar los cambios pendientes al dejar PiCode.» Reutilizar la cola existente y respetar las pausas del servicio.
- S7 — «Ahorrar una lectura de Firebase también al subir.» Conservar el control de revisiones y la cuota dentro de la transacción.
- S8 — «Mostrar qué falló y reintentar solo esa categoría.» Aplicar cualquier cambio remoto pendiente antes de omitir una categoría.
- S9 — «piensa en más mejoras y hazlas.» Impedir que la actualización de perfiles antiguos vuelva a crear un manifiesto borrado concurrentemente.
- S10 — «Revisa que las mejoras ayuden a la arquitectura de la syncronización.» Al cerrar el servicio, ningún ciclo que esperaba el manifiesto puede reanudar escrituras.

## Tasks
- T1 — S1 — inline — verificado. La prueba reprodujo dos lecturas y pasó con una. Creación concurrente y versión antigua comprobadas.
- T2 — S2–S3 — inline — verificado con dos clientes y comprobación independiente de solapamiento, edición posterior y restablecimiento.
- T3 — S4 — inline — carga por categoría y deduplicación comprobadas en el proveedor compilado. Pendiente la comprobación visual y de restauración en Electron.
- T4 — S5 — inline — mediciones reproducidas con reloj virtual y servidor local de prueba.
- T5 — S6 — inline — verificado en dos clientes durante una subida. Sin cambios pendientes no hubo peticiones.
- T6 — S7 — inline — verificado. La prueba reprodujo 2 lecturas y pasó con 1, con cuota y revisión guardadas en la transacción.
- T7 — S8 — inline — verificado. Reintenta solo la categoría pedida con el mismo manifiesto. Si otro equipo escribe, la pasada completa recoge sus cambios.
- T8 — S9 — inline — verificado. Dos pruebas cubren el borrado durante la actualización y entre actualización y subida.
- T9 — S10 — inline — el caso de un ciclo en espera y otro en cola pasó de una escritura intentada a ninguna al cerrar.

## Log
- L1 — «iHazlo»
- L2 — En 15 minutos en segundo plano hubo 1 GET, sin escrituras. Guardar en un cliente y volver al otro tardó 9,95 s virtuales, con 3 GET y 1 POST. Tres guardados y una reconexión tardaron 31,05 s virtuales, con 4 GET y 1 POST. La prueba del servidor contó 1 lectura del manifiesto existente, frente a 2 antes.
- L3 — Servidor: 94 pruebas correctas. Cliente: 508 correctas y el fallo de estados que también se reprodujo con el servicio de HEAD. Tipos del cliente, traducciones y documentación correctos. El chequeo de tipos del servidor señala dos errores preexistentes en `test/usage.test.ts`. Sin medición de Firebase en producción.
- L4 — «te queda poco tiempo de uso, haz estas mejoras, y cuando vuelvas temrina. Una vez que termines, piensa en más mejoras y hazlas.  Revisa que las mejoras ayuden a la arquitectura de la syncronización.»
- L5 — «continua». Retomada la revisión de concurrencia. Se protegió la sesión durante la actualización de perfiles antiguos y se añadió la cancelación en las esperas del ciclo.
- L6 — Pruebas finales: 98 del servidor y 511 del cliente correctas. Los tipos del cliente, traducciones y documentación pasaron. Continúan el fallo de estados del cliente y los dos errores de tipos del servidor ya documentados en L3. La revisión independiente comprobó el cierre de ambos casos de concurrencia. Falta probar en Electron y medir en Firebase de producción.
